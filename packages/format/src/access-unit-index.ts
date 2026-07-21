import {
  CHUNK_INDEX_HEADER_LENGTH,
  CHUNK_INDEX_MAGIC,
  CHUNK_INDEX_RECORD_LENGTH,
  resolveFormatBudgets
} from "./constants.js";
import {
  checkedAdd,
  checkedMultiply,
  readUint16LE,
  readUint32LE,
  readUint64LE,
  requireByteRange,
  writeUint16LE,
  writeUint32LE,
  writeUint64LE
} from "./checked-integer.js";
import {
  createCanonicalChunkPlan,
  type CanonicalChunkPlan
} from "./chunk-plan.js";
import { FormatError, isFormatError } from "./errors.js";
import type {
  CompiledManifest,
  EncodedChunkRecord,
  FormatOptions
} from "./model.js";

const RANDOM_ACCESS_FLAG = 0x0000_0001;

function recordByteOffset(ordinal: number, maximum: number): number {
  return checkedAdd(
    CHUNK_INDEX_HEADER_LENGTH,
    checkedMultiply(
      ordinal,
      CHUNK_INDEX_RECORD_LENGTH,
      maximum,
      "encoded-chunk record offset"
    ),
    maximum,
    "encoded-chunk record offset"
  );
}

function fail(message: string, offset?: number): never {
  throw new FormatError(
    "INDEX_INVALID",
    message,
    offset === undefined ? undefined : { offset }
  );
}

function assertMagic(bytes: Uint8Array): void {
  for (let index = 0; index < CHUNK_INDEX_MAGIC.length; index += 1) {
    if (bytes[index] !== CHUNK_INDEX_MAGIC[index]) {
      fail("encoded-chunk index magic must be AVLI", index);
    }
  }
}

function canonicalChunkPlan(
  manifest: CompiledManifest,
  options?: FormatOptions
): Readonly<CanonicalChunkPlan> {
  const budgets = resolveFormatBudgets(options);
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !Array.isArray(manifest.renditions) ||
    !Array.isArray(manifest.units)
  ) {
    fail("a validated manifest is required to interpret the encoded-chunk index");
  }
  try {
    return createCanonicalChunkPlan(
      manifest.renditions,
      manifest.units,
      budgets.maxChunkRecords,
      budgets.maxTotalUnitFrames
    );
  } catch (error) {
    if (
      isFormatError(error) &&
      (error.code === "BUDGET_EXCEEDED" || error.code === "INTEGER_UNSAFE")
    ) {
      throw error;
    }
    if (isFormatError(error)) {
      throw new FormatError("INDEX_INVALID", error.message, {
        ...(error.path === undefined ? {} : { path: error.path })
      });
    }
    fail("manifest chunk plan could not be derived");
  }
}

function validateRecordSequence(
  records: readonly EncodedChunkRecord[],
  plan: Readonly<CanonicalChunkPlan>,
  options?: FormatOptions
): void {
  const budgets = resolveFormatBudgets(options);
  if (records.length !== plan.recordCount) {
    fail(
      `encoded-chunk record count must be ${String(plan.recordCount)}, received ${String(records.length)}`,
      8
    );
  }

  for (const span of plan.spans) {
    let displayedFrames = 0;
    const end = span.chunkStart + span.chunkCount;
    for (let ordinal = span.chunkStart; ordinal < end; ordinal += 1) {
      const record = records[ordinal];
      const offset = recordByteOffset(ordinal, budgets.maxIndexBytes);
      if (record === undefined) fail("encoded-chunk record is missing", offset);
      if (record.byteLength < 1) fail("encoded-chunk byte length must be positive", offset + 8);
      if (record.byteLength > budgets.maxChunkBytes) {
        throw new FormatError(
          "BUDGET_EXCEEDED",
          `encoded-chunk byte length exceeds the active limit of ${String(budgets.maxChunkBytes)}`,
          { offset: offset + 8 }
        );
      }
      if (ordinal === span.chunkStart && !record.randomAccess) {
        fail("every unit must begin with a random-access chunk", offset + 32);
      }
      if (record.displayedFrameCount > 0 && record.duration === 0) {
        fail("a displayed encoded chunk must have a positive duration", offset + 24);
      }
      const lastTimestamp = BigInt(record.presentationTimestamp) +
        BigInt(record.duration) * BigInt(Math.max(0, record.displayedFrameCount - 1));
      if (lastTimestamp > BigInt(Number.MAX_SAFE_INTEGER)) {
        fail("encoded-chunk presentation timeline exceeds the safe integer range", offset + 16);
      }
      displayedFrames = checkedAdd(
        displayedFrames,
        record.displayedFrameCount,
        budgets.maxTotalUnitFrames,
        "unit displayed frame count"
      );
    }
    if (displayedFrames !== span.frameCount) {
      fail(
        `unit ${span.unitId} rendition ${span.renditionId} must display exactly ${String(span.frameCount)} frames`,
        recordByteOffset(span.chunkStart, budgets.maxIndexBytes) + 12
      );
    }
  }
}

