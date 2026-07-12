import { FORMAT_DEFAULT_BUDGETS, IDENTIFIER_PATTERN } from "../constants.js";
import { FormatError, isFormatError } from "../errors.js";
import {
  AVC_NAL_TYPE_AUD,
  AVC_NAL_TYPE_IDR,
  AVC_NAL_TYPE_NON_IDR,
  AVC_NAL_TYPE_PPS,
  AVC_NAL_TYPE_SPS,
  splitAnnexBAccessUnit,
  type AnnexBNalUnit
} from "./annex-b.js";
import { RbspBitReader } from "./bit-reader.js";
import { avcInvalid, requireAvc } from "./failure.js";
import {
  parsePps,
  parseSps,
  type ParsedPps,
  type ParsedSps
} from "./parameter-sets.js";
import {
  parseSliceHeader,
  samePrimaryPicture,
  type ParsedSliceHeader
} from "./slice-header.js";
import type {
  AvcAccessUnitInput,
  AvcAccessUnitSummary,
  AvcConstrainedBaselineProfile,
  AvcParameterSetSummary,
  AvcRenditionInspection,
  AvcRenditionInspectionInput,
  AvcUnitInspection
} from "./types.js";

const LEVEL_3_2_MAX_MACROBLOCKS_PER_FRAME = 5_120;
const LEVEL_3_2_MAX_MACROBLOCKS_PER_SECOND = 216_000;
const LEVEL_3_2_MAX_DPB_MACROBLOCKS = 20_480;
const PROFILE_MAX_BITRATE = 8_000_000;
const PROFILE_MAX_CPB_BITS = 8_000_000;

export interface AvcParameterSetState {
  readonly sps: ParsedSps;
  readonly pps: ParsedPps;
}

export interface AvcPictureOrderState {
  previousFrameNum: number;
  frameNumOffset: number;
  previousPoc: number;
  previousPocMsb: number;
  previousPocLsb: number;
}

export interface AvcAccessUnitStateResult {
  readonly summary: AvcAccessUnitSummary;
  readonly parameterSets: AvcParameterSetState;
}

export type AvcCompatibilityPolicy = "strict" | "encoder-candidate";

/**
 * Inspects every access unit in an independently decodable rendition.
 *
 * This is intentionally a syntax/dependency verifier, not a decoder. It
 * accepts only the narrow AVC v0 Constrained Baseline subset and returns a
 * deeply immutable scalar summary; no caller-owned byte views escape.
 */
export function inspectAvcAnnexBRendition(
  input: AvcRenditionInspectionInput
): AvcRenditionInspection {
  return inspectRendition(input, "strict");
}

/**
 * Proves the complete v0 subset while tolerating libx264's C0 compatibility
 * byte solely as an encoder-normalization candidate.
 */
export function inspectAvcAnnexBEncoderCandidateRendition(
  input: AvcRenditionInspectionInput
): AvcRenditionInspection {
  return inspectRendition(input, "encoder-candidate");
}

