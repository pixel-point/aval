import {
  FormatError,
  validateCompleteAsset,
  type ValidatedAssetLayout
} from "@rendered-motion/format";

import {
  retireRuntimeBodyReader,
  snapshotRuntimeFetchResponse,
  type NormalizedRuntimeAssetRequest,
  type RuntimeFetchAdapter,
  type RuntimeFetchInit,
  type RuntimeFetchResponseView,
  type RuntimeFetchResponseSnapshot
} from "./asset-fetch-contracts.js";
import {
  readBoundedBody,
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
  parseStrongEntityTag,
  requireMatchingStrongEntityTag,
  type StrongEntityTag
} from "./http-entity-tag.js";
import {
  validateRuntimeHttpResponse,
  type RuntimeHeadersView
} from "./http-response-contract.js";
import {
  createLoadOperationDeadline,
  createLoadWatchdogs,
  type LoadWatchdogTimerHost,
  type RuntimeLoadOperationDeadline,
  type RuntimeLoadWatchdogs
} from "./load-watchdogs.js";
import type { RuntimeEntityIdentity } from "./model.js";
import {
  Sha256IntegrityMismatchError,
  verifySha256AndPromote,
  type Sha256DigestAdapter
} from "./sha256-verifier.js";

export interface RuntimeFullAssetFormatAdapter {
  validateCompleteAsset(
    bytes: Uint8Array,
    maximumFileBytes: number
  ): Readonly<ValidatedAssetLayout>;
}

export interface RuntimePinnedEntity {
  readonly finalUrl: string;
  readonly strongEntityTag?: StrongEntityTag;
}

export interface RuntimeFullAssetResult {
  readonly mode: "full";
  readonly identity: Extract<RuntimeEntityIdentity, { readonly mode: "full" }>;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly layout: Readonly<ValidatedAssetLayout>;
  readonly released: boolean;
  release(): void;
}

export interface FetchFullAssetInput {
  readonly request: Readonly<NormalizedRuntimeAssetRequest>;
  readonly fetcher: RuntimeFetchAdapter;
  readonly resources: BoundedBodyByteResourceHost;
  readonly generation: number;
  readonly isGenerationCurrent: (generation: number) => boolean;
  readonly sessionSignal?: AbortSignal;
  readonly timers?: LoadWatchdogTimerHost;
  /** Internal shared absolute deadline for a composed caller operation. */
  readonly deadline?: RuntimeLoadOperationDeadline;
  readonly digestAdapter?: Sha256DigestAdapter;
  readonly format?: RuntimeFullAssetFormatAdapter;
  readonly pinnedEntity?: Readonly<RuntimePinnedEntity>;
  readonly requestOrdinal?: number;
}

export interface AcceptRuntimeFullAssetResponseInput
extends Omit<FetchFullAssetInput, "fetcher" | "sessionSignal" | "timers"> {
  readonly response: Readonly<RuntimeFetchResponseSnapshot>;
  readonly watchdogs: RuntimeLoadWatchdogs;
  readonly signal: AbortSignal;
}

const DEFAULT_FORMAT: Readonly<RuntimeFullAssetFormatAdapter> = Object.freeze({
  validateCompleteAsset(
    bytes: Uint8Array,
    maximumFileBytes: number
  ): Readonly<ValidatedAssetLayout> {
    return validateCompleteAsset({
      bytes,
      options: { budgets: { maxFileBytes: maximumFileBytes } }
    });
  }
});

