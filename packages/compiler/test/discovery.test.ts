import { describe, expect, it } from "vitest";

import { createCalibrationInvocation } from "../src/ffmpeg/discovery.js";

describe("FFmpeg discovery calibration policy", () => {
  it("pins calibration to the canonical shared H.264 encoder vector", () => {
    const arguments_ = createCalibrationInvocation().arguments;

    expect(arguments_).toEqual(expect.arrayContaining([
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "23",
      "-profile:v", "baseline",
      "-level:v", "1.1",
      "-bf", "0",
      "-refs", "1"
    ]));
    expect(arguments_).not.toContain("zerolatency");
    expect(arguments_).toContain("-maxrate");
    expect(arguments_).toContain("-bufsize");
  });
});
