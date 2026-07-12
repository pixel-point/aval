import {
  RuntimePlaybackError,
  normalizeRuntimeFailure
} from "./errors.js";
import {
  RUNTIME_BYTE_CATEGORIES,
  type RuntimeByteCategory,
  type RuntimeByteLease,
  type RuntimeByteLeaseId,
  type RuntimeByteLeaseSnapshot,
  type RuntimeCategoryBytesSnapshot,
  type RuntimePageResourcePolicy,
  type RuntimePageResourceSnapshot,
  type RuntimeParticipantId,
  type RuntimeParticipantPhase,
  type RuntimeParticipantState,
  type RuntimeParticipantVisibility
} from "./model.js";
import {
  DEFAULT_MAXIMUM_DECODER_LEASES,
  DEFAULT_MAXIMUM_PAGE_PHYSICAL_BYTES,
  DEFAULT_MAXIMUM_PLAYER_LOGICAL_BYTES,
  createRuntimePageResourcePolicy
} from "./page-resource-policy.js";

const CATEGORY_SET: ReadonlySet<string> = new Set(RUNTIME_BYTE_CATEGORIES);
const REGISTRATION_FIELDS: ReadonlySet<string> = new Set([
  "generation",
  "visibility",
  "phase",
  "reclaimable"
]);
const STATUS_FIELDS = REGISTRATION_FIELDS;
const RECLAIMABLE_FIELDS: ReadonlySet<string> = new Set([
  "category",
  "bytes"
]);
const VISIBILITIES: ReadonlySet<string> = new Set(["visible", "hidden"]);
const PHASES: ReadonlySet<string> = new Set([
  "loading",
  "preparing",
  "animated",
  "static",
  "suspended"
]);

export interface RuntimeParticipantRegistration {
  readonly generation?: number;
  readonly visibility?: RuntimeParticipantVisibility;
  readonly phase?: RuntimeParticipantPhase;
  readonly reclaimable?: readonly Readonly<RuntimeCategoryBytesSnapshot>[];
}

export interface RuntimeParticipantStatusUpdate {
  readonly generation?: number;
  readonly visibility?: RuntimeParticipantVisibility;
  readonly phase?: RuntimeParticipantPhase;
  readonly reclaimable?: readonly Readonly<RuntimeCategoryBytesSnapshot>[];
}

export interface RuntimePageResourceCounterContribution {
  readonly decoderLeaseCount: number;
  readonly decoderQueueLength: number;
  readonly pendingReclamations: number;
}

export interface RuntimePageResourceCounterContributor {
  resourceCounters(): Readonly<RuntimePageResourceCounterContribution>;
}

interface ResourceCounterRegistry {
  readonly contributors: Map<
    number,
    () => Readonly<RuntimePageResourceCounterContribution>
  >;
  nextId: number;
  closed: boolean;
}

interface ResourceAccountingBridge {
  assertOwner(
    lease: RuntimeByteLease,
    participantId: RuntimeParticipantId
  ): void;
  reclassify(
    lease: RuntimeByteLease,
    category: RuntimeByteCategory
  ): void;
  shrink(lease: RuntimeByteLease, nextBytes: number): void;
}

const RESOURCE_COUNTER_REGISTRIES = new WeakMap<
  PageResourceManager,
  ResourceCounterRegistry
>();
const RESOURCE_ACCOUNTING_BRIDGES = new WeakMap<
  PageResourceManager,
  ResourceAccountingBridge
>();

interface ParticipantRecord {
  readonly id: RuntimeParticipantId;
  readonly leases: Set<number>;
  readonly categoryBytes: Map<RuntimeByteCategory, number>;
  readonly reclaimable: Map<RuntimeByteCategory, number>;
  generation: number;
  visibility: RuntimeParticipantVisibility;
  phase: RuntimeParticipantPhase;
  lastTouchSequence: number;
  logicalBytes: number;
}

interface ByteLeaseRecord {
  readonly id: RuntimeByteLeaseId;
  readonly participantId: RuntimeParticipantId;
  category: RuntimeByteCategory;
  bytes: number;
  released: boolean;
}

/**
 * One page-wide authority for physical bytes and per-player logical bytes.
 * Decoder tickets and reclamation are composed in the following M7 slice.
 */
