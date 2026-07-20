import {
  PACKED_ALPHA_WITNESS_MAX_INTERVAL_WIDTH,
  PACKED_ALPHA_WITNESS_MAX_SAMPLES
} from "./constants.js";
import { PACKED_ALPHA_GUTTER } from "./video/geometry.js";
import { isVideoCodecString } from "./video/codec-string.js";
import {
  boundedArray,
  exactKeys,
  identifier,
  integerInRange,
  invalid,
  literal,
  nonNegativeInteger,
  oneOf,
  positiveInteger,
  record,
  tuple
} from "./manifest-validation.js";
import type {
  AlphaLayout,
  Bitrate,
  Canvas,
  FormatBudgets,
  FormatVersion,
  PackedAlphaWitnessV1,
  ProductionRendition,
  Rational,
  Rect,
  VideoCodec,
  VideoLayout
} from "./model.js";

const MAX_PIXEL_ASPECT_TERM = 10_000;
const MAX_FRAME_RATE = 60;
const MAX_FRAME_RATE_DENOMINATOR = 1_001;
const DIMENSION_MAX = 0xffff_ffff;

export function cloneCanvas(value: unknown, path: string): Canvas {
  const input = record(value, path);
  exactKeys(input, ["width", "height", "fit", "pixelAspect", "colorSpace"], path);
  const width = positiveInteger(input.width, `${path}.width`, DIMENSION_MAX);
  const height = positiveInteger(input.height, `${path}.height`, DIMENSION_MAX);
  const fit = oneOf(input.fit, ["contain", "cover", "fill", "none"], `${path}.fit`);
  const pixelAspectInput = tuple(input.pixelAspect, 2, `${path}.pixelAspect`);
  const pixelAspect = Object.freeze([
    positiveInteger(pixelAspectInput[0], `${path}.pixelAspect[0]`, MAX_PIXEL_ASPECT_TERM),
    positiveInteger(pixelAspectInput[1], `${path}.pixelAspect[1]`, MAX_PIXEL_ASPECT_TERM)
  ]) as readonly [number, number];
  literal(input.colorSpace, "srgb", `${path}.colorSpace`);
  return Object.freeze({ width, height, fit, pixelAspect, colorSpace: "srgb" });
}

export function cloneFrameRate(value: unknown, path: string): Rational {
  const input = record(value, path);
  exactKeys(input, ["numerator", "denominator"], path);
  const numerator = positiveInteger(input.numerator, `${path}.numerator`);
  const denominator = positiveInteger(
    input.denominator,
    `${path}.denominator`,
    MAX_FRAME_RATE_DENOMINATOR
  );
  if (numerator > denominator * MAX_FRAME_RATE) {
    invalid(`${path}.numerator`, `must not exceed ${String(MAX_FRAME_RATE)} frames per second`);
  }
  return Object.freeze({ numerator, denominator });
}

/** Preserve authored quality order while requiring unique rendition IDs. */
export function cloneRenditions(
  value: unknown,
  canvas: Canvas,
  codecFamily: VideoCodec,
  layout: VideoLayout,
  formatVersion: FormatVersion,
  budgets: FormatBudgets,
  path: string
): readonly ProductionRendition[] {
  const inputs = boundedArray(value, path, 1, budgets.maxRenditions);
  const seen = new Set<string>();
  const renditions = inputs.map((entry, index) => {
    const rendition = cloneRendition(
      entry,
      canvas,
      codecFamily,
      layout,
      formatVersion,
      `${path}[${String(index)}]`
    );
    if (seen.has(rendition.id)) {
      invalid(`${path}[${String(index)}].id`, "duplicates an earlier rendition ID");
    }
    seen.add(rendition.id);
    return rendition;
  });
  return Object.freeze(renditions);
}

