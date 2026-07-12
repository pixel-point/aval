import type {
  BlobAssemblyLease,
  BlobAssemblyResourceHost
} from "./blob-assembly.js";
import type {
  BoundedBodyByteLease,
  BoundedBodyByteResourceHost
} from "./bounded-body-reader.js";
import type {
  RuntimeByteCategory,
  RuntimeByteLease,
  RuntimeCategoryBytesSnapshot
} from "./model.js";
import {
  RuntimePlaybackError,
  normalizeRuntimeFailure
} from "./errors.js";
import type {
  AvcCandidateResourceAuthority,
  AvcCandidateResourcePlanLease
} from "./avc-candidate-factory-model.js";
import { PageDecoderLeases } from "./page-decoder-leases.js";
import type { PlayerResourceAdmission } from "./player-resource-admission.js";
import {
  PlayerResourceAccount,
  refreshPlayerAutomaticReclaimablePublication,
  reclassifyPlayerResourceLease,
  setPlayerResourceLeaseReclaimable,
  snapshotPlayerResourceCategories
} from "./player-resource-account.js";
import {
  createRuntimeResourceCategoryPlan
} from "./resource-category-plan.js";
import type { RuntimeResourceAllocationSnapshot } from "./resource-plan.js";
import type {
  StaticSurfaceStoreResourceHost,
  StaticSurfaceStoreResourceLease,
  StaticSurfaceStoreSurfaceRole
} from "./static-surface-store-resources.js";
import type {
  BrowserStaticDecoderResourceCategory,
  BrowserStaticDecoderResourceHost,
  BrowserStaticDecoderResourceLease
} from "./strict-static-decoder.js";
import type {
  VerifiedBlobPersistentLease,
  VerifiedBlobResourceCategory,
  VerifiedBlobResourceHost
} from "./verified-blob-store.js";
import { MARK_VERIFIED_BLOB_RECLAIMABLE } from
  "./verified-blob-resources.js";

export type PlayerBodyResourceCategory =
  | "asset-metadata"
  | "response-body"
  | "quarantine";

export interface RuntimeResourcePlanLeaseSnapshot {
  readonly released: boolean;
  readonly totalBytes: number;
  readonly categories: readonly Readonly<RuntimeCategoryBytesSnapshot>[];
}

export interface RuntimeResourcePlanLease
extends AvcCandidateResourcePlanLease {
  snapshot(): Readonly<RuntimeResourcePlanLeaseSnapshot>;
  assertAllocation(
    allocation: Readonly<RuntimeResourceAllocationSnapshot>
  ): void;
  release(): void;
}

export { createPlayerCanvasBackingResourceHost } from
  "./player-canvas-backing-host.js";

/** Bind one bounded response-body owner to its exact accounting category. */
export function createPlayerBodyResourceHost(
  account: PlayerResourceAccount,
  categoryValue: PlayerBodyResourceCategory,
  admission?: Readonly<PlayerResourceAdmission>
): BoundedBodyByteResourceHost {
  const category = requireBodyCategory(categoryValue);
  if (admission !== undefined) {
    const reserve = captureAdmissionReserve(admission);
    return Object.freeze({
      reserve: (byteLength: number) => reserve(category, byteLength)
    });
  }
  const reserve = captureAccountReserve(account);
  return Object.freeze({
    reserve(byteLength: number): BoundedBodyByteLease {
      return reserve(category, byteLength);
    }
  });
}

/** Retained full bodies begin quarantined and promote only after validation. */
export function createPlayerFullBodyResourceHost(
  account: PlayerResourceAccount,
  admission?: Readonly<PlayerResourceAdmission>
): BoundedBodyByteResourceHost {
  if (admission !== undefined) {
    const reserve = captureAdmissionReserve(admission);
    return Object.freeze({
      async reserve(byteLength: number): Promise<BoundedBodyByteLease> {
        return createPromotableFullLease(
          account,
          await reserve("quarantine", byteLength)
        );
      }
    });
  }
  const reserve = captureAccountReserve(account);
  return Object.freeze({
    reserve(byteLength: number): BoundedBodyByteLease {
      return createPromotableFullLease(
        account,
        reserve("quarantine", byteLength)
      );
    }
  });
}

