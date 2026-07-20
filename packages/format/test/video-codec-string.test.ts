import { describe, expect, it } from "vitest";

import {
  isVideoCodecString,
  parseVideoCodecString,
  VIDEO_BITSTREAM_BY_CODEC,
  VIDEO_CODECS
} from "../src/video/codec-string.js";

describe("canonical WebCodecs codec strings", () => {
  it("owns the immutable codec order and bitstream mapping", () => {
    expect(VIDEO_CODECS).toEqual(["h264", "h265", "vp9", "av1"]);
    expect(VIDEO_BITSTREAM_BY_CODEC).toEqual({
      h264: "annex-b",
      h265: "annex-b",
      vp9: "frame",
      av1: "low-overhead"
    });
    expect(Object.isFrozen(VIDEO_CODECS)).toBe(true);
    expect(Object.isFrozen(VIDEO_BITSTREAM_BY_CODEC)).toBe(true);
  });

  it("recognizes every production codec family", () => {
    expect(parseVideoCodecString("avc1.42E01E"))
      .toEqual({ family: "h264", bitDepth: 8 });
    expect(parseVideoCodecString("avc1.640020"))
      .toEqual({ family: "h264", bitDepth: 8 });
    expect(parseVideoCodecString("hvc1.1.6.L93.B0"))
      .toEqual({ family: "h265", bitDepth: 8 });
    expect(parseVideoCodecString("vp09.00.10.08.01.01.01.01.00"))
      .toEqual({ family: "vp9", bitDepth: 8 });
    expect(parseVideoCodecString("av01.0.08M.10.0.110.01.01.01.0"))
      .toEqual({ family: "av1", bitDepth: 10 });
  });

  it("requires family and declared bit depth to agree", () => {
    expect(isVideoCodecString("av01.0.08M.10.0.110.01.01.01.0", "av1", 10))
      .toBe(true);
    expect(isVideoCodecString("av01.0.08M.10.0.110.01.01.01.0", "av1", 8))
      .toBe(false);
    expect(isVideoCodecString("vp09.00.10.08", "av1", 8)).toBe(false);
  });

  it("rejects aliases, truncated forms, lowercase hex, and junk", () => {
    for (const value of [
      "avc1.42e020",
      "hev1.1.6.L93.B0",
      "vp9",
      "av01.0.08M",
      "av01.0.08M.10.0.110.01.01.01.0.extra",
      ""
    ]) {
      expect(parseVideoCodecString(value)).toBeUndefined();
    }
  });

  it.each([
    "avc1.000000",
    "vp09.99.99.08",
    "av01.2.00M.08.0.110.01.01.01.0",
    "vp09.00.10.12",
    "hvc1.1.6.L0",
    "hvc1.0.0.L93",
    "hvc1.A1.6.L93.B0",
    "hvc1.1.0.L93.B0",
    "hvc1.2.4.L93.B0",
    "hvc1.31.1.H255.FF"
  ])("rejects a syntactically-shaped but unsupported codec string %s", (value) => {
    expect(parseVideoCodecString(value)).toBeUndefined();
  });
});
