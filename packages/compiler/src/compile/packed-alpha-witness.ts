import {
  PACKED_ALPHA_WITNESS_MAX_SAMPLES
} from "@pixel-point/aval-format";

import { CompilerError } from "../diagnostics.js";

const CHANNELS_PER_PIXEL = 4;
const UINT16_MAXIMUM = 65_535;
const UINT8_MAXIMUM = 255;
export const PACKED_ALPHA_WITNESS_SEPARATED_ALPHA_DELTA = 128;

export interface CanonicalPackedAlphaFrame {
  readonly unit: string;
  /** Zero-based local presentation index inside `unit`. */
  readonly frame: number;
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint16Array;
}

export interface PackedAlphaWitnessCandidate {
  readonly x: number;
  readonly y: number;
  readonly canonicalAlpha: number;
  /** Maximum canonical-alpha delta to an orthogonal in-bounds neighbor. */
  readonly gradient: number;
}

export interface PackedAlphaWitnessCandidateSelection {
  readonly unit: string;
  readonly frame: number;
  readonly requiresSeparatedCoverage: boolean;
  readonly candidates: readonly Readonly<PackedAlphaWitnessCandidate>[];
}

export interface SelectPackedAlphaWitnessCandidatesInput {
  /** Canonical readiness order; unit identity outranks local frame identity. */
  readonly bootstrapUnits: readonly string[];
  readonly frames: readonly Readonly<CanonicalPackedAlphaFrame>[];
}

/**
 * Select a small deterministic source pool while canonical RGBA16 is live.
 * Frame identity is ordered before pixel smoothness so every rendition binds
 * to the same earliest readiness frame independently of its pixel values.
 */
export function selectPackedAlphaWitnessCandidates(
  input: Readonly<SelectPackedAlphaWitnessCandidatesInput>
): Readonly<PackedAlphaWitnessCandidateSelection> {
  const bootstrapOrder = validateBootstrapUnits(input.bootstrapUnits);
  const orderedFrames = validateAndOrderFrames(input.frames, bootstrapOrder);
  const selectedFrame = orderedFrames[0];
  if (selectedFrame === undefined) {
    throw invalid("Packed-alpha witness requires a canonical bootstrap frame");
  }

  const range = alphaRange(selectedFrame);
  const requiresSeparatedCoverage =
    range.maximum - range.minimum >= PACKED_ALPHA_WITNESS_SEPARATED_ALPHA_DELTA;
  const ranked = boundedRankedCandidates(
    selectedFrame,
    range,
    requiresSeparatedCoverage
  );
  const candidates = requiresSeparatedCoverage
    ? retainSeparatedPool(selectedFrame, ranked)
    : Object.freeze([ranked.best[0]!]);
  return Object.freeze({
    unit: selectedFrame.unit,
    frame: selectedFrame.frame,
    requiresSeparatedCoverage,
    candidates: Object.freeze(candidates)
  });
}

function validateBootstrapUnits(units: readonly string[]): ReadonlyMap<string, number> {
  if (!Array.isArray(units) || units.length < 1) {
    throw invalid("Packed-alpha witness requires readiness bootstrap units");
  }
  const order = new Map<string, number>();
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    if (typeof unit !== "string" || unit.length < 1 || order.has(unit)) {
      throw invalid("Packed-alpha witness bootstrap unit order is invalid");
    }
    order.set(unit, index);
  }
  return order;
}

