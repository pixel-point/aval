import { describe, expect, it } from "vitest";

import { parseCliArguments } from "../src/cli-args.js";
import { CompilerError } from "../src/diagnostics.js";

describe("CLI argument grammar", () => {
  it("parses the complete direct-input surface into exact values", () => {
    expect(parseCliArguments([
      "compile",
      "clip.mp4",
      "--loop", "12:36",
      "--fps", "30000/1001",
      "--canvas", "320x176",
      "--bitrate", "2000000:3000000",
      "--out", "clip.rma",
      "--report", "clip.report.json",
      "--ffmpeg", "/tools/ffmpeg",
      "--ffprobe", "/tools/ffprobe",
      "--normalize-vfr",
      "--force",
      "--json"
    ])).toEqual({
      command: "compile",
      input: "clip.mp4",
      output: "clip.rma",
      report: "clip.report.json",
      loop: [12, 36],
      fps: { numerator: 30000, denominator: 1001 },
      canvas: [320, 176],
      bitrate: { average: 2_000_000, peak: 3_000_000 },
      ffmpegPath: "/tools/ffmpeg",
      ffprobePath: "/tools/ffprobe",
      normalizeVfr: true,
      force: true,
      json: true
    });
  });

  it("accepts the closed PNG sequence grammar and a leading-dash path after --", () => {
    expect(parseCliArguments([
      "compile",
      "--out", "out.rma",
      "--loop", "0:2",
      "--frames", "7:2",
      "--fps", "30/1",
      "--canvas", "32x32",
      "--",
      "-frames-%04d.png"
    ])).toMatchObject({
      input: "-frames-%04d.png",
      frames: { firstNumber: 7, frameCount: 2 }
    });
  });

  it("keeps project-only compilation free of direct media switches", () => {
    expect(parseCliArguments([
      "compile", "motion.json", "--out", "motion.rma"
    ])).toMatchObject({
      command: "compile",
      input: "motion.json",
      output: "motion.rma"
    });
    expectUsage([
      "compile", "motion.json", "--out", "motion.rma", "--fps", "30/1"
    ]);
  });

  it.each([
    ["missing direct loop", ["compile", "clip.mp4", "--out", "x.rma"]],
    ["missing output", ["compile", "clip.mp4", "--loop", "0:2"]],
    ["duplicate", ["inspect", "a.rma", "--json", "--json"]],
    ["unknown", ["inspect", "a.rma", "--wat"]],
    ["inline value", ["unpack", "a.rma", "--out=dir"]],
    ["bad range", ["compile", "a.mp4", "--loop", "2:2", "--out", "x.rma"]],
    ["unreduced fps", ["compile", "a.mp4", "--loop", "0:2", "--fps", "60/2", "--out", "x.rma"]],
    ["bad canvas", ["compile", "a.mp4", "--loop", "0:2", "--canvas", "31x32", "--out", "x.rma"]],
    ["PNG missing frames", ["compile", "a-%04d.png", "--loop", "0:2", "--fps", "30/1", "--canvas", "32x32", "--out", "x.rma"]],
    ["PNG invalid token", ["compile", "a-%d.png", "--loop", "0:2", "--frames", "0:2", "--fps", "30/1", "--canvas", "32x32", "--out", "x.rma"]],
    ["video frames", ["compile", "a.mp4", "--loop", "0:2", "--frames", "0:2", "--out", "x.rma"]],
    ["normalize missing fps", ["compile", "a.mp4", "--loop", "0:2", "--normalize-vfr", "--out", "x.rma"]],
    ["relative tool", ["compile", "a.mp4", "--loop", "0:2", "--ffmpeg", "bin/ffmpeg", "--out", "x.rma"]],
    ["extra positional", ["validate", "a.rma", "b.rma"]]
  ])("rejects %s", (_label, argv) => {
    expectUsage(argv);
  });

  it("parses every read-only and workflow command", () => {
    expect(parseCliArguments(["inspect", "a.rma", "--json"])).toEqual({
      command: "inspect", input: "a.rma", json: true
    });
    expect(parseCliArguments(["validate", "a.rma"])).toEqual({
      command: "validate", input: "a.rma", json: false
    });
    expect(parseCliArguments(["unpack", "a.rma", "--out", "dir"])).toEqual({
      command: "unpack", input: "a.rma", output: "dir", json: false
    });
    expect(parseCliArguments(["init", "starter"])).toEqual({
      command: "init", directory: "starter", json: false
    });
    expect(parseCliArguments(["dev", "motion.json", "--out", "x.rma"])).toEqual({
      command: "dev",
      project: "motion.json",
      output: "x.rma",
      force: false,
      json: false
    });
  });
});

function expectUsage(argv: readonly string[]): void {
  try {
    parseCliArguments(argv);
    throw new Error("expected CLI usage rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(CompilerError);
    expect((error as CompilerError).code).toBe("CLI_USAGE");
  }
}
