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
import {
  drawFrameTag,
  readFrameTagFromVideoFrame,
  type FrameTagCanvasContext,
} from "./frame-tag";

const H264_CODEC = "avc1.42E020";
const VP8_CODEC = "vp8";
const DEFAULT_BITRATE = 1_500_000;

export const SYNTHETIC_REVERSIBLE_WIDTH = 256;
export const SYNTHETIC_REVERSIBLE_HEIGHT = 256;
export const SYNTHETIC_REVERSIBLE_FRAME_RATE = Object.freeze({
  numerator: 30,
  denominator: 1,
}) satisfies Readonly<RationalFrameRate>;
export const SYNTHETIC_REVERSIBLE_BODY_FRAME_COUNT = 16;
export const SYNTHETIC_REVERSIBLE_CLIP_FRAME_COUNT = 12;
export const SYNTHETIC_REVERSIBLE_RUNWAY_FRAME_COUNT = 8;
export const SYNTHETIC_REVERSIBLE_RENDITION_ID =
  "synthetic-reversible-rgba";

export type SyntheticReversibleUnitRole =
  | "source-body"
  | "reversible-clip"
  | "target-body";
export type SyntheticReversibleUnitKind = "body" | "reversible";
export type SyntheticReversibleCodec = "h264-annexb" | "vp8";
export type SyntheticReversibleCodecStatus =
  | "supported"
  | "unsupported"
  | "failed";

export interface SyntheticReversibleOptions {
  /** Semantic names are deliberately opaque to the fixture. */
  readonly sourceEndpoint?: string;
  readonly targetEndpoint?: string;
  readonly bitrate?: number;
}

export interface SyntheticResidentFrameKey {
  readonly rendition: typeof SYNTHETIC_REVERSIBLE_RENDITION_ID;
  readonly unit: SyntheticReversibleUnitRole;
  readonly localFrame: number;
}

export interface SyntheticReversibleTagIdentity {
  readonly unitRole: SyntheticReversibleUnitRole;
  readonly localFrame: number;
  readonly tagValue: number;
}

export interface SyntheticReversibleFrameIdentity
  extends SyntheticReversibleTagIdentity {
  readonly endpoint: string | null;
  readonly key: Readonly<SyntheticResidentFrameKey>;
  readonly visualLabel: string;
}

export interface SyntheticReversibleUnitMetadata {
  readonly id: SyntheticReversibleUnitRole;
  readonly kind: SyntheticReversibleUnitKind;
  readonly endpoint: string | null;
  readonly frameCount: number;
  readonly frames: readonly Readonly<SyntheticReversibleFrameIdentity>[];
}

export interface SyntheticEndpointRunwayMetadata {
  readonly endpoint: string;
  readonly bodyUnitId: "source-body" | "target-body";
  readonly entryFrame: 0;
  readonly frameCount: typeof SYNTHETIC_REVERSIBLE_RUNWAY_FRAME_COUNT;
  readonly frames: readonly Readonly<SyntheticReversibleFrameIdentity>[];
  readonly keys: readonly Readonly<SyntheticResidentFrameKey>[];
}

export interface SyntheticReversibleMetadata {
  readonly sourceEndpoint: string;
  readonly targetEndpoint: string;
  readonly width: typeof SYNTHETIC_REVERSIBLE_WIDTH;
  readonly height: typeof SYNTHETIC_REVERSIBLE_HEIGHT;
  readonly frameRate: Readonly<RationalFrameRate>;
  readonly sourceBody: Readonly<SyntheticReversibleUnitMetadata>;
  readonly reversibleClip: Readonly<SyntheticReversibleUnitMetadata>;
  readonly targetBody: Readonly<SyntheticReversibleUnitMetadata>;
  readonly units: readonly Readonly<SyntheticReversibleUnitMetadata>[];
  readonly sourceRunway: Readonly<SyntheticEndpointRunwayMetadata>;
  readonly targetRunway: Readonly<SyntheticEndpointRunwayMetadata>;
  readonly frameIdentities: readonly Readonly<SyntheticReversibleFrameIdentity>[];
}

export interface SyntheticEncodedReversibleUnit
  extends SyntheticReversibleUnitMetadata {
  /** Byte-owned and independently decodable from frame zero. */
  readonly unit: EncodedLoopUnit;
}

