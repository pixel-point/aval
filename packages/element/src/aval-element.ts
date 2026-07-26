import type {
  Binding,
  RuntimeReadiness,
  RuntimeReadinessResult,
  StaticReason
} from "@pixel-point/aval-player-web";

import { ElementAttributeReflection } from "./element-attribute-reflection.js";
import {
  AVAL_ATTRIBUTES,
  AVAL_UPGRADE_PROPERTIES
} from "./element-attributes.js";
import { ElementReconciler } from "./element-reconciler.js";
import type {
  AvalAutoplay,
  AvalBindings,
  AvalCrossOrigin,
  AvalDiagnostics,
  AvalElement,
  AvalElementConstructor,
  AvalFit,
  AvalMode,
  AvalMotion,
  AvalRing
} from "./public-types.js";

/** Browser reflection facade. All coordination and effects live in ElementReconciler. */
export function createAvalElementClass(
  Base: typeof HTMLElement
): AvalElementConstructor {
  class AvalElementImpl extends Base implements AvalElement {
    public static get observedAttributes(): readonly string[] {
      return AVAL_ATTRIBUTES;
    }

    readonly #attributes: ElementAttributeReflection;
    readonly #reconciler: ElementReconciler;

    public constructor() {
      super();
      this.#attributes = new ElementAttributeReflection(this);
      this.#reconciler = new ElementReconciler(this);
      this.#attributes.upgrade(AVAL_UPGRADE_PROPERTIES);
    }

    public connectedCallback(): void { this.#reconciler.connect(); }
    public disconnectedCallback(): void { this.#reconciler.disconnect(); }
    public adoptedCallback(): void {
      // The next connect observes the concrete root/document and reconciles it.
    }
    public attributeChangedCallback(
      name: string,
      previous: string | null,
      next: string | null
    ): void {
      if (previous !== next) this.#reconciler.configurationChanged(name);
    }

    public get crossOrigin(): AvalCrossOrigin { return this.#attributes.crossOrigin; }
    public set crossOrigin(value: AvalCrossOrigin) { this.#attributes.crossOrigin = value; }
    public get motion(): AvalMotion { return this.#attributes.motion; }
    public set motion(value: AvalMotion) { this.#attributes.motion = value; }
    public get autoplay(): AvalAutoplay { return this.#attributes.autoplay; }
    public set autoplay(value: AvalAutoplay) { this.#attributes.autoplay = value; }
    public get fit(): AvalFit | null { return this.#attributes.fit; }
    public set fit(value: AvalFit | null) { this.#attributes.fit = value; }
    public get bindings(): AvalBindings { return this.#attributes.bindings; }
    public set bindings(value: AvalBindings) { this.#attributes.bindings = value; }
    public get state(): string | null { return this.#attributes.state; }
    public set state(value: string | null) { this.#attributes.state = value; }
    public get interactionFor(): string { return this.#attributes.interactionFor; }
    public set interactionFor(value: string) { this.#attributes.interactionFor = value; }
    public get interactionTarget(): Element | null { return this.#reconciler.interactionTarget; }
    public set interactionTarget(value: Element | null) {
      this.#reconciler.setInteractionTarget(value);
    }
    public get width(): number | null { return this.#attributes.width; }
    public set width(value: number | null) { this.#attributes.width = value; }
    public get height(): number | null { return this.#attributes.height; }
    public set height(value: number | null) { this.#attributes.height = value; }

    public get readiness(): RuntimeReadiness { return this.#reconciler.readiness; }
    public get mode(): AvalMode { return this.#reconciler.mode; }
    public get assurance(): "best-effort" | null { return this.#reconciler.assurance; }
    public get staticReason(): StaticReason | null { return this.#reconciler.staticReason; }
    public get requestedState(): string | null { return this.#reconciler.requestedState; }
    public get visualState(): string | null { return this.#reconciler.visualState; }
    public get isTransitioning(): boolean { return this.#reconciler.transitioning; }
    public get paused(): boolean { return this.#reconciler.paused; }
    public get effectivelyVisible(): boolean { return this.#reconciler.effectivelyVisible; }
    public get stateNames(): readonly string[] { return this.#reconciler.stateNames; }
    public get eventNames(): readonly string[] { return this.#reconciler.eventNames; }
    public get inputBindings(): readonly Readonly<Binding>[] {
      return this.#reconciler.inputBindings;
    }
    public get rings(): readonly Readonly<AvalRing>[] {
      return this.#reconciler.rings;
    }

    public prepare(
      options: Readonly<{ signal?: AbortSignal; timeoutMs?: number }> = {}
    ): Promise<RuntimeReadinessResult> {
      return this.#reconciler.prepare(options);
    }
    public setState(name: string): Promise<void> { return this.#reconciler.setState(name); }
    public send(event: string): boolean { return this.#reconciler.send(event); }
    public readyFor(state: string): boolean { return this.#reconciler.readyFor(state); }
    public planFor(state: string): readonly string[] | null {
      return this.#reconciler.planFor(state);
    }
    public pause(): void { this.#reconciler.pause(); }
    public resume(): Promise<void> { return this.#reconciler.resume(); }
    public getDiagnostics(
      options: Readonly<{ trace?: boolean }> = {}
    ): Readonly<AvalDiagnostics> {
      return this.#reconciler.getDiagnostics(options);
    }
    public dispose(): Promise<void> { return this.#reconciler.dispose(); }
  }

  return AvalElementImpl as unknown as AvalElementConstructor;
}
