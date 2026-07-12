import type { CompiledManifestV01, UnitV01 } from "@rendered-motion/format";
import { describe, expect, it } from "vitest";

import type { RuntimeFrameKey } from "./model.js";
import {
  MAX_INTERACTION_CACHE_LAYERS,
  MAX_REVERSIBLE_CLIP_BYTES,
  MAX_REVERSIBLE_ENDPOINT_PAIR_BYTES,
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
      states: [{ id: "plain", bodyUnit: "plain-body", staticFrame: "static" }],
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

  it("accepts exact reversible clip and endpoint-pair byte boundaries", () => {
    const clip = semanticPlan({
      width: 512,
      height: 512,
      reversibleClips: [{
        unit: "clip",
        sourceEndpoint: endpoint("source", repeated(frame("source", 0), 6)),
        clip: frames("clip", 24),
        targetEndpoint: endpoint("target", repeated(frame("target", 0), 6))
      }],
      deviceLimits: device(512, 128)
    });
    expect(clip.reversibleClips[0]?.clipBytes)
      .toBe(MAX_REVERSIBLE_CLIP_BYTES);

    const pair = semanticPlan({
      width: 1_024,
      height: 512,
      reversibleClips: [{
        unit: "pair",
        sourceEndpoint: endpoint("source", frames("source", 12)),
        clip: [frame("clip", 0)],
        targetEndpoint: endpoint("target", frames("target", 12))
      }],
      deviceLimits: device(1_024, 128)
    });
    expect(pair.reversibleClips[0]?.endpointPairBytes)
      .toBe(MAX_REVERSIBLE_ENDPOINT_PAIR_BYTES);
  });

  it("rejects the first values above clip and endpoint-pair byte caps", () => {
    expect(() => semanticPlan({
      width: 513,
      height: 512,
      reversibleClips: [{
        unit: "clip",
        sourceEndpoint: endpoint("source", repeated(frame("source", 0), 6)),
        clip: frames("clip", 24),
        targetEndpoint: endpoint("target", repeated(frame("target", 0), 6))
      }],
      deviceLimits: device(513, 128)
    })).toThrow("clip bytes exceed the 24 MiB cap");

    expect(() => semanticPlan({
      width: 1_025,
      height: 512,
      reversibleClips: [{
        unit: "pair",
        sourceEndpoint: endpoint("source", frames("source", 12)),
        clip: [frame("clip", 0)],
        targetEndpoint: endpoint("target", frames("target", 12))
      }],
      deviceLimits: device(1_025, 128)
    })).toThrow("endpoint pair bytes exceed the 48 MiB cap");
  });

  it("accepts exactly 128 unique layers and rejects layer 129", () => {
    const exact = Array.from({ length: 11 }, (_, index) => cut(
      `cut-${String(index).padStart(2, "0")}`,
      `unit-${String(index).padStart(2, "0")}`,
      index === 10 ? 8 : 12
    ));
    expect(exact.reduce((total, runway) => total + runway.frames.length, 0))
      .toBe(MAX_INTERACTION_CACHE_LAYERS);
    expect(semanticPlan({ reversibleClips: [], cutRunways: exact }).layerCount)
      .toBe(MAX_INTERACTION_CACHE_LAYERS);
    expect(() => semanticPlan({
      reversibleClips: [],
      cutRunways: [...exact, cut("cut-extra", "extra", 1)]
    })).toThrow("must contain 6–12 frames");

    const over = [...exact];
    over[10] = cut("cut-10", "unit-10", 9);
    expect(() => semanticPlan({ reversibleClips: [], cutRunways: over }))
      .toThrow("layer count 129 exceeds layer limit 128");
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
    })).toThrow("clip bytes exceed the 24 MiB cap");
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
  frameCount: number
): Extract<UnitV01, { readonly kind: "body" }> {
  return {
    id,
    kind: "body",
    playback,
    frameCount,
    ports: [{ id: "default", entryFrame: 0, portalFrames: [frameCount - 1] }],
    samples: [{
      rendition: "opaque",
      sampleStart: 0,
      sampleCount: frameCount,
      sha256: "0".repeat(64)
    }]
  };
}

function routeManifest(overrides: Partial<CompiledManifestV01> = {}): CompiledManifestV01 {
  const units: readonly UnitV01[] = [
    body("a-body", "loop", 2),
    body("b-body", "finite", 2),
    body("c-body", "loop", 2),
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
      samples: [{
        rendition: "opaque",
        sampleStart: 4,
        sampleCount: 2,
        sha256: "0".repeat(64)
      }]
    }
  ];
  return {
    formatVersion: "0.1",
    generator: "test",
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
      profile: "avc-annexb-opaque-v0",
      codec: "avc1.42E020",
      codedWidth: 64,
      codedHeight: 64,
      alphaLayout: { type: "opaque-v0", colorRect: [0, 0, 64, 64] },
      bitrate: { average: 100_000, peak: 200_000 },
      capabilities: ["webcodecs", "webgl2"]
    }],
    units,
    staticFrames: [{
      id: "static",
      offset: 1,
      length: 1,
      width: 64,
      height: 64,
      sha256: "0".repeat(64)
    }],
    initialState: "a",
    states: [
      { id: "a", bodyUnit: "a-body", staticFrame: "static" },
      { id: "b", bodyUnit: "b-body", staticFrame: "static" },
      { id: "c", bodyUnit: "c-body", staticFrame: "static" }
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
    fallback: {
      unsupported: "per-state-static",
      reducedMotion: "per-state-static"
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
