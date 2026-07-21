import {
  FORMAT_HEADER_LENGTH,
  FormatError,
  parseFrontIndex as parseCanonicalFrontIndex,
  parseHeader as parseCanonicalHeader,
  parseManifestPrefix as parseCanonicalManifestPrefix,
  parseVideoCodecString,
  validateCompleteAsset,
  type CompiledManifest,
  type EncodedChunkRecord,
  type FormatHeader,
  type ParsedFrontIndex,
  type ParsedManifestPrefix,
  type UnitBlobRange,
  type VideoCodec
} from "@pixel-point/aval-format";
import type { Source } from "./player-contract.js";

export interface AssetPlatform {
  readonly fetch: typeof globalThis.fetch;
  readonly crypto: Crypto;
  readonly setTimeout?: (callback: () => void, delay: number) => number;
  readonly clearTimeout?: (handle: number) => void;
}

export interface AssetSnapshot {
  readonly mode: "range" | "full";
  readonly disposed: boolean;
  readonly declaredFileBytes: number;
  readonly metadataBytes: number;
  readonly verifiedBytes: number;
  readonly residentBlobBytes: number;
  readonly requestCount: number;
  readonly rangeRequestCount: number;
  readonly fullRequestCount: number;
  readonly activeTransportBodies: number;
  readonly pendingLoads: number;
  readonly interestedWaiters: number;
  readonly transportBytes: number;
  readonly blobs: {
    readonly total: number;
    readonly absent: number;
    readonly loading: number;
    readonly verified: number;
  };
}

type Metrics = {
  requests: number;
  ranges: number;
  full: number;
  active: number;
  bytes: number;
};
type LoadWaiter = {
  readonly signal: AbortSignal | undefined;
  readonly resolve: (value: Uint8Array<ArrayBuffer>) => void;
  readonly reject: (error: unknown) => void;
  abort: (() => void) | undefined;
  settled: boolean;
};
type Load = {
  readonly key: string;
  readonly controller: AbortController;
  readonly promise: Promise<Uint8Array<ArrayBuffer>>;
  readonly waiters: Set<LoadWaiter>;
  readonly timer: number;
};
type BodyWaiter = {
  readonly signal: AbortSignal;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly abort: () => void;
  settled: boolean;
};

const MAX = Number.MAX_SAFE_INTEGER;
const EMPTY = new Uint8Array(0);
const RESPONSE_WATCHDOGS = new WeakMap<Response, Watchdog>();
const OVERALL_MS = 5_000;
const BODY_MS = 2_000;

type Watchdog = {
  readonly controller: AbortController;
  readonly signal: AbortSignal | undefined;
  abort: (() => void) | undefined;
  readonly waits: Set<(error: unknown) => void>;
  readonly setTimeout: (callback: () => void, delay: number) => number;
  readonly clearTimeout: (handle: number) => void;
  overall: number | undefined;
  body: number | undefined;
};

function bad(): never {
  throw new Error("Invalid AVAL asset");
}

function add(a: number, b: number, maximum = MAX): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0 || a > maximum - b) bad();
  return a + b;
}

function zero(bytes: Uint8Array, offset: number, length: number): void {
  const end = add(offset, length, bytes.byteLength);
  for (let i = offset; i < end; i += 1) if (bytes[i] !== 0) bad();
}

function formatBoundary<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof FormatError) return bad();
    throw error;
  }
}

function parseHeader(bytes: Uint8Array): Readonly<FormatHeader> {
  return formatBoundary(() => parseCanonicalHeader(bytes));
}

function parseManifestPrefix(
  bytes: Uint8Array,
  expectedFamily: VideoCodec
): Readonly<ParsedManifestPrefix> {
  const parsed = formatBoundary(() => parseCanonicalManifestPrefix(bytes));
  if (parsed.manifest.codec !== expectedFamily) bad();
  return parsed;
}

function parseFront(
  bytes: Uint8Array,
  expectedFamily: VideoCodec
): Readonly<ParsedFrontIndex> {
  const parsed = formatBoundary(() => parseCanonicalFrontIndex(bytes));
  if (parsed.manifest.codec !== expectedFamily) bad();
  return parsed;
}

function validateFull(
  bytes: Uint8Array,
  frontIndex: Readonly<ParsedFrontIndex>
): void {
  formatBoundary(() => validateCompleteAsset({ bytes, frontIndex }));
}

