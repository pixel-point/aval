import {
  FormatError,
  validateCompleteAsset,
  type ValidatedAssetLayout
} from "@rendered-motion/format";
import { describe, expect, it, vi } from "vitest";

import {
  normalizeRuntimeAssetRequest,
  type RuntimeFetchAdapter,
  type RuntimeFetchInit,
  type RuntimeFetchResponseView
} from "./asset-fetch-contracts.js";
import { createOpaqueTestAsset } from "./asset-test-fixture.js";
import type {
  BoundedBodyByteLease,
  BoundedBodyByteResourceHost,
  RuntimeBodyReader,
  RuntimeBodyReadResult
} from "./bounded-body-reader.js";
import { parseStrongEntityTag } from "./http-entity-tag.js";
import type { LoadWatchdogTimerHost } from "./load-watchdogs.js";
import {
  fetchFullAsset,
  type RuntimeFullAssetFormatAdapter
} from "./full-asset-fetch.js";

describe("bounded complete-asset fetch", () => {
  it("sends one deliberate range-free GET and transfers validated ownership", async () => {
    const asset = createOpaqueTestAsset();
    const resources = new CountingResources();
    const reader = scriptedReader(asset);
    const fetcher = scriptedFetch([
      response(200, asset.byteLength, reader, { etag: '"full-v1"' })
    ]);

    const result = await fetchFullAsset({
      request: request(),
      fetcher,
      resources,
      generation: 4,
      isGenerationCurrent: (generation) => generation === 4,
      timers: new PassiveTimerHost()
    });

    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0]).toMatchObject({
      url: "https://cdn.example.test/motion.rma",
      init: {
        method: "GET",
        credentials: "same-origin",
        headers: {}
      }
    });
    expect(result.mode).toBe("full");
    expect(result.bytes).toEqual(asset);
    expect(result.layout.frontIndex.header.declaredFileLength).toBe(
      asset.byteLength
    );
    expect(result.identity).toEqual({
      mode: "full",
      generation: 4,
      finalUrl: "https://cdn.example.test/motion.rma",
      declaredTotalBytes: asset.byteLength,
      strongEntityTag: '"full-v1"'
    });
    expect(reader.cancelCount).toBe(0);
    expect(reader.releaseLockCount).toBe(1);
    expect(resources.liveBytes).toBe(asset.byteLength);

    result.release();
    result.release();
    expect(resources.liveBytes).toBe(0);
  });

  it("rejects 206 for a deliberate full request and retires its body", async () => {
    const asset = createOpaqueTestAsset();
    const reader = scriptedReader(asset);
    const resources = new CountingResources();

    await expect(fetchFullAsset({
      request: request(),
      fetcher: scriptedFetch([response(206, asset.byteLength, reader, {
        contentRange: `bytes 0-${String(asset.byteLength - 1)}/${String(asset.byteLength)}`
      })]),
      resources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    })).rejects.toMatchObject({ code: "range-response-invalid" });

    expect(reader.readCount).toBe(0);
    expect(reader.cancelCount).toBe(1);
    expect(reader.releaseLockCount).toBe(1);
    expect(resources.liveBytes).toBe(0);
  });

  it("enforces final URL and pinned strong ETag before reading replacement bytes", async () => {
    const asset = createOpaqueTestAsset();
    const pinned = parseStrongEntityTag('"range-v1"')!;
    for (const responseOptions of [
      { url: "https://other.example.test/motion.rma", etag: '"range-v1"' },
      { etag: '"range-v2"' },
      { etag: null },
      { etag: 'W/"range-v1"' }
    ] as const) {
      const reader = scriptedReader(asset);
      await expect(fetchFullAsset({
        request: request(),
        fetcher: scriptedFetch([
          response(200, asset.byteLength, reader, responseOptions)
        ]),
        resources: new CountingResources(),
        generation: 1,
        isGenerationCurrent: () => true,
        timers: new PassiveTimerHost(),
        pinnedEntity: {
          finalUrl: "https://cdn.example.test/motion.rma",
          strongEntityTag: pinned
        }
      })).rejects.toMatchObject({ code: "entity-changed" });
      expect(reader.readCount).toBe(0);
      expect(reader.cancelCount).toBe(1);
      expect(reader.releaseLockCount).toBe(1);
    }
  });

  it("checks declared and observed full lengths under the active cap", async () => {
    const asset = createOpaqueTestAsset();
    for (const [declaredLength, body] of [
      [asset.byteLength + 1, asset],
      [asset.byteLength, asset.subarray(0, asset.byteLength - 1)]
    ] as const) {
      const resources = new CountingResources();
      await expect(fetchFullAsset({
        request: request(),
        fetcher: scriptedFetch([
          response(200, declaredLength, scriptedReader(body))
        ]),
        resources,
        generation: 1,
        isGenerationCurrent: () => true,
        timers: new PassiveTimerHost()
      })).rejects.toMatchObject({ code: "range-response-invalid" });
      expect(resources.liveBytes).toBe(0);
    }
  });

  it("gates every format access behind successful external integrity", async () => {
    const asset = createOpaqueTestAsset();
    const digest = deferred<ArrayBuffer>();
    const validate = vi.fn((bytes: Uint8Array) =>
      validateCompleteAsset({ bytes })
    );
    const fetcher = scriptedFetch([
      response(200, asset.byteLength, scriptedReader(asset))
    ]);
    const operation = fetchFullAsset({
      request: request("sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
      fetcher,
      resources: new CountingResources(),
      generation: 8,
      isGenerationCurrent: (generation) => generation === 8,
      timers: new PassiveTimerHost(),
      digestAdapter: { digestSha256: () => digest.promise },
      format: { validateCompleteAsset: validate }
    });

    await flushMicrotasks();
    expect(validate).not.toHaveBeenCalled();
    expect(fetcher.calls[0]!.init.headers).toEqual({});

    digest.resolve(new Uint8Array(32).buffer);
    const result = await operation;
    expect(validate).toHaveBeenCalledOnce();
    result.release();
  });

  it("times out a late external digest without validation or promotion", async () => {
    const asset = createOpaqueTestAsset();
    const digest = deferred<ArrayBuffer>();
    const validate = vi.fn((bytes: Uint8Array) =>
      validateCompleteAsset({ bytes })
    );
    const resources = new CountingResources();
    const timers = new ManualTimerHost();
    const operation = fetchFullAsset({
      request: request(
        "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        10
      ),
      fetcher: scriptedFetch([
        response(200, asset.byteLength, scriptedReader(asset))
      ]),
      resources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers,
      digestAdapter: { digestSha256: () => digest.promise },
      format: { validateCompleteAsset: validate }
    });

    await flushMicrotasks();
    expect(validate).not.toHaveBeenCalled();
    timers.fire(10);
    await expect(operation).rejects.toMatchObject({
      code: "watchdog-timeout",
      failure: { context: { policyPhase: "overall" } }
    });
    expect(validate).not.toHaveBeenCalled();
    expect(timers.pendingCount).toBe(0);

    digest.resolve(new Uint8Array(32).buffer);
    await flushMicrotasks();
    expect(validate).not.toHaveBeenCalled();
    expect(resources.liveBytes).toBe(0);
    expect(timers.pendingCount).toBe(0);
  });

  it("checks the same deadline again before whole-file promotion", async () => {
    const asset = createOpaqueTestAsset();
    const timers = new ManualTimerHost();
    const resources = new CountingResources();
    const operation = fetchFullAsset({
      request: request(undefined, 10),
      fetcher: scriptedFetch([
        response(200, asset.byteLength, scriptedReader(asset))
      ]),
      resources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers,
      format: {
        validateCompleteAsset(bytes) {
          const layout = validateCompleteAsset({ bytes });
          timers.fire(10);
          return layout;
        }
      }
    });

    await expect(operation).rejects.toMatchObject({
      code: "watchdog-timeout",
      failure: { context: { policyPhase: "overall" } }
    });
    expect(resources.liveBytes).toBe(0);
    expect(timers.pendingCount).toBe(0);
  });

  it("reports external mismatch without parser access or retained quarantine", async () => {
    const asset = createOpaqueTestAsset();
    const validate = vi.fn((bytes: Uint8Array) =>
      validateCompleteAsset({ bytes })
    );
    const resources = new CountingResources();

    await expect(fetchFullAsset({
      request: request("sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
      fetcher: scriptedFetch([
        response(200, asset.byteLength, scriptedReader(asset))
      ]),
      resources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost(),
      digestAdapter: { digestSha256: async () => new Uint8Array(32).fill(1) },
      format: { validateCompleteAsset: validate }
    })).rejects.toMatchObject({
      code: "integrity-mismatch",
      failure: { context: { lifecyclePhase: "external-integrity" } }
    });

    expect(validate).not.toHaveBeenCalled();
    expect(resources.liveBytes).toBe(0);
  });

  it("normalizes network and format failures without retaining hostile text", async () => {
    await expect(fetchFullAsset({
      request: request(),
      fetcher: {
        fetch: async () => {
          throw new Error("https://secret.example.test/private.rma");
        }
      },
      resources: new CountingResources(),
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    })).rejects.toMatchObject({
      code: "load-failure",
      message: "animation asset loading failed"
    });

    const asset = createOpaqueTestAsset();
    const resources = new CountingResources();
    await expect(fetchFullAsset({
      request: request(),
      fetcher: scriptedFetch([
        response(200, asset.byteLength, scriptedReader(asset))
      ]),
      resources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost(),
      format: {
        validateCompleteAsset(): Readonly<ValidatedAssetLayout> {
          throw new FormatError("HEADER_INVALID", "hostile format details", {
            offset: 9
          });
        }
      }
    })).rejects.toMatchObject({
      code: "invalid-asset",
      failure: { context: { sourceCode: "HEADER_INVALID", offset: 9 } }
    });
    expect(resources.liveBytes).toBe(0);
  });

  it("retires a response body that resolves after its Fetch watchdog", async () => {
    const pending = deferred<RuntimeFetchResponseView>();
    const timers = new ManualTimerHost();
    const reader = scriptedReader(createOpaqueTestAsset());
    const operation = fetchFullAsset({
      request: request(),
      fetcher: scriptedFetch([pending.promise]),
      resources: new CountingResources(),
      generation: 1,
      isGenerationCurrent: () => true,
      timers
    });

    await flushMicrotasks();
    timers.fire(2_000);
    await expect(operation).rejects.toMatchObject({ code: "watchdog-timeout" });

    pending.resolve(response(200, createOpaqueTestAsset().byteLength, reader));
    await flushMicrotasks();
    expect(reader.readCount).toBe(0);
    expect(reader.cancelCount).toBe(1);
    expect(reader.releaseLockCount).toBe(1);
  });

  it("snapshots hostile options once and removes partial abort links on setup failure", async () => {
    const requestController = new AbortController();
    const remove = vi.spyOn(requestController.signal, "removeEventListener");
    const normalized = normalizeRuntimeAssetRequest({
      url: "https://cdn.example.test/motion.rma",
      signal: requestController.signal
    });
    const hostileSessionSignal = {
      aborted: false,
      addEventListener(): never {
        throw new Error("secret signal");
      },
      removeEventListener(): void {}
    } as unknown as AbortSignal;

    await expect(fetchFullAsset({
      request: normalized,
      fetcher: scriptedFetch([]),
      resources: new CountingResources(),
      generation: 1,
      isGenerationCurrent: () => true,
      sessionSignal: hostileSessionSignal,
      timers: new PassiveTimerHost()
    })).rejects.toMatchObject({
      code: "load-failure",
      message: "animation asset loading failed"
    });
    expect(remove).toHaveBeenCalledOnce();

    const timerController = new AbortController();
    const timerRemove = vi.spyOn(
      timerController.signal,
      "removeEventListener"
    );
    await expect(fetchFullAsset({
      request: normalizeRuntimeAssetRequest({
        url: "https://cdn.example.test/motion.rma",
        signal: timerController.signal
      }),
      fetcher: scriptedFetch([]),
      resources: new CountingResources(),
      generation: 1,
      isGenerationCurrent: () => true,
      timers: {
        now(): never { throw new Error("secret timer"); },
        setTimeout: () => ({}),
        clearTimeout: () => undefined
      }
    })).rejects.toMatchObject({ code: "load-failure" });
    expect(timerRemove).toHaveBeenCalledOnce();

    const hostile = Object.create(null);
    Object.defineProperty(hostile, "request", { value: normalized });
    Object.defineProperty(hostile, "fetcher", {
      get(): never { throw new Error("secret fetcher"); }
    });
    await expect(fetchFullAsset(hostile)).rejects.toMatchObject({
      code: "load-failure",
      message: "animation asset loading failed"
    });
  });
});

