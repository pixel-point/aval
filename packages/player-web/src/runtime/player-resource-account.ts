import {
  RuntimePlaybackError,
  normalizeRuntimeFailure
} from "./errors.js";
import type {
  RuntimeByteCategory,
  RuntimeByteLease,
  RuntimeByteLeaseSnapshot,
  RuntimeCategoryBytesSnapshot,
  RuntimeParticipantId,
  RuntimeParticipantState
} from "./model.js";
import { RUNTIME_BYTE_CATEGORIES } from "./model.js";
import {
  PageResourceManager,
  assertPageResourceByteLeaseOwner,
  reclassifyPageResourceByteLease,
  shrinkPageResourceByteLease,
  type RuntimeParticipantRegistration,
  type RuntimeParticipantStatusUpdate
} from "./page-resource-manager.js";

interface PlayerLeaseBridgeRecord {
  readonly account: PlayerResourceAccount;
  readonly manager: PageResourceManager;
  readonly managerLease: RuntimeByteLease;
}

const PLAYER_LEASE_BRIDGES = new WeakMap<object, PlayerLeaseBridgeRecord>();
const PLAYER_ACCOUNT_BRIDGES = new WeakMap<
  PlayerResourceAccount,
  {
    readonly manager: PageResourceManager;
    adopt(lease: RuntimeByteLease, reclaimable: boolean): RuntimeByteLease;
    categories(): readonly Readonly<RuntimeCategoryBytesSnapshot>[];
    setLeaseReclaimable(lease: RuntimeByteLease, reclaimable: boolean): void;
    retainReclaimableCategories(
      categories: readonly RuntimeByteCategory[]
    ): () => void;
    refreshAutomaticReclaimable(): boolean;
    retireGeneration(): number;
  }
>();

export interface PlayerResourceAccountSnapshot {
  readonly participantId: RuntimeParticipantId;
  readonly activeLeaseCount: number;
  readonly disposed: boolean;
  readonly participant: Readonly<RuntimeParticipantState> | null;
}

export interface RuntimeLeasedAllocation<Value> {
  readonly value: Value;
  readonly lease: RuntimeByteLease;
}

/** Player-owned facade over one opaque page-manager participant. */
export class PlayerResourceAccount {
  public readonly participantId: RuntimeParticipantId;
  readonly #manager: PageResourceManager;
  readonly #leases = new Set<RuntimeByteLease>();
  readonly #unreclaimableLeases = new Set<RuntimeByteLease>();
  readonly #reclaimableCategoryReferences = new Map<RuntimeByteCategory, number>();
  #managedReclaimablePublication = false;
  #disposed = false;

  public constructor(
    manager: PageResourceManager,
    registration: Readonly<RuntimeParticipantRegistration> = {}
  ) {
    if (!(manager instanceof PageResourceManager)) {
      throw new TypeError("player resource account requires a page manager");
    }
    this.#manager = manager;
    this.participantId = manager.registerParticipant(registration);
    PLAYER_ACCOUNT_BRIDGES.set(this, {
      manager,
      adopt: (lease, reclaimable) =>
        this.#adoptManagerLease(lease, reclaimable),
      categories: () => this.#categorySnapshot(),
      setLeaseReclaimable: (lease, reclaimable) =>
        this.#setLeaseReclaimable(lease, reclaimable),
      retainReclaimableCategories: (categories) =>
        this.#retainReclaimableCategories(categories),
      refreshAutomaticReclaimable: () =>
        this.#refreshAutomaticReclaimable(),
      retireGeneration: () => this.#retireGeneration()
    });
  }

  public reserve(
    category: RuntimeByteCategory,
    bytes: number
  ): RuntimeByteLease {
    this.#throwIfDisposed();
    const managerLease = this.#manager.reserve(this.participantId, category, bytes);
    try {
      return this.#adoptManagerLease(managerLease, true);
    } catch (error) {
      managerLease.release();
      throw error;
    }
  }