/** Fetch one standalone complete representation with no Range or If-Range. */
export async function fetchFullAsset(
  input: Readonly<FetchFullAssetInput>
): Promise<Readonly<RuntimeFullAssetResult>> {
  const captured = captureFullInput(input);
  const abortScope = new LinkedAbortScope([
    captured.request.signal,
    captured.sessionSignal ?? null
  ]);
  const ownsDeadline = captured.deadline === undefined;
  let deadline: RuntimeLoadOperationDeadline | null = null;
  let watchdogs: RuntimeLoadWatchdogs;
  try {
    const selectedDeadline = captured.deadline ?? createLoadOperationDeadline({
      signals: [abortScope.signal],
      ...(captured.timers === undefined ? {} : { timers: captured.timers }),
      timeoutMs: captured.request.policy.overallTimeoutMs
    });
    deadline = selectedDeadline;
    watchdogs = createLoadWatchdogs({
      signals: [abortScope.signal],
      ...(captured.timers === undefined ? {} : { timers: captured.timers }),
      overallDeadline: selectedDeadline,
      firstByteTimeoutMs: captured.request.policy.firstByteTimeoutMs,
      idleBodyTimeoutMs: captured.request.policy.idleBodyTimeoutMs
    });
  } catch (cause) {
    if (ownsDeadline) deadline?.complete();
    abortScope.dispose();
    throw normalizeFullFailure(cause, failureContext(captured));
  }
  const operationDeadline = deadline;
  if (operationDeadline === null) throw runtimeError("load-failure");

  try {
    assertCurrent(captured, abortScope.signal);
    const response = await fetchRuntimeResponseSnapshot(
      captured.fetcher,
      captured.request.url,
      Object.freeze({
        method: "GET" as const,
        credentials: captured.request.credentials,
        signal: watchdogs.signal,
        headers: Object.freeze({})
      }),
      watchdogs
    );
    watchdogs.noteHeadersReceived();
    return await acceptRuntimeFullAssetResponse({
      ...captured,
      response,
      watchdogs,
      signal: abortScope.signal,
      deadline: operationDeadline
    });
  } catch (cause) {
    throw normalizeFullFailure(cause, failureContext(captured));
  } finally {
    watchdogs.complete();
    if (ownsDeadline) operationDeadline.complete();
    abortScope.dispose();
  }
}

/** Retire a body that arrives after its request watchdog has already failed. */
export async function fetchRuntimeResponseSnapshot(
  fetcher: RuntimeFetchAdapter,
  url: string,
  init: Readonly<RuntimeFetchInit>,
  watchdogs: RuntimeLoadWatchdogs
): Promise<Readonly<RuntimeFetchResponseSnapshot>> {
  if (watchdogs.signal.aborted) {
    return watchdogs.watch(Promise.resolve(undefined as never));
  }
  const responsePromise = Promise.resolve().then(() => fetcher.fetch(url, init));
  const snapshotPromise = responsePromise.then(snapshotRuntimeFetchResponse);
  try {
    return await watchdogs.watch(snapshotPromise);
  } catch (cause) {
    void snapshotPromise.then(
      (late) => retireRuntimeBodyReader(late.bodyReader),
      () => {}
    );
    throw cause;
  }
}

