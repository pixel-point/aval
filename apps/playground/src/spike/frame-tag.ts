const DATA_BIT_COUNT = 8;
const ANCHOR_CELL_COUNT = 2;
const PARITY_CELL_COUNT = 2;

export const FRAME_TAG_CELL_COUNT =
  ANCHOR_CELL_COUNT + DATA_BIT_COUNT * 2 + PARITY_CELL_COUNT;

export const FRAME_TAG_DARK = 24;
export const FRAME_TAG_LIGHT = 232;

export type FrameTagCanvasContext =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D;

export interface FrameTagLayout {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly cellCount: typeof FRAME_TAG_CELL_COUNT;
}

export interface FrameTagRead {
  readonly value: number;
  readonly contrast: number;
  readonly threshold: number;
  /**
   * The smallest cell's distance from the adaptive threshold, normalized so
   * that 1 is half the measured black-to-white anchor range.
   */
  readonly minimumMargin: number;
  readonly samples: readonly number[];
}

export interface FrameTagPixels {
  readonly data: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
  readonly strideBytes?: number;
}

export class FrameTagDecodeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FrameTagDecodeError";
  }
}

function assertDimension(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function assertTagValue(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError("A frame tag must be an unsigned 8-bit integer");
  }
}

export function getFrameTagLayout(
  width: number,
  height: number,
): FrameTagLayout {
  assertDimension(width, "Frame-tag width");
  assertDimension(height, "Frame-tag height");

  if (width < FRAME_TAG_CELL_COUNT * 3 || height < 32) {
    throw new RangeError(
      `A frame tag needs at least ${FRAME_TAG_CELL_COUNT * 3}x32 pixels`,
    );
  }

  const tagHeight = Math.max(20, Math.floor(height * 0.2));

  return {
    x: 0,
    y: height - tagHeight,
    width,
    height: tagHeight,
    cellCount: FRAME_TAG_CELL_COUNT,
  };
}

/**
 * Returns the exact cell sequence painted into a tag. Cells 0 and 1 are dark
 * and light calibration anchors. They are followed by the byte, its bitwise
 * complement, even parity, and the parity complement.
 */
export function encodeFrameTagCells(value: number): readonly boolean[] {
  assertTagValue(value);

  const dataBits: boolean[] = [];
  let parity = false;

  for (let bit = DATA_BIT_COUNT - 1; bit >= 0; bit -= 1) {
    const enabled = (value & (1 << bit)) !== 0;
    dataBits.push(enabled);
    parity = parity !== enabled;
  }

  return [
    false,
    true,
    ...dataBits,
    ...dataBits.map((enabled) => !enabled),
    parity,
    !parity,
  ];
}

/** Paints a large, codec-tolerant grayscale tag across the frame's bottom. */
export function drawFrameTag(
  context: FrameTagCanvasContext,
  value: number,
  width: number,
  height: number,
): void {
  const layout = getFrameTagLayout(width, height);
  const cells = encodeFrameTagCells(value);

  context.save();
  for (let index = 0; index < cells.length; index += 1) {
    const x0 = Math.floor((index * layout.width) / layout.cellCount);
    const x1 = Math.floor(((index + 1) * layout.width) / layout.cellCount);
    const gray = cells[index] === true ? FRAME_TAG_LIGHT : FRAME_TAG_DARK;
    context.fillStyle = `rgb(${gray} ${gray} ${gray})`;
    context.fillRect(layout.x + x0, layout.y, x1 - x0, layout.height);
  }
  context.restore();
}

function readCellSample(
  source: FrameTagPixels,
  layout: FrameTagLayout,
  cellIndex: number,
): number {
  const stride = source.strideBytes ?? source.width * 4;
  if (!Number.isSafeInteger(stride) || stride < source.width * 4) {
    throw new RangeError("Frame-tag RGBA stride is too small");
  }

  // Ignore cell edges where H.264 ringing and chroma interpolation are worst.
  const rawX0 = (cellIndex * layout.width) / layout.cellCount;
  const rawX1 = ((cellIndex + 1) * layout.width) / layout.cellCount;
  const x0 = Math.ceil(rawX0 + (rawX1 - rawX0) * 0.28);
  const x1 = Math.max(x0 + 1, Math.floor(rawX1 - (rawX1 - rawX0) * 0.28));
  const y0 = Math.ceil(layout.y + layout.height * 0.28);
  const y1 = Math.max(y0 + 1, Math.floor(layout.y + layout.height * 0.72));

  let luminanceSum = 0;
  let sampleCount = 0;

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = y * stride + x * 4;
      const red = source.data[offset];
      const green = source.data[offset + 1];
      const blue = source.data[offset + 2];
      if (red === undefined || green === undefined || blue === undefined) {
        throw new RangeError("Frame-tag RGBA buffer is shorter than declared");
      }

      // Integer Rec. 709 approximation. Grayscale tags make this insensitive
      // to the decoder's chroma conversion while still accepting RGBA output.
      luminanceSum += (54 * red + 183 * green + 19 * blue) / 256;
      sampleCount += 1;
    }
  }

  if (sampleCount === 0) {
    throw new FrameTagDecodeError("Frame-tag sample area is empty");
  }

  return luminanceSum / sampleCount;
}

