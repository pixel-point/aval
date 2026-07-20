import type { CompiledManifestV1_0, Unit } from "@pixel-point/aval-format";
import { describe, expect, it } from "vitest";

import type { RuntimeFrameKey } from "./model.js";
import {
  MAX_INTERACTION_CACHE_LAYERS,
  createInteractionCachePlan,
  createInteractionCachePlanFromSemanticSequences,
  type InteractionCacheSemanticInput,
  type SemanticCutRunwayInput,
  type SemanticReversibleClipInput
} from "./interaction-cache-plan.js";

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
        codec: "avc1.640020",
        bitDepth: 8,
        codedWidth: 64,
        codedHeight: 144,
        alphaLayout: {
          type: "stacked",
          colorRect: [0, 0, 64, 64],
          alphaRect: [0, 72, 64, 64]
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

  it("deduplicates only exact rendition, unit, and local-frame identities", () => {
    const repeatedKey = frame("shared", 0);
    const plan = semanticPlan({
      reversibleClips: [{
        unit: "clip",
        sourceEndpoint: endpoint("source", repeated(repeatedKey, 6)),
        clip: [
          { ...repeatedKey },
          frame("shared", 1),
          frame("different", 0)
        ],
        targetEndpoint: endpoint(
          "target",
          repeated(frame("shared", 1), 6)
        )
      }]
    });

    expect(plan.layerCount).toBe(3);
    expect(plan.reversibleClips[0]?.clip.layers[0]).toBe(0);
    expect(plan.reversibleClips[0]?.clip.layers[1]).toBe(1);
    expect(plan.layerFor(frame("different", 0))).toBe(2);
    expect(plan.layerFor(frame("shared", 0, "other"))).toBeUndefined();
    expect(() => semanticPlan({
      reversibleClips: [{
        unit: "clip",
        sourceEndpoint: endpoint("source", repeated(repeatedKey, 6)),
        clip: [frame("shared", 0, "other")],
        targetEndpoint: endpoint("target", repeated(repeatedKey, 6))
      }]
    })).toThrow("rendition does not match");
  });

  it("uses stable sorted traversal for multiple clips and cuts", () => {
    const alpha = semanticClip("alpha", "a");
    const zeta = semanticClip("zeta", "z");
    const cutA = cut("cut-a", "a-cut");
    const cutZ = cut("cut-z", "z-cut");
    const first = semanticPlan({
      reversibleClips: [zeta, alpha],
      cutRunways: [cutZ, cutA]
    });
    const second = semanticPlan({
      reversibleClips: [alpha, zeta],
      cutRunways: [cutA, cutZ]
    });

    expect(first.uniqueFrames).toEqual(second.uniqueFrames);
    expect(first.reversibleClips).toEqual(second.reversibleClips);
    expect(first.cutRunways).toEqual(second.cutRunways);
    expect(first.reversibleClips.map(({ unit }) => unit))
      .toEqual(["alpha", "zeta"]);
    expect(first.cutRunways.map(({ edge }) => edge))
      .toEqual(["cut-a", "cut-z"]);
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
    const clip = semanticPlan({
      width: 513,
      height: 512,
      reversibleClips: [{
        unit: "clip",
        sourceEndpoint: endpoint("source", repeated(frame("source", 0), 6)),
        clip: frames("clip", 24),
        targetEndpoint: endpoint("target", repeated(frame("target", 0), 6))
      }],
      deviceLimits: device(513, 128)
    });
    expect(clip.reversibleClips[0]?.clipBytes)
      .toBeGreaterThan(24 * 1024 * 1024);

    const pair = semanticPlan({
      width: 1_025,
      height: 512,
      reversibleClips: [{
        unit: "pair",
        sourceEndpoint: endpoint("source", frames("source", 12)),
        clip: [frame("clip", 0)],
        targetEndpoint: endpoint("target", frames("target", 12))
      }],
      deviceLimits: device(1_025, 128)
    });
    expect(pair.reversibleClips[0]?.endpointPairBytes)
      .toBeGreaterThan(48 * 1024 * 1024);
  });

  it("uses the actual device layer limit without a fixed 128-layer cap", () => {
    const exact = Array.from({ length: 11 }, (_, index) => cut(
      `cut-${String(index).padStart(2, "0")}`,
      `unit-${String(index).padStart(2, "0")}`,
      index === 10 ? 8 : 12
    ));
    expect(exact.reduce((total, runway) => total + runway.frames.length, 0))
      .toBe(128);
    expect(semanticPlan({ reversibleClips: [], cutRunways: exact }).layerCount)
      .toBe(128);
    expect(() => semanticPlan({
      reversibleClips: [],
      cutRunways: [...exact, cut("cut-extra", "extra", 1)]
    })).toThrow("must contain 6–12 frames");

    const over = [...exact];
    over[10] = cut("cut-10", "unit-10", 9);
    expect(semanticPlan({
      reversibleClips: [],
      cutRunways: over,
      deviceLimits: device(4_096, 129)
    }).layerCount).toBe(129);
    expect(() => semanticPlan({ reversibleClips: [], cutRunways: over }))
      .toThrow("layer count 129 exceeds layer limit 128");
    expect(MAX_INTERACTION_CACHE_LAYERS).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("enforces exact device dimensions and device layer limits", () => {
    expect(() => semanticPlan({
      width: 64,
      height: 64,
      deviceLimits: device(64, 16)
    })).not.toThrow();
    expect(() => semanticPlan({
      width: 65,
      deviceLimits: device(64, 128)
    })).toThrow("width exceeds MAX_TEXTURE_SIZE");
    expect(() => semanticPlan({
      height: 65,
      deviceLimits: device(64, 128)
    })).toThrow("height exceeds MAX_TEXTURE_SIZE");
    expect(() => semanticPlan({ deviceLimits: device(4_096, 15) }))
      .toThrow("layer count 16 exceeds layer limit 15");
  });

  it("deep-freezes plans and rejects malformed or adversarial arithmetic", () => {
    const plan = semanticPlan();
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.uniqueFrames)).toBe(true);
    expect(Object.isFrozen(plan.uniqueFrames[0]?.key)).toBe(true);
    expect(Object.isFrozen(plan.reversibleClips[0]?.sourceEndpoint.frames))
      .toBe(true);

    expect(() => semanticPlan({ width: Number.MAX_SAFE_INTEGER,
      height: Number.MAX_SAFE_INTEGER,
      deviceLimits: device(Number.MAX_SAFE_INTEGER, 128)
    })).toThrow("exceeds JavaScript's safe-integer range");
    expect(() => createInteractionCachePlanFromSemanticSequences(
      null as unknown as InteractionCacheSemanticInput
    )).toThrow("semantic input must be an object");
    expect(() => semanticPlan({
      reversibleClips: [{
        unit: "bad",
        sourceEndpoint: endpoint("source", repeated(frame("source", 0), 6)),
        clip: [{ rendition: "opaque", unit: "", localFrame: 0 }],
        targetEndpoint: endpoint("target", repeated(frame("target", 0), 6))
      }]
    })).toThrow("must have non-empty rendition and unit strings");
  });
});

