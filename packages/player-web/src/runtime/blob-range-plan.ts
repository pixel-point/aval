import type {
  ByteRange,
  ParsedFrontIndex,
  StaticBlobRange,
  UnitBlobRange
} from "@rendered-motion/format";

export const DEFAULT_BLOB_RANGE_TARGET_BYTES = 4 * 1024 * 1024;

export type RuntimeBlobSelection =
  | {
      readonly kind: "unit";
      readonly rendition: string;
      readonly unit: string;
    }
  | {
      readonly kind: "static";
      readonly staticFrame: string;
    };

export type PlannedRuntimeBlob =
  | PlannedRuntimeUnitBlob
  | PlannedRuntimeStaticBlob;

interface PlannedRuntimeBlobBase {
  readonly ordinal: number;
  readonly sha256: string;
  readonly paddingRange: Readonly<ByteRange>;
  readonly blobRange: Readonly<ByteRange>;
  readonly storageRange: Readonly<ByteRange>;
}

export interface PlannedRuntimeUnitBlob extends PlannedRuntimeBlobBase {
  readonly kind: "unit";
  readonly rendition: string;
  readonly unit: string;
  readonly sampleStart: number;
  readonly sampleCount: number;
}

export interface PlannedRuntimeStaticBlob extends PlannedRuntimeBlobBase {
  readonly kind: "static";
  readonly staticFrame: string;
}

export interface PlannedBlobTransportRange {
  readonly ordinal: number;
  readonly offset: number;
  readonly length: number;
  readonly blobOrdinals: readonly number[];
}

export interface RuntimeBlobRangePlan {
  readonly blobs: readonly PlannedRuntimeBlob[];
  readonly requests: readonly Readonly<PlannedBlobTransportRange>[];
  readonly totalStorageBytes: number;
}

interface CanonicalBlob {
  readonly source: UnitBlobRange | StaticBlobRange;
  readonly kind: "unit" | "static";
  readonly paddingRange: Readonly<ByteRange>;
  readonly blobRange: Readonly<ByteRange>;
  readonly storageRange: Readonly<ByteRange>;
}

/**
 * Plan range transport from canonical format geometry without changing digest
 * boundaries. Each selected blob owns only its immediately preceding padding.
 */
export function planBlobStorageRanges(input: Readonly<{
  readonly frontIndex: ParsedFrontIndex;
  readonly requested: readonly RuntimeBlobSelection[];
  readonly targetRequestBytes?: number;
}>): Readonly<RuntimeBlobRangePlan> {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("blob range plan input must be an object");
  }
  const target = input.targetRequestBytes ?? DEFAULT_BLOB_RANGE_TARGET_BYTES;
  requirePositiveSafeInteger(target, "blob range request target");
  if (!Array.isArray(input.requested)) {
    throw new TypeError("blob range selections must be an array");
  }

  const canonical = buildCanonicalBlobs(input.frontIndex);
  const selected = selectCanonicalBlobs(canonical, input.requested);
  const blobs = Object.freeze(selected.map((entry, ordinal) =>
    freezePlannedBlob(entry, ordinal)
  ));
  const requests = planTransportRanges(blobs, target);
  const totalStorageBytes = requests.reduce(
    (total, request) => checkedAdd(total, request.length, "planned storage bytes"),
    0
  );
  return Object.freeze({ blobs, requests, totalStorageBytes });
}

