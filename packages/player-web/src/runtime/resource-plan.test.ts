import type {
  CompiledManifest,
  EncodedChunkRecord,
  Unit
} from "@pixel-point/aval-format";
import { describe, expect, it } from "vitest";

import { createRuntimeTestAsset } from "./asset-test-support.js";
import { installRuntimeAssetCatalog } from "./asset-catalog.js";
import { createInteractionCachePlan } from "./interaction-cache-plan.js";
import {
  createCanvasRuntimeResourcePlan,
  createRuntimeResourcePlan,
  maximumActualEncodedWindowBytes,
  type RuntimeResourceCatalogView
} from "./resource-plan.js";

describe("runtime resource plan", () => {
  it("accounts one animated canvas and no embedded fallback media", () => {
    const catalog = installRuntimeAssetCatalog(createRuntimeTestAsset());
    const canvas = createCanvasRuntimeResourcePlan({ catalog });
    expect(canvas.totalBytes).toBe(
      canvas.ownedAssetBytes + canvas.animatedCanvasBackingAllocationBytes
    );
    expect(() => createCanvasRuntimeResourcePlan({
      catalog,
      hostMaxRuntimeBytes: canvas.totalBytes - 1
    })).toThrow();

    const interactionCache = createInteractionCachePlan({
      manifest: catalog.manifest,
      rendition: "opaque",
      deviceLimits: { maxTextureSize: 4_096, maxArrayTextureLayers: 128 }
    });
    const plan = createRuntimeResourcePlan({
      catalog,
      rendition: "opaque",
      interactionCache,
      ringCapacity: 6
    });
    expect(plan.totalBytes).toBe(plan.allocationSnapshot.totalBytes);
    expect(plan.animatedCanvasBackingAllocationBytes).toBeGreaterThan(0);
    expect(Object.keys(plan).some((key) => key.toLowerCase().includes("static")))
      .toBe(false);
    catalog.dispose();
  });

  it("charges hidden chunk bytes while only displayed frames consume credit", () => {
    const catalog = encodedWindowCatalog([
      { byteLength: 11, displayedFrameCount: 1 },
      { byteLength: 101, displayedFrameCount: 0 },
      { byteLength: 13, displayedFrameCount: 1 }
    ]);

    expect(maximumActualEncodedWindowBytes(catalog, "video", 1))
      .toBe(101 + 13);
    expect(maximumActualEncodedWindowBytes(catalog, "video", 2))
      .toBe(101 + 13 + 11 + 101);
  });
});

interface ChunkSpec {
  readonly byteLength: number;
  readonly displayedFrameCount: number;
}

function encodedWindowCatalog(
  specs: readonly ChunkSpec[]
): RuntimeResourceCatalogView {
  const frameCount = specs.reduce(
    (total, { displayedFrameCount }) => total + displayedFrameCount,
    0
  );
  const unit: Extract<Unit, { readonly kind: "body" }> = {
    id: "body",
    kind: "body",
    playback: "loop",
    frameCount,
    ports: [{ id: "default", entryFrame: 0, portalFrames: [0] }],
    chunks: [{
      rendition: "video",
      chunkStart: 0,
      chunkCount: specs.length,
      frameCount,
      sha256: "0".repeat(64)
    }]
  };
  const manifest: CompiledManifest = {
    formatVersion: "1.1",
    generator: "resource-plan-test",
    codec: "vp9",
    bitstream: "frame",
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
      id: "video",
      codec: "vp09.00.10.08.01.01.01.01.00",
      bitDepth: 8,
      codedWidth: 64,
      codedHeight: 64,
      alphaLayout: { type: "opaque", colorRect: [0, 0, 64, 64] },
      bitrate: { average: 100_000, peak: 200_000 }
    }],
    units: [unit],
    initialState: "idle",
    states: [{ id: "idle", bodyUnit: unit.id }],
    edges: [],
    bindings: [],
    readiness: {
      policy: "all-routes",
      bootstrapUnits: [unit.id],
      immediateEdges: []
    },
    limits: {
      maxCompiledBytes: 1024 * 1024,
      maxRuntimeBytes: 8 * 1024 * 1024,
      decodedPixelBytes: 64 * 64 * 4,
      persistentCacheBytes: 0,
      runtimeWorkingSetBytes: 1024 * 1024
    }
  };
  const offsets: number[] = [];
  let offset = 1;
  for (const spec of specs) {
    offsets.push(offset);
    offset += spec.byteLength;
  }

  return {
    ownedByteLength: offset,
    manifest,
    chunks: {
      require(rendition, unitId, decodeIndex) {
        const spec = specs[decodeIndex];
        const byteOffset = offsets[decodeIndex];
        if (
          rendition !== "video" ||
          unitId !== unit.id ||
          spec === undefined ||
          byteOffset === undefined
        ) {
          throw new RangeError("unknown encoded chunk");
        }
        const record: EncodedChunkRecord = {
          byteOffset,
          byteLength: spec.byteLength,
          presentationTimestamp: decodeIndex,
          duration: spec.displayedFrameCount === 0 ? 0 : 1,
          randomAccess: decodeIndex === 0,
          displayedFrameCount: spec.displayedFrameCount
        };
        return {
          rendition,
          unit: unitId,
          decodeIndex,
          ordinal: decodeIndex,
          record,
          range: { offset: byteOffset, length: spec.byteLength }
        };
      }
    }
  };
}