export class PageResourceManager {
  readonly #policy: Readonly<RuntimePageResourcePolicy>;
  readonly #participants = new Map<number, ParticipantRecord>();
  readonly #retiredParticipants = new Set<number>();
  readonly #leases = new Map<number, ByteLeaseRecord>();
  readonly #leaseCapabilities = new WeakMap<object, ByteLeaseRecord>();
  readonly #categoryBytes = new Map<RuntimeByteCategory, number>();
  #physicalBytes = 0;
  #nextParticipantId = 0;
  #nextLeaseId = 0;
  #touchSequence = 0;
  #disposed = false;

  public constructor(
    policy: Readonly<RuntimePageResourcePolicy> =
      createRuntimePageResourcePolicy()
  ) {
    this.#policy = capturePolicy(policy);
    RESOURCE_COUNTER_REGISTRIES.set(this, {
      contributors: new Map(),
      nextId: 0,
      closed: false
    });
    RESOURCE_ACCOUNTING_BRIDGES.set(this, {
      assertOwner: (lease, participantId) => {
        this.#assertLeaseOwner(lease, participantId);
      },
      reclassify: (lease, category) => {
        this.#reclassifyLease(lease, category);
      },
      shrink: (lease, nextBytes) => {
        this.#shrinkLease(lease, nextBytes);
      }
    });
    for (const category of RUNTIME_BYTE_CATEGORIES) {
      this.#categoryBytes.set(category, 0);
    }
  }

