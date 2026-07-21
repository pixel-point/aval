import { dirname } from "node:path";

import { CompilerError } from "../diagnostics.js";
import {
  MAX_PROCESS_STDERR_BYTES,
  type Rational
} from "../model.js";
import { runBoundedProcess } from "../process-runner.js";

export type FfmpegFrameInput =
  | {
      readonly type: "video";
      readonly path: string;
    }
  | {
      readonly type: "png-sequence";
      readonly path: string;
      readonly firstFileNumber: number;
  readonly frameRate: Rational;
    }
  | {
      readonly type: "raw-rgba";
      readonly path: string;
      readonly width: number;
      readonly height: number;
      readonly frameRate: Rational;
    }
  | {
      readonly type: "raw-rgba64";
      readonly path: string;
      readonly width: number;
      readonly height: number;
      readonly frameRate: Rational;
    };

export interface FfmpegInvocation {
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly stdinFile?: {
    readonly path: string;
    readonly offset: number;
    readonly length: number;
  };
}

export interface MaterializeRgbaInvocationInput {
  readonly source: FfmpegFrameInput;
  readonly sourceFrames: readonly number[];
  readonly outputWidth: number;
  readonly outputHeight: number;
}


/** Own the exact ordered sparse canonical-RGBA16 materialization argv. */
export function createMaterializeRgbaInvocation(
  input: MaterializeRgbaInvocationInput
): Readonly<FfmpegInvocation> {
  const sourceFrames = validateSelectedFrames(input.sourceFrames);
  validateNativeDimensions(input.outputWidth, input.outputHeight);
  return Object.freeze({
    arguments: Object.freeze([
      ...decodePrefix(input.source),
      "-vf", [
        `select=${selectionExpression(sourceFrames)}`,
        `scale=${String(input.outputWidth)}:${String(input.outputHeight)}:flags=lanczos+accurate_rnd+full_chroma_int:in_range=auto:out_range=full:in_color_matrix=auto:out_color_matrix=bt709`,
        "setsar=1",
        "format=rgba64le"
      ].join(","),
      "-frames:v", String(sourceFrames.length),
      "-fps_mode", "passthrough",
      "-f", "rawvideo",
      "-pix_fmt", "rgba64le",
      "pipe:1"
    ]),
    cwd: dirname(input.source.path)
  });
}

export interface ExtractRgbaRangeInput {
  readonly source: FfmpegFrameInput;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly width: number;
  readonly height: number;
  readonly executable?: string;
  readonly signal?: AbortSignal;
  /** Optional positive per-subprocess wall limit. */
  readonly timeoutMs?: number;
}

