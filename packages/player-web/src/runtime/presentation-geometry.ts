import {
  BYTES_PER_RGBA_PIXEL,
  checkedByteNumber,
  checkedByteProduct,
  validatePositiveSafeInteger
} from "./checked-runtime-bytes.js";

export const PRESENTATION_FIT_MODES = Object.freeze([
  "contain",
  "cover",
  "fill",
  "none"
] as const);
const PRESENTATION_PLANE_COUNT = 1;

export type PresentationFit = (typeof PRESENTATION_FIT_MODES)[number];

export interface PresentationRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PresentationSize {
  readonly width: number;
  readonly height: number;
}

export interface RasterPresentationRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PresentationGeometryInput {
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly pixelAspectNumerator: number;
  readonly pixelAspectDenominator: number;
  readonly fit: PresentationFit;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly devicePixelRatio: number;
  readonly maxBackingWidth: number;
  readonly maxBackingHeight: number;
  readonly maxBackingBytes: number;
}

/** The shared integer raster boundary consumed by Canvas2D and WebGL. */
export function rasterizePresentationRect(
  rect: Readonly<PresentationRect>
): Readonly<RasterPresentationRect> {
  if (
    rect === null ||
    typeof rect !== "object" ||
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    throw new RangeError("presentation raster rectangle is invalid");
  }
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  const right = Math.round(rect.x + rect.width);
  const bottom = Math.round(rect.y + rect.height);
  return Object.freeze({
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y)
  });
}

export interface PresentationPlaneMapping {
  readonly sourceRect: Readonly<PresentationRect>;
  readonly destinationCssRect: Readonly<PresentationRect>;
  readonly destinationBackingRect: Readonly<PresentationRect>;
}

export interface PresentationGeometry {
  readonly fit: PresentationFit;
  readonly displayAspect: number;
  readonly sourceRect: Readonly<PresentationRect>;
  readonly destinationCssRect: Readonly<PresentationRect>;
  readonly destinationBackingRect: Readonly<PresentationRect>;
  readonly backing: Readonly<PresentationSize>;
  readonly effectiveDevicePixelRatio: {
    readonly x: number;
    readonly y: number;
  };
  readonly byteTerms: {
    readonly bytesPerPlane: number;
    readonly totalBackingBytes: number;
  };
  readonly planes: {
    readonly animated: Readonly<PresentationPlaneMapping>;
  };
}

/** Pure geometry authority for the animated canvas. */
export function computePresentationGeometry(
  input: Readonly<PresentationGeometryInput>
): Readonly<PresentationGeometry> {
  validateInput(input);
  const pixelScale =
    input.pixelAspectNumerator / input.pixelAspectDenominator;
  const intrinsicWidth = input.canvasWidth * pixelScale;
  const intrinsicHeight = input.canvasHeight;
  const displayAspect = intrinsicWidth / intrinsicHeight;
  if (
    !Number.isFinite(intrinsicWidth) ||
    !Number.isFinite(displayAspect) ||
    intrinsicWidth <= 0 ||
    displayAspect <= 0
  ) {
    throw new RangeError("presentation display aspect is out of range");
  }

  const { sourceRect, destinationCssRect } = fitRects(
    input,
    intrinsicWidth,
    intrinsicHeight,
    pixelScale
  );
  const desiredWidth = checkedCeilProduct(
    input.cssWidth,
    input.devicePixelRatio,
    "desired backing width"
  );
  const desiredHeight = checkedCeilProduct(
    input.cssHeight,
    input.devicePixelRatio,
    "desired backing height"
  );
  const desiredBytes = checkedByteProduct([
    desiredWidth,
    desiredHeight,
    BYTES_PER_RGBA_PIXEL,
    PRESENTATION_PLANE_COUNT
  ], "desired presentation backing bytes");

  if (
    desiredWidth > input.maxBackingWidth ||
    desiredHeight > input.maxBackingHeight
  ) {
    throw new RangeError(
      "requested presentation backing exceeds the host or device dimensions"
    );
  }
  if (desiredBytes > BigInt(input.maxBackingBytes)) {
    throw new RangeError(
      "requested presentation backing exceeds the host byte policy"
    );
  }

  const backingWidth = desiredWidth;
  const backingHeight = desiredHeight;
  const totalBackingBytesBig = checkedByteProduct([
    backingWidth,
    backingHeight,
    BYTES_PER_RGBA_PIXEL,
    PRESENTATION_PLANE_COUNT
  ], "presentation backing bytes");
  if (totalBackingBytesBig > BigInt(input.maxBackingBytes)) {
    throw new RangeError("presentation backing exceeds its byte cap");
  }
  const bytesPerPlane = checkedByteNumber(
    checkedByteProduct([
      backingWidth,
      backingHeight,
      BYTES_PER_RGBA_PIXEL
    ], "presentation plane bytes"),
    "presentation plane bytes"
  );
  const totalBackingBytes = checkedByteNumber(
    totalBackingBytesBig,
    "presentation backing bytes"
  );
  const backing = freezeSize(backingWidth, backingHeight);
  const destinationBackingRect = freezeRect(
    destinationCssRect.x * backingWidth / input.cssWidth,
    destinationCssRect.y * backingHeight / input.cssHeight,
    destinationCssRect.width * backingWidth / input.cssWidth,
    destinationCssRect.height * backingHeight / input.cssHeight
  );
  const mapping = Object.freeze({
    sourceRect,
    destinationCssRect,
    destinationBackingRect
  });

  return Object.freeze({
    fit: input.fit,
    displayAspect,
    sourceRect,
    destinationCssRect,
    destinationBackingRect,
    backing,
    effectiveDevicePixelRatio: Object.freeze({
      x: backingWidth / input.cssWidth,
      y: backingHeight / input.cssHeight
    }),
    byteTerms: Object.freeze({ bytesPerPlane, totalBackingBytes }),
    planes: Object.freeze({ animated: mapping })
  });
}

