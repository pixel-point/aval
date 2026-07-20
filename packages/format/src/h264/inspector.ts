import { FORMAT_DEFAULT_BUDGETS, IDENTIFIER_PATTERN } from "../constants.js";
import { FormatError, isFormatError } from "../errors.js";
import {
  H264_NAL_TYPE_AUD,
  H264_NAL_TYPE_IDR,
  H264_NAL_TYPE_NON_IDR,
  H264_NAL_TYPE_PPS,
  H264_NAL_TYPE_SPS,
  splitAnnexBAccessUnit,
  type AnnexBNalUnit
} from "./annex-b.js";
import { RbspBitReader } from "./bit-reader.js";
import { h264CodecForProfileLevel, h264LevelLimits } from "./codec.js";
import { h264Invalid, requireH264 } from "./failure.js";
import {
  parsePps,
  parseSps,
  type H264SpsCompatibilityPolicy,
  type ParsedPps,
  type ParsedSps
} from "./parameter-sets.js";
import {
  parseSliceHeader,
  samePrimaryPicture,
  type ParsedSliceHeader
} from "./slice-header.js";
import type {
  H264AccessUnitInput,
  H264AccessUnitSummary,
  H264Profile,
  H264ParameterSetSummary,
  H264RenditionInspection,
  H264RenditionInspectionInput,
  H264UnitInspection
} from "./types.js";

export interface H264ParameterSetState {
  readonly sps: ParsedSps;
  readonly pps: ParsedPps;
}

export interface H264PictureOrderState {
  previousReferenceFrameNum: number;
  previousReferenceFrameNumOffset: number;
  previousPocMsb: number;
  previousPocLsb: number;
}

interface H264AccessUnitDraft {
  readonly decodeIndex: number;
  readonly pictureOrderCount: number;
  readonly key: boolean;
  readonly idr: boolean;
  readonly sliceType: H264AccessUnitSummary["sliceType"];
  readonly sliceCount: number;
  readonly nalUnitTypes: readonly number[];
}

interface H264AccessUnitStateResult {
  readonly summary: H264AccessUnitDraft;
  readonly parameterSets: H264ParameterSetState;
}

/**
 * Inspects every access unit in an independently decodable rendition.
 *
 * This is intentionally a syntax/dependency verifier, not a decoder. It
 * accepts the production Constrained Baseline subset and the legacy
 * High-profile subset, and returns a
 * deeply immutable scalar summary; no caller-owned byte views escape.
 */
export function inspectH264AnnexBRendition(
  input: H264RenditionInspectionInput
): H264RenditionInspection {
  return inspectRendition(input, "strict");
}

/** Inspect libx264's C0 Baseline candidate before bounded E0 canonicalization. */
export function inspectH264AnnexBEncoderCandidateRendition(
  input: H264RenditionInspectionInput
): H264RenditionInspection {
  return inspectRendition(input, "encoder-candidate");
}