/** Decode one bounded range to canonical little-endian RGBA16 channels. */
export async function extractRgba16Range(
  input: ExtractRgbaRangeInput
): Promise<readonly Uint16Array[]> {
  const frameCount = validateRange(input.startFrame, input.endFrame);
  const frameBytes = checkedRgba64FrameBytes(input.width, input.height);
  const outputBytes = checkedProduct(frameBytes, frameCount, "RGBA16 extraction bytes");
  const invocation = createExtractRgba16RangeInvocation(input);
  const result = await runBoundedProcess({
    executable: input.executable ?? "ffmpeg",
    arguments: invocation.arguments,
    cwd: invocation.cwd,
    limits: {
      ...(input.timeoutMs === undefined
        ? {}
        : { timeoutMs: mediaTimeout(input.timeoutMs) }),
      maxStdoutBytes: outputBytes,
      maxStderrBytes: MAX_PROCESS_STDERR_BYTES
    },
    expectedStdoutBytes: outputBytes,
    privateWorkingDirectory: true,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  if (result.stdout.byteLength !== outputBytes) {
    throw new CompilerError(
      "FFMPEG_FAILED",
      `RGBA16 extraction returned ${String(result.stdout.byteLength)} bytes; expected ${String(outputBytes)}`
    );
  }
  return Object.freeze(Array.from({ length: frameCount }, (_, index) => {
    const bytes = result.stdout.subarray(
      index * frameBytes,
      (index + 1) * frameBytes
    );
    const channels = new Uint16Array(bytes.byteLength / 2);
    for (let offset = 0; offset < bytes.byteLength; offset += 2) {
      channels[offset / 2] = bytes[offset]! | bytes[offset + 1]! << 8;
    }
    return channels;
  }));
}

/** Own the exact ordered high-bit-depth RGBA extraction argv. */
export function createExtractRgba16RangeInvocation(
  input: ExtractRgbaRangeInput
): Readonly<FfmpegInvocation> {
  const frameCount = validateRange(input.startFrame, input.endFrame);
  checkedRgba64FrameBytes(input.width, input.height);
  return Object.freeze({
    arguments: Object.freeze([
      ...decodePrefix(input.source),
      "-vf",
      [
        rangeSelection(input.startFrame, input.endFrame),
        `scale=${String(input.width)}:${String(input.height)}:flags=lanczos+accurate_rnd+full_chroma_int:in_range=auto:out_range=full:in_color_matrix=auto:out_color_matrix=bt709`,
        "setsar=1",
        "format=rgba64le"
      ].join(","),
      "-frames:v", String(frameCount),
      "-fps_mode", "passthrough",
      "-f", "rawvideo",
      "-pix_fmt", "rgba64le",
      "pipe:1"
    ]),
    cwd: dirname(input.source.path)
  });
}

export function sourceArguments(source: FfmpegFrameInput): string[] {
  switch (source.type) {
    case "video":
      return ["-f", "mov", "-i", source.path];
    case "png-sequence":
      return [
        "-f", "image2",
        "-framerate", `${String(source.frameRate.numerator)}/${String(source.frameRate.denominator)}`,
        "-start_number", String(source.firstFileNumber),
        "-i", source.path
      ];
    case "raw-rgba":
      return rawRgbaArguments(source, "rgba");
    case "raw-rgba64":
      return rawRgbaArguments(source, "rgba64le");
  }
}

function rawRgbaArguments(
  source: Extract<FfmpegFrameInput, { readonly type: "raw-rgba" | "raw-rgba64" }>,
  pixelFormat: "rgba" | "rgba64le"
): string[] {
  return [
    "-f", "rawvideo",
    "-pixel_format", pixelFormat,
    "-video_size", `${String(source.width)}x${String(source.height)}`,
    "-framerate", `${String(source.frameRate.numerator)}/${String(source.frameRate.denominator)}`,
    "-i", source.path
  ];
}

function decodePrefix(source: FfmpegFrameInput): readonly string[] {
  return Object.freeze([
    "-nostdin",
    "-hide_banner",
    "-loglevel", "error",
    "-xerror",
    "-protocol_whitelist", "file,pipe",
    ...sourceArguments(source),
    "-map", "0:v:0",
    "-an", "-sn", "-dn",
    "-map_metadata", "-1",
    "-map_chapters", "-1",
    "-threads", "1",
    "-filter_threads", "1"
  ]);
}

function rangeSelection(startFrame: number, endFrame: number): string {
  return `select=between(n\\,${String(startFrame)}\\,${String(endFrame - 1)})`;
}

function selectionExpression(frames: readonly number[]): string {
  const parts: string[] = [];
  let start = frames[0]!;
  let end = start;
  for (let index = 1; index <= frames.length; index += 1) {
    const frame = frames[index];
    if (frame === end + 1) {
      end = frame;
      continue;
    }
    parts.push(start === end
      ? `eq(n\\,${String(start)})`
      : `between(n\\,${String(start)}\\,${String(end)})`);
    if (frame !== undefined) {
      start = frame;
      end = frame;
    }
  }
  return parts.join("+");
}

function validateSelectedFrames(frames: readonly number[]): readonly number[] {
  if (
    frames.length < 1 ||
    frames.some((frame, index) =>
      !Number.isSafeInteger(frame) ||
      frame < 0 ||
      (index > 0 && frame <= frames[index - 1]!)
    )
  ) {
    throw new CompilerError(
      "FRAME_RANGE_INVALID",
      "RGBA frame selection must be nonempty, unique, and increasing"
    );
  }
  return frames;
}

function validateNativeDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new CompilerError(
      "INPUT_INVALID",
      "RGBA materialization dimensions must be positive safe integers"
    );
  }
}

export function mediaTimeout(timeoutMs: number): number;
export function mediaTimeout(timeoutMs: undefined): undefined;
export function mediaTimeout(timeoutMs: number | undefined): number | undefined;
export function mediaTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined;
  const value = timeoutMs;
  if (
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new CompilerError(
      "INPUT_INVALID",
      "Media timeout must be a positive safe integer in milliseconds"
    );
  }
  return value;
}

function checkedProduct(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new CompilerError("SOURCE_LIMIT", `${label} exceeds the safe range`);
  }
  return result;
}

function validateRange(startFrame: number, endFrame: number): number {
  if (
    !Number.isSafeInteger(startFrame) ||
    !Number.isSafeInteger(endFrame) ||
    startFrame < 0 ||
    endFrame <= startFrame
  ) {
    throw new CompilerError(
      "FRAME_RANGE_INVALID",
      "Frame range must be nonempty, nonnegative, and half-open"
    );
  }
  return endFrame - startFrame;
}

function checkedRgba64FrameBytes(width: number, height: number): number {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new CompilerError(
      "INPUT_INVALID",
      "RGBA16 dimensions must be positive safe integers"
    );
  }
  return checkedProduct(
    checkedProduct(width, height, "RGBA16 pixels"),
    8,
    "RGBA16 frame bytes"
  );
}