function buildCanonicalBlobs(frontIndex: ParsedFrontIndex): readonly CanonicalBlob[] {
  if (typeof frontIndex !== "object" || frontIndex === null) {
    throw new TypeError("front index must be an object");
  }
  const declaredFileLength = frontIndex.header?.declaredFileLength;
  requirePositiveSafeInteger(declaredFileLength, "declared file length");
  const frontIndexRange = frontIndex.frontIndexRange;
  requireRange(frontIndexRange, declaredFileLength, "front index");
  if (frontIndexRange.offset !== 0) {
    throw new RangeError("front index must start at file offset zero");
  }
  const frontIndexEnd = checkedAdd(
    frontIndexRange.offset,
    frontIndexRange.length,
    "front index end"
  );
  if (frontIndexEnd > declaredFileLength) {
    throw new RangeError("front index exceeds the declared file");
  }
  if (!Array.isArray(frontIndex.unitBlobs) || !Array.isArray(frontIndex.staticBlobs)) {
    throw new TypeError("front index blob ranges must be arrays");
  }

  const sources: Array<Readonly<{
    source: UnitBlobRange | StaticBlobRange;
    kind: "unit" | "static";
  }>> = [
    ...frontIndex.unitBlobs.map((source) => ({ source, kind: "unit" as const })),
    ...frontIndex.staticBlobs.map((source) => ({ source, kind: "static" as const }))
  ];
  sources.sort((left, right) => left.source.offset - right.source.offset);

  const result: CanonicalBlob[] = [];
  let cursor = frontIndexEnd;
  for (const entry of sources) {
    validateSourceIdentity(entry.source, entry.kind);
    requireRange(entry.source, declaredFileLength, `${entry.kind} blob`);
    if (entry.source.length === 0) {
      throw new RangeError("canonical blob length must be positive");
    }
    if (entry.source.offset < cursor) {
      throw new RangeError("canonical blob ranges overlap or precede metadata");
    }
    const end = checkedAdd(entry.source.offset, entry.source.length, "blob end");
    const paddingRange = freezeRange(cursor, entry.source.offset - cursor);
    const blobRange = freezeRange(entry.source.offset, entry.source.length);
    const storageRange = freezeRange(cursor, end - cursor);
    result.push(Object.freeze({
      source: entry.source,
      kind: entry.kind,
      paddingRange,
      blobRange,
      storageRange
    }));
    cursor = end;
  }
  if (cursor !== declaredFileLength) {
    throw new RangeError("canonical blobs do not end at the declared file length");
  }
  assertUniqueCanonicalIdentities(result);
  return Object.freeze(result);
}

function selectCanonicalBlobs(
  canonical: readonly CanonicalBlob[],
  requested: readonly RuntimeBlobSelection[]
): readonly CanonicalBlob[] {
  const selected: CanonicalBlob[] = [];
  for (let index = 0; index < requested.length; index += 1) {
    const selection = requested[index];
    validateSelection(selection);
    for (let previous = 0; previous < index; previous += 1) {
      if (sameSelection(selection, requested[previous]!)) {
        throw new RangeError("blob range selections must not contain duplicates");
      }
    }
    const match = canonical.find((entry) => matches(entry, selection));
    if (match === undefined) {
      throw new RangeError("requested blob is not present in the front index");
    }
    selected.push(match);
  }
  selected.sort((left, right) => left.blobRange.offset - right.blobRange.offset);
  return Object.freeze(selected);
}

function planTransportRanges(
  blobs: readonly PlannedRuntimeBlob[],
  target: number
): readonly Readonly<PlannedBlobTransportRange>[] {
  const requests: PlannedBlobTransportRange[] = [];
  let blobIndex = 0;
  while (blobIndex < blobs.length) {
    const first = blobs[blobIndex]!;
    const groupStart = first.storageRange.offset;
    let groupEnd = rangeEnd(first.storageRange);
    let nextIndex = blobIndex + 1;
    while (
      nextIndex < blobs.length &&
      blobs[nextIndex]!.storageRange.offset === groupEnd
    ) {
      groupEnd = rangeEnd(blobs[nextIndex]!.storageRange);
      nextIndex += 1;
    }

    for (let offset = groupStart; offset < groupEnd;) {
      const length = Math.min(target, groupEnd - offset);
      const end = offset + length;
      const touched = blobs
        .filter((blob) => rangesIntersect(
          offset,
          end,
          blob.storageRange.offset,
          rangeEnd(blob.storageRange)
        ))
        .map((blob) => blob.ordinal);
      requests.push(Object.freeze({
        ordinal: requests.length,
        offset,
        length,
        blobOrdinals: Object.freeze(touched)
      }));
      offset = end;
    }
    blobIndex = nextIndex;
  }
  return Object.freeze(requests);
}

