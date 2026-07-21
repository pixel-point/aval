import { align8, checkedAdd, checkedMultiply } from "./checked-integer.js";
import {
  CHUNK_INDEX_HEADER_LENGTH,
  CHUNK_INDEX_RECORD_LENGTH,
  FORMAT_HEADER_LENGTH,
  resolveFormatBudgets
} from "./constants.js";
import {
  createCanonicalChunkPlan,
  validateCanonicalChunkSpans
} from "./chunk-plan.js";
import { FormatError, isFormatError } from "./errors.js";
import type {
  ByteRange,
  CompiledManifest,
  EncodedChunkRecord,
  FormatHeader,
  FormatOptions,
  UnitBlobRange
} from "./model.js";

export interface CanonicalAssetLayout {
  readonly frontIndexRange: ByteRange;
  readonly unitBlobs: readonly UnitBlobRange[];
  readonly paddingRanges: readonly ByteRange[];
  readonly fileRange: ByteRange;
}

interface ChunkPayloadShape {
  readonly byteLength: number;
  readonly presentationTimestamp: number;
  readonly duration: number;
  readonly randomAccess: boolean;
  readonly displayedFrameCount: number;
}

export interface CanonicalAssetPlan extends CanonicalAssetLayout {
  readonly indexOffset: number;
  readonly indexLength: number;
  readonly records: readonly EncodedChunkRecord[];
}

function fail(
  message: string,
  details?: { readonly offset?: number; readonly path?: string }
): never {
  throw new FormatError("LAYOUT_INVALID", message, details);
}

function freezeRange(offset: number, length: number): ByteRange {
  return Object.freeze({ offset, length });
}

function addPaddingRange(ranges: ByteRange[], offset: number, end: number): void {
  if (end > offset) ranges.push(freezeRange(offset, end - offset));
}