export interface SyntheticReversibleUnitCodecEvidence {
  readonly unitId: SyntheticReversibleUnitRole;
  readonly encoderOutputCount: number;
  readonly independentDecoderOutputCount: number;
  readonly firstAccessUnitType: "key";
  readonly deltaAccessUnitCount: number;
  readonly h264KeyAccessUnit?: H264AnnexBKeyAccessUnitEvidence;
}

export interface SyntheticReversibleCodecEvidence {
  readonly selectedCodec: SyntheticReversibleCodec;
  readonly selectedCodecString: typeof H264_CODEC | typeof VP8_CODEC;
  readonly compatibleIndependentUnits: "supported";
  readonly h264AnnexB: SyntheticReversibleCodecStatus;
  readonly h264AnnexBReason?: string;
  readonly encoderOutputCount: number;
  /** Outputs from all three units submitted through one decoder configuration. */
  readonly sequentialDecoderOutputCount: number;
  readonly decodedTagCount: number;
  readonly units: readonly Readonly<SyntheticReversibleUnitCodecEvidence>[];
}

export interface SyntheticReversibleFixture {
  readonly sourceEndpoint: string;
  readonly targetEndpoint: string;
  readonly width: typeof SYNTHETIC_REVERSIBLE_WIDTH;
  readonly height: typeof SYNTHETIC_REVERSIBLE_HEIGHT;
  readonly frameRate: Readonly<RationalFrameRate>;
  readonly sourceBody: Readonly<SyntheticEncodedReversibleUnit>;
  readonly reversibleClip: Readonly<SyntheticEncodedReversibleUnit>;
  readonly targetBody: Readonly<SyntheticEncodedReversibleUnit>;
  readonly units: readonly Readonly<SyntheticEncodedReversibleUnit>[];
  readonly sourceRunway: Readonly<SyntheticEndpointRunwayMetadata>;
  readonly targetRunway: Readonly<SyntheticEndpointRunwayMetadata>;
  readonly frameIdentities: readonly Readonly<SyntheticReversibleFrameIdentity>[];
  readonly evidence: Readonly<SyntheticReversibleCodecEvidence>;
}

export class SyntheticReversibleCreationError extends Error {
  public readonly h264AnnexB: SyntheticReversibleCodecStatus;
  public readonly h264AnnexBReason: string | undefined;

  public constructor(
    message: string,
    h264AnnexB: SyntheticReversibleCodecStatus,
    h264AnnexBReason?: string,
  ) {
    super(message);
    this.name = "SyntheticReversibleCreationError";
    this.h264AnnexB = h264AnnexB;
    this.h264AnnexBReason = h264AnnexBReason;
  }
}

interface NormalizedOptions {
  readonly sourceEndpoint: string;
  readonly targetEndpoint: string;
  readonly bitrate: number;
}

interface UnitBlueprint {
  readonly id: SyntheticReversibleUnitRole;
  readonly kind: SyntheticReversibleUnitKind;
  readonly endpoint: string | null;
  readonly frameCount: number;
  readonly globalStartFrame: number;
  readonly frames: readonly Readonly<SyntheticReversibleFrameIdentity>[];
}

interface CodecCandidate {
  readonly label: SyntheticReversibleCodec;
  readonly codec: typeof H264_CODEC | typeof VP8_CODEC;
  readonly encoderConfig: VideoEncoderConfig;
  readonly decoderConfig: VideoDecoderConfig;
  readonly annexB: boolean;
}

interface CallbackAccessUnit {
  readonly type: EncodedVideoChunkType;
  readonly timestamp: number;
  readonly data: Uint8Array;
  readonly hasDecoderDescription: boolean;
}

interface EncodedCandidate {
  readonly units: readonly Readonly<SyntheticEncodedReversibleUnit>[];
  readonly encoderOutputCount: number;
  readonly sequentialDecoderOutputCount: number;
  readonly decodedTagCount: number;
  readonly unitEvidence: readonly Readonly<SyntheticReversibleUnitCodecEvidence>[];
}

interface DecoderVerification {
  readonly outputCount: number;
  readonly decodedTagCount: number;
}

type FixtureCanvas = HTMLCanvasElement | OffscreenCanvas;

const UNIT_TAG_BASES = Object.freeze({
  "source-body": 0x10,
  "reversible-clip": 0x60,
  "target-body": 0xb0,
}) satisfies Readonly<Record<SyntheticReversibleUnitRole, number>>;

