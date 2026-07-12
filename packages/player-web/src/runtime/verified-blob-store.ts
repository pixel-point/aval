import { FORMAT_DEFAULT_BUDGETS } from "@rendered-motion/format";

import {
  RuntimePlaybackError,
  isRuntimePlaybackError,
  normalizeRuntimeFailure
} from "./errors.js";
import type {
  RuntimeBlobResidencySnapshot,
  RuntimeBlobResidencyState
} from "./model.js";
import {
  assertLiveRuntimeCompleteSourceRange,
  type RuntimeCompleteSourceRange
} from "./runtime-complete-source.js";
import {
  inspectBorrowedAvcRendition,
  type BorrowedAvcRenditionPlan
} from "./borrowed-avc-inspection.js";
import {
  Sha256IntegrityMismatchError,
  consumeVerifiedSha256Input,
  type ConsumedVerifiedSha256Input,
  type VerifiedSha256Input
} from "./sha256-verifier.js";
import {
  captureVerifiedBlobPersistentLease as capturePersistentLease,
  captureVerifiedBlobResourceHost,
  type CapturedVerifiedBlobPersistentLease,
  type CapturedVerifiedBlobResourceHost
} from "./verified-blob-resources.js";
import {
  StaleBlobLoadError,
  VerifiedBlobPromotionError,
  normalizeVerifiedBlobLoaderFailure as normalizeLoaderFailure,
  normalizeVerifiedBlobPromotionFailure as normalizePromotionFailure,
  verifiedBlobAbortError as abortError,
  verifiedBlobRuntimeError as runtimeError,
  type VerifiedBlobAdmissionMode
} from "./verified-blob-admission.js";

export type { VerifiedBlobAdmissionMode } from "./verified-blob-admission.js";

export type VerifiedBlobKind = "unit" | "static";
export type VerifiedBlobResourceCategory = "verified-unit" | "verified-static";

export interface VerifiedBlobDescriptor {
  readonly key: string;
  readonly kind: VerifiedBlobKind;
  readonly byteLength: number;
}

export interface VerifiedBlobPersistentLease {
  release(): void;
}

export interface VerifiedBlobResourceHost {
  reserve(
    category: VerifiedBlobResourceCategory,
    byteLength: number
  ): VerifiedBlobPersistentLease | PromiseLike<VerifiedBlobPersistentLease>;
}

export interface VerifiedBlobLoadRequest extends VerifiedBlobDescriptor {
  readonly generation: number;
  readonly signal: AbortSignal;
  /** Select and settle the one storage admission before allocation or digest. */
  readonly admit: (mode: VerifiedBlobAdmissionMode) => Promise<void>;
  /** Must be passed directly to the verifier's synchronous promote callback. */
  readonly promote: (verified: Readonly<VerifiedSha256Input>) => void;
  /** @internal Complete-source-only zero-copy promotion capability. */
  readonly [PROMOTE_BORROWED_VERIFIED_BLOB]?: (
    verified: Readonly<VerifiedSha256Input>
  ) => void;
}

export type VerifiedBlobLoader = (
  request: Readonly<VerifiedBlobLoadRequest>
) =>
  | void
  | PromiseLike<void>;

export interface VerifiedBlobEnsureOptions {
  readonly signal?: AbortSignal;
  readonly load: VerifiedBlobLoader;
}

export interface VerifiedBlobHandle extends VerifiedBlobDescriptor {
  readonly generation: number;
}

export interface VerifiedBlobStoreSnapshot {
  readonly generation: number;
  readonly disposed: boolean;
  readonly verifiedBytes: number;
  /** Exact bytes still backed by independent verified-unit/static leases. */
  readonly persistentBytes: number;
  readonly persistentLeaseCount: number;
  /** Reserved copied-promotion capacity not yet backed by a published copy. */
  readonly admittedBytes: number;
  readonly admittedLeaseCount: number;
  readonly pendingAdmissionCount: number;
  readonly interestedWaiterCount: number;
  readonly pendingLoadCount: number;
  readonly unitBlobs: Readonly<RuntimeBlobResidencySnapshot>;
  readonly staticBlobs: Readonly<RuntimeBlobResidencySnapshot>;
}

