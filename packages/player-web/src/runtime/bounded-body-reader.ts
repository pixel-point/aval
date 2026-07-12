import {
  RuntimePlaybackError,
  isRuntimePlaybackError,
  normalizeRuntimeFailure,
  type RuntimeFailureCode,
  type RuntimeFailureContext
} from "./errors.js";
import { RuntimeLoadWatchdogs } from "./load-watchdogs.js";

export interface RuntimeBodyReadResult {
  readonly done: boolean;
  readonly value?: Uint8Array | undefined;
}

export interface RuntimeBodyReader {
  read(): PromiseLike<RuntimeBodyReadResult>;
  cancel(reason?: unknown): PromiseLike<void>;
  releaseLock(): void;
}

export interface BoundedBodyByteLease {
  /** Internal one-way accounting promotion for a validated retained 200 body. */
  readonly promoteToAssetFull?: () => void;
  release(): void;
}

export interface BoundedBodyByteResourceHost {
  reserve(
    byteLength: number
  ): BoundedBodyByteLease | PromiseLike<BoundedBodyByteLease>;
}

export type BoundedBodyMode =
  | {
      readonly kind: "known-exact";
      readonly expectedBytes: number;
      readonly maximumBytes: number;
    }
  | {
      readonly kind: "bounded-unknown";
      readonly maximumBytes: number;
    };

export interface BoundedBodyFailureContext {
  readonly requestOrdinal?: number;
  readonly generation?: number;
  readonly lifecyclePhase?: string;
}

export interface BoundedBodyReaderInput {
  readonly reader: RuntimeBodyReader | null;
  readonly mode: Readonly<BoundedBodyMode>;
  readonly resources: BoundedBodyByteResourceHost;
  readonly watchdogs: RuntimeLoadWatchdogs;
  readonly isCurrent?: () => boolean;
  readonly allocate?: (byteLength: number) => Uint8Array<ArrayBuffer>;
  readonly context?: Readonly<BoundedBodyFailureContext>;
}

export interface BoundedBodyResult {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly byteLength: number;
  /** No-op unless the supplying full-body host exposes the narrow capability. */
  promoteToAssetFull(): void;
  /** Release the transferred final-buffer lease exactly once. */
  release(): void;
}

interface CapturedBodyReader {
  readonly read: () => PromiseLike<RuntimeBodyReadResult>;
  readonly cancel: (reason?: unknown) => PromiseLike<void>;
  readonly releaseLock: () => void;
}

interface CapturedResources {
  readonly reserve: (
    byteLength: number
  ) => BoundedBodyByteLease | PromiseLike<BoundedBodyByteLease>;
}

interface ReaderState {
  ended: boolean;
  lockReleased: boolean;
  pendingRead: Promise<RuntimeBodyReadResult> | null;
  cancelPromise: Promise<unknown> | null;
  abortSignal: AbortSignal | null;
  abortListener: (() => void) | null;
}

interface BodyFailureFacts {
  readonly expectedBytes?: number;
  readonly observedBytes?: number;
}

class BodyReadInvariantError extends Error {
  public declare readonly facts: Readonly<BodyFailureFacts>;

  public constructor(facts: Readonly<BodyFailureFacts> = {}) {
    super("bounded response body is invalid");
    this.name = "BodyReadInvariantError";
    this.facts = Object.freeze({ ...facts });
  }
}

/**
 * Consume one untrusted response stream without an unbounded browser body
 * helper. Success transfers one exact final-buffer lease to the returned body.
 */
