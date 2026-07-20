import type { CompiledManifestV1_0 } from "../src/model.js";

const DIGEST = "0".repeat(64);

/** A fresh compact manifest covering every graph-bearing 1.0 unit kind. */
export function validManifest(): CompiledManifestV1_0 {
  return {
    formatVersion: "1.0",
    generator: "aval-tests",
    codec: "h264",
    bitstream: "annex-b",
    layout: "opaque",
    canvas: {
      width: 2,
      height: 2,
      fit: "contain",
      pixelAspect: [1, 1],
      colorSpace: "srgb"
    },
    frameRate: { numerator: 30, denominator: 1 },
    renditions: [
      {
        id: "video",
        codec: "avc1.640020",
        bitDepth: 8,
        codedWidth: 16,
        codedHeight: 16,
        alphaLayout: { type: "opaque", colorRect: [0, 0, 2, 2] },
        bitrate: { average: 1_000, peak: 2_000 }
      }
    ],
    units: [
      body("body-a", "loop", 4, [0, 2], 0),
      body("body-b", "finite", 3, [2], 4),
      body("body-c", "finite", 1, [0], 7),
      basicUnit("bridge-ab", "bridge", 2, 8),
      basicUnit("intro-a", "one-shot", 2, 10),
      {
        id: "rev-bc",
        kind: "reversible",
        frameCount: 6,
        residency: {
          endpoints: [
            { state: "a-b", port: "default", frames: 6 },
            { state: "a-c", port: "default", frames: 6 }
          ]
        },
        chunks: [chunk(12, 6)]
      }
    ],
    initialState: "a-a",
    states: [
      {
        id: "a-a",
        bodyUnit: "body-a",
        initialUnit: "intro-a"
      },
      { id: "a-b", bodyUnit: "body-b" },
      { id: "a-c", bodyUnit: "body-c" }
    ],
    edges: [
      {
        id: "edge-ab",
        from: "a-a",
        to: "a-b",
        trigger: { type: "event", name: "go-b" },
        start: {
          type: "portal",
          sourcePort: "default",
          targetPort: "default",
          maxWaitFrames: 1
        },
        transition: { kind: "locked", unit: "bridge-ab" },
        continuity: "exact-authored"
      },
      {
        id: "edge-ac",
        from: "a-a",
        to: "a-c",
        trigger: { type: "event", name: "go-c" },
        start: { type: "cut", targetPort: "default", maxWaitFrames: 1 },
        continuity: "cut",
        targetRunwayFrames: 6
      },
      {
        id: "edge-ba",
        from: "a-b",
        to: "a-a",
        trigger: { type: "completion" },
        start: { type: "finish", targetPort: "default", maxWaitFrames: 2 },
        continuity: "exact-authored"
      },
      {
        id: "edge-bc",
        from: "a-b",
        to: "a-c",
        trigger: { type: "event", name: "go-c" },
        start: {
          type: "portal",
          sourcePort: "default",
          targetPort: "default",
          maxWaitFrames: 2
        },
        transition: {
          kind: "reversible",
          unit: "rev-bc",
          direction: "forward"
        },
        continuity: "exact-authored"
      },
      {
        id: "edge-cb",
        from: "a-c",
        to: "a-b",
        trigger: { type: "event", name: "go-b" },
        start: {
          type: "portal",
          sourcePort: "default",
          targetPort: "default",
          maxWaitFrames: 0
        },
        transition: {
          kind: "reversible",
          unit: "rev-bc",
          direction: "reverse",
          reverseOf: "edge-bc"
        },
        continuity: "exact-reverse"
      }
    ],
    bindings: [
      { source: "activate", event: "go-c" },
      { source: "pointer.enter", event: "go-b" }
    ],
    readiness: {
      policy: "all-routes",
      bootstrapUnits: [
        "body-a",
        "body-b",
        "body-c",
        "bridge-ab",
        "intro-a"
      ],
      immediateEdges: ["edge-ab", "edge-ac"]
    },
    limits: {
      maxCompiledBytes: 32 * 1024,
      maxRuntimeBytes: 64 * 1024,
      decodedPixelBytes: 1_024,
      persistentCacheBytes: 0,
      runtimeWorkingSetBytes: 1_024
    }
  };
}

