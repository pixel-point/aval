import {
  createEncodedLoopUnit,
  durationForFrame,
  timestampForFrame,
  type EncodedLoopUnit,
  type RationalFrameRate,
} from "@rendered-motion/player-web";

import {
  inspectH264AnnexBKeyAccessUnit,
  type H264AnnexBKeyAccessUnitEvidence,
} from "./annex-b";
import { drawFrameTag, type FrameTagCanvasContext } from "./frame-tag";

const H264_CODEC = "avc1.42E020";
const VP8_CODEC = "vp8";
const DEFAULT_WIDTH = 256;
const DEFAULT_HEIGHT = 256;
const DEFAULT_FRAME_RATE = { numerator: 30, denominator: 1 } as const;

export type SyntheticLoopKind = "stress" | "orbit";
export type CodecProbeStatus = "supported" | "unsupported" | "failed";
export type SelectedSyntheticCodec = "h264-annexb" | "vp8";

export interface SyntheticLoopOptions {
  /** Defaults to the realtime 24-frame orbit. */
  readonly kind?: SyntheticLoopKind;
  /** Orbit only; defaults to 24 and is limited by the 8-bit frame tag. */
  readonly frameCount?: number;
  readonly width?: number;
  readonly height?: number;
  readonly frameRate?: Readonly<RationalFrameRate>;
  readonly bitrate?: number;
}

export interface SyntheticCodecEvidence {
  readonly selectedCodec: SelectedSyntheticCodec;
  readonly selectedCodecString: typeof H264_CODEC | typeof VP8_CODEC;
  readonly genericLoopReplay: "supported";
  readonly h264AnnexB: CodecProbeStatus;
  readonly h264AnnexBReason?: string;
  readonly h264KeyAccessUnit?: H264AnnexBKeyAccessUnitEvidence;
  readonly encoderOutputCount: number;
  readonly decoderOutputCount: number;
}

export interface SyntheticLoopFixture {
  /** Owns a copied byte array for every access unit. */
  readonly unit: EncodedLoopUnit;
  readonly evidence: SyntheticCodecEvidence;
}

export class SyntheticLoopCreationError extends Error {
  public readonly h264AnnexB: CodecProbeStatus;
  public readonly h264AnnexBReason: string | undefined;

  public constructor(
    message: string,
    h264AnnexB: CodecProbeStatus,
    h264AnnexBReason?: string,
  ) {
    super(message);
    this.name = "SyntheticLoopCreationError";
    this.h264AnnexB = h264AnnexB;
    this.h264AnnexBReason = h264AnnexBReason;
  }
}

interface NormalizedSyntheticLoopOptions {
  readonly kind: SyntheticLoopKind;
  readonly frameCount: number;
  readonly width: number;
  readonly height: number;
  readonly frameRate: Readonly<RationalFrameRate>;
  readonly bitrate: number;
}

interface CallbackAccessUnit {
  readonly type: EncodedVideoChunkType;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly data: Uint8Array;
  readonly hasDecoderDescription: boolean;
}

interface EncodedCandidate {
  readonly unit: EncodedLoopUnit;
  readonly callbackCount: number;
  readonly decoderOutputCount: number;
  readonly h264KeyAccessUnit?: H264AnnexBKeyAccessUnitEvidence;
}

interface CodecCandidate {
  readonly label: SelectedSyntheticCodec;
  readonly codec: typeof H264_CODEC | typeof VP8_CODEC;
  readonly encoderConfig: VideoEncoderConfig;
  readonly decoderConfig: VideoDecoderConfig;
  readonly annexB: boolean;
}