  /** Reserve first; rollback automatically if the synchronous allocation fails. */
  public reserveForAllocation<Value>(
    category: RuntimeByteCategory,
    bytes: number,
    allocate: () => Value
  ): Readonly<RuntimeLeasedAllocation<Value>> {
    if (typeof allocate !== "function") {
      throw new TypeError("resource allocation callback must be a function");
    }
    const lease = this.reserve(category, bytes);
    try {
      const value = allocate();
      return Object.freeze({ value, lease });
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  public touch(): Readonly<RuntimeParticipantState> {
    this.#throwIfDisposed();
    return this.#manager.touchParticipant(this.participantId);
  }

  public updateStatus(
    update: Readonly<RuntimeParticipantStatusUpdate>
  ): Readonly<RuntimeParticipantState> {
    this.#throwIfDisposed();
    return this.#manager.updateParticipant(this.participantId, update);
  }

  public snapshot(): Readonly<PlayerResourceAccountSnapshot> {
    this.#pruneReleasedLeases();
    return Object.freeze({
      participantId: this.participantId,
      activeLeaseCount: this.#leases.size,
      disposed: this.#disposed,
      participant: this.#disposed
        ? null
        : this.#manager.tryParticipantSnapshot(this.participantId)
    });
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const lease of [...this.#leases]) {
      lease.release();
    }
    this.#leases.clear();
    this.#unreclaimableLeases.clear();
    this.#manager.disposeParticipant(this.participantId);
  }

  #pruneReleasedLeases(): void {
    for (const lease of this.#leases) {
      if (lease.snapshot().released) this.#leases.delete(lease);
    }
  }

  #adoptManagerLease(
    managerLease: RuntimeByteLease,
    reclaimable: boolean
  ): RuntimeByteLease {
    this.#throwIfDisposed();
    assertPageResourceByteLeaseOwner(
      this.#manager,
      managerLease,
      this.participantId
    );
    const snapshot = managerLease.snapshot();
    if (snapshot.released || snapshot.participantId !== this.participantId) {
      throw new TypeError("page resource lease belongs to another participant");
    }
    let released = false;
    let facade!: RuntimeByteLease;
    const lease = Object.freeze({
      snapshot: (): Readonly<RuntimeByteLeaseSnapshot> => managerLease.snapshot(),
      resize: (nextBytes: number): Promise<void> => managerLease.resize(nextBytes),
      release: (): void => {
        if (released) return;
        released = true;
        try {
          managerLease.release();
        } finally {
          this.#leases.delete(facade);
          this.#unreclaimableLeases.delete(facade);
          try { this.#refreshAutomaticReclaimable(); } catch {
            // Manager lease retirement remains terminal if status publication
            // races account or page disposal.
          }
        }
      }
    });
    facade = lease as unknown as RuntimeByteLease;
    PLAYER_LEASE_BRIDGES.set(lease, {
      account: this,
      manager: this.#manager,
      managerLease
    });
    this.#leases.add(facade);
    if (!reclaimable) this.#unreclaimableLeases.add(facade);
    try {
      this.#refreshAutomaticReclaimable();
    } catch (error) {
      try { facade.release(); } catch {}
      throw error;
    }
    return facade;
  }

  #retireGeneration(): number {
    this.#throwIfDisposed();
    const leases = [...this.#leases];
    for (const lease of leases) lease.release();
    this.#pruneReleasedLeases();
    return leases.length;
  }