  public registerParticipant(
    input: Readonly<RuntimeParticipantRegistration> = {}
  ): RuntimeParticipantId {
    this.#throwIfDisposed();
    validateExactObject(input, REGISTRATION_FIELDS, "participant registration");
    const generation = requireGeneration(input.generation ?? 1);
    const visibility = requireVisibility(input.visibility ?? "visible");
    const phase = requirePhase(input.phase ?? "loading");
    const reclaimable = validateReclaimable(input.reclaimable ?? [], new Map());
    const nextId = checkedIncrement(
      this.#nextParticipantId,
      "page participant ID"
    );
    const nextTouch = checkedIncrement(this.#touchSequence, "page touch sequence");
    const id = nextId as RuntimeParticipantId;
    const record: ParticipantRecord = {
      id,
      generation,
      visibility,
      phase,
      lastTouchSequence: nextTouch,
      logicalBytes: 0,
      leases: new Set(),
      categoryBytes: new Map(),
      reclaimable
    };

    this.#participants.set(nextId, record);
    this.#nextParticipantId = nextId;
    this.#touchSequence = nextTouch;
    return id;
  }

  public reserve(
    participantId: RuntimeParticipantId,
    categoryValue: RuntimeByteCategory,
    bytesValue: number
  ): RuntimeByteLease {
    this.#throwIfDisposed();
    const participant = this.#requireParticipant(participantId);
    const category = requireCategory(categoryValue);
    const bytes = requirePositiveBytes(bytesValue, "reserved bytes");
    const nextParticipantBytes = checkedSum(
      participant.logicalBytes,
      bytes,
      "participant logical bytes"
    );
    const nextPageBytes = checkedSum(
      this.#physicalBytes,
      bytes,
      "page physical bytes"
    );
    this.#assertFits(participant, bytes, nextParticipantBytes, nextPageBytes);

    const nextLeaseId = checkedIncrement(this.#nextLeaseId, "byte lease ID");
    const record: ByteLeaseRecord = {
      id: nextLeaseId as RuntimeByteLeaseId,
      participantId: participant.id,
      category,
      bytes,
      released: false
    };
    // Construct the entire capability before changing any accounting state.
    const lease = this.#createLease(record);

    this.#nextLeaseId = nextLeaseId;
    this.#leases.set(nextLeaseId, record);
    participant.leases.add(nextLeaseId);
    participant.logicalBytes = nextParticipantBytes;
    participant.categoryBytes.set(
      category,
      checkedSum(
        participant.categoryBytes.get(category) ?? 0,
        bytes,
        "participant category bytes"
      )
    );
    this.#physicalBytes = nextPageBytes;
    this.#categoryBytes.set(
      category,
      checkedSum(
        this.#categoryBytes.get(category) ?? 0,
        bytes,
        "page category bytes"
      )
    );
    return lease;
  }

  public participantSnapshot(
    participantId: RuntimeParticipantId
  ): Readonly<RuntimeParticipantState> {
    return snapshotParticipant(this.#requireParticipant(participantId));
  }

  public tryParticipantSnapshot(
    participantId: RuntimeParticipantId
  ): Readonly<RuntimeParticipantState> | null {
    const id = requireOpaqueId(participantId, "participant ID");
    const participant = this.#participants.get(id);
    return participant === undefined ? null : snapshotParticipant(participant);
  }

  public touchParticipant(
    participantId: RuntimeParticipantId
  ): Readonly<RuntimeParticipantState> {
    this.#throwIfDisposed();
    const participant = this.#requireParticipant(participantId);
    const sequence = checkedIncrement(this.#touchSequence, "page touch sequence");
    participant.lastTouchSequence = sequence;
    this.#touchSequence = sequence;
    return snapshotParticipant(participant);
  }

  public updateParticipant(
    participantId: RuntimeParticipantId,
    update: Readonly<RuntimeParticipantStatusUpdate>
  ): Readonly<RuntimeParticipantState> {
    this.#throwIfDisposed();
    const participant = this.#requireParticipant(participantId);
    validateExactObject(update, STATUS_FIELDS, "participant status update");
    const generation = requireGeneration(update.generation ?? participant.generation);
    if (generation < participant.generation) {
      throw new RangeError("participant generation cannot move backwards");
    }
    const visibility = requireVisibility(update.visibility ?? participant.visibility);
    const phase = requirePhase(update.phase ?? participant.phase);
    const reclaimable = update.reclaimable === undefined
      ? new Map(participant.reclaimable)
      : validateReclaimable(update.reclaimable, participant.categoryBytes);
    const sequence = checkedIncrement(this.#touchSequence, "page touch sequence");

    participant.generation = generation;
    participant.visibility = visibility;
    participant.phase = phase;
    participant.reclaimable.clear();
    for (const [category, bytes] of reclaimable) {
      participant.reclaimable.set(category, bytes);
    }
    participant.lastTouchSequence = sequence;
    this.#touchSequence = sequence;
    return snapshotParticipant(participant);
  }

  public disposeParticipant(participantId: RuntimeParticipantId): void {
    const id = requireOpaqueId(participantId, "participant ID");
    const participant = this.#participants.get(id);
    if (participant === undefined) {
      if (this.#disposed || this.#retiredParticipants.has(id)) return;
      throw new RangeError("participant ID is not registered");
    }

    for (const leaseId of [...participant.leases]) {
      const lease = this.#leases.get(leaseId);
      if (lease !== undefined) this.#releaseLease(lease);
    }
    participant.reclaimable.clear();
    this.#participants.delete(id);
    this.#retiredParticipants.add(id);
  }

  public snapshot(): Readonly<RuntimePageResourceSnapshot> {
    const contributed = this.#contributedResourceCounters();
    const categories = Object.freeze(RUNTIME_BYTE_CATEGORIES.map((category) =>
      Object.freeze({
        category,
        bytes: this.#categoryBytes.get(category) ?? 0
      })
    ));
    const participants = Object.freeze(
      [...this.#participants.values()]
        .sort((left, right) => Number(left.id) - Number(right.id))
        .map(snapshotParticipant)
    );
    return Object.freeze({
      policy: this.#policy,
      physicalBytes: this.#physicalBytes,
      byteLeaseCount: this.#leases.size,
      decoderLeaseCount: contributed.decoderLeaseCount,
      decoderQueueLength: contributed.decoderQueueLength,
      pendingReclamations: contributed.pendingReclamations,
      touchSequence: this.#touchSequence,
      categories,
      participants
    });
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const registry = requireCounterRegistry(this);
    registry.closed = true;
    registry.contributors.clear();
    for (const participant of [...this.#participants.values()]) {
      this.disposeParticipant(participant.id);
    }
  }

  #createLease(record: ByteLeaseRecord): RuntimeByteLease {
    const lease = Object.freeze({
      snapshot: (): Readonly<RuntimeByteLeaseSnapshot> =>
        snapshotLease(record),
      resize: (nextBytes: number): Promise<void> =>
        this.#resizeLease(record, nextBytes),
      release: (): void => {
        this.#releaseLease(record);
      }
    });
    const capability = lease as unknown as RuntimeByteLease;
    this.#leaseCapabilities.set(lease, record);
    return capability;
  }

  #reclassifyLease(
    lease: RuntimeByteLease,
    categoryValue: RuntimeByteCategory
  ): void {
    if (lease === null || typeof lease !== "object") {
      throw new TypeError("byte lease capability is not authentic");
    }
    const record = this.#leaseCapabilities.get(lease);
    if (record === undefined) {
      throw new TypeError("byte lease capability belongs to another manager");
    }
    if (
      record.released ||
      this.#disposed ||
      this.#leases.get(Number(record.id)) !== record
    ) {
      throw disposedError();
    }
    const category = requireCategory(categoryValue);
    if (category === record.category) return;
    const participant = this.#participants.get(Number(record.participantId));
    if (participant === undefined) throw disposedError();

    const previous = record.category;
    const participantPrevious = participant.categoryBytes.get(previous) ?? 0;
    const pagePrevious = this.#categoryBytes.get(previous) ?? 0;
    if (record.bytes > participantPrevious || record.bytes > pagePrevious) {
      throw new RangeError("page resource accounting underflowed");
    }
    const participantNext = checkedSum(
      participant.categoryBytes.get(category) ?? 0,
      record.bytes,
      "participant category bytes"
    );
    const pageNext = checkedSum(
      this.#categoryBytes.get(category) ?? 0,
      record.bytes,
      "page category bytes"
    );

    const remainingParticipant = participantPrevious - record.bytes;
    if (remainingParticipant === 0) participant.categoryBytes.delete(previous);
    else participant.categoryBytes.set(previous, remainingParticipant);
    participant.categoryBytes.set(category, participantNext);
    this.#categoryBytes.set(previous, pagePrevious - record.bytes);
    this.#categoryBytes.set(category, pageNext);
    record.category = category;
    clampReclaimable(participant, previous);
  }

  #assertLeaseOwner(
    lease: RuntimeByteLease,
    participantId: RuntimeParticipantId
  ): void {
    if (lease === null || typeof lease !== "object") {
      throw new TypeError("byte lease capability is not authentic");
    }
    const record = this.#leaseCapabilities.get(lease);
    if (
      record === undefined ||
      record.released ||
      record.participantId !== participantId ||
      this.#leases.get(Number(record.id)) !== record
    ) {
      throw new TypeError("byte lease belongs to another participant or manager");
    }
  }

  #shrinkLease(lease: RuntimeByteLease, nextValue: number): void {
    if (lease === null || typeof lease !== "object") {
      throw new TypeError("byte lease capability is not authentic");
    }
    const record = this.#leaseCapabilities.get(lease);
    if (record === undefined) {
      throw new TypeError("byte lease capability belongs to another manager");
    }
    if (
      record.released ||
      this.#disposed ||
      this.#leases.get(Number(record.id)) !== record
    ) {
      throw disposedError();
    }
    const nextBytes = requireNonNegativeBytes(nextValue, "shrunk bytes");
    if (nextBytes > record.bytes) {
      throw new RangeError("synchronous byte lease shrink cannot grow");
    }
    if (nextBytes === record.bytes) return;
    const participant = this.#participants.get(Number(record.participantId));
    if (participant === undefined) throw disposedError();
    this.#subtractLeaseBytes(
      participant,
      record.category,
      record.bytes - nextBytes
    );
    record.bytes = nextBytes;
    clampReclaimable(participant, record.category);
  }

  #contributedResourceCounters(): RuntimePageResourceCounterContribution {
    let decoderLeaseCount = 0;
    let decoderQueueLength = 0;
    let pendingReclamations = 0;
    for (const read of requireCounterRegistry(this).contributors.values()) {
      const contribution = validateCounterContribution(read());
      decoderLeaseCount = checkedSum(
        decoderLeaseCount,
        contribution.decoderLeaseCount,
        "decoder lease count"
      );
      decoderQueueLength = checkedSum(
        decoderQueueLength,
        contribution.decoderQueueLength,
        "decoder queue length"
      );
      pendingReclamations = checkedSum(
        pendingReclamations,
        contribution.pendingReclamations,
        "pending reclamation count"
      );
    }
    return { decoderLeaseCount, decoderQueueLength, pendingReclamations };
  }

  async #resizeLease(record: ByteLeaseRecord, nextValue: number): Promise<void> {
    if (record.released) throw disposedError();
    this.#throwIfDisposed();
    const nextBytes = requireNonNegativeBytes(nextValue, "resized bytes");
    if (nextBytes === record.bytes) return;
    const participant = this.#participants.get(Number(record.participantId));
    if (participant === undefined) {
      throw disposedError();
    }

    if (nextBytes > record.bytes) {
      const delta = nextBytes - record.bytes;
      const nextParticipantBytes = checkedSum(
        participant.logicalBytes,
        delta,
        "participant logical bytes"
      );
      const nextPageBytes = checkedSum(
        this.#physicalBytes,
        delta,
        "page physical bytes"
      );
      this.#assertFits(participant, delta, nextParticipantBytes, nextPageBytes);
      participant.logicalBytes = nextParticipantBytes;
      participant.categoryBytes.set(
        record.category,
        checkedSum(
          participant.categoryBytes.get(record.category) ?? 0,
          delta,
          "participant category bytes"
        )
      );
      this.#physicalBytes = nextPageBytes;
      this.#categoryBytes.set(
        record.category,
        checkedSum(
          this.#categoryBytes.get(record.category) ?? 0,
          delta,
          "page category bytes"
        )
      );
    } else {
      const delta = record.bytes - nextBytes;
      this.#subtractLeaseBytes(participant, record.category, delta);
    }
    record.bytes = nextBytes;
    clampReclaimable(participant, record.category);
  }

  #releaseLease(record: ByteLeaseRecord): void {
    if (record.released) return;
    const participant = this.#participants.get(Number(record.participantId));
    if (participant !== undefined) {
      this.#subtractLeaseBytes(participant, record.category, record.bytes);
      participant.leases.delete(Number(record.id));
      clampReclaimable(participant, record.category);
    }
    this.#leases.delete(Number(record.id));
    record.released = true;
  }

  #assertFits(
    participant: ParticipantRecord,
    requestedBytes: number,
    nextParticipantBytes: number,
    nextPageBytes: number
  ): void {
    if (
      nextParticipantBytes > this.#policy.maximumPlayerLogicalBytes ||
      nextPageBytes > this.#policy.maximumPagePhysicalBytes
    ) {
      throw resourceRejection(
        requestedBytes,
        participant.logicalBytes,
        this.#physicalBytes
      );
    }
  }

  #subtractLeaseBytes(
    participant: ParticipantRecord,
    category: RuntimeByteCategory,
    bytes: number
  ): void {
    const participantCategoryBytes = participant.categoryBytes.get(category) ?? 0;
    const pageCategoryBytes = this.#categoryBytes.get(category) ?? 0;
    if (
      bytes > participant.logicalBytes ||
      bytes > participantCategoryBytes ||
      bytes > this.#physicalBytes ||
      bytes > pageCategoryBytes
    ) {
      throw new RangeError("page resource accounting underflowed");
    }
    participant.logicalBytes -= bytes;
    const nextParticipantCategoryBytes = participantCategoryBytes - bytes;
    if (nextParticipantCategoryBytes === 0) {
      participant.categoryBytes.delete(category);
    } else {
      participant.categoryBytes.set(category, nextParticipantCategoryBytes);
    }
    this.#physicalBytes -= bytes;
    this.#categoryBytes.set(category, pageCategoryBytes - bytes);
  }

  #requireParticipant(participantId: RuntimeParticipantId): ParticipantRecord {
    const id = requireOpaqueId(participantId, "participant ID");
    const participant = this.#participants.get(id);
    if (participant === undefined) {
      if (this.#disposed || this.#retiredParticipants.has(id)) {
        throw disposedError();
      }
      throw new RangeError("participant ID is not registered");
    }
    return participant;
  }

  #throwIfDisposed(): void {
    if (this.#disposed) throw disposedError();
  }

}

