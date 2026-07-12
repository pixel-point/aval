import { describe, expect, it } from "vitest";

import { buildDirectFramePlan } from "../src/compile/frame-plan.js";
import { CompilerError } from "../src/diagnostics.js";
import type { MediaProbe } from "../src/model.js";

function probe(overrides: Partial<MediaProbe> = {}): MediaProbe {
  return {
    width: 32,
    height: 32,
    frameRate: { numerator: 30, denominator: 1 },
    timeBase: { numerator: 1, denominator: 30 },
    frameCount: 12,
    durationMicros: 400_000,
    pixelFormat: "yuv420p",
    hasAlpha: false,
    variableFrameRate: false,
    frames: [],
    ...overrides
  };
}

describe("direct frame plan", () => {
  it("splits an optional intro and closed partial loop", () => {
    expect(buildDirectFramePlan(probe(), [3, 10])).toEqual({
      frameRate: { numerator: 30, denominator: 1 },
      units: [
        {
          id: "intro.default",
          kind: "one-shot",
          startFrame: 0,
          endFrame: 3,
          frameCount: 3
        },
        {
          id: "body.default",
          kind: "body",
          startFrame: 3,
          endFrame: 10,
          frameCount: 7
        }
      ],
      staticFrame: 3,
      unusedTrailingFrames: 2,
      warnings: ["2 trailing source frames are unused"]
    });
  });

  it("rejects bad ranges and implicit VFR normalization", () => {
    for (const range of [[-1, 2], [2, 2], [4, 13]] as const) {
      expect(() => buildDirectFramePlan(probe(), range)).toThrow(CompilerError);
    }
    expect(() => buildDirectFramePlan(
      probe({ variableFrameRate: true }),
      [0, 10]
    )).toThrowError(expect.objectContaining({ code: "VFR_UNSUPPORTED" }));
    expect(() => buildDirectFramePlan(
      probe({ variableFrameRate: true }),
      [0, 10],
      { numerator: 24, denominator: 1 },
      true
    )).not.toThrow();
  });

  it("compares hostile safe rational rates without rounded cross-products", () => {
    expect(() => buildDirectFramePlan(
      probe({
        frameRate: {
          numerator: 9_007_199_254_720_999,
          denominator: 150_270_107_566_262
        }
      }),
      [0, 10],
      {
        numerator: 60_000,
        denominator: 1_001
      }
    )).toThrowError(expect.objectContaining({ code: "INPUT_INVALID" }));
  });
});
