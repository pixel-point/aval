import {
  FORMAT_HEADER_LENGTH,
  parseFrontIndex,
  parseHeader,
  validateCompleteAsset
} from "@rendered-motion/format";
import { describe, expect, it } from "vitest";

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
import type { LoadWatchdogTimerHost } from "./load-watchdogs.js";
import {
  openRangeAssetSession,
  type RuntimeRangeAssetSession
} from "./range-asset-session.js";

describe("entity-pinned range metadata session", () => {
  it("opens with exact 0-63 and front-index ranges under one strong ETag", async () => {
    const fixture = rangeFixture();
    const resources = new CountingResources();
    const fetcher = scriptedFetch([
      partialResponse(fixture.header, 0, fixture.total, '"entity-v1"'),
      partialResponse(
        fixture.frontTail,
        FORMAT_HEADER_LENGTH,
        fixture.total,
        '"entity-v1"'
      )
    ]);

    const opened = await openRangeAssetSession({
      request: request(),
      fetcher,
      resources,
      generation: 7,
      isGenerationCurrent: (generation) => generation === 7,
      timers: new PassiveTimerHost()
    });
    const session = requireRangeSession(opened);

    expect(fetcher.calls.map(({ init }) => init.headers)).toEqual([
      { Range: "bytes=0-63" },
      {
        Range: `bytes=64-${String(fixture.frontEnd - 1)}`,
        "If-Range": '"entity-v1"'
      }
    ]);
    expect(session.identity).toEqual({
      mode: "range",
      generation: 7,
      finalUrl: FINAL_URL,
      declaredTotalBytes: fixture.total,
      strongEntityTag: '"entity-v1"'
    });
    expect(session.frontIndex).toEqual(parseFrontIndex(fixture.asset));
    expect(session.metadataByteLength).toBe(fixture.frontEnd);
    expect(resources.liveBytes).toBe(fixture.frontEnd);
    session.releaseMetadata();
    expect(session.metadataByteLength).toBe(fixture.frontEnd);
    expect(resources.liveBytes).toBe(0);

    await session.dispose();
    await session.dispose();
    expect(resources.liveBytes).toBe(0);
  });

  it("bounds both metadata requests by one cumulative absolute deadline", async () => {
    const fixture = rangeFixture();
    const timers = new ManualTimerHost();
    const first = partialResponse(
      fixture.header, 0, fixture.total, '"entity-v1"'
    );
    const second = partialResponse(
      fixture.frontTail, 64, fixture.total, '"entity-v1"'
    );
    const scripted = scriptedFetch([first, second]);
    const fetcher: RuntimeFetchAdapter = {
      fetch(url, init) {
        timers.advance(scripted.calls.length === 0 ? 6 : 5);
        return scripted.fetch(url, init);
      }
    };
    const resources = new CountingResources();

    await expect(openRangeAssetSession({
      request: request(undefined, 10),
      fetcher,
      resources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers
    })).rejects.toMatchObject({
      code: "watchdog-timeout",
      failure: { context: { policyPhase: "overall" } }
    });

    await flushMicrotasks();
    expect(scripted.calls).toHaveLength(2);
    expect(second.reader.cancelCount).toBe(1);
    expect(second.reader.releaseLockCount).toBe(1);
    expect(resources.liveBytes).toBe(0);
    expect(timers.pendingCount).toBe(0);
  });

  it("accepts sequential metadata work completed before the same boundary", async () => {
    const fixture = rangeFixture();
    const timers = new ManualTimerHost();
    const scripted = scriptedFetch([
      partialResponse(fixture.header, 0, fixture.total, '"entity-v1"'),
      partialResponse(fixture.frontTail, 64, fixture.total, '"entity-v1"')
    ]);
    const fetcher: RuntimeFetchAdapter = {
      fetch(url, init) {
        timers.advance(scripted.calls.length === 0 ? 4 : 5);
        return scripted.fetch(url, init);
      }
    };
    const resources = new CountingResources();
    const opened = await openRangeAssetSession({
      request: request(undefined, 10),
      fetcher,
      resources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers
    });
    const session = requireRangeSession(opened);
    expect(scripted.calls).toHaveLength(2);
    expect(timers.now()).toBe(9);
    expect(timers.pendingCount).toBe(0);
    await session.dispose();
    expect(resources.liveBytes).toBe(0);
  });

  it("does not restart the deadline for a no-validator full fallback", async () => {
    const fixture = rangeFixture();
    const timers = new ManualTimerHost();
    const initial = partialResponse(fixture.header, 0, fixture.total, null);
    const fallback = fullResponse(fixture.asset, null);
    const scripted = scriptedFetch([initial, fallback]);
    const fetcher: RuntimeFetchAdapter = {
      fetch(url, init) {
        timers.advance(scripted.calls.length === 0 ? 6 : 5);
        return scripted.fetch(url, init);
      }
    };
    const resources = new CountingResources();

    await expect(openRangeAssetSession({
      request: request(undefined, 10),
      fetcher,
      resources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers
    })).rejects.toMatchObject({
      code: "watchdog-timeout",
      failure: { context: { policyPhase: "overall" } }
    });
    await flushMicrotasks();

    expect(scripted.calls.map(({ init }) => init.headers)).toEqual([
      { Range: "bytes=0-63" },
      {}
    ]);
    expect(initial.reader.cancelCount).toBe(1);
    expect(fallback.reader.cancelCount).toBe(1);
    expect(resources.liveBytes).toBe(0);
    expect(timers.pendingCount).toBe(0);
  });

  it("keeps caller abort linked after metadata readiness and releases idle metadata", async () => {
    const fixture = rangeFixture();
    const controller = new AbortController();
    const resources = new CountingResources();
    const fetcher = scriptedFetch([
      partialResponse(fixture.header, 0, fixture.total, '"entity-v1"'),
      partialResponse(fixture.frontTail, 64, fixture.total, '"entity-v1"')
    ]);
    const session = requireRangeSession(await openRangeAssetSession({
      request: normalizeRuntimeAssetRequest({
        url: FINAL_URL,
        signal: controller.signal
      }),
      fetcher,
      resources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    }));
    expect(resources.liveBytes).toBe(fixture.frontEnd);

    controller.abort();
    await session.dispose();
    expect(session.disposed).toBe(true);
    expect(resources.liveBytes).toBe(0);
    await expect(session.fetchPayloadRange({
      start: fixture.payloadStart,
      end: fixture.payloadEnd
    })).rejects.toMatchObject({ code: "disposed" });
    expect(fetcher.calls).toHaveLength(2);
  });

  it("accepts an initial ignored-range 200 only as one standalone full asset", async () => {
    const fixture = rangeFixture();
    const fetcher = scriptedFetch([
      fullResponse(fixture.asset, '"full-v1"')
    ]);
    const resources = new CountingResources();

    const opened = await openRangeAssetSession({
      request: request(),
      fetcher,
      resources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    });

    expect(opened.mode).toBe("full");
    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0]!.init.headers).toEqual({ Range: "bytes=0-63" });
    if (opened.mode === "full") opened.release();
    expect(resources.liveBytes).toBe(0);
  });

  it.each([null, 'W/"weak"', "malformed"])(
    "discards an initial 206 with unavailable strong ETag %j and restarts once without Range",
    async (etag) => {
      const fixture = rangeFixture();
      const initial = partialResponse(fixture.header, 0, fixture.total, etag);
      const fetcher = scriptedFetch([
        initial.response,
        fullResponse(fixture.asset, null)
      ]);
      const resources = new CountingResources();

      const opened = await openRangeAssetSession({
        request: request(),
        fetcher,
        resources,
        generation: 1,
        isGenerationCurrent: () => true,
        timers: new PassiveTimerHost()
      });

      expect(opened.mode).toBe("full");
      expect(fetcher.calls.map(({ init }) => init.headers)).toEqual([
        { Range: "bytes=0-63" },
        {}
      ]);
      expect(initial.reader.readCount).toBe(0);
      expect(initial.reader.cancelCount).toBe(1);
      expect(initial.reader.releaseLockCount).toBe(1);
      if (opened.mode === "full") opened.release();
      expect(resources.liveBytes).toBe(0);
    }
  );

  it("allows only one no-validator restart and rejects a second 206", async () => {
    const fixture = rangeFixture();
    const first = partialResponse(fixture.header, 0, fixture.total, null);
    const second = partialResponse(fixture.header, 0, fixture.total, '"late"');
    const fetcher = scriptedFetch([first.response, second.response]);

    await expect(openRangeAssetSession({
      request: request(),
      fetcher,
      resources: new CountingResources(),
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    })).rejects.toMatchObject({ code: "range-response-invalid" });

    expect(fetcher.calls).toHaveLength(2);
    expect(fetcher.calls[1]!.init.headers).toEqual({});
    expect(second.reader.cancelCount).toBe(1);
  });

  it("rejects header total disagreement and invalid format headers before front-index Fetch", async () => {
    const fixture = rangeFixture();
    const resources = new CountingResources();
    await expect(openRangeAssetSession({
      request: request(),
      fetcher: scriptedFetch([
        partialResponse(fixture.header, 0, fixture.total + 1, '"entity-v1"')
      ]),
      resources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    })).rejects.toMatchObject({ code: "range-response-invalid" });
    expect(resources.liveBytes).toBe(0);

    const corruptHeader = fixture.header.slice();
    corruptHeader[0] = 0;
    const corruptResources = new CountingResources();
    const fetcher = scriptedFetch([
      partialResponse(corruptHeader, 0, fixture.total, '"entity-v1"')
    ]);
    await expect(openRangeAssetSession({
      request: request(),
      fetcher,
      resources: corruptResources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    })).rejects.toMatchObject({
      code: "invalid-asset",
      failure: { context: { sourceCode: "HEADER_INVALID" } }
    });
    expect(fetcher.calls).toHaveLength(1);
    expect(corruptResources.liveBytes).toBe(0);
  });

  it("rejects corrupt front-index bytes after exact transport cleanup", async () => {
    const fixture = rangeFixture();
    const corruptFront = fixture.frontTail.slice();
    corruptFront[0] = 0xff;
    const resources = new CountingResources();

    await expect(openRangeAssetSession({
      request: request(),
      fetcher: scriptedFetch([
        partialResponse(fixture.header, 0, fixture.total, '"entity-v1"'),
        partialResponse(corruptFront, 64, fixture.total, '"entity-v1"')
      ]),
      resources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    })).rejects.toMatchObject({
      code: "invalid-asset",
      failure: { context: { lifecyclePhase: "front-index" } }
    });

    expect(resources.liveBytes).toBe(0);
  });

  it("accepts a later 200 only as an exact pinned-entity full replacement", async () => {
    const fixture = rangeFixture();
    const fetcher = scriptedFetch([
      partialResponse(fixture.header, 0, fixture.total, '"entity-v1"'),
      fullResponse(fixture.asset, '"entity-v1"')
    ]);
    const resources = new CountingResources();

    const opened = await openRangeAssetSession({
      request: request(),
      fetcher,
      resources,
      generation: 2,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    });

    expect(opened.mode).toBe("full");
    expect(fetcher.calls).toHaveLength(2);
    if (opened.mode === "full") opened.release();
    expect(resources.liveBytes).toBe(0);
  });

  it.each([
    { url: "https://other.example.test/motion.rma", etag: '"entity-v1"' },
    { etag: '"entity-v2"' },
    { etag: null },
    { etag: 'W/"entity-v1"' }
  ] as const)("rejects changed later-200 identity %# before reading", async (change) => {
    const fixture = rangeFixture();
    const replacement = fullResponse(fixture.asset, change.etag, change.url);
    const resources = new CountingResources();

    await expect(openRangeAssetSession({
      request: request(),
      fetcher: scriptedFetch([
        partialResponse(fixture.header, 0, fixture.total, '"entity-v1"'),
        replacement.response
      ]),
      resources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    })).rejects.toMatchObject({ code: "entity-changed" });

    expect(replacement.reader.readCount).toBe(0);
    expect(replacement.reader.cancelCount).toBe(1);
    expect(resources.liveBytes).toBe(0);
  });

  it.each([
    { start: FORMAT_HEADER_LENGTH + 1 },
    { totalDelta: 1 },
    { url: "https://other.example.test/motion.rma" },
    { etag: '"entity-v2"' },
    { contentEncoding: "gzip" }
  ] as const)("rejects invalid front-index response contract %#", async (change) => {
    const fixture = rangeFixture();
    const second = partialResponse(
      fixture.frontTail,
      change.start ?? FORMAT_HEADER_LENGTH,
      fixture.total + (change.totalDelta ?? 0),
      change.etag ?? '"entity-v1"',
      {
        ...(change.url === undefined ? {} : { url: change.url }),
        ...(change.contentEncoding === undefined
          ? {}
          : { contentEncoding: change.contentEncoding })
      }
    );
    const resources = new CountingResources();

    await expect(openRangeAssetSession({
      request: request(),
      fetcher: scriptedFetch([
        partialResponse(fixture.header, 0, fixture.total, '"entity-v1"'),
        second.response
      ]),
      resources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    })).rejects.toMatchObject({
      code: change.url !== undefined || change.etag !== undefined
        ? "entity-changed"
        : "range-response-invalid"
    });

    expect(second.reader.cancelCount).toBe(1);
    expect(resources.liveBytes).toBe(0);
  });

  it("fetches later exact ranges with If-Range and transfers the verified entity bytes", async () => {
    const fixture = rangeFixture();
    const payload = fixture.asset.slice(
      fixture.payloadStart,
      fixture.payloadEnd + 1
    );
    const fetcher = scriptedFetch([
      partialResponse(fixture.header, 0, fixture.total, '"entity-v1"'),
      partialResponse(fixture.frontTail, 64, fixture.total, '"entity-v1"'),
      partialResponse(payload, fixture.payloadStart, fixture.total, '"entity-v1"')
    ]);
    const resources = new CountingResources();
    const session = requireRangeSession(await openRangeAssetSession({
      request: request(),
      fetcher,
      resources,
      generation: 5,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    }));

    const loaded = await session.fetchPayloadRange({
      start: fixture.payloadStart,
      end: fixture.payloadEnd
    });
    expect(loaded.mode).toBe("range");
    expect(fetcher.calls[2]!.init.headers).toEqual({
      Range: `bytes=${String(fixture.payloadStart)}-${String(fixture.payloadEnd)}`,
      "If-Range": '"entity-v1"'
    });
    if (loaded.mode === "range") {
      expect(loaded.bytes).toEqual(payload);
      loaded.release();
    }
    await session.dispose();
    expect(resources.liveBytes).toBe(0);
  });

  it("rejects metadata-overlapping payload ranges before Fetch", async () => {
    const fixture = rangeFixture();
    const fetcher = scriptedFetch([
      partialResponse(fixture.header, 0, fixture.total, '"entity-v1"'),
      partialResponse(fixture.frontTail, 64, fixture.total, '"entity-v1"')
    ]);
    const session = requireRangeSession(await openRangeAssetSession({
      request: request(),
      fetcher,
      resources: new CountingResources(),
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    }));

    await expect(session.fetchPayloadRange({
      start: fixture.frontEnd - 1,
      end: fixture.frontEnd
    })).rejects.toMatchObject({ code: "range-response-invalid" });
    expect(fetcher.calls).toHaveLength(2);
    await session.dispose();
  });

  it("cancels one payload operation signal while preserving session retry", async () => {
    const fixture = rangeFixture();
    const range = { start: fixture.payloadStart, end: fixture.payloadEnd };
    const payload = fixture.asset.slice(range.start, range.end + 1);
    const pendingRead = deferred<RuntimeBodyReadResult>();
    let cancelCount = 0;
    let releaseLockCount = 0;
    const pendingReader: ScriptedReader = {
      get readCount() { return 1; },
      get cancelCount() { return cancelCount; },
      get releaseLockCount() { return releaseLockCount; },
      read: () => pendingRead.promise,
      async cancel() { cancelCount += 1; },
      releaseLock() { releaseLockCount += 1; }
    };
    const fetcher = scriptedFetch([
      partialResponse(fixture.header, 0, fixture.total, '"entity-v1"'),
      partialResponse(fixture.frontTail, 64, fixture.total, '"entity-v1"'),
      response(206, pendingReader, {
        etag: '"entity-v1"',
        contentLength: payload.byteLength,
        contentRange: `bytes ${String(range.start)}-${String(range.end)}/${String(fixture.total)}`
      }),
      partialResponse(payload, range.start, fixture.total, '"entity-v1"')
    ]);
    const session = requireRangeSession(await openRangeAssetSession({
      request: request(),
      fetcher,
      resources: new CountingResources(),
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    }));
    const controller = new AbortController();
    const aborted = session.fetchPayloadRange(range, {
      signal: controller.signal
    });
    await flushMicrotasks();
    controller.abort();
    await flushMicrotasks();
    expect(cancelCount).toBe(1);
    pendingRead.resolve({ done: true, value: undefined });
    await expect(aborted).rejects.toMatchObject({ code: "abort" });
    expect(releaseLockCount).toBe(1);
    expect(session.disposed).toBe(false);

    const retried = await session.fetchPayloadRange(range);
    expect(retried.mode).toBe("range");
    if (retried.mode === "range") retried.release();
    await session.dispose();
  });

  it("replaces a live range session when a later payload request returns exact pinned 200", async () => {
    const fixture = rangeFixture();
    const fetcher = scriptedFetch([
      partialResponse(fixture.header, 0, fixture.total, '"entity-v1"'),
      partialResponse(fixture.frontTail, 64, fixture.total, '"entity-v1"'),
      fullResponse(fixture.asset, '"entity-v1"')
    ]);
    const resources = new CountingResources();
    const session = requireRangeSession(await openRangeAssetSession({
      request: request(),
      fetcher,
      resources,
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    }));

    const replacement = await session.fetchPayloadRange({
      start: fixture.payloadStart,
      end: fixture.payloadEnd
    });
    expect(replacement.mode).toBe("full");
    expect(session.disposed).toBe(true);
    if (replacement.mode === "full") replacement.release();
    expect(resources.liveBytes).toBe(0);
  });

  it("caps concurrent payload bodies at four without issuing a fifth Fetch", async () => {
    const fixture = rangeFixture();
    const pending = Array.from({ length: 4 }, () =>
      deferred<RuntimeFetchResponseView>()
    );
    const fetcher = scriptedFetch([
      partialResponse(fixture.header, 0, fixture.total, '"entity-v1"'),
      partialResponse(fixture.frontTail, 64, fixture.total, '"entity-v1"'),
      ...pending.map(({ promise }) => promise)
    ]);
    const session = requireRangeSession(await openRangeAssetSession({
      request: request(),
      fetcher,
      resources: new CountingResources(),
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost()
    }));
    const range = { start: fixture.payloadStart, end: fixture.payloadEnd };
    const operations = pending.map(() => session.fetchPayloadRange(range));

    await expect(session.fetchPayloadRange(range)).rejects.toMatchObject({
      code: "resource-rejection"
    });
    expect(fetcher.calls).toHaveLength(6);

    const bytes = fixture.asset.slice(range.start, range.end + 1);
    pending.forEach((entry) => entry.resolve(
      partialResponse(bytes, range.start, fixture.total, '"entity-v1"').response
    ));
    const results = await Promise.all(operations);
    for (const result of results) if (result.mode === "range") result.release();
    await session.dispose();
  });

  it("uses one range-free externally gated full path", async () => {
    const fixture = rangeFixture();
    const fetcher = scriptedFetch([
      fullResponse(fixture.asset, null)
    ]);
    const opened = await openRangeAssetSession({
      request: request("sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
      fetcher,
      resources: new CountingResources(),
      generation: 1,
      isGenerationCurrent: () => true,
      timers: new PassiveTimerHost(),
      digestAdapter: { digestSha256: async () => new Uint8Array(32) }
    });

    expect(opened.mode).toBe("full");
    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0]!.init.headers).toEqual({});
    if (opened.mode === "full") opened.release();
  });
});