/** Internal composition bridge; deliberately absent from the package index. */
export function reclassifyPageResourceByteLease(
  manager: PageResourceManager,
  lease: RuntimeByteLease,
  category: RuntimeByteCategory
): void {
  if (!(manager instanceof PageResourceManager)) {
    throw new TypeError("byte lease reclassification requires a page manager");
  }
  const bridge = RESOURCE_ACCOUNTING_BRIDGES.get(manager);
  if (bridge === undefined) {
    throw new TypeError("page resource accounting bridge is unavailable");
  }
  bridge.reclassify(lease, category);
}

/** Internal ownership check used before adopting an async manager lease. */
export function assertPageResourceByteLeaseOwner(
  manager: PageResourceManager,
  lease: RuntimeByteLease,
  participantId: RuntimeParticipantId
): void {
  if (!(manager instanceof PageResourceManager)) {
    throw new TypeError("byte lease ownership requires a page manager");
  }
  const bridge = RESOURCE_ACCOUNTING_BRIDGES.get(manager);
  if (bridge === undefined) {
    throw new TypeError("page resource accounting bridge is unavailable");
  }
  bridge.assertOwner(lease, participantId);
}

/** Internal synchronous negative-delta bridge; absent from package exports. */
export function shrinkPageResourceByteLease(
  manager: PageResourceManager,
  lease: RuntimeByteLease,
  nextBytes: number
): void {
  if (!(manager instanceof PageResourceManager)) {
    throw new TypeError("byte lease shrink requires a page manager");
  }
  const bridge = RESOURCE_ACCOUNTING_BRIDGES.get(manager);
  if (bridge === undefined) {
    throw new TypeError("page resource accounting bridge is unavailable");
  }
  bridge.shrink(lease, nextBytes);
}

