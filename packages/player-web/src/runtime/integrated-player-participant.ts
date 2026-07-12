import { RuntimePlaybackError, normalizeRuntimeFailure } from "./errors.js";
import type {
  AvcCandidateResourceAuthority
} from "./avc-candidate-factory-model.js";
import type {
  RuntimeDecoderLease,
  RuntimeDecoderTicket,
  RuntimeParticipantPhase,
  RuntimeParticipantVisibility
} from "./model.js";
import { PageDecoderLeases } from "./page-decoder-leases.js";
import { PlayerResourceAccount } from "./player-resource-account.js";
import type { PlayerResourceAdmission } from "./player-resource-admission.js";
import { createPlayerCandidateResourceAuthority } from "./player-resource-hosts.js";

export interface IntegratedPlayerParticipantStatusUpdate {
  readonly visibility?: RuntimeParticipantVisibility;
  readonly phase?: RuntimeParticipantPhase;
  readonly eligible?: boolean;
}

export interface IntegratedPlayerParticipantSnapshot {
  readonly attached: boolean;
  readonly visibility: RuntimeParticipantVisibility;
  readonly phase: RuntimeParticipantPhase;
  readonly eligible: boolean;
  readonly decoderPending: boolean;
  readonly decoderGrantedForRebuild: boolean;
}

export interface IntegratedPlayerParticipantConnection {
  update(
    status: Readonly<IntegratedPlayerParticipantStatusUpdate>
  ): Readonly<IntegratedPlayerParticipantSnapshot>;
  touch(): void;
  snapshot(): Readonly<IntegratedPlayerParticipantSnapshot>;
  dispose(): void;
}

export interface IntegratedPlayerParticipantBinding {
  /** Wire this exact authority into the player's AVC candidate factory. */
  readonly candidateResourceAuthority: AvcCandidateResourceAuthority;
  attach(options: Readonly<{
    readonly onDecoderGrant: () => boolean | void;
  }>): IntegratedPlayerParticipantConnection;
}

interface PendingDecoder {
  readonly ticket: RuntimeDecoderTicket;
  lease: RuntimeDecoderLease | null;
  notified: boolean;
}

/**
 * Externally owned page-account binding. Detaching a player cancels its queued
 * decoder work but never disposes the supplied account or page authority.
 */
export function createIntegratedPlayerParticipantBinding(input: Readonly<{
  readonly account: PlayerResourceAccount;
  readonly decoders: PageDecoderLeases;
  readonly admission?: Readonly<PlayerResourceAdmission>;
}>): IntegratedPlayerParticipantBinding {
  return new PlayerParticipantBinding(input);
}

class PlayerParticipantBinding implements IntegratedPlayerParticipantBinding {
  public readonly candidateResourceAuthority: AvcCandidateResourceAuthority;
  readonly #account: PlayerResourceAccount;
  readonly #decoders: PageDecoderLeases;
  readonly #generation: number;
  #visibility: RuntimeParticipantVisibility;
  #phase: RuntimeParticipantPhase;
  #eligible = true;
  #attached = false;
  #onDecoderGrant: (() => boolean | void) | null = null;
  #pending: PendingDecoder | null = null;

  public constructor(input: Readonly<{
    readonly account: PlayerResourceAccount;
    readonly decoders: PageDecoderLeases;
    readonly admission?: Readonly<PlayerResourceAdmission>;
  }>) {
    if (!(input.account instanceof PlayerResourceAccount)) {
      throw new TypeError("participant binding requires a player account");
    }
    if (!(input.decoders instanceof PageDecoderLeases)) {
      throw new TypeError("participant binding requires page decoder leases");
    }
    this.#account = input.account;
    this.#decoders = input.decoders;
    const participant = input.account.snapshot().participant;
    if (participant === null) throw disposedError();
    this.#visibility = participant.visibility;
    this.#phase = participant.phase;
    this.#generation = participant.generation;
    const base = createPlayerCandidateResourceAuthority(
      input.account,
      input.decoders,
      input.admission
    );
    this.candidateResourceAuthority = Object.freeze({
      reservePlan: base.reservePlan,
      requestDecoder: () => this.#requestDecoder()
    });
  }

