import type {
  H264Codec,
  H264LevelIdc
} from "./codec.js";

/** A single Annex B access unit and its container key assertion. */
export interface H264AccessUnitInput {
  readonly bytes: Uint8Array;
  readonly key: boolean;
}

/** An independently decodable unit. Frame zero must be a closed-GOP IDR. */
export interface H264UnitInput {
  readonly id: string;
  readonly accessUnits: readonly H264AccessUnitInput[];
}

export interface H264FrameRate {
  readonly numerator: number;
  readonly denominator: number;
}

/** Non-bitstream facts required to match the canonical H264 profile. */
export interface H264Profile {
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly expectedVisibleRect?: readonly [
    x: 0,
    y: 0,
    width: number,
    height: number
  ];
  readonly frameRate: H264FrameRate;
  readonly requireBt709LimitedRange: true;
}

export interface H264RenditionInspectionInput {
  readonly profile: H264Profile;
  readonly units: readonly H264UnitInput[];
}

export interface H264CropSummary {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly visibleWidth: number;
  readonly visibleHeight: number;
}

export interface H264ColorSummary {
  readonly fullRange: boolean;
  readonly colourPrimaries?: number;
  readonly transferCharacteristics?: number;
  readonly matrixCoefficients?: number;
}

export interface H264ParameterSetSummary {
  readonly profile: "constrained-baseline";
  readonly profileIdc: 66;
  readonly codec: H264Codec;
  readonly levelIdc: H264LevelIdc;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly crop: H264CropSummary;
  readonly bitDepth: 8;
  readonly chromaFormat: "4:2:0";
  readonly maxNumRefFrames: number;
  readonly maxNumReorderFrames: number;
  readonly maxDecFrameBuffering: number;
  readonly hrdPresent: boolean;
  readonly fixedFrameRate: boolean;
  readonly squareSampleAspect: boolean;
  readonly color: H264ColorSummary;
}

export interface H264AccessUnitSummary {
  readonly decodeIndex: number;
  readonly presentationIndex: number;
  readonly pictureOrderCount: number;
  readonly key: boolean;
  readonly idr: boolean;
  readonly sliceType: "I" | "P";
  readonly sliceCount: number;
  readonly nalUnitTypes: readonly number[];
}

export interface H264UnitInspection {
  readonly id: string;
  readonly accessUnits: readonly H264AccessUnitSummary[];
  readonly decodeToPresentation: readonly number[];
}

export interface H264RenditionInspection {
  readonly parameterSet: H264ParameterSetSummary;
  readonly macroblocksPerFrame: number;
  readonly units: readonly H264UnitInspection[];
}

/** One raw FFmpeg Annex B stream for an independently encoded unit. */
export interface H264EncoderUnitStreamInput {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly expectedAccessUnitCount: number;
}

export interface H264EncoderRenditionPreparationInput {
  readonly profile: H264Profile;
  readonly units: readonly H264EncoderUnitStreamInput[];
}

/** Canonical E0 access units detached from all caller-owned raw streams. */
export interface H264EncoderRenditionPreparation {
  readonly units: readonly H264UnitInput[];
  readonly inspection: H264RenditionInspection;
}
