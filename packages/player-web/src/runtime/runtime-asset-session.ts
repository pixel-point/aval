import {
  FORMAT_DEFAULT_BUDGETS,
  FormatError,
  type ParsedFrontIndex,
  type ValidatedAssetLayout
} from "@pixel-point/aval-format";
import {
  adoptRuntimeCatalogCompleteSource,
  createMetadataRuntimeAssetCatalog,
  createRuntimeCatalogBlobDescriptors,
  runtimeUnitBlobKey,
  RuntimeAssetCatalog
} from "./asset-catalog.js";
import {
  DEFAULT_ASSET_LOAD_TIMEOUT_MS,
  createBrowserRuntimeFetchAdapter,
  normalizeRuntimeAssetRequest,
  type RuntimeFetchAdapter
} from "./asset-fetch-contracts.js";
import type {
  PlannedBlobTransportRange,
  PlannedRuntimeBlob,
  RuntimeBlobSelection
} from "./blob-range-plan.js";
import type {
  BoundedBodyByteLease
} from "./bounded-body-reader.js";
import {
  RuntimePlaybackError,
  isRuntimePlaybackError,
  normalizeRuntimeFailure,
  type RuntimeFailureCode,
  type RuntimeFailureContext
} from "./errors.js";
import type { RuntimeFullAssetResult } from "./full-asset-fetch.js";
import type {
  LoadWatchdogTimerHost,
  RuntimeLoadOperationDeadline
} from "./load-watchdogs.js";
import type {
  RuntimeAssetRequest,
  RuntimeAssetResidencySnapshot,
  RuntimeTransportMode
} from "./model.js";
import {
  RuntimeAssetBatchCoordinator,
  type RuntimeAssetBlobLoadBatch
} from "./runtime-asset-batch.js";
import {
  createRuntimeAssetOperationDeadline,
  reserveRuntimeAssetBytes,
  reserveRuntimeAssetBytesWithinDeadline
} from "./runtime-asset-resources.js";
import {
  captureRuntimeAssetSessionResources,
  type RuntimeAssetSessionResources
} from "./runtime-asset-session-resources.js";
import {
  createRuntimeCompleteSource,
  type RuntimeCompleteSource,
  type RuntimeCompleteSourceRange
} from "./runtime-complete-source.js";
import {
  openRangeAssetSession,
  type RuntimeRangeAssetSession
} from "./range-asset-session.js";
import {
  captureRuntimeRangeAssetFormatAdapter,
  DEFAULT_RUNTIME_RANGE_ASSET_FORMAT_ADAPTER,
  type RuntimeRangeAssetFormatAdapter
} from "./range-asset-format-adapter.js";
import {
  createWebCryptoSha256Adapter,
  verifySha256AndPromote,
  type Sha256DigestAdapter
} from "./sha256-verifier.js";
import {
  promoteBorrowedVerifiedBlob,
  VerifiedBlobStore,
  type VerifiedBlobHandle,
  type VerifiedBlobLoadRequest
} from "./verified-blob-store.js";