function freezePlannedBlob(
  entry: CanonicalBlob,
  ordinal: number
): PlannedRuntimeBlob {
  if (entry.kind === "unit") {
    const source = entry.source as UnitBlobRange;
    return Object.freeze({
      ordinal,
      kind: "unit",
      rendition: source.rendition,
      unit: source.unit,
      sampleStart: source.sampleStart,
      sampleCount: source.sampleCount,
      sha256: source.sha256,
      paddingRange: entry.paddingRange,
      blobRange: entry.blobRange,
      storageRange: entry.storageRange
    });
  }
  const source = entry.source as StaticBlobRange;
  return Object.freeze({
    ordinal,
    kind: "static",
    staticFrame: source.staticFrame,
    sha256: source.sha256,
    paddingRange: entry.paddingRange,
    blobRange: entry.blobRange,
    storageRange: entry.storageRange
  });
}

function validateSourceIdentity(
  source: UnitBlobRange | StaticBlobRange,
  kind: "unit" | "static"
): void {
  requireDigest(source.sha256);
  if (kind === "unit") {
    const unit = source as UnitBlobRange;
    requireNonEmptyString(unit.rendition, "rendition id");
    requireNonEmptyString(unit.unit, "unit id");
    requireNonNegativeSafeInteger(unit.sampleStart, "sample start");
    requirePositiveSafeInteger(unit.sampleCount, "sample count");
  } else {
    requireNonEmptyString((source as StaticBlobRange).staticFrame, "static frame id");
  }
}

function assertUniqueCanonicalIdentities(blobs: readonly CanonicalBlob[]): void {
  for (let index = 0; index < blobs.length; index += 1) {
    for (let other = index + 1; other < blobs.length; other += 1) {
      const left = canonicalSelection(blobs[index]!);
      const right = canonicalSelection(blobs[other]!);
      if (sameSelection(left, right)) {
        throw new RangeError("canonical blob identity is duplicated");
      }
    }
  }
}

function canonicalSelection(blob: CanonicalBlob): RuntimeBlobSelection {
  return blob.kind === "unit"
    ? {
        kind: "unit",
        rendition: (blob.source as UnitBlobRange).rendition,
        unit: (blob.source as UnitBlobRange).unit
      }
    : {
        kind: "static",
        staticFrame: (blob.source as StaticBlobRange).staticFrame
      };
}

function validateSelection(
  selection: RuntimeBlobSelection | undefined
): asserts selection is RuntimeBlobSelection {
  if (typeof selection !== "object" || selection === null) {
    throw new TypeError("blob selection must be an object");
  }
  if (selection.kind === "unit") {
    requireNonEmptyString(selection.rendition, "requested rendition id");
    requireNonEmptyString(selection.unit, "requested unit id");
    return;
  }
  if (selection.kind === "static") {
    requireNonEmptyString(selection.staticFrame, "requested static frame id");
    return;
  }
  throw new TypeError("blob selection kind is invalid");
}

function sameSelection(
  left: RuntimeBlobSelection,
  right: RuntimeBlobSelection
): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "unit" && right.kind === "unit"
    ? left.rendition === right.rendition && left.unit === right.unit
    : left.kind === "static" && right.kind === "static" &&
      left.staticFrame === right.staticFrame;
}

function matches(blob: CanonicalBlob, selection: RuntimeBlobSelection): boolean {
  return sameSelection(canonicalSelection(blob), selection);
}

function requireRange(range: ByteRange, limit: number, label: string): void {
  if (typeof range !== "object" || range === null) {
    throw new TypeError(`${label} range must be an object`);
  }
  requireNonNegativeSafeInteger(range.offset, `${label} offset`);
  requireNonNegativeSafeInteger(range.length, `${label} length`);
  if (checkedAdd(range.offset, range.length, `${label} end`) > limit) {
    throw new RangeError(`${label} exceeds the declared file`);
  }
}

function requireDigest(value: string): void {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError("blob digest must be lowercase SHA-256 hexadecimal");
  }
}

function requireNonEmptyString(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function requirePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function requireNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${label} exceeds the safe-integer range`);
  }
  return result;
}

function freezeRange(offset: number, length: number): Readonly<ByteRange> {
  return Object.freeze({ offset, length });
}

function rangeEnd(range: Readonly<ByteRange>): number {
  return checkedAdd(range.offset, range.length, "range end");
}

function rangesIntersect(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number
): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}