/** BlobAssembly allocates only quarantine destinations in this category. */
export function createPlayerBlobAssemblyResourceHost(
  account: PlayerResourceAccount,
  admission?: Readonly<PlayerResourceAdmission>
): BlobAssemblyResourceHost {
  if (admission !== undefined) {
    const reserve = captureAdmissionReserve(admission);
    return Object.freeze({
      reserve: (byteLength: number) => reserve("blob-assembly", byteLength)
    });
  }
  const reserve = captureAccountReserve(account);
  return Object.freeze({
    reserve(byteLength: number): BlobAssemblyLease {
      return reserve("blob-assembly", byteLength);
    }
  });
}

/** Persistent verified bytes remain split between unit and static ownership. */
export function createPlayerVerifiedBlobResourceHost(
  account: PlayerResourceAccount,
  admission?: Readonly<PlayerResourceAdmission>
): VerifiedBlobResourceHost {
  if (admission !== undefined) {
    const reserve = captureAdmissionReserve(admission);
    return Object.freeze({
      async reserve(
        category: VerifiedBlobResourceCategory,
        byteLength: number
      ) {
        const lease = await reserve(
          requireVerifiedCategory(category),
          byteLength,
          { reclaimable: false }
        );
        return createVerifiedBlobLease(account, lease);
      }
    });
  }
  const reserve = captureAccountReserve(account);
  return Object.freeze({
    reserve(
      category: VerifiedBlobResourceCategory,
      byteLength: number
    ): VerifiedBlobPersistentLease {
      const lease = reserve(requireVerifiedCategory(category), byteLength);
      try { setPlayerResourceLeaseReclaimable(account, lease, false); }
      catch (error) {
        lease.release();
        throw error;
      }
      return createVerifiedBlobLease(account, lease);
    }
  });
}

function createVerifiedBlobLease(
  account: PlayerResourceAccount,
  lease: RuntimeByteLease
): VerifiedBlobPersistentLease {
  let released = false;
  let reclaimable = false;
  return Object.freeze({
    [MARK_VERIFIED_BLOB_RECLAIMABLE](): void {
      if (released) throw new Error("verified blob resource lease is released");
      if (reclaimable) return;
      setPlayerResourceLeaseReclaimable(account, lease, true);
      reclaimable = true;
    },
    release(): void {
      if (released) return;
      released = true;
      lease.release();
    }
  });
}

function createPromotableFullLease(
  account: PlayerResourceAccount,
  byteLease: RuntimeByteLease
): BoundedBodyByteLease {
  let released = false;
  let promoted = false;
  return Object.freeze({
    promoteToAssetFull(): void {
      if (released) {
        throw new Error("full body resource lease is released");
      }
      if (promoted) return;
      reclassifyPlayerResourceLease(account, byteLease, "asset-full");
      promoted = true;
    },
    release(): void {
      if (released) return;
      released = true;
      byteLease.release();
    }
  });
}

/** Account one decoded surface under its exact current/incoming/cache role. */
export function createPlayerStaticSurfaceResourceHost(
  account: PlayerResourceAccount,
  admission?: Readonly<PlayerResourceAdmission>
): StaticSurfaceStoreResourceHost {
  const touch = captureAccountTouch(account);
  const refreshReclaimable = captureStaticReclaimableRefresh(account);
  if (admission !== undefined) {
    const reserve = captureAdmissionReserve(admission);
    return Object.freeze({
      async reserveDecodedSurface(input: Readonly<{
        staticFrame: string;
        byteLength: number;
        role: "incoming";
      }>): Promise<StaticSurfaceStoreResourceLease> {
        validateStaticSurfaceReservation(input);
        return createStaticSurfaceResourceLease(
          account,
          await reserve("incoming-static-surface", input.byteLength),
          refreshReclaimable
        );
      },
      nextTouchSequence(): number {
        return touch().lastTouchSequence;
      }
    });
  }
  const reserve = captureAccountReserve(account);
  return Object.freeze({
    reserveDecodedSurface(input: Readonly<{
      staticFrame: string;
      byteLength: number;
      role: "incoming";
    }>): StaticSurfaceStoreResourceLease {
      validateStaticSurfaceReservation(input);
      return createStaticSurfaceResourceLease(
        account,
        reserve("incoming-static-surface", input.byteLength),
        refreshReclaimable
      );
    },
    nextTouchSequence(): number {
      return touch().lastTouchSequence;
    }
  });
}

