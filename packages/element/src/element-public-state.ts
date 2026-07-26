import type {
  Binding,
  RuntimeReadiness,
  RuntimeReadinessResult,
  StaticReason
} from "@pixel-point/aval-player-web";

import type {
  AvalMode,
  AvalMotion,
  AvalPublicFailure,
  AvalRing
} from "./public-types.js";

/** Sole mutable authority for the element's public playback state. */
export class ElementPublicState {
  #readiness: RuntimeReadiness = "unready";
  #mode: AvalMode = null;
  #assurance: "best-effort" | null = null;
  #staticReason: StaticReason | null = null;
  #initialState: string | null = null;
  #requestedState: string | null = null;
  #visualState: string | null = null;
  #transitioning = false;
  #stateNames: readonly string[] = Object.freeze([]);
  #eventNames: readonly string[] = Object.freeze([]);
  #inputBindings: readonly Readonly<Binding>[] = Object.freeze([]);
  #rings: readonly Readonly<AvalRing>[] = Object.freeze([]);
  #lastFailure: Readonly<AvalPublicFailure> | null = null;

  public get readiness(): RuntimeReadiness { return this.#readiness; }
  public get mode(): AvalMode { return this.#mode; }
  public get assurance(): "best-effort" | null { return this.#assurance; }
  public get staticReason(): StaticReason | null { return this.#staticReason; }
  public get initialState(): string | null { return this.#initialState; }
  public get requestedState(): string | null { return this.#requestedState; }
  public get visualState(): string | null { return this.#visualState; }
  public get transitioning(): boolean { return this.#transitioning; }
  public get stateNames(): readonly string[] { return this.#stateNames; }
  public get eventNames(): readonly string[] { return this.#eventNames; }
  public get inputBindings(): readonly Readonly<Binding>[] { return this.#inputBindings; }
  public get rings(): readonly Readonly<AvalRing>[] { return this.#rings; }
  public get lastFailure(): Readonly<AvalPublicFailure> | null {
    return this.#lastFailure;
  }

  public setRequestedState(value: string): void { this.#requestedState = value; }
  public setVisualState(value: string): void { this.#visualState = value; }
  public setTransitioning(value: boolean): void { this.#transitioning = value; }
  public setFailure(value: Readonly<AvalPublicFailure>): void {
    this.#lastFailure = value;
  }
  public clearFailure(): void { this.#lastFailure = null; }
  public markFatal(): void { this.#readiness = "error"; }
  public markDisposed(): void { this.#readiness = "disposed"; }

  public fallback(reason: StaticReason): void {
    this.#mode = "static";
    this.#assurance = null;
    this.#staticReason = reason;
  }

  public metadataReady(metadata: Readonly<{
    initialState: string;
    stateNames: readonly string[];
    eventNames: readonly string[];
    bindings: readonly Readonly<Binding>[];
    rings?: readonly Readonly<AvalRing>[];
  }>): void {
    this.#initialState = metadata.initialState;
    this.#requestedState = metadata.initialState;
    this.#visualState = metadata.initialState;
    this.#stateNames = Object.freeze([...metadata.stateNames]);
    this.#eventNames = Object.freeze([...metadata.eventNames]);
    this.#inputBindings = Object.freeze(metadata.bindings.map((binding) =>
      Object.freeze({ source: binding.source, event: binding.event })
    ));
    this.#rings = Object.freeze((metadata.rings ?? []).map((ring) =>
      Object.freeze({
        id: ring.id,
        states: Object.freeze([...ring.states]),
        cyclic: ring.cyclic
      })
    ));
  }

  public prepared(result: Readonly<RuntimeReadinessResult>): void {
    if (result.mode === "animated") {
      this.#mode = "animated";
      this.#assurance = result.assurance;
      this.#staticReason = null;
    } else {
      this.fallback(result.reason);
    }
  }

  public stageReadiness(input: Readonly<{
    value: RuntimeReadiness;
    reason: StaticReason | null;
    motion: AvalMotion;
    hostReduced: boolean | null;
    effectivelyVisible: boolean;
  }>): void {
    this.#readiness = input.value;
    if (input.value === "interactiveReady") {
      this.#mode = "animated";
      this.#assurance = "best-effort";
      this.#staticReason = null;
    } else if (input.value === "staticReady") {
      this.#mode = "static";
      this.#assurance = null;
      this.#staticReason = input.reason ?? (
        input.motion === "reduce" ||
        (input.motion === "auto" && input.hostReduced === true)
          ? "reduced-motion"
          : !input.effectivelyVisible
            ? "visibility-suspended"
            : this.#staticReason ?? "readiness-failed"
      );
    }
  }

  public reset(resetReadiness = true): void {
    if (resetReadiness) this.#readiness = "unready";
    this.#mode = null;
    this.#assurance = null;
    this.#staticReason = null;
    this.#initialState = null;
    this.#requestedState = null;
    this.#visualState = null;
    this.#transitioning = false;
    this.#stateNames = Object.freeze([]);
    this.#eventNames = Object.freeze([]);
    this.#inputBindings = Object.freeze([]);
    this.#rings = Object.freeze([]);
  }
}
