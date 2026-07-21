import type {
  CompiledManifest,
  OpaqueProductionRenditionV1_1,
  ProductionRendition,
  VideoCodec,
  VideoLayout
} from "@pixel-point/aval-format";
import { describe, expect, it, vi } from "vitest";

import { certifyVideoRenditions } from "./video-rendition-certification.js";
import { selectVideoRendition } from "./video-rendition-selection.js";

const CODECS = Object.freeze({
  h264: Object.freeze({ codec: "avc1.42E020", bitstream: "annex-b" as const, bitDepth: 8 as const }),
  h265: Object.freeze({ codec: "hvc1.1.6.L30.90", bitstream: "annex-b" as const, bitDepth: 8 as const }),
  vp9: Object.freeze({
    codec: "vp09.00.10.08.01.01.01.01.00",
    bitstream: "frame" as const,
    bitDepth: 8 as const
  }),
  av1: Object.freeze({
    codec: "av01.0.00M.10.0.110.01.01.01.0",
    bitstream: "low-overhead" as const,
    bitDepth: 10 as const
  })
});

describe("catalog-certified video rendition selection", () => {
  it.each(["h264", "h265", "vp9", "av1"] as const)(
    "probes the exact byte-free %s decoder configuration",
    async (family) => {
      const renditions = certified(createManifest({ family }));
      const probe = vi.fn(async () => true);

      const result = await selectVideoRendition({
        renditions,
        isResourceEligible: () => true,
        probeDecoderConfig: probe
      });

      expect(result.outcome).toBe("selected");
      if (result.outcome !== "selected") throw new Error("fixture was unsupported");
      expect(result.selected).toBe(renditions[0]);
      expect(result.selected.decoderConfig).toMatchObject({
        codec: CODECS[family].codec,
        codedWidth: 64,
        codedHeight: 32,
        displayAspectWidth: 64,
        displayAspectHeight: 32,
        colorSpace: {
          primaries: "bt709",
          transfer: "bt709",
          matrix: "bt709",
          fullRange: false
        }
      });
      expect(probe).toHaveBeenCalledWith(
        result.selected.decoderConfig,
        result.selected
      );
    }
  );

  it("preserves authored order while filtering ineligible and unsupported rungs", async () => {
    const renditions = certified(createManifest({
      family: "h264",
      width: 96,
      height: 96,
      renditions: [
        createRendition("ineligible", "h264", 32, 32),
        createRendition("unsupported", "h264", 96, 96),
        createRendition("selected", "h264", 64, 64)
      ]
    }));
    const probes: string[] = [];

    const result = await selectVideoRendition({
      renditions,
      isResourceEligible: ({ rendition }) => rendition.id !== "ineligible",
      probeDecoderConfig: async (_config, candidate) => {
        probes.push(candidate.rendition.id);
        return candidate.rendition.id === "selected";
      }
    });

    expect(result.outcome).toBe("selected");
    if (result.outcome !== "selected") throw new Error("fixture was unsupported");
    expect(result.selected).toBe(renditions[2]);
    expect(probes).toEqual(["unsupported", "selected"]);
    expect(result.attempts.map(({ outcome }) => outcome)).toEqual([
      "resource-ineligible",
      "decoder-unsupported",
      "selected"
    ]);
  });

  it("never starts a later probe until the previous result settles", async () => {
    const renditions = certified(createManifest({
      family: "vp9",
      renditions: [
        createRendition("first", "vp9", 64, 32),
        createRendition("second", "vp9", 64, 32)
      ]
    }));
    let resolveFirst!: (supported: boolean) => void;
    const first = new Promise<boolean>((resolve) => { resolveFirst = resolve; });
    const calls: string[] = [];
    const pending = selectVideoRendition({
      renditions,
      isResourceEligible: () => true,
      probeDecoderConfig: (_config, candidate) => {
        calls.push(candidate.rendition.id);
        return candidate.authoredIndex === 0 ? first : Promise.resolve(true);
      }
    });

    expect(calls).toEqual(["first"]);
    resolveFirst(false);
    const result = await pending;
    expect(calls).toEqual(["first", "second"]);
    expect(result.outcome).toBe("selected");
  });

  it("returns deterministic exhaustion and propagates terminal probe failures", async () => {
    const renditions = certified(createManifest({ family: "h265" }));
    await expect(selectVideoRendition({
      renditions,
      isResourceEligible: () => true,
      probeDecoderConfig: async () => false
    })).resolves.toMatchObject({ outcome: "all-unsupported", selected: null });

    const terminal = new Error("worker channel failed");
    await expect(selectVideoRendition({
      renditions,
      isResourceEligible: () => true,
      probeDecoderConfig: async () => { throw terminal; }
    })).rejects.toBe(terminal);
  });

  it("derives packed-alpha storage once at catalog certification", () => {
    const [candidate] = certified(createManifest({
      family: "h265",
      layout: "packed-alpha",
      width: 63,
      height: 31,
      renditions: [{
        ...createRendition("packed", "h265", 64, 72),
        alphaLayout: {
          type: "stacked",
          colorRect: [0, 0, 63, 31],
          alphaRect: [0, 40, 63, 31]
        },
        outputQualification: {
          kind: "packed-alpha-v1",
          unit: "qualification",
          frame: 0,
          samples: [{ x: 0, y: 40, expectedRange: [0, 255] }]
        }
      }]
    }));
    expect(candidate?.geometry).toMatchObject({
      decodedStorageRect: [0, 0, 64, 72],
      decodedRgbaBytes: 18_432
    });
  });
});

function certified(manifest: CompiledManifest) {
  return certifyVideoRenditions(manifest);
}

function createManifest(options: Readonly<{
  family: VideoCodec;
  layout?: VideoLayout;
  width?: number;
  height?: number;
  renditions?: readonly ProductionRendition[];
}>): CompiledManifest {
  const spec = CODECS[options.family];
  const width = options.width ?? 64;
  const height = options.height ?? 32;
  return {
    formatVersion: "1.1",
    generator: "selection-test",
    codec: options.family,
    bitstream: spec.bitstream,
    layout: options.layout ?? "opaque",
    canvas: { width, height, fit: "contain", pixelAspect: [1, 1], colorSpace: "srgb" },
    frameRate: { numerator: 30, denominator: 1 },
    renditions: options.renditions ?? [createRendition("main", options.family, width, height)],
    units: [],
    initialState: "idle",
    states: [],
    edges: [],
    bindings: [],
    readiness: { policy: "all-routes", bootstrapUnits: [], immediateEdges: [] },
    limits: {
      maxCompiledBytes: 1_000_000,
      maxRuntimeBytes: 1_000_000,
      decodedPixelBytes: 1,
      persistentCacheBytes: 1,
      runtimeWorkingSetBytes: 1
    }
  } as CompiledManifest;
}

function createRendition(
  id: string,
  family: VideoCodec,
  width: number,
  height: number
): OpaqueProductionRenditionV1_1 {
  const spec = CODECS[family];
  return {
    id,
    codec: spec.codec,
    bitDepth: spec.bitDepth,
    codedWidth: width,
    codedHeight: height,
    alphaLayout: { type: "opaque", colorRect: [0, 0, width, height] },
    bitrate: { average: 100_000, peak: 200_000 }
  };
}