function validateStaticSurfaceReservation(input: Readonly<{
  readonly staticFrame: string;
  readonly byteLength: number;
  readonly role: "incoming";
}>): void {
  if (input === null || typeof input !== "object") {
    throw new TypeError("decoded static surface reservation is malformed");
  }
  if (
    typeof input.staticFrame !== "string" ||
    input.staticFrame.length < 1 ||
    input.role !== "incoming"
  ) {
    throw new TypeError("decoded static surface reservation is invalid");
  }
}

function createStaticSurfaceResourceLease(
  account: PlayerResourceAccount,
  byteLease: RuntimeByteLease,
  refreshReclaimable: () => void
): StaticSurfaceStoreResourceLease {
  let role: StaticSurfaceStoreSurfaceRole = "incoming";
  let released = false;
  return Object.freeze({
    setRole(nextRole: StaticSurfaceStoreSurfaceRole): void {
      if (released) {
        throw new Error("static surface resource lease is released");
      }
      const category = staticSurfaceRoleCategory(nextRole);
      if (nextRole === role) return;
      reclassifyPlayerResourceLease(account, byteLease, category);
      role = nextRole;
      refreshReclaimable();
    },
    release(): void {
      if (released) return;
      released = true;
      byteLease.release();
      refreshReclaimable();
    }
  });
}

function captureStaticReclaimableRefresh(
  account: PlayerResourceAccount
): () => void {
  const update = account.updateStatus;
  if (typeof update !== "function") {
    throw new TypeError("player resource account status capability is missing");
  }
  return (): void => {
    try {
      if (refreshPlayerAutomaticReclaimablePublication(account)) return;
      const bytes = snapshotPlayerResourceCategories(account).find(
        ({ category }) => category === "decoded-static-cache"
      )?.bytes ?? 0;
      Reflect.apply(update, account, [{
        reclaimable: bytes === 0
          ? Object.freeze([])
          : Object.freeze([Object.freeze({
              category: "decoded-static-cache" as const,
              bytes
            })])
      }]);
    } catch (error) {
      const snapshot = account.snapshot();
      if (snapshot.disposed || snapshot.participant === null) return;
      throw error;
    }
  };
}

/** Bind strict PNG copy/zlib/scratch lifetimes to their actual decoder owner. */
export function createPlayerStaticDecoderResourceHost(
  account: PlayerResourceAccount,
  admission?: Readonly<PlayerResourceAdmission>
): BrowserStaticDecoderResourceHost {
  if (admission !== undefined) {
    const reserve = captureAdmissionReserve(admission);
    return Object.freeze({
      reserve(
        category: BrowserStaticDecoderResourceCategory,
        byteLength: number
      ): Promise<BrowserStaticDecoderResourceLease> {
        if (
          category !== "png-copy" &&
          category !== "png-zlib" &&
          category !== "png-scratch"
        ) {
          throw new TypeError("static decoder resource category is invalid");
        }
        return reserve(category, byteLength);
      }
    });
  }
  const reserve = captureAccountReserve(account);
  return Object.freeze({
    reserve(
      category: BrowserStaticDecoderResourceCategory,
      byteLength: number
    ): BrowserStaticDecoderResourceLease {
      if (
        category !== "png-copy" &&
        category !== "png-zlib" &&
        category !== "png-scratch"
      ) {
        throw new TypeError("static decoder resource category is invalid");
      }
      return reserve(category, byteLength);
    }
  });
}

/** Bind candidate admission to one account and the page FIFO decoder owner. */
export function createPlayerCandidateResourceAuthority(
  account: PlayerResourceAccount,
  decoders: PageDecoderLeases,
  admission?: Readonly<PlayerResourceAdmission>
): AvcCandidateResourceAuthority {
  const assertGeneration = captureAccountGenerationGuard(account);
  if (!(decoders instanceof PageDecoderLeases)) {
    throw new TypeError("candidate resource authority requires decoder leases");
  }
  const readAccount = account.snapshot;
  const requestDecoder = decoders.request;
  if (typeof readAccount !== "function" || typeof requestDecoder !== "function") {
    throw new TypeError("candidate resource authority is malformed");
  }
  return Object.freeze({
    reservePlan(
      allocation: Readonly<RuntimeResourceAllocationSnapshot>
    ): RuntimeResourcePlanLease | Promise<RuntimeResourcePlanLease> {
      assertGeneration();
      return admission === undefined
        ? reserveCandidateRuntimeResources(account, allocation)
        : reserveCandidateRuntimeResourcesWithAdmission(
            account,
            allocation,
            admission
          );
    },
    requestDecoder() {
      assertGeneration();
      const snapshot = readAccount.call(account);
      const participant = snapshot.participant;
      if (participant === null) {
        throw new RuntimePlaybackError(normalizeRuntimeFailure("disposed"));
      }
      return requestDecoder.call(
        decoders,
        snapshot.participantId,
        participant.generation
      );
    }
  });
}

