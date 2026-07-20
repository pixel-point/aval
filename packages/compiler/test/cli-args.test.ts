import { describe, expect, it } from "vitest";

import { parseCliArguments } from "../src/cli-args.js";
import { CompilerError } from "../src/diagnostics.js";

describe("CLI argument grammar", () => {
  it("parses the complete AV1 direct-input surface into exact values", () => {
    expect(parseCliArguments([
      "compile",
      "render.mov",
      "--loop", "0:120",
      "--codec", "av1",
      "--crf", "15",
      "--bit-depth", "10",
      "--cpu-used", "0",
      "--tiles", "4x2",
      "--row-mt",
      "--threads", "32",
      "--fps", "30000/1001",
      "--canvas", "1920x1080",
      "--alpha", "packed",
      "--out", "dist/render",
      "--ffmpeg", "/tools/ffmpeg",
      "--ffprobe", "/tools/ffprobe",
      "--normalize-vfr",
      "--force",
      "--json"
    ])).toEqual({
      command: "compile",
      input: "render.mov",
      output: "dist/render",
      loop: [0, 120],
      fps: { numerator: 30000, denominator: 1001 },
      canvas: [1920, 1080],
      codec: "av1",
      crf: 15,
      bitDepth: 10,
      cpuUsed: 0,
      tiles: { columns: 4, rows: 2 },
      rowMt: true,
      threads: 32,
      alpha: "packed",
      ffmpegPath: "/tools/ffmpeg",
      ffprobePath: "/tools/ffprobe",
      normalizeVfr: true,
      force: true,
      json: true
    });
  });

  it.each([
    {
      codec: "h264",
      flags: ["--crf", "1", "--preset", "placebo"],
      expected: { codec: "h264", crf: 1, preset: "placebo" }
    },
    {
      codec: "h265",
      flags: ["--crf", "32", "--preset", "veryslow", "--threads", "8"],
      expected: { codec: "h265", crf: 32, preset: "veryslow", threads: 8 }
    },
    {
      codec: "vp9",
      flags: [
        "--crf", "40", "--deadline", "best", "--cpu-used", "-8",
        "--threads", "8"
      ],
      expected: {
        codec: "vp9",
        crf: 40,
        deadline: "best",
        cpuUsed: -8,
        threads: 8
      }
    },
    {
      codec: "av1",
      flags: [
        "--crf", "63", "--bit-depth", "8", "--cpu-used", "8",
        "--tiles", "8x8", "--threads", "64"
      ],
      expected: {
        codec: "av1",
        crf: 63,
        bitDepth: 8,
        cpuUsed: 8,
        tiles: { columns: 8, rows: 8 },
        rowMt: false,
        threads: 64
      }
    }
  ] as const)("parses the closed $codec compression controls", ({ codec, flags, expected }) => {
    expect(parseCliArguments([
      "compile", "clip.mov", "--loop", "0:2", "--codec", codec,
      ...flags, "--out", "clip"
    ])).toMatchObject(expected);
  });

  it("requires only explicit codec selection and leaves media timeout opt-in", () => {
    const parsed = parseCliArguments([
      "compile", "clip.mp4", "--loop", "0:2", "--codec", "h264",
      "--out", "clip"
    ]);
    expect(parsed).toMatchObject({ codec: "h264", alpha: "auto" });
    expect(parsed).not.toHaveProperty("mediaTimeoutMs");

    expect(parseCliArguments([
      "compile", "clip.mp4", "--loop", "0:2", "--codec", "h265",
      "--crf", "20", "--media-timeout-ms", "900000", "--out", "clip"
    ])).toMatchObject({
      codec: "h265",
      crf: 20,
      mediaTimeoutMs: 900_000
    });
  });

  it("accepts CRF without a bitrate ceiling and removes old rate-control flags", () => {
    expect(parseCliArguments([
      "compile", "clip.mp4", "--loop", "0:2", "--codec", "h264",
      "--crf", "20", "--out", "clip"
    ])).toMatchObject({ codec: "h264", crf: 20 });
    expectUsage([
      "compile", "clip.mp4", "--loop", "0:2", "--codec", "h264",
      "--bitrate", "1000000:2000000", "--out", "clip"
    ]);
    expectUsage([
      "compile", "clip.mp4", "--loop", "0:2", "--codec", "h264",
      "--max-bitrate", "2000000", "--out", "clip"
    ]);
  });

  it("accepts the closed PNG sequence grammar and a leading-dash path after --", () => {
    expect(parseCliArguments([
      "compile",
      "--out", "out",
      "--loop", "0:2",
      "--codec", "vp9",
      "--crf", "40",
      "--deadline", "best",
      "--cpu-used", "0",
      "--threads", "8",
      "--frames", "7:2",
      "--fps", "30/1",
      "--canvas", "32x32",
      "--",
      "-frames-%04d.png"
    ])).toMatchObject({
      input: "-frames-%04d.png",
      codec: "vp9",
      frames: { firstNumber: 7, frameCount: 2 }
    });
  });

  it("rejects every direct encoding override for project input", () => {
    expect(parseCliArguments([
      "compile", "motion.json", "--media-timeout-ms", "900000",
      "--out", "motion"
    ])).toMatchObject({
      command: "compile",
      input: "motion.json",
      output: "motion",
      mediaTimeoutMs: 900_000
    });
    const overrides = [
      ["--codec", "h264"],
      ["--crf", "20"],
      ["--preset", "slow"],
      ["--deadline", "best"],
      ["--cpu-used", "0"],
      ["--bit-depth", "10"],
      ["--tiles", "4x2"],
      ["--threads", "8"],
      ["--row-mt"],
      ["--loop", "0:2"],
      ["--fps", "30/1"],
      ["--canvas", "32x32"],
      ["--alpha", "auto"],
      ["--frames", "0:2"],
      ["--normalize-vfr"]
    ];
    for (const override of overrides) {
      expectUsage([
        "compile", "motion.json", "--out", "motion", ...override
      ]);
    }
  });

  it("defaults direct alpha to auto and accepts only its closed policy", () => {
    for (const policy of ["auto", "opaque", "packed"] as const) {
      expect(parseCliArguments([
        "compile", "clip.mp4", "--loop", "0:2", "--codec", "h264",
        "--alpha", policy, "--out", "clip"
      ])).toMatchObject({ alpha: policy });
    }
    expectUsage([
      "compile", "clip.mp4", "--loop", "0:2", "--codec", "h264",
      "--alpha", "stacked", "--out", "clip"
    ]);
  });

  it("accepts author-controlled canvas and PNG frame counts above old ceilings", () => {
    expect(parseCliArguments([
      "compile", "clip.mp4", "--loop", "0:1001", "--codec", "h265",
      "--canvas", "1920x1080", "--out", "clip"
    ])).toMatchObject({ loop: [0, 1001], canvas: [1920, 1080] });
    expect(parseCliArguments([
      "compile", "frames-%04d.png", "--loop", "0:2", "--codec", "av1",
      "--frames", "0:1801", "--fps", "30/1", "--out", "clip"
    ])).toMatchObject({ frames: { firstNumber: 0, frameCount: 1801 } });
  });

  it.each([
    ["missing codec", ["compile", "a.mp4", "--loop", "0:2", "--out", "x"]],
    ["unknown codec", direct("unknown")],
    ["H264 threads", direct("h264", "--threads", "8")],
    ["H264 deadline", direct("h264", "--deadline", "best")],
    ["H265 cpu-used", direct("h265", "--cpu-used", "0")],
    ["VP9 preset", direct("vp9", "--preset", "slow")],
    ["VP9 bit depth", direct("vp9", "--bit-depth", "8")],
    ["AV1 preset", direct("av1", "--preset", "slow")],
    ["AV1 deadline", direct("av1", "--deadline", "best")],
    ["row MT outside AV1", direct("vp9", "--row-mt")],
    ["H264 CRF above range", direct("h264", "--crf", "52")],
    ["H264 lossless CRF", direct("h264", "--crf", "0")],
    ["VP9 CRF above range", direct("vp9", "--crf", "64")],
    ["bad preset", direct("h265", "--preset", "impossibly-slow")],
    ["bad deadline", direct("vp9", "--deadline", "slow")],
    ["VP9 cpu below range", direct("vp9", "--cpu-used", "-9")],
    ["AV1 negative cpu", direct("av1", "--cpu-used", "-1")],
    ["AV1 cpu above range", direct("av1", "--cpu-used", "9")],
    ["bad bit depth", direct("av1", "--bit-depth", "12")],
    ["non-power tiles", direct("av1", "--tiles", "3x2")],
    ["excess tiles", direct("av1", "--tiles", "16x8")],
    ["bad tile syntax", direct("av1", "--tiles", "4:2")],
    ["zero threads", direct("h265", "--threads", "0")],
    ["excess threads", direct("av1", "--threads", "65")],
    ["zero media timeout", direct("h264", "--media-timeout-ms", "0")],
    ["custom report path", direct("h264", "--report", "custom.json")],
    ["missing direct loop", ["compile", "clip.mp4", "--codec", "h264", "--out", "x"]],
    ["missing output", ["compile", "clip.mp4", "--loop", "0:2", "--codec", "h264"]],
    ["bad range", direct("h264", "--loop", "2:2")],
    ["unreduced fps", direct("h264", "--fps", "60/2")],
    ["bad canvas", direct("h264", "--canvas", "0x32")],
    ["video frames", direct("h264", "--frames", "0:2")],
    ["normalize missing fps", direct("h264", "--normalize-vfr")],
    ["relative tool", direct("h264", "--ffmpeg", "bin/ffmpeg")],
    ["duplicate", ["inspect", "a.avl", "--json", "--json"]],
    ["unknown", ["inspect", "a.avl", "--wat"]],
    ["inline value", ["unpack", "a.avl", "--out=dir"]],
    ["extra positional", ["validate", "a.avl", "b.avl"]]
  ] as const)("rejects %s", (_label, argv) => {
    expectUsage(argv);
  });

  it.each([
    ["missing frames", directPng("--fps", "30/1")],
    ["missing fps", directPng("--frames", "0:2")],
    [
      "invalid token",
      [
        "compile", "a-%d.png", "--loop", "0:2", "--codec", "h264",
        "--frames", "0:2", "--fps", "30/1", "--out", "x"
      ]
    ]
  ] as const)("rejects PNG input with %s", (_label, argv) => {
    expectUsage(argv);
  });

  it("parses every read-only and workflow command", () => {
    expect(parseCliArguments(["inspect", "a.avl", "--json"])).toEqual({
      command: "inspect", input: "a.avl", json: true
    });
    expect(parseCliArguments(["validate", "a.avl"])).toEqual({
      command: "validate", input: "a.avl", json: false
    });
    expect(parseCliArguments(["unpack", "a.avl", "--out", "dir"])).toEqual({
      command: "unpack", input: "a.avl", output: "dir", json: false
    });
    expect(parseCliArguments(["init", "starter"])).toEqual({
      command: "init", directory: "starter", json: false
    });
    expect(parseCliArguments([
      "dev", "motion.json", "--out", "x", "--media-timeout-ms", "900000"
    ])).toEqual({
      command: "dev",
      project: "motion.json",
      output: "x",
      mediaTimeoutMs: 900_000,
      force: false,
      port: 4174,
      open: false,
      json: false
    });
  });
});

function direct(codec: string, ...flags: readonly string[]): readonly string[] {
  return [
    "compile", "a.mp4", "--loop", "0:2", "--codec", codec,
    ...flags, "--out", "x"
  ];
}

function directPng(...flags: readonly string[]): readonly string[] {
  return [
    "compile", "a-%04d.png", "--loop", "0:2", "--codec", "h264",
    ...flags, "--out", "x"
  ];
}

function expectUsage(argv: readonly string[]): void {
  try {
    parseCliArguments(argv);
    throw new Error("expected CLI usage rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(CompilerError);
    expect((error as CompilerError).code).toBe("CLI_USAGE");
  }
}
