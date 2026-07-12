import {
  FORMAT_HEADER_LENGTH,
  FormatError,
  parseFrontIndex,
  parseHeader,
  validateCompleteAsset,
  type FormatHeader,
  type ParsedFrontIndex
} from "@rendered-motion/format";
import type {
  NormalizedRuntimeAssetRequest,
  RuntimeFetchAdapter,
  RuntimeFetchInit,
  RuntimeFetchResponseSnapshot,
  RuntimeFetchResponseView
} from "./asset-fetch-contracts.js";
import { retireRuntimeBodyReader } from "./asset-fetch-contracts.js";
import {
  readBoundedBody,
  type BoundedBodyByteLease,
  type BoundedBodyByteResourceHost,
  type BoundedBodyResult
} from "./bounded-body-reader.js";
import {
  RuntimePlaybackError,
  isRuntimePlaybackError,
  normalizeRuntimeFailure,
  type RuntimeFailureCode,
  type RuntimeFailureContext
} from "./errors.js";
import {
  acceptRuntimeFullAssetResponse,
  fetchFullAsset,
  fetchRuntimeResponseSnapshot,
  runtimeResponseHeadersView,
  type RuntimeFullAssetFormatAdapter,
  type RuntimeFullAssetResult
} from "./full-asset-fetch.js";
import {
  formatInclusiveByteRange,
  validateExactContentRange,
  type RuntimeInclusiveByteRange
} from "./http-content-range.js";
import {
  parseStrongEntityTag,
  requireMatchingStrongEntityTag,
  type StrongEntityTag
} from "./http-entity-tag.js";
import {
  validateRuntimeHttpResponse
} from "./http-response-contract.js";
import {
  RuntimeLoadOperationDeadline,
  createLoadOperationDeadline,
  createLoadWatchdogs,
  type LoadWatchdogTimerHost,
  type RuntimeLoadWatchdogs
} from "./load-watchdogs.js";
import type { RuntimeEntityIdentity } from "./model.js";
import {
  captureRuntimePayloadOptions,
  createRuntimeRangeBodyResult,
  validateRuntimePayloadRange,
  type RuntimeRangeBodyResult
} from "./range-payload-contracts.js";
import type { Sha256DigestAdapter } from "./sha256-verifier.js";

export interface RuntimeRangeAssetFormatAdapter
extends RuntimeFullAssetFormatAdapter {
  parseHeader(bytes: Uint8Array, maximumFileBytes: number): Readonly<FormatHeader>;
  parseFrontIndex(
    bytes: Uint8Array,
    maximumFileBytes: number
  ): Readonly<ParsedFrontIndex>;
}
export interface OpenRangeAssetSessionInput {
  readonly request: Readonly<NormalizedRuntimeAssetRequest>;
  readonly fetcher: RuntimeFetchAdapter;
  readonly resources: BoundedBodyByteResourceHost;
  readonly fullResources?: BoundedBodyByteResourceHost;
  readonly generation: number;
  readonly isGenerationCurrent: (generation: number) => boolean;
  readonly timers?: LoadWatchdogTimerHost;
  readonly deadline?: RuntimeLoadOperationDeadline;
  readonly digestAdapter?: Sha256DigestAdapter;
  readonly format?: RuntimeRangeAssetFormatAdapter;
  readonly allocate?: (byteLength: number) => Uint8Array<ArrayBuffer>;
}
export type { RuntimeRangeBodyResult } from "./range-payload-contracts.js";
export type RuntimePayloadFetchResult =
  | Readonly<RuntimeRangeBodyResult>
  | Readonly<RuntimeFullAssetResult>;
export interface RuntimePayloadRangeOptions {
  readonly signal?: AbortSignal;
  /** @internal Aggregate finite interest owned by RuntimeAssetSession waiters. */
  readonly overallSignal?: AbortSignal;
}

export interface RuntimeRangeAssetSession {
  readonly mode: "range";
  readonly identity: Extract<RuntimeEntityIdentity, { readonly mode: "range" }>;
  readonly frontIndex: Readonly<ParsedFrontIndex>;
  readonly metadataByteLength: number;
  readonly disposed: boolean;
  releaseMetadata(): void;
  fetchPayloadRange(
    range: Readonly<RuntimeInclusiveByteRange>,
    options?: Readonly<RuntimePayloadRangeOptions>
  ): Promise<RuntimePayloadFetchResult>;
  dispose(): Promise<void>;
}
export type OpenedRuntimeAsset =
  | RuntimeRangeAssetSession
  | Readonly<RuntimeFullAssetResult>;