function cloneRendition(
  value: unknown,
  canvas: Canvas,
  codecFamily: VideoCodec,
  layout: VideoLayout,
  formatVersion: FormatVersion,
  path: string
): ProductionRendition {
  const input = record(value, path);
  const commonKeys = [
    "id",
    "codec",
    "bitDepth",
    "codedWidth",
    "codedHeight",
    "alphaLayout",
    "bitrate"
  ] as const;
  if (formatVersion === "1.1" && layout === "packed-alpha") {
    exactKeys(input, [...commonKeys, "outputQualification"], path);
  } else {
    exactKeys(input, commonKeys, path);
  }
  const id = identifier(input.id, `${path}.id`);
  const bitDepthValue = integerInRange(input.bitDepth, `${path}.bitDepth`, 8, 10);
  if (bitDepthValue !== 8 && bitDepthValue !== 10) {
    invalid(`${path}.bitDepth`, "must be 8 or 10");
  }
  const bitDepth = bitDepthValue;
  if (codecFamily !== "av1" && bitDepth !== 8) {
    invalid(`${path}.bitDepth`, `${codecFamily} assets require 8-bit renditions`);
  }
  if (!isVideoCodecString(input.codec, codecFamily, bitDepth)) {
    invalid(`${path}.codec`, `must be a canonical ${codecFamily} codec string matching bit depth`);
  }
  const codedWidth = positiveInteger(input.codedWidth, `${path}.codedWidth`, DIMENSION_MAX);
  const codedHeight = positiveInteger(input.codedHeight, `${path}.codedHeight`, DIMENSION_MAX);
  if (codedWidth % 2 !== 0 || codedHeight % 2 !== 0) {
    invalid(path, "4:2:0 coded dimensions must be even");
  }
  const alphaLayout = cloneAlphaLayout(
    input.alphaLayout,
    layout,
    canvas,
    codedWidth,
    codedHeight,
    `${path}.alphaLayout`
  );
  const bitrate = cloneBitrate(input.bitrate, `${path}.bitrate`);
  if (formatVersion === "1.1" && layout === "packed-alpha") {
    if (alphaLayout.type !== "stacked") {
      invalid(`${path}.alphaLayout`, "must describe a packed-alpha rendition");
    }
    const outputQualification = clonePackedAlphaWitness(
      input.outputQualification,
      alphaLayout,
      `${path}.outputQualification`
    );
    return Object.freeze({
      id,
      codec: input.codec,
      bitDepth,
      codedWidth,
      codedHeight,
      alphaLayout,
      bitrate,
      outputQualification
    });
  }
  return Object.freeze({
    id,
    codec: input.codec,
    bitDepth,
    codedWidth,
    codedHeight,
    alphaLayout,
    bitrate
  });
}

function clonePackedAlphaWitness(
  value: unknown,
  alphaLayout: Extract<AlphaLayout, { readonly type: "stacked" }>,
  path: string
): PackedAlphaWitnessV1 {
  const input = record(value, path);
  exactKeys(input, ["kind", "unit", "frame", "samples"], path);
  literal(input.kind, "packed-alpha-v1", `${path}.kind`);
  const unit = identifier(input.unit, `${path}.unit`);
  const frame = nonNegativeInteger(input.frame, `${path}.frame`);
  const sampleInputs = boundedArray(
    input.samples,
    `${path}.samples`,
    1,
    PACKED_ALPHA_WITNESS_MAX_SAMPLES
  );
  const coordinates = new Set<string>();
  const samples = sampleInputs.map((value, index) => {
    const samplePath = `${path}.samples[${String(index)}]`;
    const sample = record(value, samplePath);
    exactKeys(sample, ["x", "y", "expectedRange"], samplePath);
    const x = integerInRange(
      sample.x,
      `${samplePath}.x`,
      0,
      alphaLayout.alphaRect[2] - 1
    );
    const y = integerInRange(
      sample.y,
      `${samplePath}.y`,
      0,
      alphaLayout.alphaRect[3] - 1
    );
    const coordinate = `${String(x)}\0${String(y)}`;
    if (coordinates.has(coordinate)) {
      invalid(samplePath, "duplicates an earlier sample coordinate");
    }
    coordinates.add(coordinate);
    const rangeInput = tuple(
      sample.expectedRange,
      2,
      `${samplePath}.expectedRange`
    );
    const minimum = integerInRange(
      rangeInput[0],
      `${samplePath}.expectedRange[0]`,
      0,
      255
    );
    const maximum = integerInRange(
      rangeInput[1],
      `${samplePath}.expectedRange[1]`,
      0,
      255
    );
    if (minimum > maximum) {
      invalid(`${samplePath}.expectedRange`, "minimum must not exceed maximum");
    }
    if (maximum - minimum > PACKED_ALPHA_WITNESS_MAX_INTERVAL_WIDTH) {
      invalid(
        `${samplePath}.expectedRange`,
        `width must not exceed ${String(PACKED_ALPHA_WITNESS_MAX_INTERVAL_WIDTH)}`
      );
    }
    const expectedRange = Object.freeze([minimum, maximum]) as readonly [
      number,
      number
    ];
    return Object.freeze({ x, y, expectedRange });
  });
  return Object.freeze({
    kind: "packed-alpha-v1",
    unit,
    frame,
    samples: Object.freeze(samples)
  });
}