/** Internal composition bridge; deliberately absent from the package index. */
export function registerPageResourceCounterContributor(
  manager: PageResourceManager,
  value: RuntimePageResourceCounterContributor
): () => void {
  if (!(manager instanceof PageResourceManager)) {
    throw new TypeError("resource counter bridge requires a page manager");
  }
  const registry = requireCounterRegistry(manager);
  if (registry.closed) throw disposedError();
  const read = captureCounterContributor(value);
  const id = checkedIncrement(registry.nextId, "resource counter contributor ID");
  registry.nextId = id;
  registry.contributors.set(id, read);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    registry.contributors.delete(id);
  };
}

function requireCounterRegistry(manager: PageResourceManager): ResourceCounterRegistry {
  const registry = RESOURCE_COUNTER_REGISTRIES.get(manager);
  if (registry === undefined) {
    throw new TypeError("page resource counter registry is unavailable");
  }
  return registry;
}

function capturePolicy(
  value: Readonly<RuntimePageResourcePolicy>
): Readonly<RuntimePageResourcePolicy> {
  if (value === null || typeof value !== "object") {
    throw new TypeError("page resource policy must be an object");
  }
  let maximumDecoderLeases: unknown;
  let maximumPagePhysicalBytes: unknown;
  let maximumPlayerLogicalBytes: unknown;
  let referenceProfile: unknown;
  try {
    maximumDecoderLeases = Reflect.get(value, "maximumDecoderLeases");
    maximumPagePhysicalBytes = Reflect.get(value, "maximumPagePhysicalBytes");
    maximumPlayerLogicalBytes = Reflect.get(value, "maximumPlayerLogicalBytes");
    referenceProfile = Reflect.get(value, "referenceProfile");
  } catch {
    throw new TypeError("page resource policy fields are inaccessible");
  }
  if (
    !Number.isSafeInteger(maximumDecoderLeases) ||
    (maximumDecoderLeases as number) < 0 ||
    !Number.isSafeInteger(maximumPagePhysicalBytes) ||
    (maximumPagePhysicalBytes as number) <= 0 ||
    !Number.isSafeInteger(maximumPlayerLogicalBytes) ||
    (maximumPlayerLogicalBytes as number) <= 0 ||
    typeof referenceProfile !== "boolean"
  ) {
    throw new TypeError("page resource policy is malformed");
  }
  const aboveReference =
    (maximumDecoderLeases as number) > DEFAULT_MAXIMUM_DECODER_LEASES ||
    (maximumPagePhysicalBytes as number) >
      DEFAULT_MAXIMUM_PAGE_PHYSICAL_BYTES ||
    (maximumPlayerLogicalBytes as number) >
      DEFAULT_MAXIMUM_PLAYER_LOGICAL_BYTES;
  if (referenceProfile !== !aboveReference) {
    throw new TypeError("page resource policy reference profile is inconsistent");
  }
  return Object.freeze({
    maximumDecoderLeases: maximumDecoderLeases as number,
    maximumPagePhysicalBytes: maximumPagePhysicalBytes as number,
    maximumPlayerLogicalBytes: maximumPlayerLogicalBytes as number,
    referenceProfile
  });
}

