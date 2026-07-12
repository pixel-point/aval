import {
  RuntimePlaybackError,
  normalizeRuntimeFailure
} from "./errors.js";
import type {
  RuntimeDecoderLease,
  RuntimeDecoderLeaseId,
  RuntimeDecoderLeaseSnapshot,
  RuntimeDecoderTicket,
  RuntimeDecoderTicketId,
  RuntimeDecoderTicketSnapshot,
  RuntimeDecoderTicketState,
  RuntimeParticipantId
} from "./model.js";
import {
  PageResourceManager,
  registerPageResourceCounterContributor
} from "./page-resource-manager.js";

export interface PageDecoderLeasesSnapshot {
  readonly activeLeaseCount: number;
  readonly queuedTicketCount: number;
  readonly parkedTicketCount: number;
  readonly tickets: readonly Readonly<RuntimeDecoderTicketSnapshot>[];
  readonly disposed: boolean;
}

interface TicketRecord {
  readonly id: RuntimeDecoderTicketId;
  readonly participantId: RuntimeParticipantId;
  readonly generation: number;
  state: RuntimeDecoderTicketState;
  ordinal: number;
  lease: RuntimeDecoderLease | null;
  waitPromise: Promise<RuntimeDecoderLease> | null;
  resolveWait: ((lease: RuntimeDecoderLease) => void) | null;
  rejectWait: ((error: unknown) => void) | null;
}

interface DecoderLeaseRecord {
  readonly id: RuntimeDecoderLeaseId;
  readonly ticket: TicketRecord;
  released: boolean;
}

/** FIFO permission authority; live decoder objects remain player-owned. */
export class PageDecoderLeases {
  readonly #manager: PageResourceManager;
  readonly #maximumLeases: number;
  readonly #tickets = new Map<number, TicketRecord>();
  readonly #owners = new Map<number, TicketRecord>();
  readonly #activeLeases = new Map<number, DecoderLeaseRecord>();
  readonly #unregisterCounters: () => void;
  #nextTicketId = 0;
  #nextLeaseId = 0;
  #nextOrdinal = 0;
  #disposed = false;