function parseRecord(
  bytes: Uint8Array,
  ordinal: number,
  options?: FormatOptions
): Readonly<EncodedChunkRecord> {
  const budgets = resolveFormatBudgets(options);
  const offset = recordByteOffset(ordinal, budgets.maxIndexBytes);
  const byteOffset = readUint64LE(
    bytes,
    offset,
    budgets.maxFileBytes,
    "INDEX_INVALID",
    "encoded-chunk byte offset"
  );
  const byteLength = readUint32LE(
    bytes,
    offset + 8,
    "INDEX_INVALID",
    "encoded-chunk byte length"
  );
  const displayedFrameCount = readUint32LE(
    bytes,
    offset + 12,
    "INDEX_INVALID",
    "encoded-chunk displayed frame count"
  );
  const presentationTimestamp = readUint64LE(
    bytes,
    offset + 16,
    Number.MAX_SAFE_INTEGER,
    "INDEX_INVALID",
    "encoded-chunk presentation timestamp"
  );
  const duration = readUint64LE(
    bytes,
    offset + 24,
    Number.MAX_SAFE_INTEGER,
    "INDEX_INVALID",
    "encoded-chunk duration"
  );
  const flags = readUint32LE(
    bytes,
    offset + 32,
    "INDEX_INVALID",
    "encoded-chunk flags"
  );
  if ((flags & ~RANDOM_ACCESS_FLAG) !== 0) {
    fail("encoded-chunk record uses unknown flag bits", offset + 32);
  }
  for (let reserved = offset + 36; reserved < offset + 48; reserved += 1) {
    if (bytes[reserved] !== 0) {
      fail("encoded-chunk record reserved bytes must be zero", reserved);
    }
  }
  return Object.freeze({
    byteOffset,
    byteLength,
    presentationTimestamp,
    duration,
    randomAccess: (flags & RANDOM_ACCESS_FLAG) !== 0,
    displayedFrameCount
  });
}

/** Parse the exact fixed-width 1.1 decode-order chunk index. */
export function parseEncodedChunkIndex(
  bytes: Uint8Array,
  manifest: CompiledManifest,
  options?: FormatOptions
): readonly EncodedChunkRecord[] {
  try {
    const budgets = resolveFormatBudgets(options);
    requireByteRange(
      bytes,
      0,
      CHUNK_INDEX_HEADER_LENGTH,
      "INDEX_INVALID",
      "encoded-chunk index header"
    );
    assertMagic(bytes);
    const recordSize = readUint16LE(bytes, 4, "INDEX_INVALID", "encoded-chunk record size");
    if (recordSize !== CHUNK_INDEX_RECORD_LENGTH) {
      fail(`encoded-chunk record size must be ${String(CHUNK_INDEX_RECORD_LENGTH)}`, 4);
    }
    if (readUint16LE(bytes, 6, "INDEX_INVALID", "index reserved field") !== 0) {
      fail("encoded-chunk index reserved field must be zero", 6);
    }
    const chunkCount = readUint32LE(bytes, 8, "INDEX_INVALID", "encoded-chunk count");
    if (readUint32LE(bytes, 12, "INDEX_INVALID", "index reserved field") !== 0) {
      fail("encoded-chunk index reserved field must be zero", 12);
    }
    if (chunkCount > budgets.maxChunkRecords) {
      throw new FormatError(
        "BUDGET_EXCEEDED",
        `encoded-chunk count exceeds the active limit of ${String(budgets.maxChunkRecords)}`,
        { offset: 8 }
      );
    }
    const expectedLength = checkedAdd(
      CHUNK_INDEX_HEADER_LENGTH,
      checkedMultiply(
        chunkCount,
        CHUNK_INDEX_RECORD_LENGTH,
        budgets.maxIndexBytes,
        "encoded-chunk records length"
      ),
      budgets.maxIndexBytes,
      "encoded-chunk index length"
    );
    if (bytes.byteLength !== expectedLength) {
      fail(
        `encoded-chunk index length must be exactly ${String(expectedLength)} bytes`,
        Math.min(bytes.byteLength, expectedLength)
      );
    }
    const plan = canonicalChunkPlan(manifest, options);
    if (chunkCount !== plan.recordCount) {
      fail(`encoded-chunk count must match the manifest count of ${String(plan.recordCount)}`, 8);
    }
    const records: EncodedChunkRecord[] = [];
    for (let ordinal = 0; ordinal < chunkCount; ordinal += 1) {
      records.push(parseRecord(bytes, ordinal, options));
    }
    validateRecordSequence(records, plan, options);
    return Object.freeze(records);
  } catch (error) {
    if (isFormatError(error)) throw error;
    throw new FormatError("INDEX_INVALID", "encoded-chunk index could not be parsed");
  }
}