function inspectRendition(
  input: AvcRenditionInspectionInput,
  compatibilityPolicy: AvcCompatibilityPolicy
): AvcRenditionInspection {
  try {
    const profile = cloneAvcProfile(input?.profile);
    requireAvc(Array.isArray(input?.units), "units", "units must be an array");
    requireAvc(input.units.length > 0, "units", "at least one unit is required");
    requireAvc(
      input.units.length <= FORMAT_DEFAULT_BUDGETS.maxUnits,
      "units",
      "unit count exceeds the format budget"
    );

    const seenUnitIds = new Set<string>();
    let stableParameterSets: AvcParameterSetState | undefined;
    let macroblocksPerFrame: number | undefined;
    let totalFrames = 0;
    const units: AvcUnitInspection[] = [];

    for (let unitIndex = 0; unitIndex < input.units.length; unitIndex += 1) {
      const unit = input.units[unitIndex];
      const unitPath = `units[${String(unitIndex)}]`;
      requireAvc(unit !== undefined, unitPath, "unit is missing");
      requireAvc(
        typeof unit.id === "string" && IDENTIFIER_PATTERN.test(unit.id),
        `${unitPath}.id`,
        "unit id is invalid"
      );
      requireAvc(
        !seenUnitIds.has(unit.id),
        `${unitPath}.id`,
        "unit id is duplicated"
      );
      seenUnitIds.add(unit.id);
      requireAvc(
        Array.isArray(unit.accessUnits) && unit.accessUnits.length > 0,
        `${unitPath}.accessUnits`,
        "unit must contain at least one access unit"
      );
      totalFrames += unit.accessUnits.length;
      requireAvc(
        totalFrames <= FORMAT_DEFAULT_BUDGETS.maxTotalUnitFrames,
        `${unitPath}.accessUnits`,
        "total frame count exceeds the format budget"
      );

      const orderState = createAvcPictureOrderState();
      const frames: AvcAccessUnitSummary[] = [];
      let activeParameterSets = stableParameterSets;

      for (
        let frameIndex = 0;
        frameIndex < unit.accessUnits.length;
        frameIndex += 1
      ) {
        const accessUnit = unit.accessUnits[frameIndex];
        const framePath = `${unitPath}.accessUnits[${String(frameIndex)}]`;
        validateAvcAccessUnitInput(accessUnit, framePath);
        const result = inspectAvcAccessUnitStatefully(
          accessUnit,
          frameIndex,
          framePath,
          activeParameterSets,
          stableParameterSets,
          profile,
          orderState,
          macroblocksPerFrame,
          compatibilityPolicy
        );
        activeParameterSets = result.parameterSets;
        if (stableParameterSets === undefined) {
          stableParameterSets = result.parameterSets;
          macroblocksPerFrame = validateAvcSpsAgainstProfile(
            stableParameterSets.sps,
            profile,
            `${framePath}.sps`,
            compatibilityPolicy
          );
        }
        frames.push(result.summary);
      }

      units.push(Object.freeze({ id: unit.id, frames: Object.freeze(frames) }));
    }

    if (stableParameterSets === undefined || macroblocksPerFrame === undefined) {
      avcInvalid("units", "no AVC parameter sets were found");
    }
    const parameterSet = createAvcParameterSetSummary(stableParameterSets.sps);
    return Object.freeze({
      parameterSet,
      macroblocksPerFrame,
      units: Object.freeze(units)
    });
  } catch (error) {
    if (isFormatError(error)) {
      throw error;
    }
    throw new FormatError("PROFILE_INVALID", "AVC inspection failed");
  }
}

export function cloneAvcProfile(
  profile: AvcConstrainedBaselineProfile | undefined
): AvcConstrainedBaselineProfile {
  requireAvc(profile !== undefined, "profile", "AVC profile is required");
  positiveInteger(profile.codedWidth, "profile.codedWidth", 2_048);
  positiveInteger(profile.codedHeight, "profile.codedHeight", 2_048);
  positiveInteger(profile.frameRate?.numerator, "profile.frameRate.numerator");
  positiveInteger(profile.frameRate?.denominator, "profile.frameRate.denominator");
  positiveInteger(profile.averageBitrate, "profile.averageBitrate", PROFILE_MAX_BITRATE);
  positiveInteger(profile.peakBitrate, "profile.peakBitrate", PROFILE_MAX_BITRATE);
  positiveInteger(profile.cpbBufferBits, "profile.cpbBufferBits", PROFILE_MAX_CPB_BITS);
  requireAvc(
    profile.averageBitrate <= profile.peakBitrate,
    "profile.averageBitrate",
    "average bitrate must not exceed peak bitrate"
  );
  requireAvc(
    profile.cpbBufferBits === profile.peakBitrate,
    "profile.cpbBufferBits",
    "CPB buffer bits must equal peak bitrate"
  );
  requireAvc(
    profile.requireBt709LimitedRange === true,
    "profile.requireBt709LimitedRange",
    "the M5 AVC profile requires BT.709 limited range"
  );
  return Object.freeze({
    codedWidth: profile.codedWidth,
    codedHeight: profile.codedHeight,
    frameRate: Object.freeze({
      numerator: profile.frameRate.numerator,
      denominator: profile.frameRate.denominator
    }),
    averageBitrate: profile.averageBitrate,
    peakBitrate: profile.peakBitrate,
    cpbBufferBits: profile.cpbBufferBits,
    requireBt709LimitedRange: true
  });
}

function positiveInteger(value: unknown, path: string, maximum?: number): void {
  requireAvc(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value > 0 &&
      (maximum === undefined || value <= maximum),
    path,
    maximum === undefined
      ? "must be a positive safe integer"
      : `must be a positive safe integer no greater than ${String(maximum)}`
  );
}