function sourceInput(source: Readonly<Source>, documentBase: string): {
  url: string;
  integrity: string;
  family: VideoCodec;
} {
  let src: unknown;
  let sourceCodec: unknown;
  let integrity: unknown;
  try {
    src = source.src;
    sourceCodec = source.codec;
    integrity = source.integrity;
  } catch {
    return bad();
  }
  if (typeof src !== "string" || src.length < 1 || src.length > 4096 || /[\u0000-\u001f\u007f]/.test(src)) bad();
  if (typeof sourceCodec !== "string") bad();
  const parsedCodec = parseVideoCodecString(sourceCodec);
  if (parsedCodec === undefined) bad();
  if (typeof integrity !== "string") bad();
  if (integrity !== "") {
    const match = /^sha256-([A-Za-z0-9+/]{43})=$/.exec(integrity);
    const last = match === null
      ? -1
      : "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(match[1]!.at(-1)!);
    if (match === null || last < 0 || (last & 3) !== 0) bad();
  }
  let url: URL;
  try { url = new URL(src, documentBase); } catch { return bad(); }
  if (url.protocol !== "http:" && url.protocol !== "https:") bad();
  return { url: url.href, integrity, family: parsedCodec.family };
}

function strong(value: string | null): string | null {
  if (value === null) return null;
  const match = /^[\t ]*(.*?)[\t ]*$/.exec(value);
  if (match === null) return null;
  const tag = match[1]!;
  if (tag.length < 2 || tag.startsWith("W/") || tag[0] !== '"' || tag.at(-1) !== '"') return null;
  for (let i = 1; i < tag.length - 1; i += 1) {
    const code = tag.charCodeAt(i);
    if (code !== 0x21 && !(code >= 0x23 && code <= 0x7e) && !(code >= 0x80 && code <= 0xff)) return null;
  }
  return tag;
}

function responseUrl(response: Response, pinned?: string): string {
  if (!["basic", "cors", "default"].includes(response.type) || !response.url) bad();
  for (let i = 0; i < response.url.length; i += 1) {
    const code = response.url.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) bad();
  }
  let url: URL;
  try { url = new URL(response.url); } catch { return bad(); }
  if (url.protocol !== "http:" && url.protocol !== "https:" || pinned !== undefined && url.href !== pinned) bad();
  return url.href;
}

function partialMetadata(response: Response, start: number, end: number, knownTotal?: number,
  pinnedUrl?: string, pinnedTag?: string): { url: string; total: number; tag: string | null } {
  if (response.status !== 206) bad();
  const url = responseUrl(response, pinnedUrl);
  const encoding = response.headers.get("Content-Encoding");
  if (encoding !== null && !/^[\t ]*identity[\t ]*$/i.test(encoding)) bad();
  const length = end - start + 1;
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null) {
    const parsedLength = /^[\t ]*((?:0|[1-9][0-9]*))[\t ]*$/.exec(contentLength);
    if (parsedLength === null || !Number.isSafeInteger(Number(parsedLength[1])) || Number(parsedLength[1]) !== length) bad();
  }
  const match = /^[\t ]*bytes ([0-9]+)-([0-9]+)\/([0-9]+)[\t ]*$/i.exec(response.headers.get("Content-Range") ?? "");
  if (match === null || [match[1], match[2], match[3]].some((part) => !/^(?:0|[1-9][0-9]*)$/.test(part!))) bad();
  const values = match.slice(1).map(Number);
  if (values.some((value) => !Number.isSafeInteger(value)) || values[0] !== start || values[1] !== end ||
    values[2]! <= end || knownTotal !== undefined && values[2] !== knownTotal) bad();
  const tag = strong(response.headers.get("ETag"));
  if (pinnedTag !== undefined && tag !== pinnedTag) bad();
  return { url, total: values[2]!, tag };
}

async function request(
  platform: Readonly<AssetPlatform>,
  metrics: Metrics,
  url: string,
  init: RequestInit,
  range: boolean
): Promise<Response> {
  metrics.requests += 1;
  if (range) metrics.ranges += 1;
  else metrics.full += 1;
  metrics.active += 1;
  const watchdog = createWatchdog(init.signal ?? undefined, platform);
  const pending = Promise.resolve().then(() =>
    platform.fetch(url, { ...init, signal: watchdog.controller.signal })
  );
  try {
    const response = await watched(watchdog, pending);
    RESPONSE_WATCHDOGS.set(response, watchdog);
    armBody(watchdog);
    return response;
  } catch (error) {
    void pending.then((late) => late.body?.cancel(), () => undefined).catch(() => undefined);
    completeWatchdog(watchdog);
    metrics.active -= 1;
    throw error;
  }
}

