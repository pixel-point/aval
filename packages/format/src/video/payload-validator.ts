import { inspectAv1Rendition } from "../av1/inspector.js";
import {
  inspectH264AnnexBRenditionWithParameterSetIdentity
} from "../h264/inspector.js";
import { H265_MAX_ACCESS_UNIT_BYTES } from "../h265/annex-b.js";
import {
  inspectH265AnnexBRenditionWithParameterSetIdentity
} from "../h265/inspector.js";
import { deriveVp9Codec, parseVp9Level } from "../vp9/codec.js";
import { inspectVp9Rendition } from "../vp9/inspector.js";
import { FormatError, isFormatError } from "../errors.js";
import type { VideoBitDepth, VideoCodec } from "../model.js";
import { parseVideoCodecString } from "./codec-string.js";

/** Rendition facts required for stateful payload admission. */
export interface VideoPayloadValidationProfile {
  readonly codec: string;
  readonly bitDepth: VideoBitDepth;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly visibleWidth: number;
  readonly visibleHeight: number;
  readonly frameRate: Readonly<{
    readonly numerator: number;
    readonly denominator: number;
  }>;
  readonly averageBitrate: number;
}

/** One verified container chunk and the assertions carried by its index record. */
export interface VideoPayloadValidationChunk {
  readonly bytes: Uint8Array;
  readonly timestamp: number;
  readonly key: boolean;
  readonly displayedFrames: number;
}

/** Incremental, rendition-scoped payload admission for lazy unit loading. */
export interface VideoPayloadValidator {
  /** Validate the next independently decodable unit without retaining its bytes. */
  validate(chunks: readonly Readonly<VideoPayloadValidationChunk>[]): void;
  /** Complete rendition-global checks after every unit has been admitted. */
  complete(): void;
}

interface CapturedProfile extends VideoPayloadValidationProfile {
  readonly family: VideoCodec;
}

interface ValidationState {
  readonly unitCount: number;
  readonly parameterSetIdentity?: readonly string[];
  readonly av1SequenceIdentity?: string;
  readonly maximumVp9CodedFramesPerDisplayedFrame?: number;
}

const INITIAL_STATE: Readonly<ValidationState> = Object.freeze({ unitCount: 0 });
const MAX_UNIT_CHUNKS = 1_000_000;

/** Create the format-owned incremental authority for one rendition. */
export function createVideoPayloadValidator(
  input: Readonly<VideoPayloadValidationProfile>
): Readonly<VideoPayloadValidator> {
  try {
    const profile = captureProfile(input);
    let state = INITIAL_STATE;
    let completed = false;
    return Object.freeze({
      validate(chunks: readonly Readonly<VideoPayloadValidationChunk>[]): void {
        try {
          requirePayload(!completed, "validator", "payload validation is already complete");
          const captured = captureChunks(chunks, profile.family);
          const next = validateUnit(profile, captured, state);
          state = next;
        } catch (error) {
          normalizePayloadError(error, "video payload unit validation failed");
        }
      },
      complete(): void {
        if (completed) return;
        try {
          requirePayload(state.unitCount > 0, "validator", "no payload units were validated");
          if (profile.family === "vp9") validateCompleteVp9(profile, state);
          completed = true;
        } catch (error) {
          normalizePayloadError(error, "video payload completion failed");
        }
      }
    });
  } catch (error) {
    normalizePayloadError(error, "video payload validator could not be created");
  }
}

