import {
  PACKED_ALPHA_GUTTER,
  type Rect,
  type VideoRenditionGeometry
} from "@pixel-point/aval-format";

import { CompilerError } from "../diagnostics.js";

const CHANNELS = 4;
const DILATION_RADIUS = 4;
const DILATION_RADIUS_SQUARED = DILATION_RADIUS * DILATION_RADIUS;
const UINT16_MAXIMUM = 65_535;

/** Compose one visible canonical frame into shared opaque/packed-alpha storage. */
export function composeVideoSurfaceRgba16(
  source: Uint16Array,
  geometry: Readonly<VideoRenditionGeometry>
): Uint16Array {
  const facts = validate(source, geometry);
  const output = new Uint16Array(checkedProduct(
    facts.codedWidth,
    facts.codedHeight,
    CHANNELS
  ));
  for (let offset = 3; offset < output.length; offset += CHANNELS) {
    output[offset] = UINT16_MAXIMUM;
  }
  const dilated = dilate(source, facts.visibleWidth, facts.visibleHeight);
  for (let y = 0; y < facts.visibleHeight; y += 1) {
    for (let x = 0; x < facts.visibleWidth; x += 1) {
      const sourceOffset = (y * facts.visibleWidth + x) * CHANNELS;
      const targetOffset = (y * facts.codedWidth + x) * CHANNELS;
      output[targetOffset] = dilated[sourceOffset]!;
      output[targetOffset + 1] = dilated[sourceOffset + 1]!;
      output[targetOffset + 2] = dilated[sourceOffset + 2]!;
    }
  }
  if (facts.alphaRect !== null) {
    const [alphaX, alphaY] = facts.alphaRect;
    for (let y = 0; y < facts.visibleHeight; y += 1) {
      for (let x = 0; x < facts.visibleWidth; x += 1) {
        const sourceOffset = (y * facts.visibleWidth + x) * CHANNELS;
        const targetOffset = (
          (alphaY + y) * facts.codedWidth + alphaX + x
        ) * CHANNELS;
        const alpha = source[sourceOffset + 3]!;
        output[targetOffset] = alpha;
        output[targetOffset + 1] = alpha;
        output[targetOffset + 2] = alpha;
      }
    }
  }
  return output;
}

interface SurfaceFacts {
  readonly visibleWidth: number;
  readonly visibleHeight: number;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly alphaRect: Rect | null;
}

function validate(
  source: Uint16Array,
  geometry: Readonly<VideoRenditionGeometry>
): Readonly<SurfaceFacts> {
  if (!(source instanceof Uint16Array)) {
    throw invalid("Video surface source must be canonical RGBA16 channels");
  }
  if (typeof geometry !== "object" || geometry === null) {
    throw invalid("Video surface geometry must be an object");
  }
  const codedWidth = positive(geometry.codedWidth, "coded width");
  const codedHeight = positive(geometry.codedHeight, "coded height");
  if (codedWidth % 2 !== 0 || codedHeight % 2 !== 0) {
    throw invalid("Video surface coded dimensions must be even");
  }
  const color = rect(geometry.visibleColorRect, "visible color rectangle");
  const decoded = rect(geometry.decodedStorageRect, "decoded storage rectangle");
  if (
    color[0] !== 0 ||
    color[1] !== 0 ||
    decoded[0] !== 0 ||
    decoded[1] !== 0 ||
    color[2] > decoded[2] ||
    color[3] > decoded[3] ||
    decoded[2] > codedWidth ||
    decoded[3] > codedHeight
  ) {
    throw invalid("Video surface rectangles do not fit the coded geometry");
  }
  let alphaRect: Rect | null = null;
  if (geometry.layout === "opaque") {
    if (geometry.visibleAlphaRect !== undefined) {
      throw invalid("Opaque video surface cannot declare an alpha rectangle");
    }
  } else if (geometry.layout === "packed-alpha") {
    if (geometry.visibleAlphaRect === undefined) {
      throw invalid("Packed video surface requires an alpha rectangle");
    }
    const alpha = rect(geometry.visibleAlphaRect, "visible alpha rectangle");
    const below = alpha[0] === 0 && alpha[1] >= align(color[3], 2) + PACKED_ALPHA_GUTTER;
    const beside = alpha[1] === 0 && alpha[0] >= align(color[2], 2) + PACKED_ALPHA_GUTTER;
    if (
      alpha[2] !== color[2] ||
      alpha[3] !== color[3] ||
      (!below && !beside) ||
      alpha[0] + alpha[2] > decoded[2] ||
      alpha[1] + alpha[3] > decoded[3]
    ) {
      throw invalid("Packed alpha rectangle is inconsistent with shared geometry");
    }
    alphaRect = alpha;
  } else {
    throw invalid("Video surface layout is invalid");
  }
  const expectedLength = checkedProduct(color[2], color[3], CHANNELS);
  if (source.length !== expectedLength) {
    throw invalid("Canonical RGBA16 length does not match the visible color rectangle");
  }
  return Object.freeze({
    visibleWidth: color[2],
    visibleHeight: color[3],
    codedWidth,
    codedHeight,
    alphaRect
  });
}

