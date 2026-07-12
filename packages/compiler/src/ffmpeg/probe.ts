import { dirname } from "node:path";

import { CompilerError } from "../diagnostics.js";
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  MAX_PROCESS_STDERR_BYTES,
  MAX_SOURCE_DIMENSION,
  MAX_SOURCE_DURATION_SECONDS,
  MAX_SOURCE_FRAMES,
  type MediaProbe,
  type MediaProbeFrame,
  type RationalV01
} from "../model.js";
import { runBoundedProcess } from "../process-runner.js";

const PROBE_OUTPUT_LIMIT = 4 * 1024 * 1024;
const ALLOWED_FORMATS = new Set([
  "mov,mp4,m4a,3gp,3g2,mj2",
  "image2",
  "png_pipe"
]);

interface ProbeJson {
  readonly frames?: readonly Record<string, unknown>[];
  readonly streams?: readonly Record<string, unknown>[];
  readonly format?: Record<string, unknown>;
}

export async function probeMedia(
  inputPath: string,
  executable = "ffprobe",
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<Readonly<MediaProbe>> {
  const invocation = createProbeMediaInvocation(inputPath);
  const result = await runBoundedProcess({
    executable,
    arguments: invocation.arguments,
    cwd: invocation.cwd,
    limits: {
      timeoutMs: probeTimeout(timeoutMs),
      maxStdoutBytes: PROBE_OUTPUT_LIMIT,
      maxStderrBytes: MAX_PROCESS_STDERR_BYTES
    },
    privateWorkingDirectory: true,
    ...(signal === undefined ? {} : { signal })
  });
  return parseProbeJson(
    new TextDecoder().decode(result.stdout),
    inputPath,
    { sourceKind: "video" }
  );
}

export async function probePngSequence(
  pattern: string,
  firstFileNumber: number,
  frameRate: RationalV01,
  executable = "ffprobe",
  signal?: AbortSignal,
  frameCount?: number,
  timeoutMs?: number
): Promise<Readonly<MediaProbe>> {
  const invocation = createProbePngSequenceInvocation(
    pattern,
    firstFileNumber,
    frameRate,
    frameCount
  );
  const result = await runBoundedProcess({
    executable,
    arguments: invocation.arguments,
    cwd: invocation.cwd,
    limits: {
      timeoutMs: probeTimeout(timeoutMs),
      maxStdoutBytes: PROBE_OUTPUT_LIMIT,
      maxStderrBytes: MAX_PROCESS_STDERR_BYTES
    },
    privateWorkingDirectory: true,
    ...(signal === undefined ? {} : { signal })
  });
  return parseProbeJson(
    new TextDecoder().decode(result.stdout),
    pattern,
    { sourceKind: "png-sequence" }
  );
}

export interface ProbeInvocation {
  readonly arguments: readonly string[];
  readonly cwd: string;
}

/** Own the exact ordered local-video probe argv. */
export function createProbeMediaInvocation(
  inputPath: string
): Readonly<ProbeInvocation> {
  return Object.freeze({
    arguments: Object.freeze(probeArguments(
      ["-f", "mov"],
      ["-read_intervals", `%+${String(MAX_SOURCE_DURATION_SECONDS + 1)}`],
      inputPath
    )),
    cwd: dirname(inputPath)
  });
}

/** Own the exact ordered PNG-sequence probe argv. */
export function createProbePngSequenceInvocation(
  pattern: string,
  firstFileNumber: number,
  frameRate: RationalV01,
  frameCount?: number
): Readonly<ProbeInvocation> {
  if (!Number.isSafeInteger(firstFileNumber) || firstFileNumber < 0) {
    throw new CompilerError("INPUT_INVALID", "PNG first file number is invalid");
  }
  if (
    !Number.isSafeInteger(frameRate.numerator) ||
    !Number.isSafeInteger(frameRate.denominator) ||
    frameRate.numerator < 1 ||
    frameRate.denominator < 1
  ) {
    throw new CompilerError("INPUT_INVALID", "PNG frame rate is invalid");
  }
  if (
    frameCount !== undefined &&
    (!Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > MAX_SOURCE_FRAMES)
  ) {
    throw new CompilerError("INPUT_INVALID", "PNG probe frame count is invalid");
  }
  return Object.freeze({
    arguments: Object.freeze(probeArguments(
      [
        "-f", "image2",
        "-framerate", `${String(frameRate.numerator)}/${String(frameRate.denominator)}`,
        "-start_number", String(firstFileNumber)
      ],
      frameCount === undefined
        ? []
        : ["-read_intervals", `%+#${String(frameCount)}`],
      pattern
    )),
    cwd: dirname(pattern)
  });
}

function probeArguments(
  inputArguments: readonly string[],
  intervalArguments: readonly string[],
  inputPath: string
): string[] {
  return [
    "-v", "error",
    "-max_alloc", String(64 * 1024 * 1024),
    "-protocol_whitelist", "file,pipe",
    "-analyzeduration", "10000000",
    "-probesize", String(32 * 1024 * 1024),
    "-threads", "1",
    ...inputArguments,
    "-select_streams", "v",
    ...intervalArguments,
    "-show_entries",
    "stream=index,width,height,pix_fmt,avg_frame_rate,r_frame_rate,time_base,nb_frames,duration,field_order,sample_aspect_ratio:stream_side_data=rotation:format=format_name,duration:frame=stream_index,best_effort_timestamp,duration",
    "-of", "json",
    inputPath
  ];
}

export function probeTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > DEFAULT_PROBE_TIMEOUT_MS
  ) {
    throw new CompilerError(
      "INPUT_INVALID",
      `Probe timeout must be an integer from 1 to ${String(DEFAULT_PROBE_TIMEOUT_MS)} ms`
    );
  }
  return value;
}

