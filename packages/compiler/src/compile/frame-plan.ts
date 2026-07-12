import { CompilerError } from "../diagnostics.js";
import type { MediaProbe, RationalV01 } from "../model.js";

export interface PlannedUnitRange {
  readonly id: "intro.default" | "body.default";
  readonly kind: "one-shot" | "body";
  readonly startFrame: number;
  readonly endFrame: number;
  readonly frameCount: number;
}

export interface DirectFramePlan {
  readonly frameRate: RationalV01;
  readonly units: readonly PlannedUnitRange[];
  readonly staticFrame: number;
  readonly unusedTrailingFrames: number;
  readonly warnings: readonly string[];
}

export function buildDirectFramePlan(
  probe: MediaProbe,
  loop: readonly [number, number],
  requestedFps?: RationalV01,
  normalizeVfr = false
): Readonly<DirectFramePlan> {
  const [startFrame, endFrame] = loop;
  if (
    !Number.isSafeInteger(startFrame) ||
    !Number.isSafeInteger(endFrame) ||
    startFrame < 0 ||
    endFrame <= startFrame ||
    endFrame - startFrame < 2 ||
    endFrame > 900 ||
    endFrame > probe.frameCount
  ) {
    throw new CompilerError(
      "FRAME_RANGE_INVALID",
      `Loop must contain at least two frames and satisfy 0 <= start < end <= ${String(Math.min(probe.frameCount, 900))}`,
      { field: "loop" }
    );
  }
  if (probe.variableFrameRate && !normalizeVfr) {
    throw new CompilerError(
      "VFR_UNSUPPORTED",
      "Variable-frame-rate input requires explicit --normalize-vfr and --fps",
      { hint: "Choose a rational output rate such as --fps 30/1." }
    );
  }
  if (probe.variableFrameRate && requestedFps === undefined) {
    throw new CompilerError(
      "VFR_UNSUPPORTED",
      "VFR normalization requires an explicit rational --fps"
    );
  }
  const frameRate = validateFrameRate(requestedFps ?? probe.frameRate);
  if (
    !probe.variableFrameRate &&
    requestedFps !== undefined &&
    !sameRational(requestedFps, probe.frameRate)
  ) {
    throw new CompilerError(
      "INPUT_INVALID",
      "Changing a CFR source rate requires the explicit VFR normalization path"
    );
  }

  const units: PlannedUnitRange[] = [];
  if (startFrame > 0) {
    units.push(Object.freeze({
      id: "intro.default",
      kind: "one-shot",
      startFrame: 0,
      endFrame: startFrame,
      frameCount: startFrame
    }));
  }
  units.push(Object.freeze({
    id: "body.default",
    kind: "body",
    startFrame,
    endFrame,
    frameCount: endFrame - startFrame
  }));
  const unusedTrailingFrames = probe.frameCount - endFrame;
  const warnings = unusedTrailingFrames === 0
    ? []
    : [
        `${String(unusedTrailingFrames)} trailing source frame${unusedTrailingFrames === 1 ? " is" : "s are"} unused`
      ];
  return Object.freeze({
    frameRate: Object.freeze({ ...frameRate }),
    units: Object.freeze(units),
    staticFrame: startFrame,
    unusedTrailingFrames,
    warnings: Object.freeze(warnings)
  });
}

function validateFrameRate(value: RationalV01): RationalV01 {
  if (
    !Number.isSafeInteger(value.numerator) ||
    !Number.isSafeInteger(value.denominator) ||
    value.numerator < 1 ||
    value.denominator < 1 ||
    value.denominator > 1_001
  ) {
    throw new CompilerError(
      "INPUT_INVALID",
      "Frame rate must be a positive rational no greater than 60 fps"
    );
  }
  if (
    BigInt(value.numerator) >
      BigInt(value.denominator) * 60n
  ) {
    throw new CompilerError(
      "INPUT_INVALID",
      "Frame rate must be a positive rational no greater than 60 fps"
    );
  }
  return value;
}

function sameRational(left: RationalV01, right: RationalV01): boolean {
  return BigInt(left.numerator) * BigInt(right.denominator) ===
    BigInt(right.numerator) * BigInt(left.denominator);
}