  #setLeaseReclaimable(lease: RuntimeByteLease, reclaimable: boolean): void {
    this.#throwIfDisposed();
    if (!this.#leases.has(lease) || lease.snapshot().released) {
      throw new TypeError("player byte lease is not live in this account");
    }
    if (reclaimable) this.#unreclaimableLeases.delete(lease);
    else this.#unreclaimableLeases.add(lease);
    this.#refreshAutomaticReclaimable();
  }

  #refreshAutomaticReclaimable(): boolean {
    if (!this.#managedReclaimablePublication) return false;
    if (this.#disposed) return true;
    const reclaimable = Object.freeze(
      this.#categorySnapshot(true).filter(({ category }) =>
        this.#reclaimableCategoryReferences.has(category)
      )
    );
    this.#manager.updateParticipant(this.participantId, { reclaimable });
    return true;
  }

  #retainReclaimableCategories(
    categories: readonly RuntimeByteCategory[]
  ): () => void {
    this.#throwIfDisposed();
    this.#managedReclaimablePublication = true;
    for (const category of categories) {
      this.#reclaimableCategoryReferences.set(
        category,
        (this.#reclaimableCategoryReferences.get(category) ?? 0) + 1
      );
    }
    this.#refreshAutomaticReclaimable();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      for (const category of categories) {
        const count = this.#reclaimableCategoryReferences.get(category) ?? 0;
        if (count <= 1) this.#reclaimableCategoryReferences.delete(category);
        else this.#reclaimableCategoryReferences.set(category, count - 1);
      }
      try { this.#refreshAutomaticReclaimable(); } catch {
        // Account disposal already terminalizes manager status.
      }
    };
  }

  #throwIfDisposed(): void {
    if (this.#disposed) {
      throw new RuntimePlaybackError(normalizeRuntimeFailure("disposed"));
    }
  }

  #categorySnapshot(
    reclaimableOnly = false
  ): readonly Readonly<RuntimeCategoryBytesSnapshot>[] {
    const grouped = new Map<RuntimeByteCategory, number>();
    for (const lease of this.#leases) {
      if (reclaimableOnly && this.#unreclaimableLeases.has(lease)) continue;
      const snapshot = lease.snapshot();
      if (snapshot.released || snapshot.bytes === 0) continue;
      grouped.set(
        snapshot.category,
        (grouped.get(snapshot.category) ?? 0) + snapshot.bytes
      );
    }
    return Object.freeze(RUNTIME_BYTE_CATEGORIES.flatMap((category) => {
      const bytes = grouped.get(category) ?? 0;
      return bytes === 0 ? [] : [Object.freeze({ category, bytes })];
    }));
  }
}

/** Internal composition bridge; deliberately absent from the package index. */
export function reclassifyPlayerResourceLease(
  account: PlayerResourceAccount,
  lease: RuntimeByteLease,
  category: RuntimeByteCategory
): void {
  if (!(account instanceof PlayerResourceAccount)) {
    throw new TypeError("lease reclassification requires a player account");
  }
  if (lease === null || typeof lease !== "object") {
    throw new TypeError("player byte lease capability is not authentic");
  }
  const bridge = PLAYER_LEASE_BRIDGES.get(lease);
  if (bridge === undefined || bridge.account !== account) {
    throw new TypeError("player byte lease belongs to another account");
  }
  reclassifyPageResourceByteLease(
    bridge.manager,
    bridge.managerLease,
    category
  );
  PLAYER_ACCOUNT_BRIDGES.get(account)?.refreshAutomaticReclaimable();
}

/** Internal observation bridge; deliberately absent from the package index. */
export function snapshotPlayerResourceCategories(
  account: PlayerResourceAccount
): readonly Readonly<RuntimeCategoryBytesSnapshot>[] {
  if (!(account instanceof PlayerResourceAccount)) {
    throw new TypeError("resource category snapshot requires a player account");
  }
  const bridge = PLAYER_ACCOUNT_BRIDGES.get(account);
  if (bridge === undefined) {
    throw new TypeError("player resource account bridge is unavailable");
  }
  return bridge.categories();
}

/** Internal adoption bridge for manager-approved async reclamation leases. */
export function adoptPlayerResourceLease(
  account: PlayerResourceAccount,
  manager: PageResourceManager,
  lease: RuntimeByteLease,
  reclaimable = true
): RuntimeByteLease {
  if (!(account instanceof PlayerResourceAccount)) {
    throw new TypeError("resource lease adoption requires a player account");
  }
  if (!(manager instanceof PageResourceManager)) {
    throw new TypeError("resource lease adoption requires a page manager");
  }
  if (lease === null || typeof lease !== "object") {
    throw new TypeError("resource lease adoption requires an authentic lease");
  }
  if (typeof reclaimable !== "boolean") {
    throw new TypeError("resource lease reclaimable state must be boolean");
  }
  const bridge = PLAYER_ACCOUNT_BRIDGES.get(account);
  if (bridge === undefined || bridge.manager !== manager) {
    throw new TypeError("player account belongs to another page manager");
  }
  try {
    return bridge.adopt(lease, reclaimable);
  } catch (error) {
    try { lease.release(); } catch {}
    throw error;
  }
}