export function parseProbeJson(
  json: string,
  inputPath = "source",
  options: { readonly sourceKind?: "video" | "png-sequence" } = {}
): Readonly<MediaProbe> {
  let parsed: ProbeJson;
  try {
    parsed = JSON.parse(json) as ProbeJson;
  } catch (error) {
    throw new CompilerError("FFMPEG_FAILED", "FFprobe returned invalid JSON", {
      path: inputPath,
      cause: error
    });
  }
  const stream = exactlyOne(parsed.streams, "video stream", inputPath);
  const width = positiveInteger(stream.width, "stream.width", inputPath);
  const height = positiveInteger(stream.height, "stream.height", inputPath);
  validateScanGeometry(stream, inputPath, options.sourceKind ?? "video");
  if (width > MAX_SOURCE_DIMENSION || height > MAX_SOURCE_DIMENSION) {
    throw new CompilerError(
      "SOURCE_LIMIT",
      `Source dimensions ${String(width)}×${String(height)} exceed ${String(MAX_SOURCE_DIMENSION)}×${String(MAX_SOURCE_DIMENSION)}`,
      { path: inputPath }
    );
  }
  const pixelFormat = stringValue(stream.pix_fmt, "stream.pix_fmt", inputPath);
  const frameRate = parseRational(
    stringValue(stream.avg_frame_rate, "stream.avg_frame_rate", inputPath),
    "stream.avg_frame_rate"
  );
  const nominalFrameRate = parseRational(
    stringValue(stream.r_frame_rate, "stream.r_frame_rate", inputPath),
    "stream.r_frame_rate"
  );
  const timeBase = parseRational(
    stringValue(stream.time_base, "stream.time_base", inputPath),
    "stream.time_base"
  );
  if (
    BigInt(frameRate.numerator) >
      BigInt(frameRate.denominator) * 60n
  ) {
    throw new CompilerError("SOURCE_LIMIT", "Source frame rate exceeds 60 fps", {
      path: inputPath
    });
  }

  const sourceFrames = Array.isArray(parsed.frames) ? parsed.frames : [];
  if (sourceFrames.length === 0) {
    throw new CompilerError("INPUT_INVALID", "Source contains no decoded video frames", {
      path: inputPath
    });
  }
  if (sourceFrames.length > MAX_SOURCE_FRAMES) {
    throw new CompilerError(
      "SOURCE_LIMIT",
      `Source exceeds ${String(MAX_SOURCE_FRAMES)} frames`,
      { path: inputPath }
    );
  }
  const frames: MediaProbeFrame[] = sourceFrames.map((frame, index) => {
    const timestamp = signedSafeInteger(
      frame.best_effort_timestamp,
      `frames[${String(index)}].best_effort_timestamp`,
      inputPath
    );
    const duration = positiveSafeInteger(
      frame.duration,
      `frames[${String(index)}].duration`,
      inputPath
    );
    return Object.freeze({
      index,
      timestampTicks: timestamp,
      durationTicks: duration
    });
  });
  for (let index = 1; index < frames.length; index += 1) {
    if (frames[index]!.timestampTicks <= frames[index - 1]!.timestampTicks) {
      throw new CompilerError(
        "INPUT_INVALID",
        "Source frame timestamps must increase strictly",
        { path: inputPath, field: `frames[${String(index)}]` }
      );
    }
  }

  const formatName = parsed.format?.format_name;
  if (typeof formatName !== "string" || !ALLOWED_FORMATS.has(formatName)) {
    throw new CompilerError(
      "INPUT_INVALID",
      `Unsupported local demuxer ${String(formatName)}`,
      { path: inputPath }
    );
  }
  const durationText =
    typeof stream.duration === "string"
      ? stream.duration
      : parsed.format?.duration;
  const exactDurationTicks =
    BigInt(frames.at(-1)!.timestampTicks) -
    BigInt(frames[0]!.timestampTicks) +
    BigInt(frames.at(-1)!.durationTicks);
  if (
    exactDurationTicks * BigInt(timeBase.numerator) >
    BigInt(MAX_SOURCE_DURATION_SECONDS) * BigInt(timeBase.denominator)
  ) {
    throw new CompilerError(
      "SOURCE_LIMIT",
      `Source duration exceeds ${String(MAX_SOURCE_DURATION_SECONDS)} seconds`,
      { path: inputPath }
    );
  }

  const variableFrameRate =
    !sameRational(frameRate, nominalFrameRate) ||
    !hasExactCfrGrid(frames, frameRate, timeBase);
  if (
    typeof durationText === "string" &&
    decimalSecondsExceed(durationText, MAX_SOURCE_DURATION_SECONDS)
  ) {
    throw new CompilerError(
      "SOURCE_LIMIT",
      `Source duration exceeds ${String(MAX_SOURCE_DURATION_SECONDS)} seconds`,
      { path: inputPath }
    );
  }
  const durationMicros = typeof durationText === "string"
    ? decimalSecondsToMicros(durationText)
    : rationalTicksToMicros(exactDurationTicks, timeBase);
  return Object.freeze({
    width,
    height,
    frameRate: Object.freeze(frameRate),
    timeBase: Object.freeze(timeBase),
    frameCount: frames.length,
    durationMicros,
    pixelFormat,
    // FFmpeg's indexed `pal8` may carry per-entry tRNS transparency even
    // though the pixel-format name has no alpha letter. Packed AYUV/VUYA and
    // the planar/packed alpha families likewise require a native audit.
    hasAlpha: /^(?:pal8|rgba|bgra|argb|abgr|yuva|gbrap|ya|ayuv|vuya)/iu.test(
      pixelFormat
    ),
    variableFrameRate,
    frames: Object.freeze(frames)
  });
}

