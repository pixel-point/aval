import { checkedAdd, checkedMultiply } from "../checked-integer.js";
import { FormatError, isFormatError } from "../errors.js";

const BYTES_PER_PIXEL = 4;
const UINT32_MAX = 0xffff_ffff;
const VALID_LAYOUTS = new WeakSet<object>();

export interface PngRgbaLayout {
  readonly width: number;
  readonly height: number;
  readonly rowBytes: number;
  readonly filteredRowBytes: number;
  readonly filteredBytes: number;
  readonly rgbaBytes: number;
}

export interface PngUnfilterInput {
  readonly filtered: Uint8Array;
  readonly layout: Readonly<PngRgbaLayout>;
}

/** Derive all noninterlaced 8-bit RGBA storage using checked arithmetic once. */
export function derivePngRgbaLayout(
  widthValue: unknown,
  heightValue: unknown
): Readonly<PngRgbaLayout> {
  const width = dimension(widthValue, "PNG width");
  const height = dimension(heightValue, "PNG height");
  const rowBytes = checkedMultiply(
    width,
    BYTES_PER_PIXEL,
    Number.MAX_SAFE_INTEGER,
    "PNG row bytes"
  );
  const filteredRowBytes = checkedAdd(
    rowBytes,
    1,
    Number.MAX_SAFE_INTEGER,
    "PNG filtered row bytes"
  );
  const filteredBytes = checkedMultiply(
    height,
    filteredRowBytes,
    Number.MAX_SAFE_INTEGER,
    "PNG filtered bytes"
  );
  const rgbaBytes = checkedMultiply(
    height,
    rowBytes,
    Number.MAX_SAFE_INTEGER,
    "PNG RGBA bytes"
  );
  const layout = Object.freeze({
    width,
    height,
    rowBytes,
    filteredRowBytes,
    filteredBytes,
    rgbaBytes
  });
  VALID_LAYOUTS.add(layout);
  return layout;
}

/** Reconstruct exact noninterlaced 8-bit RGBA scanlines for filters 0-4. */
export function unfilterPngRgba(input: PngUnfilterInput): Uint8Array {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      fail("PNG unfilter input must be an object");
    }
    const { layout } = input;
    if (
      typeof layout !== "object" ||
      layout === null ||
      !VALID_LAYOUTS.has(layout)
    ) {
      fail("PNG RGBA layout must be an object");
    }
    const {
      height,
      rowBytes,
      filteredRowBytes,
      filteredBytes,
      rgbaBytes
    } = layout;
    if (!(input.filtered instanceof Uint8Array)) {
      fail("filtered PNG bytes must be a Uint8Array");
    }
    if (input.filtered.byteLength !== filteredBytes) {
      fail("filtered PNG length does not match its dimensions");
    }
    let rgba: Uint8Array;
    try {
      rgba = new Uint8Array(rgbaBytes);
    } catch {
      throw new FormatError(
        "PNG_SCANLINE_INVALID",
        `PNG RGBA allocation failed for ${String(rgbaBytes)} bytes`
      );
    }
    for (let row = 0; row < height; row += 1) {
      const sourceRow = row * filteredRowBytes;
      const targetRow = row * rowBytes;
      const filter = input.filtered[sourceRow]!;
      if (filter > 4) {
        fail("PNG scanline filter must be from 0 through 4", sourceRow);
      }
      for (let column = 0; column < rowBytes; column += 1) {
        const encoded = input.filtered[sourceRow + 1 + column]!;
        const left = column >= BYTES_PER_PIXEL
          ? rgba[targetRow + column - BYTES_PER_PIXEL]!
          : 0;
        const up = row > 0 ? rgba[targetRow - rowBytes + column]! : 0;
        const upperLeft = row > 0 && column >= BYTES_PER_PIXEL
          ? rgba[targetRow - rowBytes + column - BYTES_PER_PIXEL]!
          : 0;
        const predictor = filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : paeth(left, up, upperLeft);
        rgba[targetRow + column] = (encoded + predictor) & 0xff;
      }
    }
    return rgba;
  } catch (error) {
    if (isFormatError(error)) throw error;
    throw new FormatError(
      "PNG_SCANLINE_INVALID",
      "PNG scanlines could not be reconstructed"
    );
  }
}

function dimension(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > UINT32_MAX
  ) {
    fail(`${label} must be from 1 through ${String(UINT32_MAX)}`);
  }
  return value;
}

function paeth(left: number, up: number, upperLeft: number): number {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

function fail(message: string, offset?: number): never {
  throw new FormatError(
    "PNG_SCANLINE_INVALID",
    message,
    offset === undefined ? undefined : { offset }
  );
}
