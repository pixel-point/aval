import { dirname } from "node:path";

import { CompilerError } from "../diagnostics.js";
import {
  DEFAULT_MEDIA_TIMEOUT_MS,
  MAX_PROCESS_OUTPUT_BYTES,
  MAX_PROCESS_STDERR_BYTES,
  MAX_SOURCE_DIMENSION,
  MAX_SOURCE_FRAMES,
  type RationalV01
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
      readonly frameRate: RationalV01;
    }
  | {
      readonly type: "raw-rgba";
      readonly path: string;
      readonly width: number;
      readonly height: number;
      readonly frameRate: RationalV01;
    };

export const FROZEN_AVC_KEYINT = 901;

export interface EncodeAvcUnitInput {
  readonly source: FfmpegFrameInput;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly frameRate: RationalV01;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly bitrate: {
    readonly average: number;
    readonly peak: number;
  };
  readonly executable?: string;
  readonly signal?: AbortSignal;
  /** Per-subprocess wall limit; may only lower the 120-second media default. */
  readonly timeoutMs?: number;
}

export interface EncodeAvcUnitInvocation {
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly stdinFile?: {
    readonly path: string;
    readonly offset: number;
    readonly length: number;
  };
}

export type FfmpegInvocation = EncodeAvcUnitInvocation;

export interface MaterializeRgbaInvocationInput {
  readonly source: FfmpegFrameInput;
  readonly sourceFrames: readonly number[];
  readonly outputWidth: number;
  readonly outputHeight: number;
}

/** Encode one independently decodable low-delay Annex B unit. */
export async function encodeAvcUnit(
  input: EncodeAvcUnitInput
): Promise<Uint8Array> {
  const invocation = createEncodeAvcUnitInvocation(input);
  const timeoutMs = mediaTimeout(input.timeoutMs);
  const result = await runBoundedProcess({
    executable: input.executable ?? "ffmpeg",
    arguments: invocation.arguments,
    cwd: invocation.cwd,
    limits: {
      timeoutMs,
      maxStdoutBytes: MAX_PROCESS_OUTPUT_BYTES,
      maxStderrBytes: MAX_PROCESS_STDERR_BYTES
    },
    privateWorkingDirectory: true,
    ...(invocation.stdinFile === undefined
      ? {}
      : { stdinFile: invocation.stdinFile }),
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  if (result.stdout.byteLength === 0) {
    throw new CompilerError("FFMPEG_FAILED", "FFmpeg emitted an empty AVC unit");
  }
  return result.stdout;
}

/** Own the exact, snapshot-testable ordered invocation for one AVC unit. */
export function createEncodeAvcUnitInvocation(
  input: EncodeAvcUnitInput
): Readonly<EncodeAvcUnitInvocation> {
  const frameCount = validateRange(input.startFrame, input.endFrame);
  const rawPipe = input.source.type === "raw-rgba";
  const arguments_ = Object.freeze([
    "-nostdin",
    "-hide_banner",
    "-loglevel", "error",
    "-xerror",
    "-max_alloc", String(64 * 1024 * 1024),
    "-protocol_whitelist", rawPipe ? "pipe" : "file,pipe",
    ...(rawPipe
      ? rawPipeArguments(input.source)
      : sourceArguments(input.source)),
    "-map", "0:v:0",
    "-an", "-sn", "-dn",
    "-map_metadata", "-1",
    "-map_chapters", "-1",
    "-vf", rawPipe
      ? rawUnitFilter(input.codedWidth, input.codedHeight)
      : unitFilter(
          input.startFrame,
          input.endFrame,
          input.frameRate,
          input.codedWidth,
          input.codedHeight
        ),
    "-frames:v", String(frameCount),
    "-fps_mode", "passthrough",
    "-c:v", "libx264",
    "-preset", "medium",
    "-tune", "zerolatency",
    "-profile:v", "baseline",
    "-level:v", "3.2",
    "-pix_fmt", "yuv420p",
    "-color_range", "tv",
    "-color_primaries", "bt709",
    "-color_trc", "bt709",
    "-colorspace", "bt709",
    "-threads", "1",
    "-filter_threads", "1",
    "-g", String(FROZEN_AVC_KEYINT),
    "-keyint_min", String(FROZEN_AVC_KEYINT),
    "-sc_threshold", "0",
    "-bf", "0",
    "-refs", "1",
    "-b:v", String(input.bitrate.average),
    "-maxrate", String(input.bitrate.peak),
    "-bufsize", String(input.bitrate.peak),
    "-x264-params",
    [
      "aud=1",
      "bframes=0",
      "cabac=0",
      "colormatrix=bt709",
      "colorprim=bt709",
      "force-cfr=1",
      `keyint=${String(FROZEN_AVC_KEYINT)}`,
      `min-keyint=${String(FROZEN_AVC_KEYINT)}`,
      "open-gop=0",
      "ref=1",
      "range=tv",
      "repeat-headers=1",
      "scenecut=0",
      "sliced-threads=0",
      "slices=1",
      "threads=1",
      "lookahead-threads=1",
      "sync-lookahead=0",
      "transfer=bt709"
    ].join(":"),
    "-f", "h264",
    "pipe:1"
  ]);
  if (!rawPipe) {
    return Object.freeze({
      arguments: arguments_,
      cwd: dirname(input.source.path)
    });
  }
  const frameBytes = checkedFrameBytes(input.source.width, input.source.height);
  const offset = checkedProduct(input.startFrame, frameBytes, "raw unit offset");
  const length = checkedProduct(frameCount, frameBytes, "raw unit length");
  return Object.freeze({
    arguments: arguments_,
    cwd: dirname(input.source.path),
    stdinFile: Object.freeze({ path: input.source.path, offset, length })
  });
}

/** Own the exact ordered sparse canonical-RGBA materialization argv. */
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
        "format=rgba"
      ].join(","),
      "-frames:v", String(sourceFrames.length),
      "-fps_mode", "passthrough",
      "-f", "rawvideo",
      "-pix_fmt", "rgba",
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
  /** Per-subprocess wall limit; may only lower the 120-second media default. */
  readonly timeoutMs?: number;
}