/** Internal exact-publication bridge for a lease whose owner just published. */
export function setPlayerResourceLeaseReclaimable(
  account: PlayerResourceAccount,
  lease: RuntimeByteLease,
  reclaimable: boolean
): void {
  if (!(account instanceof PlayerResourceAccount)) {
    throw new TypeError("lease publication requires a player account");
  }
  if (lease === null || typeof lease !== "object") {
    throw new TypeError("player byte lease capability is not authentic");
  }
  if (typeof reclaimable !== "boolean") {
    throw new TypeError("lease publication state must be boolean");
  }
  const record = PLAYER_LEASE_BRIDGES.get(lease);
  if (record === undefined || record.account !== account) {
    throw new TypeError("player byte lease belongs to another account");
  }
  const bridge = PLAYER_ACCOUNT_BRIDGES.get(account);
  if (bridge === undefined) {
    throw new TypeError("player resource account bridge is unavailable");
  }
  bridge.setLeaseReclaimable(lease, reclaimable);
}

/** Internal generation kill switch; keeps the page participant registered. */
export function retirePlayerResourceGeneration(
  account: PlayerResourceAccount
): number {
  if (!(account instanceof PlayerResourceAccount)) {
    throw new TypeError("resource generation retirement requires a player account");
  }
  const bridge = PLAYER_ACCOUNT_BRIDGES.get(account);
  if (bridge === undefined) {
    throw new TypeError("player resource account bridge is unavailable");
  }
  return bridge.retireGeneration();
}

/** Declare exact categories one registered owner can actually retire. */
export function retainPlayerReclaimableCategories(
  account: PlayerResourceAccount,
  categories: readonly RuntimeByteCategory[]
): () => void {
  if (!(account instanceof PlayerResourceAccount)) {
    throw new TypeError("reclaimable publication requires a player account");
  }
  if (!Array.isArray(categories)) {
    throw new TypeError("reclaimable categories must be an array");
  }
  const captured = Object.freeze(categories.map((category) => {
    if (!RUNTIME_BYTE_CATEGORIES.includes(category)) {
      throw new TypeError("reclaimable byte category is invalid");
    }
    return category;
  }));
  const bridge = PLAYER_ACCOUNT_BRIDGES.get(account);
  if (bridge === undefined) {
    throw new TypeError("player resource account bridge is unavailable");
  }
  return bridge.retainReclaimableCategories(captured);
}

/** Internal host bridge: true means the account published the full category set. */
export function refreshPlayerAutomaticReclaimablePublication(
  account: PlayerResourceAccount
): boolean {
  if (!(account instanceof PlayerResourceAccount)) {
    throw new TypeError("automatic reclamation refresh requires a player account");
  }
  const bridge = PLAYER_ACCOUNT_BRIDGES.get(account);
  if (bridge === undefined) {
    throw new TypeError("player resource account bridge is unavailable");
  }
  return bridge.refreshAutomaticReclaimable();
}

/** Internal synchronous negative-delta bridge; absent from package exports. */
export function shrinkPlayerResourceLease(
  account: PlayerResourceAccount,
  lease: RuntimeByteLease,
  nextBytes: number
): void {
  if (!(account instanceof PlayerResourceAccount)) {
    throw new TypeError("lease shrink requires a player account");
  }
  if (lease === null || typeof lease !== "object") {
    throw new TypeError("player byte lease capability is not authentic");
  }
  const bridge = PLAYER_LEASE_BRIDGES.get(lease);
  if (bridge === undefined || bridge.account !== account) {
    throw new TypeError("player byte lease belongs to another account");
  }
  shrinkPageResourceByteLease(
    bridge.manager,
    bridge.managerLease,
    nextBytes
  );
  PLAYER_ACCOUNT_BRIDGES.get(account)?.refreshAutomaticReclaimable();
}