/**
 * Reserve a frozen M6/M7 candidate peak transactionally before constructing
 * any worker, decoder, CPU array, GPU store, surface, or canvas backing.
 */
export function reserveRuntimeResourcePlan(
  account: PlayerResourceAccount,
  allocation: Readonly<RuntimeResourceAllocationSnapshot>
): RuntimeResourcePlanLease {
  const reserve = captureAccountReserve(account);
  const plan = createRuntimeResourceCategoryPlan(allocation);
  const leases: RuntimeByteLease[] = [];
  try {
    for (const entry of plan.entries) {
      leases.push(reserve(entry.category, entry.bytes));
    }
  } catch (error) {
    releaseReverse(leases);
    throw error;
  }

  let released = false;
  const transferClaims = createWorkerTransferClaims(
    allocation.maximumEncodedWindowBytes
  );
  const categories = Object.freeze(plan.entries.map((entry) =>
    Object.freeze({ category: entry.category, bytes: entry.bytes })
  ));
  return Object.freeze({
    snapshot(): Readonly<RuntimeResourcePlanLeaseSnapshot> {
      return Object.freeze({ released, totalBytes: plan.totalBytes, categories });
    },
    assertAllocation(
      allocationSnapshot: Readonly<RuntimeResourceAllocationSnapshot>
    ): void {
      const expected = createRuntimeResourceCategoryPlan(allocationSnapshot);
      if (
        released ||
        expected.totalBytes !== plan.totalBytes ||
        !sameCategoryEntries(expected.entries, plan.entries) ||
        leases.length !== plan.entries.length
      ) {
        throw resourceInvariantError();
      }
      for (let index = 0; index < leases.length; index += 1) {
        const lease = leases[index]!;
        const entry = plan.entries[index]!;
        const snapshot = lease.snapshot();
        if (
          snapshot.released ||
          snapshot.category !== entry.category ||
          snapshot.bytes !== entry.bytes
        ) {
          throw resourceInvariantError();
        }
      }
    },
    claimWorkerTransfer(byteLength: number) {
      if (released) throw resourceInvariantError();
      return transferClaims.claim(byteLength);
    },
    release(): void {
      if (released) return;
      released = true;
      transferClaims.releaseAll();
      releaseReverse(leases);
    }
  });
}

/** Reserve only animation owners; loader/static/canvas owners lease themselves. */
function reserveCandidateRuntimeResources(
  account: PlayerResourceAccount,
  allocation: Readonly<RuntimeResourceAllocationSnapshot>
): RuntimeResourcePlanLease {
  const reserve = captureAccountReserve(account);
  const plan = createRuntimeResourceCategoryPlan(allocation);
  const target = categoryMap(plan.entries);
  const leases: Array<Readonly<{
    category: RuntimeByteCategory;
    bytes: number;
    lease: RuntimeByteLease;
  }>> = [];
  assertAccountWithinPlan(account, plan.entries, plan.totalBytes);
  try {
    const before = categoryMap(snapshotPlayerResourceCategories(account));
    for (const category of CANDIDATE_PLAN_CATEGORIES) {
      if ((before.get(category) ?? 0) !== 0) throw resourceInvariantError();
      const bytes = target.get(category) ?? 0;
      if (bytes === 0) continue;
      leases.push(Object.freeze({
        category,
        bytes,
        lease: reserve(category, bytes)
      }));
    }
    assertCandidateLeases(leases);
    assertAccountWithinPlan(account, plan.entries, plan.totalBytes);
  } catch (error) {
    releaseCandidateLeases(leases);
    throw error;
  }

  let released = false;
  const categories = freezeCategoryEntries(plan.entries);
  const transferClaims = createWorkerTransferClaims(
    allocation.maximumEncodedWindowBytes
  );
  return Object.freeze({
    snapshot(): Readonly<RuntimeResourcePlanLeaseSnapshot> {
      return Object.freeze({ released, totalBytes: plan.totalBytes, categories });
    },
    assertAllocation(
      allocationSnapshot: Readonly<RuntimeResourceAllocationSnapshot>
    ): void {
      const expected = createRuntimeResourceCategoryPlan(allocationSnapshot);
      if (
        released ||
        expected.totalBytes !== plan.totalBytes ||
        !sameCategoryEntries(expected.entries, plan.entries)
      ) {
        throw resourceInvariantError();
      }
      assertCandidateLeases(leases);
      assertAccountWithinPlan(account, plan.entries, plan.totalBytes);
    },
    claimWorkerTransfer(byteLength: number) {
      if (released) throw resourceInvariantError();
      return transferClaims.claim(byteLength);
    },
    release(): void {
      if (released) return;
      released = true;
      transferClaims.releaseAll();
      releaseCandidateLeases(leases);
    }
  });
}

