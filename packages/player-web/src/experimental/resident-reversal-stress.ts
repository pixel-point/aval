import type {
  ResidentFrameKey,
  ResidentFramePlan
} from "./resident-frame-plan.js";
import {
  ReversibleClipController,
  type ReversibleClipPresentation,
  type ReversibleClipTraceRecord
} from "./reversible-clip-controller.js";
import type {
  RenderFrameHandle,
  ResidentFrameHandle
} from "./webgl-frame-renderer.js";

export const RESIDENT_REVERSAL_STRESS_CHANGES = 1_000;

export interface ResidentReversalDrawTarget {
  residentHandle(layer: number): ResidentFrameHandle;
  draw(handle: RenderFrameHandle): void;
}

export interface ResidentReversalValidationContext<TEndpoint extends string> {
  readonly reversal: number | null;
  readonly expectedKey: Readonly<ResidentFrameKey>;
  readonly presentation: ReversibleClipPresentation<TEndpoint>;
  readonly trace: ReversibleClipTraceRecord<TEndpoint>;
}

export interface ResidentReversalStressOptions<TEndpoint extends string> {
  readonly plan: ResidentFramePlan;
  readonly renderer: ResidentReversalDrawTarget;
  readonly sourceEndpoint: TEndpoint;
  readonly targetEndpoint: TEndpoint;
  readonly directionChanges?: number;
  readonly validateDraw?: (
    context: Readonly<ResidentReversalValidationContext<TEndpoint>>
  ) => void | Promise<void>;
}

export interface ResidentReversalStressReport<TEndpoint extends string> {
  readonly directionChanges: number;
  readonly residentDraws: number;
  readonly validatedDraws: number;
  readonly lowerBounceFrame: number;
  readonly upperBounceFrame: number;
  readonly finalEndpoint: TEndpoint;
  readonly finalPhase: "stable";
  readonly adjacentFrameFailures: 0;
}

/**
 * Exercises cached direction changes without wall-clock delay. Every reversal
 * still advances the exact controller by one content tick and issues a real
 * resident draw, so browser callers can attach GPU readback validation.
 */
export async function runResidentReversalStress<TEndpoint extends string>(
  options: ResidentReversalStressOptions<TEndpoint>
): Promise<ResidentReversalStressReport<TEndpoint>> {
  const directionChanges = validateDirectionChanges(
    options.directionChanges ?? RESIDENT_REVERSAL_STRESS_CHANGES
  );
  const clipFrameCount = options.plan.clipLayers.length;
  if (clipFrameCount < 2) {
    throw new RangeError("resident reversal stress needs at least two clip frames");
  }

  const controller = new ReversibleClipController({
    sourceEndpoint: options.sourceEndpoint,
    targetEndpoint: options.targetEndpoint,
    clipFrameCount,
    sourceRunwayFrameCount: options.plan.sourceRunwayLayers.length,
    targetRunwayFrameCount: options.plan.targetRunwayLayers.length
  });
  const lowerBounceFrame = Math.max(0, Math.floor((clipFrameCount - 1) / 2));
  const upperBounceFrame = lowerBounceFrame + 1;
  let residentDraws = 0;
  let validatedDraws = 0;

  const draw = async (
    trace: ReversibleClipTraceRecord<TEndpoint>,
    reversal: number | null
  ): Promise<void> => {
    const layer = layerForPresentation(options.plan, trace.presentation);
    if (layer === null) {
      return;
    }
    const expected = options.plan.uniqueFrames[layer];
    if (expected === undefined || expected.layer !== layer) {
      throw new Error(`resident plan has no frame identity for layer ${String(layer)}`);
    }
    options.renderer.draw(options.renderer.residentHandle(layer));
    residentDraws += 1;
    if (options.validateDraw !== undefined) {
      await options.validateDraw(
        Object.freeze({
          reversal,
          expectedKey: expected.key,
          presentation: trace.presentation,
          trace
        })
      );
      validatedDraws += 1;
    }
  };

  controller.request(options.targetEndpoint);
  let trace = controller.tick({ portalEndpoint: options.sourceEndpoint });
  await draw(trace, null);
  while (
    trace.presentation.kind !== "clip" ||
    trace.presentation.frameIndex < upperBounceFrame
  ) {
    trace = controller.tick();
    await draw(trace, null);
  }

  let previousFrame = requireClipFrame(trace);
  for (let reversal = 1; reversal <= directionChanges; reversal += 1) {
    const direction = controller.snapshot().direction;
    if (direction === null) {
      throw new Error("resident reversal stress left the active clip");
    }
    controller.request(
      direction === "forward"
        ? options.sourceEndpoint
        : options.targetEndpoint
    );
    trace = controller.tick();
    const currentFrame = requireClipFrame(trace);
    if (Math.abs(currentFrame - previousFrame) !== 1) {
      throw new Error(
        `reversal ${String(reversal)} moved from clip frame ${String(previousFrame)} to ${String(currentFrame)}`
      );
    }
    previousFrame = currentFrame;
    await draw(trace, reversal);
  }

  controller.request(options.sourceEndpoint);
  const settleBound = clipFrameCount + options.plan.sourceRunwayLayers.length + 2;
  for (let step = 0; step < settleBound; step += 1) {
    if (
      controller.snapshot().phase === "stable" &&
      controller.snapshot().visualEndpoint === options.sourceEndpoint
    ) {
      break;
    }
    trace = controller.tick({ portalEndpoint: options.targetEndpoint });
    await draw(trace, null);
  }

  const finalSnapshot = controller.snapshot();
  if (
    finalSnapshot.phase !== "stable" ||
    finalSnapshot.visualEndpoint !== options.sourceEndpoint
  ) {
    throw new Error("resident reversal stress did not converge to its source endpoint");
  }

  return Object.freeze({
    directionChanges,
    residentDraws,
    validatedDraws,
    lowerBounceFrame,
    upperBounceFrame,
    finalEndpoint: finalSnapshot.visualEndpoint,
    finalPhase: "stable",
    adjacentFrameFailures: 0
  });
}

function layerForPresentation<TEndpoint extends string>(
  plan: ResidentFramePlan,
  presentation: ReversibleClipPresentation<TEndpoint>
): number | null {
  if (presentation.kind === "stable") {
    return null;
  }
  if (presentation.kind === "clip") {
    return plan.clipLayers[presentation.frameIndex] ?? null;
  }
  const layers =
    presentation.direction === "forward"
      ? plan.targetRunwayLayers
      : plan.sourceRunwayLayers;
  return layers[presentation.frameIndex] ?? null;
}

function requireClipFrame<TEndpoint extends string>(
  trace: ReversibleClipTraceRecord<TEndpoint>
): number {
  if (trace.presentation.kind !== "clip") {
    throw new Error("resident reversal stress expected an active clip frame");
  }
  return trace.presentation.frameIndex;
}

function validateDirectionChanges(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("direction changes must be a positive safe integer");
  }
  return value;
}
