import { checkedAdd } from "./checked-integer.js";
import { FormatError, type FormatErrorCode } from "./errors.js";
import type { ProductionRendition, Unit } from "./model.js";

const UINT32_MAX = 0xffff_ffff;

export interface CanonicalChunkSlot {
  readonly ordinal: number;
  readonly renditionIndex: number;
  readonly renditionId: string;
  readonly unitIndex: number;
  readonly unitId: string;
  readonly decodeIndex: number;
  readonly randomAccessRequired: boolean;
}

export interface CanonicalChunkSpan {
  readonly renditionIndex: number;
  readonly renditionId: string;
  readonly unitIndex: number;
  readonly unitId: string;
  readonly chunkStart: number;
  readonly chunkCount: number;
  readonly frameCount: number;
}

export interface CanonicalChunkPlan {
  readonly renditionCount: number;
  readonly unitCount: number;
  readonly totalFrameCount: number;
  readonly recordCount: number;
  readonly spans: readonly CanonicalChunkSpan[];
  readonly unitSpans: readonly (readonly CanonicalChunkSpan[])[];
  records(): IterableIterator<CanonicalChunkSlot>;
  recordAt(index: number): CanonicalChunkSlot;
}

/** Own the sole rendition → unit → decode-order chunk traversal. */
export function createCanonicalChunkPlan(
  renditions: readonly Pick<ProductionRendition, "id">[],
  units: readonly Pick<Unit, "id" | "frameCount" | "chunks">[],
  maximumRecords: number,
  maximumTotalFrames: number = maximumRecords
): Readonly<CanonicalChunkPlan> {
  requireMaximum(maximumRecords, "maximum chunk records");
  requireMaximum(maximumTotalFrames, "maximum total frames");
  if (renditions.length < 1) manifestInvalid("at least one rendition is required", "renditions");
  if (renditions.length > maximumRecords) budget("rendition count cannot fit the chunk record budget");
  if (units.length < 1) manifestInvalid("at least one unit is required", "units");
  if (units.length > maximumTotalFrames) budget("unit count cannot fit the frame budget");

  let totalFrameCount = 0;
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    if (unit === undefined || !positiveSafe(unit.frameCount)) {
      manifestInvalid("must be a positive safe integer", `units[${String(index)}].frameCount`);
    }
    totalFrameCount = checkedAdd(
      totalFrameCount,
      unit.frameCount,
      UINT32_MAX,
      "total unit frames"
    );
    if (totalFrameCount > maximumTotalFrames) budget("total unit frames exceed the active budget");
  }

  const spans: CanonicalChunkSpan[] = [];
  const unitSpans: CanonicalChunkSpan[][] = Array.from(
    { length: units.length },
    () => []
  );
  let ordinal = 0;
  for (let renditionIndex = 0; renditionIndex < renditions.length; renditionIndex += 1) {
    const rendition = renditions[renditionIndex];
    if (rendition === undefined) manifestInvalid("rendition array must be dense", "renditions");
    for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
      const unit = units[unitIndex];
      if (unit === undefined) manifestInvalid("unit array must be dense", "units");
      const descriptor = unit.chunks[renditionIndex];
      const path = `units[${String(unitIndex)}].chunks[${String(renditionIndex)}]`;
      if (descriptor === undefined) manifestInvalid("chunk span is missing", path);
      if (descriptor.rendition !== rendition.id) {
        manifestInvalid(`rendition must be ${JSON.stringify(rendition.id)}`, `${path}.rendition`);
      }
      if (!positiveSafe(descriptor.chunkCount)) {
        manifestInvalid("must be a positive safe integer", `${path}.chunkCount`);
      }
      if (descriptor.chunkStart !== ordinal) {
        manifestInvalid(`must be the canonical ordinal ${String(ordinal)}`, `${path}.chunkStart`);
      }
      if (descriptor.frameCount !== unit.frameCount) {
        manifestInvalid("must equal the unit frameCount", `${path}.frameCount`);
      }
      const span = Object.freeze({
        renditionIndex,
        renditionId: rendition.id,
        unitIndex,
        unitId: unit.id,
        chunkStart: ordinal,
        chunkCount: descriptor.chunkCount,
        frameCount: descriptor.frameCount
      });
      spans.push(span);
      unitSpans[unitIndex]!.push(span);
      ordinal = checkedAdd(
        ordinal,
        descriptor.chunkCount,
        UINT32_MAX,
        "chunk span end"
      );
      if (ordinal > maximumRecords) budget("chunk record count exceeds the active budget");
    }
  }

  const frozenSpans = Object.freeze(spans);
  function recordAt(index: number): CanonicalChunkSlot {
    if (!Number.isSafeInteger(index) || index < 0 || index >= ordinal) {
      throw new FormatError("INTEGER_UNSAFE", "chunk record index is outside the canonical plan");
    }
    let low = 0;
    let high = frozenSpans.length - 1;
    while (low <= high) {
      const middle = low + Math.floor((high - low) / 2);
      const span = frozenSpans[middle]!;
      if (index < span.chunkStart) {
        high = middle - 1;
      } else if (index >= span.chunkStart + span.chunkCount) {
        low = middle + 1;
      } else {
        const decodeIndex = index - span.chunkStart;
        return Object.freeze({
          ordinal: index,
          renditionIndex: span.renditionIndex,
          renditionId: span.renditionId,
          unitIndex: span.unitIndex,
          unitId: span.unitId,
          decodeIndex,
          randomAccessRequired: decodeIndex === 0
        });
      }
    }
    throw new FormatError("INTEGER_UNSAFE", "canonical chunk span lookup failed");
  }

  function* records(): IterableIterator<CanonicalChunkSlot> {
    for (const span of frozenSpans) {
      for (let decodeIndex = 0; decodeIndex < span.chunkCount; decodeIndex += 1) {
        yield Object.freeze({
          ordinal: span.chunkStart + decodeIndex,
          renditionIndex: span.renditionIndex,
          renditionId: span.renditionId,
          unitIndex: span.unitIndex,
          unitId: span.unitId,
          decodeIndex,
          randomAccessRequired: decodeIndex === 0
        });
      }
    }
  }

  return Object.freeze({
    renditionCount: renditions.length,
    unitCount: units.length,
    totalFrameCount,
    recordCount: ordinal,
    spans: frozenSpans,
    unitSpans: Object.freeze(unitSpans.map((value) => Object.freeze(value))),
    records,
    recordAt
  });
}