async function bytes(
  metrics: Metrics,
  response: Response,
  expected: number
): Promise<Uint8Array<ArrayBuffer>>;
async function bytes(
  metrics: Metrics,
  response: Response,
  expected: undefined,
  family: VideoCodec
): Promise<Readonly<{ bytes: Uint8Array<ArrayBuffer>; parsed: Readonly<ParsedFrontIndex> }>>;
async function bytes(
  metrics: Metrics,
  response: Response,
  expected: number | undefined,
  family?: VideoCodec
): Promise<Uint8Array<ArrayBuffer> | Readonly<{
  bytes: Uint8Array<ArrayBuffer>;
  parsed: Readonly<ParsedFrontIndex>;
}>> {
  const watchdog = RESPONSE_WATCHDOGS.get(response);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let failed = true;
  try {
    if (watchdog === undefined || response.body === null) bad();
    if (expected === undefined && family === undefined) bad();
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0 || expected > MAX)) bad();
    let contentLength = canonicalLength(response.headers.get("Content-Length"));
    if (contentLength !== null && contentLength > MAX) bad();
    if (expected !== undefined && contentLength !== null && contentLength !== expected) bad();
    if (expected === undefined) {
      const encoding = response.headers.get("Content-Encoding");
      if (encoding !== null && !/^[\t ]*identity[\t ]*$/i.test(encoding)) contentLength = null;
    }
    reader = response.body.getReader();
    let prefix = expected === undefined ? new Uint8Array(FORMAT_HEADER_LENGTH) : null;
    let output = expected === undefined ? null : new Uint8Array(expected);
    let header: Readonly<FormatHeader> | undefined;
    let admission: Readonly<ParsedManifestPrefix> | undefined;
    let parsed: Readonly<ParsedFrontIndex> | undefined;
    let offset = 0;
    let prefixOffset = 0;
    while (true) {
      const step = await watched(watchdog, Promise.resolve(reader.read()));
      if (typeof step !== "object" || step === null || typeof step.done !== "boolean") bad();
      if (step.done) {
        if (output === null || offset !== output.byteLength) bad();
        if (expected === undefined) {
          if (parsed === undefined) bad();
          validateFull(output, parsed);
        }
        metrics.bytes = add(metrics.bytes, offset);
        failed = false;
        return expected === undefined ? { bytes: output, parsed: parsed! } : output;
      }
      const received = step.value;
      if (!isUint8Array(received)) bad();
      const chunk = new Uint8Array(received.byteLength);
      chunk.set(received);
      if (chunk.byteLength === 0) continue;
      armBody(watchdog);
      if (chunk.byteLength > MAX - offset) bad();
      let start = 0;
      while (start < chunk.byteLength) {
        if (output !== null) {
          const length = chunk.byteLength - start;
          if (length > output.byteLength - offset) bad();
          output.set(chunk.subarray(start), offset);
          offset += length;
          break;
        }
        const target = prefix!;
        const length = Math.min(target.byteLength - prefixOffset, chunk.byteLength - start);
        target.set(chunk.subarray(start, start + length), prefixOffset);
        prefixOffset += length;
        offset += length;
        start += length;
        if (prefixOffset !== target.byteLength) continue;
        if (header === undefined) {
          header = parseHeader(target);
          if (contentLength !== null && contentLength !== header.declaredFileLength) bad();
          prefix = new Uint8Array(header.indexOffset);
          prefix.set(target);
          continue;
        }
        if (admission === undefined) {
          admission = parseManifestPrefix(target, family!);
          header = admission.header;
          prefix = new Uint8Array(admission.frontIndexRange.length);
          prefix.set(target);
          continue;
        }
        parsed = parseFront(target, family!);
        output = new Uint8Array(parsed.header.declaredFileLength);
        output.set(target);
        prefix = null;
      }
    }
  } finally {
    if (failed && reader !== null) {
      try { void reader.cancel().catch(() => undefined); } catch { /* Body retirement is best effort. */ }
    }
    try { reader?.releaseLock(); } catch { /* A hostile pending read may retain its lock until abort settles. */ }
    releaseResponse(metrics, response);
  }
}

function isUint8Array(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) &&
    Object.prototype.toString.call(value) === "[object Uint8Array]";
}

async function retire(metrics: Metrics, response: Response): Promise<void> {
  try { void response.body?.cancel().catch(() => undefined); } catch { /* Fetch ownership is already retired. */ }
  releaseResponse(metrics, response);
}