export async function readBoundedBody(
  input: Readonly<BoundedBodyReaderInput>
): Promise<Readonly<BoundedBodyResult>> {
  if (typeof input !== "object" || input === null) {
    throw normalizedBodyError(undefined, undefined, {});
  }

  const watchdogs = requireWatchdogs(input.watchdogs);
  const state: ReaderState = {
    ended: false,
    lockReleased: false,
    pendingRead: null,
    cancelPromise: null,
    abortSignal: null,
    abortListener: null
  };
  let reader: CapturedBodyReader | null = null;
  let finalLease: BoundedBodyByteLease | null = null;
  const temporaryLeases: BoundedBodyByteLease[] = [];
  let observedBytes = 0;
  let expectedBytes: number | undefined;

  try {
    if (input.reader !== null) {
      reader = captureReader(input.reader);
      linkReaderCancellation(reader, state, watchdogs.signal);
    }
    const mode = validateMode(input.mode);
    expectedBytes = mode.kind === "known-exact"
      ? mode.expectedBytes
      : undefined;
    const resources = captureResources(input.resources);
    const allocate = captureAllocator(input.allocate ?? allocateExactBytes);
    const isCurrent = captureCurrentPredicate(input.isCurrent ?? alwaysCurrent);
    if (reader === null) throw invariant(expectedBytes, 0);
    assertCurrent(isCurrent);

    let bytes: Uint8Array<ArrayBuffer>;
    if (mode.kind === "known-exact") {
      finalLease = await reserveBytes(
        resources,
        mode.expectedBytes,
        watchdogs
      );
      assertCurrent(isCurrent);
      bytes = allocateAndValidate(allocate, mode.expectedBytes);
      observedBytes = await fillKnownBody(
        reader,
        state,
        bytes,
        mode.expectedBytes,
        watchdogs,
        isCurrent
      );
    } else {
      const compacted = await readUnknownBody(
        reader,
        state,
        mode.maximumBytes,
        resources,
        temporaryLeases,
        watchdogs,
        allocate,
        isCurrent
      );
      bytes = compacted.bytes;
      observedBytes = compacted.byteLength;
      finalLease = compacted.lease;
    }

    assertCurrent(isCurrent);
    unlinkReaderCancellation(state);
    releaseReaderLock(reader, state);
    watchdogs.complete();
    const transferredLease = finalLease;
    finalLease = null;
    if (transferredLease === null) throw invariant(expectedBytes, observedBytes);
    return createBodyResult(bytes, transferredLease);
  } catch (cause) {
    watchdogs.complete();
    await retireReader(reader, state);
    releaseAll(temporaryLeases);
    safeRelease(finalLease);
    const facts = cause instanceof BodyReadInvariantError
      ? cause.facts
      : bodyFailureFacts(expectedBytes, observedBytes);
    throw normalizedBodyError(cause, input.context, facts);
  }
}

async function fillKnownBody(
  reader: CapturedBodyReader,
  state: ReaderState,
  destination: Uint8Array<ArrayBuffer>,
  expectedBytes: number,
  watchdogs: RuntimeLoadWatchdogs,
  isCurrent: () => boolean
): Promise<number> {
  let offset = 0;
  while (true) {
    const result = await readNext(reader, state, watchdogs);
    assertCurrent(isCurrent);
    const step = validateReadResult(result);
    if (step.done) {
      state.ended = true;
      if (offset !== expectedBytes) throw invariant(expectedBytes, offset);
      return offset;
    }
    const chunk = step.value;
    const length = safeByteLength(chunk);
    if (length === 0) continue;
    if (length > expectedBytes - offset) {
      throw invariant(expectedBytes, offset + length);
    }
    setBytes(destination, chunk, offset);
    offset += length;
    watchdogs.noteBodyProgress(length);
  }
}

async function readUnknownBody(
  reader: CapturedBodyReader,
  state: ReaderState,
  maximumBytes: number,
  resources: CapturedResources,
  temporaryLeases: BoundedBodyByteLease[],
  watchdogs: RuntimeLoadWatchdogs,
  allocate: (byteLength: number) => Uint8Array<ArrayBuffer>,
  isCurrent: () => boolean
): Promise<Readonly<{
  bytes: Uint8Array<ArrayBuffer>;
  byteLength: number;
  lease: BoundedBodyByteLease;
}>> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  while (true) {
    const result = await readNext(reader, state, watchdogs);
    assertCurrent(isCurrent);
    const step = validateReadResult(result);
    if (step.done) {
      state.ended = true;
      break;
    }
    const length = safeByteLength(step.value);
    if (length === 0) continue;
    if (length > maximumBytes - total) {
      throw invariant(maximumBytes, total + length);
    }

    const chunkLease = await reserveBytes(resources, length, watchdogs);
    temporaryLeases.push(chunkLease);
    assertCurrent(isCurrent);
    let ownedChunk: Uint8Array<ArrayBuffer>;
    try {
      ownedChunk = allocateAndValidate(allocate, length);
      setBytes(ownedChunk, step.value, 0);
    } catch (cause) {
      throw cause;
    }
    chunks.push(ownedChunk);
    total += length;
    watchdogs.noteBodyProgress(length);
  }

  if (total === 0) throw invariant(undefined, 0);
  const finalLease = await reserveBytes(resources, total, watchdogs);
  try {
    assertCurrent(isCurrent);
    const bytes = allocateAndValidate(allocate, total);
    let offset = 0;
    for (const chunk of chunks) {
      setBytes(bytes, chunk, offset);
      offset += chunk.byteLength;
    }
    assertCurrent(isCurrent);
    releaseAll(temporaryLeases);
    chunks.length = 0;
    return Object.freeze({ bytes, byteLength: total, lease: finalLease });
  } catch (cause) {
    safeRelease(finalLease);
    throw cause;
  }
}