/** Validate and consume one already-detached 200 response. */
export async function acceptRuntimeFullAssetResponse(
  input: Readonly<AcceptRuntimeFullAssetResponseInput>
): Promise<Readonly<RuntimeFullAssetResult>> {
  let readerOwned = true;
  const context = failureContext(input);
  const operationScope = new LinkedAbortScope([
    input.signal,
    input.deadline?.signal ?? null
  ]);
  try {
    input.deadline?.assertActive();
    assertCurrent(input, operationScope.signal);
    if (
      input.pinnedEntity !== undefined &&
      input.response.finalUrl !== input.pinnedEntity.finalUrl
    ) {
      throw runtimeError("entity-changed", context);
    }
    if (input.pinnedEntity?.strongEntityTag !== undefined) {
      try {
        requireMatchingStrongEntityTag(
          input.response.headers.entityTag,
          input.pinnedEntity.strongEntityTag
        );
      } catch {
        throw runtimeError("entity-changed", context);
      }
    }

    let validatedResponse: ReturnType<typeof validateRuntimeHttpResponse>;
    try {
      validatedResponse = validateRuntimeHttpResponse({
        status: input.response.status,
        expectedStatus: 200,
        responseType: input.response.type,
        finalUrl: input.response.finalUrl,
        ...(input.pinnedEntity === undefined
          ? {}
          : { pinnedFinalUrl: input.pinnedEntity.finalUrl }),
        bodyAvailable: true,
        headers: runtimeResponseHeadersView(input.response),
        maximumBodyBytes: input.request.policy.maximumFileBytes
      });
    } catch {
      throw runtimeError("range-response-invalid", context);
    }
    if (validatedResponse.contentLength === 0) {
      throw runtimeError("range-response-invalid", context);
    }

    readerOwned = false;
    let body: Readonly<BoundedBodyResult>;
    try {
      const bodyOperation = readBoundedBody({
        reader: input.response.bodyReader,
        mode: validatedResponse.contentLength === null
          ? {
              kind: "bounded-unknown",
              maximumBytes: input.request.policy.maximumFileBytes
            }
          : {
              kind: "known-exact",
              expectedBytes: validatedResponse.contentLength,
              maximumBytes: input.request.policy.maximumFileBytes
            },
        resources: input.resources,
        watchdogs: input.watchdogs,
        isCurrent: () => operationIsCurrent(input, operationScope.signal),
        context
      });
      body = input.deadline === undefined
        ? await bodyOperation
        : await input.deadline.watch(bodyOperation);
    } catch (cause) {
      if (isObservedLengthFailure(cause)) {
        throw runtimeError(
          "range-response-invalid",
          mergeFailureContext(context, cause)
        );
      }
      throw cause;
    }

    if (
      validatedResponse.contentLength !== null &&
      body.byteLength !== validatedResponse.contentLength
    ) {
      body.release();
      throw runtimeError("range-response-invalid", {
        ...context,
        expectedBytes: validatedResponse.contentLength,
        observedBytes: body.byteLength
      });
    }

    const strongEntityTag = parseStrongEntityTag(
      input.response.headers.entityTag
    );
    if (input.request.integrity !== null) {
      if (input.digestAdapter === undefined) {
        body.release();
        throw runtimeError("load-failure", context);
      }
      try {
        const verification = verifySha256AndPromote(input.digestAdapter, {
          bytes: body.bytes,
          expectedSha256Hex: input.request.integrity.sha256Hex,
          generation: input.generation,
          isGenerationCurrent: input.isGenerationCurrent,
          signal: operationScope.signal,
          inputLease: {
            release: body.release,
            promoteToAssetFull: body.promoteToAssetFull
          },
          promote: (verified) => createValidatedFullResult(
            verified.bytes as Uint8Array<ArrayBuffer>,
            verified.inputLease,
            input,
            validatedResponse.finalUrl,
            strongEntityTag
          )
        });
        return input.deadline === undefined
          ? await verification
          : await input.deadline.watch(verification);
      } catch (cause) {
        if (cause instanceof Sha256IntegrityMismatchError) {
          throw runtimeError("integrity-mismatch", context);
        }
        throw cause;
      }
    }

    try {
      return createValidatedFullResult(
        body.bytes,
        {
          release: body.release,
          promoteToAssetFull: body.promoteToAssetFull
        },
        input,
        validatedResponse.finalUrl,
        strongEntityTag
      );
    } catch (cause) {
      body.release();
      throw cause;
    }
  } catch (cause) {
    if (readerOwned) {
      await retireRuntimeBodyReader(input.response.bodyReader);
    }
    throw normalizeFullFailure(cause, context);
  } finally {
    operationScope.dispose();
  }
}

