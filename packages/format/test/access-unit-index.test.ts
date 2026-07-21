import { describe, expect, it } from "vitest";

import {
  encodeEncodedChunkIndex,
  parseEncodedChunkIndex
} from "../src/access-unit-index.js";
import { writeUint32LE, writeUint64LE } from "../src/checked-integer.js";
import { FormatError } from "../src/errors.js";
import type { CompiledManifest, EncodedChunkRecord } from "../src/model.js";

const MANIFEST = {
  renditions: [{ id: "video" }],
  units: [{
    id: "body",
    frameCount: 2,
    chunks: [{
      rendition: "video",
      chunkStart: 0,
      chunkCount: 2,
      frameCount: 2,
      sha256: "0".repeat(64)
    }]
  }]
} as unknown as CompiledManifest;

const RECORDS: readonly EncodedChunkRecord[] = Object.freeze([
  Object.freeze({
    byteOffset: 128,
    byteLength: 4,
    presentationTimestamp: 1,
    duration: 1,
    randomAccess: true,
    displayedFrameCount: 1
  }),
  Object.freeze({
    byteOffset: 132,
    byteLength: 5,
    presentationTimestamp: 0,
    duration: 1,
    randomAccess: false,
    displayedFrameCount: 1
  })
]);

const GOLDEN_HEX =
  "41564c49300000000200000000000000" +
  "800000000000000004000000010000000100000000000000010000000000000001000000000000000000000000000000" +
  "840000000000000005000000010000000000000000000000010000000000000000000000000000000000000000000000";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function expectFormatError(operation: () => unknown, code: FormatError["code"]): FormatError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(FormatError);
    expect((error as FormatError).code).toBe(code);
    return error as FormatError;
  }
  throw new Error("expected operation to throw");
}

