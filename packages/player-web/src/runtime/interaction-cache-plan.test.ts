import type { CompiledManifest, Unit } from "@pixel-point/aval-format";
import { describe, expect, it } from "vitest";

import { createInteractionCachePlan } from "./interaction-cache-plan.js";

const MEBIBYTE = 1024 * 1024;

describe("generalized interaction cache plan", () => {
  it("expands reversible clips, loop wrap, finite hold, and a shared cut runway", () => {
    const plan = createInteractionCachePlan({
      manifest: routeManifest(),
      rendition: "opaque",
      deviceLimits: device()
    });

    expect(plan.reversibleClips).toHaveLength(1);
    const reversible = plan.reversibleClips[0]!;
    expect(reversible.clip.frames.map(({ unit, localFrame }) =>
      [unit, localFrame]
    )).toEqual([["shift", 0], ["shift", 1]]);
    expect(reversible.sourceEndpoint.frames.map(({ localFrame }) => localFrame))
      .toEqual([0, 1, 0, 1, 0, 1]);
    expect(reversible.targetEndpoint.frames.map(({ localFrame }) => localFrame))
      .toEqual([0, 1, 1, 1, 1, 1]);
    expect(plan.cutRunways[0]?.frames.map(({ localFrame }) => localFrame))
      .toEqual([0, 1, 0, 1, 0, 1]);
    expect(plan.cutRunways[0]?.layers).toEqual(
      reversible.sourceEndpoint.layers
    );
    expect(plan.layerCount).toBe(6);
    expect(plan.semanticFrameCount).toBe(20);
    expect(plan.uniqueFrames.map(({ key }) =>
      `${key.unit}:${String(key.localFrame)}`
    )).toEqual([
      "a-body:0",
      "a-body:1",
      "shift:0",
      "shift:1",
      "b-body:0",
      "b-body:1"
    ]);
  });

  it("charges packed-alpha interaction layers at their full coded geometry", () => {
    const manifest = routeManifest({
      layout: "packed-alpha",
      renditions: [{
        id: "opaque",
        codec: "avc1.42E020",
        bitDepth: 8,
        codedWidth: 64,
        codedHeight: 144,
        alphaLayout: {
          type: "stacked",
          colorRect: [0, 0, 64, 64],
          alphaRect: [0, 72, 64, 64]
        },
        outputQualification: {
          kind: "packed-alpha-v1",
          unit: "shift",
          frame: 0,
          samples: [{ x: 0, y: 72, expectedRange: [0, 255] }]
        },
        bitrate: { average: 100_000, peak: 200_000 }
      }]
    });
    const plan = createInteractionCachePlan({
      manifest,
      rendition: "opaque",
      deviceLimits: device()
    });

    expect(plan.width).toBe(64);
    expect(plan.height).toBe(144);
    expect(plan.bytesPerFrame).toBe(64 * 144 * 4);
    expect(plan.persistentBytes).toBe(plan.layerCount * 64 * 144 * 4);
  });

  it("accepts a valid asset with zero persistent layers", () => {
    const manifest = routeManifest({
      units: [body("plain-body", "loop", 2)],
      states: [{ id: "plain", bodyUnit: "plain-body" }],
      edges: [],
      initialState: "plain"
    });
    const plan = createInteractionCachePlan({
      manifest,
      rendition: "opaque",
      deviceLimits: device()
    });

    expect(plan.layerCount).toBe(0);
    expect(plan.semanticFrameCount).toBe(0);
    expect(plan.persistentBytes).toBe(0);
    expect(plan.persistentAllocationBytes).toBe(0);
    expect(plan.uniqueFrames).toEqual([]);
    expect(plan.reversibleClips).toEqual([]);
    expect(plan.cutRunways).toEqual([]);
  });

  it("accepts clip and endpoint media above the former byte boundaries", () => {
    const manifest = routeManifest({
      canvas: {
        width: 1_025,
        height: 512,
        fit: "contain",
        pixelAspect: [1, 1],
        colorSpace: "srgb"
      },
      renditions: [opaqueRendition(1_025, 512)],
      units: [
        body("a-body", "loop", 12, 0),
        body("b-body", "finite", 12, 12),
        body("c-body", "loop", 2, 24),
        reversibleUnit(24, 26, 12)
      ]
    });
    const plan = createInteractionCachePlan({
      manifest,
      rendition: "opaque",
      deviceLimits: device(1_025, 64)
    });

    expect(plan.reversibleClips[0]?.clipBytes)
      .toBeGreaterThan(24 * 1024 * 1024);
    expect(plan.reversibleClips[0]?.endpointPairBytes)
      .toBeGreaterThan(48 * 1024 * 1024);
  });

  it("uses the actual device layer limit without a fixed 128-layer cap", () => {
    const manifest = routeManifest({
      units: [
        body("a-body", "loop", 2, 0),
        body("b-body", "finite", 2, 2),
        body("c-body", "loop", 2, 4),
        reversibleUnit(129, 6)
      ]
    });
    const plan = createInteractionCachePlan({
      manifest,
      rendition: "opaque",
      deviceLimits: device(4_096, 133)
    });
    expect(plan.layerCount).toBe(133);
    expect(() => createInteractionCachePlan({
      manifest,
      rendition: "opaque",
      deviceLimits: device(4_096, 132)
    })).toThrow("layer count 133 exceeds layer limit 132");
  });

  it("enforces exact device dimensions and device layer limits", () => {
    const manifest = routeManifest();
    expect(() => createInteractionCachePlan({
      manifest,
      rendition: "opaque",
      deviceLimits: device(64, 6)
    })).not.toThrow();
    expect(() => createInteractionCachePlan({
      manifest,
      rendition: "opaque",
      deviceLimits: device(63, 128)
    })).toThrow("width exceeds MAX_TEXTURE_SIZE");
    expect(() => createInteractionCachePlan({
      manifest,
      rendition: "opaque",
      deviceLimits: device(4_096, 5)
    })).toThrow("layer count 6 exceeds layer limit 5");
  });

  it("deep-freezes plans and rejects adversarial arithmetic", () => {
    const plan = createInteractionCachePlan({
      manifest: routeManifest(),
      rendition: "opaque",
      deviceLimits: device()
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.uniqueFrames)).toBe(true);
    expect(Object.isFrozen(plan.uniqueFrames[0]?.key)).toBe(true);
    expect(Object.isFrozen(plan.reversibleClips[0]?.sourceEndpoint.frames))
      .toBe(true);

    const manifest = routeManifest({
      renditions: [opaqueRendition(
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER
      )]
    });
    expect(() => createInteractionCachePlan({
      manifest,
      rendition: "opaque",
      deviceLimits: device(Number.MAX_SAFE_INTEGER, 128)
    })).toThrow("exceeds JavaScript's safe-integer range");
  });
});