async function reserveCandidateRuntimeResourcesWithAdmission(
  account: PlayerResourceAccount,
  allocation: Readonly<RuntimeResourceAllocationSnapshot>,
  admission: Readonly<PlayerResourceAdmission>
): Promise<RuntimeResourcePlanLease> {
  const reserve = captureAdmissionReserve(admission);
  const plan = createRuntimeResourceCategoryPlan(allocation);
  const target = categoryMap(plan.entries);
  const leases: Array<Readonly<{
    category: RuntimeByteCategory;
    bytes: number;
    lease: RuntimeByteLease;
  }>> = [];
  assertAccountWithinPlan(account, plan.entries, plan.totalBytes);
  try {
    const before = categoryMap(snapshotPlayerResourceCategories(account));
    for (const category of CANDIDATE_PLAN_CATEGORIES) {
      if ((before.get(category) ?? 0) !== 0) throw resourceInvariantError();
      const bytes = target.get(category) ?? 0;
      if (bytes === 0) continue;
      leases.push(Object.freeze({
        category,
        bytes,
        lease: await reserve(category, bytes)
      }));
    }
    assertCandidateLeases(leases);
    assertAccountWithinPlan(account, plan.entries, plan.totalBytes);
  } catch (error) {
    releaseCandidateLeases(leases);
    throw error;
  }

  let released = false;
  const categories = freezeCategoryEntries(plan.entries);
  const transferClaims = createWorkerTransferClaims(
    allocation.maximumEncodedWindowBytes
  );
  return Object.freeze({
    snapshot(): Readonly<RuntimeResourcePlanLeaseSnapshot> {
      return Object.freeze({ released, totalBytes: plan.totalBytes, categories });
    },
    assertAllocation(
      allocationSnapshot: Readonly<RuntimeResourceAllocationSnapshot>
    ): void {
      const expected = createRuntimeResourceCategoryPlan(allocationSnapshot);
      if (
        released ||
        expected.totalBytes !== plan.totalBytes ||
        !sameCategoryEntries(expected.entries, plan.entries)
      ) {
        throw resourceInvariantError();
      }
      assertCandidateLeases(leases);
      assertAccountWithinPlan(account, plan.entries, plan.totalBytes);
    },
    claimWorkerTransfer(byteLength: number) {
      if (released) throw resourceInvariantError();
      return transferClaims.claim(byteLength);
    },
    release(): void {
      if (released) return;
      released = true;
      transferClaims.releaseAll();
      releaseCandidateLeases(leases);
    }
  });
}

const ASSET_OWNERSHIP_CATEGORIES: readonly RuntimeByteCategory[] = Object.freeze([
  "asset-metadata",
  "asset-full",
  "verified-unit",
  "verified-static"
]);

const CANDIDATE_PLAN_CATEGORIES: readonly RuntimeByteCategory[] = Object.freeze([
  "worker-transfer",
  "decoder-output",
  "persistent-animation",
  "streaming-texture",
  "frame-staging"
]);

const DIRECT_PLAN_CATEGORIES: readonly RuntimeByteCategory[] = Object.freeze([
  ...CANDIDATE_PLAN_CATEGORIES,
  "png-copy",
  "png-zlib",
  "png-scratch",
  "animated-canvas-backing",
  "static-canvas-backing"
]);

const UNPLANNED_LIVE_CATEGORIES: readonly RuntimeByteCategory[] = Object.freeze([
  "response-body",
  "quarantine",
  "blob-assembly"
]);

