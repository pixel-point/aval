import { OpaqueCandidateFactory } from "./opaque-candidate-factory.js";
import {
  BrowserOpaqueCandidateRendererFactory,
  BrowserOpaqueCandidateWorkerFactory
} from "./browser-opaque-candidate-factories.js";
import { BrowserOpaqueCandidateHub } from "./browser-opaque-candidate-hub.js";
import { BrowserOpaqueCandidateReadinessFactory } from "./browser-opaque-candidate-readiness.js";
import type {
  BrowserOpaqueCandidateComposition,
  BrowserOpaqueCandidateCompositionOptions
} from "./browser-opaque-candidate-contracts.js";

export type {
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
} from "./browser-opaque-candidate-contracts.js";
export {
  BrowserOpaqueCandidateRendererFactory,
  BrowserOpaqueCandidateWorkerFactory
} from "./browser-opaque-candidate-factories.js";
export { BrowserOpaqueCandidateReadinessFactory } from "./browser-opaque-candidate-readiness.js";
export { BrowserOpaquePlaybackSession } from "./browser-opaque-playback-session.js";

/** Production browser composition root consumed by IntegratedPlayer. */
export function createBrowserOpaqueCandidateComposition(
  options: Readonly<BrowserOpaqueCandidateCompositionOptions>
): Readonly<BrowserOpaqueCandidateComposition> {
  validateOptions(options);
  const hub = new BrowserOpaqueCandidateHub(
    options.canvas,
    options.diagnosticsSink
  );
  const workerFactory = new BrowserOpaqueCandidateWorkerFactory({
    hub,
    ...(options.worker === undefined ? {} : { worker: options.worker }),
    ...(options.testDependencies?.createWorkerPort === undefined
      ? {}
      : { createWorkerPort: options.testDependencies.createWorkerPort })
  });
  const rendererFactory = new BrowserOpaqueCandidateRendererFactory({
    canvas: options.canvas,
    hub,
    ...(options.renderer === undefined ? {} : { backend: options.renderer }),
    ...(options.testDependencies?.createBackend === undefined
      ? {}
      : { createBackend: options.testDependencies.createBackend })
  });
  const readinessFactory = new BrowserOpaqueCandidateReadinessFactory({ hub });
  const factory = new OpaqueCandidateFactory({
    workerFactory,
    rendererFactory,
    readinessFactory,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.timers === undefined ? {} : { timers: options.timers })
  });
  return Object.freeze({ factory, controls: hub });
}

function validateOptions(
  options: Readonly<BrowserOpaqueCandidateCompositionOptions>
): void {
  if (
    options === null ||
    typeof options !== "object" ||
    options.canvas === null ||
    typeof options.canvas !== "object" ||
    typeof options.canvas.getContext !== "function"
  ) throw new TypeError("browser opaque composition requires a canvas");
  if (
    options.diagnosticsSink !== undefined &&
    typeof options.diagnosticsSink !== "function"
  ) throw new TypeError("browser diagnostics sink must be a function");
}