export type { RuntimeAssetSessionResources } from "./runtime-asset-session-resources.js";
export interface OpenRuntimeAssetOptions {
  readonly resources: RuntimeAssetSessionResources;
  readonly fetcher?: RuntimeFetchAdapter;
  readonly digestAdapter?: Sha256DigestAdapter;
  readonly generation?: number;
  readonly maximumFileBytes?: number;
  readonly timers?: LoadWatchdogTimerHost;
  readonly format?: RuntimeRangeAssetFormatAdapter;
  readonly allocate?: (byteLength: number) => Uint8Array<ArrayBuffer>;
}
export interface OpenRuntimeAssetBytesOptions
extends Omit<OpenRuntimeAssetOptions, "fetcher" | "timers"> {}
export interface RuntimeAssetEnsureOptions {
  readonly signal?: AbortSignal;
}
export interface RuntimeAssetSessionSnapshot
extends RuntimeAssetResidencySnapshot {
  readonly disposed: boolean;
  readonly activeTransportBodies: number;
  readonly pendingLoads: number;
  readonly interestedWaiters: number;
}
export interface RuntimeAssetSession {
  readonly mode: RuntimeTransportMode;
  readonly catalog: RuntimeAssetCatalog;
  readonly disposed: boolean;
  ensureUnit(
    rendition: string,
    unit: string,
    options?: Readonly<RuntimeAssetEnsureOptions>
  ): Promise<Readonly<VerifiedBlobHandle>>;
  ensureRenditionUnits(
    rendition: string,
    options?: Readonly<RuntimeAssetEnsureOptions>
  ): Promise<readonly Readonly<VerifiedBlobHandle>[]>;
  /**
   * Release verified unit residency after every candidate/sample owner for the
   * rendition has retired. Metadata remains live.
   * Returns the exact persistent payload bytes released.
   */
  evictRenditionUnits(rendition: string): number;
  snapshot(): Readonly<RuntimeAssetSessionSnapshot>;
  dispose(): Promise<void>;
}
interface CapturedSessionOptions {
  readonly resources: RuntimeAssetSessionResources;
  readonly fetcher: RuntimeFetchAdapter | null;
  readonly timers: LoadWatchdogTimerHost | undefined;
  readonly digestAdapter: Sha256DigestAdapter;
  readonly generation: number;
  readonly maximumFileBytes: number;
  readonly format: RuntimeRangeAssetFormatAdapter;
  readonly allocate: (byteLength: number) => Uint8Array<ArrayBuffer>;
}
interface CompleteByteSource extends RuntimeCompleteSource {
  readonly mode: "full";
  readonly layout: Readonly<ValidatedAssetLayout>;
}

interface BlobEnsureEntry {
  readonly key: string;
  readonly selection: RuntimeBlobSelection;
}

/** Open an HTTP asset after bounded metadata validation, without payload reads. */
export async function openRuntimeAsset(
  requestValue: Readonly<RuntimeAssetRequest>,
  optionsValue: Readonly<OpenRuntimeAssetOptions>
): Promise<RuntimeAssetSession> {
  const options = captureOptions(optionsValue);
  const request = normalizeRuntimeAssetRequest(requestValue, {
    maximumFileBytes: options.maximumFileBytes
  });
  const controller = new AbortController();
  const deadline = createRuntimeAssetOperationDeadline(
    request.policy.overallTimeoutMs,
    options.timers,
    request.signal === null ? [] : [request.signal]
  );
  let opened: Readonly<RuntimeFullAssetResult> | RuntimeRangeAssetSession | null =
    null;
  let metadataLease: BoundedBodyByteLease | null = null;
  try {
    const fetcher = options.fetcher ?? defaultFetchAdapter();
    opened = await openRangeAssetSession({
      request,
      fetcher,
      resources: options.resources.response,
      fullResources: options.resources.full,
      generation: options.generation,
      isGenerationCurrent: (generation) =>
        generation === options.generation && !controller.signal.aborted,
      ...(options.timers === undefined
        ? {}
        : { timers: options.timers }),
      deadline,
      digestAdapter: options.digestAdapter,
      format: options.format,
      allocate: options.allocate
    });
    const mode = opened.mode;
    const frontIndex = mode === "range"
      ? opened.frontIndex
      : opened.layout.frontIndex;
    const source: CompleteByteSource | RuntimeRangeAssetSession =
      opened.mode === "range"
        ? opened
        : createCompleteSource(opened.bytes, opened.layout, opened);
    if (mode === "range") {
      metadataLease = await reserveRuntimeAssetBytesWithinDeadline(
        options.resources.metadata,
        frontIndex.frontIndexRange.length,
        deadline
      );
      opened.releaseMetadata();
    }
    const session = new RuntimeAssetSessionImpl({
      options,
      mode,
      frontIndex,
      source,
      metadataLease,
      controller,
      callerSignal: request.signal,
      operationTimeoutMs: request.policy.overallTimeoutMs
    });
    opened = null;
    metadataLease = null;
    return session;
  } catch (cause) {
    controller.abort();
    safeRelease(metadataLease);
    await retireOpenedSource(opened);
    throw normalizeSessionFailure(cause);
  } finally {
    deadline.complete();
  }
}

