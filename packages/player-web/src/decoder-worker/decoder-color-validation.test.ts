import { describe, expect, it } from "vitest";

import { validateDecodedFrame } from "./core-validation.js";

const BT709_LIMITED = Object.freeze({
  fullRange: false,
  matrix: "bt709",
  primaries: "bt709",
  transfer: "bt709"
} as const);
const WEBKIT_BT709 = Object.freeze({
  fullRange: true,
  matrix: "bt709",
  primaries: "bt709",
  transfer: "iec61966-2-1"
} as const);
const DEFAULT_EXPECTATION = Object.freeze({
  codedWidth: 2,
  codedHeight: 2,
  displayWidth: 2,
  displayHeight: 2,
  visibleRect: Object.freeze({ x: 0, y: 0, width: 2, height: 2 }),
  colorSpace: BT709_LIMITED
});

describe("decoded color validation", () => {
  it.each([
    ["limited-range sRGB", {
      ...BT709_LIMITED,
      transfer: "iec61966-2-1" as const
    }],
    ["Android SMPTE-170M", {
      ...BT709_LIMITED,
      transfer: "smpte170m" as const
    }]
  ] as const)("accepts the known %s normalization", (_name, colorSpace) => {
    expect(validateDecodedFrame(
      decodedFrame(colorSpace),
      DEFAULT_EXPECTATION,
      0,
      1_000
    )).toBe(16);
  });

  it("accepts captured WebKit metadata", () => {
    expect(validateDecodedFrame(
      decodedFrame(WEBKIT_BT709),
      DEFAULT_EXPECTATION,
      0,
      1_000
    )).toBe(16);
  });

  it.each([
    ["primaries", { primaries: "smpte170m" }],
    ["transfer", { transfer: "bt709" }],
    ["matrix", { matrix: "smpte170m" }],
    ["range", { fullRange: null }]
  ] as const)("rejects a WebKit near miss in %s", (_field, patch) => {
    const frame = decodedFrame({ ...WEBKIT_BT709, ...patch });

    expect(() => validateDecodedFrame(frame, DEFAULT_EXPECTATION, 0, 1_000))
      .toThrow(/color space/iu);
  });

  it("does not broaden the limited-range sRGB normalization", () => {
    const frame = decodedFrame({
      ...BT709_LIMITED,
      primaries: "smpte170m",
      transfer: "iec61966-2-1"
    });

    expect(() => validateDecodedFrame(frame, DEFAULT_EXPECTATION, 0, 1_000))
      .toThrow(/color space/iu);
  });
});

function decodedFrame(colorSpace: VideoColorSpaceInit): VideoFrame {
  return {
    timestamp: 0,
    duration: 1_000,
    codedWidth: 2,
    codedHeight: 2,
    displayWidth: 2,
    displayHeight: 2,
    visibleRect: { x: 0, y: 0, width: 2, height: 2 },
    colorSpace
  } as unknown as VideoFrame;
}
