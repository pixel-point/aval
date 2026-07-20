import { describe, expect, it } from "vitest";

import { CompilerError } from "../src/diagnostics.js";
import {
  H264_ENCODER_PRESETS,
  H265_ENCODER_PRESETS
} from "../src/model.js";
import {
  cloneNormalizedVideoEncodings,
  cloneVideoEncodings,
  videoCompressionArguments
} from "../src/compile/video-encoding-policy.js";

const canvas = {
  width: 1_920,
  height: 1_080,
  fit: "contain" as const,
  pixelAspect: [1, 1] as const,
  colorSpace: "srgb" as const
};

function rendition(crf = 20): any {
  return { id: "video.1x", width: 1_920, height: "auto", crf };
}

describe("video encoding policy", () => {
  it("rejects lossless CRF zero for constrained-baseline H.264", () => {
    expect(() => cloneVideoEncodings([{
      codec: "h264",
      preset: "medium",
      renditions: [rendition(0)]
    }], canvas)).toThrow(/crf/u);
  });

  it("snapshots normalized policies through the same codec validator", () => {
    const normalized = cloneVideoEncodings([{
      codec: "h264",
      preset: "medium",
      renditions: [rendition(30)]
    }], canvas);
    const snapshot = cloneNormalizedVideoEncodings(normalized);

    expect(snapshot).toEqual(normalized);
    expect(snapshot).not.toBe(normalized);
    expect(snapshot[0]).not.toBe(normalized[0]);
    expect(Object.isFrozen(snapshot[0]?.renditions)).toBe(true);
    expect(() => cloneNormalizedVideoEncodings([{
      ...normalized[0],
      renditions: [rendition(30)]
    }])).toThrow(CompilerError);
  });

  it("accepts every supported codec policy and lowers owned FFmpeg controls", () => {
    const encodings = cloneVideoEncodings([
      {
        codec: "h264",
        preset: "veryslow",
        renditions: [rendition(20)]
      },
      {
        codec: "h265",
        preset: "placebo",
        threads: 16,
        renditions: [rendition(32)]
      },
      {
        codec: "vp9",
        deadline: "best",
        cpuUsed: -8,
        threads: 8,
        renditions: [rendition(40)]
      },
      {
        codec: "av1",
        bitDepth: 10,
        cpuUsed: 0,
        tiles: { columns: 4, rows: 2 },
        rowMt: true,
        threads: 32,
        renditions: [rendition(15)]
      }
    ], canvas);

    expect(videoCompressionArguments(encodings[0]!, encodings[0]!.renditions[0]!))
      .toEqual(["-crf", "20", "-preset", "veryslow"]);
    expect(videoCompressionArguments(encodings[1]!, encodings[1]!.renditions[0]!))
      .toEqual(["-crf", "32", "-preset", "placebo", "-threads", "16"]);
    expect(videoCompressionArguments(encodings[2]!, encodings[2]!.renditions[0]!))
      .toEqual([
        "-crf", "40", "-b:v", "0", "-deadline", "best",
        "-cpu-used", "-8", "-threads", "8"
      ]);
    expect(videoCompressionArguments(encodings[3]!, encodings[3]!.renditions[0]!))
      .toEqual([
        "-crf", "15", "-b:v", "0", "-pix_fmt", "yuv420p10le",
        "-cpu-used", "0", "-tiles", "4x2", "-row-mt", "1",
        "-threads", "32"
      ]);
  });

  it("accepts the complete H.264 and H.265 preset allowlists through placebo", () => {
    for (const preset of H264_ENCODER_PRESETS) {
      expect(cloneVideoEncodings([{ codec: "h264", preset, renditions: [rendition()] }], canvas))
        .toHaveLength(1);
    }
    for (const preset of H265_ENCODER_PRESETS) {
      expect(cloneVideoEncodings([{
        codec: "h265", preset, threads: 1, renditions: [rendition()]
      }], canvas)).toHaveLength(1);
    }
  });

  it("enforces codec-specific CRF bounds", () => {
    for (const codec of ["h264", "h265"] as const) {
      const minimum = codec === "h264" ? 1 : 0;
      const base = codec === "h264"
        ? { codec, preset: "medium", renditions: [rendition(minimum)] }
        : { codec, preset: "medium", threads: 1, renditions: [rendition(minimum)] };
      expect(cloneVideoEncodings([base], canvas)).toHaveLength(1);
      base.renditions[0].crf = 51;
      expect(cloneVideoEncodings([base], canvas)).toHaveLength(1);
      for (const crf of [minimum - 1, 52]) {
        base.renditions[0].crf = crf;
        expect(() => cloneVideoEncodings([base], canvas)).toThrow(CompilerError);
      }
    }

    for (const codec of ["vp9", "av1"] as const) {
      const base: any = codec === "vp9"
        ? { codec, deadline: "good", cpuUsed: 0, threads: 1, renditions: [rendition(0)] }
        : {
            codec, bitDepth: 8, cpuUsed: 0,
            tiles: { columns: 1, rows: 1 }, rowMt: false, threads: 1,
            renditions: [rendition(0)]
          };
      expect(cloneVideoEncodings([base], canvas)).toHaveLength(1);
      base.renditions[0].crf = 63;
      expect(cloneVideoEncodings([base], canvas)).toHaveLength(1);
      for (const crf of [-1, 64]) {
        base.renditions[0].crf = crf;
        expect(() => cloneVideoEncodings([base], canvas)).toThrow(CompilerError);
      }
    }
  });

  it("validates deadline, cpu-used, bit depth, tiles, row-mt, and threads", () => {
    const invalidPolicies: any[] = [
      { codec: "vp9", deadline: "slow", cpuUsed: 0, threads: 1, renditions: [rendition()] },
      { codec: "vp9", deadline: "best", cpuUsed: -9, threads: 1, renditions: [rendition()] },
      { codec: "vp9", deadline: "best", cpuUsed: 9, threads: 1, renditions: [rendition()] },
      { codec: "vp9", deadline: "best", cpuUsed: 0, threads: 0, renditions: [rendition()] },
      {
        codec: "av1", bitDepth: 9, cpuUsed: 0,
        tiles: { columns: 1, rows: 1 }, rowMt: true, threads: 1,
        renditions: [rendition()]
      },
      {
        codec: "av1", bitDepth: 12, cpuUsed: 0,
        tiles: { columns: 1, rows: 1 }, rowMt: true, threads: 1,
        renditions: [rendition()]
      },
      {
        codec: "av1", bitDepth: 10, cpuUsed: -1,
        tiles: { columns: 1, rows: 1 }, rowMt: true, threads: 1,
        renditions: [rendition()]
      },
      {
        codec: "av1", bitDepth: 10, cpuUsed: 9,
        tiles: { columns: 1, rows: 1 }, rowMt: true, threads: 1,
        renditions: [rendition()]
      },
      {
        codec: "av1", bitDepth: 10, cpuUsed: 0,
        tiles: { columns: 3, rows: 1 }, rowMt: true, threads: 1,
        renditions: [rendition()]
      },
      {
        codec: "av1", bitDepth: 10, cpuUsed: 0,
        tiles: { columns: 16, rows: 8 }, rowMt: true, threads: 1,
        renditions: [rendition()]
      },
      {
        codec: "av1", bitDepth: 10, cpuUsed: 0,
        tiles: { columns: 1, rows: 1 }, rowMt: 1, threads: 65,
        renditions: [rendition()]
      }
    ];
    for (const policy of invalidPolicies) {
      expect(() => cloneVideoEncodings([policy], canvas)).toThrow(CompilerError);
    }
  });

  it("rejects codec controls placed on the wrong union member", () => {
    const cases: any[] = [
      { codec: "h264", preset: "medium", threads: 1, renditions: [rendition()] },
      { codec: "h265", preset: "medium", threads: 1, deadline: "best", renditions: [rendition()] },
      { codec: "vp9", deadline: "best", cpuUsed: 0, threads: 1, preset: "slow", renditions: [rendition()] },
      {
        codec: "av1", bitDepth: 10, cpuUsed: 0,
        tiles: { columns: 1, rows: 1 }, rowMt: true, threads: 1,
        deadline: "best", renditions: [rendition()]
      }
    ];
    for (const policy of cases) {
      expect(() => cloneVideoEncodings([policy], canvas)).toThrow(CompilerError);
    }
  });
});
