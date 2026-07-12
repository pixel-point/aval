import { CompilerError } from "../diagnostics.js";
import { crc32 } from "./crc32.js";

const PNG_SIGNATURE = Uint8Array.of(
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
);

export interface RgbaPngInput {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

/** Emit the deterministic restricted RGBA PNG profile consumed by M6. */
export function encodeCanonicalRgbaPng(input: RgbaPngInput): Uint8Array {
  const { width, height, rgba } = input;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 512 ||
    height > 512
  ) {
    throw new CompilerError(
      "SOURCE_LIMIT",
      "Static PNG dimensions must be positive and at most 512×512"
    );
  }
  const rowBytes = width * 4;
  const expected = rowBytes * height;
  if (!(rgba instanceof Uint8Array) || rgba.byteLength !== expected) {
    throw new CompilerError(
      "INPUT_INVALID",
      `RGBA payload must contain exactly ${String(expected)} bytes`
    );
  }

  const filtered = new Uint8Array(height * (rowBytes + 1));
  for (let row = 0; row < height; row += 1) {
    const target = row * (rowBytes + 1);
    filtered[target] = 0;
    filtered.set(
      rgba.subarray(row * rowBytes, (row + 1) * rowBytes),
      target + 1
    );
  }
  const ihdr = new Uint8Array(13);
  writeUint32BE(ihdr, 0, width);
  writeUint32BE(ihdr, 4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const compressed = storedZlib(filtered);
  return concatenate([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("sRGB", Uint8Array.of(0)),
    chunk("IDAT", compressed),
    chunk("IEND", new Uint8Array())
  ]);
}

/** RFC 1950 zlib wrapper containing only deterministic RFC 1951 stored blocks. */
function storedZlib(bytes: Uint8Array): Uint8Array {
  const blockCount = Math.max(1, Math.ceil(bytes.byteLength / 65_535));
  const outputLength = 2 + blockCount * 5 + bytes.byteLength + 4;
  if (!Number.isSafeInteger(outputLength)) {
    throw new CompilerError("SOURCE_LIMIT", "Static PNG payload is too large");
  }
  const output = new Uint8Array(outputLength);
  // CM=deflate, CINFO=32 KiB; FCHECK chosen for fastest/no-compression policy.
  output.set([0x78, 0x01], 0);
  let sourceOffset = 0;
  let targetOffset = 2;
  for (let block = 0; block < blockCount; block += 1) {
    const length = Math.min(65_535, bytes.byteLength - sourceOffset);
    const final = block === blockCount - 1;
    output[targetOffset] = final ? 0x01 : 0x00;
    output[targetOffset + 1] = length & 0xff;
    output[targetOffset + 2] = (length >>> 8) & 0xff;
    const complement = (~length) & 0xffff;
    output[targetOffset + 3] = complement & 0xff;
    output[targetOffset + 4] = (complement >>> 8) & 0xff;
    targetOffset += 5;
    output.set(bytes.subarray(sourceOffset, sourceOffset + length), targetOffset);
    sourceOffset += length;
    targetOffset += length;
  }
  writeUint32BE(output, targetOffset, adler32(bytes));
  return output;
}

function adler32(bytes: Uint8Array): number {
  const modulus = 65_521;
  let a = 1;
  let b = 0;
  // 5,552 bytes is the standard overflow-safe batching interval.
  for (let offset = 0; offset < bytes.byteLength; offset += 5_552) {
    const end = Math.min(bytes.byteLength, offset + 5_552);
    for (let index = offset; index < end; index += 1) {
      a += bytes[index]!;
      b += a;
    }
    a %= modulus;
    b %= modulus;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  if (typeBytes.byteLength !== 4) {
    throw new CompilerError("INPUT_INVALID", "PNG chunk type must be four bytes");
  }
  const result = new Uint8Array(12 + data.byteLength);
  writeUint32BE(result, 0, data.byteLength);
  result.set(typeBytes, 4);
  result.set(data, 8);
  writeUint32BE(
    result,
    8 + data.byteLength,
    crc32(result.subarray(4, 8 + data.byteLength))
  );
  return result;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}