export interface VerifiedBlobStoreOptions {
  readonly generation: number;
  readonly descriptors: readonly Readonly<VerifiedBlobDescriptor>[];
  readonly resources: VerifiedBlobResourceHost;
  readonly signal?: AbortSignal;
  readonly allocate?: (byteLength: number) => Uint8Array<ArrayBuffer>;
}

interface StoredBlob {
  readonly descriptor: Readonly<VerifiedBlobDescriptor>;
  readonly handle: Readonly<VerifiedBlobHandle>;
  load: BlobLoad | null;
  storage: VerifiedStorage | null;
}

interface VerifiedStorage {
  readonly bytes: Uint8Array<ArrayBuffer>;
  /** Null only for a verified view retained by one complete-source lease. */
  readonly lease: CapturedVerifiedBlobPersistentLease | null;
}

interface BlobLoad {
  readonly entry: StoredBlob;
  readonly ordinal: number;
  readonly controller: AbortController;
  readonly waiters: Set<BlobWaiter>;
  promotion: VerifiedStorage | null;
  admissionMode: VerifiedBlobAdmissionMode | null;
  admissionLease: CapturedVerifiedBlobPersistentLease | null;
  admissionOperation: Promise<void> | null;
  operation: Promise<void> | null;
}

interface BlobWaiter {
  readonly signal: AbortSignal | null;
  readonly abortListener: (() => void) | null;
  readonly resolve: (handle: Readonly<VerifiedBlobHandle>) => void;
  readonly reject: (cause: unknown) => void;
  settled: boolean;
}

export const PROMOTE_BORROWED_VERIFIED_BLOB: unique symbol = Symbol(
  "promote borrowed verified blob"
);

/** @internal Promote a verifier-issued view without exposing a raw borrow. */
export function promoteBorrowedVerifiedBlob(
  request: Readonly<VerifiedBlobLoadRequest>,
  verified: Readonly<VerifiedSha256Input>,
  source: Readonly<RuntimeCompleteSourceRange>
): void {
  try { assertLiveRuntimeCompleteSourceRange(source, verified.bytes); }
  catch { throw new Sha256IntegrityMismatchError(); }
  const promote = request[PROMOTE_BORROWED_VERIFIED_BLOB];
  if (promote === undefined) throw new Sha256IntegrityMismatchError();
  promote(verified);
}

/**
 * Generation-scoped authority for digest-verified encoded payload residency.
 * Its backing arrays never escape; only immutable handles and fresh copies do.
 */
export class VerifiedBlobStore {
  readonly #generation: number;
  readonly #entries: ReadonlyMap<string, StoredBlob>;
  readonly #resources: CapturedVerifiedBlobResourceHost;
  readonly #allocate: (byteLength: number) => Uint8Array<ArrayBuffer>;
  readonly #pendingLoads = new Set<Promise<void>>();
  readonly #pendingAdmissions = new Set<Promise<void>>();
  readonly #sessionSignal: AbortSignal | null;
  readonly #sessionAbortListener: (() => void) | null;

  #nextLoadOrdinal = 1;
  #disposed = false;
  #disposePromise: Promise<void> | null = null;