function captureProfile(
  input: Readonly<VideoPayloadValidationProfile>
): Readonly<CapturedProfile> {
  requirePayload(isRecord(input), "profile", "profile must be an object");
  const codec = input.codec;
  const bitDepth = input.bitDepth;
  const codedWidth = input.codedWidth;
  const codedHeight = input.codedHeight;
  const visibleWidth = input.visibleWidth;
  const visibleHeight = input.visibleHeight;
  const frameRate = input.frameRate;
  const averageBitrate = input.averageBitrate;
  requirePayload(typeof codec === "string", "profile.codec", "codec must be a string");
  const parsedCodec = parseVideoCodecString(codec);
  requirePayload(parsedCodec !== undefined, "profile.codec", "codec is not canonical");
  requirePayload(
    bitDepth === 8 || bitDepth === 10,
    "profile.bitDepth",
    "bit depth must be 8 or 10"
  );
  requirePayload(
    parsedCodec.bitDepth === bitDepth,
    "profile.bitDepth",
    "bit depth disagrees with the codec declaration"
  );
  positiveInteger(codedWidth, "profile.codedWidth");
  positiveInteger(codedHeight, "profile.codedHeight");
  positiveInteger(visibleWidth, "profile.visibleWidth");
  positiveInteger(visibleHeight, "profile.visibleHeight");
  requirePayload(
    visibleWidth <= codedWidth && visibleHeight <= codedHeight,
    "profile",
    "visible dimensions exceed coded dimensions"
  );
  requirePayload(
    codedWidth % 2 === 0 && codedHeight % 2 === 0 &&
      visibleWidth % 2 === 0 && visibleHeight % 2 === 0,
    "profile",
    "4:2:0 dimensions must be even"
  );
  requirePayload(isRecord(frameRate), "profile.frameRate", "frame rate must be an object");
  positiveInteger(frameRate.numerator, "profile.frameRate.numerator");
  positiveInteger(frameRate.denominator, "profile.frameRate.denominator");
  requirePayload(
    frameRate.denominator <= 1_001 &&
      frameRate.numerator <= frameRate.denominator * 60,
    "profile.frameRate",
    "frame rate exceeds the runtime profile"
  );
  positiveInteger(averageBitrate, "profile.averageBitrate");
  return Object.freeze({
    codec,
    bitDepth,
    codedWidth,
    codedHeight,
    visibleWidth,
    visibleHeight,
    frameRate: Object.freeze({
      numerator: frameRate.numerator,
      denominator: frameRate.denominator
    }),
    averageBitrate,
    family: parsedCodec.family
  });
}

function captureChunks(
  input: readonly Readonly<VideoPayloadValidationChunk>[],
  family: VideoCodec
): readonly Readonly<VideoPayloadValidationChunk>[] {
  requirePayload(
    Array.isArray(input) && input.length > 0 && input.length <= MAX_UNIT_CHUNKS,
    "chunks",
    "unit chunks must be a nonempty bounded array"
  );
  const chunks: VideoPayloadValidationChunk[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const path = `chunks[${String(index)}]`;
    const chunk = input[index];
    requirePayload(isRecord(chunk), path, "chunk must be an object");
    const bytes = chunk.bytes;
    const timestamp = chunk.timestamp;
    const key = chunk.key;
    const displayedFrames = chunk.displayedFrames;
    requirePayload(bytes instanceof Uint8Array, `${path}.bytes`, "chunk bytes are invalid");
    requirePayload(
      Number.isSafeInteger(bytes.byteLength) && bytes.byteLength > 0,
      `${path}.bytes`,
      "chunk bytes are empty or oversized"
    );
    if (family === "h265") {
      requirePayload(
        bytes.byteLength <= H265_MAX_ACCESS_UNIT_BYTES,
        `${path}.bytes`,
        "HEVC access unit exceeds the syntax budget"
      );
    }
    requirePayload(
      typeof timestamp === "number" &&
        Number.isSafeInteger(timestamp) && timestamp >= 0,
      `${path}.timestamp`,
      "chunk timestamp is invalid"
    );
    requirePayload(typeof key === "boolean", `${path}.key`, "chunk key assertion is invalid");
    requirePayload(
      typeof displayedFrames === "number" &&
        Number.isSafeInteger(displayedFrames) && displayedFrames >= 0,
      `${path}.displayedFrames`,
      "displayed-frame assertion is invalid"
    );
    chunks.push(Object.freeze({ bytes, timestamp, key, displayedFrames }));
  }
  return Object.freeze(chunks);
}

function validateUnit(
  profile: Readonly<CapturedProfile>,
  chunks: readonly Readonly<VideoPayloadValidationChunk>[],
  previous: Readonly<ValidationState>
): Readonly<ValidationState> {
  const unitId = `unit-${String(previous.unitCount)}`;
  switch (profile.family) {
    case "h264":
      return validateH264Unit(profile, chunks, previous, unitId);
    case "h265":
      return validateH265Unit(profile, chunks, previous, unitId);
    case "vp9":
      return validateVp9Unit(profile, chunks, previous, unitId);
    case "av1":
      return validateAv1Unit(profile, chunks, previous, unitId);
  }
}

