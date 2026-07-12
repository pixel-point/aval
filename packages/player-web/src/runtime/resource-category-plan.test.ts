import { describe, expect, it } from "vitest";

import type { RuntimeResourceAllocationSnapshot } from "./resource-plan.js";
import {
  RUNTIME_RESOURCE_FIELD_CATEGORIES,
  createRuntimeResourceCategoryPlan
} from "./resource-category-plan.js";

describe("runtime resource category plan", () => {
  it("maps every M6 allocation field into the closed M7 categories", () => {
    expect(RUNTIME_RESOURCE_FIELD_CATEGORIES).toEqual({
      ownedAssetBytes: "asset-full",
      maximumEncodedWindowBytes: "worker-transfer",
      decoderEncodedWindowBytes: "worker-transfer",
      decodedSurfaceBytes: "decoder-output",
      persistentAllocationBytes: "persistent-animation",
      streamingAllocationBytes: "streaming-texture",
      frameStagingBytes: "frame-staging",
      staticDecodePngCopyBytes: "png-copy",
      staticDecodeOwnedZlibBytes: "png-zlib",
      staticDecodeWorkingPeakBytes: "png-scratch",
      currentStaticSurfaceAllocationBytes: "current-static-surface",
      incomingStaticSurfaceAllocationBytes: "incoming-static-surface",
      animatedCanvasBackingAllocationBytes: "animated-canvas-backing",
      staticCanvasBackingAllocationBytes: "static-canvas-backing"
    });
    expect(Object.isFrozen(RUNTIME_RESOURCE_FIELD_CATEGORIES)).toBe(true);
  });

  it("groups repeated categories and reconciles the exact total", () => {
    const snapshot = allocationSnapshot([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    const plan = createRuntimeResourceCategoryPlan(snapshot);

    expect(plan.entries).toEqual([
      { category: "asset-full", bytes: 1 },
      { category: "worker-transfer", bytes: 5 },
      { category: "decoder-output", bytes: 4 },
      { category: "persistent-animation", bytes: 5 },
      { category: "streaming-texture", bytes: 6 },
      { category: "frame-staging", bytes: 7 },
      { category: "png-copy", bytes: 8 },
      { category: "png-zlib", bytes: 9 },
      { category: "png-scratch", bytes: 10 },
      { category: "current-static-surface", bytes: 11 },
      { category: "incoming-static-surface", bytes: 12 },
      { category: "animated-canvas-backing", bytes: 13 },
      { category: "static-canvas-backing", bytes: 14 }
    ]);
    expect(plan.totalBytes).toBe(105);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.entries)).toBe(true);
    expect(plan.entries.every(Object.isFrozen)).toBe(true);
  });

  it("omits zero categories and rejects mismatched or hostile arithmetic", () => {
    expect(createRuntimeResourceCategoryPlan(allocationSnapshot(
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    )).entries).toEqual([{ category: "asset-full", bytes: 1 }]);

    const mismatch = { ...allocationSnapshot(new Array(14).fill(1)), totalBytes: 1 };
    expect(() => createRuntimeResourceCategoryPlan(mismatch)).toThrow();
    const hostile = {
      ...allocationSnapshot(new Array(14).fill(0)),
      frameStagingBytes: -1,
      totalBytes: -1
    };
    expect(() => createRuntimeResourceCategoryPlan(hostile)).toThrow();
  });
});

function allocationSnapshot(values: readonly number[]): RuntimeResourceAllocationSnapshot {
  const [
    ownedAssetBytes,
    maximumEncodedWindowBytes,
    decoderEncodedWindowBytes,
    decodedSurfaceBytes,
    persistentAllocationBytes,
    streamingAllocationBytes,
    frameStagingBytes,
    staticDecodePngCopyBytes,
    staticDecodeOwnedZlibBytes,
    staticDecodeWorkingPeakBytes,
    currentStaticSurfaceAllocationBytes,
    incomingStaticSurfaceAllocationBytes,
    animatedCanvasBackingAllocationBytes,
    staticCanvasBackingAllocationBytes
  ] = values;
  const normalized = values.map((value) => value ?? 0);
  return {
    ownedAssetBytes: ownedAssetBytes ?? 0,
    maximumEncodedWindowBytes: maximumEncodedWindowBytes ?? 0,
    decoderEncodedWindowBytes: decoderEncodedWindowBytes ?? 0,
    decodedSurfaceBytes: decodedSurfaceBytes ?? 0,
    persistentAllocationBytes: persistentAllocationBytes ?? 0,
    streamingAllocationBytes: streamingAllocationBytes ?? 0,
    frameStagingBytes: frameStagingBytes ?? 0,
    staticDecodePngCopyBytes: staticDecodePngCopyBytes ?? 0,
    staticDecodeOwnedZlibBytes: staticDecodeOwnedZlibBytes ?? 0,
    staticDecodeWorkingPeakBytes: staticDecodeWorkingPeakBytes ?? 0,
    currentStaticSurfaceAllocationBytes: currentStaticSurfaceAllocationBytes ?? 0,
    incomingStaticSurfaceAllocationBytes: incomingStaticSurfaceAllocationBytes ?? 0,
    animatedCanvasBackingAllocationBytes: animatedCanvasBackingAllocationBytes ?? 0,
    staticCanvasBackingAllocationBytes: staticCanvasBackingAllocationBytes ?? 0,
    totalBytes: normalized.reduce((sum, value) => sum + value, 0)
  };
}
