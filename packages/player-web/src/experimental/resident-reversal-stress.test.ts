import { describe, expect, it } from "vitest";

import { createResidentFramePlan } from "./resident-frame-plan.js";
import {
  RESIDENT_REVERSAL_STRESS_CHANGES,
  runResidentReversalStress,
  type ResidentReversalDrawTarget
} from "./resident-reversal-stress.js";
import type {
  RenderFrameHandle,
  ResidentFrameHandle
} from "./webgl-frame-renderer.js";

describe("runResidentReversalStress", () => {
  it("draws 1,000 exact adjacent direction changes and converges to source", async () => {
    const plan = createPlan(12);
    const renderer = new FakeDrawTarget();
    const validated: Array<[number | null, string, number]> = [];

    const report = await runResidentReversalStress({
      plan,
      renderer,
      sourceEndpoint: "resting",
      targetEndpoint: "engaged",
      validateDraw: ({ reversal, expectedKey }) => {
        validated.push([reversal, expectedKey.unit, expectedKey.localFrame]);
      }
    });

    expect(report).toMatchObject({
      directionChanges: RESIDENT_REVERSAL_STRESS_CHANGES,
      lowerBounceFrame: 5,
      upperBounceFrame: 6,
      finalEndpoint: "resting",
      finalPhase: "stable",
      adjacentFrameFailures: 0
    });
    expect(report.residentDraws).toBe(renderer.layers.length);
    expect(report.validatedDraws).toBe(validated.length);
    expect(
      validated.filter(([reversal]) => reversal !== null)
    ).toHaveLength(RESIDENT_REVERSAL_STRESS_CHANGES);

    const reversalFrames = validated
      .filter(([reversal]) => reversal !== null)
      .map(([, unit, frame]) => [unit, frame]);
    expect(reversalFrames.slice(0, 6)).toEqual([
      ["clip", 5],
      ["clip", 6],
      ["clip", 5],
      ["clip", 6],
      ["clip", 5],
      ["clip", 6]
    ]);
    expect(renderer.layers.every((layer) => Number.isSafeInteger(layer))).toBe(
      true
    );
  });

  it("supports a two-frame clip without repeating either reversal boundary", async () => {
    const plan = createPlan(2);
    const renderer = new FakeDrawTarget();
    const report = await runResidentReversalStress({
      plan,
      renderer,
      sourceEndpoint: "a",
      targetEndpoint: "b",
      directionChanges: 7
    });

    expect(report).toMatchObject({
      directionChanges: 7,
      lowerBounceFrame: 0,
      upperBounceFrame: 1,
      finalEndpoint: "a"
    });
  });

  it("rejects a one-frame clip because adjacent reversal cannot be measured", async () => {
    await expect(
      runResidentReversalStress({
        plan: createPlan(1),
        renderer: new FakeDrawTarget(),
        sourceEndpoint: "a",
        targetEndpoint: "b"
      })
    ).rejects.toThrow(/at least two clip frames/);
  });
});

function createPlan(clipFrames: number) {
  return createResidentFramePlan({
    width: 2,
    height: 2,
    sourceRunway: Array.from({ length: 8 }, (_, index) => ({
      rendition: "main",
      unit: "source",
      localFrame: index
    })),
    clip: Array.from({ length: clipFrames }, (_, index) => ({
      rendition: "main",
      unit: "clip",
      localFrame: index
    })),
    targetRunway: Array.from({ length: 8 }, (_, index) => ({
      rendition: "main",
      unit: "target",
      localFrame: index
    })),
    deviceLimits: {
      maxArrayTextureLayers: 128,
      maxTextureSize: 4_096
    }
  });
}

class FakeDrawTarget implements ResidentReversalDrawTarget {
  public readonly layers: number[] = [];

  public residentHandle(layer: number): ResidentFrameHandle {
    return {
      kind: "resident",
      layer,
      resourceGeneration: 1
    };
  }

  public draw(handle: RenderFrameHandle): void {
    if (handle.kind !== "resident") {
      throw new Error("stress test received a streaming handle");
    }
    this.layers.push(handle.layer);
  }
}
