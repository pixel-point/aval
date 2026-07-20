import {
  canonicalizeH265EncoderUnitStream,
  FormatError,
  inspectH265AnnexBRendition,
  prepareH264EncoderRendition,
  type H264RenditionInspection,
  type H265RenditionInspection,
  type VideoBitDepth,
  type VideoRenditionGeometry
} from "@pixel-point/aval-format";

import { CompilerError } from "../diagnostics.js";
import {
  createEncodeVideoUnitInvocation,
  encodeElementaryVideoUnit,
  encodeIvfVideoUnit,
  type RawYuv420FrameSource
} from "../ffmpeg/video-encode-unit.js";
import type {
  NormalizedSourceProject,
  NormalizedSourceRenditionTarget,
  NormalizedVideoEncoding
} from "../model.js";
import {
  prepareAv1Rendition,
  prepareVp9Rendition,
  type IvfEncodedUnitInput
} from "./ivf-codec-adapters.js";
import type { PreparedEncodingRendition } from "./project-encoding-compiler.js";

type H264Encoding = Extract<NormalizedVideoEncoding, { readonly codec: "h264" }>;
type H265Encoding = Extract<NormalizedVideoEncoding, { readonly codec: "h265" }>;
type Vp9Encoding = Extract<NormalizedVideoEncoding, { readonly codec: "vp9" }>;
type Av1Encoding = Extract<NormalizedVideoEncoding, { readonly codec: "av1" }>;

export interface CodecEncodeInput<E extends NormalizedVideoEncoding> {
  readonly unitId: string;
  readonly expectedFrames: number;
  readonly source: Readonly<RawYuv420FrameSource>;
  readonly encoding: Readonly<E>;
  readonly rendition: Readonly<NormalizedSourceRenditionTarget>;
  readonly geometry: Readonly<VideoRenditionGeometry>;
  readonly executable: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface EncodedCodecUnit<U> {
  readonly unit: Readonly<U>;
  readonly invocationArguments: readonly string[];
}

export interface CodecPrepareInput<E extends NormalizedVideoEncoding, U> {
  readonly encoding: Readonly<E>;
  readonly renditionId: string;
  readonly geometry: Readonly<VideoRenditionGeometry>;
  readonly frameRate: NormalizedSourceProject["frameRate"];
  readonly units: readonly Readonly<U>[];
}

export interface VideoCodecCompiler<
  E extends NormalizedVideoEncoding,
  U
> {
  readonly alignment: Readonly<{ readonly width: number; readonly height: number }>;
  bitDepth(encoding: Readonly<E>): VideoBitDepth;
  encode(input: Readonly<CodecEncodeInput<E>>): Promise<Readonly<EncodedCodecUnit<U>>>;
  prepare(input: Readonly<CodecPrepareInput<E, U>>): Readonly<PreparedEncodingRendition>;
}

interface EncodedElementaryUnit {
  readonly id: string;
  readonly expectedFrames: number;
  readonly rawBytes: Uint8Array;
}

const MACROBLOCK_ALIGNMENT = Object.freeze({ width: 16, height: 16 });
const YUV420_ALIGNMENT = Object.freeze({ width: 2, height: 2 });

export const H264_VIDEO_CODEC_COMPILER: VideoCodecCompiler<
  H264Encoding,
  EncodedElementaryUnit
> = Object.freeze({
  alignment: MACROBLOCK_ALIGNMENT,
  bitDepth: () => 8,
  encode: encodeElementaryUnit,
  prepare: prepareH264Rendition
});

export const H265_VIDEO_CODEC_COMPILER: VideoCodecCompiler<
  H265Encoding,
  EncodedElementaryUnit
> = Object.freeze({
  alignment: YUV420_ALIGNMENT,
  bitDepth: () => 8,
  encode: encodeElementaryUnit,
  prepare: prepareH265Rendition
});

export const VP9_VIDEO_CODEC_COMPILER: VideoCodecCompiler<
  Vp9Encoding,
  IvfEncodedUnitInput
> = Object.freeze({
  alignment: YUV420_ALIGNMENT,
  bitDepth: () => 8,
  encode: encodeIvfUnit,
  prepare: prepareVp9EncodingRendition
});

export const AV1_VIDEO_CODEC_COMPILER: VideoCodecCompiler<
  Av1Encoding,
  IvfEncodedUnitInput
> = Object.freeze({
  alignment: YUV420_ALIGNMENT,
  bitDepth: (encoding: Readonly<Av1Encoding>) => encoding.bitDepth,
  encode: encodeIvfUnit,
  prepare: prepareAv1EncodingRendition
});

async function encodeElementaryUnit(
  input: Readonly<CodecEncodeInput<H264Encoding | H265Encoding>>
): Promise<Readonly<EncodedCodecUnit<EncodedElementaryUnit>>> {
  const encodeInput = ffmpegEncodeInput(input);
  const invocation = createEncodeVideoUnitInvocation(encodeInput);
  const rawBytes = await encodeElementaryVideoUnit(encodeInput);
  return Object.freeze({
    unit: Object.freeze({
      id: input.unitId,
      expectedFrames: input.expectedFrames,
      rawBytes
    }),
    invocationArguments: invocation.arguments
  });
}

async function encodeIvfUnit(
  input: Readonly<CodecEncodeInput<Vp9Encoding | Av1Encoding>>
): Promise<Readonly<EncodedCodecUnit<IvfEncodedUnitInput>>> {
  const encodeInput = ffmpegEncodeInput(input);
  const invocation = createEncodeVideoUnitInvocation(encodeInput);
  const encoded = await encodeIvfVideoUnit(encodeInput);
  return Object.freeze({
    unit: Object.freeze({
      id: input.unitId,
      expectedDisplayedFrames: input.expectedFrames,
      packets: encoded.packets
    }),
    invocationArguments: invocation.arguments
  });
}

function ffmpegEncodeInput<E extends NormalizedVideoEncoding>(
  input: Readonly<CodecEncodeInput<E>>
) {
  return {
    source: input.source,
    startFrame: 0,
    endFrame: input.expectedFrames,
    encoding: input.encoding,
    rendition: input.rendition,
    geometry: input.geometry,
    executable: input.executable,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.signal === undefined ? {} : { signal: input.signal })
  };
}

