import { CompilerError } from "../diagnostics.js";

const IVF_HEADER_BYTES = 32;
const IVF_FRAME_HEADER_BYTES = 12;
const IVF_SIGNATURE = "DKIF";
const IVF_STREAMING_FRAME_COUNT = 0xffff_ffff;
const SUPPORTED_FOURCC = new Set(["VP90", "AV01"]);

export type IvfCodec = "vp9" | "av1";

export interface IvfFrame {
  /** IVF transport timestamp. Record order remains decoder submission order. */
  readonly timestamp: number;
  /** Owned payload bytes; no view into the caller's transport buffer escapes. */
  readonly bytes: Uint8Array;
}

export interface IvfStream {
  readonly codec: IvfCodec;
  readonly width: number;
  readonly height: number;
  readonly timeBase: {
    readonly numerator: number;
    readonly denominator: number;
  };
  readonly frames: readonly IvfFrame[];
}

export interface SerializeIvfInput {
  readonly codec: IvfCodec;
  readonly width: number;
  readonly height: number;
  readonly timeBase: {
    readonly numerator: number;
    readonly denominator: number;
  };
  readonly frames: readonly Readonly<IvfFrame>[];
}

export interface ParseIvfOptions {
  readonly expectedCodec: IvfCodec;
  readonly expectedWidth?: number;
  readonly expectedHeight?: number;
  readonly expectedFrameCount?: number;
  readonly maximumFrames?: number;
  readonly maximumFrameBytes?: number;
}

