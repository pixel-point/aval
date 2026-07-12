import {
  RuntimePlaybackError,
  normalizeRuntimeFailure
} from "./errors.js";
import type {
  RuntimeByteCategory,
  RuntimeByteLease,
  RuntimeParticipantId,
  RuntimeParticipantState,
  RuntimeReclamationReason,
  RuntimeReclamationRequest,
  RuntimeReclamationResult,
  RuntimeReclamationToken
} from "./model.js";
import {
  PageResourceManager,
  registerPageResourceCounterContributor
} from "./page-resource-manager.js";

const RESERVATION_FIELDS: ReadonlySet<string> = new Set([
  "participantId",
  "generation",
  "category",
  "bytes",
  "signal"
]);
const ABANDONED_CATEGORIES: ReadonlySet<RuntimeByteCategory> = new Set([
  "response-body",
  "quarantine",
  "blob-assembly",
  "verified-unit",
  "worker-transfer",
  "decoder-output",
  "persistent-animation",
  "streaming-texture",
  "frame-staging"
]);
const ANIMATION_CATEGORIES: ReadonlySet<RuntimeByteCategory> = new Set([
  "verified-unit",
  "worker-transfer",
  "decoder-output",
  "persistent-animation",
  "streaming-texture",
  "frame-staging"
]);
const OPTIONAL_CATEGORIES: ReadonlySet<RuntimeByteCategory> = new Set([
  "response-body",
  "quarantine",
  "blob-assembly",
  "verified-unit",
  "worker-transfer",
  "decoder-output",
  "persistent-animation",
  "streaming-texture",
  "frame-staging",
  "png-copy",
  "png-zlib",
  "png-scratch"
]);

export interface RuntimeReclamationParticipant {
  reclaim(
    request: Readonly<RuntimeReclamationRequest>
  ): PromiseLike<Readonly<RuntimeReclamationResult>>;
}

export interface RuntimeReclamationReservationInput {
  readonly participantId: RuntimeParticipantId;
  readonly generation: number;
  readonly category: RuntimeByteCategory;
  readonly bytes: number;
  /** Cancels this requester without waiting for a victim callback to settle. */
  readonly signal?: AbortSignal;
}

interface CapturedReclamationReservationInput {
  readonly participantId: RuntimeParticipantId;
  readonly generation: number;
  readonly category: RuntimeByteCategory;
  readonly bytes: number;
  readonly signal: AbortSignal | null;
}

export interface PageReclamationSnapshot {
  readonly pendingCount: number;
  readonly registeredParticipantCount: number;
  readonly tokenSequence: number;
  readonly disposed: boolean;
}

interface RegisteredParticipant {
  readonly ordinal: number;
  readonly participantId: RuntimeParticipantId;
  readonly reclaim: (
    request: Readonly<RuntimeReclamationRequest>
  ) => PromiseLike<Readonly<RuntimeReclamationResult>>;
}

interface Candidate {
  readonly key: string;
  readonly rank: number;
  readonly reason: Exclude<
    RuntimeReclamationReason,
    "policy-reduction" | "participant-disposal"
  >;
  readonly state: Readonly<RuntimeParticipantState>;
  readonly bytes: number;
  readonly participant: RegisteredParticipant;
}

/** Serialized decision authority with callbacks executed outside decision work. */
export class PageReclamationCoordinator {
  readonly #manager: PageResourceManager;
  readonly #participants = new Map<number, RegisteredParticipant>();
  readonly #pending = new Map<number, Readonly<RuntimeReclamationRequest>>();
  readonly #claimedParticipants = new Set<number>();
  readonly #operations = new Set<Promise<unknown>>();
  readonly #controller = new AbortController();
  readonly #unregisterCounters: () => void;
  #nextParticipantOrdinal = 0;
  #nextToken = 0;
  #disposed = false;
  #disposal: Promise<void> | null = null;