function validateAndOrderFrames(
  frames: readonly Readonly<CanonicalPackedAlphaFrame>[],
  bootstrapOrder: ReadonlyMap<string, number>
): readonly Readonly<CanonicalPackedAlphaFrame>[] {
  if (!Array.isArray(frames) || frames.length < 1) {
    throw invalid("Packed-alpha witness requires canonical frames");
  }
  const identities = new Set<string>();
  const eligible: Readonly<CanonicalPackedAlphaFrame>[] = [];
  for (const candidate of frames) {
    if (typeof candidate !== "object" || candidate === null) {
      throw invalid("Packed-alpha witness canonical frame is invalid");
    }
    if (
      typeof candidate.unit !== "string" ||
      candidate.unit.length < 1 ||
      !Number.isSafeInteger(candidate.frame) ||
      candidate.frame < 0 ||
      !Number.isSafeInteger(candidate.width) ||
      !Number.isSafeInteger(candidate.height) ||
      candidate.width < 1 ||
      candidate.height < 1 ||
      !(candidate.rgba instanceof Uint16Array) ||
      candidate.rgba.length !== checkedProduct(
        candidate.width,
        candidate.height,
        CHANNELS_PER_PIXEL
      )
    ) {
      throw invalid("Packed-alpha witness canonical frame shape is invalid");
    }
    const identity = `${candidate.unit}\u0000${String(candidate.frame)}`;
    if (identities.has(identity)) {
      throw invalid("Packed-alpha witness canonical frame identity is duplicated");
    }
    identities.add(identity);
    if (bootstrapOrder.has(candidate.unit)) eligible.push(candidate);
  }
  return eligible.slice().sort((left, right) => {
    const unitOrder = bootstrapOrder.get(left.unit)! - bootstrapOrder.get(right.unit)!;
    return unitOrder === 0 ? left.frame - right.frame : unitOrder;
  });
}

interface CanonicalAlphaRange {
  readonly minimum: number;
  readonly maximum: number;
}

interface BoundedRankedCandidates {
  readonly best: readonly Readonly<PackedAlphaWitnessCandidate>[];
  readonly separatedAnchor?: Readonly<PackedAlphaWitnessCandidate>;
}

function alphaRange(
  frame: Readonly<CanonicalPackedAlphaFrame>
): Readonly<CanonicalAlphaRange> {
  let minimum = UINT8_MAXIMUM;
  let maximum = 0;
  const pixels = checkedProduct(frame.width, frame.height);
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const alpha = downconvert(
      frame.rgba[pixel * CHANNELS_PER_PIXEL + 3]!
    );
    minimum = Math.min(minimum, alpha);
    maximum = Math.max(maximum, alpha);
  }
  return Object.freeze({ minimum, maximum });
}

function boundedRankedCandidates(
  frame: Readonly<CanonicalPackedAlphaFrame>,
  range: Readonly<CanonicalAlphaRange>,
  requireSeparated: boolean
): Readonly<BoundedRankedCandidates> {
  const best: Readonly<PackedAlphaWitnessCandidate>[] = [];
  let separatedAnchor: Readonly<PackedAlphaWitnessCandidate> | undefined;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const canonicalAlpha = alphaAt(frame, x, y);
      const gradient = gradientAt(frame, x, y, canonicalAlpha);
      insertBounded(best, x, y, canonicalAlpha, gradient);
      if (
        requireSeparated &&
        canHaveSeparatedMate(canonicalAlpha, range) &&
        (
          separatedAnchor === undefined ||
          compareCandidateFacts(gradient, y, x, separatedAnchor) < 0
        )
      ) {
        separatedAnchor = createCandidate(x, y, canonicalAlpha, gradient);
      }
    }
  }
  return Object.freeze({
    best: Object.freeze(best),
    ...(separatedAnchor === undefined ? {} : { separatedAnchor })
  });
}

function retainSeparatedPool(
  frame: Readonly<CanonicalPackedAlphaFrame>,
  ranked: Readonly<BoundedRankedCandidates>
): readonly Readonly<PackedAlphaWitnessCandidate>[] {
  const anchor = ranked.separatedAnchor;
  if (anchor === undefined) {
    throw invalid("Packed-alpha witness could not retain a separated source anchor");
  }
  let mate: Readonly<PackedAlphaWitnessCandidate> | undefined;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const canonicalAlpha = alphaAt(frame, x, y);
      const gradient = gradientAt(frame, x, y, canonicalAlpha);
      if (
        Math.abs(canonicalAlpha - anchor.canonicalAlpha) >=
          PACKED_ALPHA_WITNESS_SEPARATED_ALPHA_DELTA &&
        (
          mate === undefined ||
          compareCandidateFacts(gradient, y, x, mate) < 0
        )
      ) {
        mate = createCandidate(x, y, canonicalAlpha, gradient);
      }
    }
  }
  if (mate === undefined) {
    throw invalid("Packed-alpha witness could not retain separated source candidates");
  }
  const selected = new Map<string, Readonly<PackedAlphaWitnessCandidate>>();
  for (const candidate of [anchor, mate, ...ranked.best]) {
    selected.set(`${String(candidate.x)}:${String(candidate.y)}`, candidate);
    if (selected.size === PACKED_ALPHA_WITNESS_MAX_SAMPLES) break;
  }
  return Object.freeze(
    [...selected.values()].sort(compareCandidates)
  );
}

