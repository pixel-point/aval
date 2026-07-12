import type { CanvasV01 } from "@rendered-motion/format";

import type { BrowserPresentationPlanesOptions } from "./browser-presentation-planes.js";
import type {
  BrowserCanvasBackingResourceHost,
  BrowserCanvasBackingResourceInput,
  BrowserCanvasBackingResourceTransition
} from "./browser-presentation-planes.js";
import {
  MAX_LOGICAL_CANVAS_DIMENSION,
  MAX_PRESENTATION_BACKING_DIMENSION,
  PRESENTATION_FIT_MODES,
  type PresentationFit
} from "./presentation-geometry.js";

export interface CapturedBrowserPresentationPlanesOptions {
  readonly animatedCanvas: HTMLCanvasElement;
  readonly staticCanvas: HTMLCanvasElement;
  readonly canvas: Readonly<CanvasV01>;
  readonly maxBackingWidth: number;
  readonly maxBackingHeight: number;
  readonly maxBackingBytes: number;
  readonly setStaticVisible: (visible: boolean) => void;
  readonly onClamp: BrowserPresentationPlanesOptions["onClamp"];
  readonly createBackend: BrowserPresentationPlanesOptions["createBackend"];
  readonly backingResources: Readonly<BrowserCanvasBackingResourceHost> | null;
}

/** Capture every public constructor field once before any canvas is mutated. */
export function capturePresentationPlaneOptions(
  options: Readonly<BrowserPresentationPlanesOptions>
): Readonly<CapturedBrowserPresentationPlanesOptions> {
  if (options === null || typeof options !== "object") {
    throw new TypeError("browser presentation plane options are invalid");
  }
  let animatedCanvas: unknown;
  let staticCanvas: unknown;
  let canvasValue: unknown;
  let width: unknown;
  let height: unknown;
  let fit: unknown;
  let colorSpace: unknown;
  let pixelAspectValue: unknown;
  let pixelAspectNumerator: unknown;
  let pixelAspectDenominator: unknown;
  let maximumWidthValue: unknown;
  let maximumHeightValue: unknown;
  let maximumBytes: unknown;
  let setStaticVisible: unknown;
  let onClamp: unknown;
  let createBackend: unknown;
  let backingResourcesValue: unknown;
  try {
    animatedCanvas = Reflect.get(options, "animatedCanvas");
    staticCanvas = Reflect.get(options, "staticCanvas");
    canvasValue = Reflect.get(options, "canvas");
    if (canvasValue === null || typeof canvasValue !== "object") {
      throw new TypeError("canvas descriptor is invalid");
    }
    width = Reflect.get(canvasValue, "width");
    height = Reflect.get(canvasValue, "height");
    fit = Reflect.get(canvasValue, "fit");
    colorSpace = Reflect.get(canvasValue, "colorSpace");
    pixelAspectValue = Reflect.get(canvasValue, "pixelAspect");
    if (pixelAspectValue === null || typeof pixelAspectValue !== "object") {
      throw new TypeError("pixel aspect is invalid");
    }
    pixelAspectNumerator = Reflect.get(pixelAspectValue, 0);
    pixelAspectDenominator = Reflect.get(pixelAspectValue, 1);
    maximumWidthValue = Reflect.get(options, "maxBackingWidth");
    maximumHeightValue = Reflect.get(options, "maxBackingHeight");
    maximumBytes = Reflect.get(options, "maxBackingBytes");
    setStaticVisible = Reflect.get(options, "setStaticVisible");
    onClamp = Reflect.get(options, "onClamp");
    createBackend = Reflect.get(options, "createBackend");
    backingResourcesValue = Reflect.get(options, "backingResources");
  } catch {
    throw new TypeError("browser presentation plane options are invalid");
  }
  if (
    animatedCanvas === null ||
    typeof animatedCanvas !== "object" ||
    staticCanvas === null ||
    typeof staticCanvas !== "object" ||
    animatedCanvas === staticCanvas ||
    typeof setStaticVisible !== "function" ||
    (onClamp !== undefined && typeof onClamp !== "function") ||
    (createBackend !== undefined && typeof createBackend !== "function")
  ) {
    throw new TypeError("browser presentation plane options are invalid");
  }
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    (width as number) < 1 ||
    (height as number) < 1 ||
    (width as number) > MAX_LOGICAL_CANVAS_DIMENSION ||
    (height as number) > MAX_LOGICAL_CANVAS_DIMENSION ||
    !PRESENTATION_FIT_MODES.includes(fit as PresentationFit) ||
    colorSpace !== "srgb" ||
    !Number.isSafeInteger(pixelAspectNumerator) ||
    !Number.isSafeInteger(pixelAspectDenominator) ||
    (pixelAspectNumerator as number) < 1 ||
    (pixelAspectDenominator as number) < 1
  ) {
    throw new RangeError("browser presentation canvas descriptor is invalid");
  }
  const maximumWidth = maximumWidthValue ??
    MAX_PRESENTATION_BACKING_DIMENSION;
  const maximumHeight = maximumHeightValue ??
    MAX_PRESENTATION_BACKING_DIMENSION;
  for (const [value, label] of [
    [maximumWidth, "maximum backing width"],
    [maximumHeight, "maximum backing height"],
    [maximumBytes, "maximum backing bytes"]
  ] as const) {
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
      throw new RangeError(`browser presentation ${label} is invalid`);
    }
  }
  if ((maximumBytes as number) < 8) {
    throw new RangeError(
      "browser presentation maximum backing bytes cannot hold both planes"
    );
  }
  const canvas = Object.freeze({
    width: width as number,
    height: height as number,
    fit: fit as PresentationFit,
    pixelAspect: Object.freeze([
      pixelAspectNumerator as number,
      pixelAspectDenominator as number
    ] as const),
    colorSpace: "srgb" as const
  });
  const backingResources = backingResourcesValue === undefined
    ? null
    : captureBackingResources(
        backingResourcesValue as BrowserCanvasBackingResourceHost
      );
  return Object.freeze({
    animatedCanvas: animatedCanvas as HTMLCanvasElement,
    staticCanvas: staticCanvas as HTMLCanvasElement,
    canvas,
    maxBackingWidth: maximumWidth as number,
    maxBackingHeight: maximumHeight as number,
    maxBackingBytes: maximumBytes as number,
    setStaticVisible: setStaticVisible as (visible: boolean) => void,
    onClamp: onClamp as BrowserPresentationPlanesOptions["onClamp"],
    createBackend: createBackend as BrowserPresentationPlanesOptions["createBackend"],
    backingResources
  });
}

