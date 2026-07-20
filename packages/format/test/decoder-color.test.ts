import { describe, expect, it } from "vitest";

import {
  classifyDecoderColor,
  type DecoderColorTuple
} from "../src/video/decoder-color.js";

const BT709_LIMITED: Readonly<DecoderColorTuple> = Object.freeze([
  "bt709",
  "bt709",
  "bt709",
  false
]);

describe("decoder color classification", () => {
  it("accepts exact limited BT.709 metadata", () => {
    expect(classifyDecoderColor(BT709_LIMITED, BT709_LIMITED)).toEqual({
      kind: "exact"
    });
  });

  it("accepts the captured BT.709 transfer normalization", () => {
    expect(classifyDecoderColor(
      BT709_LIMITED,
      ["bt709", "smpte170m", "bt709", false]
    )).toEqual({
      kind: "known-normalization",
      normalization: "bt709-transfer-as-smpte170m"
    });
  });

  it("retains the narrow limited-BT.709 sRGB normalization", () => {
    expect(classifyDecoderColor(
      BT709_LIMITED,
      ["bt709", "iec61966-2-1", "bt709", false]
    )).toEqual({
      kind: "known-normalization",
      normalization: "limited-bt709-srgb-transfer"
    });
  });

  it("rejects full-range sRGB as a range mismatch", () => {
    expect(classifyDecoderColor(
      BT709_LIMITED,
      ["bt709", "iec61966-2-1", "bt709", true]
    )).toEqual({ kind: "incompatible", field: "range" });
  });

  it.each([
    ["primaries", BT709_LIMITED, ["smpte170m", "bt709", "bt709", false]],
    ["transfer", ["bt709", "smpte170m", "bt709", false], BT709_LIMITED],
    ["matrix", BT709_LIMITED, ["bt709", "bt709", "smpte170m", false]],
    ["range", BT709_LIMITED, ["bt709", "bt709", "bt709", true]]
  ] as const)("rejects a conflicting %s", (field, expected, actual) => {
    expect(classifyDecoderColor(expected, actual)).toEqual({
      kind: "incompatible",
      field
    });
  });

  it.each([
    ["primaries", [null, "bt709", "bt709", false]],
    ["transfer", ["bt709", null, "bt709", false]],
    ["matrix", ["bt709", "bt709", null, false]],
    ["range", ["bt709", "bt709", "bt709", null]]
  ] as const)(
    "does not treat a null %s as satisfying a concrete expectation",
    (field, actual) => {
      expect(classifyDecoderColor(BT709_LIMITED, actual)).toEqual({
        kind: "incompatible",
        field
      });
    }
  );

  it("reports mismatches in stable semantic order", () => {
    expect(classifyDecoderColor(
      BT709_LIMITED,
      ["smpte170m", "iec61966-2-1", "smpte170m", true]
    )).toEqual({ kind: "incompatible", field: "range" });
  });

  it.each([
    ["primaries", ["smpte170m", "smpte170m", "bt709", false]],
    ["matrix", ["bt709", "smpte170m", "smpte170m", false]]
  ] as const)("does not normalize smpte170m %s metadata", (field, actual) => {
    expect(classifyDecoderColor(BT709_LIMITED, actual)).toEqual({
      kind: "incompatible",
      field
    });
  });
});