/** Copy and validate complete caller bytes, then expose the same sparse path. */
export async function openRuntimeAssetBytes(
  callerBytes: Uint8Array,
  optionsValue: Readonly<OpenRuntimeAssetBytesOptions>
): Promise<RuntimeAssetSession> {
  const options = captureOptions(optionsValue);
  if (
    !(callerBytes instanceof Uint8Array) ||
    callerBytes.byteLength < 1 ||
    callerBytes.byteLength > options.maximumFileBytes
  ) {
    throw runtimeError("invalid-asset");
  }

  const controller = new AbortController();
  let lease: BoundedBodyByteLease | null = null;
  let source: CompleteByteSource | null = null;
  try {
    lease = await reserveRuntimeAssetBytes(
      options.resources.full,
      callerBytes.byteLength
    );
    const bytes = allocateExact(options.allocate, callerBytes.byteLength);
    Uint8Array.prototype.set.call(bytes, callerBytes, 0);
    const layout = options.format.validateCompleteAsset(
      bytes,
      options.maximumFileBytes
    );
    lease.promoteToAssetFull?.();
    source = createCompleteSource(bytes, layout, lease);
    lease = null;
    const session = new RuntimeAssetSessionImpl({
      options,
      mode: "full",
      frontIndex: layout.frontIndex,
      source,
      metadataLease: null,
      controller,
      callerSignal: null,
      operationTimeoutMs: DEFAULT_ASSET_LOAD_TIMEOUT_MS
    });
    source = null;
    return session;
  } catch (cause) {
    controller.abort();
    source?.release();
    safeRelease(lease);
    throw normalizeSessionFailure(cause);
  }
}

class RuntimeAssetSessionImpl implements RuntimeAssetSession {
  public readonly catalog: RuntimeAssetCatalog;

