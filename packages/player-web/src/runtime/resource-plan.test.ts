import {
  maximumAvcDecodedRgbaBytes,
  type AccessUnitRecord,
  type CompiledManifestV01,
  type UnitV01
} from "@rendered-motion/format";
import { describe, expect, it } from "vitest";

import {
  installRuntimeAssetCatalog,
  type RuntimeCatalogAccessUnit
} from "./asset-catalog.js";
import { createOpaqueTestAsset } from "./asset-test-fixture.js";
import {
  MAX_PLAYER_RUNTIME_BYTES,
  checkedByteNumber,
  checkedByteProduct,
  checkedByteSum,
  roundedGpuAllocationBytes
} from "./checked-runtime-bytes.js";
import {
  createInteractionCachePlan,
  createInteractionCachePlanFromSemanticSequences
} from "./interaction-cache-plan.js";
import {
  RESOURCE_DECODE_SURFACE_COUNT,
  createRuntimeResourcePlan,
  maximumActualEncodedWindowBytes,
  type RuntimeResourceCatalogView
} from "./resource-plan.js";

const MEBIBYTE = 1024 * 1024;

describe("exact runtime resource plan", () => {
  it("integrates the owned catalog and accounts every frozen term exactly", () => {
    const catalog = installRuntimeAssetCatalog(createOpaqueTestAsset());
    const cache = createInteractionCachePlan({
      manifest: catalog.manifest,
      rendition: "opaque",
      deviceLimits: { maxTextureSize: 4_096, maxArrayTextureLayers: 128 }
    });
    const plan = createRuntimeResourcePlan({
      catalog,
      rendition: "opaque",
      interactionCache: cache,
      ringCapacity: 6
    });

    const decodedPerSurface = maximumAvcDecodedRgbaBytes(64, 64);
    const streaming = 64 * 64 * 4 * 3;
    const staticSwap = 64 * 64 * 4 * 2;
    const expected = catalog.ownedByteLength +
      366 +
      decodedPerSurface * RESOURCE_DECODE_SURFACE_COUNT +
      Number(roundedGpuAllocationBytes(streaming)) +
      64 * 64 * 4 +
      Number(roundedGpuAllocationBytes(staticSwap));

    expect(plan).toMatchObject({
      ownedAssetBytes: catalog.ownedByteLength,
      maximumEncodedWindowBytes: 366,
      decodedBytesPerSurface: decodedPerSurface,
      decodedSurfaceBytes:
        decodedPerSurface * RESOURCE_DECODE_SURFACE_COUNT,
      persistentLayerBytes: 0,
      persistentAllocationBytes: 0,
      streamingLayerBytes: streaming,
      streamingAllocationBytes: Number(roundedGpuAllocationBytes(streaming)),
      stagingBytes: 64 * 64 * 4,
      staticSwapBytes: staticSwap,
      staticSwapAllocationBytes: Number(roundedGpuAllocationBytes(staticSwap)),
      ringAdditionalBytes: 0,
      totalBytes: expected
    });
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it("finds legal windows without combining impossible mid-unit samples", () => {
    const catalog = fakeCatalog({
      unitLengths: {
        alpha: [100, 1],
        beta: [90, 1]
      }
    });

    expect(maximumActualEncodedWindowBytes(catalog, "opaque", 1)).toBe(100);
    expect(maximumActualEncodedWindowBytes(catalog, "opaque", 2)).toBe(101);
    expect(maximumActualEncodedWindowBytes(catalog, "opaque", 3)).toBe(201);
    expect(maximumActualEncodedWindowBytes(catalog, "opaque", 12)).toBe(606);
  });

  it("uses actual sample windows rather than max-sample multiplication", () => {
    const catalog = fakeCatalog({
      unitLengths: { body: [1_000, 1, 1, 1] }
    });
    const actual = maximumActualEncodedWindowBytes(catalog, "opaque", 12);

    expect(actual).toBe(3_009);
    expect(actual).toBeLessThan(12_000);
  });

  it("charges twelve decoder surfaces once for every legal ring size", () => {
    const catalog = fakeCatalog();
    const cache = zeroCache();
    const six = createRuntimeResourcePlan({
      catalog,
      rendition: "opaque",
      interactionCache: cache,
      ringCapacity: 6
    });
    const twelve = createRuntimeResourcePlan({
      catalog,
      rendition: "opaque",
      interactionCache: cache,
      ringCapacity: 12
    });

    expect(six.decodedSurfaceBytes).toBe(twelve.decodedSurfaceBytes);
    expect(six.totalBytes).toBe(twelve.totalBytes);
    expect(six.ringAdditionalBytes).toBe(0);
    expect(twelve.ringAdditionalBytes).toBe(0);
    expect(six.outstandingFrameLimit).toBe(12);
  });

  it("accepts the exact effective cap and rejects one byte below", () => {
    const catalog = fakeCatalog();
    const cache = zeroCache();
    const baseline = createRuntimeResourcePlan({
      catalog,
      rendition: "opaque",
      interactionCache: cache,
      ringCapacity: 6
    });
    const exact = createRuntimeResourcePlan({
      catalog,
      rendition: "opaque",
      interactionCache: cache,
      ringCapacity: 6,
      hostMaxRuntimeBytes: baseline.totalBytes
    });

    expect(exact.effectiveCapBytes).toBe(baseline.totalBytes);
    expect(exact.totalBytes).toBe(baseline.totalBytes);
    expect(() => createRuntimeResourcePlan({
      catalog,
      rendition: "opaque",
      interactionCache: cache,
      ringCapacity: 6,
      hostMaxRuntimeBytes: baseline.totalBytes - 1
    })).toThrow("exceeds effective cap");
  });

  it("uses the minimum of 64 MiB, manifest advisory cap, and host policy", () => {
    const cache = zeroCache();
    const baseline = createRuntimeResourcePlan({
      catalog: fakeCatalog(),
      rendition: "opaque",
      interactionCache: cache,
      ringCapacity: 6
    });
    const manifestCap = baseline.totalBytes + 100;
    const catalog = fakeCatalog({ manifestMaxRuntimeBytes: manifestCap });
    const manifestLimited = createRuntimeResourcePlan({
      catalog,
      rendition: "opaque",
      interactionCache: cache,
      ringCapacity: 6,
      hostMaxRuntimeBytes: manifestCap + 100
    });
    expect(manifestLimited.effectiveCapBytes).toBe(manifestCap);

    const hardLimited = createRuntimeResourcePlan({
      catalog: fakeCatalog({
        manifestMaxRuntimeBytes: Number.MAX_SAFE_INTEGER
      }),
      rendition: "opaque",
      interactionCache: cache,
      ringCapacity: 6,
      hostMaxRuntimeBytes: Number.MAX_SAFE_INTEGER
    });
    expect(hardLimited.effectiveCapBytes).toBe(MAX_PLAYER_RUNTIME_BYTES);
  });

  it("never treats manifest byte estimates as allocation authority", () => {
    const cache = zeroCache();
    const lowEstimates = createRuntimeResourcePlan({
      catalog: fakeCatalog({
        estimate: {
          decodedPixelBytes: 0,
          persistentCacheBytes: 0,
          runtimeWorkingSetBytes: 0
        }
      }),
      rendition: "opaque",
      interactionCache: cache,
      ringCapacity: 6
    });
    const highEstimates = createRuntimeResourcePlan({
      catalog: fakeCatalog({
        estimate: {
          decodedPixelBytes: Number.MAX_SAFE_INTEGER,
          persistentCacheBytes: Number.MAX_SAFE_INTEGER,
          runtimeWorkingSetBytes: Number.MAX_SAFE_INTEGER
        }
      }),
      rendition: "opaque",
      interactionCache: cache,
      ringCapacity: 6
    });
    expect(highEstimates.totalBytes).toBe(lowEstimates.totalBytes);

    expect(() => createRuntimeResourcePlan({
      catalog: fakeCatalog({
        ownedByteLength: MAX_PLAYER_RUNTIME_BYTES,
        manifestMaxRuntimeBytes: Number.MAX_SAFE_INTEGER
      }),
      rendition: "opaque",
      interactionCache: cache,
      ringCapacity: 6,
      hostMaxRuntimeBytes: Number.MAX_SAFE_INTEGER
    })).toThrow("exceeds effective cap 67108864");
  });

  it("counts only two logical static surfaces even when states share IDs", () => {
    const base = fakeCatalog();
    const shared = fakeCatalog({ stateCount: 12, sharedStatic: true });
    const distinct = fakeCatalog({ stateCount: 12, sharedStatic: false });
    const plans = [base, shared, distinct].map((catalog) =>
      createRuntimeResourcePlan({
        catalog,
        rendition: "opaque",
        interactionCache: zeroCache(),
        ringCapacity: 6
      })
    );

    expect(new Set(plans.map(({ staticSwapBytes }) => staticSwapBytes)))
      .toEqual(new Set([16 * 16 * 4 * 2]));
    expect(new Set(plans.map(({ totalBytes }) => totalBytes)).size).toBe(1);
  });

  it("rounds allocation overhead upward and rejects unsafe arithmetic", () => {
    expect([0, 1, 2, 3, 4, 5].map((bytes) =>
      Number(roundedGpuAllocationBytes(bytes))
    )).toEqual([0, 2, 3, 4, 5, 7]);
    expect(() => checkedByteNumber(
      checkedByteProduct(
        [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
        "hostile product"
      ),
      "hostile product"
    )).toThrow("safe-integer range");
    expect(() => checkedByteNumber(
      checkedByteSum([Number.MAX_SAFE_INTEGER, 1], "hostile sum"),
      "hostile sum"
    )).toThrow("safe-integer range");
  });

  it("rejects mismatched caches, invalid rings, and invalid host caps", () => {
    const catalog = fakeCatalog();
    const cache = zeroCache();
    expect(() => createRuntimeResourcePlan({
      catalog,
      rendition: "opaque",
      interactionCache: { ...cache, rendition: "other" },
      ringCapacity: 6
    })).toThrow("does not match the selected rendition");
    for (const ringCapacity of [5, 13, 6.5]) {
      expect(() => createRuntimeResourcePlan({
        catalog,
        rendition: "opaque",
        interactionCache: cache,
        ringCapacity
      })).toThrow(RangeError);
    }
    for (const hostMaxRuntimeBytes of [0, -1, 1.5, Number.NaN]) {
      expect(() => createRuntimeResourcePlan({
        catalog,
        rendition: "opaque",
        interactionCache: cache,
        ringCapacity: 6,
        hostMaxRuntimeBytes
      })).toThrow(RangeError);
    }
  });
});

function zeroCache() {
  return createInteractionCachePlanFromSemanticSequences({
    rendition: "opaque",
    width: 16,
    height: 16,
    reversibleClips: [],
    cutRunways: [],
    deviceLimits: { maxTextureSize: 4_096, maxArrayTextureLayers: 128 }
  });
}

interface FakeCatalogOptions {
  readonly unitLengths?: Readonly<Record<string, readonly number[]>>;
  readonly ownedByteLength?: number;
  readonly manifestMaxRuntimeBytes?: number;
  readonly estimate?: {
    readonly decodedPixelBytes: number;
    readonly persistentCacheBytes: number;
    readonly runtimeWorkingSetBytes: number;
  };
  readonly stateCount?: number;
  readonly sharedStatic?: boolean;
}

function fakeCatalog(
  options: FakeCatalogOptions = {}
): RuntimeResourceCatalogView {
  const unitLengths = options.unitLengths ?? { body: [100, 1] };
  const units: UnitV01[] = [];
  const records = new Map<string, RuntimeCatalogAccessUnit>();
  let ordinal = 0;
  let offset = 1;
  for (const [unit, lengths] of Object.entries(unitLengths).sort()) {
    units.push({
      id: unit,
      kind: "body",
      playback: "loop",
      frameCount: lengths.length,
      ports: [{ id: "default", entryFrame: 0, portalFrames: [0] }],
      samples: [{
        rendition: "opaque",
        sampleStart: ordinal,
        sampleCount: lengths.length,
        sha256: "0".repeat(64)
      }]
    });
    for (let localFrame = 0; localFrame < lengths.length; localFrame += 1) {
      const length = lengths[localFrame]!;
      const record = {
        renditionIndex: 0,
        unitIndex: units.length - 1,
        frameIndex: localFrame,
        key: localFrame === 0,
        payloadOffset: offset,
        payloadLength: length
      } as AccessUnitRecord;
      records.set(`${unit}:${String(localFrame)}`, {
        rendition: "opaque",
        unit,
        localFrame,
        ordinal,
        record,
        range: { offset, length }
      });
      ordinal += 1;
      offset += length;
    }
  }

  const stateCount = options.stateCount ?? 1;
  const sharedStatic = options.sharedStatic ?? true;
  const manifest = fakeManifest({
    units,
    stateCount,
    sharedStatic,
    maxRuntimeBytes:
      options.manifestMaxRuntimeBytes ?? MAX_PLAYER_RUNTIME_BYTES,
    estimate: options.estimate
  });
  return {
    ownedByteLength: options.ownedByteLength ?? 1_000,
    manifest,
    records: {
      require(rendition, unit, localFrame) {
        if (rendition !== "opaque") throw new Error("missing rendition");
        const record = records.get(`${unit}:${String(localFrame)}`);
        if (record === undefined) throw new Error("missing record");
        return record;
      }
    }
  };
}

function fakeManifest(input: {
  readonly units: readonly UnitV01[];
  readonly stateCount: number;
  readonly sharedStatic: boolean;
  readonly maxRuntimeBytes: number;
  readonly estimate: FakeCatalogOptions["estimate"];
}): CompiledManifestV01 {
  const firstUnit = input.units[0]!;
  const staticFrames = Array.from(
    { length: input.sharedStatic ? 1 : input.stateCount },
    (_, index) => ({
      id: `static-${String(index)}`,
      offset: 1 + index,
      length: 1,
      width: 16,
      height: 16,
      sha256: "0".repeat(64)
    })
  );
  return {
    formatVersion: "0.1",
    generator: "resource-test",
    canvas: {
      width: 16,
      height: 16,
      fit: "contain",
      pixelAspect: [1, 1],
      colorSpace: "srgb"
    },
    frameRate: { numerator: 30, denominator: 1 },
    renditions: [{
      id: "opaque",
      profile: "avc-annexb-opaque-v0",
      codec: "avc1.42E020",
      codedWidth: 16,
      codedHeight: 16,
      alphaLayout: { type: "opaque-v0", colorRect: [0, 0, 16, 16] },
      bitrate: { average: 100_000, peak: 200_000 },
      capabilities: ["webcodecs", "webgl2"]
    }],
    units: input.units,
    staticFrames,
    initialState: "state-0",
    states: Array.from({ length: input.stateCount }, (_, index) => ({
      id: `state-${String(index)}`,
      bodyUnit: firstUnit.id,
      staticFrame: input.sharedStatic ? "static-0" : `static-${String(index)}`
    })),
    edges: [],
    bindings: [],
    readiness: {
      policy: "all-routes",
      bootstrapUnits: [firstUnit.id],
      immediateEdges: []
    },
    fallback: {
      unsupported: "per-state-static",
      reducedMotion: "per-state-static"
    },
    limits: {
      maxCompiledBytes: 32 * MEBIBYTE,
      maxRuntimeBytes: input.maxRuntimeBytes,
      decodedPixelBytes: input.estimate?.decodedPixelBytes ?? 0,
      persistentCacheBytes: input.estimate?.persistentCacheBytes ?? 0,
      runtimeWorkingSetBytes: input.estimate?.runtimeWorkingSetBytes ?? 0
    }
  };
}
