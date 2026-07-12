import { CompilerError } from "../diagnostics.js";
import type { MediaProbeFrame, RationalV01 } from "../model.js";

export interface NormalizedTimeline {
  readonly sourceFrameByOutputFrame: readonly number[];
  readonly duplicatedSourceFrames: readonly number[];
  readonly droppedSourceFrames: readonly number[];
}

/** Deterministic hold normalization: latest source PTS <= each target tick. */
export function normalizeHoldTimeline(
  frames: readonly MediaProbeFrame[],
  frameRate: RationalV01,
  timeBase: RationalV01,
  maximumFrames = 1_800
): Readonly<NormalizedTimeline> {
  if (frames.length < 1) {
    throw new CompilerError("VFR_UNSUPPORTED", "Cannot normalize an empty timeline");
  }
  const firstPts = BigInt(frames[0]!.timestampTicks);
  const last = frames.at(-1)!;
  const endTicks =
    BigInt(last.timestampTicks) - firstPts + BigInt(last.durationTicks);
  const mapping: number[] = [];
  let sourceIndex = 0;
  for (let outputIndex = 0; outputIndex < maximumFrames; outputIndex += 1) {
    const targetScale =
      BigInt(outputIndex) *
      BigInt(frameRate.denominator) *
      BigInt(timeBase.denominator);
    const sourceScale =
      BigInt(timeBase.numerator) * BigInt(frameRate.numerator);
    if (targetScale >= endTicks * sourceScale) break;
    while (
      sourceIndex + 1 < frames.length &&
      (BigInt(frames[sourceIndex + 1]!.timestampTicks) - firstPts) * sourceScale <=
        targetScale
    ) {
      sourceIndex += 1;
    }
    mapping.push(sourceIndex);
  }
  if (mapping.length === maximumFrames) {
    const nextScale =
      BigInt(maximumFrames) *
      BigInt(frameRate.denominator) *
      BigInt(timeBase.denominator);
    const sourceScale =
      BigInt(timeBase.numerator) * BigInt(frameRate.numerator);
    if (nextScale < endTicks * sourceScale) {
      throw new CompilerError(
        "SOURCE_LIMIT",
        `Normalized timeline exceeds ${String(maximumFrames)} frames`
      );
    }
  }
  const counts = new Map<number, number>();
  for (const source of mapping) counts.set(source, (counts.get(source) ?? 0) + 1);
  const duplicatedSourceFrames = [...counts]
    .filter(([, count]) => count > 1)
    .map(([index]) => index);
  const droppedSourceFrames = frames.flatMap((_, index) =>
    counts.has(index) ? [] : [index]
  );
  return Object.freeze({
    sourceFrameByOutputFrame: Object.freeze(mapping),
    duplicatedSourceFrames: Object.freeze(duplicatedSourceFrames),
    droppedSourceFrames: Object.freeze(droppedSourceFrames)
  });
}
