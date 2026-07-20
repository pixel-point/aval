import { describe, expect, it } from "vitest";
import { deriveVideoRenditionGeometry } from "@pixel-point/aval-format";

import type {
  NormalizedSourceRenditionTarget,
  NormalizedVideoEncoding
} from "../src/model.js";
import { createEncodeVideoUnitInvocation } from "../src/ffmpeg/video-encode-unit.js";

const rendition: NormalizedSourceRenditionTarget = {
  id: "video.4k",
  width: 3_840,
  height: 2_160,
  crf: 20
};

function invocation(encoding: NormalizedVideoEncoding, bitDepth: 8 | 10 = 8) {
  const target = encoding.renditions[0]!;
  const geometry = deriveVideoRenditionGeometry({
    canvasWidth: target.width,
    canvasHeight: target.height,
    layout: "opaque",
    visibleWidth: target.width,
    visibleHeight: target.height,
    storage: { widthAlignment: 2, heightAlignment: 2 }
  });
  return createEncodeVideoUnitInvocation({
    source: {
      path: "/private/spool/render.yuv",
      width: target.width,
      height: target.height,
      bitDepth,
      frameRate: { numerator: 60, denominator: 1 },
      frameBytes: target.width * target.height * 3 / 2 * (bitDepth === 10 ? 2 : 1)
    },
    startFrame: 3,
    endFrame: 9,
    encoding,
    rendition: target,
    geometry
  });
}

function expectArguments(
  actual: readonly string[],
  expected: readonly string[]
): void {
  const start = actual.findIndex((value, index) =>
    expected.every((candidate, offset) => actual[index + offset] === candidate)
  );
  expect(start, `missing ordered argv: ${expected.join(" ")}`).toBeGreaterThanOrEqual(0);
}