/** Decodes and validates the byte, complement, and parity checks. */
export function readFrameTagFromRgba(source: FrameTagPixels): FrameTagRead {
  assertDimension(source.width, "Frame-tag width");
  assertDimension(source.height, "Frame-tag height");
  const layout = getFrameTagLayout(source.width, source.height);
  const minimumLength =
    (source.height - 1) * (source.strideBytes ?? source.width * 4) +
    source.width * 4;
  if (source.data.length < minimumLength) {
    throw new RangeError("Frame-tag RGBA buffer is shorter than declared");
  }

  const samples = Array.from({ length: FRAME_TAG_CELL_COUNT }, (_, index) =>
    readCellSample(source, layout, index),
  );
  const darkAnchor = samples[0];
  const lightAnchor = samples[1];
  if (darkAnchor === undefined || lightAnchor === undefined) {
    throw new FrameTagDecodeError("Frame tag has no calibration anchors");
  }

  const contrast = lightAnchor - darkAnchor;
  if (contrast < 48) {
    throw new FrameTagDecodeError(
      `Frame-tag anchors have insufficient contrast (${contrast.toFixed(1)})`,
    );
  }

  const threshold = darkAnchor + contrast / 2;
  const decoded = samples.map((sample) => sample > threshold);
  if (decoded[0] !== false || decoded[1] !== true) {
    throw new FrameTagDecodeError("Frame-tag calibration anchors are inverted");
  }

  let value = 0;
  let parity = false;
  for (let index = 0; index < DATA_BIT_COUNT; index += 1) {
    const data = decoded[ANCHOR_CELL_COUNT + index];
    const complement =
      decoded[ANCHOR_CELL_COUNT + DATA_BIT_COUNT + index];
    if (data === undefined || complement === undefined || data === complement) {
      throw new FrameTagDecodeError(
        `Frame-tag complement check failed at bit ${DATA_BIT_COUNT - 1 - index}`,
      );
    }

    value = (value << 1) | (data ? 1 : 0);
    parity = parity !== data;
  }

  const encodedParity = decoded[FRAME_TAG_CELL_COUNT - 2];
  const encodedParityComplement = decoded[FRAME_TAG_CELL_COUNT - 1];
  if (
    encodedParity === undefined ||
    encodedParityComplement === undefined ||
    encodedParity !== parity ||
    encodedParity === encodedParityComplement
  ) {
    throw new FrameTagDecodeError("Frame-tag parity check failed");
  }

  const halfRange = contrast / 2;
  const minimumMargin = Math.min(
    ...samples.map((sample) => Math.abs(sample - threshold) / halfRange),
  );

  return {
    value,
    contrast,
    threshold,
    minimumMargin,
    samples,
  };
}

export function decodeFrameTagFromRgba(source: FrameTagPixels): number {
  return readFrameTagFromRgba(source).value;
}

/** Copies a decoded frame to RGBA and reads its machine tag. */
export async function readFrameTagFromVideoFrame(
  frame: VideoFrame,
): Promise<FrameTagRead> {
  const width = frame.displayWidth;
  const height = frame.displayHeight;
  const copyOptions: VideoFrameCopyToOptions = {
    format: "RGBA",
    rect: { x: 0, y: 0, width, height },
  };
  const bytes = new Uint8Array(frame.allocationSize(copyOptions));
  const layouts = await frame.copyTo(bytes, copyOptions);
  const plane = layouts[0];
  if (plane === undefined) {
    throw new FrameTagDecodeError("VideoFrame RGBA copy returned no plane");
  }

  return readFrameTagFromRgba({
    data: bytes.subarray(plane.offset),
    width,
    height,
    strideBytes: plane.stride,
  });
}