function captureCounterContributor(
  value: RuntimePageResourceCounterContributor
): () => Readonly<RuntimePageResourceCounterContribution> {
  if (value === null || typeof value !== "object") {
    throw new TypeError("resource counter contributor must be an object");
  }
  let resourceCounters: unknown;
  try {
    resourceCounters = Reflect.get(value, "resourceCounters");
  } catch {
    throw new TypeError("resource counter contributor is inaccessible");
  }
  if (typeof resourceCounters !== "function") {
    throw new TypeError("resource counter contributor is malformed");
  }
  return () => validateCounterContribution(
    Reflect.apply(resourceCounters, value, []) as
      Readonly<RuntimePageResourceCounterContribution>
  );
}

function validateCounterContribution(
  value: Readonly<RuntimePageResourceCounterContribution>
): RuntimePageResourceCounterContribution {
  if (value === null || typeof value !== "object") {
    throw new TypeError("resource counter contribution must be an object");
  }
  const decoderLeaseCount = requireCounter(
    value.decoderLeaseCount,
    "decoder lease count"
  );
  const decoderQueueLength = requireCounter(
    value.decoderQueueLength,
    "decoder queue length"
  );
  const pendingReclamations = requireCounter(
    value.pendingReclamations,
    "pending reclamation count"
  );
  return { decoderLeaseCount, decoderQueueLength, pendingReclamations };
}