const UNIT_FRAME_COUNTS = Object.freeze({
  "source-body": SYNTHETIC_REVERSIBLE_BODY_FRAME_COUNT,
  "reversible-clip": SYNTHETIC_REVERSIBLE_CLIP_FRAME_COUNT,
  "target-body": SYNTHETIC_REVERSIBLE_BODY_FRAME_COUNT,
}) satisfies Readonly<Record<SyntheticReversibleUnitRole, number>>;

/** Resolves a readback tag without relying on endpoint names or array order. */
export function decodeSyntheticReversibleTag(
  tagValue: number,
): Readonly<SyntheticReversibleTagIdentity> | undefined {
  if (!Number.isSafeInteger(tagValue) || tagValue < 0 || tagValue > 0xff) {
    return undefined;
  }

  for (const unitRole of unitRoles()) {
    const base = UNIT_TAG_BASES[unitRole];
    const localFrame = tagValue - base;
    if (localFrame >= 0 && localFrame < UNIT_FRAME_COUNTS[unitRole]) {
      return Object.freeze({ unitRole, localFrame, tagValue });
    }
  }
  return undefined;
}

/**
 * Builds all browser-independent metadata used by the encoder and M2 tests.
 * Endpoint strings are preserved verbatim and never encoded into a tag.
 */
export function createSyntheticReversibleMetadata(
  options: SyntheticReversibleOptions = {},
): Readonly<SyntheticReversibleMetadata> {
  const normalized = normalizeOptions(options);
  const blueprints = createBlueprints(normalized);
  const sourceBody = metadataFromBlueprint(requireBlueprint(blueprints, "source-body"));
  const reversibleClip = metadataFromBlueprint(
    requireBlueprint(blueprints, "reversible-clip"),
  );
  const targetBody = metadataFromBlueprint(requireBlueprint(blueprints, "target-body"));
  const units = Object.freeze([sourceBody, reversibleClip, targetBody]);
  const sourceRunway = createRunway(normalized.sourceEndpoint, sourceBody);
  const targetRunway = createRunway(normalized.targetEndpoint, targetBody);
  const frameIdentities = Object.freeze(units.flatMap((unit) => unit.frames));

  return Object.freeze({
    sourceEndpoint: normalized.sourceEndpoint,
    targetEndpoint: normalized.targetEndpoint,
    width: SYNTHETIC_REVERSIBLE_WIDTH,
    height: SYNTHETIC_REVERSIBLE_HEIGHT,
    frameRate: SYNTHETIC_REVERSIBLE_FRAME_RATE,
    sourceBody,
    reversibleClip,
    targetBody,
    units,
    sourceRunway,
    targetRunway,
    frameIdentities,
  });
}

/**
 * Builds the browser-only M2 fixture. H.264 Annex B is attempted first and
 * VP8 remains an explicitly labeled scheduler/renderer fallback, matching M1.
 */
export async function createSyntheticReversibleFixture(
  options: SyntheticReversibleOptions = {},
): Promise<Readonly<SyntheticReversibleFixture>> {
  assertWebCodecsAvailable();
  const normalized = normalizeOptions(options);
  const metadata = createSyntheticReversibleMetadata(normalized);
  const blueprints = createBlueprints(normalized);
  const h264Candidate = makeCandidate("h264-annexb", normalized.bitrate);
  let h264AnnexB: SyntheticReversibleCodecStatus = "unsupported";
  let h264AnnexBReason: string | undefined;

  try {
    if (await queryCandidateSupport(h264Candidate)) {
      const encoded = await encodeCandidate(h264Candidate, blueprints);
      return assembleFixture(
        metadata,
        encoded,
        createCodecEvidence(h264Candidate, encoded, "supported"),
      );
    }
    h264AnnexBReason =
      "Exact H.264 encoder or decoder configuration unsupported";
  } catch (error) {
    h264AnnexB = "failed";
    h264AnnexBReason = errorMessage(error);
  }

  const vp8Candidate = makeCandidate("vp8", normalized.bitrate);
  try {
    if (!(await queryCandidateSupport(vp8Candidate))) {
      throw new Error("VP8 encoder or decoder configuration unsupported");
    }
    const encoded = await encodeCandidate(vp8Candidate, blueprints);
    return assembleFixture(
      metadata,
      encoded,
      createCodecEvidence(
        vp8Candidate,
        encoded,
        h264AnnexB,
        h264AnnexBReason,
      ),
    );
  } catch (error) {
    throw new SyntheticReversibleCreationError(
      `No synthetic reversible codec passed real encode/decode allocation: ${errorMessage(error)}`,
      h264AnnexB,
      h264AnnexBReason,
    );
  }
}