function inspectRendition(
  input: H264RenditionInspectionInput,
  compatibilityPolicy: H264SpsCompatibilityPolicy
): H264RenditionInspection {
  try {
    const profile = cloneH264Profile(input?.profile);
    requireH264(Array.isArray(input?.units), "units", "units must be an array");
    requireH264(input.units.length > 0, "units", "at least one unit is required");
    requireH264(
      input.units.length <= FORMAT_DEFAULT_BUDGETS.maxUnits,
      "units",
      "unit count exceeds the format budget"
    );

    const seenUnitIds = new Set<string>();
    let stableParameterSets: H264ParameterSetState | undefined;
    let macroblocksPerFrame: number | undefined;
    let totalFrames = 0;
    const units: H264UnitInspection[] = [];

    for (let unitIndex = 0; unitIndex < input.units.length; unitIndex += 1) {
      const unit = input.units[unitIndex];
      const unitPath = `units[${String(unitIndex)}]`;
      requireH264(unit !== undefined, unitPath, "unit is missing");
      requireH264(
        typeof unit.id === "string" && IDENTIFIER_PATTERN.test(unit.id),
        `${unitPath}.id`,
        "unit id is invalid"
      );
      requireH264(
        !seenUnitIds.has(unit.id),
        `${unitPath}.id`,
        "unit id is duplicated"
      );
      seenUnitIds.add(unit.id);
      requireH264(
        Array.isArray(unit.accessUnits) && unit.accessUnits.length > 0,
        `${unitPath}.accessUnits`,
        "unit must contain at least one access unit"
      );
      totalFrames += unit.accessUnits.length;
      requireH264(
        totalFrames <= FORMAT_DEFAULT_BUDGETS.maxTotalUnitFrames,
        `${unitPath}.accessUnits`,
        "total frame count exceeds the format budget"
      );

      const orderState = createH264PictureOrderState();
      const drafts: H264AccessUnitDraft[] = [];
      const decodedPictureOrderCounts = new Set<number>();
      let activeParameterSets = stableParameterSets;

      for (
        let decodeIndex = 0;
        decodeIndex < unit.accessUnits.length;
        decodeIndex += 1
      ) {
        const accessUnit = unit.accessUnits[decodeIndex];
        const accessUnitPath = `${unitPath}.accessUnits[${String(decodeIndex)}]`;
        validateH264AccessUnitInput(accessUnit, accessUnitPath);
        const result = inspectH264AccessUnitStatefully(
          accessUnit,
          decodeIndex,
          accessUnitPath,
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
          macroblocksPerFrame = validateH264SpsAgainstProfile(
            stableParameterSets.sps,
            profile,
            `${accessUnitPath}.sps`
          );
        }
        requireH264(
          !decodedPictureOrderCounts.has(result.summary.pictureOrderCount),
          accessUnitPath,
          "unit contains duplicate picture-order counts"
        );
        decodedPictureOrderCounts.add(result.summary.pictureOrderCount);
        drafts.push(result.summary);
      }

      const parameterSets = activeParameterSets;
      if (parameterSets === undefined) {
        h264Invalid(unitPath, "unit has no parameter sets");
      }
      const decodeToPresentation = deriveH264PresentationOrder(
        drafts,
        parameterSets.sps.maxNumReorderFrames,
        `${unitPath}.accessUnits`
      );
      const accessUnits = Object.freeze(drafts.map((draft) => {
        const presentationIndex = decodeToPresentation[draft.decodeIndex];
        if (presentationIndex === undefined) {
          h264Invalid(unitPath, "presentation order is incomplete");
        }
        return Object.freeze({ ...draft, presentationIndex });
      }));
      units.push(Object.freeze({
        id: unit.id,
        accessUnits,
        decodeToPresentation
      }));
    }

    if (stableParameterSets === undefined || macroblocksPerFrame === undefined) {
      h264Invalid("units", "no H264 parameter sets were found");
    }
    const parameterSet = createH264ParameterSetSummary(stableParameterSets.sps);
    return Object.freeze({
      parameterSet,
      macroblocksPerFrame,
      units: Object.freeze(units)
    });
  } catch (error) {
    if (isFormatError(error)) {
      throw error;
    }
    throw new FormatError("PROFILE_INVALID", "H264 inspection failed");
  }
}

export function cloneH264Profile(
  profile: H264Profile | undefined
): H264Profile {
  requireH264(profile !== undefined, "profile", "H264 profile is required");
  positiveInteger(profile.codedWidth, "profile.codedWidth");
  positiveInteger(profile.codedHeight, "profile.codedHeight");
  const expectedVisibleRect = cloneExpectedVisibleRect(
    profile.expectedVisibleRect,
    profile.codedWidth,
    profile.codedHeight
  );
  positiveInteger(profile.frameRate?.numerator, "profile.frameRate.numerator");
  positiveInteger(profile.frameRate?.denominator, "profile.frameRate.denominator");
  requireH264(
    profile.requireBt709LimitedRange === true,
    "profile.requireBt709LimitedRange",
    "the production H264 profile requires BT.709 limited range"
  );
  return Object.freeze({
    codedWidth: profile.codedWidth,
    codedHeight: profile.codedHeight,
    expectedVisibleRect,
    frameRate: Object.freeze({
      numerator: profile.frameRate.numerator,
      denominator: profile.frameRate.denominator
    }),
    requireBt709LimitedRange: true
  });
}