function createValidatedFullResult(
  bytes: Uint8Array<ArrayBuffer>,
  lease: { readonly promoteToAssetFull?: () => void; release(): void },
  input: Pick<
    AcceptRuntimeFullAssetResponseInput,
    "format" | "request" | "generation" | "deadline"
  >,
  finalUrl: string,
  strongEntityTag: StrongEntityTag | null
): Readonly<RuntimeFullAssetResult> {
  input.deadline?.assertActive();
  const format = captureFormat(input.format ?? DEFAULT_FORMAT);
  const layout = format.validateCompleteAsset(
    bytes,
    input.request.policy.maximumFileBytes
  );
  input.deadline?.assertActive();
  lease.promoteToAssetFull?.();
  input.deadline?.assertActive();
  let released = false;
  const result: RuntimeFullAssetResult = {
    mode: "full",
    identity: Object.freeze({
      mode: "full",
      generation: input.generation,
      finalUrl,
      declaredTotalBytes: layout.frontIndex.header.declaredFileLength,
      strongEntityTag
    }),
    bytes,
    layout,
    get released() { return released; },
    release(): void {
      if (released) return;
      released = true;
      try { lease.release(); } catch {}
    }
  };
  return Object.freeze(result);
}

interface CapturedFullInput extends FetchFullAssetInput {
  readonly fetcher: RuntimeFetchAdapter;
  readonly isGenerationCurrent: (generation: number) => boolean;
}

function captureFullInput(
  input: Readonly<FetchFullAssetInput>
): Readonly<CapturedFullInput> {
  if (typeof input !== "object" || input === null) {
    throw runtimeError("load-failure");
  }
  let request: FetchFullAssetInput["request"];
  let fetcherValue: FetchFullAssetInput["fetcher"];
  let resources: FetchFullAssetInput["resources"];
  let generation: number;
  let isGenerationCurrent: FetchFullAssetInput["isGenerationCurrent"];
  let sessionSignal: AbortSignal | undefined;
  let timers: LoadWatchdogTimerHost | undefined;
  let deadline: RuntimeLoadOperationDeadline | undefined;
  let digestAdapter: Sha256DigestAdapter | undefined;
  let format: RuntimeFullAssetFormatAdapter | undefined;
  let pinnedEntity: Readonly<RuntimePinnedEntity> | undefined;
  let requestOrdinal: number | undefined;
  try {
    request = input.request;
    fetcherValue = input.fetcher;
    resources = input.resources;
    generation = input.generation;
    isGenerationCurrent = input.isGenerationCurrent;
    sessionSignal = input.sessionSignal;
    timers = input.timers;
    deadline = input.deadline;
    digestAdapter = input.digestAdapter;
    format = input.format;
    pinnedEntity = input.pinnedEntity;
    requestOrdinal = input.requestOrdinal;
  } catch {
    throw runtimeError("load-failure");
  }
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw runtimeError("load-failure");
  }
  const fetcher = captureFetcher(fetcherValue);
  if (typeof isGenerationCurrent !== "function") {
    throw runtimeError("load-failure");
  }
  return Object.freeze({
    request,
    fetcher,
    resources,
    generation,
    isGenerationCurrent,
    ...(sessionSignal === undefined ? {} : { sessionSignal }),
    ...(timers === undefined ? {} : { timers }),
    ...(deadline === undefined ? {} : { deadline }),
    ...(digestAdapter === undefined ? {} : { digestAdapter }),
    ...(format === undefined ? {} : { format }),
    ...(pinnedEntity === undefined ? {} : { pinnedEntity }),
    ...(requestOrdinal === undefined ? {} : { requestOrdinal })
  });
}

function captureFetcher(value: RuntimeFetchAdapter): RuntimeFetchAdapter {
  let fetchMethod: unknown;
  try { fetchMethod = Reflect.get(value, "fetch"); } catch {}
  if (typeof fetchMethod !== "function") throw runtimeError("load-failure");
  return Object.freeze({
    fetch: (url: string, init: Readonly<RuntimeFetchInit>) =>
      Reflect.apply(fetchMethod, value, [url, init]) as
        PromiseLike<RuntimeFetchResponseView>
  });
}

