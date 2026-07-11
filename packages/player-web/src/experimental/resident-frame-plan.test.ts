import { describe, expect, it } from "vitest";

import {
  MAX_ENDPOINT_RUNWAY_FRAMES,
  MAX_RESIDENT_FRAME_BYTES,
  MAX_RESIDENT_FRAME_LAYERS,
  MAX_REVERSIBLE_CLIP_BYTES,
  MAX_REVERSIBLE_CLIP_FRAMES,
  MAX_TRACKED_PLAYER_BYTES,
  MIN_ENDPOINT_RUNWAY_FRAMES,
  MIN_REVERSIBLE_CLIP_FRAMES,
  STREAMING_SLOT_COUNT,
  createResidentFramePlan,
  type ResidentFrameKey,
  type ResidentFramePlanInput
} from "./resident-frame-plan.js";

const MEBIBYTE = 1024 * 1024;

describe("resident frame plan", () => {
  it("deduplicates semantic identities in stable first-occurrence order", () => {
    const mutableSourceZero = {
      rendition: "main",
      unit: "source",
      localFrame: 0
    };
    const input = validInput({
      sourceRunway: [
        mutableSourceZero,
        ...frames("source", 5, 1)
      ],
      clip: [
        frame("source", 5),
        frame("clip", 1),
        frame("clip", 2),
        frame("clip", 3)
      ],
      targetRunway: [
        ...frames("target", 5),
        frame("clip", 3)
      ]
    });

    const plan = createResidentFramePlan(input);

    expect(plan.layerCount).toBe(14);
    expect(plan.sourceRunwayLayers).toEqual([0, 1, 2, 3, 4, 5]);
    expect(plan.clipLayers).toEqual([5, 6, 7, 8]);
    expect(plan.targetRunwayLayers).toEqual([9, 10, 11, 12, 13, 8]);
    expect(
      plan.uniqueFrames.map(({ key, layer }) => [
        key.unit,
        key.localFrame,
        layer
      ])
    ).toEqual([
        ["source", 0, 0],
        ["source", 1, 1],
        ["source", 2, 2],
        ["source", 3, 3],
        ["source", 4, 4],
        ["source", 5, 5],
        ["clip", 1, 6],
        ["clip", 2, 7],
        ["clip", 3, 8],
        ["target", 0, 9],
        ["target", 1, 10],
        ["target", 2, 11],
        ["target", 3, 12],
        ["target", 4, 13]
      ]);
    expect(
      plan.layerFor({ rendition: "main", unit: "clip", localFrame: 3 })
    ).toBe(8);
    expect(
      plan.layerFor({ rendition: "main", unit: "missing", localFrame: 0 })
    ).toBeUndefined();

    mutableSourceZero.unit = "mutated-after-planning";
    expect(plan.uniqueFrames[0]?.key.unit).toBe("source");
    expect(plan.layerFor(frame("source", 0))).toBe(0);
  });

  it("keeps all public planning data immutable", () => {
    const plan = createResidentFramePlan(validInput());

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.uniqueFrames)).toBe(true);
    expect(Object.isFrozen(plan.uniqueFrames[0])).toBe(true);
    expect(Object.isFrozen(plan.uniqueFrames[0]?.key)).toBe(true);
    expect(Object.isFrozen(plan.sourceRunwayLayers)).toBe(true);
    expect(Object.isFrozen(plan.clipLayers)).toBe(true);
    expect(Object.isFrozen(plan.targetRunwayLayers)).toBe(true);
  });

  it("tracks the resident array, three streaming layers, GPU overhead, and staging", () => {
    const plan = createResidentFramePlan(
      validInput({
        width: 256,
        height: 256,
        sourceRunway: frames("source", 8),
        clip: frames("clip", 12),
        targetRunway: frames("target", 8)
      })
    );

    expect(STREAMING_SLOT_COUNT).toBe(3);
    expect(plan.layerCount).toBe(28);
    expect(plan.bytesPerFrame).toBe(262_144);
    expect(plan.residentBytes).toBe(7_340_032);
    expect(plan.residentAllocationBytes).toBe(9_175_040);
    expect(plan.streamingBytes).toBe(786_432);
    expect(plan.streamingAllocationBytes).toBe(983_040);
    expect(plan.gpuAllocationBytes).toBe(10_158_080);
    expect(plan.stagingBytes).toBe(262_144);
    expect(plan.trackedBytes).toBe(10_420_224);
  });

  it("uses all three key fields and never pixel-like or object identity", () => {
    const source = frames("shared", 6);
    const plan = createResidentFramePlan(
      validInput({
        sourceRunway: source,
        clip: [
          { ...source[0]! },
          frame("shared", 0, "alternate"),
          frame("shared", 1),
          frame("different-unit", 0)
        ],
        targetRunway: frames("target", 6)
      })
    );

    expect(plan.clipLayers[0]).toBe(plan.sourceRunwayLayers[0]);
    expect(plan.clipLayers[1]).not.toBe(plan.sourceRunwayLayers[0]);
    expect(plan.clipLayers[2]).toBe(plan.sourceRunwayLayers[1]);
    expect(plan.clipLayers[3]).not.toBe(plan.sourceRunwayLayers[0]);
    expect(plan.clipBytes).toBe(plan.bytesPerFrame * 4);
  });

  it.each([
    [MIN_REVERSIBLE_CLIP_FRAMES, "minimum"],
    [MAX_REVERSIBLE_CLIP_FRAMES, "maximum"]
  ])("accepts the %s-frame reversible clip %s", (count) => {
    expect(() =>
      createResidentFramePlan(validInput({ clip: frames("clip", count) }))
    ).not.toThrow();
  });

  it.each([0, MAX_REVERSIBLE_CLIP_FRAMES + 1])(
    "rejects a %s-frame reversible clip",
    (count) => {
      expect(() =>
        createResidentFramePlan(validInput({ clip: frames("clip", count) }))
      ).toThrow("reversible clip must contain 1–24 frames");
    }
  );

  it.each([
    [MIN_ENDPOINT_RUNWAY_FRAMES, "minimum"],
    [MAX_ENDPOINT_RUNWAY_FRAMES, "maximum"]
  ])("accepts %s-frame endpoint runways at the %s", (count) => {
    expect(() =>
      createResidentFramePlan(
        validInput({
          sourceRunway: frames("source", count),
          targetRunway: frames("target", count)
        })
      )
    ).not.toThrow();
  });

  it.each([
    ["sourceRunway", MIN_ENDPOINT_RUNWAY_FRAMES - 1],
    ["sourceRunway", MAX_ENDPOINT_RUNWAY_FRAMES + 1],
    ["targetRunway", MIN_ENDPOINT_RUNWAY_FRAMES - 1],
    ["targetRunway", MAX_ENDPOINT_RUNWAY_FRAMES + 1]
  ] as const)("rejects %s with %s frames", (field, count) => {
    expect(() =>
      createResidentFramePlan(
        validInput({ [field]: frames(field, count) })
      )
    ).toThrow("endpoint runway must contain 6–12 frames");
  });

  it("accepts exact device dimensions and rejects one over", () => {
    expect(() =>
      createResidentFramePlan(
        validInput({
          width: 64,
          height: 64,
          deviceLimits: { maxArrayTextureLayers: 128, maxTextureSize: 64 }
        })
      )
    ).not.toThrow();

    expect(() =>
      createResidentFramePlan(
        validInput({
          width: 65,
          deviceLimits: { maxArrayTextureLayers: 128, maxTextureSize: 64 }
        })
      )
    ).toThrow("width exceeds MAX_TEXTURE_SIZE");
    expect(() =>
      createResidentFramePlan(
        validInput({
          height: 65,
          deviceLimits: { maxArrayTextureLayers: 128, maxTextureSize: 64 }
        })
      )
    ).toThrow("height exceeds MAX_TEXTURE_SIZE");
  });

  it("accepts the exact device layer count and rejects one over", () => {
    const input = validInput();
    const expectedLayers =
      input.sourceRunway.length + input.clip.length + input.targetRunway.length;

    expect(expectedLayers).toBeLessThan(MAX_RESIDENT_FRAME_LAYERS);
    expect(
      createResidentFramePlan({
        ...input,
        deviceLimits: {
          ...input.deviceLimits,
          maxArrayTextureLayers: expectedLayers
        }
      }).layerCount
    ).toBe(expectedLayers);
    expect(() =>
      createResidentFramePlan({
        ...input,
        deviceLimits: {
          ...input.deviceLimits,
          maxArrayTextureLayers: expectedLayers - 1
        }
      })
    ).toThrow(`exceeds layer limit ${expectedLayers - 1}`);
  });

  it("accepts exactly 24 MiB of deduplicated clip data", () => {
    const plan = createResidentFramePlan(
      validInput({
        width: 512,
        height: 512,
        sourceRunway: repeated(frame("clip", 0), 6),
        clip: frames("clip", 24),
        targetRunway: repeated(frame("clip", 23), 6)
      })
    );

    expect(plan.bytesPerFrame).toBe(MEBIBYTE);
    expect(plan.clipBytes).toBe(MAX_REVERSIBLE_CLIP_BYTES);
    expect(plan.residentBytes).toBe(MAX_REVERSIBLE_CLIP_BYTES);
    expect(plan.streamingBytes).toBe(3 * MEBIBYTE);
    expect(plan.trackedBytes).toBe((139 * MEBIBYTE) / 4);
  });

  it("rejects the smallest RGBA-aligned value above the clip byte cap", () => {
    const shared = frame("shared", 0);
    expect(() =>
      createResidentFramePlan(
        validInput({
          width: MAX_REVERSIBLE_CLIP_BYTES / 4 + 1,
          height: 1,
          sourceRunway: repeated(shared, 6),
          clip: [shared],
          targetRunway: repeated(shared, 6),
          deviceLimits: {
            maxArrayTextureLayers: 128,
            maxTextureSize: MAX_REVERSIBLE_CLIP_BYTES / 4 + 1
          }
        })
      )
    ).toThrow("clip bytes exceed the 24 MiB cap");
  });

  it("accepts 47 MiB of resident data beneath the stricter tracked cap", () => {
    const target = frames("target", 12);
    target[11] = frame("source", 0);
    const plan = createResidentFramePlan(
      validInput({
        width: 512,
        height: 512,
        sourceRunway: frames("source", 12),
        clip: frames("clip", 24),
        targetRunway: target
      })
    );

    expect(plan.layerCount).toBe(47);
    expect(plan.clipBytes).toBe(MAX_REVERSIBLE_CLIP_BYTES);
    expect(plan.residentBytes).toBe(47 * MEBIBYTE);
    expect(plan.trackedBytes).toBe((127 * MEBIBYTE) / 2);
  });

  it("rejects 48 MiB of resident data when streaming and staging exceed the tracked cap", () => {
    expect(() =>
      createResidentFramePlan(
        validInput({
          width: 512,
          height: 512,
          sourceRunway: frames("source", 12),
          clip: frames("clip", 24),
          targetRunway: frames("target", 12)
        })
      )
    ).toThrow("tracked player bytes exceed the 64 MiB cap");
  });

  it("rejects the first practical RGBA-aligned value above the resident cap", () => {
    const pixelsPerFrame = Math.floor(MAX_RESIDENT_FRAME_BYTES / 4 / 47) + 1;
    const clip = [...frames("clip", 23), frame("clip", 0)];

    expect(47 * pixelsPerFrame * 4).toBeGreaterThan(
      MAX_RESIDENT_FRAME_BYTES
    );
    expect(23 * pixelsPerFrame * 4).toBeLessThanOrEqual(
      MAX_REVERSIBLE_CLIP_BYTES
    );
    expect(() =>
      createResidentFramePlan(
        validInput({
          width: pixelsPerFrame,
          height: 1,
          sourceRunway: frames("source", 12),
          clip,
          targetRunway: frames("target", 12),
          deviceLimits: {
            maxArrayTextureLayers: 128,
            maxTextureSize: pixelsPerFrame
          }
        })
      )
    ).toThrow("resident frame bytes exceed the 48 MiB cap");
  });

  it("accepts exactly 64 MiB of tracked player data", () => {
    const source = frames("source", 6);
    const plan = createResidentFramePlan(
      validInput({
        width: 1_024,
        height: 1_024,
        sourceRunway: source,
        clip: frames("clip", 3),
        targetRunway: source.map((key) => ({ ...key }))
      })
    );

    expect(plan.layerCount).toBe(9);
    expect(plan.clipBytes).toBe(12 * MEBIBYTE);
    expect(plan.residentBytes).toBe(36 * MEBIBYTE);
    expect(plan.residentAllocationBytes).toBe(45 * MEBIBYTE);
    expect(plan.streamingBytes).toBe(12 * MEBIBYTE);
    expect(plan.streamingAllocationBytes).toBe(15 * MEBIBYTE);
    expect(plan.gpuAllocationBytes).toBe(60 * MEBIBYTE);
    expect(plan.stagingBytes).toBe(4 * MEBIBYTE);
    expect(plan.trackedBytes).toBe(MAX_TRACKED_PLAYER_BYTES);
  });

  it("rejects the smallest pixel-aligned tracked value above 64 MiB for nine layers", () => {
    const pixelsPerFrame = Math.floor(MAX_TRACKED_PLAYER_BYTES / 64) + 1;
    const source = frames("source", 6);
    const clip = frames("clip", 3);

    expect(64 * pixelsPerFrame).toBeGreaterThan(MAX_TRACKED_PLAYER_BYTES);
    expect(36 * pixelsPerFrame).toBeLessThanOrEqual(
      MAX_RESIDENT_FRAME_BYTES
    );
    expect(12 * pixelsPerFrame).toBeLessThanOrEqual(
      MAX_REVERSIBLE_CLIP_BYTES
    );
    expect(() =>
      createResidentFramePlan(
        validInput({
          width: pixelsPerFrame,
          height: 1,
          sourceRunway: source,
          clip,
          targetRunway: source.map((key) => ({ ...key })),
          deviceLimits: {
            maxArrayTextureLayers: 128,
            maxTextureSize: pixelsPerFrame
          }
        })
      )
    ).toThrow("tracked player bytes exceed the 64 MiB cap");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid dimensions and device limits: %s",
    (value) => {
      expect(() =>
        createResidentFramePlan(validInput({ width: value }))
      ).toThrow(RangeError);
      expect(() =>
        createResidentFramePlan(validInput({ height: value }))
      ).toThrow(RangeError);
      expect(() =>
        createResidentFramePlan(
          validInput({
            deviceLimits: {
              maxArrayTextureLayers: value,
              maxTextureSize: 4_096
            }
          })
        )
      ).toThrow(RangeError);
      expect(() =>
        createResidentFramePlan(
          validInput({
            deviceLimits: {
              maxArrayTextureLayers: 128,
              maxTextureSize: value
            }
          })
        )
      ).toThrow(RangeError);
    }
  );

  it("rejects malformed frame keys and non-array sequences", () => {
    for (const malformed of [
      { rendition: " ", unit: "clip", localFrame: 0 },
      { rendition: "main", unit: "", localFrame: 0 },
      { rendition: "main", unit: "clip", localFrame: -1 },
      { rendition: "main", unit: "clip", localFrame: 1.5 },
      {
        rendition: "main",
        unit: "clip",
        localFrame: Number.MAX_SAFE_INTEGER + 1
      }
    ]) {
      expect(() =>
        createResidentFramePlan(
          validInput({ clip: [malformed, ...frames("clip", 5)] })
        )
      ).toThrow("must have non-empty rendition and unit strings");
    }

    expect(() =>
      createResidentFramePlan(
        validInput({ clip: {} as readonly ResidentFrameKey[] })
      )
    ).toThrow("reversible clip must be an array");
  });

  it("rejects malformed top-level and device-limit objects", () => {
    expect(() =>
      createResidentFramePlan(null as unknown as ResidentFramePlanInput)
    ).toThrow("resident frame plan input must be an object");
    expect(() =>
      createResidentFramePlan(
        validInput({
          deviceLimits: null as unknown as ResidentFramePlanInput["deviceLimits"]
        })
      )
    ).toThrow("resident frame device limits must be an object");
  });

  it("uses checked integer arithmetic for adversarial safe dimensions", () => {
    const shared = frame("shared", 0);
    expect(() =>
      createResidentFramePlan(
        validInput({
          width: Number.MAX_SAFE_INTEGER,
          height: Number.MAX_SAFE_INTEGER,
          sourceRunway: repeated(shared, 6),
          clip: [shared],
          targetRunway: repeated(shared, 6),
          deviceLimits: {
            maxArrayTextureLayers: 128,
            maxTextureSize: Number.MAX_SAFE_INTEGER
          }
        })
      )
    ).toThrow("clip bytes exceed the 24 MiB cap");
  });

  it("returns undefined rather than aliasing malformed lookup keys", () => {
    const plan = createResidentFramePlan(validInput());
    expect(plan.layerFor(null as unknown as ResidentFrameKey)).toBeUndefined();
    expect(
      plan.layerFor({
        rendition: "main",
        unit: "source",
        localFrame: -1
      })
    ).toBeUndefined();
  });
});

function validInput(
  overrides: Partial<ResidentFramePlanInput> = {}
): ResidentFramePlanInput {
  return {
    width: 64,
    height: 64,
    sourceRunway: frames("source", 6),
    clip: frames("clip", 4),
    targetRunway: frames("target", 6),
    deviceLimits: {
      maxArrayTextureLayers: MAX_RESIDENT_FRAME_LAYERS,
      maxTextureSize: 4_096
    },
    ...overrides
  };
}

function frame(
  unit: string,
  localFrame: number,
  rendition = "main"
): ResidentFrameKey {
  return { rendition, unit, localFrame };
}

function frames(
  unit: string,
  count: number,
  start = 0,
  rendition = "main"
): ResidentFrameKey[] {
  return Array.from({ length: count }, (_, index) =>
    frame(unit, start + index, rendition)
  );
}

function repeated(key: ResidentFrameKey, count: number): ResidentFrameKey[] {
  return Array.from({ length: count }, () => ({ ...key }));
}