function releaseResponse(metrics: Metrics, response: Response): void {
  const watchdog = RESPONSE_WATCHDOGS.get(response);
  if (watchdog !== undefined) {
    RESPONSE_WATCHDOGS.delete(response);
    completeWatchdog(watchdog);
    metrics.active -= 1;
  }
}

function canonicalLength(value: string | null): number | null {
  if (value === null) return null;
  const match = /^[\t ]*((?:0|[1-9][0-9]*))[\t ]*$/.exec(value);
  const parsed = match === null ? -1 : Number(match[1]);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== match![1]) bad();
  return parsed;
}

function createWatchdog(
  signal: AbortSignal | null | undefined,
  platform: Readonly<AssetPlatform>
): Watchdog {
  const controller = new AbortController();
  const schedule = platform.setTimeout ?? ((callback: () => void, delay: number) =>
    globalThis.setTimeout(callback, delay) as unknown as number);
  const cancel = platform.clearTimeout ?? ((handle: number) => globalThis.clearTimeout(handle));
  const watchdog: Watchdog = {
    controller,
    signal: signal ?? undefined,
    abort: undefined,
    waits: new Set(),
    setTimeout: schedule,
    clearTimeout: cancel,
    overall: undefined,
    body: undefined
  };
  if (signal?.aborted) terminateWatchdog(watchdog, signal.reason);
  else if (signal !== null && signal !== undefined) {
    const abort = (): void => terminateWatchdog(watchdog, signal.reason);
    watchdog.abort = abort;
    signal.addEventListener("abort", abort, { once: true });
  }
  if (!controller.signal.aborted) {
    watchdog.overall = schedule(() => timeoutWatchdog(watchdog), OVERALL_MS);
  }
  return watchdog;
}

function watched<T>(watchdog: Watchdog, operation: Promise<T>): Promise<T> {
  if (watchdog.controller.signal.aborted) return Promise.reject(watchdog.controller.signal.reason);
  return new Promise<T>((resolve, reject) => {
    let active = true;
    const stop = (error: unknown): void => {
      if (!active) return;
      active = false;
      watchdog.waits.delete(stop);
      reject(error);
    };
    watchdog.waits.add(stop);
    operation.then((value) => {
      if (!active) return;
      active = false;
      watchdog.waits.delete(stop);
      resolve(value);
    }, stop);
  });
}

function armBody(watchdog: Watchdog): void {
  if (watchdog.controller.signal.aborted) return;
  if (watchdog.body !== undefined) watchdog.clearTimeout(watchdog.body);
  watchdog.body = watchdog.setTimeout(() => timeoutWatchdog(watchdog), BODY_MS);
}

function timeoutWatchdog(watchdog: Watchdog): void {
  terminateWatchdog(watchdog, new DOMException("AVAL asset load timed out", "TimeoutError"));
}

function terminateWatchdog(watchdog: Watchdog, error: unknown): void {
  if (watchdog.controller.signal.aborted) return;
  watchdog.controller.abort(error);
  for (const reject of watchdog.waits) reject(error);
  watchdog.waits.clear();
}

function completeWatchdog(watchdog: Watchdog): void {
  if (watchdog.overall !== undefined) watchdog.clearTimeout(watchdog.overall);
  if (watchdog.body !== undefined) watchdog.clearTimeout(watchdog.body);
  watchdog.overall = undefined;
  watchdog.body = undefined;
  if (watchdog.signal !== undefined && watchdog.abort !== undefined) {
    watchdog.signal.removeEventListener("abort", watchdog.abort);
  }
}

async function fullResponse(metrics: Metrics, response: Response, family: VideoCodec,
  pinnedUrl?: string, pinnedTag?: string): Promise<{
    parsed: Readonly<ParsedFrontIndex>;
    bytes: Uint8Array<ArrayBuffer>;
    url: string;
    tag: string | null;
  }> {
  try {
    if (response.status !== 200) bad();
    const url = responseUrl(response, pinnedUrl);
    const tag = strong(response.headers.get("ETag"));
    if (pinnedTag !== undefined && tag !== pinnedTag) bad();
    const value = await bytes(metrics, response, undefined, family);
    return { ...value, url, tag };
  } catch (error) {
    await retire(metrics, response);
    throw error;
  }
}

