import { AvcCandidateFactory } from "./avc-candidate-factory.js";
import {
  BrowserAvcCandidateRendererFactory,
  BrowserAvcCandidateWorkerFactory
} from "./browser-avc-candidate-factories.js";
import { BrowserAvcCandidateHub } from "./browser-avc-candidate-hub.js";
import { BrowserAvcCandidateReadinessFactory } from "./browser-avc-candidate-readiness.js";
import type {
  BrowserAvcCandidateComposition,
  BrowserAvcCandidateCompositionOptions
} from "./browser-avc-candidate-contracts.js";

export type {
  BrowserAvcCandidateComposition,
  BrowserAvcCandidateCompositionOptions,
  BrowserAvcCandidateControls,
  BrowserAvcCandidateSnapshot,
  BrowserAvcCleanupSnapshot,
  BrowserAvcPlaybackSnapshot,
  BrowserAvcReadPixelsResult,
  BrowserAvcReadinessSnapshot,
  BrowserAvcRendererSnapshot,
  BrowserAvcWorkerSnapshot,
  BrowserOpaqueCandidateComposition,
  BrowserOpaqueCandidateCompositionOptions,
  BrowserOpaqueCandidateControls,
  BrowserOpaqueCandidateSnapshot,
  BrowserOpaqueCleanupSnapshot,
  BrowserOpaquePlaybackSnapshot,
  BrowserOpaqueReadPixelsResult,
  BrowserOpaqueReadinessSnapshot,
  BrowserOpaqueRendererSnapshot,
  BrowserOpaqueWorkerSnapshot
} from "./browser-avc-candidate-contracts.js";
export {
  BrowserAvcCandidateRendererFactory,
  BrowserAvcCandidateWorkerFactory,
  BrowserOpaqueCandidateRendererFactory,
  BrowserOpaqueCandidateWorkerFactory
} from "./browser-avc-candidate-factories.js";
export {
  BrowserAvcCandidateReadinessFactory,
  BrowserOpaqueCandidateReadinessFactory
} from "./browser-avc-candidate-readiness.js";
export {
  BrowserAvcPlaybackSession,
  BrowserOpaquePlaybackSession
} from "./browser-avc-playback-session.js";

/** Production browser composition root consumed by IntegratedPlayer. */
export function createBrowserAvcCandidateComposition(
  options: Readonly<BrowserAvcCandidateCompositionOptions>
): Readonly<BrowserAvcCandidateComposition> {
  validateOptions(options);
  const hub = new BrowserAvcCandidateHub(
    options.canvas,
    options.diagnosticsSink
  );
  const workerFactory = new BrowserAvcCandidateWorkerFactory({
    hub,
    ...(options.worker === undefined ? {} : { worker: options.worker }),
    ...(options.testDependencies?.createWorkerPort === undefined
      ? {}
      : { createWorkerPort: options.testDependencies.createWorkerPort })
  });
  const rendererFactory = new BrowserAvcCandidateRendererFactory({
    canvas: options.canvas,
    hub,
    ...(options.renderer === undefined ? {} : { backend: options.renderer }),
    ...(options.presentationPlanes === undefined
      ? {}
      : { presentationPlanes: options.presentationPlanes }),
    ...(options.testDependencies?.createBackend === undefined
      ? {}
      : { createBackend: options.testDependencies.createBackend }),
    ...(options.testDependencies?.createFrameBackend === undefined
      ? {}
      : { createFrameBackend: options.testDependencies.createFrameBackend })
  });
  const readinessFactory = new BrowserAvcCandidateReadinessFactory({ hub });
  const contextTarget = options.presentationPlanes?.animatedContextTarget?.();
  const factory = new AvcCandidateFactory({
    workerFactory,
    rendererFactory,
    readinessFactory,
    ...(options.presentationPlanes === undefined
      ? {}
      : { resourceHost: options.presentationPlanes }),
    ...(contextTarget === undefined ? {} : { contextTarget }),
    ...(options.resourceAuthority === undefined
      ? {}
      : { resourceAuthority: options.resourceAuthority }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.timers === undefined ? {} : { timers: options.timers })
  });
  return Object.freeze({ factory, controls: hub });
}

/** @deprecated Use createBrowserAvcCandidateComposition. */
export const createBrowserOpaqueCandidateComposition =
  createBrowserAvcCandidateComposition;

function validateOptions(
  options: Readonly<BrowserAvcCandidateCompositionOptions>
): void {
  if (
    options === null ||
    typeof options !== "object" ||
    options.canvas === null ||
    typeof options.canvas !== "object" ||
    typeof options.canvas.getContext !== "function"
  ) throw new TypeError("browser AVC composition requires a canvas");
  if (
    options.presentationPlanes !== undefined &&
    (
      options.presentationPlanes === null ||
      typeof options.presentationPlanes !== "object" ||
      typeof options.presentationPlanes.createFrameBackend !== "function" ||
      typeof options.presentationPlanes.currentCanvasBacking !== "function" ||
      typeof options.presentationPlanes.reserveCanvasResources !== "function" ||
      typeof options.presentationPlanes.ownsAnimatedCanvas !== "function" ||
      (
        options.presentationPlanes.animatedContextTarget !== undefined &&
        typeof options.presentationPlanes.animatedContextTarget !== "function"
      ) ||
      !options.presentationPlanes.ownsAnimatedCanvas(options.canvas)
    )
  ) {
    throw new TypeError("browser AVC presentation planes are malformed");
  }
  if (
    options.diagnosticsSink !== undefined &&
    typeof options.diagnosticsSink !== "function"
  ) throw new TypeError("browser diagnostics sink must be a function");
  if (
    options.resourceAuthority !== undefined &&
    (
      options.resourceAuthority === null ||
      typeof options.resourceAuthority !== "object" ||
      typeof options.resourceAuthority.reservePlan !== "function" ||
      typeof options.resourceAuthority.requestDecoder !== "function"
    )
  ) {
    throw new TypeError("browser candidate resource authority is malformed");
  }
}