const FINAL_URL = "https://cdn.example.test/motion.rma";

function request(integrity?: string, timeoutMs?: number) {
  return normalizeRuntimeAssetRequest({
    url: FINAL_URL,
    ...(integrity === undefined ? {} : { integrity }),
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  });
}

function rangeFixture() {
  const asset = createOpaqueTestAsset();
  const layout = validateCompleteAsset({ bytes: asset });
  const frontEnd = layout.frontIndex.frontIndexRange.length;
  const firstBlob = layout.frontIndex.unitBlobs[0]!;
  return {
    asset,
    total: asset.byteLength,
    frontEnd,
    header: asset.slice(0, FORMAT_HEADER_LENGTH),
    frontTail: asset.slice(FORMAT_HEADER_LENGTH, frontEnd),
    payloadStart: firstBlob.offset,
    payloadEnd: firstBlob.offset + firstBlob.length - 1
  };
}

interface PartialOptions {
  readonly url?: string;
  readonly contentEncoding?: string;
}

function partialResponse(
  bytes: Uint8Array,
  start: number,
  total: number,
  etag: string | null,
  options: PartialOptions = {}
): { readonly response: RuntimeFetchResponseView; readonly reader: ScriptedReader } {
  const reader = scriptedReader(bytes);
  const end = start + bytes.byteLength - 1;
  return {
    reader,
    response: response(206, reader, {
      ...(options.url === undefined ? {} : { url: options.url }),
      etag,
      contentLength: bytes.byteLength,
      contentRange: `bytes ${String(start)}-${String(end)}/${String(total)}`,
      ...(options.contentEncoding === undefined
        ? {}
        : { contentEncoding: options.contentEncoding })
    })
  };
}