type FixtureCanvas = HTMLCanvasElement | OffscreenCanvas;

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function assertSafePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function normalizeOptions(
  options: SyntheticLoopOptions,
): NormalizedSyntheticLoopOptions {
  const kind = options.kind ?? "orbit";
  const frameCount = options.frameCount ?? (kind === "stress" ? 2 : 24);
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const frameRate = options.frameRate ?? DEFAULT_FRAME_RATE;
  const bitrate = options.bitrate ?? 1_500_000;

  assertSafePositiveInteger(frameCount, "Synthetic frame count");
  if (frameCount > 256) {
    throw new RangeError("Synthetic frame count cannot exceed the 8-bit tag range");
  }
  if (kind === "stress" && frameCount !== 2) {
    throw new RangeError("The stress fixture is exactly two frames");
  }

  assertSafePositiveInteger(width, "Synthetic width");
  assertSafePositiveInteger(height, "Synthetic height");
  if (width < 160 || height < 96 || width > 1024 || height > 1024) {
    throw new RangeError("Synthetic dimensions must be within 160x96 and 1024x1024");
  }
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new RangeError("Synthetic dimensions must be even for 4:2:0 codecs");
  }

  assertSafePositiveInteger(frameRate.numerator, "Frame-rate numerator");
  assertSafePositiveInteger(frameRate.denominator, "Frame-rate denominator");
  if (
    BigInt(frameRate.numerator) > 60n * BigInt(frameRate.denominator)
  ) {
    throw new RangeError("Synthetic frame rate must be in (0, 60]");
  }
  const macroblocksPerFrame = Math.ceil(width / 16) * Math.ceil(height / 16);
  if (macroblocksPerFrame > 5_120) {
    throw new RangeError(
      "Synthetic dimensions exceed the H.264 Level 3.2 macroblock envelope",
    );
  }
  if (
    BigInt(macroblocksPerFrame) * BigInt(frameRate.numerator) >
    216_000n * BigInt(frameRate.denominator)
  ) {
    throw new RangeError(
      "Synthetic dimensions and frame rate exceed the H.264 Level 3.2 processing envelope",
    );
  }
  assertSafePositiveInteger(bitrate, "Synthetic bitrate");
  if (bitrate > 8_000_000) {
    throw new RangeError("Synthetic bitrate exceeds the H.264 Level 3.2 envelope");
  }

  return { kind, frameCount, width, height, frameRate, bitrate };
}

function createFixtureCanvas(width: number, height: number): FixtureCanvas {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error("Synthetic fixture creation needs a browser canvas");
}

function getCanvasContext(canvas: FixtureCanvas): FrameTagCanvasContext {
  const context = canvas.getContext("2d", {
    alpha: false,
    desynchronized: true,
  });
  if (context === null || !("fillRect" in context)) {
    throw new Error("A 2D canvas context is required for the synthetic fixture");
  }
  return context as FrameTagCanvasContext;
}

function drawStressFrame(
  context: FrameTagCanvasContext,
  frameIndex: number,
  width: number,
  height: number,
): void {
  const colors = ["#f43f5e", "#2563eb"] as const;
  context.fillStyle = "#172033";
  context.fillRect(0, 0, width, height);

  context.strokeStyle = "rgba(255, 255, 255, 0.12)";
  context.lineWidth = Math.max(1, Math.floor(width / 128));
  for (let step = 1; step < 4; step += 1) {
    const x = (step * width) / 4;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height * 0.78);
    context.stroke();
  }

  const markerX = width * (frameIndex === 0 ? 0.43 : 0.57);
  context.fillStyle = "rgba(255, 255, 255, 0.94)";
  context.beginPath();
  context.arc(
    markerX,
    height * 0.39,
    Math.min(width, height) * 0.13,
    0,
    Math.PI * 2,
  );
  context.fill();

  context.fillStyle = colors[frameIndex] ?? "#111827";
  context.font = `800 ${Math.floor(height * 0.16)}px ui-monospace, monospace`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(String(frameIndex), markerX, height * 0.39);
}