/** Assert that every unit carries one canonical span per authored rendition. */
export function validateCanonicalChunkSpans(
  plan: Readonly<CanonicalChunkPlan>,
  units: readonly Pick<Unit, "chunks">[],
  code: Extract<FormatErrorCode, "MANIFEST_INVALID" | "INDEX_INVALID"> =
    "MANIFEST_INVALID"
): void {
  for (const expected of plan.spans) {
    const descriptor = units[expected.unitIndex]?.chunks[expected.renditionIndex];
    if (
      descriptor === undefined ||
      descriptor.rendition !== expected.renditionId ||
      descriptor.chunkStart !== expected.chunkStart ||
      descriptor.chunkCount !== expected.chunkCount ||
      descriptor.frameCount !== expected.frameCount
    ) {
      throw new FormatError(code, `unit ${expected.unitId} chunk span is not canonical`, {
        path: `units[${String(expected.unitIndex)}].chunks[${String(expected.renditionIndex)}]`
      });
    }
  }
  for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
    if (units[unitIndex]?.chunks.length !== plan.renditionCount) {
      throw new FormatError(code, "unit must declare exactly one chunk span per rendition", {
        path: `units[${String(unitIndex)}].chunks`
      });
    }
  }
}

function positiveSafe(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function requireMaximum(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new FormatError("INTEGER_UNSAFE", `${label} must be a nonnegative safe integer`);
  }
}

function manifestInvalid(message: string, path?: string): never {
  throw new FormatError(
    "MANIFEST_INVALID",
    message,
    path === undefined ? undefined : { path }
  );
}

function budget(message: string): never {
  throw new FormatError("BUDGET_EXCEEDED", message);
}