function fitRects(
  input: Readonly<PresentationGeometryInput>,
  intrinsicWidth: number,
  intrinsicHeight: number,
  pixelScale: number
): {
  readonly sourceRect: Readonly<PresentationRect>;
  readonly destinationCssRect: Readonly<PresentationRect>;
} {
  const fullSource = freezeRect(
    0,
    0,
    input.canvasWidth,
    input.canvasHeight
  );
  if (input.fit === "fill") {
    return {
      sourceRect: fullSource,
      destinationCssRect: freezeRect(
        0,
        0,
        input.cssWidth,
        input.cssHeight
      )
    };
  }
  if (input.fit === "none") {
    return {
      sourceRect: fullSource,
      destinationCssRect: freezeRect(
        (input.cssWidth - intrinsicWidth) / 2,
        (input.cssHeight - intrinsicHeight) / 2,
        intrinsicWidth,
        intrinsicHeight
      )
    };
  }

  const xScale = input.cssWidth / intrinsicWidth;
  const yScale = input.cssHeight / intrinsicHeight;
  if (input.fit === "contain") {
    const scale = Math.min(xScale, yScale);
    const width = intrinsicWidth * scale;
    const height = intrinsicHeight * scale;
    return {
      sourceRect: fullSource,
      destinationCssRect: freezeRect(
        (input.cssWidth - width) / 2,
        (input.cssHeight - height) / 2,
        width,
        height
      )
    };
  }

  const scale = Math.max(xScale, yScale);
  const sourceWidth = Math.min(
    input.canvasWidth,
    input.cssWidth / scale / pixelScale
  );
  const sourceHeight = Math.min(
    input.canvasHeight,
    input.cssHeight / scale
  );
  return {
    sourceRect: freezeRect(
      (input.canvasWidth - sourceWidth) / 2,
      (input.canvasHeight - sourceHeight) / 2,
      sourceWidth,
      sourceHeight
    ),
    destinationCssRect: freezeRect(
      0,
      0,
      input.cssWidth,
      input.cssHeight
    )
  };
}

function validateInput(input: Readonly<PresentationGeometryInput>): void {
  if (input === null || typeof input !== "object") {
    throw new TypeError("presentation geometry input must be an object");
  }
  validatePositiveSafeInteger(input.canvasWidth, "presentation canvas width");
  validatePositiveSafeInteger(input.canvasHeight, "presentation canvas height");
  validatePositiveSafeInteger(
    input.pixelAspectNumerator,
    "presentation pixel-aspect numerator"
  );
  validatePositiveSafeInteger(
    input.pixelAspectDenominator,
    "presentation pixel-aspect denominator"
  );
  if (!PRESENTATION_FIT_MODES.includes(input.fit)) {
    throw new RangeError("presentation fit is invalid");
  }
  validatePositiveFinite(input.cssWidth, "presentation CSS width");
  validatePositiveFinite(input.cssHeight, "presentation CSS height");
  validatePositiveFinite(
    input.devicePixelRatio,
    "presentation device pixel ratio"
  );
  validatePositiveSafeInteger(
    input.maxBackingWidth,
    "presentation maximum backing width"
  );
  validatePositiveSafeInteger(
    input.maxBackingHeight,
    "presentation maximum backing height"
  );
  validatePositiveSafeInteger(
    input.maxBackingBytes,
    "presentation maximum backing bytes"
  );
  if (
    input.maxBackingBytes <
      BYTES_PER_RGBA_PIXEL * PRESENTATION_PLANE_COUNT
  ) {
    throw new RangeError(
      "presentation maximum backing bytes cannot hold both planes"
    );
  }
}

function checkedCeilProduct(left: number, right: number, label: string): number {
  const product = left * right;
  if (!Number.isFinite(product) || product <= 0) {
    throw new RangeError(`${label} is out of range`);
  }
  const value = Math.ceil(product);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} exceeds safe integer range`);
  }
  return value;
}

function freezeRect(
  x: number,
  y: number,
  width: number,
  height: number
): Readonly<PresentationRect> {
  for (const value of [x, y, width, height]) {
    if (!Number.isFinite(value)) {
      throw new RangeError("presentation rectangle is not finite");
    }
  }
  if (width <= 0 || height <= 0) {
    throw new RangeError("presentation rectangle must have positive size");
  }
  return Object.freeze({ x: normalizeZero(x), y: normalizeZero(y), width, height });
}

function freezeSize(width: number, height: number): Readonly<PresentationSize> {
  return Object.freeze({ width, height });
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function validatePositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be finite and positive`);
  }
}
