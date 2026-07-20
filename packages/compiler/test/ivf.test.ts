import { describe, expect, it } from "vitest";

import { CompilerError } from "../src/diagnostics.js";
import { parseIvf, serializeIvf } from "../src/ffmpeg/ivf.js";

function ivf(
  fourcc: "VP90" | "AV01",
  frames: readonly { readonly timestamp: bigint; readonly bytes: Uint8Array }[]
): Uint8Array {
  return serializeIvf({
    codec: fourcc === "VP90" ? "vp9" : "av1",
    width: 320,
    height: 180,
    timeBase: { numerator: 1_001, denominator: 30_000 },
    frames: frames.map(({ timestamp, bytes }) => ({
      timestamp: Number(timestamp),
      bytes
    }))
  });
}

describe("bounded IVF transport parsing", () => {
  it("serializes deterministic transport without mutating payloads", () => {
    const payload = Uint8Array.of(1, 2, 3);
    const first = ivf("AV01", [{ timestamp: 4n, bytes: payload }]);
    const second = ivf("AV01", [{ timestamp: 4n, bytes: payload }]);

    expect(first).toEqual(second);
    expect(parseIvf(first, { expectedCodec: "av1" }).frames)
      .toEqual([{ timestamp: 4, bytes: payload }]);
    expect(payload).toEqual(Uint8Array.of(1, 2, 3));
  });

  it("detaches VP9 records in decoder submission order", () => {
    const input = ivf("VP90", [
      { timestamp: 2n, bytes: Uint8Array.of(0x82, 0x49) },
      { timestamp: 0n, bytes: Uint8Array.of(0x86) }
    ]);
    const parsed = parseIvf(input, {
      expectedCodec: "vp9",
      expectedWidth: 320,
      expectedHeight: 180,
      expectedFrameCount: 2
    });

    expect(parsed).toEqual({
      codec: "vp9",
      width: 320,
      height: 180,
      timeBase: { numerator: 1_001, denominator: 30_000 },
      frames: [
        { timestamp: 2, bytes: Uint8Array.of(0x82, 0x49) },
        { timestamp: 0, bytes: Uint8Array.of(0x86) }
      ]
    });
    input.fill(0);
    expect(parsed.frames[0]?.bytes).toEqual(Uint8Array.of(0x82, 0x49));
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.frames)).toBe(true);
  });

  it("accepts AV1 transport without retaining IVF headers", () => {
    expect(parseIvf(
      ivf("AV01", [{ timestamp: 0n, bytes: Uint8Array.of(0x12, 0x00) }]),
      { expectedCodec: "av1" }
    )).toMatchObject({
      codec: "av1",
      frames: [{ timestamp: 0, bytes: Uint8Array.of(0x12, 0x00) }]
    });
  });

  it("counts non-seekable FFmpeg stdout records under an explicit budget", () => {
    const input = ivf("VP90", [
      { timestamp: 0n, bytes: Uint8Array.of(1) },
      { timestamp: 1n, bytes: Uint8Array.of(2) }
    ]);
    new DataView(input.buffer).setUint32(24, 0xffff_ffff, true);

    expect(parseIvf(input, {
      expectedCodec: "vp9",
      expectedFrameCount: 2,
      maximumFrames: 2
    }).frames).toHaveLength(2);
    expect(() => parseIvf(input, { expectedCodec: "vp9" }))
      .toThrow(/explicit frame budget/u);
    expect(() => parseIvf(input, {
      expectedCodec: "vp9",
      maximumFrames: 1
    })).toThrow(/frame count exceeds/u);
  });

  it("rejects malformed headers, codec mismatch, truncation, budgets, and tails", () => {
    const valid = ivf("VP90", [
      { timestamp: 0n, bytes: Uint8Array.of(1, 2, 3) }
    ]);
    const cases: Uint8Array[] = [];
    const signature = valid.slice();
    signature[0] = 0;
    cases.push(signature);
    const version = valid.slice();
    new DataView(version.buffer).setUint16(4, 1, true);
    cases.push(version);
    cases.push(valid.slice(0, valid.length - 1));
    const tail = new Uint8Array(valid.length + 1);
    tail.set(valid);
    cases.push(tail);

    for (const value of cases) {
      expect(() => parseIvf(value, { expectedCodec: "vp9" }))
        .toThrow(CompilerError);
    }
    expect(() => parseIvf(valid, { expectedCodec: "av1" }))
      .toThrow(/does not match/u);
    expect(() => parseIvf(valid, {
      expectedCodec: "vp9",
      maximumFrameBytes: 2
    })).toThrow(/byte budget/u);
    expect(() => parseIvf(valid, {
      expectedCodec: "vp9",
      maximumFrames: 0
    })).toThrow(/positive safe integer/u);
  });
});