  public constructor(options: Readonly<VerifiedBlobStoreOptions>) {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("verified blob store options must be an object");
    }
    this.#generation = requireNonNegativeSafeInteger(
      options.generation,
      "verified blob generation"
    );
    this.#entries = captureDescriptors(options.descriptors, this.#generation);
    this.#resources = captureVerifiedBlobResourceHost(options.resources);
    this.#allocate = captureAllocator(options.allocate ?? allocateExactBytes);

    const sessionSignal = options.signal === undefined
      ? null
      : requireAbortSignal(options.signal);
    this.#sessionSignal = sessionSignal;
    if (sessionSignal === null || sessionSignal.aborted) {
      this.#sessionAbortListener = null;
      if (sessionSignal?.aborted === true) {
        this.#disposed = true;
        this.#disposePromise = Promise.resolve();
      }
    } else {
      const listener = (): void => {
        void this.dispose();
      };
      this.#sessionAbortListener = listener;
      try {
        sessionSignal.addEventListener("abort", listener, { once: true });
        if (sessionSignal.aborted) listener();
      } catch (error) {
        // Registration may attach and then throw. A failed constructor must
        // not leave the signal retaining this otherwise unreachable store.
        try { sessionSignal.removeEventListener("abort", listener); } catch {}
        throw error;
      }
    }
  }

  public state(key: string): RuntimeBlobResidencyState {
    const entry = this.#entry(key);
    if (entry.storage !== null) return "verified";
    if (entry.load !== null) return "loading";
    return "absent";
  }

  public ensure(
    key: string,
    options: Readonly<VerifiedBlobEnsureOptions>
  ): Promise<Readonly<VerifiedBlobHandle>> {
    const entry = this.#entry(key);
    if (typeof options !== "object" || options === null) {
      return Promise.reject(runtimeError("load-failure"));
    }
    const loader = captureLoader(options.load);
    const signal = options.signal === undefined
      ? null
      : requireAbortSignal(options.signal);
    if (this.#disposed || signal?.aborted === true) {
      return Promise.reject(abortError());
    }
    if (entry.storage !== null) return Promise.resolve(entry.handle);

    let load = entry.load;
    let start = false;
    if (load === null) {
      load = {
        entry,
        ordinal: this.#nextLoadOrdinal,
        controller: new AbortController(),
        waiters: new Set(),
        promotion: null,
        admissionMode: null,
        admissionLease: null,
        admissionOperation: null,
        operation: null
      };
      this.#nextLoadOrdinal += 1;
      entry.load = load;
      start = true;
    }
    const promise = this.#attachWaiter(load, signal);
    if (start && load.waiters.size > 0) this.#startLoad(load, loader);
    return promise;
  }

  /** Return one fresh exact copy; persistent backing ownership stays private. */
  public copy(key: string): Uint8Array<ArrayBuffer> {
    const storage = this.#requireVerifiedStorage(key);
    return copyExactRange(storage.bytes, 0, storage.bytes.byteLength);
  }

  /**
   * Allocate only the requested verified span. The transfer/PNG-copy lease is
   * deliberately charged by the caller that owns the returned allocation.
   */
  public copyRange(
    key: string,
    relativeOffset: number,
    byteLength: number
  ): Uint8Array<ArrayBuffer> {
    const storage = this.#requireVerifiedStorage(key);
    if (
      !Number.isSafeInteger(relativeOffset) ||
      !Number.isSafeInteger(byteLength) ||
      relativeOffset < 0 ||
      byteLength < 1 ||
      relativeOffset > storage.bytes.byteLength ||
      byteLength > storage.bytes.byteLength - relativeOffset
    ) {
      throw new RuntimePlaybackError(normalizeRuntimeFailure(
        "invalid-asset",
        undefined,
        {
          ...(Number.isSafeInteger(relativeOffset) && relativeOffset >= 0
            ? { offset: relativeOffset }
            : {}),
          ...(Number.isSafeInteger(byteLength) && byteLength >= 0
            ? { expectedBytes: byteLength }
            : {})
        }
      ));
    }
    return copyExactRange(storage.bytes, relativeOffset, byteLength);
  }

  /** @internal Synchronous, byte-free inspection over verified backing. */
  public inspectAvcRendition(
    plan: Readonly<BorrowedAvcRenditionPlan>
  ): ReturnType<typeof inspectBorrowedAvcRendition> {
    return inspectBorrowedAvcRendition(
      plan,
      (key, relativeOffset, byteLength) => this.#borrowRange(
        key,
        relativeOffset,
        byteLength
      )
    );
  }

  /** Eviction is legal only after the caller has retired external sample use. */
  public evict(key: string): boolean {
    const entry = this.#entry(key);
    if (entry.storage === null) return false;
    const storage = entry.storage;
    entry.storage = null;
    safeRelease(storage.lease);
    return true;
  }

  public snapshot(): Readonly<VerifiedBlobStoreSnapshot> {
    const unitBlobs = this.#residencySnapshot("unit");
    const staticBlobs = this.#residencySnapshot("static");
    let waiters = 0;
    let leaseCount = 0;
    let persistentBytes = 0;
    let admittedBytes = 0;
    let admittedLeaseCount = 0;
    for (const entry of this.#entries.values()) {
      const load = entry.load;
      waiters += load?.waiters.size ?? 0;
      if (load !== null && load.admissionLease !== null) {
        admittedLeaseCount += 1;
        admittedBytes += entry.descriptor.byteLength;
      }
      if (entry.storage !== null && entry.storage.lease !== null) {
        leaseCount += 1;
        persistentBytes += entry.descriptor.byteLength;
      }
      if (entry.load !== null && entry.load.promotion !== null &&
        entry.load.promotion.lease !== null) {
        leaseCount += 1;
        persistentBytes += entry.descriptor.byteLength;
      }
    }
    return Object.freeze({
      generation: this.#generation,
      disposed: this.#disposed,
      verifiedBytes: unitBlobs.verifiedBytes + staticBlobs.verifiedBytes,
      persistentBytes,
      persistentLeaseCount: leaseCount,
      admittedBytes,
      admittedLeaseCount,
      pendingAdmissionCount: this.#pendingAdmissions.size,
      interestedWaiterCount: waiters,
      pendingLoadCount: this.#pendingLoads.size,
      unitBlobs,
      staticBlobs
    });
  }

  public dispose(): Promise<void> {
    if (this.#disposePromise !== null) return this.#disposePromise;
    this.#disposed = true;
    this.#removeSessionAbortListener();

    for (const entry of this.#entries.values()) {
      if (entry.storage !== null) {
        const storage = entry.storage;
        entry.storage = null;
        safeRelease(storage.lease);
      }
      if (entry.load !== null) {
        const load = entry.load;
        entry.load = null;
        this.#abortLoad(load);
      }
    }

    const pending = [
      ...this.#pendingLoads,
      ...this.#pendingAdmissions
    ];
    this.#disposePromise = pending.length === 0
      ? Promise.resolve()
      : Promise.allSettled(pending).then(() => {});
    return this.#disposePromise;
  }

  #attachWaiter(
    load: BlobLoad,
    signal: AbortSignal | null
  ): Promise<Readonly<VerifiedBlobHandle>> {
    return new Promise((resolve, reject) => {
      let waiter!: BlobWaiter;
      const listener = signal === null
        ? null
        : (): void => {
            this.#abortWaiter(load, waiter);
          };
      waiter = {
        signal,
        abortListener: listener,
        resolve,
        reject,
        settled: false
      };
      load.waiters.add(waiter);
      if (signal !== null && listener !== null) {
        try {
          signal.addEventListener("abort", listener, { once: true });
        } catch {
          this.#settleWaiter(load, waiter, runtimeError("load-failure"));
          if (load.waiters.size === 0 && this.#isCurrentLoad(load)) {
            load.entry.load = null;
            try {
              load.controller.abort();
            } catch {
              // The empty record is already detached.
            }
          }
          return;
        }
        if (signal.aborted) this.#abortWaiter(load, waiter);
      }
    });
  }

  #startLoad(load: BlobLoad, loader: VerifiedBlobLoader): void {
    const descriptor = load.entry.descriptor;
    const request: Readonly<VerifiedBlobLoadRequest> = Object.freeze({
      ...descriptor,
      generation: this.#generation,
      signal: load.controller.signal,
      admit: (mode: VerifiedBlobAdmissionMode): Promise<void> =>
        this.#admitLoad(load, mode),
      promote: (verified: Readonly<VerifiedSha256Input>): void => {
        this.#promoteLoad(load, verified);
      },
      [PROMOTE_BORROWED_VERIFIED_BLOB]: (
        verified: Readonly<VerifiedSha256Input>
      ): void => {
        this.#promoteLoad(load, verified, true);
      }
    });
    const operation = Promise.resolve()
      .then(() => loader(request))
      .then(
        () => {
          this.#commitLoad(load);
        },
        (cause: unknown) => {
          this.#failLoad(load, normalizeLoaderFailure(cause));
        }
      );
    load.operation = operation;
    this.#pendingLoads.add(operation);
    void operation.then(
      () => {
        this.#pendingLoads.delete(operation);
      },
      () => {
        this.#pendingLoads.delete(operation);
      }
    );
  }

  #admitLoad(
    load: BlobLoad,
    mode: VerifiedBlobAdmissionMode
  ): Promise<void> {
    if (mode !== "copied" && mode !== "borrowed") {
      return Promise.reject(runtimeError("load-failure"));
    }
    if (!this.#isCurrentInterestedLoad(load)) {
      return Promise.reject(abortError());
    }
    const selected = load.admissionMode;
    if (selected === "borrowed" && mode === "copied") {
      return Promise.reject(runtimeError("load-failure"));
    }
    if (selected === "copied" && mode === "borrowed") {
      load.admissionMode = "borrowed";
      const lease = load.admissionLease;
      load.admissionLease = null;
      safeRelease(lease);
      const pending = load.admissionOperation;
      if (pending === null) return Promise.resolve();
      return pending.then(
        () => undefined,
        () => {
          if (!this.#isCurrentInterestedLoad(load)) throw abortError();
          if (load.admissionMode !== "borrowed") {
            throw runtimeError("load-failure");
          }
        }
      );
    }
    load.admissionMode = mode;
    if (mode === "borrowed") return Promise.resolve();
    if (load.admissionLease !== null) return Promise.resolve();
    if (load.admissionOperation !== null) return load.admissionOperation;

    const descriptor = load.entry.descriptor;
    const category: VerifiedBlobResourceCategory = descriptor.kind === "unit"
      ? "verified-unit"
      : "verified-static";
    const pending = Promise.resolve()
      .then(() => this.#resources.reserve(category, descriptor.byteLength))
      .then((rawLease) => {
        const lease = capturePersistentLease(rawLease);
        if (
          !this.#isCurrentInterestedLoad(load) ||
          load.admissionMode !== "copied" ||
          load.admissionLease !== null
        ) {
          safeRelease(lease);
          throw abortError();
        }
        load.admissionLease = lease;
      });
    load.admissionOperation = pending;
    this.#pendingAdmissions.add(pending);
    void pending.then(
      () => {
        this.#pendingAdmissions.delete(pending);
        if (load.admissionOperation === pending) {
          load.admissionOperation = null;
        }
      },
      () => {
        this.#pendingAdmissions.delete(pending);
        if (load.admissionOperation === pending) {
          load.admissionOperation = null;
        }
      }
    );
    return pending;
  }

  #promoteLoad(
    load: BlobLoad,
    verified: Readonly<VerifiedSha256Input>,
    borrowed = false
  ): void {
    try {
      const storage = consumeVerifiedSha256Input(verified, (input) =>
        borrowed
          ? this.#createBorrowedStorage(load, input)
          : this.#createPersistentStorage(load, input)
      );
      if (storage === null) return;
      if (!this.#isCurrentInterestedLoad(load)) {
        safeRelease(storage.lease);
        return;
      }
      if (load.promotion !== null) {
        safeRelease(storage.lease);
        throw new VerifiedBlobPromotionError("integrity-mismatch");
      }
      load.promotion = storage;
    } catch (cause) {
      if (!this.#isCurrentLoad(load)) return;
      throw normalizePromotionFailure(cause);
    }
  }

  #commitLoad(load: BlobLoad): void {
    if (!this.#isCurrentLoad(load)) {
      this.#releasePromotion(load);
      return;
    }
    const storage = load.promotion;
    if (storage === null) {
      this.#failLoad(load, runtimeError("integrity-mismatch"));
      return;
    }
    try {
      storage.lease?.markReclaimable();
    } catch {
      load.promotion = null;
      safeRelease(storage.lease);
      this.#failLoad(load, runtimeError("load-failure"));
      return;
    }
    load.promotion = null;
    load.entry.storage = storage;
    load.entry.load = null;
    if (load.operation !== null) this.#pendingLoads.delete(load.operation);
    for (const waiter of [...load.waiters]) {
      this.#settleWaiter(load, waiter, null, load.entry.handle);
    }
  }

  #createPersistentStorage(
    load: BlobLoad,
    input: Readonly<ConsumedVerifiedSha256Input>
  ): VerifiedStorage | null {
    const inputLease = capturePersistentLease(input.inputLease);
    try {
      if (!this.#isCurrentInterestedLoad(load)) return null;
      if (
        input.generation !== this.#generation ||
        !(input.bytes instanceof Uint8Array) ||
        !(input.bytes.buffer instanceof ArrayBuffer) ||
        input.bytes.byteOffset !== 0 ||
        input.bytes.byteLength !== load.entry.descriptor.byteLength ||
        input.bytes.buffer.byteLength !== load.entry.descriptor.byteLength
      ) {
        throw new VerifiedBlobPromotionError("integrity-mismatch");
      }

      const descriptor = load.entry.descriptor;
      if (load.admissionMode !== "copied" || load.admissionOperation !== null) {
        throw new VerifiedBlobPromotionError("load-failure");
      }
      const lease = load.admissionLease;
      if (lease === null) throw new VerifiedBlobPromotionError("load-failure");
      load.admissionLease = null;
      try {
        if (!this.#isCurrentInterestedLoad(load)) throw new StaleBlobLoadError();
        const bytes = allocateAndValidate(this.#allocate, descriptor.byteLength);
        Uint8Array.prototype.set.call(bytes, input.bytes, 0);
        if (!this.#isCurrentInterestedLoad(load)) throw new StaleBlobLoadError();
        return Object.freeze({ bytes, lease });
      } catch (cause) {
        safeRelease(lease);
        if (cause instanceof StaleBlobLoadError) return null;
        if (cause instanceof VerifiedBlobPromotionError) throw cause;
        if (isRuntimePlaybackError(cause)) throw cause;
        throw new VerifiedBlobPromotionError("load-failure");
      }
    } finally {
      safeRelease(inputLease);
    }
  }

  #createBorrowedStorage(
    load: BlobLoad,
    input: Readonly<ConsumedVerifiedSha256Input>
  ): VerifiedStorage | null {
    const inputLease = capturePersistentLease(input.inputLease);
    try {
      if (!this.#isCurrentInterestedLoad(load)) return null;
      if (
        load.admissionMode !== "borrowed" ||
        load.admissionLease !== null ||
        load.admissionOperation !== null
      ) {
        throw new VerifiedBlobPromotionError("load-failure");
      }
      if (
        input.generation !== this.#generation ||
        !(input.bytes instanceof Uint8Array) ||
        !(input.bytes.buffer instanceof ArrayBuffer) ||
        input.bytes.byteLength !== load.entry.descriptor.byteLength
      ) {
        throw new VerifiedBlobPromotionError("integrity-mismatch");
      }
      return Object.freeze({
        bytes: input.bytes as Uint8Array<ArrayBuffer>,
        lease: null
      });
    } finally {
      safeRelease(inputLease);
    }
  }

  #failLoad(load: BlobLoad, cause: unknown): void {
    if (!this.#isCurrentLoad(load)) return;
    this.#releasePromotion(load);
    load.entry.load = null;
    if (load.operation !== null) this.#pendingLoads.delete(load.operation);
    for (const waiter of [...load.waiters]) {
      this.#settleWaiter(load, waiter, cause);
    }
  }

  #abortWaiter(load: BlobLoad, waiter: BlobWaiter): void {
    if (waiter.settled) return;
    this.#settleWaiter(load, waiter, abortError());
    if (load.waiters.size !== 0 || !this.#isCurrentLoad(load)) return;
    load.entry.load = null;
    this.#releasePromotion(load);
    try {
      load.controller.abort();
    } catch {
      // The record is already detached and cannot publish.
    }
  }

  #abortLoad(load: BlobLoad): void {
    this.#releasePromotion(load);
    try {
      load.controller.abort();
    } catch {
      // Waiters still retire below.
    }
    for (const waiter of [...load.waiters]) {
      this.#settleWaiter(load, waiter, abortError());
    }
  }

  #releasePromotion(load: BlobLoad): void {
    const storage = load.promotion;
    load.promotion = null;
    if (storage !== null) safeRelease(storage.lease);
    const admission = load.admissionLease;
    load.admissionLease = null;
    safeRelease(admission);
  }

  #settleWaiter(
    load: BlobLoad,
    waiter: BlobWaiter,
    cause: unknown | null,
    handle?: Readonly<VerifiedBlobHandle>
  ): void {
    if (waiter.settled) return;
    waiter.settled = true;
    load.waiters.delete(waiter);
    if (waiter.signal !== null && waiter.abortListener !== null) {
      try {
        waiter.signal.removeEventListener("abort", waiter.abortListener);
      } catch {
        // Continue settlement without retaining local waiter authority.
      }
    }
    if (cause === null && handle !== undefined) waiter.resolve(handle);
    else waiter.reject(cause ?? runtimeError("load-failure"));
  }

  #isCurrentLoad(load: BlobLoad): boolean {
    return !this.#disposed && load.entry.load === load;
  }

  #isCurrentInterestedLoad(load: BlobLoad): boolean {
    return this.#isCurrentLoad(load) && load.waiters.size > 0;
  }

  #entry(key: string): StoredBlob {
    if (typeof key !== "string") {
      throw new TypeError("verified blob key must be a string");
    }
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      throw new RuntimePlaybackError(normalizeRuntimeFailure("invalid-asset"));
    }
    return entry;
  }

  #requireVerifiedStorage(key: string): VerifiedStorage {
    const entry = this.#entry(key);
    if (this.#disposed || entry.storage === null) {
      throw new RuntimePlaybackError(normalizeRuntimeFailure(
        this.#disposed ? "disposed" : "load-failure"
      ));
    }
    return entry.storage;
  }

  #borrowRange(
    key: string,
    relativeOffset: number,
    byteLength: number
  ): Uint8Array {
    const storage = this.#requireVerifiedStorage(key);
    if (
      !Number.isSafeInteger(relativeOffset) ||
      !Number.isSafeInteger(byteLength) ||
      relativeOffset < 0 ||
      byteLength < 1 ||
      relativeOffset > storage.bytes.byteLength ||
      byteLength > storage.bytes.byteLength - relativeOffset
    ) {
      throw new RuntimePlaybackError(normalizeRuntimeFailure("invalid-asset"));
    }
    return storage.bytes.subarray(
      relativeOffset,
      relativeOffset + byteLength
    );
  }

  #residencySnapshot(
    kind: VerifiedBlobKind
  ): Readonly<RuntimeBlobResidencySnapshot> {
    let total = 0;
    let absent = 0;
    let loading = 0;
    let verified = 0;
    let verifiedBytes = 0;
    for (const entry of this.#entries.values()) {
      if (entry.descriptor.kind !== kind) continue;
      total += 1;
      if (entry.storage !== null) {
        verified += 1;
        verifiedBytes += entry.descriptor.byteLength;
      } else if (entry.load !== null) {
        loading += 1;
      } else {
        absent += 1;
      }
    }
    return Object.freeze({ total, absent, loading, verified, verifiedBytes });
  }

  #removeSessionAbortListener(): void {
    if (this.#sessionSignal === null || this.#sessionAbortListener === null) return;
    try {
      this.#sessionSignal.removeEventListener(
        "abort",
        this.#sessionAbortListener
      );
    } catch {
      // Local session ownership is terminal regardless of host cleanup failure.
    }
  }
}

