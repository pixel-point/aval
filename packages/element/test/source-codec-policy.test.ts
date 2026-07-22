import { describe, expect, it } from "vitest";

import {
  compareSourceCodec,
  sourceCodec,
  SOURCE_CODEC_PRIORITY
} from "../src/source-codec-policy.js";

describe("source codec policy", () => {
  it("publishes one frozen, fixed runtime priority", () => {
    expect(SOURCE_CODEC_PRIORITY).toEqual(["av1", "vp9", "h265", "h264"]);
    expect(Object.isFrozen(SOURCE_CODEC_PRIORITY)).toBe(true);
  });

  it("accepts only exact codec-family declarations", () => {
    for (const codec of SOURCE_CODEC_PRIORITY) expect(sourceCodec(codec)).toBe(codec);
    expect(sourceCodec("AV1")).toBeUndefined();
    expect(sourceCodec("hevc")).toBeUndefined();
    expect(sourceCodec("av01.0.08M.08")).toBeUndefined();
    expect(sourceCodec(null)).toBeUndefined();
  });

  it("orders every family through the exhaustive rank table", () => {
    expect([...SOURCE_CODEC_PRIORITY].sort(compareSourceCodec))
      .toEqual(SOURCE_CODEC_PRIORITY);
    expect(compareSourceCodec("av1", "h264")).toBeLessThan(0);
    expect(compareSourceCodec("h265", "vp9")).toBeGreaterThan(0);
  });
});