export function validateAvcAccessUnitInput(
  accessUnit: AvcAccessUnitInput | undefined,
  path: string
): asserts accessUnit is AvcAccessUnitInput {
  requireAvc(accessUnit !== undefined, path, "access unit is missing");
  requireAvc(
    accessUnit.bytes instanceof Uint8Array,
    `${path}.bytes`,
    "access unit bytes must be a Uint8Array"
  );
  requireAvc(
    accessUnit.bytes.length <= FORMAT_DEFAULT_BUDGETS.maxSampleBytes,
    `${path}.bytes`,
    "access unit exceeds the sample budget"
  );
  requireAvc(
    typeof accessUnit.key === "boolean",
    `${path}.key`,
    "access unit key assertion must be boolean"
  );
}

export function inspectAvcAccessUnitStatefully(
  accessUnit: AvcAccessUnitInput,
  frameIndex: number,
  path: string,
  activeParameterSets: AvcParameterSetState | undefined,
  stableParameterSets: AvcParameterSetState | undefined,
  profile: AvcConstrainedBaselineProfile,
  orderState: AvcPictureOrderState,
  knownMacroblocksPerFrame: number | undefined,
  compatibilityPolicy: AvcCompatibilityPolicy = "strict"
): AvcAccessUnitStateResult {
  const nals = splitAnnexBAccessUnit(accessUnit.bytes, `${path}.bytes`);
  const nalTypes = Object.freeze(nals.map((nal) => nal.type));
  let parsedSps: ParsedSps | undefined;
  let parsedPps: ParsedPps | undefined;
  let audPrimaryPicType: number | undefined;
  const vcl: AnnexBNalUnit[] = [];
  let reachedVcl = false;

  for (let index = 0; index < nals.length; index += 1) {
    const nal = nals[index];
    if (nal === undefined) {
      avcInvalid(path, "NAL unit is missing");
    }
    const nalPath = `${path}.nals[${String(index)}]`;
    switch (nal.type) {
      case AVC_NAL_TYPE_AUD:
        requireAvc(
          index === 0 && audPrimaryPicType === undefined,
          nalPath,
          "AUD must appear once, before every other NAL",
          nal.offset
        );
        audPrimaryPicType = parseAud(nal, nalPath);
        break;
      case AVC_NAL_TYPE_SPS:
        requireAvc(
          !reachedVcl && parsedSps === undefined && parsedPps === undefined,
          nalPath,
          "SPS must appear once before PPS and VCL",
          nal.offset
        );
        parsedSps = parseSps(nal, nalPath);
        break;
      case AVC_NAL_TYPE_PPS:
        requireAvc(
          !reachedVcl && parsedPps === undefined && parsedSps !== undefined,
          nalPath,
          "PPS must appear once after SPS and before VCL",
          nal.offset
        );
        parsedPps = parsePps(nal, nalPath);
        requireAvc(
          parsedPps.spsId === parsedSps.id,
          nalPath,
          "PPS references an SPS outside this access unit",
          nal.offset
        );
        break;
      case AVC_NAL_TYPE_IDR:
      case AVC_NAL_TYPE_NON_IDR:
        reachedVcl = true;
        vcl.push(nal);
        break;
      default:
        avcInvalid(nalPath, "unreachable NAL type", nal.offset);
    }
  }
  requireAvc(vcl.length > 0, path, "access unit contains no primary coded picture");

  const idr = vcl[0]?.type === AVC_NAL_TYPE_IDR;
  requireAvc(
    vcl.every((nal) => (nal.type === AVC_NAL_TYPE_IDR) === idr),
    path,
    "an access unit mixes IDR and non-IDR slices"
  );
  requireAvc(
    accessUnit.key === idr,
    `${path}.key`,
    idr
      ? "IDR access unit is missing its key assertion"
      : "non-IDR access unit has a false key assertion"
  );
  requireAvc(
    frameIndex !== 0 || idr,
    path,
    "frame zero of every unit must be an IDR picture"
  );
  requireAvc(
    (parsedSps === undefined) === (parsedPps === undefined),
    path,
    "SPS and PPS must be carried together"
  );
  requireAvc(
    !idr || (parsedSps !== undefined && parsedPps !== undefined),
    path,
    "every key/IDR access unit must carry SPS and PPS"
  );
  requireAvc(
    idr || (parsedSps === undefined && parsedPps === undefined),
    path,
    "parameter sets are permitted only in key/IDR access units"
  );

  let parameterSets = activeParameterSets;
  if (parsedSps !== undefined && parsedPps !== undefined) {
    if (stableParameterSets !== undefined) {
      requireStableParameterSets(parsedSps, parsedPps, stableParameterSets, path);
    }
    parameterSets = Object.freeze({ sps: parsedSps, pps: parsedPps });
  }
  if (parameterSets === undefined) {
    avcInvalid(path, "access unit has no usable SPS/PPS");
  }

  const macroblocksPerFrame =
    knownMacroblocksPerFrame ??
    validateAvcSpsAgainstProfile(
      parameterSets.sps,
      profile,
      `${path}.sps`,
      compatibilityPolicy
    );
  const slices = vcl.map((nal, index) =>
    parseSliceHeader(
      nal,
      parameterSets.pps,
      parameterSets.sps,
      macroblocksPerFrame,
      `${path}.slices[${String(index)}]`
    )
  );
  const primary = slices[0];
  if (primary === undefined) {
    avcInvalid(path, "primary picture is missing");
  }
  requireAvc(
    primary.firstMacroblock === 0,
    `${path}.slices[0]`,
    "the first slice must begin at macroblock zero"
  );
  let previousFirstMacroblock = -1;
  for (let index = 0; index < slices.length; index += 1) {
    const slice = slices[index];
    if (slice === undefined) {
      avcInvalid(path, "slice is missing");
    }
    requireAvc(
      samePrimaryPicture(primary, slice),
      `${path}.slices[${String(index)}]`,
      "access unit contains more than one primary coded picture"
    );
    requireAvc(
      slice.firstMacroblock > previousFirstMacroblock,
      `${path}.slices[${String(index)}]`,
      "slice macroblock starts must be strictly increasing"
    );
    previousFirstMacroblock = slice.firstMacroblock;
  }
  if (audPrimaryPicType !== undefined) {
    requireAvc(
      audPrimaryPicType === 1 || primary.sliceType === "I",
      `${path}.nals[0]`,
      "AUD primary_pic_type does not permit the coded P picture"
    );
  }

  const summary = Object.freeze({
    frameIndex,
    key: accessUnit.key,
    idr,
    sliceType: primary.sliceType,
    sliceCount: slices.length,
    nalUnitTypes: nalTypes
  });
  validateCanonicalAvcSubset(
    frameIndex,
    summary,
    parameterSets,
    audPrimaryPicType,
    path
  );
  validatePictureSequence(primary, parameterSets.sps, orderState, path);
  return Object.freeze({
    summary,
    parameterSets
  });
}

