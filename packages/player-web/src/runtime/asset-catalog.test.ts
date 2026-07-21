import { describe, expect, it } from "vitest";

import { createRuntimeTestAsset } from "./asset-test-support.js";
import {
  RuntimeAssetCatalog,
  createRuntimeCatalogBlobDescriptors
} from "./asset-catalog.js";

describe("runtime asset catalog", () => {
  it("indexes and copies only animation unit payloads", () => {
    const catalog = new RuntimeAssetCatalog(createRuntimeTestAsset());

    expect(catalog.manifest.initialState).toBe("idle");
    expect(catalog.states.require("idle")).toEqual({
      id: "idle",
      bodyUnit: "body",
      initialUnit: "intro"
    });
    expect("staticFrames" in catalog.manifest).toBe(false);

    const descriptors = createRuntimeCatalogBlobDescriptors(
      catalog.layout.frontIndex
    );
    expect(descriptors).toHaveLength(2);
    expect(descriptors.every(({ kind }) => kind === "unit")).toBe(true);
    expect(new Uint8Array(catalog.copyChunk("opaque", "body", 0)).byteLength)
      .toBeGreaterThan(0);
    expect(catalog.residencySnapshot().unitBlobs).toMatchObject({
      total: 2,
      verified: 2
    });

    catalog.dispose();
    expect(catalog.ownedByteLength).toBe(0);
  });

  it("retains the exact wire-1.1 video rendition contract", () => {
    const catalog = new RuntimeAssetCatalog(createRuntimeTestAsset());

    expect(catalog.manifest).toMatchObject({
      formatVersion: "1.1",
      codec: "h264",
      bitstream: "annex-b",
      layout: "opaque"
    });
    expect(catalog.renditions.require("opaque")).toMatchObject({
      codec: "avc1.42E020",
      bitDepth: 8,
      codedWidth: 64,
      codedHeight: 64
    });
    expect(catalog.chunks.require("opaque", "body", 1)).toMatchObject({
      rendition: "opaque",
      unit: "body",
      decodeIndex: 1,
      record: {
        randomAccess: false,
        displayedFrameCount: 1
      }
    });
    catalog.dispose();
  });

  it("owns one immutable certified rendition identity per authored rung", () => {
    const left = new RuntimeAssetCatalog(createRuntimeTestAsset());
    const right = new RuntimeAssetCatalog(createRuntimeTestAsset());
    const candidate = left.videoRenditions[0]!;

    expect(candidate.rendition).toBe(left.manifest.renditions[0]);
    expect(left.ownsVideoRendition(candidate)).toBe(true);
    expect(right.ownsVideoRendition(candidate)).toBe(false);
    expect(candidate.geometry).toMatchObject({
      decodedStorageRect: [0, 0, 64, 64],
      decodedRgbaBytes: 16_384
    });
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(Object.isFrozen(candidate.decoderConfig)).toBe(true);

    left.dispose();
    right.dispose();
  });
});