  readonly #options: Readonly<CapturedSessionOptions>;
  readonly #frontIndex: Readonly<ParsedFrontIndex>;
  readonly #controller: AbortController;
  readonly #operationTimeoutMs: number;
  readonly #store: VerifiedBlobStore;
  readonly #batch: RuntimeAssetBatchCoordinator;
  #rangeSource: RuntimeRangeAssetSession | null;
  #completeSource: CompleteByteSource | null;
  #metadataLease: BoundedBodyByteLease | null;
  #mode: RuntimeTransportMode;
  #callerAbortLink: Readonly<{
    signal: AbortSignal;
    listener: () => void;
  }> | null = null;
  #disposed = false;
  #disposePromise: Promise<void> | null = null;

  public constructor(input: Readonly<{
    options: Readonly<CapturedSessionOptions>;
    mode: RuntimeTransportMode;
    frontIndex: Readonly<ParsedFrontIndex>;
    source: CompleteByteSource | RuntimeRangeAssetSession;
    metadataLease: BoundedBodyByteLease | null;
    controller: AbortController;
    callerSignal: AbortSignal | null;
    operationTimeoutMs: number;
  }>) {
    this.#options = input.options;
    this.#mode = input.mode;
    this.#frontIndex = input.frontIndex;
    this.#controller = input.controller;
    this.#operationTimeoutMs = input.operationTimeoutMs;
    this.#rangeSource = input.source.mode === "range" ? input.source : null;
    this.#completeSource = input.source.mode === "full" ? input.source : null;
    this.#metadataLease = input.metadataLease;
    this.#batch = new RuntimeAssetBatchCoordinator({
      frontIndex: input.frontIndex,
      generation: input.options.generation,
      targetRequestBytes: Math.min(4 * 1024 * 1024, input.options.maximumFileBytes),
      maximumActiveBodies: 4,
      resources: input.options.resources.assembly,
      readComplete: (offset, length) => this.#readComplete(offset, length),
      fetchRange: (range, signal) => this.#fetchBatchRange(range, signal),
      verifyAndPromote: (blob, quarantined, request) =>
        this.#verifyAndPromote(blob, quarantined, request),
      verifyBorrowedAndPromote: (blob, source, request) =>
        this.#verifyAndPromote(
          blob, { bytes: source.bytes, release() {} }, request, source
        )
    });
    this.#store = new VerifiedBlobStore({
      generation: input.options.generation,
      descriptors: createRuntimeCatalogBlobDescriptors(input.frontIndex),
      resources: input.options.resources.verified,
      signal: input.controller.signal,
      allocate: input.options.allocate
    });
    this.catalog = createMetadataRuntimeAssetCatalog({
      frontIndex: input.frontIndex,
      declaredFileLength: input.frontIndex.header.declaredFileLength,
      mode: input.mode,
      blobStore: this.#store
    });
    this.#linkCaller(input.callerSignal);
  }

  public get mode(): RuntimeTransportMode {
    return this.#mode;
  }
  public get disposed(): boolean { return this.#disposed; }

  public ensureUnit(
    rendition: string,
    unit: string,
    options: Readonly<RuntimeAssetEnsureOptions> = {}
  ): Promise<Readonly<VerifiedBlobHandle>> {
    const source = this.#frontIndex.unitBlobs.find((blob) =>
      blob.rendition === rendition && blob.unit === unit
    );
    if (source === undefined) {
      return Promise.reject(runtimeError("invalid-asset", { rendition, unit }));
    }
    return this.#ensure(
      runtimeUnitBlobKey(rendition, unit),
      { kind: "unit", rendition, unit },
      options
    );
  }

  public ensureRenditionUnits(
    rendition: string,
    options: Readonly<RuntimeAssetEnsureOptions> = {}
  ): Promise<readonly Readonly<VerifiedBlobHandle>[]> {
    const blobs = this.#frontIndex.unitBlobs.filter(
      (blob) => blob.rendition === rendition
    );
    if (blobs.length === 0) {
      return Promise.reject(runtimeError("invalid-asset", { rendition }));
    }
    return this.#ensureMany(blobs.map((blob) => ({
      key: runtimeUnitBlobKey(blob.rendition, blob.unit),
      selection: {
        kind: "unit" as const,
        rendition: blob.rendition,
        unit: blob.unit
      }
    })), options);
  }

  public evictRenditionUnits(rendition: string): number {
    if (this.#disposed) throw runtimeError("disposed");
    const blobs = this.#frontIndex.unitBlobs.filter(
      (blob) => blob.rendition === rendition
    );
    if (blobs.length === 0) {
      throw runtimeError("invalid-asset", { rendition });
    }
    let releasedBytes = 0;
    for (const blob of blobs) {
      if (this.#store.evict(runtimeUnitBlobKey(blob.rendition, blob.unit))) {
        releasedBytes += blob.length;
      }
    }
    return releasedBytes;
  }

  public snapshot(): Readonly<RuntimeAssetSessionSnapshot> {
    const catalog = this.catalog.residencySnapshot();
    const store = this.#store.snapshot();
    return Object.freeze({
      ...catalog,
      disposed: this.#disposed,
      activeTransportBodies: this.#batch.activeTransportBodies,
      pendingLoads: store.pendingLoadCount,
      interestedWaiters: store.interestedWaiterCount
    });
  }

  public dispose(): Promise<void> {
    if (this.#disposePromise !== null) return this.#disposePromise;
    this.#disposed = true;
    this.#removeCallerLink();
    this.#controller.abort();
    this.catalog.dispose();
    const range = this.#rangeSource;
    this.#rangeSource = null;
    const complete = this.#completeSource;
    this.#completeSource = null;
    const metadataLease = this.#metadataLease;
    this.#metadataLease = null;
    this.#disposePromise = Promise.allSettled([
      this.#store.dispose(),
      ...(range === null ? [] : [range.dispose()])
    ]).then(() => {
      complete?.release();
      safeRelease(metadataLease);
    });
    return this.#disposePromise;
  }

  #ensure(
    key: string,
    selection: RuntimeBlobSelection,
    options: Readonly<RuntimeAssetEnsureOptions>
  ): Promise<Readonly<VerifiedBlobHandle>> {
    if (this.#disposed) return Promise.reject(runtimeError("disposed"));
    let signal: AbortSignal | undefined;
    try {
      signal = options.signal;
      if (signal !== undefined && !isAbortSignal(signal)) {
        throw new TypeError("invalid signal");
      }
    } catch {
      return Promise.reject(runtimeError("load-failure"));
    }
    let deadline: RuntimeLoadOperationDeadline;
    try { deadline = this.#operationDeadline(signal); } catch (cause) {
      return Promise.reject(normalizeSessionFailure(cause));
    }
    const operation = this.#store.ensure(key, {
      signal: deadline.signal,
      load: (request) => this.#batch.load(selection, request)
    });
    return deadline.watch(operation).finally(() => { deadline.complete(); });
  }

  #ensureMany(
    entries: readonly Readonly<BlobEnsureEntry>[],
    options: Readonly<RuntimeAssetEnsureOptions>
  ): Promise<readonly Readonly<VerifiedBlobHandle>[]> {
    if (this.#disposed) return Promise.reject(runtimeError("disposed"));
    let signal: AbortSignal | undefined;
    try {
      signal = captureEnsureSignal(options);
    } catch {
      return Promise.reject(runtimeError("load-failure"));
    }
    if (signal?.aborted === true) return Promise.reject(abortError());
    let deadline: RuntimeLoadOperationDeadline;
    try { deadline = this.#operationDeadline(signal); } catch (cause) {
      return Promise.reject(normalizeSessionFailure(cause));
    }
    try {
      const absent = entries.filter(
        ({ key }) => this.#store.state(key) === "absent"
      );
      const batch: RuntimeAssetBlobLoadBatch | null = absent.length === 0
        ? null
        : this.#batch.createBatch(absent.length);
      const operation = Promise.all(entries.map(({ key, selection }) =>
        this.#store.ensure(key, {
          signal: deadline.signal,
          load: (request) => batch?.register(selection, request)
        })
      )).then(freezeHandles);
      return deadline.watch(operation).finally(() => { deadline.complete(); });
    } catch (cause) {
      deadline.cancel();
      return Promise.reject(normalizeSessionFailure(cause));
    }
  }

  async #fetchBatchRange(
    range: Readonly<PlannedBlobTransportRange>,
    signal: AbortSignal
  ): Promise<Readonly<{ readonly bytes: Uint8Array; release(): void }>> {
    const rangeSource = this.#rangeSource;
    if (rangeSource === null) throw abortError();
    const result = await rangeSource.fetchPayloadRange({
      start: range.offset,
      end: range.offset + range.length - 1
    }, { signal, overallSignal: signal });
    if (result.mode === "range") return result;
    this.#adoptCompleteReplacement(result);
    const source = this.#requireCompleteSource();
    const retained = source.read(range.offset, range.length);
    return Object.freeze({
      bytes: retained.bytes,
      release(): void {}
    });
  }

  #readComplete(
    offset: number,
    length: number
  ): Readonly<RuntimeCompleteSourceRange> | null {
    const source = this.#completeSource;
    return source?.read(offset, length) ?? null;
  }

  async #verifyAndPromote(
    blob: PlannedRuntimeBlob,
    quarantined: Readonly<{
      readonly bytes: Uint8Array;
      release(): void;
    }>,
    request: Readonly<VerifiedBlobLoadRequest>,
    source: Readonly<RuntimeCompleteSourceRange> | null = null
  ): Promise<void> {
    await verifySha256AndPromote(this.#options.digestAdapter, {
      bytes: quarantined.bytes,
      expectedSha256Hex: blob.sha256,
      generation: request.generation,
      isGenerationCurrent: (generation) =>
        generation === this.#options.generation && !this.#disposed,
      signal: request.signal,
      inputLease: quarantined,
      promote: (verified) => {
        if (source === null) request.promote(verified);
        else promoteBorrowedVerifiedBlob(request, verified, source);
      }
    });
  }

  #adoptCompleteReplacement(result: Readonly<RuntimeFullAssetResult>): void {
    if (
      result.layout.frontIndex.header.declaredFileLength !==
      this.#frontIndex.header.declaredFileLength
    ) {
      result.release();
      throw runtimeError("entity-changed");
    }
    if (this.#completeSource !== null) {
      result.release();
      return;
    }
    const source = createCompleteSource(result.bytes, result.layout, result);
    try { adoptRuntimeCatalogCompleteSource(this.catalog); }
    catch (cause) {
      source.release();
      throw cause;
    }
    this.#completeSource = source;
    this.#mode = "full";
    safeRelease(this.#metadataLease);
    this.#metadataLease = null;
  }

  #requireCompleteSource(): CompleteByteSource {
    const source = this.#completeSource;
    if (source === null) throw abortError();
    return source;
  }

  #linkCaller(signal: AbortSignal | null): void {
    if (signal === null) return;
    const listener = (): void => { void this.dispose(); };
    try {
      if (signal.aborted) {
        listener();
        return;
      }
      this.#callerAbortLink = Object.freeze({ signal, listener });
      signal.addEventListener("abort", listener, { once: true });
    } catch {
      this.#removeCallerLink();
      void this.dispose();
      throw runtimeError("load-failure");
    }
  }

  #removeCallerLink(): void {
    const link = this.#callerAbortLink;
    this.#callerAbortLink = null;
    if (link === null) return;
    try { link.signal.removeEventListener("abort", link.listener); } catch {}
  }

  #operationDeadline(
    signal: AbortSignal | undefined
  ): RuntimeLoadOperationDeadline {
    const signals = signal === undefined
      ? [this.#controller.signal]
      : [this.#controller.signal, signal];
    return createRuntimeAssetOperationDeadline(
      this.#operationTimeoutMs, this.#options.timers, signals
    );
  }
}

function captureOptions(
  value: Readonly<OpenRuntimeAssetOptions | OpenRuntimeAssetBytesOptions>
): Readonly<CapturedSessionOptions> {
  if (typeof value !== "object" || value === null) {
    throw runtimeError("load-failure");
  }
  let resources: RuntimeAssetSessionResources;
  let fetcher: RuntimeFetchAdapter | undefined;
  let timers: LoadWatchdogTimerHost | undefined;
  let digest: Sha256DigestAdapter | undefined;
  let generation: number;
  let maximumFileBytes: number;
  let format: RuntimeRangeAssetFormatAdapter;
  let allocate: (byteLength: number) => Uint8Array<ArrayBuffer>;
  try {
    resources = captureRuntimeAssetSessionResources(value.resources);
    fetcher = "fetcher" in value ? value.fetcher : undefined;
    timers = "timers" in value ? value.timers : undefined;
    digest = value.digestAdapter;
    generation = value.generation ?? 0;
    maximumFileBytes = value.maximumFileBytes ??
      FORMAT_DEFAULT_BUDGETS.maxFileBytes;
    format = captureRuntimeRangeAssetFormatAdapter(
      value.format ?? DEFAULT_RUNTIME_RANGE_ASSET_FORMAT_ADAPTER
    );
    allocate = value.allocate ?? allocateBytes;
  } catch {
    throw runtimeError("load-failure");
  }
  if (
    !Number.isSafeInteger(generation) || generation < 0 ||
    !Number.isSafeInteger(maximumFileBytes) || maximumFileBytes < 1 ||
    maximumFileBytes > FORMAT_DEFAULT_BUDGETS.maxFileBytes ||
    typeof allocate !== "function"
  ) {
    throw runtimeError("load-failure");
  }
  return Object.freeze({
    resources,
    fetcher: fetcher ?? null,
    timers,
    digestAdapter: digest ?? defaultDigestAdapter(),
    generation,
    maximumFileBytes,
    format,
    allocate: (byteLength: number) => Reflect.apply(
      allocate,
      undefined,
      [byteLength]
    ) as Uint8Array<ArrayBuffer>
  });
}

function defaultFetchAdapter(): RuntimeFetchAdapter {
  let fetchFunction: typeof fetch | undefined;
  try { fetchFunction = globalThis.fetch; } catch {}
  if (typeof fetchFunction !== "function") throw runtimeError("load-failure");
  return createBrowserRuntimeFetchAdapter(fetchFunction);
}

function defaultDigestAdapter(): Sha256DigestAdapter {
  let subtle: SubtleCrypto | undefined;
  try { subtle = globalThis.crypto?.subtle; } catch {}
  if (subtle === undefined) throw runtimeError("load-failure");
  return createWebCryptoSha256Adapter(subtle);
}

function createCompleteSource(
  bytes: Uint8Array<ArrayBuffer>,
  layout: Readonly<ValidatedAssetLayout>,
  lease: { release(): void }
): CompleteByteSource {
  const source = createRuntimeCompleteSource(bytes, () => safeRelease(lease));
  return Object.freeze({
    mode: "full" as const,
    layout,
    read: source.read,
    release: source.release
  });
}

async function retireOpenedSource(source:
  Readonly<RuntimeFullAssetResult> | RuntimeRangeAssetSession | null
): Promise<void> {
  if (source === null) return;
  try {
    if (source.mode === "range") await source.dispose();
    else source.release();
  } catch {
    // The opening failure remains authoritative over terminal cleanup errors.
  }
}

function allocateBytes(byteLength: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(byteLength));
}