function assertAccountWithinPlan(
  account: PlayerResourceAccount,
  entries: readonly Readonly<RuntimeCategoryBytesSnapshot>[],
  totalBytes: number
): void {
  const snapshot = snapshotPlayerResourceCategories(account);
  const live = categoryMap(snapshot);
  const target = categoryMap(entries);
  if (creditedPlanBytes(live, "asset-full") > (target.get("asset-full") ?? 0)) {
    throw resourceInvariantError();
  }
  for (const category of DIRECT_PLAN_CATEGORIES) {
    if ((live.get(category) ?? 0) > (target.get(category) ?? 0)) {
      throw resourceInvariantError();
    }
  }
  const surfaceBytes = (live.get("current-static-surface") ?? 0) +
    (live.get("incoming-static-surface") ?? 0);
  const surfaceTarget = (target.get("current-static-surface") ?? 0) +
    (target.get("incoming-static-surface") ?? 0);
  if (surfaceBytes > surfaceTarget) {
    throw resourceInvariantError();
  }
  for (const category of UNPLANNED_LIVE_CATEGORIES) {
    if ((live.get(category) ?? 0) !== 0) {
      throw resourceInvariantError();
    }
  }
  // Optional decoded statics are page-managed LRU residency outside the
  // candidate's guaranteed current/incoming peak. Their authentic leases are
  // bounded and reclaimed by the page policy, not reserved by this candidate.
  const optionalStaticBytes = live.get("decoded-static-cache") ?? 0;
  const liveTotal = snapshot.reduce((total, { bytes }) => total + bytes, 0) -
    optionalStaticBytes;
  if (liveTotal > totalBytes) throw resourceInvariantError();
}

function creditedPlanBytes(
  account: ReadonlyMap<RuntimeByteCategory, number>,
  category: RuntimeByteCategory
): number {
  if (category !== "asset-full") return account.get(category) ?? 0;
  return ASSET_OWNERSHIP_CATEGORIES.reduce(
    (total, assetCategory) => total + (account.get(assetCategory) ?? 0),
    0
  );
}

function categoryMap(
  entries: readonly Readonly<RuntimeCategoryBytesSnapshot>[]
): Map<RuntimeByteCategory, number> {
  return new Map(entries.map(({ category, bytes }) => [category, bytes]));
}

function freezeCategoryEntries(
  entries: readonly Readonly<RuntimeCategoryBytesSnapshot>[]
): readonly Readonly<RuntimeCategoryBytesSnapshot>[] {
  return Object.freeze(entries.map((entry) => Object.freeze({
    category: entry.category,
    bytes: entry.bytes
  })));
}

function assertCandidateLeases(
  leases: readonly Readonly<{
    category: RuntimeByteCategory;
    bytes: number;
    lease: RuntimeByteLease;
  }>[]
): void {
  for (const entry of leases) {
    const snapshot = entry.lease.snapshot();
    if (
      snapshot.released ||
      snapshot.category !== entry.category ||
      snapshot.bytes !== entry.bytes
    ) {
      throw resourceInvariantError();
    }
  }
}

function releaseCandidateLeases(
  leases: Array<Readonly<{ readonly lease: RuntimeByteLease }>>
): void {
  for (let index = leases.length - 1; index >= 0; index -= 1) {
    try {
      leases[index]!.lease.release();
    } catch {
      // Terminal accounting continues through a hostile release.
    }
  }
  leases.length = 0;
}

function createWorkerTransferClaims(maximumBytes: number): Readonly<{
  claim(byteLength: number): Readonly<{ release(): void }>;
  releaseAll(): void;
}> {
  let claimedBytes = 0;
  const active = new Set<{ bytes: number; released: boolean }>();
  return Object.freeze({
    claim(byteLength: number): Readonly<{ release(): void }> {
      if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
        throw new RangeError("worker transfer claim must be positive and safe");
      }
      if (byteLength > maximumBytes - claimedBytes) {
        throw resourceInvariantError();
      }
      const record = { bytes: byteLength, released: false };
      active.add(record);
      claimedBytes += byteLength;
      return Object.freeze({
        release(): void {
          if (record.released) return;
          record.released = true;
          if (active.delete(record)) claimedBytes -= record.bytes;
        }
      });
    },
    releaseAll(): void {
      for (const record of active) record.released = true;
      active.clear();
      claimedBytes = 0;
    }
  });
}

function sameCategoryEntries(
  left: readonly Readonly<RuntimeCategoryBytesSnapshot>[],
  right: readonly Readonly<RuntimeCategoryBytesSnapshot>[]
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return other !== undefined &&
      entry.category === other.category &&
      entry.bytes === other.bytes;
  });
}