export class Asset {
  readonly manifest: Readonly<CompiledManifest>;
  readonly records: readonly Readonly<EncodedChunkRecord>[];
  readonly blobs: readonly Readonly<UnitBlobRange>[];
  readonly #family: VideoCodec;
  readonly #credentials: RequestCredentials;
  readonly #requestUrl: string;
  readonly #controller: AbortController;
  readonly #metrics: Metrics;
  readonly #caller: AbortSignal;
  readonly #abortListener: () => void;
  readonly #platform: Readonly<AssetPlatform>;
  readonly #cache = new Map<string, Uint8Array<ArrayBuffer>>();
  readonly #loads = new Map<string, Load>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #bodyQueue: BodyWaiter[] = [];
  #bodyActive = 0;
  #mode: "range" | "full";
  #url: string;
  #etag: string | null;
  #front: Uint8Array<ArrayBuffer>;
  #file: Uint8Array<ArrayBuffer> | null;
  #disposed = false;
  #disposePromise: Promise<void> | null = null;

  private constructor(parsed: Readonly<ParsedFrontIndex>, mode: "range" | "full", requestUrl: string,
    url: string, etag: string | null,
    front: Uint8Array<ArrayBuffer>, file: Uint8Array<ArrayBuffer> | null, family: VideoCodec,
    credentials: RequestCredentials,
    controller: AbortController, caller: AbortSignal, abortListener: () => void,
    metrics: Metrics, platform: Readonly<AssetPlatform>) {
    this.manifest = parsed.manifest;
    this.records = parsed.records;
    this.blobs = parsed.unitBlobs;
    this.#mode = mode;
    this.#requestUrl = requestUrl;
    this.#url = url;
    this.#etag = etag;
    this.#front = front;
    this.#file = file;
    this.#family = family;
    this.#credentials = credentials;
    this.#controller = controller;
    this.#caller = caller;
    this.#abortListener = abortListener;
    this.#metrics = metrics;
    this.#platform = platform;
  }

