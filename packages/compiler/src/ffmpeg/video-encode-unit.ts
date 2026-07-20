import { dirname } from "node:path";

import type {
  VideoRenditionGeometry
} from "@pixel-point/aval-format";
import {
  h264LevelLimits,
  h264LevelName,
  minimumH264CompatibilityLevel
} from "@pixel-point/aval-format";
import type {
  NormalizedSourceRenditionTarget,
  NormalizedVideoEncoding,
  Rational,
  VideoCodec
} from "../model.js";
import {
  MAX_PROCESS_OUTPUT_BYTES,
  MAX_PROCESS_STDERR_BYTES
} from "../model.js";
import { videoCompressionArguments } from "../compile/video-encoding-policy.js";
import { CompilerError } from "../diagnostics.js";
import { runBoundedProcess } from "../process-runner.js";
import { parseIvf, type IvfFrame } from "./ivf.js";

export interface RawYuv420FrameSource {
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly bitDepth: 8 | 10;
  readonly frameRate: Rational;
  readonly frameBytes: number;
}

export interface EncodeVideoUnitInput {
  readonly source: Readonly<RawYuv420FrameSource>;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly encoding: Readonly<NormalizedVideoEncoding>;
  readonly rendition: Readonly<NormalizedSourceRenditionTarget>;
  readonly geometry: Readonly<VideoRenditionGeometry>;
}

export interface EncodeVideoUnitInvocation {
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly stdinFile: {
    readonly path: string;
    readonly offset: number;
    readonly length: number;
  };
}

export interface EncodeIvfVideoUnitInput extends EncodeVideoUnitInput {
  readonly encoding: Extract<NormalizedVideoEncoding, { readonly codec: "vp9" | "av1" }>;
  readonly executable?: string;
  readonly signal?: AbortSignal;
  /** Optional positive subprocess wall limit. No timeout is applied when absent. */
  readonly timeoutMs?: number;
  readonly maximumOutputBytes?: number;
}

export interface EncodeElementaryVideoUnitInput extends EncodeVideoUnitInput {
  readonly encoding: Extract<NormalizedVideoEncoding, { readonly codec: "h264" | "h265" }>;
  readonly executable?: string;
  readonly signal?: AbortSignal;
  /** Optional positive subprocess wall limit. No timeout is applied when absent. */
  readonly timeoutMs?: number;
  readonly maximumOutputBytes?: number;
}

export interface EncodedIvfVideoUnit {
  readonly codec: "vp9" | "av1";
  readonly timeBase: {
    readonly numerator: number;
    readonly denominator: number;
  };
  /** IVF record order is decoder submission order; IVF headers are discarded. */
  readonly packets: readonly IvfFrame[];
}