/** A valid manifest exactly at the state/edge/unit/blob/frame ceilings. */
export function limitManifest(): CompiledManifestV1_0 {
  const bodyUnits = Array.from({ length: 32 }, (_, index) => ({
    id: numbered("body", index),
    kind: "body" as const,
    playback: "finite" as const,
    frameCount: 1,
    ports: [{ id: "default", entryFrame: 0 as const, portalFrames: [0] }],
    chunks: [] as {
      rendition: string;
      chunkStart: number;
      chunkCount: number;
      frameCount: number;
      sha256: string;
    }[]
  }));
  const bridgeUnits = Array.from({ length: 64 }, (_, index) => ({
    id: numbered("bridge", index),
    kind: "bridge" as const,
    frameCount: index < 36 ? 14 : 13,
    chunks: [] as {
      rendition: string;
      chunkStart: number;
      chunkCount: number;
      frameCount: number;
      sha256: string;
    }[]
  }));
  const units = [...bodyUnits, ...bridgeUnits];
  let chunkStart = 0;
  for (const unit of units) {
    unit.chunks.push({
      rendition: "video",
      chunkStart,
      chunkCount: unit.frameCount,
      frameCount: unit.frameCount,
      sha256: DIGEST
    });
    chunkStart += unit.frameCount;
  }

  const states = Array.from({ length: 32 }, (_, index) => ({
    id: numbered("state", index),
    bodyUnit: numbered("body", index)
  }));
  const edges = Array.from({ length: 64 }, (_, index) => {
    const from = index % 32;
    const targetStep = index < 32 ? 1 : 2;
    return {
      id: numbered("edge", index),
      from: numbered("state", from),
      to: numbered("state", (from + targetStep) % 32),
      start: {
        type: "portal" as const,
        sourcePort: "default",
        targetPort: "default",
        maxWaitFrames: 0
      },
      transition: {
        kind: "locked" as const,
        unit: numbered("bridge", index)
      },
      continuity: "exact-authored" as const
    };
  });

  return {
    formatVersion: "1.0",
    generator: "aval-limit-tests",
    codec: "h264",
    bitstream: "annex-b",
    layout: "opaque",
    canvas: {
      width: 2,
      height: 2,
      fit: "contain",
      pixelAspect: [1, 1],
      colorSpace: "srgb"
    },
    frameRate: { numerator: 60, denominator: 1 },
    renditions: [
      {
        id: "video",
        codec: "avc1.640020",
        bitDepth: 8,
        codedWidth: 16,
        codedHeight: 16,
        alphaLayout: { type: "opaque", colorRect: [0, 0, 2, 2] },
        bitrate: { average: 1_000, peak: 2_000 }
      }
    ],
    units,
    initialState: "state-00",
    states,
    edges,
    bindings: [],
    readiness: {
      policy: "all-routes",
      bootstrapUnits: [
        "body-00",
        "body-01",
        "body-02",
        "bridge-00",
        "bridge-32"
      ],
      immediateEdges: ["edge-00", "edge-32"]
    },
    limits: {
      maxCompiledBytes: 32 * 1024 * 1024,
      maxRuntimeBytes: 64 * 1024 * 1024,
      decodedPixelBytes: 1_024,
      persistentCacheBytes: 0,
      runtimeWorkingSetBytes: 1_024
    }
  };
}

function numbered(prefix: string, index: number): string {
  return `${prefix}-${String(index).padStart(2, "0")}`;
}

function body(
  id: string,
  playback: "loop" | "finite",
  frameCount: number,
  portalFrames: readonly number[],
  chunkStart: number
): Extract<CompiledManifestV1_0["units"][number], { readonly kind: "body" }> {
  return {
    id,
    kind: "body",
    playback,
    frameCount,
    ports: [{ id: "default", entryFrame: 0, portalFrames }],
    chunks: [chunk(chunkStart, frameCount)]
  };
}

function basicUnit(
  id: string,
  kind: "bridge" | "one-shot",
  frameCount: number,
  chunkStart: number
): Extract<CompiledManifestV1_0["units"][number], { readonly kind: typeof kind }> {
  return { id, kind, frameCount, chunks: [chunk(chunkStart, frameCount)] };
}

function chunk(chunkStart: number, chunkCount: number) {
  return {
    rendition: "video",
    chunkStart,
    chunkCount,
    frameCount: chunkCount,
    sha256: DIGEST
  };
}