  public attach(options: Readonly<{
    readonly onDecoderGrant: () => boolean | void;
  }>): IntegratedPlayerParticipantConnection {
    this.#assertGeneration();
    if (this.#attached) {
      throw new RangeError("participant binding already has an attached player");
    }
    if (options === null || typeof options !== "object" ||
      typeof options.onDecoderGrant !== "function") {
      throw new TypeError("participant decoder-grant callback is invalid");
    }
    this.#attached = true;
    this.#onDecoderGrant = options.onDecoderGrant;
    let disposed = false;
    return Object.freeze({
      update: (status: Readonly<IntegratedPlayerParticipantStatusUpdate>) => {
        if (disposed) throw disposedError();
        return this.#update(status);
      },
      touch: () => {
        if (disposed) throw disposedError();
        this.#assertGeneration();
        this.#account.touch();
      },
      snapshot: () => this.#snapshot(),
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.#detach();
      }
    });
  }

  #requestDecoder(): RuntimeDecoderTicket {
    this.#assertGeneration();
    if (!this.#attached || !this.#eligible || this.#visibility !== "visible") {
      throw queuedError();
    }
    const pending = this.#pending;
    if (pending !== null && pending.lease !== null) {
      return this.#createHandoffTicket(pending);
    }
    if (pending !== null) return createQueuedTicket(pending.ticket);

    const account = this.#account.snapshot();
    const participant = account.participant;
    if (participant === null) throw disposedError();
    const ticket = this.#decoders.request(
      account.participantId,
      participant.generation
    );
    if (ticket.snapshot().state === "granted") return ticket;
    const record: PendingDecoder = { ticket, lease: null, notified: false };
    this.#pending = record;
    void ticket.wait().then(
      (lease) => this.#acceptQueuedGrant(record, lease),
      () => {
        if (this.#pending === record) this.#pending = null;
      }
    );
    return createQueuedTicket(ticket);
  }

  #acceptQueuedGrant(record: PendingDecoder, lease: RuntimeDecoderLease): void {
    if (
      this.#pending !== record || !this.#attached || !this.#eligible ||
      this.#visibility !== "visible" || !this.#isGenerationCurrent()
    ) {
      lease.release();
      if (this.#pending === record) this.#pending = null;
      return;
    }
    record.lease = lease;
    if (record.notified) return;
    record.notified = true;
    const notify = this.#onDecoderGrant;
    queueMicrotask(() => {
      if (this.#pending !== record || record.lease === null) return;
      try {
        if (notify?.() === false) this.#rejectQueuedGrant(record);
      } catch {
        this.#rejectQueuedGrant(record);
      }
    });
  }

  #rejectQueuedGrant(record: PendingDecoder): void {
    if (this.#pending !== record) return;
    this.#pending = null;
    const lease = record.lease;
    record.lease = null;
    lease?.release();
  }

  #createHandoffTicket(record: PendingDecoder): RuntimeDecoderTicket {
    const lease = record.lease;
    if (lease === null) return createQueuedTicket(record.ticket);
    let consumed = false;
    let cancelled = false;
    return {
      snapshot: () => record.ticket.snapshot(),
      wait: (): Promise<RuntimeDecoderLease> => {
        if (cancelled) return Promise.reject(abortError());
        if (!consumed) {
          consumed = true;
          record.lease = null;
          if (this.#pending === record) this.#pending = null;
        }
        return Promise.resolve(lease);
      },
      cancel: (): void => {
        if (consumed || cancelled) return;
        cancelled = true;
        record.lease = null;
        if (this.#pending === record) this.#pending = null;
        lease.release();
      }
    } as RuntimeDecoderTicket;
  }

  #update(
    status: Readonly<IntegratedPlayerParticipantStatusUpdate>
  ): Readonly<IntegratedPlayerParticipantSnapshot> {
    this.#assertGeneration();
    if (status === null || typeof status !== "object") {
      throw new TypeError("participant status update must be an object");
    }
    const { visibility, phase, eligible } = status;
    if (
      visibility !== undefined &&
      visibility !== "visible" && visibility !== "hidden"
    ) {
      throw new TypeError("participant visibility is invalid");
    }
    if (phase !== undefined && !PARTICIPANT_PHASES.has(phase)) {
      throw new TypeError("participant phase is invalid");
    }
    if (eligible !== undefined && typeof eligible !== "boolean") {
      throw new TypeError("participant eligibility is invalid");
    }
    this.#visibility = visibility ?? this.#visibility;
    this.#phase = phase ?? this.#phase;
    this.#eligible = eligible ?? this.#eligible;
    this.#account.updateStatus({
      visibility: this.#visibility,
      phase: this.#phase
    });
    if (!this.#eligible || this.#visibility === "hidden") {
      this.#cancelPending();
      this.#decoders.removeParticipant(this.#account.participantId);
    } else {
      this.#decoders.reconcileParticipant(this.#account.participantId);
    }
    return this.#snapshot();
  }

  #snapshot(): Readonly<IntegratedPlayerParticipantSnapshot> {
    const pending = this.#pending;
    return Object.freeze({
      attached: this.#attached,
      visibility: this.#visibility,
      phase: this.#phase,
      eligible: this.#eligible,
      decoderPending: pending !== null,
      decoderGrantedForRebuild: pending !== null && pending.lease !== null
    });
  }

  #cancelPending(): void {
    const pending = this.#pending;
    this.#pending = null;
    if (pending === null) return;
    if (pending.lease !== null) {
      pending.lease.release();
      pending.lease = null;
    } else {
      pending.ticket.cancel();
    }
  }

  #detach(): void {
    const current = this.#isGenerationCurrent();
    if (current) {
      try {
        this.#visibility = "hidden";
        this.#phase = "suspended";
        this.#account.updateStatus({
          visibility: "hidden",
          phase: "suspended"
        });
      } catch {
        // An externally disposed account already has no participant to update.
      }
    }
    this.#attached = false;
    this.#onDecoderGrant = null;
    this.#cancelPending();
    if (current) this.#decoders.removeParticipant(this.#account.participantId);
  }

  #isGenerationCurrent(): boolean {
    return this.#account.snapshot().participant?.generation === this.#generation;
  }

  #assertGeneration(): void {
    if (!this.#isGenerationCurrent()) {
      throw new RuntimePlaybackError(normalizeRuntimeFailure(
        "abort",
        undefined,
        { generation: this.#generation, operation: "stale-participant-binding" }
      ));
    }
  }
}

const PARTICIPANT_PHASES: ReadonlySet<string> = new Set([
  "loading",
  "preparing",
  "animated",
  "static",
  "suspended"
]);

function createQueuedTicket(ticket: RuntimeDecoderTicket): RuntimeDecoderTicket {
  return {
    snapshot: () => ticket.snapshot(),
    wait: () => Promise.reject(queuedError()),
    // The binding retains this ticket for the future fresh rebuild.
    cancel: () => undefined
  } as RuntimeDecoderTicket;
}

function queuedError(): RuntimePlaybackError {
  return new RuntimePlaybackError(normalizeRuntimeFailure(
    "resource-rejection",
    undefined,
    { operation: "decoder-queued" }
  ));
}

function disposedError(): RuntimePlaybackError {
  return new RuntimePlaybackError(normalizeRuntimeFailure("disposed"));
}

function abortError(): DOMException {
  return new DOMException("decoder grant handoff was cancelled", "AbortError");
}