function validateH264Unit(
  profile: Readonly<CapturedProfile>,
  chunks: readonly Readonly<VideoPayloadValidationChunk>[],
  previous: Readonly<ValidationState>,
  unitId: string
): Readonly<ValidationState> {
  requirePayload(
    chunks.every(({ displayedFrames }) => displayedFrames === 1),
    "chunks",
    "H264 chunks must each display exactly one frame"
  );
  const { inspection, parameterSetIdentity } =
    inspectH264AnnexBRenditionWithParameterSetIdentity({
      profile: {
        codedWidth: profile.codedWidth,
        codedHeight: profile.codedHeight,
        expectedVisibleRect: [0, 0, profile.visibleWidth, profile.visibleHeight],
        frameRate: profile.frameRate,
        requireBt709LimitedRange: true
      },
      units: [{
        id: unitId,
        accessUnits: chunks.map(({ bytes, key }) => ({ bytes, key }))
      }]
    });
  requirePayload(
    inspection.parameterSet.codec === profile.codec,
    "profile.codec",
    "H264 bitstream level disagrees with the codec declaration"
  );
  const unit = inspection.units[0];
  requirePayload(unit !== undefined, "chunks", "H264 unit inspection is missing");
  validateTimestampOrder(chunks, unit.decodeToPresentation, "H264");
  requireStableParameterSetIdentity(
    previous.parameterSetIdentity,
    parameterSetIdentity,
    "H264"
  );
  return Object.freeze({
    unitCount: previous.unitCount + 1,
    parameterSetIdentity
  });
}

function validateH265Unit(
  profile: Readonly<CapturedProfile>,
  chunks: readonly Readonly<VideoPayloadValidationChunk>[],
  previous: Readonly<ValidationState>,
  unitId: string
): Readonly<ValidationState> {
  requirePayload(
    chunks.every(({ displayedFrames }) => displayedFrames === 1),
    "chunks",
    "HEVC chunks must each display exactly one frame"
  );
  const { inspection, parameterSetIdentity } =
    inspectH265AnnexBRenditionWithParameterSetIdentity({
      profile: {
        codedWidth: profile.codedWidth,
        codedHeight: profile.codedHeight,
        expectedVisibleRect: [0, 0, profile.visibleWidth, profile.visibleHeight],
        frameRate: profile.frameRate,
        requireBt709LimitedRange: true
      },
      units: [{
        id: unitId,
        accessUnits: chunks.map(({ bytes, key }) => ({ bytes, key }))
      }]
    });
  requirePayload(
    inspection.parameterSet.codec === profile.codec,
    "profile.codec",
    "HEVC bitstream profile disagrees with the codec declaration"
  );
  const unit = inspection.units[0];
  requirePayload(unit !== undefined, "chunks", "HEVC unit inspection is missing");
  validateTimestampOrder(chunks, unit.decodeToPresentation, "HEVC");
  requireStableParameterSetIdentity(
    previous.parameterSetIdentity,
    parameterSetIdentity,
    "HEVC"
  );
  return Object.freeze({
    unitCount: previous.unitCount + 1,
    parameterSetIdentity
  });
}

function validateAv1Unit(
  profile: Readonly<CapturedProfile>,
  chunks: readonly Readonly<VideoPayloadValidationChunk>[],
  previous: Readonly<ValidationState>,
  unitId: string
): Readonly<ValidationState> {
  const expectedDisplayedFrames = sumDisplayedFrames(chunks);
  const inspection = inspectAv1Rendition({
    width: profile.codedWidth,
    height: profile.codedHeight,
    bitDepth: profile.bitDepth,
    units: [{
      id: unitId,
      chunks: chunks.map(({ bytes, key, timestamp }) => ({ bytes, key, timestamp })),
      expectedDisplayedFrames
    }]
  });
  requirePayload(
    inspection.codec === profile.codec,
    "profile.codec",
    "AV1 sequence header disagrees with the codec declaration"
  );
  const inspectedChunks = inspection.units[0]?.chunks;
  requirePayload(
    inspectedChunks?.length === chunks.length &&
      chunks.every((chunk, index) =>
        inspectedChunks[index]?.displayedFrameCount === chunk.displayedFrames
      ),
    "chunks",
    "AV1 displayed-frame assertions disagree with the bitstream"
  );
  const av1SequenceIdentity = JSON.stringify(inspection.sequence);
  requireStableStringIdentity(previous.av1SequenceIdentity, av1SequenceIdentity, "AV1");
  return Object.freeze({
    unitCount: previous.unitCount + 1,
    av1SequenceIdentity
  });
}

