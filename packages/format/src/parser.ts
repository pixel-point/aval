import { parseEncodedChunkIndex } from "./access-unit-index.js";
import { parseCanonicalJson, serializeCanonicalJson } from "./canonical-json.js";
import { checkedAdd, checkedMultiply, requireByteRange } from "./checked-integer.js";
import { createCanonicalChunkPlan } from "./chunk-plan.js";
import {
  CHUNK_INDEX_HEADER_LENGTH,
  CHUNK_INDEX_RECORD_LENGTH,
  resolveFormatBudgets
} from "./constants.js";
import { adaptManifestToMotionGraph } from "./graph-adapter.js";
import { parseHeader } from "./header.js";
import {
  deriveCanonicalAssetLayout,
  validateZeroPadding
} from "./layout.js";
import { validateCompiledManifest } from "./manifest-schema.js";
import { FormatError, isFormatError } from "./errors.js";
import type {
  CompiledManifest,
  EncodedChunkRecord,
  FormatHeader,
  FormatOptions,
  ParsedFrontIndex,
  ParsedManifestPrefix,
  ValidatedAssetLayout
} from "./model.js";

const HEADER_FIELDS = Object.freeze([
  "major",
  "minor",
  "headerLength",
  "requiredFeatureFlags",
  "declaredFileLength",
  "manifestOffset",
  "manifestLength",
  "indexOffset",
  "indexLength"
] as const satisfies readonly (keyof FormatHeader)[]);

const RECORD_FIELDS = Object.freeze([
  "byteOffset",
  "byteLength",
  "presentationTimestamp",
  "duration",
  "randomAccess",
  "displayedFrameCount"
] as const satisfies readonly (keyof EncodedChunkRecord)[]);

