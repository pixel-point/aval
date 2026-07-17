import {
  normalizeAutoplay,
  normalizeAutoplayAttribute,
  normalizeBindings,
  normalizeBindingsAttribute,
  normalizeCrossOrigin,
  normalizeCrossOriginAttribute,
  normalizeFit,
  normalizeFitAttribute,
  normalizeInteractionFor,
  normalizeInteractionForAttribute,
  normalizeMotion,
  normalizeMotionAttribute,
  normalizeSize,
  normalizeSizeAttribute,
  normalizeState,
  normalizeStateAttribute
} from "./element-configuration.js";
import type {
  AvalAutoplay,
  AvalBindings,
  AvalCrossOrigin,
  AvalFit,
  AvalMotion
} from "./public-types.js";

/** Realm-independent reflected attribute normalization. */
export class ElementAttributeReflection {
  readonly #host: HTMLElement;
  public constructor(host: HTMLElement) { this.#host = host; }

  public get crossOrigin(): AvalCrossOrigin {
    return this.#read("crossorigin", normalizeCrossOriginAttribute, "anonymous");
  }
  public set crossOrigin(value: AvalCrossOrigin) {
    this.#host.setAttribute("crossorigin", normalizeCrossOrigin(value));
  }
  public get motion(): AvalMotion {
    return this.#read("motion", normalizeMotionAttribute, "auto");
  }
  public set motion(value: AvalMotion) {
    this.#host.setAttribute("motion", normalizeMotion(value));
  }
  public get autoplay(): AvalAutoplay {
    return this.#read("autoplay", normalizeAutoplayAttribute, "visible");
  }
  public set autoplay(value: AvalAutoplay) {
    this.#host.setAttribute("autoplay", normalizeAutoplay(value));
  }
  public get fit(): AvalFit | null {
    return this.#read("fit", normalizeFitAttribute, null);
  }
  public set fit(value: AvalFit | null) {
    const checked = normalizeFit(value);
    if (checked === null) this.#host.removeAttribute("fit");
    else this.#host.setAttribute("fit", checked);
  }
  public get bindings(): AvalBindings {
    return this.#read("bindings", normalizeBindingsAttribute, "auto");
  }
  public set bindings(value: AvalBindings) {
    this.#host.setAttribute("bindings", normalizeBindings(value));
  }
  public get state(): string | null {
    return this.#read("state", normalizeStateAttribute, null);
  }
  public set state(value: string | null) {
    const checked = normalizeState(value);
    if (checked === null) this.#host.removeAttribute("state");
    else this.#host.setAttribute("state", checked);
  }
  public get interactionFor(): string {
    return this.#read("interaction-for", normalizeInteractionForAttribute, "");
  }
  public set interactionFor(value: string) {
    this.#optional("interaction-for", normalizeInteractionFor(value));
  }
  public get width(): number | null {
    return this.#read("width", normalizeSizeAttribute, null);
  }
  public set width(value: number | null) { this.#size("width", value); }
  public get height(): number | null {
    return this.#read("height", normalizeSizeAttribute, null);
  }
  public set height(value: number | null) { this.#size("height", value); }

  public upgrade(properties: readonly string[]): void {
    for (const property of properties) {
      if (!Object.prototype.hasOwnProperty.call(this.#host, property)) continue;
      const value = Reflect.get(this.#host, property);
      if (Reflect.deleteProperty(this.#host, property)) {
        Reflect.set(this.#host, property, value);
      }
    }
  }

  #read<T>(
    name: string,
    normalize: (value: string | null) => T,
    fallback: T
  ): T {
    try { return normalize(this.#host.getAttribute(name)); }
    catch { return fallback; }
  }

  #optional(name: string, value: string): void {
    if (value === "") this.#host.removeAttribute(name);
    else this.#host.setAttribute(name, value);
  }

  #size(name: "width" | "height", value: number | null): void {
    const checked = normalizeSize(value);
    if (checked === null) this.#host.removeAttribute(name);
    else this.#host.setAttribute(name, String(checked));
  }
}