  public constructor(manager: PageResourceManager) {
    if (!(manager instanceof PageResourceManager)) {
      throw new TypeError("reclamation requires a page resource manager");
    }
    this.#manager = manager;
    this.#unregisterCounters = registerPageResourceCounterContributor(manager, {
      resourceCounters: () => ({
        decoderLeaseCount: 0,
        decoderQueueLength: 0,
        pendingReclamations: this.#pending.size
      })
    });
  }

  public registerParticipant(
    participantId: RuntimeParticipantId,
    value: RuntimeReclamationParticipant
  ): () => void {
    this.#throwIfDisposed();
    if (this.#manager.tryParticipantSnapshot(participantId) === null) {
      throw disposedError();
    }
    const id = Number(participantId);
    if (this.#participants.has(id)) {
      throw new RangeError("reclamation participant is already registered");
    }
    const reclaim = captureReclaim(value);
    const ordinal = checkedIncrement(
      this.#nextParticipantOrdinal,
      "reclamation participant ordinal"
    );
    const registration: RegisteredParticipant = {
      ordinal,
      participantId,
      reclaim
    };
    this.#nextParticipantOrdinal = ordinal;
    this.#participants.set(id, registration);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      if (this.#participants.get(id) === registration) {
        this.#participants.delete(id);
      }
    };
  }

  public reserveWithReclamation(
    input: Readonly<RuntimeReclamationReservationInput>
  ): Promise<RuntimeByteLease> {
    this.#throwIfDisposed();
    validateExactObject(input, RESERVATION_FIELDS, "reclamation reservation");
    const captured = Object.freeze({
      participantId: input.participantId,
      generation: requireGeneration(input.generation),
      category: input.category,
      bytes: requirePositiveBytes(input.bytes, "requested reservation bytes"),
      signal: input.signal === undefined
        ? null
        : requireAbortSignal(input.signal)
    });
    return this.#track(this.#reserve(captured));
  }

  public reclaimForPolicyReduction(requestedValue: number): Promise<number> {
    this.#throwIfDisposed();
    const requestedBytes = requirePositiveBytes(
      requestedValue,
      "policy reduction bytes"
    );
    return this.#track(this.#reclaimPolicy(requestedBytes));
  }

  public snapshot(): Readonly<PageReclamationSnapshot> {
    return Object.freeze({
      pendingCount: this.#pending.size,
      registeredParticipantCount: this.#participants.size,
      tokenSequence: this.#nextToken,
      disposed: this.#disposed
    });
  }

  public dispose(): Promise<void> {
    if (this.#disposal !== null) return this.#disposal;
    this.#disposed = true;
    try { this.#controller.abort(disposedError()); } catch {}
    this.#participants.clear();
    this.#disposal = Promise.allSettled([...this.#operations]).then(() => {
      this.#unregisterCounters();
    });
    return this.#disposal;
  }

  async #reserve(
    input: Readonly<CapturedReclamationReservationInput>
  ): Promise<RuntimeByteLease> {
    const attempted = new Set<string>();
    while (true) {
      this.#throwIfReservationAborted(input);
      this.#throwIfDisposed();
      const requester = this.#requireCurrentRequester(input);
      try {
        return this.#manager.reserve(
          input.participantId,
          input.category,
          input.bytes
        );
      } catch (error) {
        if (!isResourceRejection(error)) throw error;
      }

      const snapshot = this.#manager.snapshot();
      const playerShortfall = Math.max(
        0,
        checkedSum(
          requester.logicalBytes,
          input.bytes,
          "requested player bytes"
        ) -
          snapshot.policy.maximumPlayerLogicalBytes
      );
      const pageShortfall = Math.max(
        0,
        checkedSum(
          snapshot.physicalBytes,
          input.bytes,
          "requested page bytes"
        ) -
          snapshot.policy.maximumPagePhysicalBytes
      );
      const allCandidates = this.#candidates(
        input.participantId,
        attempted,
        false
      );
      const requesterCandidates = allCandidates.filter(({ state }) =>
        state.id === input.participantId
      );
      if (
        sumCandidateBytes(allCandidates) < pageShortfall ||
        sumCandidateBytes(requesterCandidates) < playerShortfall
      ) {
        return this.#manager.reserve(
          input.participantId,
          input.category,
          input.bytes
        );
      }
      const candidates = playerShortfall > 0
        ? requesterCandidates
        : allCandidates;
      const candidate = candidates[0];
      if (candidate === undefined) {
        return this.#manager.reserve(
          input.participantId,
          input.category,
          input.bytes
        );
      }
      attempted.add(candidate.key);
      const requestedBytes = Math.min(
        candidate.bytes,
        Math.max(1, playerShortfall, pageShortfall)
      );
      let result: Readonly<RuntimeReclamationResult>;
      try {
        result = await this.#invoke(
          candidate,
          requestedBytes,
          candidate.reason,
          input.signal
        );
      } catch {
        this.#throwIfReservationAborted(input);
        this.#throwIfDisposed();
        this.#requireCurrentRequester(input);
        continue;
      }
      this.#throwIfReservationAborted(input);
      this.#throwIfDisposed();
      this.#requireCurrentRequester(input);
      if (
        (candidate.reason === "hidden-animation" ||
          candidate.reason === "requester-fallback") &&
        !result.covered
      ) {
        throw resourceRejection(
          input.bytes,
          requester.logicalBytes,
          snapshot.physicalBytes
        );
      }
    }
  }

  async #reclaimPolicy(requestedBytes: number): Promise<number> {
    const before = this.#manager.snapshot().physicalBytes;
    const attempted = new Set<string>();
    while (before - this.#manager.snapshot().physicalBytes < requestedBytes) {
      this.#throwIfDisposed();
      const released = before - this.#manager.snapshot().physicalBytes;
      const needed = requestedBytes - released;
      const candidates = this.#candidates(null, attempted, true);
      if (sumCandidateBytes(candidates) < needed) {
        throw resourceRejection(
          requestedBytes,
          0,
          this.#manager.snapshot().physicalBytes
        );
      }
      const candidate = candidates[0];
      if (candidate === undefined) {
        throw resourceRejection(
          requestedBytes,
          0,
          this.#manager.snapshot().physicalBytes
        );
      }
      attempted.add(candidate.key);
      try {
        await this.#invoke(
          candidate,
          Math.min(candidate.bytes, needed),
          "policy-reduction",
          null
        );
      } catch {
        this.#throwIfDisposed();
      }
    }
    return before - this.#manager.snapshot().physicalBytes;
  }

  #candidates(
    requesterId: RuntimeParticipantId | null,
    attempted: ReadonlySet<string>,
    policyReduction: boolean
  ): Candidate[] {
    const candidates = new Map<string, Candidate>();
    for (const state of this.#manager.snapshot().participants) {
      const participant = this.#participants.get(Number(state.id));
      if (participant === undefined) continue;
      for (const reclaimable of state.reclaimable) {
        const classification = classifyCandidate(
          state,
          reclaimable.category,
          requesterId,
          policyReduction
        );
        if (classification === null) continue;
        const key = `${classification.rank}:${Number(state.id)}`;
        if (
          attempted.has(key) ||
          this.#claimedParticipants.has(Number(state.id))
        ) continue;
        const existing = candidates.get(key);
        if (existing === undefined) {
          candidates.set(key, {
            key,
            rank: classification.rank,
            reason: classification.reason,
            state,
            bytes: reclaimable.bytes,
            participant
          });
        } else {
          candidates.set(key, {
            ...existing,
            bytes: checkedSum(
              existing.bytes,
              reclaimable.bytes,
              "candidate reclaimable bytes"
            )
          });
        }
      }
    }
    return [...candidates.values()].sort((left, right) =>
      left.rank - right.rank ||
      left.state.lastTouchSequence - right.state.lastTouchSequence ||
      Number(left.state.id) - Number(right.state.id)
    );
  }

  async #invoke(
    candidate: Candidate,
    requestedBytes: number,
    reason: RuntimeReclamationReason,
    requesterSignal: AbortSignal | null
  ): Promise<Readonly<RuntimeReclamationResult>> {
    const tokenNumber = checkedIncrement(this.#nextToken, "reclamation token");
    const request = Object.freeze({
      token: tokenNumber as RuntimeReclamationToken,
      participantId: candidate.state.id,
      generation: candidate.state.generation,
      reason,
      requestedBytes
    });
    this.#nextToken = tokenNumber;
    this.#pending.set(tokenNumber, request);
    this.#claimedParticipants.add(Number(candidate.state.id));
    let result: Readonly<RuntimeReclamationResult>;
    let callback: Promise<Readonly<RuntimeReclamationResult>>;
    try {
      callback = Promise.resolve(candidate.participant.reclaim(request));
      result = await raceReclamationCancellation(
        callback,
        requesterSignal === null
          ? [this.#controller.signal]
          : [this.#controller.signal, requesterSignal]
      );
    } finally {
      this.#pending.delete(tokenNumber);
      this.#claimedParticipants.delete(Number(candidate.state.id));
    }
    return validateReclamationResult(result, request.token);
  }

  #requireCurrentRequester(
    input: Readonly<CapturedReclamationReservationInput>
  ): Readonly<RuntimeParticipantState> {
    const requester = this.#manager.tryParticipantSnapshot(input.participantId);
    if (requester === null) throw disposedError();
    if (requester.generation !== input.generation) {
      throw staleReclamationError();
    }
    return requester;
  }

  #track<Result>(operation: Promise<Result>): Promise<Result> {
    this.#operations.add(operation);
    operation.then(
      () => { this.#operations.delete(operation); },
      () => { this.#operations.delete(operation); }
    );
    return operation;
  }

  #throwIfDisposed(): void {
    if (this.#disposed) throw disposedError();
  }

  #throwIfReservationAborted(
    input: Readonly<CapturedReclamationReservationInput>
  ): void {
    if (input.signal?.aborted === true) throw staleReclamationError();
  }
}

function classifyCandidate(
  state: Readonly<RuntimeParticipantState>,
  category: RuntimeByteCategory,
  requesterId: RuntimeParticipantId | null,
  policyReduction: boolean
): { readonly rank: number; readonly reason: Candidate["reason"] } | null {
  if (category === "decoded-static-cache") {
    return { rank: 1, reason: "decoded-static" };
  }
  if (ABANDONED_CATEGORIES.has(category) && state.phase !== "animated") {
    return { rank: 2, reason: "abandoned-animation" };
  }
  if (
    state.visibility === "hidden" &&
    ANIMATION_CATEGORIES.has(category)
  ) {
    return { rank: 3, reason: "hidden-animation" };
  }
  if (
    (state.phase === "static" || state.phase === "preparing") &&
    OPTIONAL_CATEGORIES.has(category)
  ) {
    return { rank: 4, reason: "optional-cache" };
  }
  if (
    !policyReduction &&
    requesterId !== null &&
    state.id === requesterId &&
    ANIMATION_CATEGORIES.has(category)
  ) {
    return { rank: 5, reason: "requester-fallback" };
  }
  return null;
}

function captureReclaim(
  value: RuntimeReclamationParticipant
): RegisteredParticipant["reclaim"] {
  if (value === null || typeof value !== "object") {
    throw new TypeError("reclamation participant must be an object");
  }
  let reclaim: unknown;
  try {
    reclaim = Reflect.get(value, "reclaim");
  } catch {
    throw new TypeError("reclamation callback is inaccessible");
  }
  if (typeof reclaim !== "function") {
    throw new TypeError("reclamation callback is unavailable");
  }
  return (request) => Reflect.apply(reclaim, value, [request]) as
    PromiseLike<Readonly<RuntimeReclamationResult>>;
}

function validateReclamationResult(
  value: Readonly<RuntimeReclamationResult>,
  token: RuntimeReclamationToken
): Readonly<RuntimeReclamationResult> {
  if (value === null || typeof value !== "object") {
    throw new TypeError("reclamation result must be an object");
  }
  if (value.token !== token) {
    throw new TypeError("reclamation result token does not match");
  }
  const releasedBytes = requireNonNegativeBytes(
    value.releasedBytes,
    "released reclamation bytes"
  );
  if (typeof value.covered !== "boolean") {
    throw new TypeError("reclamation cover result must be boolean");
  }
  return Object.freeze({ token, releasedBytes, covered: value.covered });
}

function sumCandidateBytes(candidates: readonly Candidate[]): number {
  return candidates.reduce(
    (sum, candidate) => checkedSum(
      sum,
      candidate.bytes,
      "planned reclamation bytes"
    ),
    0
  );
}

function validateExactObject(
  value: object,
  fields: ReadonlySet<string>,
  label: string
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw new TypeError(`${label} has an unknown field`);
  }
}

function requireGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("reclamation generation must be non-negative and safe");
  }
  return value;
}

function requirePositiveBytes(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function requireNonNegativeBytes(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireAbortSignal(value: AbortSignal): AbortSignal {
  if (!(value instanceof AbortSignal)) {
    throw new TypeError("reclamation signal must be an AbortSignal");
  }
  return value;
}

async function raceReclamationCancellation<Value>(
  operation: Promise<Value>,
  signals: readonly AbortSignal[]
): Promise<Value> {
  const aborted = signals.find(({ aborted }) => aborted);
  if (aborted !== undefined) throw cancellationReason(aborted);
  const removers: Array<() => void> = [];
  const cancellation = new Promise<never>((_resolve, reject) => {
    for (const signal of signals) {
      const listener = (): void => { reject(cancellationReason(signal)); };
      let installed = false;
      try {
        installed = true;
        signal.addEventListener("abort", listener, { once: true });
        removers.push(() => {
          if (!installed) return;
          installed = false;
          try { signal.removeEventListener("abort", listener); } catch {}
        });
        if (signal.aborted) listener();
      } catch (error) {
        if (installed) {
          try { signal.removeEventListener("abort", listener); } catch {}
        }
        reject(error);
        return;
      }
    }
  });
  try {
    return await Promise.race([operation, cancellation]);
  } finally {
    for (const remove of removers.splice(0)) remove();
    // Promise.race observes a late callback settlement; no callback authority
    // remains in coordinator pending/claim state after cancellation.
    void operation.catch(() => undefined);
  }
}

function cancellationReason(signal: AbortSignal): unknown {
  try {
    return signal.reason ?? staleReclamationError();
  } catch {
    return staleReclamationError();
  }
}

function checkedIncrement(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${label} exceeded the safe-integer range`);
  }
  return value + 1;
}

function checkedSum(left: number, right: number, label: string): number {
  if (
    !Number.isSafeInteger(left) ||
    left < 0 ||
    !Number.isSafeInteger(right) ||
    right < 0 ||
    left > Number.MAX_SAFE_INTEGER - right
  ) {
    throw new RangeError(`${label} exceeded the safe-integer range`);
  }
  return left + right;
}

function isResourceRejection(error: unknown): error is RuntimePlaybackError {
  return error instanceof RuntimePlaybackError && error.code === "resource-rejection";
}

function resourceRejection(
  expectedBytes: number,
  playerBytes: number,
  pageBytes: number
): RuntimePlaybackError {
  return new RuntimePlaybackError(normalizeRuntimeFailure(
    "resource-rejection",
    undefined,
    { expectedBytes, playerBytes, pageBytes }
  ));
}

function disposedError(): RuntimePlaybackError {
  return new RuntimePlaybackError(normalizeRuntimeFailure("disposed"));
}

function staleReclamationError(): DOMException {
  return new DOMException("reclamation generation is stale", "AbortError");
}