function requireCounter(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function snapshotParticipant(
  participant: ParticipantRecord
): Readonly<RuntimeParticipantState> {
  const reclaimable = Object.freeze(RUNTIME_BYTE_CATEGORIES.flatMap((category) => {
    const bytes = participant.reclaimable.get(category) ?? 0;
    return bytes === 0
      ? []
      : [Object.freeze({ category, bytes })];
  }));
  return Object.freeze({
    id: participant.id,
    generation: participant.generation,
    visibility: participant.visibility,
    phase: participant.phase,
    lastTouchSequence: participant.lastTouchSequence,
    logicalBytes: participant.logicalBytes,
    reclaimable
  });
}

function snapshotLease(record: ByteLeaseRecord): Readonly<RuntimeByteLeaseSnapshot> {
  return Object.freeze({
    id: record.id,
    participantId: record.participantId,
    category: record.category,
    bytes: record.bytes,
    released: record.released
  });
}

function validateReclaimable(
  values: readonly Readonly<RuntimeCategoryBytesSnapshot>[],
  categoryBytes: ReadonlyMap<RuntimeByteCategory, number>
): Map<RuntimeByteCategory, number> {
  if (!Array.isArray(values)) {
    throw new TypeError("participant reclaimable bytes must be an array");
  }
  const result = new Map<RuntimeByteCategory, number>();
  for (const value of values) {
    validateExactObject(value, RECLAIMABLE_FIELDS, "reclaimable category");
    const category = requireCategory(value.category);
    const bytes = requirePositiveBytes(value.bytes, "reclaimable bytes");
    if (result.has(category)) {
      throw new TypeError("reclaimable category must not be duplicated");
    }
    if (bytes > (categoryBytes.get(category) ?? 0)) {
      throw new RangeError("reclaimable bytes exceed participant category bytes");
    }
    result.set(category, bytes);
  }
  return result;
}

function clampReclaimable(
  participant: ParticipantRecord,
  category: RuntimeByteCategory
): void {
  const reclaimable = participant.reclaimable.get(category);
  if (reclaimable === undefined) return;
  const available = participant.categoryBytes.get(category) ?? 0;
  if (available === 0) participant.reclaimable.delete(category);
  else if (reclaimable > available) participant.reclaimable.set(category, available);
}

function requireCategory(value: RuntimeByteCategory): RuntimeByteCategory {
  if (typeof value !== "string" || !CATEGORY_SET.has(value)) {
    throw new TypeError("byte category is not recognized");
  }
  return value;
}

function requireGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("participant generation must be non-negative and safe");
  }
  return value;
}

function requireVisibility(
  value: RuntimeParticipantVisibility
): RuntimeParticipantVisibility {
  if (typeof value !== "string" || !VISIBILITIES.has(value)) {
    throw new TypeError("participant visibility is invalid");
  }
  return value;
}

function requirePhase(value: RuntimeParticipantPhase): RuntimeParticipantPhase {
  if (typeof value !== "string" || !PHASES.has(value)) {
    throw new TypeError("participant phase is invalid");
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

function requireOpaqueId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
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

function validateExactObject(
  value: object,
  allowedFields: ReadonlySet<string>,
  label: string
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      throw new TypeError(`${label} contains an unknown field`);
    }
  }
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