describe("version-1.1 encoded-chunk index", () => {
  it("encodes the exact 16 + 48N canonical bytes", () => {
    const bytes = encodeEncodedChunkIndex(RECORDS, MANIFEST);
    expect(bytes).toHaveLength(112);
    expect(hex(bytes)).toBe(GOLDEN_HEX);
  });

  it("preserves decode order independently from presentation timestamps", () => {
    const bytes = encodeEncodedChunkIndex(RECORDS, MANIFEST);
    const parsed = parseEncodedChunkIndex(bytes, MANIFEST);
    expect(parsed).toEqual(RECORDS);
    expect(parsed.map(({ presentationTimestamp }) => presentationTimestamp)).toEqual([1, 0]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed.every(Object.isFrozen)).toBe(true);
    bytes.fill(0);
    expect(parsed).toEqual(RECORDS);
  });

  it("supports hidden chunks and multiple chunks per displayed frame timeline", () => {
    const manifest = {
      ...MANIFEST,
      units: [{
        ...MANIFEST.units[0]!,
        frameCount: 1,
        chunks: [{
          ...MANIFEST.units[0]!.chunks[0]!,
          chunkCount: 2,
          frameCount: 1
        }]
      }]
    } as CompiledManifest;
    const records = [
      { ...RECORDS[0]!, duration: 0, displayedFrameCount: 0 },
      { ...RECORDS[1]!, presentationTimestamp: 0 }
    ];
    expect(parseEncodedChunkIndex(
      encodeEncodedChunkIndex(records, manifest),
      manifest
    )).toEqual(records);
  });

  it("rejects every truncation and any trailing byte", () => {
    const bytes = encodeEncodedChunkIndex(RECORDS, MANIFEST);
    for (let length = 0; length < bytes.length; length += 1) {
      expectFormatError(
        () => parseEncodedChunkIndex(bytes.subarray(0, length), MANIFEST),
        "INDEX_INVALID"
      );
    }
    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes);
    expectFormatError(() => parseEncodedChunkIndex(trailing, MANIFEST), "INDEX_INVALID");
  });

  it("rejects magic, size, reserved bytes, and unknown flag bits", () => {
    for (const offset of [0, 4, 6, 12, 16 + 36, 16 + 40]) {
      const bytes = encodeEncodedChunkIndex(RECORDS, MANIFEST);
      bytes[offset] = (bytes[offset] ?? 0) ^ 1;
      expectFormatError(() => parseEncodedChunkIndex(bytes, MANIFEST), "INDEX_INVALID");
    }
    const flag = encodeEncodedChunkIndex(RECORDS, MANIFEST);
    flag[16 + 32] = 2;
    expectFormatError(() => parseEncodedChunkIndex(flag, MANIFEST), "INDEX_INVALID");
  });

  it("requires independent random-access unit entry and exact displayed coverage", () => {
    const entry = encodeEncodedChunkIndex(RECORDS, MANIFEST);
    writeUint32LE(entry, 16 + 32, 0);
    expectFormatError(() => parseEncodedChunkIndex(entry, MANIFEST), "INDEX_INVALID");

    const coverage = encodeEncodedChunkIndex(RECORDS, MANIFEST);
    writeUint32LE(coverage, 16 + 12, 0);
    expectFormatError(() => parseEncodedChunkIndex(coverage, MANIFEST), "INDEX_INVALID");

    const duration = encodeEncodedChunkIndex(RECORDS, MANIFEST);
    writeUint64LE(duration, 16 + 24, 0);
    expectFormatError(() => parseEncodedChunkIndex(duration, MANIFEST), "INDEX_INVALID");
  });

  it("rejects zero/over-budget byte lengths and unsafe timestamps", () => {
    const zero = encodeEncodedChunkIndex(RECORDS, MANIFEST);
    writeUint32LE(zero, 16 + 8, 0);
    expectFormatError(() => parseEncodedChunkIndex(zero, MANIFEST), "INDEX_INVALID");

    expectFormatError(
      () => parseEncodedChunkIndex(encodeEncodedChunkIndex(RECORDS, MANIFEST), MANIFEST, {
        budgets: { maxChunkBytes: 4 }
      }),
      "BUDGET_EXCEEDED"
    );

    const unsafe = encodeEncodedChunkIndex(RECORDS, MANIFEST);
    writeUint64LE(unsafe, 16 + 16, BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    expectFormatError(() => parseEncodedChunkIndex(unsafe, MANIFEST), "INTEGER_UNSAFE");
  });

  it("cross-checks the canonical manifest chunk spans", () => {
    const wrongSpan = {
      ...MANIFEST,
      units: [{
        ...MANIFEST.units[0]!,
        chunks: [{ ...MANIFEST.units[0]!.chunks[0]!, chunkStart: 1 }]
      }]
    } as CompiledManifest;
    expectFormatError(
      () => parseEncodedChunkIndex(encodeEncodedChunkIndex(RECORDS, MANIFEST), wrongSpan),
      "INDEX_INVALID"
    );
  });

  it("round-trips an index above the former scale", () => {
    const recordCount = 100_000;
    const manifest = {
      renditions: [{ id: "video" }],
      units: [{
        id: "body",
        frameCount: recordCount,
        chunks: [{
          rendition: "video",
          chunkStart: 0,
          chunkCount: recordCount,
          frameCount: recordCount,
          sha256: "0".repeat(64)
        }]
      }]
    } as unknown as CompiledManifest;
    const records = Array.from({ length: recordCount }, (_, index) => ({
      byteOffset: 8_000_000 + index,
      byteLength: 1,
      presentationTimestamp: index,
      duration: 1,
      randomAccess: index === 0,
      displayedFrameCount: 1
    }));
    const bytes = encodeEncodedChunkIndex(records, manifest);
    const parsed = parseEncodedChunkIndex(bytes, manifest);
    expect(bytes.byteLength).toBeGreaterThan(4 * 1024 * 1024);
    expect(parsed).toHaveLength(recordCount);
    expect(parsed.at(-1)?.presentationTimestamp).toBe(recordCount - 1);
  }, 20_000);

  it("honors record/index budgets and wraps hostile inputs", () => {
    const bytes = encodeEncodedChunkIndex(RECORDS, MANIFEST);
    expectFormatError(
      () => parseEncodedChunkIndex(bytes, MANIFEST, { budgets: { maxChunkRecords: 1 } }),
      "BUDGET_EXCEEDED"
    );
    expectFormatError(
      () => parseEncodedChunkIndex(bytes, MANIFEST, { budgets: { maxIndexBytes: 111 } }),
      "BUDGET_EXCEEDED"
    );
    expectFormatError(
      () => parseEncodedChunkIndex(null as unknown as Uint8Array, MANIFEST),
      "INDEX_INVALID"
    );
    expectFormatError(
      () => encodeEncodedChunkIndex(null as unknown as readonly EncodedChunkRecord[], MANIFEST),
      "INDEX_INVALID"
    );
  });
});
