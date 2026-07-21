import type { PresentationGeometry } from "./presentation-geometry.js";
import { computePresentationGeometry } from "./presentation-geometry.js";
import type { CapturedBrowserPresentationPlanesOptions } from "./browser-presentation-options.js";
import {
  safelyRollbackBackingTransition,
  type BrowserCanvasBackingResourceHost,
  type BrowserCanvasBackingResourceTransition
} from "./browser-canvas-backing-resources.js";
import type {
  BrowserContextRecoveryEvent,
  BrowserContextRecoveryEventTarget
} from "./browser-context-recovery.js";
import type { BrowserPresentationPlanesOptions } from "./browser-presentation-planes.js";

export function initialPresentationGeometry(
  options: Readonly<CapturedBrowserPresentationPlanesOptions>
): Readonly<PresentationGeometry> {
  const initial = options.initialPresentation;
  return computePresentationGeometry({
    canvasWidth: options.canvas.width,
    canvasHeight: options.canvas.height,
    pixelAspectNumerator: options.canvas.pixelAspect[0],
    pixelAspectDenominator: options.canvas.pixelAspect[1],
    fit: initial?.fit ?? options.canvas.fit,
    cssWidth: initial?.cssWidth ?? options.canvas.width,
    cssHeight: initial?.cssHeight ?? options.canvas.height,
    devicePixelRatio: initial?.devicePixelRatio ?? 1,
    maxBackingWidth: options.maxBackingWidth,
    maxBackingHeight: options.maxBackingHeight,
    maxBackingBytes: initial?.maxBackingBytes ?? options.maxBackingBytes
  });
}

export function replayPresentationOptions(
  captured: Readonly<CapturedBrowserPresentationPlanesOptions>,
  backingResources: Readonly<BrowserCanvasBackingResourceHost> | null =
    captured.backingResources
): Readonly<BrowserPresentationPlanesOptions> {
  return Object.freeze({
    animatedCanvas: captured.animatedCanvas,
    canvas: captured.canvas,
    maxBackingWidth: captured.maxBackingWidth,
    maxBackingHeight: captured.maxBackingHeight,
    maxBackingBytes: captured.maxBackingBytes,
    ...(captured.initialPresentation === null
      ? {}
      : { initialPresentation: captured.initialPresentation }),
    ...(captured.createBackend === undefined
      ? {}
      : { createBackend: captured.createBackend }),
    ...(backingResources === null ? {} : { backingResources })
  });
}

export function createPrimedBackingResources(
  resources: Readonly<BrowserCanvasBackingResourceHost>,
  admitted: BrowserCanvasBackingResourceTransition,
  allocationBytes: number
): Readonly<BrowserCanvasBackingResourceHost> {
  let first: BrowserCanvasBackingResourceTransition | null = admitted;
  let released = false;
  return Object.freeze({
    asynchronous: false,
    asynchronousAfterInitial: true,
    beginTransition(input: Readonly<{
      readonly animatedAllocationBytes: number;
    }>) {
      if (released) {
        throw new DOMException("canvas backing resources are released", "AbortError");
      }
      if (first !== null) {
        const transition = first;
        first = null;
        if (
          input.animatedAllocationBytes !== allocationBytes
        ) {
          safelyRollbackBackingTransition(transition);
          throw new RangeError("initial canvas admission does not match geometry");
        }
        return transition;
      }
      return resources.beginTransition(input);
    },
    release(): void {
      if (released) return;
      released = true;
      safelyRollbackBackingTransition(first);
      first = null;
      resources.release();
    }
  });
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (value === null ||
    (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  let then: unknown;
  try { then = Reflect.get(value, "then"); } catch { return false; }
  return typeof then === "function";
}

export class OwnedCanvasContextEventTarget
implements BrowserContextRecoveryEventTarget {
  readonly #add: (type: string, listener: EventListener) => void;
  readonly #remove: (type: string, listener: EventListener) => void;
  readonly #listeners = new Map<
    "webglcontextlost" | "webglcontextrestored",
    Map<(event: BrowserContextRecoveryEvent) => void, EventListener>
  >();
  #disposed = false;

  public constructor(canvas: HTMLCanvasElement) {
    let add: unknown;
    let remove: unknown;
    try {
      add = Reflect.get(canvas, "addEventListener");
      remove = Reflect.get(canvas, "removeEventListener");
    } catch {
      throw new TypeError("animated canvas context events are inaccessible");
    }
    if (typeof add !== "function" || typeof remove !== "function") {
      throw new TypeError("animated canvas has no context event capability");
    }
    this.#add = (type, listener) => {
      Reflect.apply(add, canvas, [type, listener]);
    };
    this.#remove = (type, listener) => {
      Reflect.apply(remove, canvas, [type, listener]);
    };
  }

  public get listenerCount(): number {
    let count = 0;
    for (const listeners of this.#listeners.values()) count += listeners.size;
    return count;
  }

  public addEventListener(
    type: "webglcontextlost" | "webglcontextrestored",
    listener: (event: BrowserContextRecoveryEvent) => void
  ): void {
    this.#assertActive();
    const listeners = this.#listeners.get(type) ?? new Map();
    if (listeners.has(listener)) return;
    const adapted: EventListener = (event) => listener(
      event as unknown as BrowserContextRecoveryEvent
    );
    this.#add(type, adapted);
    listeners.set(listener, adapted);
    this.#listeners.set(type, listeners);
  }

  public removeEventListener(
    type: "webglcontextlost" | "webglcontextrestored",
    listener: (event: BrowserContextRecoveryEvent) => void
  ): void {
    const listeners = this.#listeners.get(type);
    const adapted = listeners?.get(listener);
    if (adapted === undefined) return;
    listeners!.delete(listener);
    if (listeners!.size === 0) this.#listeners.delete(type);
    this.#remove(type, adapted);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const [type, listeners] of this.#listeners) {
      for (const adapted of listeners.values()) {
        try {
          this.#remove(type, adapted);
        } catch {
          // Terminal plane cleanup continues through hostile event hosts.
        }
      }
    }
    this.#listeners.clear();
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new DOMException("context event target is disposed", "AbortError");
    }
  }
}