function validateCanonicalAvcSubset(
  frameIndex: number,
  summary: AvcAccessUnitSummary,
  parameterSets: AvcParameterSetState,
  audPrimaryPicType: number | undefined,
  path: string
): void {
  const first = frameIndex === 0;
  const expectedNalTypes = first ? [9, 7, 8, 5] : [9, 1];
  requireAvc(
    summary.nalUnitTypes.length === expectedNalTypes.length &&
      summary.nalUnitTypes.every(
        (type, index) => type === expectedNalTypes[index]
      ),
    path,
    first
      ? "frame zero must contain exactly AUD/SPS/PPS/IDR"
      : "later frames must contain exactly AUD/non-IDR"
  );
  requireAvc(
    summary.sliceCount === 1,
    path,
    "M5 AVC requires exactly one slice per access unit"
  );
  requireAvc(
    first
      ? summary.idr && summary.sliceType === "I" && summary.key
      : !summary.idr && summary.sliceType === "P" && !summary.key,
    path,
    "unit pictures must be one frame-zero IDR I followed only by non-IDR P"
  );
  requireAvc(
    audPrimaryPicType === (first ? 0 : 1),
    `${path}.nals[0]`,
    first
      ? "frame-zero AUD must announce an I picture"
      : "later AUD must announce a P picture"
  );
  const { sps } = parameterSets;
  requireAvc(
    sps.crop.left === 0 &&
      sps.crop.right === 0 &&
      sps.crop.top === 0 &&
      sps.crop.bottom === 0,
    `${path}.sps`,
    "M5 AVC forbids SPS cropping"
  );
  requireAvc(
    sps.squareSampleAspect,
    `${path}.sps`,
    "M5 AVC requires square sample aspect"
  );
  requireAvc(
    sps.timing.fixedFrameRate,
    `${path}.sps`,
    "M5 AVC requires fixed_frame_rate_flag"
  );
  requireAvc(
    !sps.hrdPresent,
    `${path}.sps`,
    "M5 AVC forbids HRD syntax"
  );
}