async function readNext(
  reader: CapturedBodyReader,
  state: ReaderState,
  watchdogs: RuntimeLoadWatchdogs
): Promise<RuntimeBodyReadResult> {
  let pending: Promise<RuntimeBodyReadResult>;
  try {
    pending = Promise.resolve(reader.read());
  } catch (cause) {
    throw cause;
  }
  state.pendingRead = pending;
  const result = await watchdogs.watch(pending);
  state.pendingRead = null;
  return result;
}

async function reserveBytes(
  resources: CapturedResources,
  byteLength: number,
  watchdogs: RuntimeLoadWatchdogs
): Promise<BoundedBodyByteLease> {
  const reservation = Promise.resolve()
    .then(() => resources.reserve(byteLength))
    .then(captureLease);
  try {
    return await watchdogs.watch(reservation);
  } catch (cause) {
    void reservation.then(
      (lease) => {
        safeRelease(lease);
      },
      () => {}
    );
    throw cause;
  }
}

async function retireReader(
  reader: CapturedBodyReader | null,
  state: ReaderState
): Promise<void> {
  if (reader === null) return;
  unlinkReaderCancellation(state);
  const retirements: PromiseLike<unknown>[] = [];
  if (!state.ended) startReaderCancellation(reader, state);
  if (state.cancelPromise !== null) retirements.push(state.cancelPromise);
  if (state.pendingRead !== null) retirements.push(state.pendingRead);
  if (retirements.length > 0) {
    await Promise.allSettled(retirements.map((value) => Promise.resolve(value)));
  }
  releaseReaderLock(reader, state, true);
}

function linkReaderCancellation(
  reader: CapturedBodyReader,
  state: ReaderState,
  signal: AbortSignal
): void {
  const listener = (): void => {
    startReaderCancellation(reader, state);
  };
  state.abortSignal = signal;
  state.abortListener = listener;
  signal.addEventListener("abort", listener, { once: true });
  if (signal.aborted) listener();
}

function unlinkReaderCancellation(state: ReaderState): void {
  const signal = state.abortSignal;
  const listener = state.abortListener;
  state.abortSignal = null;
  state.abortListener = null;
  if (signal === null || listener === null) return;
  try {
    signal.removeEventListener("abort", listener);
  } catch {
    // Local ownership is retired even if a hostile signal refuses removal.
  }
}

function startReaderCancellation(
  reader: CapturedBodyReader,
  state: ReaderState
): void {
  if (state.ended || state.cancelPromise !== null) return;
  try {
    state.cancelPromise = Promise.resolve(reader.cancel()).catch(() => {});
  } catch {
    state.cancelPromise = Promise.resolve();
  }
}

function releaseReaderLock(
  reader: CapturedBodyReader,
  state: ReaderState,
  suppressFailure = false
): void {
  if (state.lockReleased) return;
  state.lockReleased = true;
  try {
    reader.releaseLock();
  } catch (cause) {
    if (!suppressFailure) throw cause;
  }
}

function validateMode(value: Readonly<BoundedBodyMode>): BoundedBodyMode {
  if (typeof value !== "object" || value === null) {
    throw invariant();
  }
  if (value.kind === "known-exact") {
    requirePositiveSafeInteger(value.maximumBytes, "known body cap");
    requirePositiveSafeInteger(value.expectedBytes, "known body length");
    if (value.expectedBytes > value.maximumBytes) {
      throw invariant(value.maximumBytes, value.expectedBytes);
    }
    return Object.freeze({
      kind: "known-exact",
      expectedBytes: value.expectedBytes,
      maximumBytes: value.maximumBytes
    });
  }
  if (value.kind === "bounded-unknown") {
    requirePositiveSafeInteger(value.maximumBytes, "unknown body cap");
    return Object.freeze({
      kind: "bounded-unknown",
      maximumBytes: value.maximumBytes
    });
  }
  throw invariant();
}