  public constructor(manager: PageResourceManager) {
    if (!(manager instanceof PageResourceManager)) {
      throw new TypeError("decoder leases require a page resource manager");
    }
    this.#manager = manager;
    this.#maximumLeases = manager.snapshot().policy.maximumDecoderLeases;
    this.#unregisterCounters = registerPageResourceCounterContributor(manager, {
      resourceCounters: () => ({
        decoderLeaseCount: this.#activeLeases.size,
        decoderQueueLength: this.#pendingTicketCount(),
        pendingReclamations: 0
      })
    });
  }

  public request(
    participantId: RuntimeParticipantId,
    generationValue: number
  ): RuntimeDecoderTicket {
    this.#throwIfDisposed();
    const generation = requireGeneration(generationValue);
    const participant = this.#manager.tryParticipantSnapshot(participantId);
    if (participant === null) throw disposedError();
    if (participant.generation !== generation) throw staleTicketError();
    if (this.#owners.has(Number(participantId))) {
      throw new RangeError("participant already owns a decoder ticket or lease");
    }

    const ticketId = checkedIncrement(this.#nextTicketId, "decoder ticket ID");
    const ordinal = checkedIncrement(this.#nextOrdinal, "decoder ticket ordinal");
    const record: TicketRecord = {
      id: ticketId as RuntimeDecoderTicketId,
      participantId,
      generation,
      ordinal,
      state: participant.visibility === "visible" ? "queued" : "parked",
      lease: null,
      waitPromise: null,
      resolveWait: null,
      rejectWait: null
    };
    const ticket = this.#createTicket(record);
    this.#nextTicketId = ticketId;
    this.#nextOrdinal = ordinal;
    this.#tickets.set(ticketId, record);
    this.#owners.set(Number(participantId), record);
    this.#drainQueue();
    return ticket;
  }

  /** Reconcile visibility, replacement generation, or participant disposal. */
  public reconcileParticipant(participantId: RuntimeParticipantId): void {
    if (this.#disposed) return;
    const record = this.#owners.get(Number(participantId));
    if (record === undefined || record.state === "granted") return;
    const participant = this.#manager.tryParticipantSnapshot(participantId);
    if (
      participant === null ||
      participant.generation !== record.generation
    ) {
      this.#cancelTicket(record);
      this.#drainQueue();
      return;
    }
    if (participant.visibility === "hidden") {
      record.state = "parked";
      return;
    }
    if (record.state === "parked") {
      record.ordinal = checkedIncrement(
        this.#nextOrdinal,
        "decoder ticket ordinal"
      );
      this.#nextOrdinal = record.ordinal;
      record.state = "queued";
    }
    this.#drainQueue();
  }

  /** Cancel pending eligibility; an active owner must release after cleanup. */
  public removeParticipant(participantId: RuntimeParticipantId): void {
    if (this.#disposed) return;
    const record = this.#owners.get(Number(participantId));
    if (record === undefined || record.state === "granted") return;
    this.#cancelTicket(record);
    this.#drainQueue();
  }

  public snapshot(): Readonly<PageDecoderLeasesSnapshot> {
    const tickets = Object.freeze(
      [...this.#tickets.values()]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map(snapshotTicket)
    );
    return Object.freeze({
      activeLeaseCount: this.#activeLeases.size,
      queuedTicketCount: countState(this.#tickets, "queued"),
      parkedTicketCount: countState(this.#tickets, "parked"),
      tickets,
      disposed: this.#disposed
    });
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const ticket of [...this.#tickets.values()]) {
      if (ticket.state === "granted") continue;
      this.#cancelTicket(ticket);
    }
    for (const lease of [...this.#activeLeases.values()]) {
      this.#releaseLease(lease, false);
    }
    this.#tickets.clear();
    this.#owners.clear();
    this.#unregisterCounters();
  }

  #createTicket(record: TicketRecord): RuntimeDecoderTicket {
    const ticket = Object.freeze({
      snapshot: (): Readonly<RuntimeDecoderTicketSnapshot> =>
        snapshotTicket(record),
      wait: (): Promise<RuntimeDecoderLease> => this.#waitForTicket(record),
      cancel: (): void => {
        if (record.state === "granted" || record.state === "cancelled") return;
        this.#cancelTicket(record);
        this.#drainQueue();
      }
    });
    return ticket as unknown as RuntimeDecoderTicket;
  }

  #waitForTicket(record: TicketRecord): Promise<RuntimeDecoderLease> {
    if (record.state === "granted" && record.lease !== null) {
      return Promise.resolve(record.lease);
    }
    if (record.state === "cancelled" || this.#disposed) {
      return Promise.reject(cancelledTicketError());
    }
    if (record.waitPromise !== null) return record.waitPromise;
    record.waitPromise = new Promise<RuntimeDecoderLease>((resolve, reject) => {
      record.resolveWait = resolve;
      record.rejectWait = reject;
    });
    return record.waitPromise;
  }

  #drainQueue(): void {
    if (this.#disposed) return;
    while (this.#activeLeases.size < this.#maximumLeases) {
      const next = [...this.#tickets.values()]
        .filter(({ state }) => state === "queued")
        .sort((left, right) => left.ordinal - right.ordinal)[0];
      if (next === undefined) return;
      const participant = this.#manager.tryParticipantSnapshot(next.participantId);
      if (participant === null || participant.generation !== next.generation) {
        this.#cancelTicket(next);
        continue;
      }
      if (participant.visibility === "hidden") {
        next.state = "parked";
        continue;
      }
      this.#grant(next);
    }
  }

  #grant(ticket: TicketRecord): void {
    const leaseId = checkedIncrement(this.#nextLeaseId, "decoder lease ID");
    const record: DecoderLeaseRecord = {
      id: leaseId as RuntimeDecoderLeaseId,
      ticket,
      released: false
    };
    const lease = this.#createLease(record);
    this.#nextLeaseId = leaseId;
    this.#activeLeases.set(leaseId, record);
    ticket.lease = lease;
    ticket.state = "granted";
    const resolve = ticket.resolveWait;
    ticket.resolveWait = null;
    ticket.rejectWait = null;
    resolve?.(lease);
  }

  #createLease(record: DecoderLeaseRecord): RuntimeDecoderLease {
    const lease = Object.freeze({
      snapshot: (): Readonly<RuntimeDecoderLeaseSnapshot> => Object.freeze({
        id: record.id,
        participantId: record.ticket.participantId,
        generation: record.ticket.generation,
        released: record.released
      }),
      release: (): void => this.#releaseLease(record, true)
    });
    return lease as unknown as RuntimeDecoderLease;
  }

  #releaseLease(record: DecoderLeaseRecord, drain: boolean): void {
    if (record.released) return;
    record.released = true;
    this.#activeLeases.delete(Number(record.id));
    this.#tickets.delete(Number(record.ticket.id));
    this.#owners.delete(Number(record.ticket.participantId));
    if (drain) this.#drainQueue();
  }

  #cancelTicket(record: TicketRecord): void {
    if (record.state === "cancelled" || record.state === "granted") return;
    record.state = "cancelled";
    this.#tickets.delete(Number(record.id));
    this.#owners.delete(Number(record.participantId));
    const reject = record.rejectWait;
    record.resolveWait = null;
    record.rejectWait = null;
    reject?.(cancelledTicketError());
  }

  #pendingTicketCount(): number {
    return countState(this.#tickets, "queued") +
      countState(this.#tickets, "parked");
  }

  #throwIfDisposed(): void {
    if (this.#disposed) throw disposedError();
  }
}

function snapshotTicket(
  record: TicketRecord
): Readonly<RuntimeDecoderTicketSnapshot> {
  return Object.freeze({
    id: record.id,
    participantId: record.participantId,
    generation: record.generation,
    ordinal: record.ordinal,
    state: record.state
  });
}

function countState(
  records: ReadonlyMap<number, TicketRecord>,
  state: RuntimeDecoderTicketState
): number {
  let count = 0;
  for (const record of records.values()) {
    if (record.state === state) count += 1;
  }
  return count;
}

function requireGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("decoder generation must be a non-negative safe integer");
  }
  return value;
}

function checkedIncrement(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${label} exceeded the safe-integer range`);
  }
  return value + 1;
}

function cancelledTicketError(): DOMException {
  return new DOMException("decoder ticket was cancelled", "AbortError");
}

function staleTicketError(): DOMException {
  return new DOMException("decoder ticket generation is stale", "AbortError");
}

function disposedError(): RuntimePlaybackError {
  return new RuntimePlaybackError(normalizeRuntimeFailure("disposed"));
}
