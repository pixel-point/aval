import {
  CHUNK_INDEX_HEADER_LENGTH,
  CHUNK_INDEX_RECORD_LENGTH,
  FORMAT_HEADER_LENGTH,
  FORMAT_MAGIC,
  FORMAT_VERSION_MAJOR,
  FORMAT_VERSION_MINOR,
  resolveFormatBudgets
} from "./constants.js";
import {
  align8,
  checkedAdd,
  readUint16LE,
  readUint32LE,
  readUint64LE,
  requireByteRange,
  writeUint16LE,
  writeUint32LE,
  writeUint64LE
} from "./checked-integer.js";
import { FormatError, isFormatError } from "./errors.js";
import type { FormatHeader, FormatOptions } from "./model.js";

export type { FormatHeader } from "./model.js";

interface HeaderFields {
  readonly major: number;
  readonly minor: number;
  readonly headerLength: number;
  readonly requiredFeatureFlags: number;
  readonly declaredFileLength: number;
  readonly manifestOffset: number;
  readonly manifestLength: number;
  readonly indexOffset: number;
  readonly indexLength: number;
}

function fail(message: string, offset: number): never {
  throw new FormatError("HEADER_INVALID", message, { offset });
}

function assertMagic(bytes: Uint8Array): void {
  for (let index = 0; index < FORMAT_MAGIC.length; index += 1) {
    if (bytes[index] !== FORMAT_MAGIC[index]) {
      fail("format magic does not match AVLF", index);
    }
  }
}

function validateHeaderShape(
  header: Readonly<HeaderFields>,
  options?: FormatOptions
): void {
  const budgets = resolveFormatBudgets(options);

  if (
    header.major !== FORMAT_VERSION_MAJOR ||
    header.minor !== FORMAT_VERSION_MINOR
  ) {
    throw new FormatError(
      "VERSION_UNSUPPORTED",
      `format version ${header.major}.${header.minor} is unsupported`,
      { offset: header.major !== FORMAT_VERSION_MAJOR ? 8 : 10 }
    );
  }
  if (header.headerLength !== FORMAT_HEADER_LENGTH) {
    fail(`header length must be ${FORMAT_HEADER_LENGTH}`, 12);
  }
  if (header.requiredFeatureFlags !== 0) {
    throw new FormatError(
      "FEATURE_UNSUPPORTED",
      "required feature flags are unsupported",
      { offset: 16 }
    );
  }
  if (header.manifestOffset !== FORMAT_HEADER_LENGTH) {
    fail(`manifest offset must be ${FORMAT_HEADER_LENGTH}`, 32);
  }
  if (header.manifestLength === 0) {
    fail("manifest length must be positive", 40);
  }

  let expectedIndexOffset: number;
  try {
    expectedIndexOffset = align8(
      checkedAdd(
        FORMAT_HEADER_LENGTH,
        header.manifestLength,
        budgets.maxFileBytes,
        "manifest end"
      ),
      budgets.maxFileBytes,
      "index offset"
    );
  } catch (error) {
    if (isFormatError(error)) {
      throw new FormatError(error.code, error.message, { offset: 40 });
    }
    fail("manifest range is invalid", 40);
  }
  if (header.indexOffset !== expectedIndexOffset) {
    fail(`index offset must be ${expectedIndexOffset}`, 48);
  }
  if (
    header.indexLength < CHUNK_INDEX_HEADER_LENGTH ||
    (header.indexLength - CHUNK_INDEX_HEADER_LENGTH) %
      CHUNK_INDEX_RECORD_LENGTH !==
      0
  ) {
    fail("index length does not encode whole access-unit records", 56);
  }
  const chunkCount =
    (header.indexLength - CHUNK_INDEX_HEADER_LENGTH) /
    CHUNK_INDEX_RECORD_LENGTH;
  if (chunkCount > budgets.maxChunkRecords) {
    throw new FormatError(
      "BUDGET_EXCEEDED",
      `chunk record count exceeds the active limit of ${budgets.maxChunkRecords}`,
      { offset: 56 }
    );
  }

  let frontIndexEnd: number;
  try {
    frontIndexEnd = checkedAdd(
      header.indexOffset,
      header.indexLength,
      budgets.maxFileBytes,
      "front index end"
    );
  } catch (error) {
    if (isFormatError(error)) {
      throw new FormatError(error.code, error.message, { offset: 56 });
    }
    fail("front index range is invalid", 56);
  }
  if (frontIndexEnd > header.declaredFileLength) {
    fail("front index extends beyond the declared file length", 24);
  }
}