/** Build the sole legal 1.1 file layout from bounded chunk descriptors. */
export function planCanonicalAssetLayout(
  manifestLength: number,
  manifest: CompiledManifest,
  chunks: readonly ChunkPayloadShape[],
  options?: FormatOptions
): Readonly<CanonicalAssetPlan> {
  try {
    const budgets = resolveFormatBudgets(options);
    const chunkPlan = createCanonicalChunkPlan(
      manifest.renditions,
      manifest.units,
      budgets.maxChunkRecords,
      budgets.maxTotalUnitFrames
    );
    validateCanonicalChunkSpans(chunkPlan, manifest.units);
    if (chunks.length !== chunkPlan.recordCount) {
      fail(
        `encoded-chunk payload count must be ${String(chunkPlan.recordCount)}, received ${String(chunks.length)}`
      );
    }
    if (chunkPlan.spans.length > budgets.maxBlobRanges) {
      throw new FormatError("BUDGET_EXCEEDED", "canonical blob range count exceeds the active budget");
    }
    if (manifestLength > budgets.maxManifestBytes) {
      throw new FormatError(
        "BUDGET_EXCEEDED",
        `manifest length exceeds the active limit of ${String(budgets.maxManifestBytes)}`
      );
    }
    const manifestEnd = checkedAdd(
      FORMAT_HEADER_LENGTH,
      manifestLength,
      budgets.maxFileBytes,
      "manifest end"
    );
    const indexOffset = align8(manifestEnd, budgets.maxFileBytes, "encoded-chunk index offset");
    const indexLength = checkedAdd(
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
    const frontIndexEnd = checkedAdd(
      indexOffset,
      indexLength,
      budgets.maxFileBytes,
      "front index end"
    );

    const paddingRanges: ByteRange[] = [];
    addPaddingRange(paddingRanges, manifestEnd, indexOffset);
    const records: EncodedChunkRecord[] = [];
    const unitBlobs: UnitBlobRange[] = [];
    let cursor = frontIndexEnd;
    for (const span of chunkPlan.spans) {
      const aligned = align8(cursor, budgets.maxFileBytes, "unit blob offset");
      addPaddingRange(paddingRanges, cursor, aligned);
      cursor = aligned;
      const blobOffset = cursor;
      const unit = manifest.units[span.unitIndex];
      const descriptor = unit?.chunks[span.renditionIndex];
      if (unit === undefined || descriptor === undefined) {
        fail("canonical unit chunk descriptor is missing");
      }
      const spanEnd = checkedAdd(
        span.chunkStart,
        span.chunkCount,
        chunkPlan.recordCount,
        "chunk span end"
      );
      let displayedFrames = 0;
      for (let ordinal = span.chunkStart; ordinal < spanEnd; ordinal += 1) {
        const slot = chunkPlan.recordAt(ordinal);
        const chunk = chunks[ordinal];
        if (chunk === undefined) fail("canonical encoded-chunk payload is missing");
        if (typeof chunk.randomAccess !== "boolean") {
          fail("encoded-chunk random-access marker must be boolean");
        }
        if (!Number.isSafeInteger(chunk.byteLength) || chunk.byteLength < 1) {
          fail("encoded-chunk byte length must be a positive safe integer");
        }
        if (chunk.byteLength > budgets.maxChunkBytes) {
          throw new FormatError(
            "BUDGET_EXCEEDED",
            `encoded-chunk byte length exceeds the active limit of ${String(budgets.maxChunkBytes)}`
          );
        }
        if (slot.randomAccessRequired && !chunk.randomAccess) {
          fail("every unit must begin with a random-access chunk");
        }
        if (
          !Number.isSafeInteger(chunk.presentationTimestamp) ||
          chunk.presentationTimestamp < 0 ||
          !Number.isSafeInteger(chunk.duration) ||
          chunk.duration < 0 ||
          !Number.isSafeInteger(chunk.displayedFrameCount) ||
          chunk.displayedFrameCount < 0
        ) {
          fail("encoded-chunk timeline fields must be nonnegative safe integers");
        }
        if (chunk.displayedFrameCount > 0 && chunk.duration === 0) {
          fail("a displayed encoded chunk must have a positive duration");
        }
        displayedFrames = checkedAdd(
          displayedFrames,
          chunk.displayedFrameCount,
          budgets.maxTotalUnitFrames,
          "unit displayed frame count"
        );
        records.push(Object.freeze({
          byteOffset: cursor,
          byteLength: chunk.byteLength,
          presentationTimestamp: chunk.presentationTimestamp,
          duration: chunk.duration,
          randomAccess: chunk.randomAccess,
          displayedFrameCount: chunk.displayedFrameCount
        }));
        cursor = checkedAdd(
          cursor,
          chunk.byteLength,
          budgets.maxFileBytes,
          "encoded-chunk payload end"
        );
      }
      if (displayedFrames !== span.frameCount) {
        fail(
          `unit ${span.unitId} rendition ${span.renditionId} must display exactly ${String(span.frameCount)} frames`
        );
      }
      unitBlobs.push(Object.freeze({
        rendition: span.renditionId,
        unit: span.unitId,
        chunkStart: span.chunkStart,
        chunkCount: span.chunkCount,
        frameCount: span.frameCount,
        sha256: descriptor.sha256,
        offset: blobOffset,
        length: cursor - blobOffset
      }));
    }
    if (cursor > manifest.limits.maxCompiledBytes) {
      throw new FormatError(
        "BUDGET_EXCEEDED",
        "compiled file exceeds manifest limits.maxCompiledBytes",
        { path: "limits.maxCompiledBytes" }
      );
    }
    return Object.freeze({
      indexOffset,
      indexLength,
      records: Object.freeze(records),
      frontIndexRange: freezeRange(0, frontIndexEnd),
      unitBlobs: Object.freeze(unitBlobs),
      paddingRanges: Object.freeze(paddingRanges),
      fileRange: freezeRange(0, cursor)
    });
  } catch (error) {
    if (isFormatError(error)) throw error;
    throw new FormatError("LAYOUT_INVALID", "canonical asset layout could not be planned");
  }
}

/** Derive and validate the sole legal 1.1 byte layout. */
export function deriveCanonicalAssetLayout(
  header: FormatHeader,
  manifest: CompiledManifest,
  records: readonly EncodedChunkRecord[],
  options?: FormatOptions
): Readonly<CanonicalAssetLayout> {
  try {
    if (!Array.isArray(records)) fail("encoded-chunk records must be an array");
    const plan = planCanonicalAssetLayout(
      header.manifestLength,
      manifest,
      records,
      options
    );
    if (header.manifestOffset !== FORMAT_HEADER_LENGTH) {
      fail("manifest offset is not canonical", { offset: header.manifestOffset });
    }
    if (header.indexOffset !== plan.indexOffset) {
      fail("encoded-chunk index offset is not canonical", { offset: header.indexOffset });
    }
    if (header.indexLength !== plan.indexLength) {
      fail("encoded-chunk index length is not canonical", { offset: header.indexOffset });
    }
    if (header.declaredFileLength !== plan.fileRange.length) {
      fail(
        header.declaredFileLength > plan.fileRange.length
          ? "declared file contains trailing bytes"
          : "payload layout extends beyond the declared file",
        { offset: Math.min(header.declaredFileLength, plan.fileRange.length) }
      );
    }
    for (let index = 0; index < plan.records.length; index += 1) {
      const actual = records[index];
      const expected = plan.records[index];
      if (
        actual === undefined ||
        expected === undefined ||
        actual.byteOffset !== expected.byteOffset ||
        actual.byteLength !== expected.byteLength ||
        actual.presentationTimestamp !== expected.presentationTimestamp ||
        actual.duration !== expected.duration ||
        actual.randomAccess !== expected.randomAccess ||
        actual.displayedFrameCount !== expected.displayedFrameCount
      ) {
        fail("encoded-chunk record is not canonical", {
          offset: actual?.byteOffset ?? header.indexOffset
        });
      }
    }
    return Object.freeze({
      frontIndexRange: plan.frontIndexRange,
      unitBlobs: plan.unitBlobs,
      paddingRanges: plan.paddingRanges,
      fileRange: plan.fileRange
    });
  } catch (error) {
    if (isFormatError(error)) throw error;
    throw new FormatError("LAYOUT_INVALID", "asset layout could not be derived");
  }
}

export function validateZeroPadding(bytes: Uint8Array, ranges: readonly ByteRange[]): void {
  try {
    if (!(bytes instanceof Uint8Array)) {
      throw new FormatError("INPUT_INVALID", "asset bytes must be a Uint8Array");
    }
    for (const range of ranges) {
      const end = checkedAdd(range.offset, range.length, bytes.byteLength, "padding range end");
      for (let offset = range.offset; offset < end; offset += 1) {
        if (bytes[offset] !== 0) fail("alignment padding must contain only zero bytes", { offset });
      }
    }
  } catch (error) {
    if (isFormatError(error)) throw error;
    throw new FormatError("LAYOUT_INVALID", "asset padding could not be validated");
  }
}