function request(integrity?: string, timeoutMs?: number) {
  return normalizeRuntimeAssetRequest({
    url: "https://cdn.example.test/motion.rma",
    ...(integrity === undefined ? {} : { integrity }),
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  });
}

interface ResponseOptions {
  readonly url?: string;
  readonly etag?: string | null;
  readonly contentRange?: string | null;
  readonly contentEncoding?: string | null;
}

function response(
  status: number,
  contentLength: number,
  reader: ScriptedReader,
  options: ResponseOptions = {}
): RuntimeFetchResponseView {
  const values: Readonly<Record<string, string | null>> = {
    "content-encoding": options.contentEncoding ?? null,
    "content-length": String(contentLength),
    "content-range": options.contentRange ?? null,
    etag: options.etag ?? null
  };
  return {
    status,
    type: "cors",
    url: options.url ?? "https://cdn.example.test/motion.rma",
    headers: { get: (name) => values[name.toLowerCase()] ?? null },
    body: { getReader: () => reader }
  };
}

interface FetchCall {
  readonly url: string;
  readonly init: Readonly<RuntimeFetchInit>;
}

function scriptedFetch(
  responses: readonly (RuntimeFetchResponseView | PromiseLike<RuntimeFetchResponseView>)[]
):
RuntimeFetchAdapter & { readonly calls: FetchCall[] } {
  const queue = [...responses];
  const calls: FetchCall[] = [];
  return {
    calls,
    async fetch(url, init) {
      calls.push({ url, init });
      const next = queue.shift();
      if (next === undefined) throw new Error("unexpected fetch");
      return await next;
    }
  };
}

