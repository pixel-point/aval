import type {
  LegacyManifest,
  OpaqueQualifiedManifest,
  PackedAlphaQualifiedManifest
} from "../../src/asset.js";
import type {
  MaterializedRgbaFrame,
  MaterializedRgbaFrameReference
} from "../../src/rgba-materializer.js";
import {
  deriveRenderLayout,
  type RenderLayout
} from "../../src/renderer-geometry.js";

const WITNESS_RED = 48;

export const witnessLayout: Readonly<RenderLayout> = deriveRenderLayout({
  codedWidth: 2,
  codedHeight: 12,
  logicalWidth: 2,
  logicalHeight: 2,
  pixelAspect: [1, 1],
  colorRect: [0, 0, 2, 2],
  alphaRect: [0, 10, 2, 2]
});

export function packedQualifiedManifest(): Readonly<PackedAlphaQualifiedManifest> {
  return Object.freeze({
    ...manifestBase(),
    formatVersion: "1.1",
    layout: "packed-alpha",
    renditions: Object.freeze([Object.freeze({
      ...renditionBase(),
      alphaLayout: Object.freeze({
        type: "stacked",
        colorRect: Object.freeze([0, 0, 2, 2] as const),
        alphaRect: Object.freeze([0, 10, 2, 2] as const)
      }),
      outputQualification: Object.freeze({
        kind: "packed-alpha-v1",
        unit: "bootstrap",
        frame: 2,
        samples: Object.freeze([Object.freeze({
          x: 0,
          y: 0,
          expectedRange: Object.freeze([32, 64] as const)
        })])
      })
    })])
  });
}

export function opaqueQualifiedManifest(): Readonly<OpaqueQualifiedManifest> {
  return Object.freeze({
    ...manifestBase(),
    formatVersion: "1.1",
    layout: "opaque",
    renditions: Object.freeze([Object.freeze({
      ...renditionBase(),
      alphaLayout: Object.freeze({
        type: "opaque",
        colorRect: Object.freeze([0, 0, 2, 2] as const)
      })
    })])
  });
}

export function legacyPackedManifest(): Readonly<LegacyManifest> {
  return Object.freeze({
    ...manifestBase(),
    formatVersion: "1.0",
    layout: "packed-alpha",
    renditions: Object.freeze([Object.freeze({
      ...renditionBase(),
      alphaLayout: Object.freeze({
        type: "stacked",
        colorRect: Object.freeze([0, 0, 2, 2] as const),
        alphaRect: Object.freeze([0, 10, 2, 2] as const)
      })
    })])
  });
}

export function rgbaReference(
  frame: VideoFrame,
  red = WITNESS_RED
): Readonly<MaterializedRgbaFrameReference> {
  const pixels = new Uint8Array(
    witnessLayout.storageWidth * witnessLayout.storageHeight * 4
  );
  const alpha = witnessLayout.alphaRect;
  if (alpha === undefined) throw new Error("test alpha rectangle is unavailable");
  pixels[(alpha[1] * witnessLayout.storageWidth + alpha[0]) * 4] = red;
  const materialized = Object.freeze({
    width: witnessLayout.storageWidth,
    height: witnessLayout.storageHeight,
    stride: witnessLayout.storageWidth * 4,
    pixels
  }) satisfies Readonly<MaterializedRgbaFrame>;
  return Object.freeze({ frame, rgba: materialized });
}

function manifestBase() {
  return {
    generator: "provisional-output-test",
    codec: "h264" as const,
    bitstream: "annex-b" as const,
    canvas: Object.freeze({
      width: 2,
      height: 2,
      fit: "contain" as const,
      pixelAspect: Object.freeze([1, 1] as const),
      colorSpace: "srgb" as const
    }),
    frameRate: Object.freeze({ numerator: 30, denominator: 1 }),
    units: Object.freeze([Object.freeze({
      id: "bootstrap",
      kind: "body" as const,
      playback: "loop" as const,
      frameCount: 3,
      ports: Object.freeze([Object.freeze({
        id: "default",
        entryFrame: 0 as const,
        portalFrames: Object.freeze([0])
      })]),
      chunks: Object.freeze([Object.freeze({
        rendition: "main",
        chunkStart: 0,
        chunkCount: 1,
        frameCount: 3,
        sha256: "0".repeat(64)
      })])
    })]),
    initialState: "initial",
    states: Object.freeze([Object.freeze({
      id: "initial",
      bodyUnit: "bootstrap"
    })]),
    edges: Object.freeze([]),
    bindings: Object.freeze([]),
    readiness: Object.freeze({
      policy: "all-routes" as const,
      bootstrapUnits: Object.freeze(["bootstrap"]),
      immediateEdges: Object.freeze([])
    }),
    limits: Object.freeze({
      maxCompiledBytes: 1_024,
      maxRuntimeBytes: 1_024,
      decodedPixelBytes: 96,
      persistentCacheBytes: 0,
      runtimeWorkingSetBytes: 96
    })
  };
}

function renditionBase() {
  return {
    id: "main",
    codec: "avc1.64000A",
    bitDepth: 8 as const,
    codedWidth: 2,
    codedHeight: 12,
    bitrate: Object.freeze({ average: 1_000, peak: 2_000 })
  };
}