function prepareH264Rendition(
  input: Readonly<CodecPrepareInput<H264Encoding, EncodedElementaryUnit>>
): Readonly<PreparedEncodingRendition> {
  let prepared: ReturnType<typeof prepareH264EncoderRendition>;
  try {
    prepared = prepareH264EncoderRendition({
      profile: inspectionProfile(input.geometry, input.frameRate),
      units: input.units.map((unit) => Object.freeze({
        id: unit.id,
        bytes: unit.rawBytes,
        expectedAccessUnitCount: unit.expectedFrames
      }))
    });
  } catch (cause) {
    if (cause instanceof FormatError) {
      throw new CompilerError("H264_BITSTREAM_INVALID", cause.message, {
        cause,
        rendition: input.renditionId
      });
    }
    throw cause;
  }
  const bitrate = measuredBitrate(
    prepared.units.flatMap(({ accessUnits }) => accessUnits.map(({ bytes }) => bytes)),
    totalElementaryFrames(input.units),
    input.frameRate,
    "H.264"
  );
  return Object.freeze({
    id: input.renditionId,
    codec: prepared.inspection.parameterSet.codec,
    bitDepth: 8,
    geometry: input.geometry,
    bitrate: Object.freeze({ average: bitrate, peak: bitrate }),
    units: Object.freeze(prepared.units.map((unit, unitIndex) => {
      const inspected = requiredH264Unit(prepared.inspection, unitIndex, unit.id);
      return Object.freeze({
        id: unit.id,
        chunks: Object.freeze(unit.accessUnits.map((accessUnit, decodeIndex) => {
          const summary = inspected.accessUnits[decodeIndex];
          if (summary === undefined || summary.decodeIndex !== decodeIndex) {
            throw new CompilerError(
              "ASSET_INVALID",
              "H.264 inspection omitted or reordered a decode access unit",
              { unit: unit.id }
            );
          }
          return Object.freeze({
            bytes: accessUnit.bytes,
            presentationTimestamp: summary.presentationIndex,
            duration: 1,
            randomAccess: summary.key,
            displayedFrameCount: 1
          });
        }))
      });
    }))
  });
}

function prepareH265Rendition(
  input: Readonly<CodecPrepareInput<H265Encoding, EncodedElementaryUnit>>
): Readonly<PreparedEncodingRendition> {
  const canonicalUnits = input.units.map((unit) => Object.freeze({
    id: unit.id,
    accessUnits: canonicalizeH265EncoderUnitStream(
      unit.rawBytes,
      unit.expectedFrames,
      `units.${unit.id}`
    )
  }));
  const inspection = inspectH265AnnexBRendition({
    profile: inspectionProfile(input.geometry, input.frameRate),
    units: canonicalUnits
  });
  const bitrate = measuredBitrate(
    canonicalUnits.flatMap(({ accessUnits }) => accessUnits.map(({ bytes }) => bytes)),
    totalElementaryFrames(input.units),
    input.frameRate,
    "H.265"
  );
  return Object.freeze({
    id: input.renditionId,
    codec: inspection.decoderConfig.codec,
    bitDepth: 8,
    geometry: input.geometry,
    bitrate: Object.freeze({ average: bitrate, peak: bitrate }),
    units: Object.freeze(canonicalUnits.map((unit, unitIndex) => {
      const inspected = requiredH265Unit(inspection, unitIndex, unit.id);
      return Object.freeze({
        id: unit.id,
        chunks: Object.freeze(unit.accessUnits.map((accessUnit, decodeIndex) => {
          const summary = inspected.accessUnits[decodeIndex];
          if (summary === undefined) {
            throw new CompilerError(
              "ASSET_INVALID",
              "HEVC inspection omitted an access unit",
              { unit: unit.id }
            );
          }
          return Object.freeze({
            bytes: accessUnit.bytes,
            presentationTimestamp: summary.presentationIndex,
            duration: 1,
            randomAccess: summary.key,
            displayedFrameCount: 1
          });
        }))
      });
    }))
  });
}