interface ScriptedReader extends RuntimeBodyReader {
  readonly readCount: number;
  readonly cancelCount: number;
  readonly releaseLockCount: number;
}

function scriptedReader(bytes: Uint8Array): ScriptedReader {
  const steps: RuntimeBodyReadResult[] = [
    { done: false, value: bytes.slice() },
    { done: true, value: undefined }
  ];
  let readCount = 0;
  let cancelCount = 0;
  let releaseLockCount = 0;
  return {
    get readCount() { return readCount; },
    get cancelCount() { return cancelCount; },
    get releaseLockCount() { return releaseLockCount; },
    async read() {
      readCount += 1;
      return steps.shift() ?? { done: true, value: undefined };
    },
    async cancel() { cancelCount += 1; },
    releaseLock() { releaseLockCount += 1; }
  };
}

class CountingResources implements BoundedBodyByteResourceHost {
  public liveBytes = 0;
  public peakBytes = 0;

  public reserve(byteLength: number): BoundedBodyByteLease {
    this.liveBytes += byteLength;
    this.peakBytes = Math.max(this.peakBytes, this.liveBytes);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.liveBytes -= byteLength;
      }
    };
  }
}

class PassiveTimerHost implements LoadWatchdogTimerHost {
  public now(): number { return 0; }
  public setTimeout(): object { return {}; }
  public clearTimeout(): void {}
}

class ManualTimerHost implements LoadWatchdogTimerHost {
  readonly #tasks = new Map<object, { readonly callback: () => void; readonly delay: number }>();
  public now(): number { return 0; }
  public get pendingCount(): number { return this.#tasks.size; }
  public setTimeout(callback: () => void, delay: number): object {
    const handle = {};
    this.#tasks.set(handle, { callback, delay });
    return handle;
  }
  public clearTimeout(handle: unknown): void {
    this.#tasks.delete(handle as object);
  }
  public fire(delay: number): void {
    const task = [...this.#tasks.entries()].find(([, value]) =>
      value.delay === delay
    );
    if (task === undefined) throw new Error("timer not found");
    this.#tasks.delete(task[0]);
    task[1].callback();
  }
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

void (null as unknown as RuntimeFullAssetFormatAdapter);
