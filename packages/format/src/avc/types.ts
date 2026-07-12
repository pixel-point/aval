/** A single Annex B access unit and its container key assertion. */
export interface AvcAccessUnitInput {
  readonly bytes: Uint8Array;
  readonly key: boolean;
}

/** An independently decodable unit. Frame zero must be a closed-GOP IDR. */
export interface AvcUnitInput {
  readonly id: string;
  readonly accessUnits: readonly AvcAccessUnitInput[];
}

export interface AvcFrameRate {
  readonly numerator: number;
  readonly denominator: number;
}

/**
 * The non-bitstream limits supplied by the compiler profile. `cpbBufferBits`
 * is the exact FFmpeg VBV buffer setting; when HRD is present it is also
 * checked against the value signalled by the SPS.
 */
export interface AvcConstrainedBaselineProfile {
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly frameRate: AvcFrameRate;
  readonly averageBitrate: number;
  readonly peakBitrate: number;
  readonly cpbBufferBits: number;
  readonly requireBt709LimitedRange: true;
}

export interface AvcRenditionInspectionInput {
  readonly profile: AvcConstrainedBaselineProfile;
  readonly units: readonly AvcUnitInput[];
}

export interface AvcCropSummary {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly visibleWidth: number;
  readonly visibleHeight: number;
}

export interface AvcColorSummary {
  readonly fullRange: boolean;
  readonly colourPrimaries?: number;
  readonly transferCharacteristics?: number;
  readonly matrixCoefficients?: number;
}

export interface AvcParameterSetSummary {
  readonly profileIdc: 66;
  readonly constraintSet2: boolean;
  readonly levelIdc: 32;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly crop: AvcCropSummary;
  readonly maxNumRefFrames: 1;
  readonly maxNumReorderFrames: 0;
  readonly maxDecFrameBuffering: number;
  readonly hrdPresent: boolean;
  readonly fixedFrameRate: boolean;
  readonly squareSampleAspect: boolean;
  readonly color: AvcColorSummary;
}

export interface AvcAccessUnitSummary {
  readonly frameIndex: number;
  readonly key: boolean;
  readonly idr: boolean;
  readonly sliceType: "I" | "P";
  readonly sliceCount: number;
  readonly nalUnitTypes: readonly number[];
}

export interface AvcUnitInspection {
  readonly id: string;
  readonly frames: readonly AvcAccessUnitSummary[];
}

export interface AvcRenditionInspection {
  readonly parameterSet: AvcParameterSetSummary;
  readonly macroblocksPerFrame: number;
  readonly units: readonly AvcUnitInspection[];
}

/** One sequential worker sample inspected before it reaches a decoder. */
export interface AvcIncrementalAccessUnitInput extends AvcAccessUnitInput {
  readonly unitId: string;
  readonly unitInstance: number;
  readonly unitFrame: number;
  readonly unitFrameCount: number;
}

/** Immutable, byte-view-free result used to derive the decoder chunk type. */
export interface AvcIncrementalAccessUnitInspection {
  readonly unitId: string;
  readonly unitInstance: number;
  readonly unitFrame: number;
  readonly unitFrameCount: number;
  readonly unitComplete: boolean;
  readonly chunkType: "key" | "delta";
  readonly accessUnit: AvcAccessUnitSummary;
}

/** One raw FFmpeg Annex B stream for an independently encoded unit. */
export interface AvcEncoderUnitStreamInput {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly expectedAccessUnitCount: number;
}

export interface AvcEncoderRenditionPreparationInput {
  readonly profile: AvcConstrainedBaselineProfile;
  readonly units: readonly AvcEncoderUnitStreamInput[];
}

/** Canonical E0 access units detached from all caller-owned raw streams. */
export interface AvcEncoderRenditionPreparation {
  readonly units: readonly AvcUnitInput[];
  readonly inspection: AvcRenditionInspection;
  readonly canonicalizations: readonly {
    readonly unitId: string;
    readonly constraintSet2Canonicalized: boolean;
  }[];
}