  static async open(source: Readonly<Source>, documentBase: string,
    credentials: RequestCredentials, signal: AbortSignal,
    platform: Readonly<AssetPlatform> = {
      fetch: globalThis.fetch.bind(globalThis),
      crypto: globalThis.crypto
    }): Promise<Asset> {
    if (!["omit", "same-origin", "include"].includes(credentials) ||
      typeof signal !== "object" || signal === null) bad();
    signal.throwIfAborted();
    const input = sourceInput(source, documentBase);
    const controller = new AbortController();
    const metrics: Metrics = { requests: 0, ranges: 0, full: 0, active: 0, bytes: 0 };
    let asset: Asset | null = null;
    const abortListener = (): void => {
      controller.abort(signal.reason);
      if (asset !== null) void asset.dispose();
    };
    signal.addEventListener("abort", abortListener, { once: true });
    try {
      if (input.integrity !== "") {
        const response = await request(platform, metrics, input.url, {
          credentials, signal: controller.signal, integrity: input.integrity
        }, false);
        const full = await fullResponse(metrics, response, input.family);
        asset = new Asset(full.parsed, "full", input.url, full.url, full.tag,
          full.bytes.subarray(0, full.parsed.frontIndexRange.length), full.bytes, input.family,
          credentials, controller, signal, abortListener, metrics, platform);
        return asset;
      }
      let response = await request(platform, metrics, input.url, {
        credentials,
        signal: controller.signal,
        headers: { Range: `bytes=0-${String(FORMAT_HEADER_LENGTH - 1)}` }
      }, true);
      if (response.status === 200) {
        const full = await fullResponse(metrics, response, input.family);
        asset = new Asset(full.parsed, "full", input.url, full.url, full.tag,
          full.bytes.subarray(0, full.parsed.frontIndexRange.length), full.bytes, input.family,
          credentials, controller, signal, abortListener, metrics, platform);
        return asset;
      }
      let initial: ReturnType<typeof partialMetadata>;
      try { initial = partialMetadata(response, 0, FORMAT_HEADER_LENGTH - 1); }
      catch (error) { await retire(metrics, response); throw error; }
      if (initial.tag === null) {
        await retire(metrics, response);
        response = await request(
          platform,
          metrics,
          input.url,
          { credentials, signal: controller.signal },
          false
        );
        const full = await fullResponse(metrics, response, input.family, initial.url);
        asset = new Asset(full.parsed, "full", input.url, full.url, full.tag,
          full.bytes.subarray(0, full.parsed.frontIndexRange.length), full.bytes, input.family,
          credentials, controller, signal, abortListener, metrics, platform);
        return asset;
      }
      let headerBytes: Uint8Array<ArrayBuffer>;
      try { headerBytes = await bytes(metrics, response, FORMAT_HEADER_LENGTH); }
      catch (error) { await retire(metrics, response); throw error; }
      const header = parseHeader(headerBytes);
      if (header.declaredFileLength !== initial.total) bad();
      const manifestEnd = header.indexOffset - 1;
      response = await request(platform, metrics, input.url, {
        credentials, signal: controller.signal,
        headers: {
          Range: `bytes=${String(FORMAT_HEADER_LENGTH)}-${String(manifestEnd)}`,
          "If-Range": initial.tag
        }
      }, true);
      if (response.status === 200) {
        const full = await fullResponse(metrics, response, input.family, initial.url, initial.tag);
        asset = new Asset(full.parsed, "full", input.url, full.url, full.tag,
          full.bytes.subarray(0, full.parsed.frontIndexRange.length), full.bytes, input.family,
          credentials, controller, signal, abortListener, metrics, platform);
        return asset;
      }
      try {
        partialMetadata(
          response,
          FORMAT_HEADER_LENGTH,
          manifestEnd,
          initial.total,
          initial.url,
          initial.tag
        );
      }
      catch (error) { await retire(metrics, response); throw error; }
      let manifestTail: Uint8Array<ArrayBuffer>;
      try {
        manifestTail = await bytes(
          metrics,
          response,
          header.indexOffset - FORMAT_HEADER_LENGTH
        );
      }
      catch (error) { await retire(metrics, response); throw error; }
      const manifestPrefix = new Uint8Array(header.indexOffset);
      manifestPrefix.set(headerBytes);
      manifestPrefix.set(manifestTail, FORMAT_HEADER_LENGTH);
      const admission = parseManifestPrefix(manifestPrefix, input.family);
      const frontLength = admission.frontIndexRange.length;
      const indexOffset = admission.header.indexOffset;
      const indexEnd = frontLength - 1;
      response = await request(platform, metrics, input.url, {
        credentials, signal: controller.signal,
        headers: {
          Range: `bytes=${String(indexOffset)}-${String(indexEnd)}`,
          "If-Range": initial.tag
        }
      }, true);
      if (response.status === 200) {
        const full = await fullResponse(metrics, response, input.family, initial.url, initial.tag);
        asset = new Asset(full.parsed, "full", input.url, full.url, full.tag,
          full.bytes.subarray(0, full.parsed.frontIndexRange.length), full.bytes, input.family,
          credentials, controller, signal, abortListener, metrics, platform);
        return asset;
      }
      try {
        partialMetadata(
          response,
          indexOffset,
          indexEnd,
          initial.total,
          initial.url,
          initial.tag
        );
      }
      catch (error) { await retire(metrics, response); throw error; }
      let indexBytes: Uint8Array<ArrayBuffer>;
      try {
        indexBytes = await bytes(
          metrics,
          response,
          frontLength - indexOffset
        );
      }
      catch (error) { await retire(metrics, response); throw error; }
      const front = new Uint8Array(frontLength);
      front.set(manifestPrefix);
      front.set(indexBytes, indexOffset);
      const parsed = parseFront(front, input.family);
      asset = new Asset(parsed, "range", input.url, initial.url, initial.tag, front, null,
        input.family, credentials, controller, signal, abortListener, metrics, platform);
      return asset;
    } catch (error) {
      controller.abort();
      signal.removeEventListener("abort", abortListener);
      throw error;
    }
  }

