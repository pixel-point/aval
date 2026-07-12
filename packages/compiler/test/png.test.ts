import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { encodeCanonicalRgbaPng } from "../src/compile/png.js";
import { CompilerError } from "../src/diagnostics.js";

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! * 0x100_0000) +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  ) >>> 0;
}

describe("canonical RGBA PNG", () => {
  it("emits deterministic IHDR, sRGB, one IDAT, and IEND chunks", () => {
    const rgba = Uint8Array.of(
      255, 0, 0, 255,
      0, 255, 0, 128,
      0, 0, 255, 64,
      255, 255, 255, 0
    );
    const first = encodeCanonicalRgbaPng({ width: 2, height: 2, rgba });
    const second = encodeCanonicalRgbaPng({ width: 2, height: 2, rgba });
    expect(first).toEqual(second);
    expect(Array.from(first.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
    ]);

    const types: string[] = [];
    let offset = 8;
    let inflated: Uint8Array | undefined;
    while (offset < first.byteLength) {
      const length = readUint32BE(first, offset);
      const type = new TextDecoder().decode(first.subarray(offset + 4, offset + 8));
      types.push(type);
      if (type === "IDAT") {
        inflated = new Uint8Array(
          inflateSync(first.subarray(offset + 8, offset + 8 + length))
        );
      }
      offset += 12 + length;
    }
    expect(types).toEqual(["IHDR", "sRGB", "IDAT", "IEND"]);
    expect(inflated).toEqual(Uint8Array.of(
      0, 255, 0, 0, 255, 0, 255, 0, 128,
      0, 0, 0, 255, 64, 255, 255, 255, 0
    ));
  });

  it("rejects dimensions and RGBA length before allocation", () => {
    expect(() => encodeCanonicalRgbaPng({
      width: 513,
      height: 1,
      rgba: new Uint8Array()
    })).toThrow(CompilerError);
    expect(() => encodeCanonicalRgbaPng({
      width: 2,
      height: 2,
      rgba: new Uint8Array(15)
    })).toThrow(CompilerError);
  });

  it("uses stable stored DEFLATE blocks across the 65,535-byte boundary", () => {
    const rgba = new Uint8Array(128 * 128 * 4);
    rgba.fill(0xa5);
    const before = rgba.slice();
    const png = encodeCanonicalRgbaPng({ width: 128, height: 128, rgba });
    expect(rgba).toEqual(before);

    let offset = 8;
    while (offset < png.byteLength) {
      const length = readUint32BE(png, offset);
      const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
      if (type === "IDAT") {
        const zlib = png.subarray(offset + 8, offset + 8 + length);
        expect(Array.from(zlib.subarray(0, 2))).toEqual([0x78, 0x01]);
        expect(zlib[2]).toBe(0x00);
        expect(zlib[2 + 5 + 65_535]).toBe(0x01);
        expect(new Uint8Array(inflateSync(zlib))).toHaveLength(128 * (128 * 4 + 1));
        return;
      }
      offset += 12 + length;
    }
    throw new Error("IDAT not found");
  });
});