/** Encode one H.264/H.265 closed unit as a bounded elementary stream. */
export async function encodeElementaryVideoUnit(
  input: Readonly<EncodeElementaryVideoUnitInput>
): Promise<Uint8Array> {
  const invocation = createEncodeVideoUnitInvocation(input);
  const maximumOutputBytes = outputBudget(
    input,
    input.endFrame - input.startFrame
  );
  const result = await runBoundedProcess({
    executable: input.executable ?? "ffmpeg",
    arguments: invocation.arguments,
    cwd: invocation.cwd,
    stdinFile: invocation.stdinFile,
    limits: {
      maxStdoutBytes: maximumOutputBytes,
      maxStderrBytes: MAX_PROCESS_STDERR_BYTES,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
    },
    privateWorkingDirectory: true,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  if (result.stdout.byteLength < 1) {
    throw new CompilerError(
      "FFMPEG_FAILED",
      `FFmpeg emitted an empty ${input.encoding.codec} elementary unit`,
      { phase: "encode" }
    );
  }
  return result.stdout;
}

/** Encode VP9/AV1 and strip the bounded IVF stdout transport immediately. */
export async function encodeIvfVideoUnit(
  input: Readonly<EncodeIvfVideoUnitInput>
): Promise<Readonly<EncodedIvfVideoUnit>> {
  const invocation = createEncodeVideoUnitInvocation(input);
  const frameCount = input.endFrame - input.startFrame;
  const maximumOutputBytes = outputBudget(input, frameCount);
  const result = await runBoundedProcess({
    executable: input.executable ?? "ffmpeg",
    arguments: invocation.arguments,
    cwd: invocation.cwd,
    stdinFile: invocation.stdinFile,
    limits: {
      maxStdoutBytes: maximumOutputBytes,
      maxStderrBytes: MAX_PROCESS_STDERR_BYTES,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
    },
    privateWorkingDirectory: true,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  const parsed = parseIvf(result.stdout, {
    expectedCodec: input.encoding.codec,
    expectedWidth: input.source.width,
    expectedHeight: input.source.height,
    maximumFrames: checkedProduct(frameCount, 4, "IVF frame budget"),
    maximumFrameBytes: maximumOutputBytes
  });
  if (
    parsed.timeBase.numerator * input.source.frameRate.numerator !==
    parsed.timeBase.denominator * input.source.frameRate.denominator
  ) {
    throw new CompilerError(
      "FFMPEG_FAILED",
      "IVF time base does not match the requested frame rate",
      { phase: "encode" }
    );
  }
  return Object.freeze({
    codec: parsed.codec,
    timeBase: parsed.timeBase,
    packets: parsed.frames
  });
}

/** Create the exact shell-free FFmpeg invocation for one closed graph unit. */
export function createEncodeVideoUnitInvocation(
  input: Readonly<EncodeVideoUnitInput>
): Readonly<EncodeVideoUnitInvocation> {
  const frameCount = validate(input);
  const sourcePixelFormat = input.source.bitDepth === 10
    ? "yuv420p10le"
    : "yuv420p";
  const arguments_ = Object.freeze([
    "-nostdin",
    "-hide_banner",
    "-loglevel", "error",
    "-xerror",
    "-protocol_whitelist", "pipe",
    "-f", "rawvideo",
    "-pixel_format", sourcePixelFormat,
    "-video_size", `${String(input.source.width)}x${String(input.source.height)}`,
    "-framerate",
    `${String(input.source.frameRate.numerator)}/${String(input.source.frameRate.denominator)}`,
    "-i", "pipe:0",
    "-map", "0:v:0",
    "-an", "-sn", "-dn",
    "-map_metadata", "-1",
    "-map_chapters", "-1",
    "-frames:v", String(frameCount),
    "-fps_mode", "passthrough",
    "-c:v", encoder(input.encoding.codec),
    ...videoCompressionArguments(input.encoding, input.rendition),
    ...(input.encoding.codec === "av1" ? [] : ["-pix_fmt", "yuv420p"]),
    "-color_range", "tv",
    "-color_primaries", "bt709",
    "-color_trc", "bt709",
    "-colorspace", "bt709",
    "-g", String(frameCount),
    "-keyint_min", String(frameCount),
    "-sc_threshold", "0",
    ...codecArguments(
      input.encoding.codec,
      frameCount,
      input.geometry,
      input.source.frameRate
    ),
    "-f", outputFormat(input.encoding.codec),
    "pipe:1"
  ]);
  const offset = checkedProduct(input.startFrame, input.source.frameBytes, "unit byte offset");
  const length = checkedProduct(frameCount, input.source.frameBytes, "unit byte length");
  return Object.freeze({
    arguments: arguments_,
    cwd: dirname(input.source.path),
    stdinFile: Object.freeze({ path: input.source.path, offset, length })
  });
}

function validate(input: Readonly<EncodeVideoUnitInput>): number {
  if (typeof input !== "object" || input === null) {
    throw invalid("Video encode input must be an object");
  }
  const { source, encoding, rendition } = input;
  if (typeof source !== "object" || source === null) {
    throw invalid("Video encode source must be an object");
  }
  if (typeof source.path !== "string" || source.path.length === 0) {
    throw invalid("Video encode source path must be nonempty");
  }
  for (const [label, value] of [
    ["width", source.width],
    ["height", source.height],
    ["frame-rate numerator", source.frameRate?.numerator],
    ["frame-rate denominator", source.frameRate?.denominator]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw invalid(`Video encode ${label} must be a positive safe integer`);
    }
  }
  if (source.width % 2 !== 0 || source.height % 2 !== 0) {
    throw invalid("Video encode dimensions must be even for YUV420");
  }
  if (typeof rendition !== "object" || rendition === null) {
    throw invalid("Video encode rendition must be an object");
  }
  const geometry = input.geometry;
  if (
    typeof geometry !== "object" ||
    geometry === null ||
    geometry.codedWidth !== source.width ||
    geometry.codedHeight !== source.height ||
    geometry.visibleColorRect[2] !== rendition.width ||
    geometry.visibleColorRect[3] !== rendition.height
  ) {
    throw invalid("Video encode source and visible dimensions must match the shared geometry");
  }
  if (typeof encoding !== "object" || encoding === null) {
    throw invalid("Video encoding policy must be an object");
  }
  const expectedBitDepth = encoding.codec === "av1" ? encoding.bitDepth : 8;
  if (source.bitDepth !== expectedBitDepth) {
    throw invalid("Video source bit depth does not match the codec policy");
  }
  const policyRendition = encoding.renditions.find((candidate) => candidate.id === rendition.id);
  if (
    policyRendition === undefined ||
    policyRendition.width !== rendition.width ||
    policyRendition.height !== rendition.height ||
    policyRendition.crf !== rendition.crf
  ) {
    throw invalid("Video rendition is not owned by the codec policy");
  }
  const bytesPerSample = source.bitDepth === 10 ? 2 : 1;
  const expectedFrameBytes = checkedProduct(
    checkedProduct(source.width, source.height, "YUV frame pixels"),
    3,
    "YUV frame components"
  ) / 2 * bytesPerSample;
  if (!Number.isSafeInteger(expectedFrameBytes) || source.frameBytes !== expectedFrameBytes) {
    throw invalid("Video source frame byte count does not match its dimensions and bit depth");
  }
  if (
    !Number.isSafeInteger(input.startFrame) ||
    !Number.isSafeInteger(input.endFrame) ||
    input.startFrame < 0 ||
    input.endFrame <= input.startFrame
  ) {
    throw invalid("Video unit frame range must be nonempty, nonnegative, and half-open");
  }
  return input.endFrame - input.startFrame;
}

function encoder(codec: VideoCodec): string {
  switch (codec) {
    case "h264": return "libx264";
    case "h265": return "libx265";
    case "vp9": return "libvpx-vp9";
    case "av1": return "libaom-av1";
  }
}

function outputFormat(codec: VideoCodec): "h264" | "hevc" | "ivf" {
  switch (codec) {
    case "h264": return "h264";
    case "h265": return "hevc";
    case "vp9":
    case "av1":
      return "ivf";
  }
}

function codecArguments(
  codec: VideoCodec,
  frameCount: number,
  geometry: Readonly<VideoRenditionGeometry>,
  frameRate: Readonly<Rational>
): readonly string[] {
  switch (codec) {
    case "h264": {
      const cropRect = h264CropRect(geometry);
      const levelIdc = minimumH264CompatibilityLevel({
        codedWidth: geometry.codedWidth,
        codedHeight: geometry.codedHeight,
        frameRate,
        // Level 1.0 cannot admit the quality-preserving production floor used
        // by independently encoded interactive units.
        maximumBitrate: 192_000,
        maximumCpbBits: 500_000
      });
      const level = h264LevelLimits(levelIdc);
      return [
        "-profile:v", "baseline",
        "-level:v", h264LevelName(levelIdc),
        "-bf", "0",
        "-refs", "1",
        "-maxrate", String(level.maximumBitrate),
        "-bufsize", String(level.maximumCpbBits),
        "-x264-params",
        [
          "8x8dct=0",
          "aud=1",
          "bframes=0",
          "cabac=0",
          "colorprim=bt709",
          "colormatrix=bt709",
          `crop-rect=${cropRect.join(",")}`,
          "force-cfr=1",
          `keyint=${String(frameCount)}`,
          `min-keyint=${String(frameCount)}`,
          "open-gop=0",
          "range=tv",
          "ref=1",
          "repeat-headers=1",
          "scenecut=0",
          "transfer=bt709",
          "weightp=0"
        ].join(":")
      ];
    }
    case "h265":
      return [
        "-profile:v", "main",
        "-x265-params",
        [
          "aud=1",
          "colorprim=bt709",
          "colormatrix=bt709",
          `keyint=${String(frameCount)}`,
          `min-keyint=${String(frameCount)}`,
          "open-gop=0",
          "range=limited",
          "repeat-headers=1",
          "scenecut=0",
          "transfer=bt709"
        ].join(":")
      ];
    case "vp9":
      return [];
    case "av1":
      // FFmpeg's generic color options do not populate libaom's sequence-header
      // CICP fields; pass the encoder-owned controls as well.
      return [
        "-aom-params",
        "color-primaries=1:transfer-characteristics=1:matrix-coefficients=1"
      ];
  }
}

function h264CropRect(
  geometry: Readonly<VideoRenditionGeometry>
): readonly [number, number, number, number] {
  const [left, top, decodedWidth, decodedHeight] = geometry.decodedStorageRect;
  const crop = [
    left,
    top,
    geometry.codedWidth - left - decodedWidth,
    geometry.codedHeight - top - decodedHeight
  ] as const;
  if (crop.some((value) =>
    !Number.isSafeInteger(value) || value < 0 || value % 2 !== 0
  )) {
    throw invalid("H.264 crop deltas must be nonnegative even safe integers");
  }
  return crop;
}

function outputBudget(
  input: Readonly<EncodeVideoUnitInput & { readonly maximumOutputBytes?: number }>,
  frameCount: number
): number {
  if (input.maximumOutputBytes !== undefined) {
    if (!Number.isSafeInteger(input.maximumOutputBytes) || input.maximumOutputBytes < 1) {
      throw invalid("Maximum encoded output bytes must be a positive safe integer");
    }
    return Math.min(input.maximumOutputBytes, MAX_PROCESS_OUTPUT_BYTES);
  }
  const rawBytes = checkedProduct(frameCount, input.source.frameBytes, "raw unit byte length");
  const doubled = checkedProduct(rawBytes, 2, "encoded output budget");
  const withOverhead = doubled + 1024 * 1024;
  if (!Number.isSafeInteger(withOverhead)) {
    throw invalid("Encoded output budget exceeds the safe integer range");
  }
  return Math.min(MAX_PROCESS_OUTPUT_BYTES, Math.max(1024 * 1024, withOverhead));
}

function checkedProduct(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw invalid(`${label} exceeds the safe integer range`);
  }
  return result;
}

function invalid(message: string): CompilerError {
  return new CompilerError("INPUT_INVALID", message, { phase: "encode" });
}