interface CapturedOpenInput extends OpenRangeAssetSessionInput {
  readonly fetcher: RuntimeFetchAdapter;
  readonly fullResources: BoundedBodyByteResourceHost;
  readonly format: RuntimeRangeAssetFormatAdapter;
  readonly allocate: (byteLength: number) => Uint8Array<ArrayBuffer>;
}

interface RequestOperation {
  readonly response: Readonly<RuntimeFetchResponseSnapshot>;
  readonly watchdogs: RuntimeLoadWatchdogs;
}

const DEFAULT_FORMAT: Readonly<RuntimeRangeAssetFormatAdapter> = Object.freeze({
  parseHeader(bytes: Uint8Array, maximumFileBytes: number) {
    return parseHeader(bytes, { budgets: { maxFileBytes: maximumFileBytes } });
  },
  parseFrontIndex(bytes: Uint8Array, maximumFileBytes: number) {
    return parseFrontIndex(bytes, {
      budgets: { maxFileBytes: maximumFileBytes }
    });
  },
  validateCompleteAsset(bytes: Uint8Array, maximumFileBytes: number) {
    return validateCompleteAsset({
      bytes,
      options: { budgets: { maxFileBytes: maximumFileBytes } }
    });
  }
});
export async function openRangeAssetSession(
  inputValue: Readonly<OpenRangeAssetSessionInput>
): Promise<OpenedRuntimeAsset> {
  const input = captureOpenInput(inputValue);
  const controller = new AbortController();
  const ownsDeadline = input.deadline === undefined;
  const deadline = input.deadline ?? createLoadOperationDeadline({
    signals: input.request.signal === null ? [] : [input.request.signal],
    ...(input.timers === undefined ? {} : { timers: input.timers }),
    timeoutMs: input.request.policy.overallTimeoutMs
  });
  if (input.request.integrity !== null) {
    try {
      return await fetchFullAsset({
        request: input.request,
        fetcher: input.fetcher,
        resources: input.fullResources,
        generation: input.generation,
        isGenerationCurrent: input.isGenerationCurrent,
        ...(input.timers === undefined ? {} : { timers: input.timers }),
        ...(input.digestAdapter === undefined
          ? {}
          : { digestAdapter: input.digestAdapter }),
        deadline,
        format: input.format,
        requestOrdinal: 1
      });
    } finally {
      if (ownsDeadline) deadline.complete();
    }
  }

  let headerBody: Readonly<BoundedBodyResult> | null = null;
  let frontBody: Readonly<BoundedBodyResult> | null = null;
  let prefixLease: BoundedBodyByteLease | null = null;
  try {
    const first = await beginRequest(
      input,
      controller.signal,
      Object.freeze({ Range: "bytes=0-63" }),
      deadline
    );
    if (first.response.status === 200) {
      const result = await acceptRuntimeFullAssetResponse({
        request: input.request,
        resources: input.fullResources,
        generation: input.generation,
        isGenerationCurrent: input.isGenerationCurrent,
        format: input.format,
        requestOrdinal: 1,
        response: first.response,
        watchdogs: first.watchdogs,
        signal: controller.signal,
        deadline
      });
      controller.abort();
      return result;
    }

    let initialRange: Readonly<{ readonly finalUrl: string; readonly total: number }>;
    try {
      initialRange = validatePartialResponse(
        first.response,
        { start: 0, end: FORMAT_HEADER_LENGTH - 1 },
        undefined,
        undefined,
        input.request.policy.maximumRangeBytes,
        failureContext(input, 1, "initial-range")
      );
    } catch (cause) {
      await retireOperation(first);
      throw cause;
    }
    const strongEntityTag = parseStrongEntityTag(
      first.response.headers.entityTag
    );
    if (strongEntityTag === null) {
      await retireOperation(first);
      const result = await fetchFullAsset({
        request: input.request,
        fetcher: input.fetcher,
        resources: input.fullResources,
        generation: input.generation,
        isGenerationCurrent: input.isGenerationCurrent,
        sessionSignal: controller.signal,
        ...(input.timers === undefined ? {} : { timers: input.timers }),
        format: input.format,
        deadline,
        pinnedEntity: { finalUrl: initialRange.finalUrl },
        requestOrdinal: 2
      });
      controller.abort();
      return result;
    }

    headerBody = await consumeExactBody(
      input,
      controller.signal,
      first,
      FORMAT_HEADER_LENGTH,
      1,
      "initial-range",
      null,
      deadline
    );
    deadline.assertActive();
    const header = input.format.parseHeader(
      headerBody.bytes,
      input.request.policy.maximumFileBytes
    );
    deadline.assertActive();
    if (header.declaredFileLength !== initialRange.total) {
      throw runtimeError("range-response-invalid", {
        ...failureContext(input, 1, "initial-range"),
        declaredTotalBytes: initialRange.total,
        observedBytes: header.declaredFileLength
      });
    }
    const frontEnd = header.indexOffset + header.indexLength;
    const frontRange = Object.freeze({
      start: FORMAT_HEADER_LENGTH,
      end: frontEnd - 1
    });
    const second = await beginRequest(
      input,
      controller.signal,
      Object.freeze({
        Range: formatInclusiveByteRange(frontRange),
        "If-Range": strongEntityTag
      }),
      deadline
    );
    if (second.response.status === 200) {
      try {
        const replacement = await acceptRuntimeFullAssetResponse({
          request: input.request,
          resources: input.fullResources,
          generation: input.generation,
          isGenerationCurrent: input.isGenerationCurrent,
          format: input.format,
          pinnedEntity: {
            finalUrl: initialRange.finalUrl,
            strongEntityTag
          },
          requestOrdinal: 2,
          response: second.response,
          watchdogs: second.watchdogs,
          signal: controller.signal,
          deadline
        });
        headerBody.release();
        headerBody = null;
        controller.abort();
        return replacement;
      } catch (cause) {
        throw cause;
      }
    }

    try {
      validatePartialResponse(
        second.response,
        frontRange,
        initialRange.total,
      Object.freeze({ finalUrl: initialRange.finalUrl, strongEntityTag }),
      input.request.policy.maximumFileBytes,
        failureContext(input, 2, "front-index")
      );
    } catch (cause) {
      await retireOperation(second);
      throw cause;
    }
    frontBody = await consumeExactBody(
      input,
      controller.signal,
      second,
      frontEnd - FORMAT_HEADER_LENGTH,
      2,
      "front-index",
      null,
      deadline
    );

    prefixLease = await reserveBytes(
      input.resources,
      frontEnd,
      input,
      controller.signal,
      deadline
    );
    deadline.assertActive();
    assertCurrent(input, controller.signal);
    const prefix = allocateExact(input.allocate, frontEnd);
    Uint8Array.prototype.set.call(prefix, headerBody.bytes, 0);
    Uint8Array.prototype.set.call(prefix, frontBody.bytes, FORMAT_HEADER_LENGTH);
    let parsed: Readonly<ParsedFrontIndex>;
    try {
      deadline.assertActive();
      parsed = input.format.parseFrontIndex(
        prefix,
        input.request.policy.maximumFileBytes
      );
      deadline.assertActive();
    } catch (cause) {
      throw normalizeRangeFailure(
        cause,
        failureContext(input, 2, "front-index")
      );
    }
    headerBody.release();
    headerBody = null;
    frontBody.release();
    frontBody = null;
    const transferredLease = prefixLease;
    prefixLease = null;
    const session = new RangeAssetSessionImpl(
      input,
      controller,
      Object.freeze({
        mode: "range",
        generation: input.generation,
        finalUrl: initialRange.finalUrl,
        declaredTotalBytes: initialRange.total,
        strongEntityTag
      }),
      parsed,
      prefix,
      transferredLease
    );
    if (session.disposed) {
      await session.dispose();
      throw runtimeError("abort", failureContext(input, 2, "front-index"));
    }
    return session;
  } catch (cause) {
    controller.abort();
    headerBody?.release();
    frontBody?.release();
    safeRelease(prefixLease);
    throw normalizeRangeFailure(cause, failureContext(input, 1, "initial-range"));
  } finally {
    if (ownsDeadline) deadline.complete();
  }
}