/** Short alias for callers that already name the returned value `fixture`. */
export function createSyntheticReversible(
  options: SyntheticReversibleOptions = {},
): Promise<Readonly<SyntheticReversibleFixture>> {
  return createSyntheticReversibleFixture(options);
}

function normalizeOptions(options: SyntheticReversibleOptions): NormalizedOptions {
  if (options === null || typeof options !== "object") {
    throw new TypeError("Synthetic reversible options must be an object");
  }
  const sourceEndpoint = options.sourceEndpoint ?? "idle";
  const targetEndpoint = options.targetEndpoint ?? "hovered";
  validateEndpoint(sourceEndpoint, "Source endpoint");
  validateEndpoint(targetEndpoint, "Target endpoint");
  if (sourceEndpoint === targetEndpoint) {
    throw new RangeError("Source and target endpoints must differ");
  }

  const bitrate = options.bitrate ?? DEFAULT_BITRATE;
  if (!Number.isSafeInteger(bitrate) || bitrate <= 0 || bitrate > 8_000_000) {
    throw new RangeError(
      "Synthetic reversible bitrate must be a positive safe integer no greater than 8,000,000",
    );
  }
  return { sourceEndpoint, targetEndpoint, bitrate };
}

function validateEndpoint(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function unitRoles(): readonly SyntheticReversibleUnitRole[] {
  return ["source-body", "reversible-clip", "target-body"];
}

function createBlueprints(options: NormalizedOptions): readonly UnitBlueprint[] {
  let globalStartFrame = 0;
  const definitions = [
    {
      id: "source-body",
      kind: "body",
      endpoint: options.sourceEndpoint,
      frameCount: SYNTHETIC_REVERSIBLE_BODY_FRAME_COUNT,
    },
    {
      id: "reversible-clip",
      kind: "reversible",
      endpoint: null,
      frameCount: SYNTHETIC_REVERSIBLE_CLIP_FRAME_COUNT,
    },
    {
      id: "target-body",
      kind: "body",
      endpoint: options.targetEndpoint,
      frameCount: SYNTHETIC_REVERSIBLE_BODY_FRAME_COUNT,
    },
  ] as const;

  const blueprints = definitions.map((definition) => {
    const frames = createFrameIdentities(
      definition.id,
      definition.endpoint,
      definition.frameCount,
    );
    const blueprint: UnitBlueprint = Object.freeze({
      ...definition,
      globalStartFrame,
      frames,
    });
    globalStartFrame += definition.frameCount;
    return blueprint;
  });
  return Object.freeze(blueprints);
}

function createFrameIdentities(
  unitRole: SyntheticReversibleUnitRole,
  endpoint: string | null,
  frameCount: number,
): readonly Readonly<SyntheticReversibleFrameIdentity>[] {
  const base = UNIT_TAG_BASES[unitRole];
  return Object.freeze(
    Array.from({ length: frameCount }, (_, localFrame) => {
      const tagValue = base + localFrame;
      return Object.freeze({
        unitRole,
        localFrame,
        tagValue,
        endpoint,
        key: Object.freeze({
          rendition: SYNTHETIC_REVERSIBLE_RENDITION_ID,
          unit: unitRole,
          localFrame,
        }),
        visualLabel: `${unitRole}:${String(localFrame).padStart(2, "0")}`,
      });
    }),
  );
}

function metadataFromBlueprint(
  blueprint: UnitBlueprint,
): Readonly<SyntheticReversibleUnitMetadata> {
  return Object.freeze({
    id: blueprint.id,
    kind: blueprint.kind,
    endpoint: blueprint.endpoint,
    frameCount: blueprint.frameCount,
    frames: blueprint.frames,
  });
}

function createRunway(
  endpoint: string,
  body: Readonly<SyntheticReversibleUnitMetadata>,
): Readonly<SyntheticEndpointRunwayMetadata> {
  if (body.id !== "source-body" && body.id !== "target-body") {
    throw new TypeError("A restart runway must reference a body unit");
  }
  const frames = Object.freeze(
    body.frames.slice(0, SYNTHETIC_REVERSIBLE_RUNWAY_FRAME_COUNT),
  );
  const keys = Object.freeze(frames.map((frame) => frame.key));
  return Object.freeze({
    endpoint,
    bodyUnitId: body.id,
    entryFrame: 0,
    frameCount: SYNTHETIC_REVERSIBLE_RUNWAY_FRAME_COUNT,
    frames,
    keys,
  });
}

function requireBlueprint(
  blueprints: readonly UnitBlueprint[],
  role: SyntheticReversibleUnitRole,
): UnitBlueprint {
  const blueprint = blueprints.find((candidate) => candidate.id === role);
  if (blueprint === undefined) {
    throw new Error(`Missing synthetic reversible unit ${role}`);
  }
  return blueprint;
}

function makeCandidate(
  label: SyntheticReversibleCodec,
  bitrate: number,
): CodecCandidate {
  const codec = label === "h264-annexb" ? H264_CODEC : VP8_CODEC;
  const encoderConfig: VideoEncoderConfig = {
    codec,
    width: SYNTHETIC_REVERSIBLE_WIDTH,
    height: SYNTHETIC_REVERSIBLE_HEIGHT,
    displayWidth: SYNTHETIC_REVERSIBLE_WIDTH,
    displayHeight: SYNTHETIC_REVERSIBLE_HEIGHT,
    framerate:
      SYNTHETIC_REVERSIBLE_FRAME_RATE.numerator /
      SYNTHETIC_REVERSIBLE_FRAME_RATE.denominator,
    bitrate,
    latencyMode: "realtime",
    hardwareAcceleration: "no-preference",
    ...(label === "h264-annexb" ? { avc: { format: "annexb" as const } } : {}),
  };
  const decoderConfig: VideoDecoderConfig = {
    codec,
    codedWidth: SYNTHETIC_REVERSIBLE_WIDTH,
    codedHeight: SYNTHETIC_REVERSIBLE_HEIGHT,
    displayAspectWidth: SYNTHETIC_REVERSIBLE_WIDTH,
    displayAspectHeight: SYNTHETIC_REVERSIBLE_HEIGHT,
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

async function encodeCandidate(
  candidate: CodecCandidate,
  blueprints: readonly UnitBlueprint[],
): Promise<EncodedCandidate> {
  const accessUnits = await encodeAccessUnits(candidate, blueprints);
  const encodedUnits: SyntheticEncodedReversibleUnit[] = [];
  const unitEvidence: SyntheticReversibleUnitCodecEvidence[] = [];

  for (const blueprint of blueprints) {
    const unitAccessUnits = accessUnits.slice(
      blueprint.globalStartFrame,
      blueprint.globalStartFrame + blueprint.frameCount,
    );
    if (unitAccessUnits.length !== blueprint.frameCount) {
      throw new Error(`Encoded ${blueprint.id} output is incomplete`);
    }
    const first = unitAccessUnits[0];
    if (first === undefined || first.type !== "key") {
      throw new Error(`${blueprint.id} frame zero is not independently decodable`);
    }
    const deltaAccessUnitCount = unitAccessUnits.filter(
      (accessUnit) => accessUnit.type === "delta",
    ).length;
    if (deltaAccessUnitCount === 0) {
      throw new Error(`${blueprint.id} must exercise dependent delta frames`);
    }

    let h264KeyAccessUnit: H264AnnexBKeyAccessUnitEvidence | undefined;
    if (candidate.annexB) {
      if (unitAccessUnits.some((accessUnit) => accessUnit.hasDecoderDescription)) {
        throw new Error(
          `${blueprint.id} Annex B output unexpectedly supplied a decoder description`,
        );
      }
      h264KeyAccessUnit = inspectH264AnnexBKeyAccessUnit(first.data);
    }

    const independent = await verifyDecoder(
      candidate.decoderConfig,
      unitAccessUnits,
      blueprint.frames,
      false,
    );
    const unit = createEncodedLoopUnit({
      config: candidate.decoderConfig,
      codedWidth: SYNTHETIC_REVERSIBLE_WIDTH,
      codedHeight: SYNTHETIC_REVERSIBLE_HEIGHT,
      displayWidth: SYNTHETIC_REVERSIBLE_WIDTH,
      displayHeight: SYNTHETIC_REVERSIBLE_HEIGHT,
      frameRate: SYNTHETIC_REVERSIBLE_FRAME_RATE,
      frames: unitAccessUnits.map((accessUnit) => ({
        type: accessUnit.type,
        data: accessUnit.data,
      })),
    });
    encodedUnits.push(
      Object.freeze({
        ...metadataFromBlueprint(blueprint),
        unit,
      }),
    );
    unitEvidence.push(
      Object.freeze({
        unitId: blueprint.id,
        encoderOutputCount: unitAccessUnits.length,
        independentDecoderOutputCount: independent.outputCount,
        firstAccessUnitType: "key",
        deltaAccessUnitCount,
        ...(h264KeyAccessUnit === undefined ? {} : { h264KeyAccessUnit }),
      }),
    );
  }

  const allIdentities = blueprints.flatMap((blueprint) => blueprint.frames);
  const sequential = await verifyDecoder(
    candidate.decoderConfig,
    accessUnits,
    allIdentities,
    true,
  );
  return {
    units: Object.freeze(encodedUnits),
    encoderOutputCount: accessUnits.length,
    sequentialDecoderOutputCount: sequential.outputCount,
    decodedTagCount: sequential.decodedTagCount,
    unitEvidence: Object.freeze(unitEvidence),
  };
}

async function encodeAccessUnits(
  candidate: CodecCandidate,
  blueprints: readonly UnitBlueprint[],
): Promise<readonly CallbackAccessUnit[]> {
  const canvas = createFixtureCanvas();
  const context = getCanvasContext(canvas);
  const accessUnits: CallbackAccessUnit[] = [];
  let encoderError: DOMException | undefined;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      accessUnits.push({
        type: chunk.type,
        timestamp: chunk.timestamp,
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
    for (const blueprint of blueprints) {
      for (const identity of blueprint.frames) {
        drawSyntheticReversibleFrame(context, identity);
        const ordinal = blueprint.globalStartFrame + identity.localFrame;
        const timestamp = timestampForFrame(
          ordinal,
          SYNTHETIC_REVERSIBLE_FRAME_RATE,
        );
        const duration = durationForFrame(
          ordinal,
          SYNTHETIC_REVERSIBLE_FRAME_RATE,
        );
        const frame = new VideoFrame(canvas, { timestamp, duration });
        try {
          encoder.encode(frame, { keyFrame: identity.localFrame === 0 });
        } finally {
          frame.close();
        }
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

  const expectedCount = blueprints.reduce(
    (sum, blueprint) => sum + blueprint.frameCount,
    0,
  );
  if (accessUnits.length !== expectedCount) {
    throw new Error(
      `Encoder produced ${accessUnits.length} outputs for ${expectedCount} reversible source frames`,
    );
  }
  for (let ordinal = 0; ordinal < accessUnits.length; ordinal += 1) {
    const actual = accessUnits[ordinal];
    const expectedTimestamp = timestampForFrame(
      ordinal,
      SYNTHETIC_REVERSIBLE_FRAME_RATE,
    );
    if (actual === undefined || actual.timestamp !== expectedTimestamp) {
      throw new Error(
        `Encoder callback order changed at output ${ordinal}: expected timestamp ${expectedTimestamp}, received ${String(actual?.timestamp)}`,
      );
    }
  }
  return Object.freeze(accessUnits);
}

async function verifyDecoder(
  config: VideoDecoderConfig,
  accessUnits: readonly CallbackAccessUnit[],
  identities: readonly Readonly<SyntheticReversibleFrameIdentity>[],
  validateTags: boolean,
): Promise<DecoderVerification> {
  if (accessUnits.length !== identities.length) {
    throw new Error("Decoder verification access-unit and identity counts differ");
  }
  let decoderError: DOMException | undefined;
  let outputCount = 0;
  let decodedTagCount = 0;
  const tagCopies: Promise<void>[] = [];
  const identityByTimestamp = new Map<number, SyntheticReversibleFrameIdentity>();
  identities.forEach((identity, ordinal) => {
    identityByTimestamp.set(
      timestampForFrame(ordinal, SYNTHETIC_REVERSIBLE_FRAME_RATE),
      identity,
    );
  });
  const decoder = new VideoDecoder({
    output: (frame) => {
      outputCount += 1;
      if (!validateTags) {
        frame.close();
        return;
      }
      const expected = identityByTimestamp.get(frame.timestamp);
      const copy = (async () => {
        try {
          if (expected === undefined) {
            throw new Error(
              `Decoder returned unexpected timestamp ${frame.timestamp}`,
            );
          }
          const tag = await readFrameTagFromVideoFrame(frame);
          if (tag.value !== expected.tagValue) {
            throw new Error(
              `Decoded ${expected.visualLabel} tag mismatch: expected ${expected.tagValue}, received ${tag.value}`,
            );
          }
          decodedTagCount += 1;
        } finally {
          frame.close();
        }
      })();
      tagCopies.push(copy);
    },
    error: (error) => {
      decoderError = error;
    },
  });

  try {
    decoder.configure(config);
    for (let ordinal = 0; ordinal < accessUnits.length; ordinal += 1) {
      const accessUnit = accessUnits[ordinal];
      if (accessUnit === undefined) {
        throw new Error(`Missing decoder-verification access unit ${ordinal}`);
      }
      decoder.decode(
        new EncodedVideoChunk({
          type: accessUnit.type,
          timestamp: timestampForFrame(
            ordinal,
            SYNTHETIC_REVERSIBLE_FRAME_RATE,
          ),
          duration: durationForFrame(
            ordinal,
            SYNTHETIC_REVERSIBLE_FRAME_RATE,
          ),
          data: accessUnit.data,
        }),
      );
    }
    await decoder.flush();
    await Promise.all(tagCopies);
    if (decoderError !== undefined) {
      throw decoderError;
    }
    if (outputCount !== accessUnits.length) {
      throw new Error(
        `Decoder produced ${outputCount} frames for ${accessUnits.length} access units`,
      );
    }
    if (validateTags && decodedTagCount !== identities.length) {
      throw new Error(
        `Decoder validated ${decodedTagCount} tags for ${identities.length} frames`,
      );
    }
    return { outputCount, decodedTagCount };
  } finally {
    if (decoder.state !== "closed") {
      decoder.close();
    }
  }
}

function drawSyntheticReversibleFrame(
  context: FrameTagCanvasContext,
  identity: Readonly<SyntheticReversibleFrameIdentity>,
): void {
  const width = SYNTHETIC_REVERSIBLE_WIDTH;
  const height = SYNTHETIC_REVERSIBLE_HEIGHT;
  const pose = poseFor(identity);
  const sourceHue = 225;
  const targetHue = 26;
  const hue = sourceHue + (targetHue + 360 - sourceHue) * pose;
  const gradient = context.createLinearGradient(0, 0, width, height * 0.8);
  gradient.addColorStop(0, `hsl(${hue % 360} 78% 28%)`);
  gradient.addColorStop(1, `hsl(${(hue + 58) % 360} 86% 12%)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  const trackLeft = width * 0.2;
  const trackRight = width * 0.8;
  const centerY = height * 0.42;
  const markerX = trackLeft + (trackRight - trackLeft) * pose;
  context.strokeStyle = "rgba(255, 255, 255, 0.28)";
  context.lineWidth = 5;
  context.beginPath();
  context.moveTo(trackLeft, centerY);
  context.lineTo(trackRight, centerY);
  context.stroke();

  context.fillStyle = "rgba(255, 255, 255, 0.96)";
  context.beginPath();
  context.arc(markerX, centerY, 22, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = `hsl(${hue % 360} 72% 34%)`;
  context.fillRect(markerX - 8, centerY - 8, 16, 16);

  context.fillStyle = "rgba(3, 7, 18, 0.72)";
  context.fillRect(12, 12, 166, 42);
  context.fillStyle = "rgba(255, 255, 255, 0.96)";
  context.font = "700 14px ui-monospace, monospace";
  context.textAlign = "left";
  context.textBaseline = "top";
  context.fillText(identity.unitRole, 22, 20);
  context.font = "600 12px ui-monospace, monospace";
  context.fillText(
    `frame ${String(identity.localFrame).padStart(2, "0")} · tag 0x${identity.tagValue.toString(16)}`,
    22,
    38,
  );

  drawFrameTag(context, identity.tagValue, width, height);
}

function poseFor(identity: Readonly<SyntheticReversibleFrameIdentity>): number {
  if (identity.unitRole === "reversible-clip") {
    const t =
      (identity.localFrame + 1) / (SYNTHETIC_REVERSIBLE_CLIP_FRAME_COUNT + 1);
    return t * t * (3 - 2 * t);
  }
  const direction = identity.unitRole === "source-body" ? 1 : -1;
  const endpoint = identity.unitRole === "source-body" ? 0 : 1;
  const phase =
    (identity.localFrame / SYNTHETIC_REVERSIBLE_BODY_FRAME_COUNT) * Math.PI * 2;
  return endpoint + direction * Math.sin(phase) * 0.025;
}

function createFixtureCanvas(): FixtureCanvas {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(
      SYNTHETIC_REVERSIBLE_WIDTH,
      SYNTHETIC_REVERSIBLE_HEIGHT,
    );
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = SYNTHETIC_REVERSIBLE_WIDTH;
    canvas.height = SYNTHETIC_REVERSIBLE_HEIGHT;
    return canvas;
  }
  throw new Error("Synthetic reversible fixture creation needs a browser canvas");
}

function getCanvasContext(canvas: FixtureCanvas): FrameTagCanvasContext {
  const context = canvas.getContext("2d", {
    alpha: false,
    desynchronized: true,
  });
  if (context === null || !("fillRect" in context)) {
    throw new Error("A 2D canvas context is required for the reversible fixture");
  }
  return context as FrameTagCanvasContext;
}

function createCodecEvidence(
  candidate: CodecCandidate,
  encoded: EncodedCandidate,
  h264AnnexB: SyntheticReversibleCodecStatus,
  h264AnnexBReason?: string,
): Readonly<SyntheticReversibleCodecEvidence> {
  return Object.freeze({
    selectedCodec: candidate.label,
    selectedCodecString: candidate.codec,
    compatibleIndependentUnits: "supported",
    h264AnnexB,
    ...(h264AnnexBReason === undefined ? {} : { h264AnnexBReason }),
    encoderOutputCount: encoded.encoderOutputCount,
    sequentialDecoderOutputCount: encoded.sequentialDecoderOutputCount,
    decodedTagCount: encoded.decodedTagCount,
    units: encoded.unitEvidence,
  });
}

function assembleFixture(
  metadata: Readonly<SyntheticReversibleMetadata>,
  encoded: EncodedCandidate,
  evidence: Readonly<SyntheticReversibleCodecEvidence>,
): Readonly<SyntheticReversibleFixture> {
  const sourceBody = requireEncodedUnit(encoded.units, "source-body");
  const reversibleClip = requireEncodedUnit(encoded.units, "reversible-clip");
  const targetBody = requireEncodedUnit(encoded.units, "target-body");
  const sourceRunway = createRunway(metadata.sourceEndpoint, sourceBody);
  const targetRunway = createRunway(metadata.targetEndpoint, targetBody);
  const frameIdentities = Object.freeze(
    encoded.units.flatMap((unit) => unit.frames),
  );
  return Object.freeze({
    sourceEndpoint: metadata.sourceEndpoint,
    targetEndpoint: metadata.targetEndpoint,
    width: metadata.width,
    height: metadata.height,
    frameRate: metadata.frameRate,
    sourceBody,
    reversibleClip,
    targetBody,
    units: encoded.units,
    sourceRunway,
    targetRunway,
    frameIdentities,
    evidence,
  });
}

function requireEncodedUnit(
  units: readonly Readonly<SyntheticEncodedReversibleUnit>[],
  role: SyntheticReversibleUnitRole,
): Readonly<SyntheticEncodedReversibleUnit> {
  const unit = units.find((candidate) => candidate.id === role);
  if (unit === undefined) {
    throw new Error(`Missing encoded synthetic reversible unit ${role}`);
  }
  return unit;
}

function assertWebCodecsAvailable(): void {
  if (
    typeof VideoEncoder === "undefined" ||
    typeof VideoDecoder === "undefined" ||
    typeof VideoFrame === "undefined" ||
    typeof EncodedVideoChunk === "undefined"
  ) {
    throw new SyntheticReversibleCreationError(
      "This browser does not expose the WebCodecs APIs needed by the reversible fixture",
      "unsupported",
      "WebCodecs API unavailable",
    );
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