function parseAud(nal: AnnexBNalUnit, path: string): number {
  const reader = new RbspBitReader(nal.rbsp, path, nal.offset + 1);
  const primaryPicType = reader.readBits(3, "primary_pic_type");
  requireAvc(
    primaryPicType === 0 || primaryPicType === 1,
    path,
    "AUD announces B, SP, or SI picture types",
    nal.offset + 1
  );
  reader.readTrailingBits();
  return primaryPicType;
}

function requireStableParameterSets(
  sps: ParsedSps,
  pps: ParsedPps,
  stable: AvcParameterSetState,
  path: string
): void {
  requireAvc(
    sps.payloadSignature === stable.sps.payloadSignature,
    `${path}.sps`,
    "SPS bytes changed within the rendition"
  );
  requireAvc(
    pps.payloadSignature === stable.pps.payloadSignature,
    `${path}.pps`,
    "PPS bytes changed within the rendition"
  );
}

export function validateAvcSpsAgainstProfile(
  sps: ParsedSps,
  profile: AvcConstrainedBaselineProfile,
  path: string,
  compatibilityPolicy: AvcCompatibilityPolicy = "strict"
): number {
  if (compatibilityPolicy === "strict") {
    requireAvc(
      sps.constraintSet2,
      path,
      "final avc1.42E020 output must assert constraint_set2_flag"
    );
  }
  requireAvc(
    sps.codedWidth === profile.codedWidth &&
      sps.codedHeight === profile.codedHeight,
    path,
    `SPS coded dimensions ${String(sps.codedWidth)}x${String(
      sps.codedHeight
    )} do not match the rendition`
  );
  const macroblocksPerFrame = (sps.codedWidth / 16) * (sps.codedHeight / 16);
  requireAvc(
    macroblocksPerFrame <= LEVEL_3_2_MAX_MACROBLOCKS_PER_FRAME,
    path,
    "SPS exceeds the Level 3.2 macroblocks-per-frame limit"
  );
  requireAvc(
    BigInt(macroblocksPerFrame) * BigInt(profile.frameRate.numerator) <=
      BigInt(LEVEL_3_2_MAX_MACROBLOCKS_PER_SECOND) *
        BigInt(profile.frameRate.denominator),
    path,
    "rendition exceeds the Level 3.2 macroblocks-per-second limit"
  );
  requireAvc(
    BigInt(sps.timing.timeScale) * BigInt(profile.frameRate.denominator) ===
      2n *
        BigInt(sps.timing.numUnitsInTick) *
        BigInt(profile.frameRate.numerator),
    path,
    "SPS VUI timing does not match the rendition frame rate"
  );
  requireAvc(
    sps.timing.fixedFrameRate,
    path,
    "fixed_frame_rate_flag must be one"
  );
  const maximumDpbFrames = Math.min(
    4,
    Math.floor(LEVEL_3_2_MAX_DPB_MACROBLOCKS / macroblocksPerFrame)
  );
  requireAvc(
    sps.maxDecFrameBuffering <= maximumDpbFrames,
    path,
    "SPS max_dec_frame_buffering exceeds the Level 3.2 profile cap"
  );
  if (sps.hrdMaximumBitrate !== undefined) {
    requireAvc(
      sps.hrdMaximumBitrate <= profile.peakBitrate,
      path,
      "SPS HRD bitrate exceeds the declared peak bitrate"
    );
  }
  if (sps.hrdMaximumCpbBits !== undefined) {
    requireAvc(
      sps.hrdMaximumCpbBits <= profile.cpbBufferBits,
      path,
      "SPS HRD CPB exceeds the configured VBV buffer"
    );
  }
  requireAvc(
    !sps.color.fullRange &&
      sps.color.colourPrimaries === 1 &&
      sps.color.transferCharacteristics === 1 &&
      sps.color.matrixCoefficients === 1,
    path,
    "M5 AVC requires BT.709 limited-range colour signalling"
  );
  return macroblocksPerFrame;
}