function captureBackingResources(
  value: BrowserCanvasBackingResourceHost
): Readonly<BrowserCanvasBackingResourceHost> {
  if (value === null || typeof value !== "object") {
    throw new TypeError("browser canvas backing resource host is malformed");
  }
  let beginTransition: unknown;
  let release: unknown;
  let asynchronous: unknown;
  let asynchronousAfterInitial: unknown;
  try {
    beginTransition = Reflect.get(value, "beginTransition");
    release = Reflect.get(value, "release");
    asynchronous = Reflect.get(value, "asynchronous");
    asynchronousAfterInitial = Reflect.get(value, "asynchronousAfterInitial");
  } catch {
    throw new TypeError("browser canvas backing resource host is inaccessible");
  }
  if (
    typeof beginTransition !== "function" ||
    typeof release !== "function" ||
    (asynchronous !== undefined && typeof asynchronous !== "boolean") ||
    (asynchronousAfterInitial !== undefined &&
      typeof asynchronousAfterInitial !== "boolean")
  ) {
    throw new TypeError("browser canvas backing resource host is malformed");
  }
  let released = false;
  return Object.freeze({
    ...(asynchronous === undefined ? {} : { asynchronous }),
    ...(asynchronousAfterInitial === undefined
      ? {}
      : { asynchronousAfterInitial }),
    beginTransition(
      input: Readonly<BrowserCanvasBackingResourceInput>
    ): BrowserCanvasBackingResourceTransition |
      Promise<BrowserCanvasBackingResourceTransition> {
      if (released) {
        throw new DOMException("canvas backing resources are released", "AbortError");
      }
      const raw = Reflect.apply(
        beginTransition,
        value,
        [input]
      ) as BrowserCanvasBackingResourceTransition |
        PromiseLike<BrowserCanvasBackingResourceTransition>;
      if (isPromiseLike(raw)) {
        return Promise.resolve(raw).then((transition) => {
          if (released) {
            bestEffortTransitionRollbackValue(transition);
            throw new DOMException(
              "canvas backing resources were released during admission",
              "AbortError"
            );
          }
          return captureBackingTransition(transition, () => {
            if (released) throw releasedBackingResourcesError();
          });
        });
      }
      return captureBackingTransition(raw, () => {
        if (released) throw releasedBackingResourcesError();
      });
    },
    release(): void {
      if (released) return;
      released = true;
      Reflect.apply(release, value, []);
    }
  });
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  let then: unknown;
  try { then = Reflect.get(value, "then"); } catch { return false; }
  return typeof then === "function";
}

function bestEffortTransitionRollbackValue(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  let rollback: unknown;
  try { rollback = Reflect.get(value, "rollback"); } catch { return; }
  bestEffortTransitionRollback(value, rollback);
}

function captureBackingTransition(
  value: BrowserCanvasBackingResourceTransition,
  assertOwnerActive: () => void
): BrowserCanvasBackingResourceTransition {
  if (value === null || typeof value !== "object") {
    throw new TypeError("canvas backing resource transition is malformed");
  }
  let commit: unknown;
  let rollback: unknown;
  let assertActive: unknown;
  try {
    rollback = Reflect.get(value, "rollback");
    commit = Reflect.get(value, "commit");
    assertActive = Reflect.get(value, "assertActive");
  } catch {
    bestEffortTransitionRollback(value, rollback);
    throw new TypeError("canvas backing resource transition is inaccessible");
  }
  if (
    typeof commit !== "function" ||
    typeof rollback !== "function" ||
    (assertActive !== undefined && typeof assertActive !== "function")
  ) {
    bestEffortTransitionRollback(value, rollback);
    throw new TypeError("canvas backing resource transition is malformed");
  }
  let state: "active" | "committed" | "rolled-back" = "active";
  return Object.freeze({
    assertActive(): void {
      if (state !== "active") throw settledBackingTransitionError();
      assertOwnerActive();
      if (typeof assertActive === "function") {
        Reflect.apply(assertActive, value, []);
      }
    },
    commit(): void {
      if (state === "committed") return;
      if (state === "rolled-back") throw settledBackingTransitionError();
      assertOwnerActive();
      Reflect.apply(commit, value, []);
      state = "committed";
    },
    rollback(): void {
      if (state !== "active") return;
      try {
        Reflect.apply(rollback, value, []);
      } finally {
        state = "rolled-back";
      }
    }
  });
}

function releasedBackingResourcesError(): DOMException {
  return new DOMException("canvas backing resources are released", "AbortError");
}

function settledBackingTransitionError(): DOMException {
  return new DOMException(
    "canvas backing resource transition is no longer active",
    "AbortError"
  );
}

function bestEffortTransitionRollback(owner: object, rollback: unknown): void {
  if (typeof rollback !== "function") return;
  try {
    Reflect.apply(rollback, owner, []);
  } catch {
    // Preserve the transition capability failure.
  }
}
