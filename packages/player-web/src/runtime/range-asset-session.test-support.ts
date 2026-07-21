import {
  FORMAT_HEADER_LENGTH,
  parseHeader,
  validateCompleteAsset
} from "@pixel-point/aval-format";

import {
  normalizeRuntimeAssetRequest,
  type RuntimeFetchAdapter,
  type RuntimeFetchInit,
  type RuntimeFetchResponseView
} from "./asset-fetch-contracts.js";
import { createRuntimeTestAsset } from "./asset-test-support.js";
import type {
  BoundedBodyByteLease,
  BoundedBodyByteResourceHost,
  RuntimeBodyReader,
  RuntimeBodyReadResult
} from "./bounded-body-reader.js";
import type { LoadWatchdogTimerHost } from "./load-watchdogs.js";
import type {
  openRangeAssetSession,
  RuntimeRangeAssetSession
} from "./range-asset-session.js";

export const FINAL_URL = "https://cdn.example.test/motion.avl";

export function request(integrity?: string, timeoutMs?: number) {
  return normalizeRuntimeAssetRequest({
    url: FINAL_URL,
    ...(integrity === undefined ? {} : { integrity }),
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  });
}

export function rangeFixture() {
  const asset = createRuntimeTestAsset();
  const layout = validateCompleteAsset({ bytes: asset });
  const header = parseHeader(asset);
  const frontEnd = layout.frontIndex.frontIndexRange.length;
  const firstBlob = layout.frontIndex.unitBlobs[0]!;
  return {
    asset,
    total: asset.byteLength,
    frontEnd,
    indexOffset: header.indexOffset,
    header: asset.slice(0, FORMAT_HEADER_LENGTH),
    manifestTail: asset.slice(FORMAT_HEADER_LENGTH, header.indexOffset),
    indexBytes: asset.slice(header.indexOffset, frontEnd),
    payloadStart: firstBlob.offset,
    payloadEnd: firstBlob.offset + firstBlob.length - 1
  };
}

interface PartialOptions {
  readonly url?: string;
  readonly contentEncoding?: string;
}

export function partialResponse(
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

export function fullResponse(
  bytes: Uint8Array,
  etag: string | null,
  url?: string,
  options: Readonly<{
    readonly contentEncoding?: string;
    readonly contentLength?: number;
  }> = {}
): { readonly response: RuntimeFetchResponseView; readonly reader: ScriptedReader } {
  const reader = scriptedReader(bytes);
  return {
    reader,
    response: response(200, reader, {
      ...(url === undefined ? {} : { url }),
      etag,
      contentLength: options.contentLength ?? bytes.byteLength,
      contentRange: null,
      ...(options.contentEncoding === undefined
        ? {}
        : { contentEncoding: options.contentEncoding })
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

export function response(
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

export interface FetchCall {
  readonly url: string;
  readonly init: Readonly<RuntimeFetchInit>;
}

type ScriptedResponse =
  | RuntimeFetchResponseView
  | { readonly response: RuntimeFetchResponseView }
  | PromiseLike<RuntimeFetchResponseView>;

export function scriptedFetch(responses: readonly ScriptedResponse[]):
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

export function runtimeRequestedRange(
  init: Readonly<RuntimeFetchInit>
): readonly [number, number] {
  const value = init.headers.Range ?? "";
  const match = /^bytes=([0-9]+)-([0-9]+)$/.exec(value);
  if (match === null) throw new Error(`missing range: ${value}`);
  return [Number(match[1]), Number(match[2])];
}

export interface ScriptedReader extends RuntimeBodyReader {
  readonly readCount: number;
  readonly cancelCount: number;
  readonly releaseLockCount: number;
}

export function scriptedReader(bytes: Uint8Array): ScriptedReader {
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

export class CountingResources implements BoundedBodyByteResourceHost {
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

export class PassiveTimerHost implements LoadWatchdogTimerHost {
  public now(): number { return 0; }
  public setTimeout(): object { return {}; }
  public clearTimeout(): void {}
}

export class ManualTimerHost implements LoadWatchdogTimerHost {
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

export function requireRangeSession(
  value: Awaited<ReturnType<typeof openRangeAssetSession>>
): RuntimeRangeAssetSession {
  if (value.mode !== "range") throw new Error("expected range session");
  return value;
}

export function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((accept) => { resolve = accept; });
  return { promise, resolve };
}

export async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