function validateReadResult(value: RuntimeBodyReadResult):
  | Readonly<{ done: true }>
  | Readonly<{ done: false; value: Uint8Array }> {
  if (typeof value !== "object" || value === null) throw invariant();
  let done: unknown;
  let chunk: unknown;
  try {
    done = Reflect.get(value, "done");
    chunk = Reflect.get(value, "value");
  } catch {
    throw invariant();
  }
  if (done === true) {
    if (chunk !== undefined) throw invariant();
    return Object.freeze({ done: true });
  }
  if (done !== false || !(chunk instanceof Uint8Array)) throw invariant();
  return Object.freeze({ done: false, value: chunk });
}

function captureReader(value: RuntimeBodyReader): CapturedBodyReader {
  if (typeof value !== "object" || value === null) throw invariant();
  let read: unknown;
  let cancel: unknown;
  let releaseLock: unknown;
  try {
    read = Reflect.get(value, "read");
    cancel = Reflect.get(value, "cancel");
    releaseLock = Reflect.get(value, "releaseLock");
  } catch {
    throw invariant();
  }
  if (
    typeof read !== "function" ||
    typeof cancel !== "function" ||
    typeof releaseLock !== "function"
  ) {
    throw invariant();
  }
  return Object.freeze({
    read: () => Reflect.apply(read, value, []) as PromiseLike<RuntimeBodyReadResult>,
    cancel: (reason?: unknown) => Reflect.apply(cancel, value, [reason]) as PromiseLike<void>,
    releaseLock: () => {
      Reflect.apply(releaseLock, value, []);
    }
  });
}

function captureResources(value: BoundedBodyByteResourceHost): CapturedResources {
  if (typeof value !== "object" || value === null) throw invariant();
  let reserve: unknown;
  try {
    reserve = Reflect.get(value, "reserve");
  } catch {
    throw invariant();
  }
  if (typeof reserve !== "function") throw invariant();
  return Object.freeze({
    reserve: (byteLength: number) => Reflect.apply(reserve, value, [byteLength]) as
      | BoundedBodyByteLease
      | PromiseLike<BoundedBodyByteLease>
  });
}

function captureLease(value: BoundedBodyByteLease): BoundedBodyByteLease {
  if (typeof value !== "object" || value === null) throw invariant();
  let release: unknown;
  let promote: unknown;
  try {
    release = Reflect.get(value, "release");
    promote = Reflect.get(value, "promoteToAssetFull");
  } catch {
    throw invariant();
  }
  if (typeof release !== "function") throw invariant();
  if (promote !== undefined && typeof promote !== "function") throw invariant();
  let released = false;
  let promoted = false;
  return Object.freeze({
    promoteToAssetFull(): void {
      if (released) throw invariant();
      if (promoted) return;
      if (typeof promote === "function") Reflect.apply(promote, value, []);
      promoted = true;
    },
    release(): void {
      if (released) return;
      released = true;
      Reflect.apply(release, value, []);
    }
  });
}

function captureAllocator(
  value: (byteLength: number) => Uint8Array<ArrayBuffer>
): (byteLength: number) => Uint8Array<ArrayBuffer> {
  if (typeof value !== "function") throw invariant();
  return (byteLength) => Reflect.apply(value, undefined, [byteLength]) as Uint8Array<ArrayBuffer>;
}

function captureCurrentPredicate(value: () => boolean): () => boolean {
  if (typeof value !== "function") throw invariant();
  return () => Reflect.apply(value, undefined, []) as boolean;
}

function requireWatchdogs(value: RuntimeLoadWatchdogs): RuntimeLoadWatchdogs {
  if (!(value instanceof RuntimeLoadWatchdogs)) {
    throw normalizedBodyError(undefined, undefined, {});
  }
  return value;
}

function allocateExactBytes(byteLength: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(byteLength));
}

function allocateAndValidate(
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
    throw invariant(byteLength, safeObservedLength(bytes));
  }
  return bytes;
}