function resourceInvariantError(): RuntimePlaybackError {
  return new RuntimePlaybackError(normalizeRuntimeFailure(
    "resource-rejection",
    "runtime resource allocation diverged from its admitted plan"
  ));
}

function captureAccountReserve(
  account: PlayerResourceAccount
): (category: RuntimeByteCategory, bytes: number) => RuntimeByteLease {
  if (!(account instanceof PlayerResourceAccount)) {
    throw new TypeError("player resource host requires a player account");
  }
  const reserve = account.reserve;
  if (typeof reserve !== "function") {
    throw new TypeError("player resource account reserve capability is missing");
  }
  const assertGeneration = captureAccountGenerationGuard(account);
  return (category, bytes) => {
    assertGeneration();
    return reserve.call(account, category, bytes);
  };
}

function captureAdmissionReserve(
  admission: Readonly<PlayerResourceAdmission>
): (
  category: RuntimeByteCategory,
  bytes: number,
  options?: Readonly<{ readonly reclaimable?: boolean }>
) => Promise<RuntimeByteLease> {
  if (admission === null || typeof admission !== "object") {
    throw new TypeError("player resource admission is malformed");
  }
  let reserve: unknown;
  try { reserve = Reflect.get(admission, "reserve"); } catch {
    throw new TypeError("player resource admission is inaccessible");
  }
  if (typeof reserve !== "function") {
    throw new TypeError("player resource admission reserve capability is missing");
  }
  return async (category, bytes, options) => {
    const lease = await Promise.resolve(Reflect.apply(
      reserve,
      admission,
      [category, bytes, ...(options === undefined ? [] : [options])]
    ) as RuntimeByteLease | PromiseLike<RuntimeByteLease>);
    if (lease === null || typeof lease !== "object" ||
      typeof lease.release !== "function") {
      throw new TypeError("player resource admission returned an invalid lease");
    }
    return lease;
  };
}

function captureAccountTouch(
  account: PlayerResourceAccount
): () => Readonly<ReturnType<PlayerResourceAccount["touch"]>> {
  if (!(account instanceof PlayerResourceAccount)) {
    throw new TypeError("player resource host requires a player account");
  }
  const touch = account.touch;
  if (typeof touch !== "function") {
    throw new TypeError("player resource account touch capability is missing");
  }
  const assertGeneration = captureAccountGenerationGuard(account);
  return () => {
    assertGeneration();
    return touch.call(account);
  };
}

function captureAccountGenerationGuard(
  account: PlayerResourceAccount
): () => void {
  const initial = account.snapshot().participant;
  if (initial === null) {
    throw new RuntimePlaybackError(normalizeRuntimeFailure("disposed"));
  }
  const generation = initial.generation;
  return (): void => {
    const current = account.snapshot().participant;
    if (current === null) {
      throw new RuntimePlaybackError(normalizeRuntimeFailure("disposed"));
    }
    if (current.generation !== generation) {
      throw new RuntimePlaybackError(normalizeRuntimeFailure(
        "abort",
        undefined,
        { generation, operation: "stale-resource-generation" }
      ));
    }
  };
}

function staticSurfaceRoleCategory(
  role: StaticSurfaceStoreSurfaceRole
): RuntimeByteCategory {
  switch (role) {
    case "current": return "current-static-surface";
    case "incoming": return "incoming-static-surface";
    case "optional": return "decoded-static-cache";
    default:
      throw new TypeError("static surface resource role is invalid");
  }
}

function requireBodyCategory(
  value: PlayerBodyResourceCategory
): PlayerBodyResourceCategory {
  if (
    value !== "asset-metadata" &&
    value !== "response-body" &&
    value !== "quarantine"
  ) {
    throw new RangeError("player body resource category is invalid");
  }
  return value;
}

function requireVerifiedCategory(
  value: VerifiedBlobResourceCategory
): VerifiedBlobResourceCategory {
  if (value !== "verified-unit" && value !== "verified-static") {
    throw new RangeError("verified blob resource category is invalid");
  }
  return value;
}

function releaseReverse(leases: RuntimeByteLease[]): void {
  for (let index = leases.length - 1; index >= 0; index -= 1) {
    try {
      leases[index]!.release();
    } catch {
      // Rollback/terminal accounting continues through a hostile release.
    }
  }
  leases.length = 0;
}