function cloneExpectedVisibleRect(
  value: H264Profile["expectedVisibleRect"],
  codedWidth: number,
  codedHeight: number
): readonly [0, 0, number, number] {
  if (value === undefined) {
    return Object.freeze([0, 0, codedWidth, codedHeight] as const);
  }
  requireH264(
    Array.isArray(value) && value.length === 4,
    "profile.expectedVisibleRect",
    "expected visible rectangle must contain four integers"
  );
  for (let index = 0; index < 4; index += 1) {
    requireH264(
      Object.prototype.hasOwnProperty.call(value, String(index)),
      "profile.expectedVisibleRect",
      "expected visible rectangle must be dense"
    );
  }
  const [x, y, width, height] = value;
  requireH264(
    x === 0 && y === 0,
    "profile.expectedVisibleRect",
    "expected visible rectangle must begin at the coded origin"
  );
  positiveInteger(width, "profile.expectedVisibleRect[2]", codedWidth);
  positiveInteger(height, "profile.expectedVisibleRect[3]", codedHeight);
  requireH264(
    width % 2 === 0 && height % 2 === 0,
    "profile.expectedVisibleRect",
    "expected visible dimensions must be even for yuv420p"
  );
  requireH264(
    (codedWidth - width) % 2 === 0 && (codedHeight - height) % 2 === 0,
    "profile.expectedVisibleRect",
    "expected visible crop must use 4:2:0 crop units"
  );
  return Object.freeze([0, 0, width, height] as const);
}