function gradientAt(
  frame: Readonly<CanonicalPackedAlphaFrame>,
  x: number,
  y: number,
  canonicalAlpha: number
): number {
  let gradient = 0;
  if (y > 0) gradient = gradientAgainst(frame, x, y - 1, canonicalAlpha, gradient);
  if (x > 0) gradient = gradientAgainst(frame, x - 1, y, canonicalAlpha, gradient);
  if (x + 1 < frame.width) {
    gradient = gradientAgainst(frame, x + 1, y, canonicalAlpha, gradient);
  }
  if (y + 1 < frame.height) {
    gradient = gradientAgainst(frame, x, y + 1, canonicalAlpha, gradient);
  }
  return gradient;
}

function gradientAgainst(
  frame: Readonly<CanonicalPackedAlphaFrame>,
  x: number,
  y: number,
  canonicalAlpha: number,
  gradient: number
): number {
  return Math.max(
    gradient,
    Math.abs(canonicalAlpha - alphaAt(frame, x, y))
  );
}

function alphaAt(
  frame: Readonly<CanonicalPackedAlphaFrame>,
  x: number,
  y: number
): number {
  return downconvert(
    frame.rgba[(y * frame.width + x) * CHANNELS_PER_PIXEL + 3]!
  );
}

function canHaveSeparatedMate(
  alpha: number,
  range: Readonly<CanonicalAlphaRange>
): boolean {
  return alpha - range.minimum >= PACKED_ALPHA_WITNESS_SEPARATED_ALPHA_DELTA ||
    range.maximum - alpha >= PACKED_ALPHA_WITNESS_SEPARATED_ALPHA_DELTA;
}

function insertBounded(
  best: Readonly<PackedAlphaWitnessCandidate>[],
  x: number,
  y: number,
  canonicalAlpha: number,
  gradient: number
): void {
  const insertion = best.findIndex((current) =>
    compareCandidateFacts(gradient, y, x, current) < 0
  );
  if (insertion < 0) {
    if (best.length < PACKED_ALPHA_WITNESS_MAX_SAMPLES) {
      best.push(createCandidate(x, y, canonicalAlpha, gradient));
    }
    return;
  }
  best.splice(insertion, 0, createCandidate(x, y, canonicalAlpha, gradient));
  if (best.length > PACKED_ALPHA_WITNESS_MAX_SAMPLES) best.pop();
}

function createCandidate(
  x: number,
  y: number,
  canonicalAlpha: number,
  gradient: number
): Readonly<PackedAlphaWitnessCandidate> {
  return Object.freeze({ x, y, canonicalAlpha, gradient });
}

function compareCandidateFacts(
  gradient: number,
  y: number,
  x: number,
  right: Readonly<PackedAlphaWitnessCandidate>
): number {
  return gradient - right.gradient || y - right.y || x - right.x;
}

function compareCandidates(
  left: Readonly<PackedAlphaWitnessCandidate>,
  right: Readonly<PackedAlphaWitnessCandidate>
): number {
  return left.gradient - right.gradient ||
    left.y - right.y ||
    left.x - right.x;
}

function downconvert(value: number): number {
  return Math.floor((value * UINT8_MAXIMUM + 32_767) / UINT16_MAXIMUM);
}

function checkedProduct(...values: number[]): number {
  let result = 1;
  for (const value of values) {
    result *= value;
    if (!Number.isSafeInteger(result) || result < 0) {
      throw invalid("Packed-alpha witness frame size exceeds safe arithmetic");
    }
  }
  return result;
}

function invalid(message: string): CompilerError {
  return new CompilerError("INPUT_INVALID", message, { phase: "pixel-pipeline" });
}
