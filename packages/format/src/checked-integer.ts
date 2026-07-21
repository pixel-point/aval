import { FormatError, type FormatErrorCode, isFormatError } from "./errors.js";

const UINT8_MAX = 0xff;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffff_ffff;
const UINT64_MAX = (1n << 64n) - 1n;

function integerError(label: string): FormatError {
  return new FormatError(
    "INTEGER_UNSAFE",
    `${label} must be a nonnegative safe integer`
  );
}

export function checkedNonNegativeInteger(
  value: unknown,
  label = "value"
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw integerError(label);
  }
  return value;
}

function checkedLimit(limit: number): number {
  return checkedNonNegativeInteger(limit, "limit");
}

function enforceLimit(value: number, limit: number, label: string): number {
  if (value > checkedLimit(limit)) {
    throw new FormatError(
      "BUDGET_EXCEEDED",
      `${label} exceeds the active limit of ${limit}`
    );
  }
  return value;
}

export function checkedAdd(
  left: number,
  right: number,
  limit = Number.MAX_SAFE_INTEGER,
  label = "sum"
): number {
  const safeLeft = checkedNonNegativeInteger(left, `${label} left operand`);
  const safeRight = checkedNonNegativeInteger(right, `${label} right operand`);
  if (safeLeft > Number.MAX_SAFE_INTEGER - safeRight) {
    throw new FormatError("INTEGER_UNSAFE", `${label} exceeds safe integer range`);
  }
  return enforceLimit(safeLeft + safeRight, limit, label);
}

export function checkedMultiply(
  left: number,
  right: number,
  limit = Number.MAX_SAFE_INTEGER,
  label = "product"
): number {
  const safeLeft = checkedNonNegativeInteger(left, `${label} left operand`);
  const safeRight = checkedNonNegativeInteger(right, `${label} right operand`);
  if (
    safeLeft !== 0 &&
    safeRight > Math.floor(Number.MAX_SAFE_INTEGER / safeLeft)
  ) {
    throw new FormatError("INTEGER_UNSAFE", `${label} exceeds safe integer range`);
  }
  return enforceLimit(safeLeft * safeRight, limit, label);
}

export function align8(
  value: number,
  limit = Number.MAX_SAFE_INTEGER,
  label = "aligned value"
): number {
  const safeValue = checkedNonNegativeInteger(value, label);
  const remainder = safeValue % 8;
  return remainder === 0
    ? enforceLimit(safeValue, limit, label)
    : checkedAdd(safeValue, 8 - remainder, limit, label);
}

export function checkedRangeEnd(
  offset: number,
  length: number,
  limit = Number.MAX_SAFE_INTEGER,
  label = "range end"
): number {
  return checkedAdd(offset, length, limit, label);
}

export function rangeContains(
  outerOffset: number,
  outerLength: number,
  innerOffset: number,
  innerLength: number,
  limit = Number.MAX_SAFE_INTEGER
): boolean {
  const outerEnd = checkedRangeEnd(
    outerOffset,
    outerLength,
    limit,
    "outer range end"
  );
  const innerEnd = checkedRangeEnd(
    innerOffset,
    innerLength,
    limit,
    "inner range end"
  );
  return innerOffset >= outerOffset && innerEnd <= outerEnd;
}

export function bigintToSafeNumber(
  value: bigint,
  limit = Number.MAX_SAFE_INTEGER,
  label = "integer"
): number {
  if (typeof value !== "bigint" || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new FormatError("INTEGER_UNSAFE", `${label} exceeds safe integer range`);
  }
  const numberValue = Number(value);
  return enforceLimit(numberValue, limit, label);
}

function ensureBytes(
  bytes: Uint8Array,
  code: FormatErrorCode,
  label: string
): Uint8Array {
  if (!(bytes instanceof Uint8Array)) {
    throw new FormatError(code, `${label} must be a Uint8Array`);
  }
  return bytes;
}

export function requireByteRange(
  bytes: Uint8Array,
  offset: number,
  length: number,
  code: FormatErrorCode = "INPUT_INVALID",
  label = "byte range"
): number {
  try {
    const view = ensureBytes(bytes, code, label);
    const end = checkedRangeEnd(offset, length, Number.MAX_SAFE_INTEGER, label);
    if (end > view.byteLength) {
      throw new FormatError(code, `${label} is truncated`, {
        offset: Math.min(
          Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
          view.byteLength
        )
      });
    }
    return end;
  } catch (error) {
    if (isFormatError(error) && error.code === code) {
      throw error;
    }
    if (isFormatError(error)) {
      throw new FormatError(code, `${label} is invalid`, {
        offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0
      });
    }
    throw new FormatError(code, `${label} could not be read`);
  }
}