function rethrowAtFileOffset(error: unknown, baseOffset: number): never {
  if (isFormatError(error)) {
    throw new FormatError(
      error.code,
      error.message,
      error.offset === undefined
        ? error.path === undefined
          ? undefined
          : { path: error.path }
        : error.path === undefined
          ? { offset: baseOffset + error.offset }
          : { path: error.path, offset: baseOffset + error.offset }
    );
  }
  throw error;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function assertMatchingFrontIndex(
  supplied: ParsedFrontIndex,
  reparsed: ParsedFrontIndex,
  options?: FormatOptions
): void {
  if (typeof supplied !== "object" || supplied === null) {
    throw new FormatError(
      "INPUT_INVALID",
      "supplied front index must be an object"
    );
  }
  for (const field of HEADER_FIELDS) {
    if (supplied.header[field] !== reparsed.header[field]) {
      throw new FormatError(
        "LAYOUT_INVALID",
        `supplied front index header field ${field} does not match the asset`
      );
    }
  }

  let suppliedManifestBytes: Uint8Array;
  let reparsedManifestBytes: Uint8Array;
  try {
    const suppliedManifest = validateCompiledManifest(
      supplied.manifest,
      options
    );
    suppliedManifestBytes = serializeCanonicalJson(suppliedManifest, options);
    reparsedManifestBytes = serializeCanonicalJson(reparsed.manifest, options);
  } catch (error) {
    if (isFormatError(error)) {
      throw new FormatError(
        "LAYOUT_INVALID",
        "supplied front index manifest is not the asset manifest"
      );
    }
    throw error;
  }
  if (!bytesEqual(suppliedManifestBytes, reparsedManifestBytes)) {
    throw new FormatError(
      "LAYOUT_INVALID",
      "supplied front index manifest does not match the asset"
    );
  }

  if (supplied.records.length !== reparsed.records.length) {
    throw new FormatError(
      "LAYOUT_INVALID",
      "supplied front index record count does not match the asset"
    );
  }
  for (let index = 0; index < reparsed.records.length; index += 1) {
    const suppliedRecord = supplied.records[index];
    const reparsedRecord = reparsed.records[index];
    if (suppliedRecord === undefined || reparsedRecord === undefined) {
      throw new FormatError(
        "LAYOUT_INVALID",
        "supplied front index record set is incomplete"
      );
    }
    for (const field of RECORD_FIELDS) {
      if (suppliedRecord[field] !== reparsedRecord[field]) {
        throw new FormatError(
          "LAYOUT_INVALID",
          `supplied front index record ${String(index)} field ${field} does not match the asset`
        );
      }
    }
  }
}

function parseManifest(
  bytes: Uint8Array,
  header: FormatHeader,
  options?: FormatOptions
): CompiledManifest {
  const end = requireByteRange(
    bytes,
    header.manifestOffset,
    header.manifestLength,
    "JSON_INVALID",
    "manifest"
  );
  let parsed: unknown;
  try {
    parsed = parseCanonicalJson(
      bytes.subarray(header.manifestOffset, end),
      options
    );
  } catch (error) {
    rethrowAtFileOffset(error, header.manifestOffset);
  }
  const manifest = validateCompiledManifest(parsed, options);
  const headerVersion = `${String(header.major)}.${String(header.minor)}`;
  if (manifest.formatVersion !== headerVersion) {
    throw new FormatError(
      "MANIFEST_INVALID",
      `formatVersion must match header version ${headerVersion}`,
      { path: "formatVersion" }
    );
  }
  return manifest;
}

/**
 * Parse the bounded manifest stage needed to calculate the exact front-index
 * range without accepting or allocating from unverified index metadata.
 */
export function parseManifestPrefix(
  bytesFromFileStart: Uint8Array,
  options?: FormatOptions
): Readonly<ParsedManifestPrefix> {
  try {
    if (!(bytesFromFileStart instanceof Uint8Array)) {
      throw new FormatError(
        "INPUT_INVALID",
        "manifest-prefix input must be a Uint8Array"
      );
    }
    const header = parseHeader(bytesFromFileStart, options);
    if (bytesFromFileStart.byteLength < header.indexOffset) {
      throw new FormatError("JSON_INVALID", "manifest prefix is truncated", {
        offset: bytesFromFileStart.byteLength
      });
    }

    const manifest = parseManifest(bytesFromFileStart, header, options);
    const manifestEnd = checkedAdd(
      header.manifestOffset,
      header.manifestLength,
      header.indexOffset,
      "manifest end"
    );
    validateZeroPadding(bytesFromFileStart, [
      Object.freeze({
        offset: manifestEnd,
        length: header.indexOffset - manifestEnd
      })
    ]);

    if (header.declaredFileLength > manifest.limits.maxCompiledBytes) {
      throw new FormatError(
        "BUDGET_EXCEEDED",
        "declared file length exceeds manifest limits.maxCompiledBytes",
        { path: "limits.maxCompiledBytes" }
      );
    }

    const budgets = resolveFormatBudgets(options);
    const chunkPlan = createCanonicalChunkPlan(
      manifest.renditions,
      manifest.units,
      budgets.maxChunkRecords,
      budgets.maxTotalUnitFrames
    );
    const expectedIndexLength = checkedAdd(
      CHUNK_INDEX_HEADER_LENGTH,
      checkedMultiply(
        chunkPlan.recordCount,
        CHUNK_INDEX_RECORD_LENGTH,
        budgets.maxIndexBytes,
        "encoded-chunk records length"
      ),
      budgets.maxIndexBytes,
      "encoded-chunk index length"
    );
    if (header.indexLength !== expectedIndexLength) {
      throw new FormatError(
        "INDEX_INVALID",
        `encoded-chunk index length must be ${String(expectedIndexLength)} bytes`,
        { offset: 56 }
      );
    }
    const frontIndexLength = checkedAdd(
      header.indexOffset,
      header.indexLength,
      header.declaredFileLength,
      "front index end"
    );
    return Object.freeze({
      header,
      manifest,
      frontIndexRange: Object.freeze({ offset: 0, length: frontIndexLength })
    });
  } catch (error) {
    if (isFormatError(error)) {
      throw error;
    }
    throw new FormatError("INPUT_INVALID", "manifest prefix could not be parsed");
  }
}

/**
 * Parse exactly the bounded metadata prefix needed to route and range-load an
 * asset. Payload bytes, when present in the input view, are ignored.
 */
export function parseFrontIndex(
  bytesFromFileStart: Uint8Array,
  options?: FormatOptions
): ParsedFrontIndex {
  try {
    const prefix = parseManifestPrefix(bytesFromFileStart, options);
    const { header, manifest } = prefix;
    const frontIndexEnd = prefix.frontIndexRange.length;
    if (bytesFromFileStart.byteLength < frontIndexEnd) {
      throw new FormatError("INDEX_INVALID", "front index is truncated", {
        offset: bytesFromFileStart.byteLength
      });
    }

    let records: readonly EncodedChunkRecord[];
    try {
      records = parseEncodedChunkIndex(
        bytesFromFileStart.subarray(header.indexOffset, frontIndexEnd),
        manifest,
        options
      );
    } catch (error) {
      rethrowAtFileOffset(error, header.indexOffset);
    }

    const graph = adaptManifestToMotionGraph(manifest);
    const layout = deriveCanonicalAssetLayout(header, manifest, records, options);
    return Object.freeze({
      header,
      manifest,
      graph,
      records,
      frontIndexRange: prefix.frontIndexRange,
      unitBlobs: layout.unitBlobs
    });
  } catch (error) {
    if (isFormatError(error)) {
      throw error;
    }
    throw new FormatError("INPUT_INVALID", "front index could not be parsed");
  }
}

/** Reparse and completely validate one exact, caller-owned asset byte array. */
export function validateCompleteAsset(input: {
  readonly bytes: Uint8Array;
  readonly frontIndex?: ParsedFrontIndex;
  readonly options?: FormatOptions;
}): ValidatedAssetLayout {
  try {
    if (typeof input !== "object" || input === null) {
      throw new FormatError(
        "INPUT_INVALID",
        "complete-asset input must be an object"
      );
    }
    if (!(input.bytes instanceof Uint8Array)) {
      throw new FormatError("INPUT_INVALID", "asset bytes must be a Uint8Array");
    }

    const reparsed = parseFrontIndex(input.bytes, input.options);
    if (input.bytes.byteLength !== reparsed.header.declaredFileLength) {
      throw new FormatError(
        "LAYOUT_INVALID",
        input.bytes.byteLength < reparsed.header.declaredFileLength
          ? "asset bytes are truncated"
          : "asset contains bytes beyond the declared file length",
        {
          offset: Math.min(
            input.bytes.byteLength,
            reparsed.header.declaredFileLength
          )
        }
      );
    }
    if (input.frontIndex !== undefined) {
      assertMatchingFrontIndex(input.frontIndex, reparsed, input.options);
    }

    const layout = deriveCanonicalAssetLayout(
      reparsed.header,
      reparsed.manifest,
      reparsed.records,
      input.options
    );
    validateZeroPadding(input.bytes, layout.paddingRanges);
    return Object.freeze({
      frontIndex: reparsed,
      fileRange: layout.fileRange
    });
  } catch (error) {
    if (isFormatError(error)) {
      throw error;
    }
    throw new FormatError("INPUT_INVALID", "complete asset could not be validated");
  }
}
