import { CompilerError } from "../diagnostics.js";

export interface SeamAnalysisInput {
  readonly width: number;
  readonly height: number;
  readonly frames: readonly Uint8Array[];
  readonly boundaryAfter: number;
}

export interface SeamAnalysisResult {
  readonly boundaryRms: number;
  readonly alphaBoundaryRms: number;
  readonly neighborP95: number;
  readonly alphaNeighborP95: number;
  readonly identicalBoundary: boolean;
  readonly repeatedEndpointPause: boolean;
  readonly passes: boolean;
}

/** Analyze a closed boundary in linear-light premultiplied RGBA. */
export function analyzeSeam(
  input: SeamAnalysisInput
): Readonly<SeamAnalysisResult> {
  const frameBytes = input.width * input.height * 4;
  if (
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    input.width < 1 ||
    input.height < 1 ||
    input.frames.length < 2 ||
    !Number.isSafeInteger(input.boundaryAfter) ||
    input.boundaryAfter < 0 ||
    input.boundaryAfter >= input.frames.length - 1 ||
    input.frames.some((frame) => frame.byteLength !== frameBytes)
  ) {
    throw new CompilerError("INPUT_INVALID", "Seam-analysis frame geometry is invalid");
  }
  const left = input.frames[input.boundaryAfter]!;
  const right = input.frames[input.boundaryAfter + 1]!;
  const boundary = frameDifference(left, right);
  const neighborRgb: number[] = [];
  const neighborAlpha: number[] = [];
  const first = Math.max(0, input.boundaryAfter - 4);
  const last = Math.min(input.frames.length - 2, input.boundaryAfter + 4);
  for (let index = first; index <= last; index += 1) {
    if (index === input.boundaryAfter) continue;
    const difference = frameDifference(
      input.frames[index]!,
      input.frames[index + 1]!
    );
    neighborRgb.push(difference.rgb);
    neighborAlpha.push(difference.alpha);
  }
  const neighborP95 = percentile95(neighborRgb);
  const alphaNeighborP95 = percentile95(neighborAlpha);
  const floor = 1 / 255;
  const identicalBoundary = equalBytes(left, right);
  const repeatedEndpointPause =
    identicalBoundary &&
    (neighborP95 > floor || alphaNeighborP95 > floor);
  return Object.freeze({
    boundaryRms: boundary.rgb,
    alphaBoundaryRms: boundary.alpha,
    neighborP95,
    alphaNeighborP95,
    identicalBoundary,
    repeatedEndpointPause,
    passes:
      boundary.rgb <= 1.5 * Math.max(neighborP95, floor) &&
      boundary.alpha <= 1.5 * Math.max(alphaNeighborP95, floor)
  });
}

function frameDifference(
  left: Uint8Array,
  right: Uint8Array
): { readonly rgb: number; readonly alpha: number } {
  let rgbSquares = 0;
  let alphaSquares = 0;
  let pixels = 0;
  for (let offset = 0; offset < left.byteLength; offset += 4) {
    const leftAlpha = left[offset + 3]! / 255;
    const rightAlpha = right[offset + 3]! / 255;
    for (let channel = 0; channel < 3; channel += 1) {
      const a = srgbToLinear(left[offset + channel]! / 255) * leftAlpha;
      const b = srgbToLinear(right[offset + channel]! / 255) * rightAlpha;
      const delta = a - b;
      rgbSquares += delta * delta;
    }
    const alphaDelta = leftAlpha - rightAlpha;
    alphaSquares += alphaDelta * alphaDelta;
    pixels += 1;
  }
  return {
    rgb: Math.sqrt(rgbSquares / (pixels * 3)),
    alpha: Math.sqrt(alphaSquares / pixels)
  };
}

function srgbToLinear(value: number): number {
  return value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4;
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}