function allocateExact(
  allocate: (byteLength: number) => Uint8Array<ArrayBuffer>,
  byteLength: number
): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = allocate(byteLength); } catch {
    throw runtimeError("resource-rejection", { expectedBytes: byteLength });
  }
  if (
    !(bytes instanceof Uint8Array) ||
    !(bytes.buffer instanceof ArrayBuffer) ||
    bytes.byteOffset !== 0 ||
    bytes.byteLength !== byteLength ||
    bytes.buffer.byteLength !== byteLength
  ) {
    throw runtimeError("resource-rejection", { expectedBytes: byteLength });
  }
  return bytes;
}

function freezeHandles(
  handles: Readonly<VerifiedBlobHandle>[]
): readonly Readonly<VerifiedBlobHandle>[] {
  return Object.freeze(handles.slice());
}

function captureEnsureSignal(
  options: Readonly<RuntimeAssetEnsureOptions>
): AbortSignal | undefined {
  const signal = options.signal;
  if (signal !== undefined && !isAbortSignal(signal)) throw new TypeError();
  return signal;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object" && value !== null &&
    typeof (value as AbortSignal).aborted === "boolean" &&
    typeof (value as AbortSignal).addEventListener === "function" &&
    typeof (value as AbortSignal).removeEventListener === "function";
}

function safeRelease(value: { release(): void } | null): void {
  if (value === null) return;
  try { value.release(); } catch {}
}

function normalizeSessionFailure(cause: unknown): RuntimePlaybackError {
  if (isRuntimePlaybackError(cause)) return cause;
  if (cause instanceof FormatError) {
    return runtimeError("invalid-asset", {
      sourceCode: cause.code,
      ...(cause.offset === undefined ? {} : { offset: cause.offset }),
      ...(cause.path === undefined ? {} : { sourcePath: cause.path })
    });
  }
  if (cause instanceof DOMException && cause.name === "AbortError") {
    return runtimeError("abort");
  }
  return runtimeError("load-failure");
}

function runtimeError(
  code: RuntimeFailureCode,
  context: Readonly<RuntimeFailureContext> = {}
): RuntimePlaybackError {
  return new RuntimePlaybackError(normalizeRuntimeFailure(code, undefined, context));
}

function abortError(): DOMException {
  return new DOMException("runtime asset operation was aborted", "AbortError");
}
