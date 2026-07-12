export interface RuntimeInclusiveByteRange {
  readonly start: number;
  readonly end: number;
}

export interface ParsedContentRange extends RuntimeInclusiveByteRange {
  readonly total: number;
  readonly length: number;
}

/** Parse exactly one concrete `bytes S-E/T` header value. */
export function parseCanonicalContentRange(
  value: string
): Readonly<ParsedContentRange> {
  if (typeof value !== "string") {
    throw new RangeError("Content-Range must be a string");
  }
  const match = /^[\t ]*bytes ([0-9]+)-([0-9]+)\/([0-9]+)[\t ]*$/i.exec(
    value
  );
  if (match === null) {
    throw new RangeError("Content-Range is not canonical");
  }

  const start = parseCanonicalDecimal(match[1]!, "Content-Range start");
  const end = parseCanonicalDecimal(match[2]!, "Content-Range end");
  const total = parseCanonicalDecimal(match[3]!, "Content-Range total");
  if (end < start) {
    throw new RangeError("Content-Range end precedes its start");
  }
  if (total <= end) {
    throw new RangeError("Content-Range total does not contain its end");
  }
  const length = end - start + 1;
  if (!Number.isSafeInteger(length) || length < 1) {
    throw new RangeError("Content-Range length is outside the safe range");
  }

  return Object.freeze({ start, end, total, length });
}

/** Validate that a partial response returned exactly the requested interval. */
export function validateExactContentRange(
  value: string,
  requested: Readonly<RuntimeInclusiveByteRange>,
  knownTotal?: number
): Readonly<ParsedContentRange> {
  const exactRequest = readInclusiveRange(requested);
  if (knownTotal !== undefined) {
    validatePositiveSafeInteger(knownTotal, "known Content-Range total");
  }
  const parsed = parseCanonicalContentRange(value);
  if (
    parsed.start !== exactRequest.start ||
    parsed.end !== exactRequest.end ||
    (knownTotal !== undefined && parsed.total !== knownTotal)
  ) {
    throw new RangeError("Content-Range does not match the requested range");
  }
  return parsed;
}

/** Build the one canonical Range request value used by the loader. */
export function formatInclusiveByteRange(
  range: Readonly<RuntimeInclusiveByteRange>
): string {
  const exact = readInclusiveRange(range);
  return `bytes=${String(exact.start)}-${String(exact.end)}`;
}

function readInclusiveRange(
  range: Readonly<RuntimeInclusiveByteRange>
): Readonly<RuntimeInclusiveByteRange> {
  let start: unknown;
  let end: unknown;
  try {
    start = range.start;
    end = range.end;
  } catch {
    throw new RangeError("requested byte range is unavailable");
  }
  validateNonNegativeSafeInteger(start, "requested byte range start");
  validateNonNegativeSafeInteger(end, "requested byte range end");
  if (end < start) {
    throw new RangeError("requested byte range end precedes its start");
  }
  const length = end - start + 1;
  if (!Number.isSafeInteger(length) || length < 1) {
    throw new RangeError("requested byte range length is outside the safe range");
  }
  return Object.freeze({ start, end });
}

function parseCanonicalDecimal(value: string, label: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new RangeError(`${label} is not canonical`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== value) {
    throw new RangeError(`${label} is outside the safe range`);
  }
  return parsed;
}

function validateNonNegativeSafeInteger(
  value: unknown,
  label: string
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function validatePositiveSafeInteger(
  value: unknown,
  label: string
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}