function validateScanGeometry(
  stream: Record<string, unknown>,
  inputPath: string,
  sourceKind: "video" | "png-sequence"
): void {
  if (
    stream.sample_aspect_ratio !== "1:1" &&
    !(sourceKind === "png-sequence" && stream.sample_aspect_ratio === undefined)
  ) {
    throw new CompilerError(
      "INPUT_INVALID",
      "Source pixels must be square (sample_aspect_ratio 1:1)",
      { path: inputPath, field: "stream.sample_aspect_ratio" }
    );
  }
  if (
    sourceKind === "video" &&
    stream.field_order !== "progressive"
  ) {
    throw new CompilerError(
      "INPUT_INVALID",
      "Source video must explicitly report progressive scan",
      { path: inputPath, field: "stream.field_order" }
    );
  }
  const sideData = stream.side_data_list;
  if (sideData === undefined) return;
  if (!Array.isArray(sideData)) {
    throw new CompilerError(
      "FFMPEG_FAILED",
      "FFprobe stream side-data list is malformed",
      { path: inputPath }
    );
  }
  for (const entry of sideData) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new CompilerError(
        "FFMPEG_FAILED",
        "FFprobe stream side-data entry is malformed",
        { path: inputPath }
      );
    }
    const rotation = (entry as Record<string, unknown>).rotation;
    if (rotation === undefined) continue;
    const numeric = typeof rotation === "number"
      ? rotation
      : typeof rotation === "string" && /^-?\d+(?:\.\d+)?$/u.test(rotation)
        ? Number(rotation)
        : Number.NaN;
    if (!Number.isFinite(numeric) || numeric !== 0) {
      throw new CompilerError(
        "INPUT_INVALID",
        "Source rotation metadata must be zero",
        { path: inputPath, field: "stream.side_data_list.rotation" }
      );
    }
  }
}