function drawOrbitFrame(
  context: FrameTagCanvasContext,
  frameIndex: number,
  frameCount: number,
  width: number,
  height: number,
): void {
  const phase = (frameIndex / frameCount) * Math.PI * 2;
  const hue = (frameIndex / frameCount) * 360;
  const gradient = context.createRadialGradient(
    width * 0.5,
    height * 0.38,
    2,
    width * 0.5,
    height * 0.38,
    Math.max(width, height) * 0.72,
  );
  gradient.addColorStop(0, `hsl(${(hue + 42) % 360} 84% 55%)`);
  gradient.addColorStop(1, `hsl(${(hue + 230) % 360} 68% 15%)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  const centerX = width * 0.5;
  const centerY = height * 0.39;
  const orbitRadius = Math.min(width, height) * 0.25;
  const orbRadius = Math.min(width, height) * 0.075;
  const orbX = centerX + Math.cos(phase) * orbitRadius;
  const orbY = centerY + Math.sin(phase) * orbitRadius;

  context.strokeStyle = "rgba(255, 255, 255, 0.36)";
  context.lineWidth = Math.max(2, Math.floor(width / 96));
  context.beginPath();
  context.arc(centerX, centerY, orbitRadius, 0, Math.PI * 2);
  context.stroke();

  context.strokeStyle = "rgba(255, 255, 255, 0.86)";
  context.beginPath();
  context.moveTo(centerX, centerY);
  context.lineTo(orbX, orbY);
  context.stroke();

  context.fillStyle = "rgba(255, 255, 255, 0.96)";
  context.beginPath();
  context.arc(orbX, orbY, orbRadius, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = "rgba(8, 15, 35, 0.82)";
  context.beginPath();
  context.arc(centerX, centerY, orbRadius * 0.62, 0, Math.PI * 2);
  context.fill();
}

function drawSyntheticFrame(
  context: FrameTagCanvasContext,
  options: NormalizedSyntheticLoopOptions,
  frameIndex: number,
): void {
  if (options.kind === "stress") {
    drawStressFrame(context, frameIndex, options.width, options.height);
  } else {
    drawOrbitFrame(
      context,
      frameIndex,
      options.frameCount,
      options.width,
      options.height,
    );
  }
  drawFrameTag(context, frameIndex, options.width, options.height);
}

function makeCandidate(
  label: SelectedSyntheticCodec,
  options: NormalizedSyntheticLoopOptions,
): CodecCandidate {
  const codec = label === "h264-annexb" ? H264_CODEC : VP8_CODEC;
  const encoderConfig: VideoEncoderConfig = {
    codec,
    width: options.width,
    height: options.height,
    displayWidth: options.width,
    displayHeight: options.height,
    framerate: options.frameRate.numerator / options.frameRate.denominator,
    bitrate: options.bitrate,
    latencyMode: "realtime",
    hardwareAcceleration: "no-preference",
    ...(label === "h264-annexb" ? { avc: { format: "annexb" as const } } : {}),
  };
  const decoderConfig: VideoDecoderConfig = {
    codec,
    codedWidth: options.width,
    codedHeight: options.height,
    displayAspectWidth: options.width,
    displayAspectHeight: options.height,
    optimizeForLatency: true,
    hardwareAcceleration: "no-preference",
  };

  return {
    label,
    codec,
    encoderConfig,
    decoderConfig,
    annexB: label === "h264-annexb",
  };
}

async function queryCandidateSupport(candidate: CodecCandidate): Promise<boolean> {
  const [encoderSupport, decoderSupport] = await Promise.all([
    VideoEncoder.isConfigSupported(candidate.encoderConfig),
    VideoDecoder.isConfigSupported(candidate.decoderConfig),
  ]);
  return encoderSupport.supported === true && decoderSupport.supported === true;
}

async function verifyRealDecoder(
  config: VideoDecoderConfig,
  accessUnits: readonly CallbackAccessUnit[],
  rate: Readonly<RationalFrameRate>,
): Promise<number> {
  let decoderError: DOMException | undefined;
  let outputCount = 0;
  const decoder = new VideoDecoder({
    output: (frame) => {
      outputCount += 1;
      frame.close();
    },
    error: (error) => {
      decoderError = error;
    },
  });

  try {
    decoder.configure(config);
    for (let index = 0; index < accessUnits.length; index += 1) {
      const accessUnit = accessUnits[index];
      if (accessUnit === undefined) {
        throw new Error(`Missing encoded access unit ${index}`);
      }
      decoder.decode(
        new EncodedVideoChunk({
          type: accessUnit.type,
          timestamp: timestampForFrame(index, rate),
          duration: durationForFrame(index, rate),
          data: accessUnit.data,
        }),
      );
    }
    await decoder.flush();
    if (decoderError !== undefined) {
      throw decoderError;
    }
    if (outputCount !== accessUnits.length) {
      throw new Error(
        `Decoder produced ${outputCount} frames for ${accessUnits.length} access units`,
      );
    }
    return outputCount;
  } finally {
    if (decoder.state !== "closed") {
      decoder.close();
    }
  }
}

async function encodeCandidate(
  candidate: CodecCandidate,
  options: NormalizedSyntheticLoopOptions,
): Promise<EncodedCandidate> {
  const canvas = createFixtureCanvas(options.width, options.height);
  const context = getCanvasContext(canvas);
  const callbackAccessUnits: CallbackAccessUnit[] = [];
  let encoderError: DOMException | undefined;

  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      callbackAccessUnits.push({
        type: chunk.type,
        timestamp: chunk.timestamp,
        duration: chunk.duration,
        data,
        hasDecoderDescription:
          metadata?.decoderConfig?.description !== undefined,
      });
    },
    error: (error) => {
      encoderError = error;
    },
  });

  try {
    encoder.configure(candidate.encoderConfig);
    for (let frameIndex = 0; frameIndex < options.frameCount; frameIndex += 1) {
      drawSyntheticFrame(context, options, frameIndex);
      const timestamp = timestampForFrame(frameIndex, options.frameRate);
      const duration = durationForFrame(frameIndex, options.frameRate);
      const frame = new VideoFrame(canvas, { timestamp, duration });
      try {
        encoder.encode(frame, { keyFrame: frameIndex === 0 });
      } finally {
        frame.close();
      }
    }

    await encoder.flush();
    if (encoderError !== undefined) {
      throw encoderError;
    }
  } finally {
    if (encoder.state !== "closed") {
      encoder.close();
    }
  }

  if (callbackAccessUnits.length !== options.frameCount) {
    throw new Error(
      `Encoder produced ${callbackAccessUnits.length} outputs for ${options.frameCount} source frames`,
    );
  }

  for (let index = 0; index < callbackAccessUnits.length; index += 1) {
    const accessUnit = callbackAccessUnits[index];
    if (accessUnit === undefined) {
      throw new Error(`Encoder callback ${index} is missing`);
    }
    const expectedTimestamp = timestampForFrame(index, options.frameRate);
    if (accessUnit.timestamp !== expectedTimestamp) {
      throw new Error(
        `Encoder callback order changed at output ${index}: expected timestamp ${expectedTimestamp}, received ${accessUnit.timestamp}`,
      );
    }
  }

  const first = callbackAccessUnits[0];
  if (first === undefined || first.type !== "key") {
    throw new Error("Encoder did not return a key access unit for source frame zero");
  }
  if (
    callbackAccessUnits.length > 1 &&
    !callbackAccessUnits.slice(1).some((accessUnit) => accessUnit.type === "delta")
  ) {
    throw new Error(
      "Encoder returned an all-key unit; the loop fixture must exercise delta replay",
    );
  }

  let h264KeyAccessUnit: H264AnnexBKeyAccessUnitEvidence | undefined;
  if (candidate.annexB) {
    if (callbackAccessUnits.some((unit) => unit.hasDecoderDescription)) {
      throw new Error(
        "Annex B encoder returned a decoder description; avcC output is not accepted",
      );
    }
    h264KeyAccessUnit = inspectH264AnnexBKeyAccessUnit(first.data);
  }

  const decoderOutputCount = await verifyRealDecoder(
    candidate.decoderConfig,
    callbackAccessUnits,
    options.frameRate,
  );
  const unit = createEncodedLoopUnit({
    config: candidate.decoderConfig,
    codedWidth: options.width,
    codedHeight: options.height,
    displayWidth: options.width,
    displayHeight: options.height,
    frameRate: options.frameRate,
    frames: callbackAccessUnits.map((accessUnit) => ({
      type: accessUnit.type,
      data: accessUnit.data,
    })),
  });

  return {
    unit,
    callbackCount: callbackAccessUnits.length,
    decoderOutputCount,
    ...(h264KeyAccessUnit === undefined ? {} : { h264KeyAccessUnit }),
  };
}

function assertWebCodecsAvailable(): void {
  if (
    typeof VideoEncoder === "undefined" ||
    typeof VideoDecoder === "undefined" ||
    typeof VideoFrame === "undefined" ||
    typeof EncodedVideoChunk === "undefined"
  ) {
    throw new SyntheticLoopCreationError(
      "This browser does not expose the WebCodecs APIs needed by the synthetic fixture",
      "unsupported",
      "WebCodecs API unavailable",
    );
  }
}

/**
 * Builds an in-memory, browser-only loop fixture. H.264 Annex B is attempted
 * first; VP8 is an explicitly labeled scheduler-only fallback.
 */
export async function createSyntheticLoop(
  options: SyntheticLoopOptions = {},
): Promise<SyntheticLoopFixture> {
  assertWebCodecsAvailable();
  const normalized = normalizeOptions(options);
  const h264Candidate = makeCandidate("h264-annexb", normalized);
  let h264AnnexB: CodecProbeStatus = "unsupported";
  let h264AnnexBReason: string | undefined;

  try {
    const supported = await queryCandidateSupport(h264Candidate);
    if (supported) {
      const encoded = await encodeCandidate(h264Candidate, normalized);
      if (encoded.h264KeyAccessUnit === undefined) {
        throw new Error("H.264 Annex B inspection produced no key-unit evidence");
      }
      return {
        unit: encoded.unit,
        evidence: {
          selectedCodec: h264Candidate.label,
          selectedCodecString: h264Candidate.codec,
          genericLoopReplay: "supported",
          h264AnnexB: "supported",
          h264KeyAccessUnit: encoded.h264KeyAccessUnit,
          encoderOutputCount: encoded.callbackCount,
          decoderOutputCount: encoded.decoderOutputCount,
        },
      };
    }
    h264AnnexBReason = "Exact H.264 encoder or decoder configuration unsupported";
  } catch (error) {
    h264AnnexB = "failed";
    h264AnnexBReason = errorMessage(error);
  }

  const vp8Candidate = makeCandidate("vp8", normalized);
  try {
    if (!(await queryCandidateSupport(vp8Candidate))) {
      throw new Error("VP8 encoder or decoder configuration unsupported");
    }
    const encoded = await encodeCandidate(vp8Candidate, normalized);
    return {
      unit: encoded.unit,
      evidence: {
        selectedCodec: vp8Candidate.label,
        selectedCodecString: vp8Candidate.codec,
        genericLoopReplay: "supported",
        h264AnnexB,
        ...(h264AnnexBReason === undefined ? {} : { h264AnnexBReason }),
        encoderOutputCount: encoded.callbackCount,
        decoderOutputCount: encoded.decoderOutputCount,
      },
    };
  } catch (error) {
    throw new SyntheticLoopCreationError(
      `No synthetic loop codec passed real encode/decode allocation: ${errorMessage(error)}`,
      h264AnnexB,
      h264AnnexBReason,
    );
  }
}

export function createSyntheticStressLoop(
  options: Omit<SyntheticLoopOptions, "kind" | "frameCount"> = {},
): Promise<SyntheticLoopFixture> {
  return createSyntheticLoop({ ...options, kind: "stress", frameCount: 2 });
}

export function createSyntheticOrbitLoop(
  options: Omit<SyntheticLoopOptions, "kind"> = {},
): Promise<SyntheticLoopFixture> {
  return createSyntheticLoop({ ...options, kind: "orbit" });
}
