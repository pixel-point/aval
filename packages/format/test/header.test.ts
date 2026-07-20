import { describe, expect, it } from "vitest";

import {
  CHUNK_INDEX_HEADER_LENGTH,
  CHUNK_INDEX_RECORD_LENGTH,
  FORMAT_HEADER_LENGTH,
  FORMAT_MAGIC
} from "../src/constants.js";
import { writeUint32LE, writeUint64LE } from "../src/checked-integer.js";
import { FormatError } from "../src/errors.js";
import {
  encodeHeader,
  parseHeader,
  type FormatHeader
} from "../src/header.js";

const HEADER: FormatHeader = {
  major: 1,
  minor: 0,
  headerLength: FORMAT_HEADER_LENGTH,
  requiredFeatureFlags: 0,
  declaredFileLength: 136,
  manifestOffset: 64,
  manifestLength: 8,
  indexOffset: 72,
  indexLength: 64
};

const GOLDEN_HEX =
  "41564c460d0a1a0a" +
  "01000000" +
  "40000000" +
  "00000000" +
  "00000000" +
  "8800000000000000" +
  "4000000000000000" +
  "0800000000000000" +
  "4800000000000000" +
  "4000000000000000";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function expectFormatError(
  operation: () => unknown,
  code: FormatError["code"]
): FormatError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(FormatError);
    expect((error as FormatError).code).toBe(code);
    return error as FormatError;
  }
  throw new Error("expected operation to throw");
}

describe("version-1.0 header codec", () => {
  it("emits the exact canonical 64-byte little-endian header", () => {
    const bytes = encodeHeader(HEADER);
    expect(bytes).toHaveLength(64);
    expect(hex(bytes)).toBe(GOLDEN_HEX);
    expect([...bytes.subarray(0, 8)]).toEqual([...FORMAT_MAGIC]);
  });

  it("parses and freezes the exact fields", () => {
    const parsed = parseHeader(encodeHeader(HEADER));
    expect(parsed).toEqual(HEADER);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("round-trips the qualified 1.1 header without rewriting its version", () => {
    const qualified: FormatHeader = { ...HEADER, major: 1, minor: 1 };
    expect(parseHeader(encodeHeader(qualified))).toEqual(qualified);
  });

  it("supports an unaligned Uint8Array view without reading adjacent bytes", () => {
    const storage = new Uint8Array(70).fill(0xa5);
    const view = storage.subarray(3, 67);
    view.set(encodeHeader(HEADER));

    expect(parseHeader(view)).toEqual(HEADER);
    expect(storage.subarray(0, 3)).toEqual(new Uint8Array([0xa5, 0xa5, 0xa5]));
    expect(storage.subarray(67)).toEqual(new Uint8Array([0xa5, 0xa5, 0xa5]));
  });

  it("rejects truncation at every byte boundary with one stable error", () => {
    const bytes = encodeHeader(HEADER);
    for (let length = 0; length < FORMAT_HEADER_LENGTH; length += 1) {
      const error = expectFormatError(
        () => parseHeader(bytes.subarray(0, length)),
        "HEADER_INVALID"
      );
      expect(error).toBeInstanceOf(FormatError);
    }
  });

  it("rejects every noncanonical fixed header field", () => {
    const mutations: readonly [number, number, FormatError["code"]][] = [
      [0, 0, "HEADER_INVALID"],
      [8, 2, "VERSION_UNSUPPORTED"],
      [10, 2, "VERSION_UNSUPPORTED"],
      [12, 63, "HEADER_INVALID"],
      [16, 1, "FEATURE_UNSUPPORTED"],
      [20, 1, "HEADER_INVALID"]
    ];
    for (const [offset, value, code] of mutations) {
      const bytes = encodeHeader(HEADER);
      bytes[offset] = value;
      expectFormatError(() => parseHeader(bytes), code);
    }
  });

  it("rejects unsafe uint64 fields but accepts files above the former ceiling", () => {
    const unsafe = encodeHeader(HEADER);
    writeUint64LE(unsafe, 24, BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    expectFormatError(() => parseHeader(unsafe), "INTEGER_UNSAFE");

    const large = { ...HEADER, declaredFileLength: 40 * 1024 * 1024 };
    expect(parseHeader(encodeHeader(large))).toEqual(large);
    expectFormatError(
      () => parseHeader(encodeHeader(large), {
        budgets: { maxFileBytes: 32 * 1024 * 1024 }
      }),
      "BUDGET_EXCEEDED"
    );
  });

  it("enforces canonical offsets, index shape, count, and containment", () => {
    const wrongManifestOffset = encodeHeader(HEADER);
    writeUint64LE(wrongManifestOffset, 32, 65);
    expectFormatError(() => parseHeader(wrongManifestOffset), "HEADER_INVALID");

    const wrongIndexOffset = encodeHeader(HEADER);
    writeUint64LE(wrongIndexOffset, 48, 80);
    expectFormatError(() => parseHeader(wrongIndexOffset), "HEADER_INVALID");

    const partialRecord = encodeHeader(HEADER);
    writeUint64LE(partialRecord, 56, 17);
    expectFormatError(() => parseHeader(partialRecord), "HEADER_INVALID");

    const outsideFile = encodeHeader(HEADER);
    writeUint64LE(outsideFile, 24, 135);
    expectFormatError(() => parseHeader(outsideFile), "HEADER_INVALID");

    const formerRecordLimit = {
      ...HEADER,
      indexLength: CHUNK_INDEX_HEADER_LENGTH + CHUNK_INDEX_RECORD_LENGTH * 3_601,
      declaredFileLength: 200_000
    };
    expect(parseHeader(encodeHeader(formerRecordLimit))).toEqual(formerRecordLimit);

    const outsideUint32 = {
      ...HEADER,
      indexLength: CHUNK_INDEX_HEADER_LENGTH + CHUNK_INDEX_RECORD_LENGTH * 0x1_0000_0000,
      declaredFileLength: 72 + CHUNK_INDEX_HEADER_LENGTH + CHUNK_INDEX_RECORD_LENGTH * 0x1_0000_0000
    };
    expectFormatError(() => encodeHeader(outsideUint32), "BUDGET_EXCEEDED");
  });

  it("honors lower-only active budgets", () => {
    expectFormatError(
      () => parseHeader(encodeHeader(HEADER), { budgets: { maxFileBytes: 135 } }),
      "BUDGET_EXCEEDED"
    );
    expectFormatError(
      () =>
        parseHeader(encodeHeader(HEADER), {
          budgets: { maxManifestBytes: 7 }
        }),
      "BUDGET_EXCEEDED"
    );
  });

  it("never leaks built-in errors for hostile runtime inputs", () => {
    expectFormatError(
      () => parseHeader(null as unknown as Uint8Array),
      "HEADER_INVALID"
    );
    expectFormatError(
      () => encodeHeader(null as unknown as FormatHeader),
      "HEADER_INVALID"
    );

    const badShape = { ...HEADER, declaredFileLength: Number.NaN };
    expectFormatError(() => encodeHeader(badShape), "HEADER_INVALID");
  });

  it("does not mistake reserved bytes for part of a numeric field", () => {
    const bytes = encodeHeader(HEADER);
    writeUint32LE(bytes, 20, 0x0102_0304);
    expectFormatError(() => parseHeader(bytes), "HEADER_INVALID");
  });
});