export function parseRational(value: string, field: string): RationalV01 {
  const match = /^(\d+)\/(\d+)$/u.exec(value);
  if (match === null) {
    throw new CompilerError("INPUT_INVALID", `${field} must be a rational p/q`);
  }
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator < 1 ||
    denominator < 1
  ) {
    throw new CompilerError("INPUT_INVALID", `${field} is outside the safe rational range`);
  }
  const divisor = gcd(numerator, denominator);
  return Object.freeze({
    numerator: numerator / divisor,
    denominator: denominator / divisor
  });
}

export function decimalSecondsToMicros(value: string): number {
  const { numerator: seconds, scale } = parseDecimalSeconds(value);
  const numerator = seconds * 1_000_000n;
  const rounded = (numerator + scale / 2n) / scale;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CompilerError("SOURCE_LIMIT", "Timestamp exceeds safe microseconds");
  }
  return Number(rounded);
}

function decimalSecondsExceed(value: string, maximumSeconds: number): boolean {
  const { numerator, scale } = parseDecimalSeconds(value);
  return numerator > BigInt(maximumSeconds) * scale;
}

function parseDecimalSeconds(value: string): {
  readonly numerator: bigint;
  readonly scale: bigint;
} {
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(value);
  if (match === null) {
    throw new CompilerError("INPUT_INVALID", "Invalid nonnegative decimal timestamp");
  }
  const whole = BigInt(match[1] ?? "0");
  const fractionText = match[2] ?? "";
  const scale = 10n ** BigInt(fractionText.length);
  const fraction = BigInt(fractionText === "" ? "0" : fractionText);
  return Object.freeze({ numerator: whole * scale + fraction, scale });
}

function hasExactCfrGrid(
  frames: readonly MediaProbeFrame[],
  frameRate: RationalV01,
  timeBase: RationalV01
): boolean {
  const first = frames[0]!.timestampTicks;
  const frameScale =
    BigInt(frameRate.numerator) * BigInt(timeBase.numerator);
  const expectedScale =
    BigInt(frameRate.denominator) * BigInt(timeBase.denominator);
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]!;
    if (
      (BigInt(frame.timestampTicks) - BigInt(first)) * frameScale !==
        BigInt(index) * expectedScale ||
      BigInt(frame.durationTicks) * frameScale !== expectedScale
    ) {
      return false;
    }
  }
  return true;
}

function rationalTicksToMicros(
  ticks: bigint,
  timeBase: RationalV01
): number {
  const numerator =
    ticks * BigInt(timeBase.numerator) * 1_000_000n;
  const denominator = BigInt(timeBase.denominator);
  const rounded = (numerator + denominator / 2n) / denominator;
  if (rounded < 0n || rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CompilerError("SOURCE_LIMIT", "Duration exceeds safe microseconds");
  }
  return Number(rounded);
}

function sameRational(left: RationalV01, right: RationalV01): boolean {
  return left.numerator === right.numerator &&
    left.denominator === right.denominator;
}

function exactlyOne(
  value: unknown,
  label: string,
  path: string
): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new CompilerError("INPUT_INVALID", `Source must contain exactly one ${label}`, {
      path
    });
  }
  const item: unknown = value[0];
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    throw new CompilerError("FFMPEG_FAILED", `FFprobe ${label} is malformed`, { path });
  }
  return item as Record<string, unknown>;
}

function positiveInteger(value: unknown, field: string, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new CompilerError("INPUT_INVALID", `${field} must be a positive integer`, {
      path,
      field
    });
  }
  return value;
}

function stringValue(value: unknown, field: string, path: string): string {
  if (typeof value !== "string") {
    throw new CompilerError("FFMPEG_FAILED", `${field} must be a string`, {
      path,
      field
    });
  }
  return value;
}

function signedSafeInteger(value: unknown, field: string, path: string): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^-?\d+$/u.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    throw new CompilerError("FFMPEG_FAILED", `${field} must be a safe integer`, {
      path,
      field
    });
  }
  return parsed;
}

function positiveSafeInteger(value: unknown, field: string, path: string): number {
  const parsed = signedSafeInteger(value, field, path);
  if (parsed < 1) {
    throw new CompilerError("INPUT_INVALID", `${field} must be positive`, {
      path,
      field
    });
  }
  return parsed;
}

function gcd(left: number, right: number): number {
  let a = BigInt(left);
  let b = BigInt(right);
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return Number(a);
}
