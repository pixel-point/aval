import type {
  EffectHostEvent,
  RuntimeReadiness,
  StaticReason
} from "@pixel-point/aval-player-web";

import { freezeEventDetail } from "./dom-event-detail.js";
import { normalizePublicFailure, normalizeStaticReason } from "./public-failure.js";
import { nextElementSequence } from "./element-sequence.js";

export interface DomEventBridgeStage {
  readiness(value: RuntimeReadiness, reason: StaticReason | null): void;
  requestedState(value: string): void;
  visualState(value: string): void;
  transitioning(value: boolean): void;
  fallback?(reason: StaticReason): void;
  transaction?(active: boolean): void;
  snapshot(): Readonly<{
    requestedState: string | null;
    visualState: string | null;
  }>;
}

export class DomEventBridge {
  readonly #target: EventTarget;
  readonly #create: <T>(type: string, detail: Readonly<T>) => CustomEvent<T>;
  readonly #stage: DomEventBridgeStage;
  #generation: number;
  #underflowIncidents = 0;
  #closed = false;

  public constructor(options: Readonly<{
    target: EventTarget;
    generation: number;
    stage: DomEventBridgeStage;
    createEvent<T>(type: string, detail: Readonly<T>): CustomEvent<T>;
  }>) {
    this.#target = options.target;
    this.#generation = options.generation;
    this.#stage = options.stage;
    this.#create = options.createEvent;
  }

  public runtime(event: Readonly<EffectHostEvent>): void {
    if (this.#closed) return;
    switch (event.type) {
      case "readinesschange":
        {
        const reason = event.reason === undefined
          ? null
          : normalizeStaticReason(event.reason);
        this.#stage.readiness(event.to, reason);
        this.#dispatch("readinesschange", freezeEventDetail({
          generation: this.#generation,
          from: event.from,
          to: event.to,
          ...(reason === null ? {} : { reason })
        }));
        return;
        }
      case "requestedstatechange":
        this.#stage.requestedState(event.to);
        this.#dispatch("requestedstatechange", freezeEventDetail({
          generation: this.#generation,
          from: event.from,
          to: event.to,
          sequence: event.sequence
        }));
        return;
      case "visualstatechange":
        this.#stage.visualState(event.to);
        this.#dispatch("visualstatechange", freezeEventDetail({
          generation: this.#generation,
          from: event.from,
          to: event.to
        }));
        return;
      case "transitionstart":
        this.#stage.transitioning(true);
        this.#dispatch("transitionstart", freezeEventDetail({
          generation: this.#generation,
          edge: event.edgeId,
          from: event.from,
          to: event.to,
          sequence: event.sequence
        }));
        return;
      case "transitionend":
        this.#stage.transitioning(false);
        this.#dispatch("transitionend", freezeEventDetail({
          generation: this.#generation,
          edge: event.edgeId,
          from: event.from,
          to: event.to
        }));
        return;
      case "turnstep":
        this.#dispatch("turnstep", freezeEventDetail({
          generation: this.#generation,
          ring: event.ring,
          from: event.from,
          to: event.to,
          remaining: event.remaining
        }));
        return;
      case "fallback": {
        const snapshot = this.#stage.snapshot();
        const reason = normalizeStaticReason(event.reason);
        this.#stage.fallback?.(reason);
        this.#dispatch("fallback", freezeEventDetail({
          generation: this.#generation,
          reason,
          requestedState: snapshot.requestedState,
          visualState: snapshot.visualState
        }));
        return;
      }
    }
  }

  public failure(error: unknown, fatal: boolean): void {
    if (this.#closed) return;
    this.#dispatch("error", freezeEventDetail({
      generation: this.#generation,
      failure: normalizePublicFailure(error),
      fatal
    }));
  }

  public underflow(heldPresentationOrdinal: bigint): void {
    if (this.#closed) return;
    this.#underflowIncidents = nextElementSequence(
      this.#underflowIncidents,
      "underflow incident"
    );
    this.#dispatch("underflow", freezeEventDetail({
      generation: this.#generation,
      incident: this.#underflowIncidents,
      heldPresentationOrdinal: heldPresentationOrdinal.toString(),
      cumulativeCount: this.#underflowIncidents
    }));
  }

  public close(): void {
    this.#closed = true;
  }

  #dispatch<T>(type: string, detail: Readonly<T>): void {
    this.#stage.transaction?.(true);
    try {
      this.#target.dispatchEvent(this.#create(type, detail));
    } finally {
      this.#stage.transaction?.(false);
    }
  }
}
