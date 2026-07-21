import { VideoCandidateFactory } from "./video-candidate-factory.js";
import {
  BrowserVideoCandidateRendererFactory,
  BrowserVideoCandidateWorkerFactory
} from "./browser-video-candidate-factories.js";
import { BrowserVideoCandidateHub } from "./browser-video-candidate-hub.js";
import { BrowserVideoCandidateReadinessFactory } from "./browser-video-candidate-readiness.js";
import type {
  BrowserVideoCandidateComposition,
  BrowserVideoCandidateCompositionOptions
} from "./browser-video-candidate-contracts.js";

export type {
  BrowserVideoCandidateCleanupSnapshot,
  BrowserVideoCandidateComposition,
  BrowserVideoCandidateCompositionOptions,
  BrowserVideoCandidateControls,
  BrowserVideoCandidateOrderEntry,
  BrowserVideoCandidateSnapshot,
  BrowserVideoCandidateTestDependencies,
  BrowserVideoPlaybackSnapshot,
  BrowserVideoReadPixelsResult,
  BrowserVideoReadinessSnapshot,
  BrowserVideoRendererSnapshot,
  BrowserVideoWorkerSnapshot
} from "./browser-video-candidate-contracts.js";

/** Production codec-neutral browser composition consumed by IntegratedPlayer. */
export function createBrowserVideoCandidateComposition(
  options: Readonly<BrowserVideoCandidateCompositionOptions>
): Readonly<BrowserVideoCandidateComposition> {
  validateOptions(options);
  const hub = new BrowserVideoCandidateHub(
    options.canvas,
    options.diagnosticsSink
  );
  const workerFactory = new BrowserVideoCandidateWorkerFactory({
    hub,
    ...(options.worker === undefined ? {} : { worker: options.worker }),
    ...(options.testDependencies?.createWorkerPort === undefined
      ? {}
      : { createWorkerPort: options.testDependencies.createWorkerPort })
  });
  const rendererFactory = new BrowserVideoCandidateRendererFactory({
    canvas: options.canvas,
    hub,
    ...(options.renderer === undefined ? {} : { backend: options.renderer }),
    ...(options.presentationPlanes === undefined
      ? {}
      : { presentationPlanes: options.presentationPlanes }),
    ...(options.testDependencies?.createFrameBackend === undefined
      ? {}
      : { createFrameBackend: options.testDependencies.createFrameBackend })
  });
  const readinessFactory = new BrowserVideoCandidateReadinessFactory({ hub });
  const contextTarget = options.presentationPlanes?.animatedContextTarget?.();
  const factory = new VideoCandidateFactory({
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

function validateOptions(
  options: Readonly<BrowserVideoCandidateCompositionOptions>
): void {
  if (
    options === null ||
    typeof options !== "object" ||
    options.canvas === null ||
    typeof options.canvas !== "object" ||
    typeof options.canvas.getContext !== "function"
  ) throw new TypeError("browser video composition requires a canvas");
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
    throw new TypeError("browser video presentation planes are malformed");
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
