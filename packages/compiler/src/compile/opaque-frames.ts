import { CompilerError } from "../diagnostics.js";
import {
  extractAlphaRange,
  extractRgbaRange,
  inspectNativeAlpha,
  type FfmpegFrameInput
} from "../ffmpeg/encode-unit.js";
import { MAX_SOURCE_DIMENSION, MAX_SOURCE_FRAMES } from "../model.js";

/** Reject any referenced source pixel with alpha other than 255 before scale. */
export async function scanNativeOpacity(
  source: FfmpegFrameInput,
  startFrame: number,
  endFrame: number,
  width: number,
  height: number,
  executable: string,
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<void> {
  if (
    !Number.isSafeInteger(startFrame) ||
    !Number.isSafeInteger(endFrame) ||
    startFrame < 0 ||
    endFrame <= startFrame ||
    endFrame - startFrame > MAX_SOURCE_FRAMES
  ) {
    throw new CompilerError(
      "FRAME_RANGE_INVALID",
      "Native alpha range must be nonempty and half-open"
    );
  }
  const frames = Array.from(
    { length: endFrame - startFrame },
    (_, index) => startFrame + index
  );
  await scanSelectedNativeOpacity(
    source,
    frames,
    width,
    height,
    executable,
    signal,
    timeoutMs
  );
}

/**
 * Audit exactly one ordered set of referenced native frames in one metadata
 * pass, then retain at most the first failing alpha plane for coordinates.
 */
export async function scanSelectedNativeOpacity(
  source: FfmpegFrameInput,
  sourceFrames: readonly number[],
  width: number,
  height: number,
  executable: string,
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<void> {
  const frameBytes = width * height;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_SOURCE_DIMENSION ||
    height > MAX_SOURCE_DIMENSION ||
    !Number.isSafeInteger(frameBytes)
  ) {
    throw new CompilerError("SOURCE_LIMIT", "Native alpha geometry is invalid");
  }
  const audit = await inspectNativeAlpha({
    source,
    sourceFrames,
    executable,
    ...(signal === undefined ? {} : { signal }),
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  });
  if (audit.firstFailingFrame === undefined) return;

  const alpha = await extractAlphaRange({
    source,
    startFrame: audit.firstFailingFrame,
    endFrame: audit.firstFailingFrame + 1,
    width,
    height,
    executable,
    ...(signal === undefined ? {} : { signal }),
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  });
  const pixel = alpha.findIndex((value) => value !== 255);
  if (pixel < 0) {
    throw new CompilerError(
      "FFMPEG_FAILED",
      `Alpha audit minimum for frame ${String(audit.firstFailingFrame)} did not match its targeted plane`
    );
  }
  throw new CompilerError(
    "OPAQUE_ONLY_M5",
    `Frame ${String(audit.firstFailingFrame)} contains alpha ${String(alpha[pixel])} at (${String(pixel % width)}, ${String(Math.floor(pixel / width))})`,
    { hint: "Packed alpha is introduced in M6." }
  );
}

/** Scan a bounded range for forbidden alpha and retain only named frames. */
export async function scanOpaqueFrames(
  source: FfmpegFrameInput,
  startFrame: number,
  endFrame: number,
  width: number,
  height: number,
  retain: ReadonlySet<number>,
  executable: string,
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<ReadonlyMap<number, Uint8Array>> {
  const retained = new Map<number, Uint8Array>();
  const frameBytes = width * height * 4;
  const chunkFrames = Math.max(1, Math.floor((32 * 1024 * 1024) / frameBytes));
  for (let chunkStart = startFrame; chunkStart < endFrame; chunkStart += chunkFrames) {
    const chunkEnd = Math.min(endFrame, chunkStart + chunkFrames);
    const frames = await extractRgbaRange({
      source,
      startFrame: chunkStart,
      endFrame: chunkEnd,
      width,
      height,
      executable,
      ...(signal === undefined ? {} : { signal }),
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    });
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index]!;
      const absolute = chunkStart + index;
      for (let offset = 3; offset < frame.length; offset += 4) {
        if (frame[offset] !== 255) {
          const pixel = (offset - 3) / 4;
          throw new CompilerError(
            "OPAQUE_ONLY_M5",
            `Frame ${String(absolute)} contains alpha at (${String(pixel % width)}, ${String(Math.floor(pixel / width))})`,
            { hint: "Packed alpha is introduced in M6." }
          );
        }
      }
      if (retain.has(absolute)) retained.set(absolute, frame);
    }
  }
  return retained;
}