function validatePictureSequence(
  picture: ParsedSliceHeader,
  sps: ParsedSps,
  state: AvcPictureOrderState,
  path: string
): void {
  const maximumFrameNum = 2 ** sps.frameNumBits;
  if (picture.idr) {
    requireAvc(picture.frameNum === 0, path, "IDR frame_num must be zero");
    state.previousFrameNum = 0;
    state.frameNumOffset = 0;
    state.previousPoc = -1;
    state.previousPocMsb = 0;
    state.previousPocLsb = 0;
  } else {
    const expectedFrameNum = (state.previousFrameNum + 1) % maximumFrameNum;
    requireAvc(
      picture.frameNum === expectedFrameNum,
      path,
      "reference frame_num is not consecutive"
    );
    if (picture.frameNum < state.previousFrameNum) {
      state.frameNumOffset += maximumFrameNum;
    }
  }

  const poc = calculatePictureOrderCount(picture, sps, state);
  requireAvc(
    picture.idr ? poc === 0 : poc > state.previousPoc,
    path,
    "picture order count is reordered or non-increasing"
  );
  state.previousPoc = poc;
  state.previousFrameNum = picture.frameNum;
}

function calculatePictureOrderCount(
  picture: ParsedSliceHeader,
  sps: ParsedSps,
  state: AvcPictureOrderState
): number {
  const syntax = sps.picOrderCount;
  if (syntax.type === 2) {
    return picture.idr ? 0 : 2 * (state.frameNumOffset + picture.frameNum);
  }
  if (syntax.type === 1) {
    if (picture.idr) {
      return picture.deltaPicOrderCnt0;
    }
    const absoluteFrameNum = state.frameNumOffset + picture.frameNum;
    const cycleLength = syntax.offsetForRefFrame.length;
    let expected = 0;
    if (absoluteFrameNum > 0 && cycleLength > 0) {
      const expectedDelta = syntax.offsetForRefFrame.reduce(
        (total, offset) => total + offset,
        0
      );
      const cycleCount = Math.floor((absoluteFrameNum - 1) / cycleLength);
      const frameInCycle = (absoluteFrameNum - 1) % cycleLength;
      expected = cycleCount * expectedDelta;
      for (let index = 0; index <= frameInCycle; index += 1) {
        expected += syntax.offsetForRefFrame[index] ?? 0;
      }
    }
    const top = expected + picture.deltaPicOrderCnt0;
    const bottom =
      top + syntax.offsetForTopToBottomField + picture.deltaPicOrderCnt1;
    return Math.min(top, bottom);
  }

  const lsb = picture.picOrderCntLsb;
  if (lsb === undefined) {
    avcInvalid("slice", "pic_order_cnt_lsb is missing");
  }
  const maximumLsb = 2 ** syntax.lsbBits;
  let msb = 0;
  if (!picture.idr) {
    if (
      lsb < state.previousPocLsb &&
      state.previousPocLsb - lsb >= maximumLsb / 2
    ) {
      msb = state.previousPocMsb + maximumLsb;
    } else if (
      lsb > state.previousPocLsb &&
      lsb - state.previousPocLsb > maximumLsb / 2
    ) {
      msb = state.previousPocMsb - maximumLsb;
    } else {
      msb = state.previousPocMsb;
    }
  }
  const top = msb + lsb;
  const bottom = top + picture.deltaPicOrderCntBottom;
  state.previousPocMsb = msb;
  state.previousPocLsb = lsb;
  return Math.min(top, bottom);
}

export function createAvcParameterSetSummary(
  sps: ParsedSps
): AvcParameterSetSummary {
  return Object.freeze({
    profileIdc: 66,
    constraintSet2: sps.constraintSet2,
    levelIdc: 32,
    codedWidth: sps.codedWidth,
    codedHeight: sps.codedHeight,
    crop: sps.crop,
    maxNumRefFrames: 1,
    maxNumReorderFrames: 0,
    maxDecFrameBuffering: sps.maxDecFrameBuffering,
    hrdPresent: sps.hrdPresent,
    fixedFrameRate: sps.timing.fixedFrameRate,
    squareSampleAspect: sps.squareSampleAspect,
    color: sps.color
  });
}

export function createAvcPictureOrderState(): AvcPictureOrderState {
  return {
    previousFrameNum: 0,
    frameNumOffset: 0,
    previousPoc: -1,
    previousPocMsb: 0,
    previousPocLsb: 0
  };
}

export function cloneAvcPictureOrderState(
  state: AvcPictureOrderState
): AvcPictureOrderState {
  return {
    previousFrameNum: state.previousFrameNum,
    frameNumOffset: state.frameNumOffset,
    previousPoc: state.previousPoc,
    previousPocMsb: state.previousPocMsb,
    previousPocLsb: state.previousPocLsb
  };
}