function captureDescriptors(
  values: readonly Readonly<VerifiedBlobDescriptor>[],
  generation: number
): ReadonlyMap<string, StoredBlob> {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError("verified blob descriptors must be a non-empty array");
  }
  const entries = new Map<string, StoredBlob>();
  let totalBytes = 0;
  for (const value of values) {
    if (typeof value !== "object" || value === null) {
      throw new TypeError("verified blob descriptor must be an object");
    }
    const key = value.key;
    if (typeof key !== "string" || key.length === 0 || key.length > 256) {
      throw new TypeError("verified blob key is invalid");
    }
    if (value.kind !== "unit" && value.kind !== "static") {
      throw new TypeError("verified blob kind is invalid");
    }
    const byteLength = requirePositiveSafeInteger(
      value.byteLength,
      "verified blob byte length"
    );
    totalBytes += byteLength;
    if (
      !Number.isSafeInteger(totalBytes) ||
      byteLength > FORMAT_DEFAULT_BUDGETS.maxFileBytes ||
      totalBytes > FORMAT_DEFAULT_BUDGETS.maxFileBytes
    ) {
      throw new RangeError("verified blob descriptors exceed the file limit");
    }
    if (entries.has(key)) throw new TypeError("verified blob key is duplicated");
    const descriptor: Readonly<VerifiedBlobDescriptor> = Object.freeze({
      key,
      kind: value.kind,
      byteLength
    });
    const handle: Readonly<VerifiedBlobHandle> = Object.freeze({
      ...descriptor,
      generation
    });
    entries.set(key, { descriptor, handle, load: null, storage: null });
  }
  return entries;
}