function positiveInteger(value: unknown, path: string, maximum?: number): void {
  requireH264(
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

export function validateH264AccessUnitInput(
  accessUnit: H264AccessUnitInput | undefined,
  path: string
): asserts accessUnit is H264AccessUnitInput {
  requireH264(accessUnit !== undefined, path, "access unit is missing");
  requireH264(
    accessUnit.bytes instanceof Uint8Array,
    `${path}.bytes`,
    "access unit bytes must be a Uint8Array"
  );
  requireH264(
    accessUnit.bytes.length <= FORMAT_DEFAULT_BUDGETS.maxChunkBytes,
    `${path}.bytes`,
    "access unit exceeds the sample budget"
  );
  requireH264(
    typeof accessUnit.key === "boolean",
    `${path}.key`,
    "access unit key assertion must be boolean"
  );
}

function inspectH264AccessUnitStatefully(
  accessUnit: H264AccessUnitInput,
  decodeIndex: number,
  path: string,
  activeParameterSets: H264ParameterSetState | undefined,
  stableParameterSets: H264ParameterSetState | undefined,
  profile: H264Profile,
  orderState: H264PictureOrderState,
  knownMacroblocksPerFrame: number | undefined,
  compatibilityPolicy: H264SpsCompatibilityPolicy
): H264AccessUnitStateResult {
  const nals = splitAnnexBAccessUnit(accessUnit.bytes, `${path}.bytes`);
  requireH264(
    nals.every((nal) => nal.prefixLength === 4),
    `${path}.bytes`,
    "stored H264 access units must use canonical four-byte start codes"
  );
  const nalTypes = Object.freeze(nals.map((nal) => nal.type));
  let parsedSps: ParsedSps | undefined;
  let parsedPps: ParsedPps | undefined;
  let audPrimaryPicType: number | undefined;
  const vcl: AnnexBNalUnit[] = [];
  let reachedVcl = false;

  for (let index = 0; index < nals.length; index += 1) {
    const nal = nals[index];
    if (nal === undefined) {
      h264Invalid(path, "NAL unit is missing");
    }
    const nalPath = `${path}.nals[${String(index)}]`;
    switch (nal.type) {
      case H264_NAL_TYPE_AUD:
        requireH264(
          index === 0 && audPrimaryPicType === undefined,
          nalPath,
          "AUD must appear once, before every other NAL",
          nal.offset
        );
        audPrimaryPicType = parseAud(nal, nalPath);
        break;
      case H264_NAL_TYPE_SPS:
        requireH264(
          !reachedVcl && parsedSps === undefined && parsedPps === undefined,
          nalPath,
          "SPS must appear once before PPS and VCL",
          nal.offset
        );
        parsedSps = parseSps(nal, nalPath, compatibilityPolicy);
        break;
      case H264_NAL_TYPE_PPS:
        requireH264(
          !reachedVcl && parsedPps === undefined && parsedSps !== undefined,
          nalPath,
          "PPS must appear once after SPS and before VCL",
          nal.offset
        );
        parsedPps = parsePps(nal, nalPath, parsedSps);
        requireH264(
          parsedPps.spsId === parsedSps.id,
          nalPath,
          "PPS references an SPS outside this access unit",
          nal.offset
        );
        break;
      case H264_NAL_TYPE_IDR:
      case H264_NAL_TYPE_NON_IDR:
        reachedVcl = true;
        vcl.push(nal);
        break;
      default:
        h264Invalid(nalPath, "unreachable NAL type", nal.offset);
    }
  }
  requireH264(vcl.length > 0, path, "access unit contains no primary coded picture");

  const idr = vcl[0]?.type === H264_NAL_TYPE_IDR;
  requireH264(
    vcl.every((nal) => (nal.type === H264_NAL_TYPE_IDR) === idr),
    path,
    "an access unit mixes IDR and non-IDR slices"
  );
  requireH264(
    accessUnit.key === idr,
    `${path}.key`,
    idr
      ? "IDR access unit is missing its key assertion"
      : "non-IDR access unit has a false key assertion"
  );
  requireH264(
    decodeIndex !== 0 || idr,
    path,
    "frame zero of every unit must be an IDR picture"
  );
  requireH264(
    (parsedSps === undefined) === (parsedPps === undefined),
    path,
    "SPS and PPS must be carried together"
  );
  requireH264(
    !idr || (parsedSps !== undefined && parsedPps !== undefined),
    path,
    "every key/IDR access unit must carry SPS and PPS"
  );
  requireH264(
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
    h264Invalid(path, "access unit has no usable SPS/PPS");
  }

  const macroblocksPerFrame =
    knownMacroblocksPerFrame ??
    validateH264SpsAgainstProfile(
      parameterSets.sps,
      profile,
      `${path}.sps`
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
    h264Invalid(path, "primary picture is missing");
  }
  requireH264(
    primary.firstMacroblock === 0,
    `${path}.slices[0]`,
    "the first slice must begin at macroblock zero"
  );
  let previousFirstMacroblock = -1;
  for (let index = 0; index < slices.length; index += 1) {
    const slice = slices[index];
    if (slice === undefined) {
      h264Invalid(path, "slice is missing");
    }
    requireH264(
      samePrimaryPicture(primary, slice),
      `${path}.slices[${String(index)}]`,
      "access unit contains more than one primary coded picture"
    );
    requireH264(
      slice.firstMacroblock > previousFirstMacroblock,
      `${path}.slices[${String(index)}]`,
      "slice macroblock starts must be strictly increasing"
    );
    previousFirstMacroblock = slice.firstMacroblock;
  }
  const pictureOrderCount = validatePictureSequence(
    primary,
    parameterSets.sps,
    orderState,
    path
  );

  const summary = Object.freeze({
    decodeIndex,
    pictureOrderCount,
    key: accessUnit.key,
    idr,
    sliceType: primary.sliceType,
    sliceCount: slices.length,
    nalUnitTypes: nalTypes
  });
  validateCanonicalH264Subset(
    decodeIndex,
    summary,
    parameterSets,
    audPrimaryPicType,
    path
  );
  return Object.freeze({
    summary,
    parameterSets
  });
}

function validateCanonicalH264Subset(
  decodeIndex: number,
  summary: H264AccessUnitDraft,
  parameterSets: H264ParameterSetState,
  audPrimaryPicType: number | undefined,
  path: string
): void {
  const first = decodeIndex === 0;
  const expectedNalTypes = first ? [9, 7, 8, 5] : [9, 1];
  requireH264(
    summary.nalUnitTypes.length === expectedNalTypes.length &&
      summary.nalUnitTypes.every(
        (type, index) => type === expectedNalTypes[index]
      ),
    path,
    first
      ? "frame zero must contain exactly AUD/SPS/PPS/IDR"
      : "later frames must contain exactly AUD/non-IDR"
  );
  requireH264(
    summary.sliceCount === 1,
    path,
    "the production H264 profile requires exactly one slice per access unit"
  );
  requireH264(
    first
      ? summary.idr && summary.sliceType === "I" && summary.key
      : !summary.idr &&
        (summary.sliceType === "P" || summary.sliceType === "B") &&
        !summary.key,
    path,
    "unit pictures must be one decode-zero IDR I followed by non-IDR P/B pictures"
  );
  const expectedAudPrimaryPicType = summary.sliceType === "I"
    ? 0
    : summary.sliceType === "P"
      ? 1
      : 2;
  requireH264(
    audPrimaryPicType === expectedAudPrimaryPicType,
    `${path}.nals[0]`,
    "AUD primary_pic_type does not match the coded picture"
  );
  const { sps } = parameterSets;
  if (sps.profile === "constrained-baseline") {
    const { pps } = parameterSets;
    requireH264(
      sps.maxNumRefFrames === 1 &&
        sps.maxNumReorderFrames === 0 &&
        pps.numRefIdxL0DefaultActiveMinus1 === 0 &&
        pps.numRefIdxL1DefaultActiveMinus1 === 0,
      path,
      "Constrained Baseline requires one reference and no reordering"
    );
    requireH264(
      !pps.entropyCoding &&
        !pps.weightedPrediction &&
        pps.weightedBipredIdc === 0 &&
        !pps.transform8x8Mode,
      path,
      "Constrained Baseline forbids CABAC, weighted prediction, and 8x8 transform"
    );
    requireH264(
      first
        ? summary.sliceType === "I"
        : summary.sliceType === "P",
      path,
      "Constrained Baseline units must contain one IDR I followed by P pictures"
    );
  }
  requireH264(
    sps.squareSampleAspect,
    `${path}.sps`,
    "the production H264 profile requires square sample aspect"
  );
  requireH264(
    sps.timing.fixedFrameRate,
    `${path}.sps`,
    "the production H264 profile requires fixed_frame_rate_flag"
  );
  requireH264(
    !sps.hrdPresent,
    `${path}.sps`,
    "the production H264 profile forbids HRD syntax"
  );
}

function parseAud(nal: AnnexBNalUnit, path: string): number {
  const reader = new RbspBitReader(nal.rbsp, path, nal.offset + 1);
  const primaryPicType = reader.readBits(3, "primary_pic_type");
  requireH264(
    primaryPicType === 0 || primaryPicType === 1 || primaryPicType === 2,
    path,
    "AUD announces SP or SI picture types",
    nal.offset + 1
  );
  reader.readTrailingBits();
  return primaryPicType;
}

function requireStableParameterSets(
  sps: ParsedSps,
  pps: ParsedPps,
  stable: H264ParameterSetState,
  path: string
): void {
  requireH264(
    sps.payloadSignature === stable.sps.payloadSignature,
    `${path}.sps`,
    "SPS bytes changed within the rendition"
  );
  requireH264(
    pps.payloadSignature === stable.pps.payloadSignature,
    `${path}.pps`,
    "PPS bytes changed within the rendition"
  );
}

export function validateH264SpsAgainstProfile(
  sps: ParsedSps,
  profile: H264Profile,
  path: string
): number {
  requireH264(
    sps.codedWidth === profile.codedWidth &&
      sps.codedHeight === profile.codedHeight,
    path,
    `SPS coded dimensions ${String(sps.codedWidth)}x${String(
      sps.codedHeight
    )} do not match the rendition`
  );
  const expectedCrop = profile.expectedVisibleRect ??
    ([0, 0, profile.codedWidth, profile.codedHeight] as const);
  requireH264(
    sps.crop.left === expectedCrop[0] &&
      sps.crop.top === expectedCrop[1] &&
      sps.crop.right === profile.codedWidth - expectedCrop[0] - expectedCrop[2] &&
      sps.crop.bottom === profile.codedHeight - expectedCrop[1] - expectedCrop[3] &&
      sps.crop.visibleWidth === expectedCrop[2] &&
      sps.crop.visibleHeight === expectedCrop[3],
    path,
    "SPS crop does not match the expected visible rectangle"
  );
  const macroblocksPerFrame = (sps.codedWidth / 16) * (sps.codedHeight / 16);
  const level = h264LevelLimits(sps.levelIdc);
  const widthInMacroblocks = sps.codedWidth / 16;
  const heightInMacroblocks = sps.codedHeight / 16;
  requireH264(
    widthInMacroblocks <= level.maximumMacroblockDimension &&
      heightInMacroblocks <= level.maximumMacroblockDimension,
    path,
    "SPS width or height exceeds its declared H264 level dimension limit"
  );
  requireH264(
    macroblocksPerFrame <= level.maximumMacroblocksPerFrame,
    path,
    "SPS exceeds its declared H264 level macroblocks-per-frame limit"
  );
  requireH264(
    BigInt(macroblocksPerFrame) * BigInt(profile.frameRate.numerator) <=
      BigInt(level.maximumMacroblocksPerSecond) *
        BigInt(profile.frameRate.denominator),
    path,
    "rendition exceeds its declared H264 level macroblocks-per-second limit"
  );
  requireH264(
    BigInt(sps.timing.timeScale) * BigInt(profile.frameRate.denominator) ===
      2n *
        BigInt(sps.timing.numUnitsInTick) *
        BigInt(profile.frameRate.numerator),
    path,
    "SPS VUI timing does not match the rendition frame rate"
  );
  requireH264(
    sps.timing.fixedFrameRate,
    path,
    "fixed_frame_rate_flag must be one"
  );
  const maximumDpbFrames = Math.min(
    16,
    Math.floor(level.maximumDpbMacroblocks / macroblocksPerFrame)
  );
  requireH264(
    sps.maxDecFrameBuffering <= maximumDpbFrames,
    path,
    "SPS max_dec_frame_buffering exceeds its declared H264 level"
  );
  requireH264(
    !sps.color.fullRange &&
      sps.color.colourPrimaries === 1 &&
      sps.color.transferCharacteristics === 1 &&
      sps.color.matrixCoefficients === 1,
    path,
    "the production H264 profile requires BT.709 limited-range colour signalling"
  );
  return macroblocksPerFrame;
}

function validatePictureSequence(
  picture: ParsedSliceHeader,
  sps: ParsedSps,
  state: H264PictureOrderState,
  path: string
): number {
  const maximumFrameNum = 2 ** sps.frameNumBits;
  let frameNumOffset = 0;
  if (picture.idr) {
    requireH264(picture.frameNum === 0, path, "IDR frame_num must be zero");
    state.previousReferenceFrameNum = 0;
    state.previousReferenceFrameNumOffset = 0;
    state.previousPocMsb = 0;
    state.previousPocLsb = 0;
  } else {
    const expectedFrameNum =
      (state.previousReferenceFrameNum + 1) % maximumFrameNum;
    requireH264(
      picture.frameNum === expectedFrameNum,
      path,
      "frame_num does not identify the next short-term picture"
    );
    frameNumOffset = state.previousReferenceFrameNumOffset +
      (picture.frameNum < state.previousReferenceFrameNum ? maximumFrameNum : 0);
  }

  const poc = calculatePictureOrderCount(
    picture,
    sps,
    state,
    frameNumOffset
  );
  requireH264(
    Number.isSafeInteger(poc) && (!picture.idr || poc === 0),
    path,
    "picture order count is invalid"
  );
  if (picture.referenceIdc !== 0) {
    state.previousReferenceFrameNum = picture.frameNum;
    state.previousReferenceFrameNumOffset = frameNumOffset;
  }
  return poc;
}

function calculatePictureOrderCount(
  picture: ParsedSliceHeader,
  sps: ParsedSps,
  state: H264PictureOrderState,
  frameNumOffset: number
): number {
  const syntax = sps.picOrderCount;
  if (syntax.type === 2) {
    if (picture.idr) return 0;
    const absoluteFrameNum = frameNumOffset + picture.frameNum;
    return picture.referenceIdc === 0
      ? 2 * absoluteFrameNum - 1
      : 2 * absoluteFrameNum;
  }
  if (syntax.type === 1) {
    if (picture.idr) {
      return picture.deltaPicOrderCnt0;
    }
    let absoluteFrameNum = frameNumOffset + picture.frameNum;
    if (picture.referenceIdc === 0 && absoluteFrameNum > 0) {
      absoluteFrameNum -= 1;
    }
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
    if (picture.referenceIdc === 0) {
      expected += syntax.offsetForNonRefPic;
    }
    const top = expected + picture.deltaPicOrderCnt0;
    const bottom =
      top + syntax.offsetForTopToBottomField + picture.deltaPicOrderCnt1;
    return Math.min(top, bottom);
  }

  const lsb = picture.picOrderCntLsb;
  if (lsb === undefined) {
    h264Invalid("slice", "pic_order_cnt_lsb is missing");
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
  if (picture.referenceIdc !== 0) {
    state.previousPocMsb = msb;
    state.previousPocLsb = lsb;
  }
  return Math.min(top, bottom);
}

function deriveH264PresentationOrder(
  pictures: readonly H264AccessUnitDraft[],
  maximumReorderFrames: number,
  path: string
): readonly number[] {
  requireH264(pictures.length > 0, path, "unit contains no decoded pictures");
  const sorted = [...pictures].sort(
    (left, right) => left.pictureOrderCount - right.pictureOrderCount
  );
  requireH264(
    sorted[0]?.decodeIndex === 0 && sorted[0]?.pictureOrderCount === 0,
    path,
    "the unit IDR must be the first presentation picture"
  );
  const decodeToPresentation = new Array<number>(pictures.length);
  let previousPictureOrderCount: number | undefined;
  for (
    let presentationIndex = 0;
    presentationIndex < sorted.length;
    presentationIndex += 1
  ) {
    const picture = sorted[presentationIndex];
    requireH264(picture !== undefined, path, "presentation picture is missing");
    requireH264(
      previousPictureOrderCount === undefined ||
        picture.pictureOrderCount > previousPictureOrderCount,
      path,
      "unit picture-order counts must be unique"
    );
    requireH264(
      picture.decodeIndex >= 0 &&
        picture.decodeIndex < pictures.length &&
        decodeToPresentation[picture.decodeIndex] === undefined,
      path,
      "unit decode index is duplicated or out of range"
    );
    decodeToPresentation[picture.decodeIndex] = presentationIndex;
    previousPictureOrderCount = picture.pictureOrderCount;
  }
  let requiredReorderFrames = 0;
  for (let decodeIndex = 0; decodeIndex < decodeToPresentation.length; decodeIndex += 1) {
    const presentationIndex = decodeToPresentation[decodeIndex];
    requireH264(presentationIndex !== undefined, path, "decode order has a gap");
    requiredReorderFrames = Math.max(
      requiredReorderFrames,
      decodeIndex - presentationIndex
    );
  }
  requireH264(
    requiredReorderFrames <= maximumReorderFrames,
    path,
    "derived presentation reordering exceeds the SPS declaration"
  );
  return Object.freeze(decodeToPresentation);
}

export function createH264ParameterSetSummary(
  sps: ParsedSps
): H264ParameterSetSummary {
  return Object.freeze({
    profile: sps.profile,
    profileIdc: sps.profileIdc,
    codec: h264CodecForProfileLevel(sps.profile, sps.levelIdc),
    levelIdc: sps.levelIdc,
    codedWidth: sps.codedWidth,
    codedHeight: sps.codedHeight,
    crop: sps.crop,
    bitDepth: 8,
    chromaFormat: "4:2:0",
    maxNumRefFrames: sps.maxNumRefFrames,
    maxNumReorderFrames: sps.maxNumReorderFrames,
    maxDecFrameBuffering: sps.maxDecFrameBuffering,
    hrdPresent: sps.hrdPresent,
    fixedFrameRate: sps.timing.fixedFrameRate,
    squareSampleAspect: sps.squareSampleAspect,
    color: sps.color
  });
}

function createH264PictureOrderState(): H264PictureOrderState {
  return {
    previousReferenceFrameNum: 0,
    previousReferenceFrameNumOffset: 0,
    previousPocMsb: 0,
    previousPocLsb: 0
  };
}