/** Decode one bounded half-open source range to tightly packed RGBA bytes. */
export async function extractRgbaRange(
  input: ExtractRgbaRangeInput
): Promise<readonly Uint8Array[]> {
  const frameCount = validateRange(input.startFrame, input.endFrame);
  const frameBytes = checkedFrameBytes(input.width, input.height);
  const outputBytes = frameBytes * frameCount;
  if (!Number.isSafeInteger(outputBytes) || outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
    throw new CompilerError(
      "SOURCE_LIMIT",
      "Requested RGBA extraction exceeds the process output budget"
    );
  }
  const invocation = createExtractRgbaRangeInvocation(input);
  const result = await runBoundedProcess({
    executable: input.executable ?? "ffmpeg",
    arguments: invocation.arguments,
    cwd: invocation.cwd,
    limits: {
      timeoutMs: mediaTimeout(input.timeoutMs),
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
      `RGBA extraction returned ${String(result.stdout.byteLength)} bytes; expected ${String(outputBytes)}`
    );
  }
  return Object.freeze(Array.from({ length: frameCount }, (_, index) =>
    result.stdout.slice(index * frameBytes, (index + 1) * frameBytes)
  ));
}

/** Own the exact ordered RGBA extraction argv. */
export function createExtractRgbaRangeInvocation(
  input: ExtractRgbaRangeInput
): Readonly<FfmpegInvocation> {
  const frameCount = validateRange(input.startFrame, input.endFrame);
  checkedFrameBytes(input.width, input.height);
  return Object.freeze({
    arguments: Object.freeze([
      ...decodePrefix(input.source),
      "-vf",
      [
        rangeSelection(input.startFrame, input.endFrame),
        `scale=${String(input.width)}:${String(input.height)}:flags=lanczos+accurate_rnd+full_chroma_int:in_range=auto:out_range=full:in_color_matrix=auto:out_color_matrix=bt709`,
        "setsar=1",
        "format=rgba"
      ].join(","),
      "-frames:v", String(frameCount),
      "-fps_mode", "passthrough",
      "-f", "rawvideo",
      "-pix_fmt", "rgba",
      "pipe:1"
    ]),
    cwd: dirname(input.source.path)
  });
}

export interface ExtractAlphaRangeInput {
  readonly source: FfmpegFrameInput;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly width: number;
  readonly height: number;
  readonly executable?: string;
  readonly signal?: AbortSignal;
  /** Per-subprocess wall limit; may only lower the 120-second media default. */
  readonly timeoutMs?: number;
}

/** Decode native-resolution alpha only, preserving transparency before scale. */
export async function extractAlphaRange(
  input: ExtractAlphaRangeInput
): Promise<Uint8Array> {
  const frameCount = validateRange(input.startFrame, input.endFrame);
  validateNativeDimensions(input.width, input.height);
  const frameBytes = input.width * input.height;
  const outputBytes = frameBytes * frameCount;
  if (!Number.isSafeInteger(outputBytes) || outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
    throw new CompilerError(
      "SOURCE_LIMIT",
      "Requested alpha extraction exceeds the process output budget"
    );
  }
  const invocation = createExtractAlphaRangeInvocation(input);
  const result = await runBoundedProcess({
    executable: input.executable ?? "ffmpeg",
    arguments: invocation.arguments,
    cwd: invocation.cwd,
    limits: {
      timeoutMs: mediaTimeout(input.timeoutMs),
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
      `Alpha extraction returned ${String(result.stdout.byteLength)} bytes; expected ${String(outputBytes)}`
    );
  }
  return result.stdout;
}

/** Own the exact ordered targeted alpha-plane extraction argv. */
export function createExtractAlphaRangeInvocation(
  input: ExtractAlphaRangeInput
): Readonly<FfmpegInvocation> {
  const frameCount = validateRange(input.startFrame, input.endFrame);
  validateNativeDimensions(input.width, input.height);
  return Object.freeze({
    arguments: Object.freeze([
      ...decodePrefix(input.source),
      "-vf",
      [
        rangeSelection(input.startFrame, input.endFrame),
        "format=rgba",
        "alphaextract",
        "format=gray"
      ].join(","),
      "-frames:v", String(frameCount),
      "-fps_mode", "passthrough",
      "-f", "rawvideo",
      "-pix_fmt", "gray",
      "pipe:1"
    ]),
    cwd: dirname(input.source.path)
  });
}

export interface InspectNativeAlphaInput {
  readonly source: FfmpegFrameInput;
  /** Strictly increasing source-frame indexes to inspect. */
  readonly sourceFrames: readonly number[];
  readonly executable?: string;
  readonly signal?: AbortSignal;
  /** Per-subprocess wall limit; may only lower the 120-second media default. */
  readonly timeoutMs?: number;
}

export interface NativeAlphaAudit {
  readonly inspectedFrames: number;
  readonly minimumAlpha: number;
  readonly firstFailingFrame?: number;
}

/**
 * Inspect native alpha minima using one metadata-sized FFmpeg stream.
 * No native-resolution frame plane is retained by this pass.
 */
export async function inspectNativeAlpha(
  input: InspectNativeAlphaInput
): Promise<Readonly<NativeAlphaAudit>> {
  const sourceFrames = validateSelectedFrames(input.sourceFrames);
  const invocation = createNativeAlphaAuditInvocation(input);
  const metadataLimit = Math.max(4_096, checkedProduct(
    sourceFrames.length,
    256,
    "alpha metadata output"
  ));
  const result = await runBoundedProcess({
    executable: input.executable ?? "ffmpeg",
    arguments: invocation.arguments,
    cwd: invocation.cwd,
    limits: {
      timeoutMs: mediaTimeout(input.timeoutMs),
      maxStdoutBytes: metadataLimit,
      maxStderrBytes: MAX_PROCESS_STDERR_BYTES
    },
    privateWorkingDirectory: true,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  return parseNativeAlphaMetadata(result.stdout, sourceFrames);
}

/** Own the exact ordered metadata-scale native-alpha audit argv. */
export function createNativeAlphaAuditInvocation(
  input: Pick<InspectNativeAlphaInput, "source" | "sourceFrames">
): Readonly<FfmpegInvocation> {
  const sourceFrames = validateSelectedFrames(input.sourceFrames);
  return Object.freeze({
    arguments: Object.freeze([
      ...decodePrefix(input.source),
      "-vf",
      [
        `select=${selectionExpression(sourceFrames)}`,
        "format=rgba",
        "alphaextract",
        "signalstats",
        "metadata=mode=print:key=lavfi.signalstats.YMIN:file='pipe\\:1':direct=1"
      ].join(","),
      "-frames:v", String(sourceFrames.length),
      "-fps_mode", "passthrough",
      "-f", "null",
      "-"
    ]),
    cwd: dirname(input.source.path)
  });
}

export function sourceArguments(source: FfmpegFrameInput): string[] {
  if (source.type === "video") return ["-f", "mov", "-i", source.path];
  if (source.type === "png-sequence") {
    return [
        "-f", "image2",
        "-framerate", `${String(source.frameRate.numerator)}/${String(source.frameRate.denominator)}`,
        "-start_number", String(source.firstFileNumber),
        "-i", source.path
      ];
  }
  return [
    "-f", "rawvideo",
    "-pixel_format", "rgba",
    "-video_size", `${String(source.width)}x${String(source.height)}`,
    "-framerate", `${String(source.frameRate.numerator)}/${String(source.frameRate.denominator)}`,
    "-i", source.path
  ];
}

function rawPipeArguments(
  source: Extract<FfmpegFrameInput, { readonly type: "raw-rgba" }>
): string[] {
  return [
    "-f", "rawvideo",
    "-pixel_format", "rgba",
    "-video_size", `${String(source.width)}x${String(source.height)}`,
    "-framerate", `${String(source.frameRate.numerator)}/${String(source.frameRate.denominator)}`,
    "-i", "pipe:0"
  ];
}

function rawUnitFilter(codedWidth: number, codedHeight: number): string {
  return [
    `scale=${String(codedWidth)}:${String(codedHeight)}:flags=lanczos+accurate_rnd+full_chroma_int:in_range=full:out_range=tv:in_color_matrix=bt709:out_color_matrix=bt709`,
    "setsar=1",
    "format=yuv420p"
  ].join(",");
}

function unitFilter(
  startFrame: number,
  endFrame: number,
  frameRate: RationalV01,
  codedWidth: number,
  codedHeight: number
): string {
  return [
    `select=between(n\\,${String(startFrame)}\\,${String(endFrame - 1)})`,
    `setpts=N*${String(frameRate.denominator)}/(${String(frameRate.numerator)}*TB)`,
    `scale=${String(codedWidth)}:${String(codedHeight)}:flags=lanczos+accurate_rnd+full_chroma_int:in_range=auto:out_range=tv:in_color_matrix=auto:out_color_matrix=bt709`,
    "setsar=1",
    "format=yuv420p"
  ].join(",");
}

function decodePrefix(source: FfmpegFrameInput): readonly string[] {
  return Object.freeze([
    "-nostdin",
    "-hide_banner",
    "-loglevel", "error",
    "-xerror",
    "-max_alloc", String(64 * 1024 * 1024),
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
    frames.length > MAX_SOURCE_FRAMES ||
    frames.some((frame, index) =>
      !Number.isSafeInteger(frame) ||
      frame < 0 ||
      (index > 0 && frame <= frames[index - 1]!)
    )
  ) {
    throw new CompilerError(
      "FRAME_RANGE_INVALID",
      "Native alpha frame selection must be nonempty, unique, and increasing"
    );
  }
  return frames;
}

function parseNativeAlphaMetadata(
  bytes: Uint8Array,
  sourceFrames: readonly number[]
): Readonly<NativeAlphaAudit> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new CompilerError(
      "FFMPEG_FAILED",
      "FFmpeg alpha audit returned invalid UTF-8 metadata",
      { cause: error }
    );
  }
  let count = 0;
  let minimumAlpha = 255;
  let firstFailingFrame: number | undefined;
  for (const match of text.matchAll(
    /^lavfi\.signalstats\.YMIN=(\d{1,3})\r?$/gmu
  )) {
    const value = Number(match[1]);
    if (
      count >= sourceFrames.length ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 255
    ) {
      throw new CompilerError(
        "FFMPEG_FAILED",
        "FFmpeg alpha audit returned malformed minimum metadata"
      );
    }
    minimumAlpha = Math.min(minimumAlpha, value);
    if (value !== 255 && firstFailingFrame === undefined) {
      firstFailingFrame = sourceFrames[count]!;
    }
    count += 1;
  }
  if (count !== sourceFrames.length) {
    throw new CompilerError(
      "FFMPEG_FAILED",
      `FFmpeg alpha audit returned ${String(count)} minima; expected ${String(sourceFrames.length)}`
    );
  }
  return Object.freeze({
    inspectedFrames: count,
    minimumAlpha,
    ...(firstFailingFrame === undefined ? {} : { firstFailingFrame })
  });
}

function validateNativeDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_SOURCE_DIMENSION ||
    height > MAX_SOURCE_DIMENSION
  ) {
    throw new CompilerError(
      "SOURCE_LIMIT",
      "Native alpha dimensions exceed the source limit"
    );
  }
}

export function mediaTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_MEDIA_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > DEFAULT_MEDIA_TIMEOUT_MS
  ) {
    throw new CompilerError(
      "INPUT_INVALID",
      `Media timeout must be an integer from 1 to ${String(DEFAULT_MEDIA_TIMEOUT_MS)} ms`
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

function checkedFrameBytes(width: number, height: number): number {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 512 ||
    height > 512
  ) {
    throw new CompilerError("SOURCE_LIMIT", "RGBA dimensions must fit 512×512");
  }
  return width * height * 4;
}