/** Encode the exact fixed-width 1.1 decode-order chunk index. */
export function encodeEncodedChunkIndex(
  records: readonly EncodedChunkRecord[],
  manifest: CompiledManifest,
  options?: FormatOptions
): Uint8Array {
  try {
    if (!Array.isArray(records)) fail("encoded-chunk records must be an array");
    const budgets = resolveFormatBudgets(options);
    if (records.length > budgets.maxChunkRecords) {
      throw new FormatError("BUDGET_EXCEEDED", "encoded-chunk count exceeds the active limit", { offset: 8 });
    }
    const length = checkedAdd(
      CHUNK_INDEX_HEADER_LENGTH,
      checkedMultiply(
        records.length,
        CHUNK_INDEX_RECORD_LENGTH,
        budgets.maxIndexBytes,
        "encoded-chunk records length"
      ),
      budgets.maxIndexBytes,
      "encoded-chunk index length"
    );
    const bytes = new Uint8Array(length);
    bytes.set(CHUNK_INDEX_MAGIC, 0);
    writeUint16LE(bytes, 4, CHUNK_INDEX_RECORD_LENGTH, "INDEX_INVALID", "encoded-chunk record size");
    writeUint16LE(bytes, 6, 0, "INDEX_INVALID", "index reserved field");
    writeUint32LE(bytes, 8, records.length, "INDEX_INVALID", "encoded-chunk count");
    writeUint32LE(bytes, 12, 0, "INDEX_INVALID", "index reserved field");

    for (let ordinal = 0; ordinal < records.length; ordinal += 1) {
      const record = records[ordinal];
      const offset = recordByteOffset(ordinal, budgets.maxIndexBytes);
      if (typeof record !== "object" || record === null) {
        fail("encoded-chunk record must be an object", offset);
      }
      if (typeof record.randomAccess !== "boolean") {
        fail("encoded-chunk random-access marker must be boolean", offset + 32);
      }
      writeUint64LE(bytes, offset, record.byteOffset, "INDEX_INVALID", "encoded-chunk byte offset");
      writeUint32LE(bytes, offset + 8, record.byteLength, "INDEX_INVALID", "encoded-chunk byte length");
      writeUint32LE(
        bytes,
        offset + 12,
        record.displayedFrameCount,
        "INDEX_INVALID",
        "encoded-chunk displayed frame count"
      );
      writeUint64LE(
        bytes,
        offset + 16,
        record.presentationTimestamp,
        "INDEX_INVALID",
        "encoded-chunk presentation timestamp"
      );
      writeUint64LE(bytes, offset + 24, record.duration, "INDEX_INVALID", "encoded-chunk duration");
      writeUint32LE(
        bytes,
        offset + 32,
        record.randomAccess ? RANDOM_ACCESS_FLAG : 0,
        "INDEX_INVALID",
        "encoded-chunk flags"
      );
    }
    parseEncodedChunkIndex(bytes, manifest, options);
    return bytes;
  } catch (error) {
    if (isFormatError(error)) throw error;
    throw new FormatError("INDEX_INVALID", "encoded-chunk index could not be encoded");
  }
}
