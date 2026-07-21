import type { CompiledManifest, VideoCodec } from "@pixel-point/aval-format";
import type { MotionGraphSnapshot } from "@pixel-point/aval-graph";
import { describe, expect, it } from "vitest";

import type { RuntimeAssetCatalog } from "./asset-catalog.js";
import type { IntegratedCandidateAttemptContext } from "./integrated-player-contracts.js";
import { createVideoCandidateWorkerSetup } from "./video-candidate-config.js";
import { VideoCandidateFactory } from "./video-candidate-factory.js";
import { certifyVideoRenditions } from "./video-rendition-certification.js";

const SPECS = Object.freeze({
  h264: Object.freeze({ codec: "avc1.42E020", bitstream: "annex-b" as const }),
  h265: Object.freeze({ codec: "hvc1.1.6.L30.90", bitstream: "annex-b" as const }),
  vp9: Object.freeze({
    codec: "vp09.00.10.08.01.01.01.01.00",
    bitstream: "frame" as const
  }),
  av1: Object.freeze({
    codec: "av01.0.00M.10.0.110.01.01.01.0",
    bitstream: "low-overhead" as const
  })
});

describe("codec-neutral video candidate factory", () => {
  it.each(["h264", "h265", "vp9", "av1"] as const)(
    "requests interactive decoder latency for %s",
    (family) => {
      const setup = createVideoCandidateWorkerSetup(createContext(family));

      expect(setup.configure.config).toMatchObject({
        hardwareAcceleration: "no-preference",
        optimizeForLatency: true
      });
    }
  );

  it.each(["h264", "h265", "vp9", "av1"] as const)(
    "accepts an exact inspected %s context",
    async (family) => {
      const context = createContext(family);
      const factory = createFactory();

      const attempt = factory.create(context);

      expect(attempt.playback).toBeTypeOf("object");
      await expect(attempt.dispose()).resolves.toBeUndefined();
    }
  );

  it("rejects a candidate/asset mix before creating decoder resources", () => {
    const h264 = createContext("h264");
    const vp9 = createContext("vp9");
    const mixed = Object.freeze({
      ...h264,
      candidate: vp9.candidate,
      inspection: vp9.inspection
    }) as Readonly<IntegratedCandidateAttemptContext>;

    expect(() => createFactory().create(mixed)).toThrow(
      /does not belong to its inspected asset catalog/iu
    );
  });
});

function createFactory(): VideoCandidateFactory {
  return new VideoCandidateFactory({
    workerFactory: Object.freeze({
      available: true,
      create() { throw new Error("worker must not be created by this test"); }
    }),
    rendererFactory: Object.freeze({
      available: true,
      create() { throw new Error("renderer must not be created by this test"); }
    }),
    readinessFactory: Object.freeze({
      create() { throw new Error("readiness must not be created by this test"); }
    })
  });
}

function createContext(
  family: keyof typeof SPECS
): Readonly<IntegratedCandidateAttemptContext> {
  const manifest = createManifest(family);
  const videoRenditions = certifyVideoRenditions(manifest);
  const candidate = videoRenditions[0]!;
  const catalog = {
    manifest,
    videoRenditions,
    ownsVideoRendition: (value: unknown) => value === candidate,
    renditions: {
      require(id: string) {
        const rendition = manifest.renditions.find((value) => value.id === id);
        if (rendition === undefined) throw new Error("missing rendition");
        return rendition;
      }
    }
  } as unknown as RuntimeAssetCatalog;
  return Object.freeze({
    catalog,
    candidate,
    inspection: Object.freeze({
      family,
      bitstream: manifest.bitstream,
      bitDepth: candidate.rendition.bitDepth,
      decoderConfig: candidate.decoderConfig,
      units: Object.freeze([])
    }),
    graphSnapshot: Object.freeze({}) as Readonly<MotionGraphSnapshot>,
    hostMaxRuntimeBytes: null
  });
}

function createManifest(family: keyof typeof SPECS): CompiledManifest {
  const spec = SPECS[family];
  const bitDepth = family === "av1" ? 10 as const : 8 as const;
  return {
    formatVersion: "1.1",
    generator: "candidate-test",
    codec: family as VideoCodec,
    bitstream: spec.bitstream,
    layout: "opaque",
    canvas: {
      width: 64,
      height: 32,
      fit: "contain",
      pixelAspect: [1, 1],
      colorSpace: "srgb"
    },
    frameRate: { numerator: 30, denominator: 1 },
    renditions: [{
      id: "main",
      codec: spec.codec,
      bitDepth,
      codedWidth: 64,
      codedHeight: 32,
      alphaLayout: { type: "opaque", colorRect: [0, 0, 64, 32] },
      bitrate: { average: 100_000, peak: 150_000 }
    }],
    units: [],
    initialState: "idle",
    states: [],
    edges: [],
    bindings: [],
    readiness: { policy: "all-routes", bootstrapUnits: [], immediateEdges: [] },
    limits: {
      maxCompiledBytes: 1_000_000,
      maxRuntimeBytes: 1_000_000,
      decodedPixelBytes: 8_192,
      persistentCacheBytes: 1,
      runtimeWorkingSetBytes: 1
    }
  };
}