function fullResponse(
  bytes: Uint8Array,
  etag: string | null,
  url?: string
): { readonly response: RuntimeFetchResponseView; readonly reader: ScriptedReader } {
  const reader = scriptedReader(bytes);
  return {
    reader,
    response: response(200, reader, {
      ...(url === undefined ? {} : { url }),
      etag,
      contentLength: bytes.byteLength,
      contentRange: null
    })
  };
}

interface ResponseOptions {
  readonly url?: string;
  readonly etag: string | null;
  readonly contentLength: number;
  readonly contentRange: string | null;
  readonly contentEncoding?: string;
}

function response(
  status: number,
  reader: ScriptedReader,
  options: ResponseOptions
): RuntimeFetchResponseView {
  const values: Readonly<Record<string, string | null>> = {
    "content-encoding": options.contentEncoding ?? null,
    "content-length": String(options.contentLength),
    "content-range": options.contentRange,
    etag: options.etag
  };
  return {
    status,
    type: "cors",
    url: options.url ?? FINAL_URL,
    headers: { get: (name) => values[name.toLowerCase()] ?? null },
    body: { getReader: () => reader }
  };
}

interface FetchCall {
  readonly url: string;
  readonly init: Readonly<RuntimeFetchInit>;
}

type ScriptedResponse =
  | RuntimeFetchResponseView
  | { readonly response: RuntimeFetchResponseView }
  | PromiseLike<RuntimeFetchResponseView>;