function captureFormat(
  value: RuntimeFullAssetFormatAdapter
): RuntimeFullAssetFormatAdapter {
  let validate: unknown;
  try { validate = Reflect.get(value, "validateCompleteAsset"); } catch {}
  if (typeof validate !== "function") throw runtimeError("load-failure");
  return Object.freeze({
    validateCompleteAsset: (
      bytes: Uint8Array,
      maximumFileBytes: number
    ) =>
      Reflect.apply(validate, value, [bytes, maximumFileBytes]) as
        Readonly<ValidatedAssetLayout>
  });
}

export function runtimeResponseHeadersView(
  response: Readonly<RuntimeFetchResponseSnapshot>
): RuntimeHeadersView {
  const values = response.headers;
  return Object.freeze({
    get(name: string): string | null {
      if (name === "Content-Encoding") return values.contentEncoding;
      if (name === "Content-Length") return values.contentLength;
      if (name === "Content-Range") return values.contentRange;
      if (name === "ETag") return values.entityTag;
      return null;
    }
  });
}

function failureContext(input: {
  readonly request: Readonly<NormalizedRuntimeAssetRequest>;
  readonly generation: number;
  readonly requestOrdinal?: number;
}): Readonly<RuntimeFailureContext> {
  return Object.freeze({
    generation: input.generation,
    ...(input.requestOrdinal === undefined
      ? {}
      : { requestOrdinal: input.requestOrdinal }),
    lifecyclePhase: input.request.integrity === null
      ? "full-fallback"
      : "external-integrity"
  });
}

function mergeFailureContext(
  base: Readonly<RuntimeFailureContext>,
  cause: RuntimePlaybackError
): Readonly<RuntimeFailureContext> {
  return Object.freeze({
    ...base,
    ...(cause.failure.context.expectedBytes === undefined
      ? {}
      : { expectedBytes: cause.failure.context.expectedBytes }),
    ...(cause.failure.context.observedBytes === undefined
      ? {}
      : { observedBytes: cause.failure.context.observedBytes })
  });
}

function isObservedLengthFailure(cause: unknown): cause is RuntimePlaybackError {
  return isRuntimePlaybackError(cause) &&
    cause.code === "load-failure" &&
    cause.failure.context.expectedBytes !== undefined &&
    cause.failure.context.observedBytes !== undefined;
}

function normalizeFullFailure(
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
  if (isAbortFailure(cause)) return runtimeError("abort", context);
  return runtimeError("load-failure", context);
}

function runtimeError(
  code: RuntimeFailureCode,
  context: Readonly<RuntimeFailureContext> = {}
): RuntimePlaybackError {
  return new RuntimePlaybackError(normalizeRuntimeFailure(code, undefined, context));
}

function assertCurrent(
  input: { readonly generation: number; readonly isGenerationCurrent: (generation: number) => boolean },
  signal: AbortSignal
): void {
  if (!operationIsCurrent(input, signal)) throw runtimeError("abort");
}

function operationIsCurrent(
  input: { readonly generation: number; readonly isGenerationCurrent: (generation: number) => boolean },
  signal: AbortSignal
): boolean {
  if (signal.aborted) return false;
  try { return input.isGenerationCurrent(input.generation) === true; } catch {
    return false;
  }
}

function isAbortFailure(value: unknown): boolean {
  return value instanceof DOMException && value.name === "AbortError";
}

class LinkedAbortScope {
  readonly #controller = new AbortController();
  readonly #links: { readonly signal: AbortSignal; readonly listener: () => void }[] = [];

  public constructor(signals: readonly (AbortSignal | null)[]) {
    try {
      for (const signal of signals) {
        if (signal === null) continue;
        const listener = (): void => { this.#controller.abort(); };
        if (signal.aborted) {
          listener();
          break;
        }
        this.#links.push({ signal, listener });
        signal.addEventListener("abort", listener, { once: true });
      }
    } catch {
      this.dispose();
      throw runtimeError("load-failure");
    }
  }

  public get signal(): AbortSignal { return this.#controller.signal; }

  public dispose(): void {
    for (const { signal, listener } of this.#links.splice(0)) {
      try { signal.removeEventListener("abort", listener); } catch {}
    }
  }
}