function validateVp9Unit(
  profile: Readonly<CapturedProfile>,
  chunks: readonly Readonly<VideoPayloadValidationChunk>[],
  previous: Readonly<ValidationState>,
  unitId: string
): Readonly<ValidationState> {
  const expectedDisplayedFrames = sumDisplayedFrames(chunks);
  const inspection = inspectVp9Rendition({
    width: profile.codedWidth,
    height: profile.codedHeight,
    frameRate: profile.frameRate,
    averageBitrate: profile.averageBitrate,
    units: [{
      id: unitId,
      packets: chunks.map(({ bytes, key, timestamp }) => ({ bytes, key, timestamp })),
      expectedDisplayedFrames
    }]
  });
  const packets = inspection.units[0]?.packets;
  requirePayload(
    packets?.length === chunks.length &&
      chunks.every((chunk, index) =>
        packets[index]?.displayedFrameCount === chunk.displayedFrames
      ),
    "chunks",
    "VP9 displayed-frame assertions disagree with the bitstream"
  );
  let codedFrames = 0;
  for (const packet of packets) {
    codedFrames = safeAdd(codedFrames, packet.codedFrames.length, "chunks");
    for (const frame of packet.codedFrames) {
      if (!frame.key) continue;
      requirePayload(
        frame.width === profile.codedWidth &&
          frame.height === profile.codedHeight &&
          frame.renderWidth === profile.visibleWidth &&
          frame.renderHeight === profile.visibleHeight,
        "chunks",
        "VP9 key-frame geometry disagrees with the rendition"
      );
    }
  }
  const codedFramesPerDisplayedFrame = codedFrames / expectedDisplayedFrames;
  const declaredLevel = parseVp9Level(profile.codec);
  const inspectedLevel = parseVp9Level(inspection.codec);
  requirePayload(
    declaredLevel !== undefined && inspectedLevel !== undefined &&
      Number(declaredLevel) >= Number(inspectedLevel),
    "profile.codec",
    "VP9 unit exceeds the declared codec level"
  );
  return Object.freeze({
    unitCount: previous.unitCount + 1,
    maximumVp9CodedFramesPerDisplayedFrame: Math.max(
      previous.maximumVp9CodedFramesPerDisplayedFrame ?? 1,
      codedFramesPerDisplayedFrame
    )
  });
}

function validateCompleteVp9(
  profile: Readonly<CapturedProfile>,
  state: Readonly<ValidationState>
): void {
  const maximumRatio = state.maximumVp9CodedFramesPerDisplayedFrame;
  requirePayload(maximumRatio !== undefined, "validator", "VP9 validation state is incomplete");
  const codec = deriveVp9Codec({
    width: profile.codedWidth,
    height: profile.codedHeight,
    codedFramesPerSecond:
      profile.frameRate.numerator / profile.frameRate.denominator * maximumRatio,
    averageBitrate: profile.averageBitrate
  });
  requirePayload(
    codec === profile.codec,
    "profile.codec",
    "VP9 codec must be the exact rendition-global level"
  );
}

function validateTimestampOrder(
  chunks: readonly Readonly<VideoPayloadValidationChunk>[],
  decodeToPresentation: readonly number[],
  family: string
): void {
  requirePayload(
    decodeToPresentation.length === chunks.length,
    "chunks",
    `${family} presentation map is incomplete`
  );
  const byTimestamp = chunks.map((_, index) => index).sort((left, right) =>
    chunks[left]!.timestamp - chunks[right]!.timestamp || left - right
  );
  requirePayload(
    byTimestamp.every((decodeIndex, presentationIndex) =>
      decodeToPresentation[decodeIndex] === presentationIndex
    ),
    "chunks",
    `${family} timestamps disagree with bitstream presentation order`
  );
}

function requireStableParameterSetIdentity(
  previous: readonly string[] | undefined,
  current: readonly string[],
  family: string
): void {
  requirePayload(
    previous === undefined ||
      previous.length === current.length &&
        previous.every((part, index) => part === current[index]),
    "chunks[0].bytes",
    `${family} headers changed within the rendition`
  );
}

function requireStableStringIdentity(
  previous: string | undefined,
  current: string,
  family: string
): void {
  requirePayload(
    previous === undefined || previous === current,
    "chunks[0].bytes",
    `${family} headers changed within the rendition`
  );
}

function sumDisplayedFrames(
  chunks: readonly Readonly<VideoPayloadValidationChunk>[]
): number {
  return chunks.reduce(
    (total, { displayedFrames }) => safeAdd(total, displayedFrames, "chunks"),
    0
  );
}

function safeAdd(left: number, right: number, path: string): number {
  const value = left + right;
  requirePayload(Number.isSafeInteger(value), path, "displayed or coded frame count is unsafe");
  return value;
}

function positiveInteger(value: unknown, path: string): asserts value is number {
  requirePayload(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    path,
    "value must be a positive safe integer"
  );
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requirePayload(
  condition: unknown,
  path: string,
  message: string
): asserts condition {
  if (!condition) throw new FormatError("PROFILE_INVALID", message, { path });
}

function normalizePayloadError(error: unknown, message: string): never {
  if (isFormatError(error)) throw error;
  throw new FormatError("PROFILE_INVALID", message);
}