  get mode(): "range" | "full" { return this.#mode; }

  unitBytes(rendition: string, unit: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    if (this.#disposed) return Promise.reject(new Error("Disposed AVAL asset"));
    const blob = this.blobs.find((value) => value.rendition === rendition && value.unit === unit);
    if (blob === undefined) return Promise.reject(new Error("Unknown AVAL unit"));
    const key = `${rendition}\0${unit}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined) return signal === undefined ? Promise.resolve(cached) : wait(Promise.resolve(cached), signal);
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    let load = this.#loads.get(key);
    if (load === undefined) {
      const controller = new AbortController();
      const waiters = new Set<LoadWaiter>();
      const schedule = this.#platform.setTimeout ?? (
        (callback: () => void, delay: number) =>
          globalThis.setTimeout(callback, delay) as unknown as number
      );
      const cancel = this.#platform.clearTimeout ?? (
        (handle: number) => globalThis.clearTimeout(handle)
      );
      const timer = schedule(() => controller.abort(timeoutError()), OVERALL_MS);
      let owned!: Load;
      const promise = Promise.resolve().then(() => this.#load(blob, controller.signal)).then(async (value) => {
        if (!await verify(value, blob.sha256, this.#platform.crypto)) bad();
        controller.signal.throwIfAborted();
        if (this.#disposed) throw new Error("Disposed AVAL asset");
        this.#cache.set(key, value);
        return value;
      }).finally(() => {
        cancel(timer);
        if (this.#loads.get(key) === owned) this.#loads.delete(key);
      });
      load = owned = { key, controller, promise, waiters, timer };
      this.#loads.set(key, load);
      const tracked = promise.then(() => undefined, () => undefined)
        .finally(() => { this.#pending.delete(tracked); });
      this.#pending.add(tracked);
    }
    return this.#attach(load, signal);
  }

  chunkBytes(rendition: string, unit: string, decodeIndex: number): ArrayBuffer {
    const blob = this.blobs.find((value) => value.rendition === rendition && value.unit === unit);
    const cached = this.#cache.get(`${rendition}\0${unit}`);
    if (blob === undefined || cached === undefined || !Number.isSafeInteger(decodeIndex) ||
      decodeIndex < 0 || decodeIndex >= blob.chunkCount) bad();
    const record = this.records[blob.chunkStart + decodeIndex];
    if (record === undefined) bad();
    const offset = record.byteOffset - blob.offset;
    if (offset < 0 || offset + record.byteLength > cached.byteLength) bad();
    const output = new Uint8Array(record.byteLength);
    output.set(cached.subarray(offset, offset + record.byteLength));
    return output.buffer;
  }

  snapshot(): Readonly<AssetSnapshot> {
    let verifiedBytes = 0;
    for (const value of this.#cache.values()) verifiedBytes = add(verifiedBytes, value.byteLength);
    const loading = this.#loads.size;
    const verified = this.#cache.size;
    let interestedWaiters = 0;
    for (const load of this.#loads.values()) interestedWaiters += load.waiters.size;
    return Object.freeze({
      mode: this.#mode,
      disposed: this.#disposed,
      declaredFileBytes: this.#disposed ? 0 : this.#parsedFileLength(),
      metadataBytes: this.#disposed ? 0 : this.#front.byteLength,
      verifiedBytes: this.#disposed ? 0 : verifiedBytes,
      residentBlobBytes: this.#disposed ? 0 : this.#file === null ? verifiedBytes : this.#file.byteLength - this.#front.byteLength,
      requestCount: this.#metrics.requests,
      rangeRequestCount: this.#metrics.ranges,
      fullRequestCount: this.#metrics.full,
      activeTransportBodies: this.#metrics.active,
      pendingLoads: this.#pending.size,
      interestedWaiters,
      transportBytes: this.#metrics.bytes,
      blobs: Object.freeze({
        total: this.blobs.length,
        absent: Math.max(0, this.blobs.length - loading - verified),
        loading,
        verified
      })
    });
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== null) return this.#disposePromise;
    this.#disposed = true;
    this.#controller.abort();
    for (const load of this.#loads.values()) load.controller.abort(abortError());
    this.#caller.removeEventListener("abort", this.#abortListener);
    this.#disposePromise = Promise.allSettled([...this.#pending]).then(() => {
      this.#cache.clear();
      this.#loads.clear();
      this.#front = EMPTY;
      this.#file = null;
    });
    return this.#disposePromise;
  }

  async #load(
    blob: Readonly<UnitBlobRange>,
    signal: AbortSignal
  ): Promise<Uint8Array<ArrayBuffer>> {
    if (this.#file !== null) return this.#file.subarray(blob.offset, blob.offset + blob.length);
    const index = this.blobs.indexOf(blob);
    const preceding = index < 1
      ? this.#front.byteLength
      : this.blobs[index - 1]!.offset + this.blobs[index - 1]!.length;
    const padding = blob.offset - preceding;
    if (index < 0 || padding < 0 || padding > 7) bad();
    const output = new Uint8Array(blob.length);
    let offset = 0;
    const transferLength = padding + blob.length;
    while (offset < transferLength) {
      signal.throwIfAborted();
      const resident = this.#file as Uint8Array<ArrayBuffer> | null;
      if (resident !== null) return resident.subarray(blob.offset, blob.offset + blob.length);
      const length = Math.min(4 * 1024 * 1024, transferLength - offset);
      const start = preceding + offset;
      const end = start + length - 1;
      const result = await this.#body(signal, async () => {
        const response = await request(this.#platform, this.#metrics, this.#requestUrl, {
          credentials: this.#credentials,
          signal,
          headers: { Range: `bytes=${String(start)}-${String(end)}`, "If-Range": this.#etag! }
        }, true);
        if (response.status === 200) {
          return { full: await fullResponse(this.#metrics, response, this.#family, this.#url, this.#etag!) };
        }
        try { partialMetadata(response, start, end, this.#parsedFileLength(), this.#url, this.#etag!); }
        catch (error) { await retire(this.#metrics, response); throw error; }
        try { return { part: await bytes(this.#metrics, response, length) }; }
        catch (error) { await retire(this.#metrics, response); throw error; }
      });
      if ("full" in result) {
        const full = result.full;
        const front = full.bytes.subarray(0, full.parsed.frontIndexRange.length);
        if (!sameBytes(front, this.#front)) bad();
        const installed = this.#file as Uint8Array<ArrayBuffer> | null;
        if (installed !== null) return installed.subarray(blob.offset, blob.offset + blob.length);
        this.#mode = "full";
        this.#file = full.bytes;
        this.#cache.clear();
        return this.#file.subarray(blob.offset, blob.offset + blob.length);
      }
      const installed = this.#file as Uint8Array<ArrayBuffer> | null;
      if (installed !== null) return installed.subarray(blob.offset, blob.offset + blob.length);
      const part = result.part;
      const dataStart = Math.max(start, blob.offset);
      if (dataStart > start) zero(part, 0, dataStart - start);
      output.set(part.subarray(dataStart - start), dataStart - blob.offset);
      offset += length;
    }
    return output;
  }

  #attach(load: Load, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    return new Promise((resolve, reject) => {
      const waiter: LoadWaiter = { signal, resolve, reject, abort: undefined, settled: false };
      const settle = (error: unknown | null, value?: Uint8Array<ArrayBuffer>): void => {
        if (waiter.settled) return;
        waiter.settled = true;
        load.waiters.delete(waiter);
        if (signal !== undefined && waiter.abort !== undefined) signal.removeEventListener("abort", waiter.abort);
        if (error === null && value !== undefined) resolve(value);
        else reject(error);
      };
      waiter.abort = signal === undefined ? undefined : () => {
        settle(abortReason(signal));
        if (load.waiters.size === 0 && this.#loads.get(load.key) === load) {
          this.#loads.delete(load.key);
          load.controller.abort(abortError());
        }
      };
      load.waiters.add(waiter);
      if (signal !== undefined) {
        signal.addEventListener("abort", waiter.abort!, { once: true });
        if (signal.aborted) waiter.abort!();
      }
      load.promise.then((value) => settle(null, value), (error) => settle(error));
    });
  }

  async #body<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    await this.#acquireBody(signal);
    try {
      signal.throwIfAborted();
      return await operation();
    } finally {
      this.#releaseBody();
    }
  }

  #acquireBody(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    if (this.#bodyActive < 4) {
      this.#bodyActive += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let waiter!: BodyWaiter;
      const abort = (): void => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = this.#bodyQueue.indexOf(waiter);
        if (index >= 0) this.#bodyQueue.splice(index, 1);
        reject(abortReason(signal));
      };
      waiter = { signal, resolve, reject, abort, settled: false };
      this.#bodyQueue.push(waiter);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  #releaseBody(): void {
    this.#bodyActive -= 1;
    while (this.#bodyQueue.length > 0) {
      const waiter = this.#bodyQueue.shift()!;
      if (waiter.settled) continue;
      waiter.settled = true;
      waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.signal.aborted) {
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      this.#bodyActive += 1;
      waiter.resolve();
      return;
    }
  }

  #parsedFileLength(): number {
    const last = this.blobs.at(-1);
    return last === undefined ? this.#front.byteLength : last.offset + last.length;
  }
}

async function verify(
  bytes: Uint8Array<ArrayBuffer>,
  expected: string,
  crypto: Crypto
): Promise<boolean> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  for (let i = 0; i < 32; i += 1) if (digest[i] !== Number.parseInt(expected.slice(i * 2, i * 2 + 2), 16)) return false;
  return true;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function abortError(): DOMException {
  return new DOMException("AVAL asset load was aborted", "AbortError");
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? abortError();
}

function timeoutError(): DOMException {
  return new DOMException("AVAL asset load timed out", "TimeoutError");
}