function captureLoader(value: VerifiedBlobLoader): VerifiedBlobLoader {
  if (typeof value !== "function") {
    throw new TypeError("verified blob loader must be a function");
  }
  return (request) => Reflect.apply(value, undefined, [request]) as
    | void
    | PromiseLike<void>;
}

function captureAllocator(
  value: (byteLength: number) => Uint8Array<ArrayBuffer>
): (byteLength: number) => Uint8Array<ArrayBuffer> {
  if (typeof value !== "function") {
    throw new TypeError("verified blob allocator must be a function");
  }
  return (byteLength) => Reflect.apply(value, undefined, [byteLength]) as
    Uint8Array<ArrayBuffer>;
}

function allocateExactBytes(byteLength: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(byteLength));
}

function copyExactRange(
  source: Uint8Array<ArrayBuffer>,
  offset: number,
  byteLength: number
): Uint8Array<ArrayBuffer> {
  let copy: Uint8Array<ArrayBuffer>;
  try {
    copy = new Uint8Array(new ArrayBuffer(byteLength));
  } catch {
    throw new RuntimePlaybackError(normalizeRuntimeFailure(
      "resource-rejection",
      undefined,
      { expectedBytes: byteLength }
    ));
  }
  Uint8Array.prototype.set.call(
    copy,
    source.subarray(offset, offset + byteLength),
    0
  );
  return copy;
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
    throw new VerifiedBlobPromotionError("load-failure");
  }
  return bytes;
}

function requireAbortSignal(value: AbortSignal): AbortSignal {
  if (!(value instanceof AbortSignal)) {
    throw new TypeError("verified blob signal must be an AbortSignal");
  }
  return value;
}

function requirePositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function requireNonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function safeRelease(lease: VerifiedBlobPersistentLease | null): void {
  if (lease === null) return;
  try {
    lease.release();
  } catch {
    // Continue complete store cleanup without masking the primary outcome.
  }
}