function scriptedFetch(responses: readonly ScriptedResponse[]):
RuntimeFetchAdapter & { readonly calls: FetchCall[] } {
  const queue = [...responses];
  const calls: FetchCall[] = [];
  return {
    calls,
    async fetch(url, init) {
      calls.push({ url, init });
      const next = queue.shift();
      if (next === undefined) throw new Error("unexpected fetch");
      if ("then" in next) return await next;
      return "response" in next ? next.response : next;
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
  readonly #tasks = new Map<number, Readonly<{
    deadline: number;
    callback: () => void;
  }>>();
  #nextId = 1;
  #now = 0;
  public get pendingCount(): number { return this.#tasks.size; }
  public now(): number { return this.#now; }
  public setTimeout(callback: () => void, milliseconds: number): number {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#tasks.set(id, { deadline: this.#now + milliseconds, callback });
    return id;
  }
  public clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.#tasks.delete(handle);
  }
  public advance(milliseconds: number): void {
    this.#now += milliseconds;
    while (true) {
      const due = [...this.#tasks]
        .filter(([, task]) => task.deadline <= this.#now)
        .sort((left, right) => left[1].deadline - right[1].deadline)[0];
      if (due === undefined) return;
      this.#tasks.delete(due[0]);
      due[1].callback();
    }
  }
}

function requireRangeSession(
  value: Awaited<ReturnType<typeof openRangeAssetSession>>
): RuntimeRangeAssetSession {
  if (value.mode !== "range") throw new Error("expected range session");
  return value;
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

void parseHeader;