function setBytes(
  destination: Uint8Array<ArrayBuffer>,
  source: Uint8Array,
  offset: number
): void {
  Uint8Array.prototype.set.call(destination, source, offset);
}

function safeByteLength(value: Uint8Array): number {
  let length: number;
  try {
    length = value.byteLength;
  } catch {
    throw invariant();
  }
  if (!Number.isSafeInteger(length) || length < 0) throw invariant();
  return length;
}

function safeObservedLength(value: unknown): number | undefined {
  try {
    if (value instanceof Uint8Array && Number.isSafeInteger(value.byteLength)) {
      return value.byteLength;
    }
  } catch {
    // Leave hostile allocation length out of diagnostics.
  }
  return undefined;
}

function assertCurrent(isCurrent: () => boolean): void {
  if (isCurrent() !== true) {
    throw new RuntimePlaybackError(normalizeRuntimeFailure("abort"));
  }
}

function alwaysCurrent(): boolean {
  return true;
}

function createBodyResult(
  bytes: Uint8Array<ArrayBuffer>,
  lease: BoundedBodyByteLease
): Readonly<BoundedBodyResult> {
  let released = false;
  return Object.freeze({
    bytes,
    byteLength: bytes.byteLength,
    promoteToAssetFull(): void {
      lease.promoteToAssetFull?.();
    },
    release(): void {
      if (released) return;
      released = true;
      safeRelease(lease);
    }
  });
}

function releaseAll(leases: BoundedBodyByteLease[]): void {
  for (const lease of leases.splice(0)) safeRelease(lease);
}

function safeRelease(lease: BoundedBodyByteLease | null): void {
  if (lease === null) return;
  try {
    lease.release();
  } catch {
    // Release remains logically retired and never masks the primary outcome.
  }
}

function requirePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function invariant(
  expectedBytes?: number,
  observedBytes?: number
): BodyReadInvariantError {
  const facts: { expectedBytes?: number; observedBytes?: number } = {};
  if (expectedBytes !== undefined) facts.expectedBytes = expectedBytes;
  if (observedBytes !== undefined) facts.observedBytes = observedBytes;
  return new BodyReadInvariantError(facts);
}

function bodyFailureFacts(
  expectedBytes: number | undefined,
  observedBytes: number | undefined
): Readonly<BodyFailureFacts> {
  const facts: { expectedBytes?: number; observedBytes?: number } = {};
  if (expectedBytes !== undefined) facts.expectedBytes = expectedBytes;
  if (observedBytes !== undefined) facts.observedBytes = observedBytes;
  return Object.freeze(facts);
}

function normalizedBodyError(
  cause: unknown,
  base: Readonly<BoundedBodyFailureContext> | undefined,
  facts: Readonly<BodyFailureFacts>
): RuntimePlaybackError {
  const code: RuntimeFailureCode = isRuntimePlaybackError(cause)
    ? cause.code
    : "load-failure";
  const context = bodyFailureContext(base, facts, cause);
  return new RuntimePlaybackError(normalizeRuntimeFailure(
    code,
    isRuntimePlaybackError(cause) ? cause : undefined,
    context
  ));
}

function bodyFailureContext(
  base: Readonly<BoundedBodyFailureContext> | undefined,
  facts: Readonly<BodyFailureFacts>,
  cause: unknown
): Readonly<RuntimeFailureContext> {
  const context: {
    requestOrdinal?: number;
    generation?: number;
    lifecyclePhase?: string;
    policyPhase?: string;
    expectedBytes?: number;
    observedBytes?: number;
  } = {};
  try {
    if (base !== undefined) {
      if (base.requestOrdinal !== undefined) {
        context.requestOrdinal = base.requestOrdinal;
      }
      if (base.generation !== undefined) context.generation = base.generation;
      if (base.lifecyclePhase !== undefined) {
        context.lifecyclePhase = base.lifecyclePhase;
      }
    }
    if (facts.expectedBytes !== undefined) {
      context.expectedBytes = facts.expectedBytes;
    }
    if (facts.observedBytes !== undefined) {
      context.observedBytes = facts.observedBytes;
    }
    if (isRuntimePlaybackError(cause)) {
      const phase = cause.failure.context.policyPhase;
      if (phase !== undefined) context.policyPhase = phase;
    }
  } catch {
    // normalizeRuntimeFailure will retain only the safe facts assembled so far.
  }
  return Object.freeze(context);
}