/** Wrap unchanged elementary payloads in deterministic seekable IVF transport. */
export function serializeIvf(input: Readonly<SerializeIvfInput>): Uint8Array {
  requireIvf(input?.codec === "vp9" || input?.codec === "av1", "IVF codec is unsupported");
  requireIvf(
    Number.isSafeInteger(input.width) && input.width > 0 && input.width <= 0xffff,
    "IVF width must fit uint16"
  );
  requireIvf(
    Number.isSafeInteger(input.height) && input.height > 0 && input.height <= 0xffff,
    "IVF height must fit uint16"
  );
  requireIvf(
    Number.isSafeInteger(input.timeBase?.numerator) &&
      input.timeBase.numerator > 0 &&
      input.timeBase.numerator <= 0xffff_ffff,
    "IVF time-base numerator must fit uint32"
  );
  requireIvf(
    Number.isSafeInteger(input.timeBase?.denominator) &&
      input.timeBase.denominator > 0 &&
      input.timeBase.denominator <= 0xffff_ffff,
    "IVF time-base denominator must fit uint32"
  );
  requireIvf(
    Array.isArray(input.frames) &&
      input.frames.length > 0 &&
      input.frames.length <= 0xffff_ffff,
    "IVF frame count must fit uint32"
  );
  let byteLength = IVF_HEADER_BYTES;
  for (const frame of input.frames) {
    requireIvf(
      Number.isSafeInteger(frame?.timestamp) && frame.timestamp >= 0,
      "IVF frame timestamp must be a nonnegative safe integer"
    );
    requireIvf(
      frame?.bytes instanceof Uint8Array &&
        frame.bytes.byteLength > 0 &&
        frame.bytes.byteLength <= 0xffff_ffff,
      "IVF frame payload length must fit uint32"
    );
    byteLength = checkedIvfAdd(byteLength, IVF_FRAME_HEADER_BYTES);
    byteLength = checkedIvfAdd(byteLength, frame.bytes.byteLength);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(byteLength);
  } catch (cause) {
    throw new CompilerError("OUTPUT_LIMIT", "IVF transport could not be allocated", {
      cause
    });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  writeAscii(bytes, 0, IVF_SIGNATURE);
  view.setUint16(4, 0, true);
  view.setUint16(6, IVF_HEADER_BYTES, true);
  writeAscii(bytes, 8, input.codec === "vp9" ? "VP90" : "AV01");
  view.setUint16(12, input.width, true);
  view.setUint16(14, input.height, true);
  view.setUint32(16, input.timeBase.denominator, true);
  view.setUint32(20, input.timeBase.numerator, true);
  view.setUint32(24, input.frames.length, true);
  view.setUint32(28, 0, true);
  let cursor = IVF_HEADER_BYTES;
  for (const frame of input.frames) {
    view.setUint32(cursor, frame.bytes.byteLength, true);
    view.setBigUint64(cursor + 4, BigInt(frame.timestamp), true);
    cursor += IVF_FRAME_HEADER_BYTES;
    bytes.set(frame.bytes, cursor);
    cursor += frame.bytes.byteLength;
  }
  return bytes;
}

/** Parse FFmpeg's IVF transport and detach the elementary VP9/AV1 payloads. */
export function parseIvf(
  input: Uint8Array,
  options: Readonly<ParseIvfOptions>
): Readonly<IvfStream> {
  requireIvf(input instanceof Uint8Array, "IVF transport must be bytes");
  requireIvf(input.byteLength >= IVF_HEADER_BYTES, "IVF header is truncated");
  requireIvf(
    options?.expectedCodec === "vp9" || options?.expectedCodec === "av1",
    "IVF expected codec must be vp9 or av1"
  );

  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  requireIvf(ascii(input, 0, 4) === IVF_SIGNATURE, "IVF signature must be DKIF");
  requireIvf(view.getUint16(4, true) === 0, "IVF version must be zero");
  requireIvf(
    view.getUint16(6, true) === IVF_HEADER_BYTES,
    "IVF header length must be 32"
  );

  const fourcc = ascii(input, 8, 4);
  requireIvf(SUPPORTED_FOURCC.has(fourcc), "IVF fourcc is unsupported");
  const codec: IvfCodec = fourcc === "VP90" ? "vp9" : "av1";
  requireIvf(codec === options.expectedCodec, "IVF codec does not match the request");

  const width = view.getUint16(12, true);
  const height = view.getUint16(14, true);
  requireIvf(width > 0 && height > 0, "IVF dimensions must be positive");
  if (options.expectedWidth !== undefined) {
    requirePositiveSafeInteger(options.expectedWidth, "expectedWidth");
    requireIvf(width === options.expectedWidth, "IVF width does not match the request");
  }
  if (options.expectedHeight !== undefined) {
    requirePositiveSafeInteger(options.expectedHeight, "expectedHeight");
    requireIvf(height === options.expectedHeight, "IVF height does not match the request");
  }

  const rate = view.getUint32(16, true);
  const scale = view.getUint32(20, true);
  requireIvf(rate > 0 && scale > 0, "IVF time base must be positive");
  const divisor = greatestCommonDivisor(rate, scale);
  const timeBase = Object.freeze({
    numerator: scale / divisor,
    denominator: rate / divisor
  });

  const declaredFrames = view.getUint32(24, true);
  const maximumFrames = options.maximumFrames ?? 0xffff_ffff;
  requirePositiveSafeInteger(maximumFrames, "maximumFrames");
  const streamingFrameCount = declaredFrames === IVF_STREAMING_FRAME_COUNT;
  requireIvf(
    !streamingFrameCount || options.maximumFrames !== undefined,
    "Streaming IVF requires an explicit frame budget"
  );
  requireIvf(
    streamingFrameCount || declaredFrames > 0,
    "IVF must declare at least one frame"
  );
  requireIvf(
    streamingFrameCount || declaredFrames <= maximumFrames,
    "IVF frame count exceeds the budget"
  );
  if (options.expectedFrameCount !== undefined) {
    requirePositiveSafeInteger(options.expectedFrameCount, "expectedFrameCount");
  }
  requireIvf(view.getUint32(28, true) === 0, "IVF reserved field must be zero");

  const maximumFrameBytes = options.maximumFrameBytes ?? 0xffff_ffff;
  requirePositiveSafeInteger(maximumFrameBytes, "maximumFrameBytes");
  const frames: IvfFrame[] = [];
  let cursor = IVF_HEADER_BYTES;
  for (
    let frameIndex = 0;
    streamingFrameCount ? cursor < input.byteLength : frameIndex < declaredFrames;
    frameIndex += 1
  ) {
    requireIvf(frameIndex < maximumFrames, "IVF frame count exceeds the budget");
    requireIvf(
      input.byteLength - cursor >= IVF_FRAME_HEADER_BYTES,
      `IVF frame ${String(frameIndex)} header is truncated`
    );
    const size = view.getUint32(cursor, true);
    requireIvf(size > 0, `IVF frame ${String(frameIndex)} is empty`);
    requireIvf(
      size <= maximumFrameBytes,
      `IVF frame ${String(frameIndex)} exceeds the byte budget`
    );
    const timestampBig = view.getBigUint64(cursor + 4, true);
    requireIvf(
      timestampBig <= BigInt(Number.MAX_SAFE_INTEGER),
      `IVF frame ${String(frameIndex)} timestamp is unsafe`
    );
    cursor += IVF_FRAME_HEADER_BYTES;
    requireIvf(
      size <= input.byteLength - cursor,
      `IVF frame ${String(frameIndex)} payload is truncated`
    );
    frames.push(Object.freeze({
      timestamp: Number(timestampBig),
      bytes: input.slice(cursor, cursor + size)
    }));
    cursor += size;
  }
  requireIvf(cursor === input.byteLength, "IVF contains trailing bytes");
  requireIvf(frames.length > 0, "IVF must contain at least one frame");
  if (options.expectedFrameCount !== undefined) {
    requireIvf(
      frames.length === options.expectedFrameCount,
      "IVF frame count does not match the request"
    );
  }

  return Object.freeze({
    codec,
    width,
    height,
    timeBase,
    frames: Object.freeze(frames)
  });
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    const byte = bytes[offset + index];
    requireIvf(byte !== undefined, "IVF text field is truncated");
    value += String.fromCharCode(byte);
  }
  return value;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function checkedIvfAdd(left: number, right: number): number {
  requireIvf(
    Number.isSafeInteger(right) && right >= 0 && left <= Number.MAX_SAFE_INTEGER - right,
    "IVF transport length exceeds safe arithmetic"
  );
  return left + right;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function requirePositiveSafeInteger(value: number, field: string): void {
  requireIvf(
    Number.isSafeInteger(value) && value > 0,
    `${field} must be a positive safe integer`
  );
}

function requireIvf(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new CompilerError("FFMPEG_FAILED", message);
  }
}