function dilate(source: Uint16Array, width: number, height: number): Uint16Array {
  const output = source.slice();
  for (let destinationY = 0; destinationY < height; destinationY += 1) {
    for (let destinationX = 0; destinationX < width; destinationX += 1) {
      const destination = offset(width, destinationX, destinationY);
      if (source[destination + 3]! > 0) continue;
      let bestOffset = -1;
      let bestDistance = DILATION_RADIUS_SQUARED + 1;
      let bestAlpha = -1;
      let bestY = Number.MAX_SAFE_INTEGER;
      let bestX = Number.MAX_SAFE_INTEGER;
      for (
        let sourceY = Math.max(0, destinationY - DILATION_RADIUS);
        sourceY <= Math.min(height - 1, destinationY + DILATION_RADIUS);
        sourceY += 1
      ) {
        const deltaY = sourceY - destinationY;
        for (
          let sourceX = Math.max(0, destinationX - DILATION_RADIUS);
          sourceX <= Math.min(width - 1, destinationX + DILATION_RADIUS);
          sourceX += 1
        ) {
          const deltaX = sourceX - destinationX;
          const distance = deltaX * deltaX + deltaY * deltaY;
          if (distance > DILATION_RADIUS_SQUARED) continue;
          const candidate = offset(width, sourceX, sourceY);
          const alpha = source[candidate + 3]!;
          if (
            alpha === 0 ||
            !better(
              distance,
              alpha,
              sourceY,
              sourceX,
              bestDistance,
              bestAlpha,
              bestY,
              bestX
            )
          ) continue;
          bestOffset = candidate;
          bestDistance = distance;
          bestAlpha = alpha;
          bestY = sourceY;
          bestX = sourceX;
        }
      }
      output[destination] = bestOffset < 0 ? 0 : source[bestOffset]!;
      output[destination + 1] = bestOffset < 0 ? 0 : source[bestOffset + 1]!;
      output[destination + 2] = bestOffset < 0 ? 0 : source[bestOffset + 2]!;
      output[destination + 3] = 0;
    }
  }
  return output;
}

function better(
  distance: number,
  alpha: number,
  y: number,
  x: number,
  bestDistance: number,
  bestAlpha: number,
  bestY: number,
  bestX: number
): boolean {
  return distance < bestDistance ||
    (distance === bestDistance && (
      alpha > bestAlpha ||
      (alpha === bestAlpha && (y < bestY || (y === bestY && x < bestX)))
    ));
}

function rect(value: Rect, label: string): Rect {
  if (!Array.isArray(value) || value.length !== 4) {
    throw invalid(`${label} must contain four integers`);
  }
  for (const component of value) {
    if (!Number.isSafeInteger(component) || component < 0) {
      throw invalid(`${label} components must be nonnegative safe integers`);
    }
  }
  if (value[2] < 1 || value[3] < 1) {
    throw invalid(`${label} dimensions must be positive`);
  }
  return value;
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid(`Video surface ${label} must be a positive safe integer`);
  }
  return value;
}

function align(value: number, alignment: number): number {
  const remainder = value % alignment;
  return remainder === 0 ? value : value + alignment - remainder;
}

function offset(width: number, x: number, y: number): number {
  return (y * width + x) * CHANNELS;
}

function checkedProduct(...values: number[]): number {
  let result = 1;
  for (const value of values) {
    result *= value;
    if (!Number.isSafeInteger(result) || result < 0) {
      throw invalid("Video surface size exceeds the safe integer range");
    }
  }
  return result;
}

function invalid(message: string): CompilerError {
  return new CompilerError("INPUT_INVALID", message, { phase: "pixel-pipeline" });
}
