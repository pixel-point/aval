import { describe, expect, it } from "vitest";

import {
  formatInclusiveByteRange,
  parseCanonicalContentRange,
  validateExactContentRange
} from "./http-content-range.js";

describe("canonical Content-Range grammar", () => {
  it("parses one exact concrete canonical range", () => {
    const parsed = parseCanonicalContentRange("\t BYTES 0-63/4096 \t");

    expect(parsed).toEqual({ start: 0, end: 63, total: 4_096, length: 64 });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(formatInclusiveByteRange({ start: 0, end: 63 })).toBe(
      "bytes=0-63"
    );
  });

  it("accepts safe-integer boundaries without losing decimal precision", () => {
    expect(
      parseCanonicalContentRange(
        "bytes 9007199254740990-9007199254740990/9007199254740991"
      )
    ).toEqual({
      start: Number.MAX_SAFE_INTEGER - 1,
      end: Number.MAX_SAFE_INTEGER - 1,
      total: Number.MAX_SAFE_INTEGER,
      length: 1
    });
    expect(
      parseCanonicalContentRange(
        "bytes 0-9007199254740990/9007199254740991"
      ).length
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    "",
    "bytes",
    "bytes=0-1/2",
    "bytes 0-1",
    "bytes 0-1/*",
    "bytes */2",
    "bytes -1/2",
    "bytes 0-/2",
    "bytes 1-0/2",
    "bytes 0-2/2",
    "bytes 00-1/2",
    "bytes 0-01/2",
    "bytes 0-1/02",
    "bytes +0-1/2",
    "bytes 0 -1/2",
    "bytes 0-1 /2",
    "bytes  0-1/2",
    "bytes\t0-1/2",
    "bytes 0-1/2, bytes 2-3/4",
    "bytes 0-1/2\n",
    "bytes 0-9007199254740991/9007199254740991",
    "bytes 0-1/9007199254740992",
    "items 0-1/2"
  ])("rejects malformed, wildcard, list, whitespace, and overflow form %j", (value) => {
    expect(() => parseCanonicalContentRange(value)).toThrow(RangeError);
  });

  it("validates the exact requested range and optional pinned total", () => {
    expect(
      validateExactContentRange(
        "bytes 64-127/4096",
        { start: 64, end: 127 },
        4_096
      )
    ).toEqual({ start: 64, end: 127, total: 4_096, length: 64 });

    for (const [value, requested, total] of [
      ["bytes 63-127/4096", { start: 64, end: 127 }, 4_096],
      ["bytes 64-126/4096", { start: 64, end: 127 }, 4_096],
      ["bytes 64-128/4096", { start: 64, end: 127 }, 4_096],
      ["bytes 64-127/4097", { start: 64, end: 127 }, 4_096]
    ] as const) {
      expect(() => validateExactContentRange(value, requested, total)).toThrow(
        RangeError
      );
    }
  });

  it("rejects invalid requested numeric boundaries before formatting or matching", () => {
    for (const range of [
      { start: -1, end: 1 },
      { start: 2, end: 1 },
      { start: 0.5, end: 1 },
      { start: 0, end: Number.MAX_SAFE_INTEGER },
      { start: Number.NaN, end: 1 }
    ]) {
      expect(() => formatInclusiveByteRange(range)).toThrow(RangeError);
      expect(() =>
        validateExactContentRange("bytes 0-1/2", range)
      ).toThrow(RangeError);
    }
  });

  it("round-trips generated canonical decimals around zero and the safe limit", () => {
    const starts = [0, 1, 9, 10, 999, Number.MAX_SAFE_INTEGER - 2];
    for (const start of starts) {
      const end = Math.min(start + 1, Number.MAX_SAFE_INTEGER - 1);
      const total = end + 1;
      const value = `bytes ${String(start)}-${String(end)}/${String(total)}`;
      expect(validateExactContentRange(value, { start, end }, total)).toEqual({
        start,
        end,
        total,
        length: end - start + 1
      });

      const mutations = [
        value.replace("bytes ", "bytes  "),
        value.replace("-", " -"),
        value.replace("/", " /"),
        `${value},${value}`
      ];
      for (const mutation of mutations) {
        expect(() => parseCanonicalContentRange(mutation)).toThrow(RangeError);
      }
    }
  });
});