function prepareVp9EncodingRendition(
  input: Readonly<CodecPrepareInput<Vp9Encoding, IvfEncodedUnitInput>>
): Readonly<PreparedEncodingRendition> {
  const prepared = prepareVp9Rendition({
    width: input.geometry.codedWidth,
    height: input.geometry.codedHeight,
    frameRate: input.frameRate,
    units: input.units
  });
  return lowerIvfRendition(input, prepared);
}

function prepareAv1EncodingRendition(
  input: Readonly<CodecPrepareInput<Av1Encoding, IvfEncodedUnitInput>>
): Readonly<PreparedEncodingRendition> {
  const prepared = prepareAv1Rendition({
    width: input.geometry.codedWidth,
    height: input.geometry.codedHeight,
    bitDepth: input.encoding.bitDepth,
    frameRate: input.frameRate,
    units: input.units
  });
  return lowerIvfRendition(input, prepared);
}

function lowerIvfRendition(
  input: Readonly<CodecPrepareInput<Vp9Encoding | Av1Encoding, IvfEncodedUnitInput>>,
  prepared: Readonly<ReturnType<typeof prepareVp9Rendition> | ReturnType<typeof prepareAv1Rendition>>
): Readonly<PreparedEncodingRendition> {
  return Object.freeze({
    id: input.renditionId,
    codec: prepared.codec,
    bitDepth: prepared.bitDepth,
    geometry: input.geometry,
    bitrate: prepared.bitrate,
    units: Object.freeze(prepared.units.map(({ id, chunks }) =>
      Object.freeze({ id, chunks })
    ))
  });
}

function inspectionProfile(
  geometry: Readonly<VideoRenditionGeometry>,
  frameRate: NormalizedSourceProject["frameRate"]
) {
  return Object.freeze({
    codedWidth: geometry.codedWidth,
    codedHeight: geometry.codedHeight,
    expectedVisibleRect: Object.freeze([
      0,
      0,
      geometry.decodedStorageRect[2],
      geometry.decodedStorageRect[3]
    ] as const),
    frameRate,
    requireBt709LimitedRange: true as const
  });
}

function requiredH264Unit(
  inspection: Readonly<H264RenditionInspection>,
  index: number,
  id: string
): H264RenditionInspection["units"][number] {
  const unit = inspection.units[index];
  if (unit === undefined || unit.id !== id) {
    throw new CompilerError(
      "ASSET_INVALID",
      "H.264 inspection unit order changed",
      { unit: id }
    );
  }
  return unit;
}

function requiredH265Unit(
  inspection: Readonly<H265RenditionInspection>,
  index: number,
  id: string
): H265RenditionInspection["units"][number] {
  const unit = inspection.units[index];
  if (unit === undefined || unit.id !== id) {
    throw new CompilerError(
      "ASSET_INVALID",
      "HEVC inspection unit order changed",
      { unit: id }
    );
  }
  return unit;
}

function totalElementaryFrames(
  units: readonly Readonly<EncodedElementaryUnit>[]
): number {
  return units.reduce((total, unit) =>
    checkedAdd(total, unit.expectedFrames, "encoded frame count"), 0
  );
}

function measuredBitrate(
  chunks: readonly Uint8Array[],
  frames: number,
  frameRate: NormalizedSourceProject["frameRate"],
  codec: string
): number {
  let bytes = 0;
  for (const chunk of chunks) {
    bytes = checkedAdd(bytes, chunk.byteLength, `${codec} encoded bytes`);
  }
  const numerator = bytes * 8 * frameRate.numerator;
  const denominator = frames * frameRate.denominator;
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    denominator < 1
  ) {
    throw new CompilerError("OUTPUT_LIMIT", `${codec} bitrate exceeds safe arithmetic`);
  }
  return Math.max(1, Math.ceil(numerator / denominator));
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new CompilerError("OUTPUT_LIMIT", `${label} exceeds safe arithmetic`);
  }
  return result;
}