function device(
  maxTextureSize = 4_096,
  maxArrayTextureLayers = 128
) {
  return { maxTextureSize, maxArrayTextureLayers };
}

function body(
  id: string,
  playback: "loop" | "finite",
  frameCount: number,
  chunkStart = 0
): Extract<Unit, { readonly kind: "body" }> {
  return {
    id,
    kind: "body",
    playback,
    frameCount,
    ports: [{ id: "default", entryFrame: 0, portalFrames: [frameCount - 1] }],
    chunks: [{
      rendition: "opaque",
      chunkStart,
      chunkCount: frameCount,
      frameCount,
      sha256: "0".repeat(64)
    }]
  };
}

function reversibleUnit(
  frameCount: number,
  chunkStart: number,
  endpointFrames = 6
): Extract<Unit, { readonly kind: "reversible" }> {
  return {
    id: "shift",
    kind: "reversible",
    frameCount,
    residency: {
      endpoints: [
        { state: "a", port: "default", frames: endpointFrames },
        { state: "b", port: "default", frames: endpointFrames }
      ]
    },
    chunks: [{
      rendition: "opaque",
      chunkStart,
      chunkCount: frameCount,
      frameCount,
      sha256: "0".repeat(64)
    }]
  };
}

function opaqueRendition(codedWidth: number, codedHeight: number) {
  return {
    id: "opaque",
    codec: "avc1.42E020",
    bitDepth: 8 as const,
    codedWidth,
    codedHeight,
    alphaLayout: {
      type: "opaque" as const,
      colorRect: [0, 0, codedWidth, codedHeight] as const
    },
    bitrate: { average: 100_000, peak: 200_000 }
  };
}

function routeManifest(
  overrides: Partial<CompiledManifest> = {}
): CompiledManifest {
  const units: readonly Unit[] = [
    body("a-body", "loop", 2, 0),
    body("b-body", "finite", 2, 2),
    body("c-body", "loop", 2, 4),
    reversibleUnit(2, 6)
  ];
  return {
    formatVersion: "1.1",
    generator: "test",
    codec: "h264",
    bitstream: "annex-b",
    layout: "opaque",
    canvas: {
      width: 64,
      height: 64,
      fit: "contain",
      pixelAspect: [1, 1],
      colorSpace: "srgb"
    },
    frameRate: { numerator: 30, denominator: 1 },
    renditions: [opaqueRendition(64, 64)],
    units,
    initialState: "a",
    states: [
      { id: "a", bodyUnit: "a-body" },
      { id: "b", bodyUnit: "b-body" },
      { id: "c", bodyUnit: "c-body" }
    ],
    edges: [
      {
        id: "a-b",
        from: "a",
        to: "b",
        start: {
          type: "portal",
          sourcePort: "default",
          targetPort: "default",
          maxWaitFrames: 2
        },
        transition: { kind: "reversible", unit: "shift", direction: "forward" },
        continuity: "exact-authored"
      },
      {
        id: "b-a",
        from: "b",
        to: "a",
        start: {
          type: "portal",
          sourcePort: "default",
          targetPort: "default",
          maxWaitFrames: 2
        },
        transition: {
          kind: "reversible",
          unit: "shift",
          direction: "reverse",
          reverseOf: "a-b"
        },
        continuity: "exact-reverse"
      },
      {
        id: "c-a-cut",
        from: "c",
        to: "a",
        start: { type: "cut", targetPort: "default", maxWaitFrames: 1 },
        continuity: "cut",
        targetRunwayFrames: 6
      }
    ],
    bindings: [],
    readiness: {
      policy: "all-routes",
      bootstrapUnits: ["a-body"],
      immediateEdges: ["a-b"]
    },
    limits: {
      maxCompiledBytes: 32 * MEBIBYTE,
      maxRuntimeBytes: 64 * MEBIBYTE,
      decodedPixelBytes: 64 * 64 * 4,
      persistentCacheBytes: 0,
      runtimeWorkingSetBytes: 0
    },
    ...overrides
  } as CompiledManifest;
}