/** Decodes and validates an exact supported 64-byte header. */
export function parseHeader(
  bytes: Uint8Array,
  options?: FormatOptions
): Readonly<FormatHeader> {
  try {
    requireByteRange(
      bytes,
      0,
      FORMAT_HEADER_LENGTH,
      "HEADER_INVALID",
      "format header"
    );
    assertMagic(bytes);

    const major = readUint16LE(bytes, 8, "HEADER_INVALID", "major version");
    const minor = readUint16LE(bytes, 10, "HEADER_INVALID", "minor version");
    const headerLength = readUint32LE(
      bytes,
      12,
      "HEADER_INVALID",
      "header length"
    );
    const requiredFeatureFlags = readUint32LE(
      bytes,
      16,
      "HEADER_INVALID",
      "required feature flags"
    );
    const reserved = readUint32LE(bytes, 20, "HEADER_INVALID", "reserved field");
    if (reserved !== 0) {
      fail("reserved header field must be zero", 20);
    }

    const budgets = resolveFormatBudgets(options);
    const declaredFileLength = readUint64LE(
      bytes,
      24,
      budgets.maxFileBytes,
      "HEADER_INVALID",
      "declared file length"
    );
    const manifestOffset = readUint64LE(
      bytes,
      32,
      budgets.maxFileBytes,
      "HEADER_INVALID",
      "manifest offset"
    );
    const manifestLength = readUint64LE(
      bytes,
      40,
      budgets.maxManifestBytes,
      "HEADER_INVALID",
      "manifest length"
    );
    const indexOffset = readUint64LE(
      bytes,
      48,
      budgets.maxFileBytes,
      "HEADER_INVALID",
      "index offset"
    );
    const indexLength = readUint64LE(
      bytes,
      56,
      budgets.maxIndexBytes,
      "HEADER_INVALID",
      "index length"
    );

    const fields: HeaderFields = {
      major,
      minor,
      headerLength,
      requiredFeatureFlags,
      declaredFileLength,
      manifestOffset,
      manifestLength,
      indexOffset,
      indexLength
    };
    validateHeaderShape(fields, options);
    const header = {
      major,
      minor,
      headerLength: FORMAT_HEADER_LENGTH,
      requiredFeatureFlags: 0,
      declaredFileLength,
      manifestOffset: FORMAT_HEADER_LENGTH,
      manifestLength,
      indexOffset,
      indexLength
    } as FormatHeader;
    return Object.freeze(header);
  } catch (error) {
    if (isFormatError(error)) {
      throw error;
    }
    throw new FormatError("HEADER_INVALID", "format header could not be parsed");
  }
}

/** Encodes one canonical supported header into a new 64-byte array. */
export function encodeHeader(
  header: FormatHeader,
  options?: FormatOptions
): Uint8Array {
  try {
    if (typeof header !== "object" || header === null) {
      fail("header must be an object", 0);
    }
    validateHeaderShape(header, options);
    const bytes = new Uint8Array(FORMAT_HEADER_LENGTH);
    bytes.set(FORMAT_MAGIC, 0);
    writeUint16LE(bytes, 8, header.major, "HEADER_INVALID", "major version");
    writeUint16LE(bytes, 10, header.minor, "HEADER_INVALID", "minor version");
    writeUint32LE(
      bytes,
      12,
      header.headerLength,
      "HEADER_INVALID",
      "header length"
    );
    writeUint32LE(
      bytes,
      16,
      header.requiredFeatureFlags,
      "HEADER_INVALID",
      "required feature flags"
    );
    writeUint32LE(bytes, 20, 0, "HEADER_INVALID", "reserved field");
    writeUint64LE(
      bytes,
      24,
      header.declaredFileLength,
      "HEADER_INVALID",
      "declared file length"
    );
    writeUint64LE(
      bytes,
      32,
      header.manifestOffset,
      "HEADER_INVALID",
      "manifest offset"
    );
    writeUint64LE(
      bytes,
      40,
      header.manifestLength,
      "HEADER_INVALID",
      "manifest length"
    );
    writeUint64LE(
      bytes,
      48,
      header.indexOffset,
      "HEADER_INVALID",
      "index offset"
    );
    writeUint64LE(
      bytes,
      56,
      header.indexLength,
      "HEADER_INVALID",
      "index length"
    );
    return bytes;
  } catch (error) {
    if (isFormatError(error)) {
      throw error;
    }
    throw new FormatError("HEADER_INVALID", "format header could not be encoded");
  }
}