describe("codec-major unit encoder argv", () => {
  it("owns packed H.264 macroblock padding and the matching SPS crop", () => {
    const packedRendition: NormalizedSourceRenditionTarget = {
      id: "motion.1x",
      width: 48,
      height: 48,
      crf: 24
    };
    const geometry = deriveVideoRenditionGeometry({
      canvasWidth: 48,
      canvasHeight: 48,
      layout: "packed-alpha",
      visibleWidth: 48,
      visibleHeight: 48,
      storage: { widthAlignment: 16, heightAlignment: 16 }
    });
    expect(geometry).toMatchObject({
      codedWidth: 48,
      codedHeight: 112,
      decodedStorageRect: [0, 0, 48, 104]
    });
    const result = createEncodeVideoUnitInvocation({
      source: {
        path: "/private/spool/render.yuv",
        width: 48,
        height: 112,
        bitDepth: 8,
        frameRate: { numerator: 30, denominator: 1 },
        frameBytes: 48 * 112 * 3 / 2
      },
      startFrame: 0,
      endFrame: 8,
      encoding: {
        codec: "h264",
        preset: "slow",
        renditions: [packedRendition]
      },
      rendition: packedRendition,
      geometry
    });
    const parameters = result.arguments[result.arguments.indexOf("-x264-params") + 1];
    expect(parameters).toContain("crop-rect=0,0,0,8");
  });

  it("pins H.264 to the constrained-baseline compatibility vector after the preset", () => {
    const result = invocation({
      codec: "h264",
      preset: "veryslow",
      renditions: [rendition]
    });
    expectArguments(result.arguments, [
      "-c:v", "libx264", "-crf", "20", "-preset", "veryslow"
    ]);
    expectArguments(result.arguments, [
      "-g", "6", "-keyint_min", "6", "-sc_threshold", "0"
    ]);
    expect(result.arguments).not.toContain("zerolatency");
    expectArguments(result.arguments, ["-profile:v", "baseline"]);
    expectArguments(result.arguments, ["-level:v", "5.2"]);
    expectArguments(result.arguments, ["-bf", "0", "-refs", "1"]);
    expectArguments(result.arguments, ["-maxrate", "240000000"]);
    expectArguments(result.arguments, ["-bufsize", "240000000"]);
    const parameters = result.arguments[result.arguments.indexOf("-x264-params") + 1];
    expect(parameters).toContain("8x8dct=0");
    expect(parameters).toContain("bframes=0");
    expect(parameters).toContain("cabac=0");
    expect(parameters).toContain("ref=1");
    expect(parameters).toContain("weightp=0");
    expect(result.arguments.at(-2)).toBe("h264");
  });

  it.each([
    {
      width: 48, height: 112, numerator: 30, denominator: 1,
      level: "1.1", maxrate: "192000", bufsize: "500000"
    },
    {
      width: 512, height: 512, numerator: 24, denominator: 1,
      level: "3.0", maxrate: "10000000", bufsize: "10000000"
    },
    {
      width: 640, height: 368, numerator: 24, denominator: 1,
      level: "3.0", maxrate: "10000000", bufsize: "10000000"
    },
    {
      width: 1_280, height: 720, numerator: 24, denominator: 1,
      level: "3.1", maxrate: "14000000", bufsize: "14000000"
    }
  ] as const)(
    "derives H.264 Level $level for $width×$height at $numerator/$denominator",
    ({ width, height, numerator, denominator, level, maxrate, bufsize }) => {
      const target = { id: "compat", width, height, crf: 23 };
      const geometry = deriveVideoRenditionGeometry({
        canvasWidth: width,
        canvasHeight: height,
        layout: "opaque",
        visibleWidth: width,
        visibleHeight: height,
        storage: { widthAlignment: 16, heightAlignment: 16 }
      });
      const result = createEncodeVideoUnitInvocation({
        source: {
          path: "/private/spool/render.yuv",
          width: geometry.codedWidth,
          height: geometry.codedHeight,
          bitDepth: 8,
          frameRate: { numerator, denominator },
          frameBytes: geometry.codedWidth * geometry.codedHeight * 3 / 2
        },
        startFrame: 0,
        endFrame: 6,
        encoding: { codec: "h264", preset: "veryslow", renditions: [target] },
        rendition: target,
        geometry
      });

      expectArguments(result.arguments, ["-level:v", level]);
      expectArguments(result.arguments, ["-maxrate", maxrate]);
      expectArguments(result.arguments, ["-bufsize", bufsize]);
    }
  );

  it("lowers the requested H.265 slow preset and thread count to raw HEVC", () => {
    const result = invocation({
      codec: "h265",
      preset: "placebo",
      threads: 32,
      renditions: [{ ...rendition, crf: 32 }]
    });
    expectArguments(result.arguments, [
      "-c:v", "libx265", "-crf", "32", "-preset", "placebo",
      "-threads", "32"
    ]);
    expect(result.arguments).toContain("-x265-params");
    expect(result.arguments.at(-2)).toBe("hevc");
  });

  it("lowers VP9 constant-quality best-deadline controls and retains IVF only as transport", () => {
    const result = invocation({
      codec: "vp9",
      deadline: "best",
      cpuUsed: -4,
      threads: 16,
      renditions: [{ ...rendition, crf: 40 }]
    });
    expectArguments(result.arguments, [
      "-c:v", "libvpx-vp9", "-crf", "40", "-b:v", "0",
      "-deadline", "best", "-cpu-used", "-4", "-threads", "16"
    ]);
    expect(result.arguments.at(-2)).toBe("ivf");
  });

  it("lowers the complete requested 10-bit AV1 compression vector", () => {
    const av1Rendition = { ...rendition, width: 1_920, height: 1_080, crf: 15 };
    const result = createEncodeVideoUnitInvocation({
      source: {
        path: "/private/spool/render.yuv",
        width: 1_920,
        height: 1_080,
        bitDepth: 10,
        frameRate: { numerator: 60, denominator: 1 },
        frameBytes: 1_920 * 1_080 * 3
      },
      startFrame: 0,
      endFrame: 6,
      encoding: {
        codec: "av1",
        bitDepth: 10,
        cpuUsed: 0,
        tiles: { columns: 4, rows: 2 },
        rowMt: true,
        threads: 32,
        renditions: [av1Rendition]
      },
      rendition: av1Rendition,
      geometry: deriveVideoRenditionGeometry({
        canvasWidth: 1_920,
        canvasHeight: 1_080,
        layout: "opaque",
        visibleWidth: 1_920,
        visibleHeight: 1_080,
        storage: { widthAlignment: 2, heightAlignment: 2 }
      })
    });
    expectArguments(result.arguments, [
      "-c:v", "libaom-av1", "-crf", "15", "-b:v", "0",
      "-pix_fmt", "yuv420p10le", "-cpu-used", "0",
      "-tiles", "4x2", "-row-mt", "1", "-threads", "32"
    ]);
    expectArguments(result.arguments, [
      "-aom-params",
      "color-primaries=1:transfer-characteristics=1:matrix-coefficients=1"
    ]);
    expect(result.arguments).not.toContain("-strict");
    expect(result.arguments).not.toContain("-tag:v");
    expect(result.arguments).not.toContain("-movflags");
    expect(result.arguments.at(-2)).toBe("ivf");
  });

  it("rejects rendition/pixel-policy mismatches before spawning FFmpeg", () => {
    expect(() => invocation({
      codec: "av1",
      bitDepth: 10,
      cpuUsed: 0,
      tiles: { columns: 1, rows: 1 },
      rowMt: false,
      threads: 1,
      renditions: [rendition]
    })).toThrow(/bit depth/u);
    expect(() => createEncodeVideoUnitInvocation({
      source: {
        path: "/private/spool/render.yuv",
        width: 10,
        height: 10,
        bitDepth: 8,
        frameRate: { numerator: 60, denominator: 1 },
        frameBytes: 150
      },
      startFrame: 0,
      endFrame: 1,
      encoding: { codec: "h264", preset: "medium", renditions: [rendition] },
      rendition,
      geometry: deriveVideoRenditionGeometry({
        canvasWidth: rendition.width,
        canvasHeight: rendition.height,
        layout: "opaque",
        visibleWidth: rendition.width,
        visibleHeight: rendition.height,
        storage: { widthAlignment: 2, heightAlignment: 2 }
      })
    })).toThrow(/dimensions/u);
  });

  it("rejects negative or chroma-misaligned H.264 crop deltas", () => {
    const packedRendition: NormalizedSourceRenditionTarget = {
      id: "motion.1x",
      width: 48,
      height: 48,
      crf: 24
    };
    const base = deriveVideoRenditionGeometry({
      canvasWidth: 48,
      canvasHeight: 48,
      layout: "packed-alpha",
      visibleWidth: 48,
      visibleHeight: 48,
      storage: { widthAlignment: 16, heightAlignment: 16 }
    });
    const encode = (decodedHeight: number) => createEncodeVideoUnitInvocation({
      source: {
        path: "/private/spool/render.yuv",
        width: 48,
        height: 112,
        bitDepth: 8,
        frameRate: { numerator: 30, denominator: 1 },
        frameBytes: 48 * 112 * 3 / 2
      },
      startFrame: 0,
      endFrame: 8,
      encoding: { codec: "h264", preset: "slow", renditions: [packedRendition] },
      rendition: packedRendition,
      geometry: {
        ...base,
        decodedStorageRect: [0, 0, 48, decodedHeight] as const
      }
    });
    expect(() => encode(114)).toThrow(/crop deltas/u);
    expect(() => encode(111)).toThrow(/crop deltas/u);
  });
});