function cloneAlphaLayout(
  value: unknown,
  layout: VideoLayout,
  canvas: Canvas,
  codedWidth: number,
  codedHeight: number,
  path: string
): AlphaLayout {
  const input = record(value, path);
  if (layout === "opaque") {
    exactKeys(input, ["type", "colorRect"], path);
    literal(input.type, "opaque", `${path}.type`);
    const colorRect = cloneVisibleColorRect(input.colorRect, canvas, codedWidth, codedHeight, `${path}.colorRect`);
    return Object.freeze({ type: "opaque", colorRect });
  }
  exactKeys(input, ["type", "colorRect", "alphaRect"], path);
  literal(input.type, "stacked", `${path}.type`);
  const colorRect = cloneVisibleColorRect(input.colorRect, canvas, codedWidth, codedHeight, `${path}.colorRect`);
  const alphaRect = cloneRect(input.alphaRect, codedWidth, codedHeight, `${path}.alphaRect`);
  const paneHeight = colorRect[3] % 2 === 0 ? colorRect[3] : colorRect[3] + 1;
  const expectedY = paneHeight + PACKED_ALPHA_GUTTER;
  if (
    alphaRect[0] !== 0 ||
    alphaRect[1] !== expectedY ||
    alphaRect[2] !== colorRect[2] ||
    alphaRect[3] !== colorRect[3]
  ) {
    invalid(`${path}.alphaRect`, "must be a second matching pane after the fixed eight-pixel gutter");
  }
  return Object.freeze({ type: "stacked", colorRect, alphaRect });
}

function cloneVisibleColorRect(
  value: unknown,
  canvas: Canvas,
  codedWidth: number,
  codedHeight: number,
  path: string
): Rect {
  const rect = cloneRect(value, codedWidth, codedHeight, path);
  if (rect[0] !== 0 || rect[1] !== 0) {
    invalid(path, "visible color rectangle must begin at the decoded surface origin");
  }
  if (rect[2] > canvas.width || rect[3] > canvas.height) {
    invalid(path, "visible color rectangle must fit the logical canvas");
  }
  if (BigInt(rect[2]) * BigInt(canvas.height) !== BigInt(rect[3]) * BigInt(canvas.width)) {
    invalid(path, "visible color rectangle must retain the canvas aspect ratio");
  }
  return rect;
}

function cloneBitrate(value: unknown, path: string): Bitrate {
  const input = record(value, path);
  exactKeys(input, ["average", "peak"], path);
  const average = positiveInteger(input.average, `${path}.average`);
  const peak = positiveInteger(input.peak, `${path}.peak`);
  if (average > peak) invalid(`${path}.average`, "must not exceed peak bitrate");
  return Object.freeze({ average, peak });
}

function cloneRect(
  value: unknown,
  surfaceWidth: number,
  surfaceHeight: number,
  path: string
): Rect {
  const input = tuple(value, 4, path);
  const x = nonNegativeInteger(input[0], `${path}[0]`);
  const y = nonNegativeInteger(input[1], `${path}[1]`);
  const width = positiveInteger(input[2], `${path}[2]`);
  const height = positiveInteger(input[3], `${path}[3]`);
  if (x > surfaceWidth - width || y > surfaceHeight - height) {
    invalid(path, "must lie inside the coded surface");
  }
  return Object.freeze([x, y, width, height]);
}