function checkedUnsigned(
  value: number,
  maximum: number,
  code: FormatErrorCode,
  label: string,
  offset: number
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    throw new FormatError(code, `${label} is outside its unsigned range`, {
      offset
    });
  }
  return value;
}

export function readUint16LE(
  bytes: Uint8Array,
  offset: number,
  code: FormatErrorCode = "INPUT_INVALID",
  label = "uint16"
): number {
  requireByteRange(bytes, offset, 2, code, label);
  return (bytes[offset] as number) + (bytes[offset + 1] as number) * 0x100;
}

export function readUint32LE(
  bytes: Uint8Array,
  offset: number,
  code: FormatErrorCode = "INPUT_INVALID",
  label = "uint32"
): number {
  requireByteRange(bytes, offset, 4, code, label);
  return (
    (bytes[offset] as number) +
    (bytes[offset + 1] as number) * 0x100 +
    (bytes[offset + 2] as number) * 0x1_0000 +
    (bytes[offset + 3] as number) * 0x100_0000
  );
}

export function readUint64LEBigInt(
  bytes: Uint8Array,
  offset: number,
  code: FormatErrorCode = "INPUT_INVALID",
  label = "uint64"
): bigint {
  requireByteRange(bytes, offset, 8, code, label);
  let result = 0n;
  for (let index = 7; index >= 0; index -= 1) {
    result = (result << 8n) | BigInt(bytes[offset + index] as number);
  }
  return result;
}

export function readUint64LE(
  bytes: Uint8Array,
  offset: number,
  limit = Number.MAX_SAFE_INTEGER,
  code: FormatErrorCode = "INPUT_INVALID",
  label = "uint64"
): number {
  const value = readUint64LEBigInt(bytes, offset, code, label);
  try {
    return bigintToSafeNumber(value, limit, label);
  } catch (error) {
    if (isFormatError(error)) {
      throw new FormatError(error.code, error.message, { offset });
    }
    throw new FormatError(code, `${label} could not be converted`, { offset });
  }
}

export function writeUint16LE(
  bytes: Uint8Array,
  offset: number,
  value: number,
  code: FormatErrorCode = "INPUT_INVALID",
  label = "uint16"
): void {
  requireByteRange(bytes, offset, 2, code, label);
  const checked = checkedUnsigned(value, UINT16_MAX, code, label, offset);
  bytes[offset] = checked & UINT8_MAX;
  bytes[offset + 1] = Math.floor(checked / 0x100) & UINT8_MAX;
}

export function writeUint32LE(
  bytes: Uint8Array,
  offset: number,
  value: number,
  code: FormatErrorCode = "INPUT_INVALID",
  label = "uint32"
): void {
  requireByteRange(bytes, offset, 4, code, label);
  const checked = checkedUnsigned(value, UINT32_MAX, code, label, offset);
  bytes[offset] = checked & UINT8_MAX;
  bytes[offset + 1] = Math.floor(checked / 0x100) & UINT8_MAX;
  bytes[offset + 2] = Math.floor(checked / 0x1_0000) & UINT8_MAX;
  bytes[offset + 3] = Math.floor(checked / 0x100_0000) & UINT8_MAX;
}

export function writeUint64LE(
  bytes: Uint8Array,
  offset: number,
  value: number | bigint,
  code: FormatErrorCode = "INPUT_INVALID",
  label = "uint64"
): void {
  requireByteRange(bytes, offset, 8, code, label);
  let checked: bigint;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new FormatError(code, `${label} must be a nonnegative safe integer`, {
        offset
      });
    }
    checked = BigInt(value);
  } else if (typeof value === "bigint" && value >= 0n && value <= UINT64_MAX) {
    checked = value;
  } else {
    throw new FormatError(code, `${label} is outside the uint64 range`, {
      offset
    });
  }

  for (let index = 0; index < 8; index += 1) {
    bytes[offset + index] = Number(checked & 0xffn);
    checked >>= 8n;
  }
}
