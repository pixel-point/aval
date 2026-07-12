import { describe, expect, it } from "vitest";

import {
  createProbeMediaInvocation,
  createProbePngSequenceInvocation,
  probeMedia,
  probePngSequence
} from "../src/ffmpeg/probe.js";

const SHOW_ENTRIES =
  "stream=index,width,height,pix_fmt,avg_frame_rate,r_frame_rate,time_base,nb_frames,duration,field_order,sample_aspect_ratio:stream_side_data=rotation:format=format_name,duration:frame=stream_index,best_effort_timestamp,duration";

describe("frozen FFprobe invocations", () => {
  it("owns the complete reviewed MOV probe vector", () => {
    expect(createProbeMediaInvocation(
      "/input/-show_entries;touch-pwn.mov"
    )).toEqual({
      cwd: "/input",
      arguments: [
        "-v", "error", "-max_alloc", "67108864",
        "-protocol_whitelist", "file,pipe",
        "-analyzeduration", "10000000", "-probesize", "33554432",
        "-threads", "1", "-f", "mov", "-select_streams", "v",
        "-read_intervals", "%+31", "-show_entries", SHOW_ENTRIES,
        "-of", "json", "/input/-show_entries;touch-pwn.mov"
      ]
    });
  });

  it("owns the bounded PNG-sequence probe vector", () => {
    expect(createProbePngSequenceInvocation(
      "/input/frames/frame-%08d.png",
      42,
      { numerator: 30_000, denominator: 1_001 },
      90
    )).toEqual({
      cwd: "/input/frames",
      arguments: [
        "-v", "error", "-max_alloc", "67108864",
        "-protocol_whitelist", "file,pipe",
        "-analyzeduration", "10000000", "-probesize", "33554432",
        "-threads", "1", "-f", "image2", "-framerate", "30000/1001",
        "-start_number", "42", "-select_streams", "v",
        "-read_intervals", "%+#90", "-show_entries", SHOW_ENTRIES,
        "-of", "json", "/input/frames/frame-%08d.png"
      ]
    });
  });

  it("only permits callers to lower operation-specific timeout ceilings", async () => {
    await expect(probeMedia(
      "/input/clip.mov",
      "not-used",
      undefined,
      15_001
    )).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(probePngSequence(
      "/input/frame-%04d.png",
      0,
      { numerator: 30, denominator: 1 },
      "not-used",
      undefined,
      1,
      0
    )).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });
});