class RangeAssetSessionImpl implements RuntimeRangeAssetSession {
  readonly #input: Readonly<CapturedOpenInput>;
  readonly #controller: AbortController;
  readonly #identity: Extract<RuntimeEntityIdentity, { readonly mode: "range" }>;
  readonly #frontIndex: Readonly<ParsedFrontIndex>;
  readonly #metadataByteLength: number;
  readonly #metadataLease: BoundedBodyByteLease;
  readonly #pending = new Set<Promise<unknown>>();
  #callerAbortLink: {
    readonly signal: AbortSignal;
    readonly listener: () => void;
  } | null = null;
  #requestOrdinal = 2;
  #activePayloadBodies = 0;
  #disposed = false;
  #metadataReleased = false;
  #disposePromise: Promise<void> | null = null;

  public constructor(
    input: Readonly<CapturedOpenInput>,
    controller: AbortController,
    identity: Extract<RuntimeEntityIdentity, { readonly mode: "range" }>,
    frontIndex: Readonly<ParsedFrontIndex>,
    metadata: Uint8Array<ArrayBuffer>,
    metadataLease: BoundedBodyByteLease
  ) {
    this.#input = input;
    this.#controller = controller;
    this.#identity = identity;
    this.#frontIndex = frontIndex;
    this.#metadataByteLength = metadata.byteLength;
    this.#metadataLease = metadataLease;
    const callerSignal = input.request.signal;
    if (callerSignal !== null) {
      const listener = (): void => { void this.dispose(); };
      try {
        this.#callerAbortLink = { signal: callerSignal, listener };
        callerSignal.addEventListener("abort", listener, { once: true });
        if (callerSignal.aborted) listener();
      } catch {
        this.#removeCallerAbortLink();
        this.#releaseMetadata();
        throw runtimeError("load-failure");
      }
    }
  }

  public get mode(): "range" { return "range"; }
  public get identity() { return this.#identity; }
  public get frontIndex() { return this.#frontIndex; }
  public get metadataByteLength(): number { return this.#metadataByteLength; }
  public get disposed(): boolean { return this.#disposed; }
  public releaseMetadata(): void { this.#releaseMetadata(); }

  public fetchPayloadRange(
    rangeValue: Readonly<RuntimeInclusiveByteRange>,
    options: Readonly<RuntimePayloadRangeOptions> = {}
  ): Promise<RuntimePayloadFetchResult> {
    if (this.#disposed) return Promise.reject(runtimeError("disposed"));
    if (
      this.#activePayloadBodies >=
      this.#input.request.policy.maximumConcurrentPayloadBodies
    ) {
      return Promise.reject(runtimeError("resource-rejection", {
        generation: this.#identity.generation,
        lifecyclePhase: "payload-range"
      }));
    }
    let range: Readonly<RuntimeInclusiveByteRange>;
    let operationSignal: AbortSignal | null;
    let overallSignal: AbortSignal | null;
    try {
      ({ signal: operationSignal, overallSignal } =
        captureRuntimePayloadOptions(options));
      range = validateRuntimePayloadRange(
        rangeValue,
        this.#identity,
        this.#frontIndex.frontIndexRange.length,
        this.#input.request.policy.maximumRangeBytes
      );
    } catch (cause) {
      return Promise.reject(normalizeRangeFailure(cause, {
        generation: this.#identity.generation,
        lifecyclePhase: "payload-range"
      }));
    }
    const ownsDeadline = overallSignal === null;
    let deadline: RuntimeLoadOperationDeadline | null = null;
    if (ownsDeadline) {
      try {
        deadline = createLoadOperationDeadline({
          signals: [this.#input.request.signal, operationSignal]
            .filter((value): value is AbortSignal => value !== null),
          ...(this.#input.timers === undefined
            ? {}
            : { timers: this.#input.timers }),
          timeoutMs: this.#input.request.policy.overallTimeoutMs
        });
      } catch (cause) {
        return Promise.reject(normalizeRangeFailure(cause, {
          generation: this.#identity.generation,
          lifecyclePhase: "payload-range"
        }));
      }
    }
    this.#activePayloadBodies += 1;
    const ordinal = this.#requestOrdinal + 1;
    this.#requestOrdinal = ordinal;
    const pending = this.#fetchPayload(
      range,
      ordinal,
      operationSignal,
      deadline,
      overallSignal
    );
    const operation = pending.finally(() => {
      if (ownsDeadline) deadline?.complete();
      this.#activePayloadBodies -= 1;
      this.#pending.delete(operation);
    });
    this.#pending.add(operation);
    return operation;
  }

  public dispose(): Promise<void> {
    if (this.#disposePromise !== null) return this.#disposePromise;
    this.#disposed = true;
    this.#removeCallerAbortLink();
    this.#controller.abort();
    this.#disposePromise = Promise.allSettled([...this.#pending]).then(() => {
      this.#releaseMetadata();
    });
    return this.#disposePromise;
  }

  async #fetchPayload(
    range: Readonly<RuntimeInclusiveByteRange>,
    ordinal: number,
    operationSignal: AbortSignal | null,
    deadline: RuntimeLoadOperationDeadline | null,
    overallSignal: AbortSignal | null
  ): Promise<RuntimePayloadFetchResult> {
    const context = failureContext(this.#input, ordinal, "payload-range");
    let operation: RequestOperation | null = null;
    try {
      operation = await beginRequest(
        this.#input,
        this.#controller.signal,
        Object.freeze({
          Range: formatInclusiveByteRange(range),
          "If-Range": this.#identity.strongEntityTag
        }),
        deadline,
        operationSignal,
        overallSignal
      );
      if (operation.response.status === 200) {
        const fullOperation = operation;
        operation = null;
        const replacement = await acceptRuntimeFullAssetResponse({
          request: this.#input.request,
          resources: this.#input.fullResources,
          generation: this.#identity.generation,
          isGenerationCurrent: this.#input.isGenerationCurrent,
          format: this.#input.format,
          pinnedEntity: {
            finalUrl: this.#identity.finalUrl,
            strongEntityTag: this.#identity.strongEntityTag as StrongEntityTag
          },
          requestOrdinal: ordinal,
          response: fullOperation.response,
          watchdogs: fullOperation.watchdogs,
          signal: operationSignal ?? this.#controller.signal,
          ...(deadline === null ? {} : { deadline })
        });
        this.#disposed = true;
        this.#removeCallerAbortLink();
        this.#controller.abort();
        this.#releaseMetadata();
        return replacement;
      }

      validatePartialResponse(
        operation.response,
        range,
        this.#identity.declaredTotalBytes,
        {
          finalUrl: this.#identity.finalUrl,
          strongEntityTag: this.#identity.strongEntityTag as StrongEntityTag
        },
        this.#input.request.policy.maximumRangeBytes,
        context
      );
      const bodyOperation = operation;
      operation = null;
      const body = await consumeExactBody(
        this.#input,
        this.#controller.signal,
        bodyOperation,
        range.end - range.start + 1,
        ordinal,
        "payload-range",
        operationSignal,
        deadline
      );
      operation = null;
      return createRuntimeRangeBodyResult(range, body);
    } catch (cause) {
      if (operation !== null) await retireOperation(operation);
      throw normalizeRangeFailure(cause, context);
    }
  }

  #releaseMetadata(): void {
    if (this.#metadataReleased) return;
    this.#metadataReleased = true;
    safeRelease(this.#metadataLease);
  }

  #removeCallerAbortLink(): void {
    const link = this.#callerAbortLink;
    this.#callerAbortLink = null;
    if (link === null) return;
    try {
      link.signal.removeEventListener("abort", link.listener);
    } catch {}
  }
}

async function beginRequest(
  input: Readonly<CapturedOpenInput>,
  sessionSignal: AbortSignal,
  headers: Readonly<Record<string, string>>,
  deadline: RuntimeLoadOperationDeadline | null,
  operationSignal: AbortSignal | null = null,
  overallSignal: AbortSignal | null = null
): Promise<RequestOperation> {
  const signals = [input.request.signal, sessionSignal, operationSignal]
    .filter((signal): signal is AbortSignal => signal !== null);
  const watchdogs = createLoadWatchdogs({
    signals,
    ...(input.timers === undefined ? {} : { timers: input.timers }),
    ...(deadline === null
      ? { overallSignal: overallSignal ?? operationSignal ?? sessionSignal }
      : { overallDeadline: deadline }),
    firstByteTimeoutMs: input.request.policy.firstByteTimeoutMs,
    idleBodyTimeoutMs: input.request.policy.idleBodyTimeoutMs
  });
  try {
    const response = await fetchRuntimeResponseSnapshot(
      input.fetcher,
      input.request.url,
      Object.freeze({
        method: "GET",
        credentials: input.request.credentials,
        signal: watchdogs.signal,
        headers
      }),
      watchdogs
    );
    watchdogs.noteHeadersReceived();
    return Object.freeze({ response, watchdogs });
  } catch (cause) {
    watchdogs.complete();
    throw cause;
  }
}

function validatePartialResponse(
  response: Readonly<RuntimeFetchResponseSnapshot>,
  range: Readonly<RuntimeInclusiveByteRange>,
  knownTotal: number | undefined,
  pinned: Readonly<{ readonly finalUrl: string; readonly strongEntityTag: StrongEntityTag }> | undefined,
  maximumBytes: number,
  context: Readonly<RuntimeFailureContext>
): Readonly<{ readonly finalUrl: string; readonly total: number }> {
  if (pinned !== undefined && response.finalUrl !== pinned.finalUrl) {
    throw runtimeError("entity-changed", context);
  }
  if (pinned !== undefined) {
    try {
      requireMatchingStrongEntityTag(
        response.headers.entityTag,
        pinned.strongEntityTag
      );
    } catch {
      throw runtimeError("entity-changed", context);
    }
  }
  const expectedBytes = range.end - range.start + 1;
  try {
    const common = validateRuntimeHttpResponse({
      status: response.status,
      expectedStatus: 206,
      responseType: response.type,
      finalUrl: response.finalUrl,
      ...(pinned === undefined ? {} : { pinnedFinalUrl: pinned.finalUrl }),
      bodyAvailable: true,
      headers: runtimeResponseHeadersView(response),
      expectedBodyBytes: expectedBytes,
      maximumBodyBytes: maximumBytes
    });
    if (response.headers.contentRange === null) throw new RangeError();
    const parsed = validateExactContentRange(
      response.headers.contentRange,
      range,
      knownTotal
    );
    return Object.freeze({ finalUrl: common.finalUrl, total: parsed.total });
  } catch (cause) {
    if (isRuntimePlaybackError(cause) && cause.code === "entity-changed") {
      throw cause;
    }
    throw runtimeError("range-response-invalid", context);
  }
}

async function consumeExactBody(
  input: Readonly<CapturedOpenInput>,
  signal: AbortSignal,
  operation: RequestOperation,
  expectedBytes: number,
  requestOrdinal: number,
  lifecyclePhase: "initial-range" | "front-index" | "payload-range",
  operationSignal: AbortSignal | null = null,
  deadline: RuntimeLoadOperationDeadline | null = null
): Promise<Readonly<BoundedBodyResult>> {
  try {
    const bodyOperation = readBoundedBody({
      reader: operation.response.bodyReader,
      mode: {
        kind: "known-exact",
        expectedBytes,
        maximumBytes: lifecyclePhase === "payload-range"
          ? Math.min(
              input.request.policy.maximumRangeBytes,
              input.request.policy.maximumFileBytes
            )
          : input.request.policy.maximumFileBytes
      },
      resources: input.resources,
      watchdogs: operation.watchdogs,
      isCurrent: () =>
        operationIsCurrent(input, signal) && operationSignal?.aborted !== true,
      allocate: input.allocate,
      context: {
        generation: input.generation,
        requestOrdinal,
        lifecyclePhase
      }
    });
    return deadline === null
      ? await bodyOperation
      : await deadline.watch(bodyOperation);
  } catch (cause) {
    if (
      isRuntimePlaybackError(cause) &&
      cause.code === "load-failure" &&
      cause.failure.context.expectedBytes !== undefined &&
      cause.failure.context.observedBytes !== undefined
    ) {
      throw runtimeError("range-response-invalid", {
        ...failureContext(input, requestOrdinal, lifecyclePhase),
        expectedBytes: cause.failure.context.expectedBytes,
        observedBytes: cause.failure.context.observedBytes
      });
    }
    throw cause;
  }
}

async function retireOperation(operation: RequestOperation): Promise<void> {
  operation.watchdogs.complete();
  await retireRuntimeBodyReader(operation.response.bodyReader);
}

async function reserveBytes(
  resources: BoundedBodyByteResourceHost,
  byteLength: number,
  input: Readonly<CapturedOpenInput>,
  signal: AbortSignal,
  deadline: RuntimeLoadOperationDeadline
): Promise<BoundedBodyByteLease> {
  let reserve: unknown;
  try { reserve = Reflect.get(resources, "reserve"); } catch {}
  if (typeof reserve !== "function") throw runtimeError("resource-rejection");
  const raw = Promise.resolve().then(() =>
    Reflect.apply(reserve, resources, [byteLength]) as
      BoundedBodyByteLease | PromiseLike<BoundedBodyByteLease>
  );
  const capturedPromise = raw.then(captureLease);
  try {
    const captured = await deadline.watch(capturedPromise);
    if (!operationIsCurrent(input, signal)) {
      safeRelease(captured);
      throw runtimeError("abort");
    }
    return captured;
  } catch (cause) {
    void capturedPromise.then(safeRelease, () => {});
    throw cause;
  }
}

function captureOpenInput(
  input: Readonly<OpenRangeAssetSessionInput>
): Readonly<CapturedOpenInput> {
  if (typeof input !== "object" || input === null) {
    throw runtimeError("load-failure");
  }
  let request: OpenRangeAssetSessionInput["request"];
  let fetcherValue: OpenRangeAssetSessionInput["fetcher"];
  let resources: OpenRangeAssetSessionInput["resources"];
  let fullResources: BoundedBodyByteResourceHost | undefined;
  let generation: number;
  let isGenerationCurrent: OpenRangeAssetSessionInput["isGenerationCurrent"];
  let timers: LoadWatchdogTimerHost | undefined;
  let deadline: RuntimeLoadOperationDeadline | undefined;
  let digestAdapter: Sha256DigestAdapter | undefined;
  let formatValue: RuntimeRangeAssetFormatAdapter | undefined;
  let allocateValue: ((byteLength: number) => Uint8Array<ArrayBuffer>) | undefined;
  try {
    request = input.request;
    fetcherValue = input.fetcher;
    resources = input.resources;
    fullResources = input.fullResources;
    generation = input.generation;
    isGenerationCurrent = input.isGenerationCurrent;
    timers = input.timers;
    deadline = input.deadline;
    digestAdapter = input.digestAdapter;
    formatValue = input.format;
    allocateValue = input.allocate;
  } catch {
    throw runtimeError("load-failure");
  }
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw runtimeError("load-failure");
  }
  if (typeof isGenerationCurrent !== "function") {
    throw runtimeError("load-failure");
  }
  if (deadline !== undefined && !(deadline instanceof RuntimeLoadOperationDeadline)) {
    throw runtimeError("load-failure");
  }
  const fetcher = captureFetcher(fetcherValue);
  const format = captureFormat(formatValue ?? DEFAULT_FORMAT);
  const allocate = captureAllocator(allocateValue ?? allocateBytes);
  return Object.freeze({
    request,
    fetcher,
    resources,
    fullResources: fullResources ?? resources,
    generation,
    isGenerationCurrent,
    ...(timers === undefined ? {} : { timers }),
    ...(deadline === undefined ? {} : { deadline }),
    ...(digestAdapter === undefined ? {} : { digestAdapter }),
    format,
    allocate
  });
}

function captureFetcher(value: RuntimeFetchAdapter): RuntimeFetchAdapter {
  let fetchMethod: unknown;
  try { fetchMethod = Reflect.get(value, "fetch"); } catch {}
  if (typeof fetchMethod !== "function") throw runtimeError("load-failure");
  return Object.freeze({
    fetch(url: string, init: Readonly<RuntimeFetchInit>) {
      return Reflect.apply(fetchMethod, value, [url, init]) as
        PromiseLike<RuntimeFetchResponseView>;
    }
  });
}

function captureFormat(
  value: RuntimeRangeAssetFormatAdapter
): RuntimeRangeAssetFormatAdapter {
  let header: unknown;
  let front: unknown;
  let complete: unknown;
  try {
    header = Reflect.get(value, "parseHeader");
    front = Reflect.get(value, "parseFrontIndex");
    complete = Reflect.get(value, "validateCompleteAsset");
  } catch {}
  if (
    typeof header !== "function" ||
    typeof front !== "function" ||
    typeof complete !== "function"
  ) {
    throw runtimeError("load-failure");
  }
  return Object.freeze({
    parseHeader: (bytes: Uint8Array, cap: number) =>
      Reflect.apply(header, value, [bytes, cap]) as Readonly<FormatHeader>,
    parseFrontIndex: (bytes: Uint8Array, cap: number) =>
      Reflect.apply(front, value, [bytes, cap]) as Readonly<ParsedFrontIndex>,
    validateCompleteAsset: (bytes: Uint8Array, cap: number) =>
      Reflect.apply(complete, value, [bytes, cap]) as ReturnType<
        RuntimeFullAssetFormatAdapter["validateCompleteAsset"]
      >
  });
}

function captureAllocator(
  value: (byteLength: number) => Uint8Array<ArrayBuffer>
): (byteLength: number) => Uint8Array<ArrayBuffer> {
  if (typeof value !== "function") throw runtimeError("load-failure");
  return (byteLength) => Reflect.apply(value, undefined, [byteLength]) as
    Uint8Array<ArrayBuffer>;
}

function allocateBytes(byteLength: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(byteLength));
}

function allocateExact(
  allocate: (byteLength: number) => Uint8Array<ArrayBuffer>,
  byteLength: number
): Uint8Array<ArrayBuffer> {
  const bytes = allocate(byteLength);
  if (
    !(bytes instanceof Uint8Array) ||
    !(bytes.buffer instanceof ArrayBuffer) ||
    bytes.byteOffset !== 0 ||
    bytes.byteLength !== byteLength ||
    bytes.buffer.byteLength !== byteLength
  ) {
    throw runtimeError("load-failure");
  }
  return bytes;
}

function captureLease(value: BoundedBodyByteLease): BoundedBodyByteLease {
  let release: unknown;
  try { release = Reflect.get(value, "release"); } catch {}
  if (typeof release !== "function") throw runtimeError("resource-rejection");
  let released = false;
  return Object.freeze({
    release(): void {
      if (released) return;
      released = true;
      Reflect.apply(release, value, []);
    }
  });
}

function failureContext(
  input: { readonly generation: number },
  requestOrdinal: number,
  lifecyclePhase: "initial-range" | "front-index" | "payload-range"
): Readonly<RuntimeFailureContext> {
  return Object.freeze({ generation: input.generation, requestOrdinal, lifecyclePhase });
}

function normalizeRangeFailure(
  cause: unknown,
  context: Readonly<RuntimeFailureContext>
): RuntimePlaybackError {
  if (isRuntimePlaybackError(cause)) {
    return runtimeError(cause.code, {
      ...context,
      ...cause.failure.context
    });
  }
  if (cause instanceof FormatError) {
    return runtimeError("invalid-asset", {
      ...context,
      sourceCode: cause.code,
      ...(cause.offset === undefined ? {} : { offset: cause.offset }),
      ...(cause.path === undefined ? {} : { sourcePath: cause.path })
    });
  }
  if (cause instanceof DOMException && cause.name === "AbortError") {
    return runtimeError("abort", context);
  }
  return runtimeError("load-failure", context);
}

function runtimeError(
  code: RuntimeFailureCode,
  context: Readonly<RuntimeFailureContext> = {}
): RuntimePlaybackError {
  return new RuntimePlaybackError(normalizeRuntimeFailure(code, undefined, context));
}

function assertCurrent(
  input: Readonly<CapturedOpenInput>,
  signal: AbortSignal
): void {
  if (!operationIsCurrent(input, signal)) throw runtimeError("abort");
}

function operationIsCurrent(
  input: Readonly<CapturedOpenInput>,
  signal: AbortSignal
): boolean {
  if (signal.aborted || input.request.signal?.aborted === true) return false;
  try { return input.isGenerationCurrent(input.generation) === true; } catch {
    return false;
  }
}

function safeRelease(lease: BoundedBodyByteLease | null): void {
  if (lease === null) return;
  try { lease.release(); } catch {}
}
