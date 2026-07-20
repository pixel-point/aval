import type {
  CompiledManifestV1_0,
  EncodedChunkRecord,
  ProductionRenditionV1_0,
  Unit
} from "@pixel-point/aval-format";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeAssetCatalog, RuntimeCatalogChunk } from "./asset-catalog.js";
import { inspectSelectedVideoRendition } from "./video-rendition-inspection.js";
import { certifyVideoRenditions } from "./video-rendition-certification.js";

const ACCESS_UNITS = Object.freeze([
  fromHex(
    "000000010910000000016742e020f42134d40404050000030001000003003c8da08846a00000000168ce32c80000000165b840fc"
  ),
  fromHex("0000000109300000000141e243f0")
]);

describe("selected catalog video rendition inspection", () => {
  it("certifies the exact selected rung without exposing or retaining chunk bytes", () => {
    const fixture = createCatalogFixture();
    const selected = fixture.catalog.videoRenditions[0]!;

    const result = inspectSelectedVideoRendition(fixture.catalog, selected);

    expect(result.candidate).toBe(selected);
    expect(result.inspection).toMatchObject({
      family: "h264",
      bitstream: "annex-b",
      bitDepth: 8,
      decoderConfig: {
        codec: "avc1.42E020",
        codedWidth: 64,
        codedHeight: 64
      },
      units: [{
        id: "body",
        displayedFrameCount: 2,
        submissions: [
          { decodeIndex: 0, presentationIndices: [0] },
          { decodeIndex: 1, presentationIndices: [1] }
        ]
      }]
    });
    expect(fixture.copyChunk).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain("bytes");
    expect(isDeeplyFrozen(result)).toBe(true);
  });

  it("rejects a selected candidate from another asset before borrowing bytes", () => {
    const fixture = createCatalogFixture();
    const foreignManifest = {
      ...fixture.manifest,
      renditions: [{
        ...fixture.manifest.renditions[0]!,
        bitrate: { average: 90_000, peak: 140_000 }
      }]
    } satisfies CompiledManifestV1_0;
    const foreign = certifyVideoRenditions(foreignManifest)[0]!;

    expect(() => inspectSelectedVideoRendition(fixture.catalog, foreign))
      .toThrow(/does not belong to this asset catalog/iu);
    expect(fixture.copyChunk).not.toHaveBeenCalled();
  });

  it("rejects an H264 manifest profile that disagrees with the inspected SPS", () => {
    const fixture = createCatalogFixture("avc1.640020");
    const selected = fixture.catalog.videoRenditions[0]!;

    expect(() => inspectSelectedVideoRendition(fixture.catalog, selected))
      .toThrow(/inspected codec string disagrees/iu);
  });
});

function createCatalogFixture(codec = "avc1.42E020"): Readonly<{
  manifest: Readonly<CompiledManifestV1_0>;
  catalog: RuntimeAssetCatalog;
  copyChunk: ReturnType<typeof vi.fn>;
}> {
  const rendition: ProductionRenditionV1_0 = Object.freeze({
    id: "main",
    codec,
    bitDepth: 8,
    codedWidth: 64,
    codedHeight: 64,
    alphaLayout: Object.freeze({
      type: "opaque" as const,
      colorRect: Object.freeze([0, 0, 64, 64] as const)
    }),
    bitrate: Object.freeze({ average: 100_000, peak: 150_000 })
  });
  const unit: Unit = Object.freeze({
    id: "body",
    kind: "body" as const,
    playback: "loop" as const,
    frameCount: 2,
    ports: Object.freeze([]),
    chunks: Object.freeze([Object.freeze({
      rendition: "main",
      chunkStart: 0,
      chunkCount: 2,
      frameCount: 2,
      sha256: "0".repeat(64)
    })])
  });
  const manifest: Readonly<CompiledManifestV1_0> = Object.freeze({
    formatVersion: "1.0",
    generator: "inspection-test",
    codec: "h264",
    bitstream: "annex-b",
    layout: "opaque",
    canvas: Object.freeze({
      width: 64,
      height: 64,
      fit: "contain" as const,
      pixelAspect: Object.freeze([1, 1] as const),
      colorSpace: "srgb" as const
    }),
    frameRate: Object.freeze({ numerator: 30, denominator: 1 }),
    renditions: Object.freeze([rendition]),
    units: Object.freeze([unit]),
    initialState: "idle",
    states: Object.freeze([]),
    edges: Object.freeze([]),
    bindings: Object.freeze([]),
    readiness: Object.freeze({
      policy: "all-routes" as const,
      bootstrapUnits: Object.freeze([]),
      immediateEdges: Object.freeze([])
    }),
    limits: Object.freeze({
      maxCompiledBytes: 1_000_000,
      maxRuntimeBytes: 1_000_000,
      decodedPixelBytes: 16_384,
      persistentCacheBytes: 1,
      runtimeWorkingSetBytes: 1
    })
  });
  const offsets = Object.freeze([0, ACCESS_UNITS[0]!.byteLength]);
  const records: readonly Readonly<EncodedChunkRecord>[] = Object.freeze([
    Object.freeze({
      byteOffset: offsets[0]!,
      byteLength: ACCESS_UNITS[0]!.byteLength,
      presentationTimestamp: 0,
      duration: 33_333,
      randomAccess: true,
      displayedFrameCount: 1
    }),
    Object.freeze({
      byteOffset: offsets[1]!,
      byteLength: ACCESS_UNITS[1]!.byteLength,
      presentationTimestamp: 33_333,
      duration: 33_333,
      randomAccess: false,
      displayedFrameCount: 1
    })
  ]);
  const entries = records.map((record, decodeIndex): RuntimeCatalogChunk =>
    Object.freeze({
      rendition: "main",
      unit: "body",
      decodeIndex,
      ordinal: decodeIndex,
      record,
      blobKey: "unit:main:body",
      relativeRange: Object.freeze({
        offset: offsets[decodeIndex]!,
        length: record.byteLength
      }),
      range: Object.freeze({
        offset: offsets[decodeIndex]!,
        length: record.byteLength
      })
    })
  );
  const copyChunk = vi.fn((_rendition: string, _unit: string, decodeIndex: number) =>
    ACCESS_UNITS[decodeIndex]!.slice().buffer
  );
  const videoRenditions = certifyVideoRenditions(manifest);
  const catalog = {
    manifest,
    videoRenditions,
    ownsVideoRendition: (value: unknown) => videoRenditions.includes(
      value as (typeof videoRenditions)[number]
    ),
    chunks: { require: (_r: string, _u: string, index: number) => entries[index]! },
    copyChunk
  } as unknown as RuntimeAssetCatalog;
  return Object.freeze({ manifest, catalog, copyChunk });
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(
    value.match(/.{2}/gu)!.map((byte) => Number.parseInt(byte, 16))
  );
}

function isDeeplyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== "object" || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((nested) =>
    isDeeplyFrozen(nested, seen)
  );
}