function semanticPlan(
  overrides: Partial<InteractionCacheSemanticInput> = {}
) {
  return createInteractionCachePlanFromSemanticSequences({
    rendition: "opaque",
    width: 64,
    height: 64,
    reversibleClips: [semanticClip("clip", "base")],
    cutRunways: [],
    deviceLimits: device(),
    ...overrides
  });
}

function semanticClip(unit: string, prefix: string): SemanticReversibleClipInput {
  return {
    unit,
    sourceEndpoint: endpoint(`${prefix}-source`, frames(`${prefix}-source`, 6)),
    clip: frames(`${prefix}-clip`, 4),
    targetEndpoint: endpoint(`${prefix}-target`, frames(`${prefix}-target`, 6))
  };
}

function endpoint(
  state: string,
  runway: readonly RuntimeFrameKey[]
) {
  return { state, port: "default", frames: runway };
}

function cut(edge: string, unit: string, count = 6): SemanticCutRunwayInput {
  return {
    edge,
    state: `${unit}-state`,
    port: "default",
    frames: frames(unit, count)
  };
}

function frame(
  unit: string,
  localFrame: number,
  rendition = "opaque"
): RuntimeFrameKey {
  return { rendition, unit, localFrame };
}

function frames(unit: string, count: number): RuntimeFrameKey[] {
  return Array.from({ length: count }, (_, index) => frame(unit, index));
}

function repeated(key: RuntimeFrameKey, count: number): RuntimeFrameKey[] {
  return Array.from({ length: count }, () => ({ ...key }));
}

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

function routeManifest(
  overrides: Partial<CompiledManifestV1_0> = {}
): CompiledManifestV1_0 {
  const units: readonly Unit[] = [
    body("a-body", "loop", 2, 0),
    body("b-body", "finite", 2, 2),
    body("c-body", "loop", 2, 4),
    {
      id: "shift",
      kind: "reversible",
      frameCount: 2,
      residency: {
        endpoints: [
          { state: "a", port: "default", frames: 6 },
          { state: "b", port: "default", frames: 6 }
        ]
      },
      chunks: [{
        rendition: "opaque",
        chunkStart: 6,
        chunkCount: 2,
        frameCount: 2,
        sha256: "0".repeat(64)
      }]
    }
  ];
  return {
    formatVersion: "1.0",
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
    renditions: [{
      id: "opaque",
      codec: "avc1.640020",
      bitDepth: 8,
      codedWidth: 64,
      codedHeight: 64,
      alphaLayout: { type: "opaque", colorRect: [0, 0, 64, 64] },
      bitrate: { average: 100_000, peak: 200_000 }
    }],
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
  };
}
