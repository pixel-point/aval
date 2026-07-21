import { IDENTIFIER_PATTERN } from "../constants.js";
import { FormatError, isFormatError } from "../errors.js";
import {
  H265_MAX_ACCESS_UNIT_BYTES,
  H265_NAL_AUD,
  H265_NAL_PPS,
  H265_NAL_SPS,
  H265_NAL_VPS,
  isH265RandomAccessNalType,
  isH265VclNalType,
  splitH265AnnexBAccessUnit,
  type H265AnnexBNalUnit
} from "./annex-b.js";
import { H265RbspBitReader } from "./bit-reader.js";
import { createH265VideoDecoderConfig, h265CodecString } from "./codec.js";
import { h265Invalid, requireH265 } from "./failure.js";
import {
  parseH265Pps,
  parseH265Sps,
  parseH265Vps,
  sameH265ProfileTierLevel,
  type ParsedH265Pps,
  type ParsedH265Sps,
  type ParsedH265Vps
} from "./parameter-sets.js";
import {
  createH265PictureOrderState,
  deriveH265PictureOrderCount,
  deriveH265PresentationOrder
} from "./presentation-order.js";
import { parseH265SliceHeader } from "./slice-header.js";
import type {
  H265AccessUnitInput,
  H265AccessUnitSummary,
  H265MainProfile,
  H265ParameterSetSummary,
  H265RenditionInspection,
  H265RenditionInspectionInput,
  H265UnitInspection
} from "./types.js";

const MAX_UNITS = 96;
const MAX_TOTAL_ACCESS_UNITS = 1_000_000;

interface H265ParameterSetState {
  readonly vps: ParsedH265Vps;
  readonly sps: ParsedH265Sps;
  readonly pps: ParsedH265Pps;
}

interface DraftSummary {
  readonly decodeIndex: number;
  readonly pictureOrderCount: number;
  readonly key: boolean;
  readonly randomAccess: H265AccessUnitSummary["randomAccess"];
  readonly sliceType: H265AccessUnitSummary["sliceType"];
  readonly temporalId: number;
  readonly referencedPictureOrderCounts: readonly number[];
  readonly nalUnitTypes: readonly number[];
}

interface H265RenditionInspectionWithParameterSetIdentity {
  readonly inspection: H265RenditionInspection;
  readonly parameterSetIdentity: readonly [
    vps: string,
    sps: string,
    pps: string
  ];
}

/** Inspects canonical HEVC access units and proves each graph unit is closed. */
export function inspectH265AnnexBRendition(
  input: H265RenditionInspectionInput
): H265RenditionInspection {
  return inspectH265AnnexBRenditionWithParameterSetIdentity(input).inspection;
}

/** Internal continuity view over the exact signatures already parsed by inspection. */
export function inspectH265AnnexBRenditionWithParameterSetIdentity(
  input: H265RenditionInspectionInput
): Readonly<H265RenditionInspectionWithParameterSetIdentity> {
  try {
    const profile = cloneH265Profile(input?.profile);
    requireH265(Array.isArray(input?.units), "units", "units must be an array");
    requireH265(input.units.length > 0, "units", "at least one unit is required");
    requireH265(
      input.units.length <= MAX_UNITS,
      "units",
      "unit count exceeds the HEVC inspection budget"
    );
    const ids = new Set<string>();
    let stableParameterSets: H265ParameterSetState | undefined;
    let totalAccessUnits = 0;
    const units: H265UnitInspection[] = [];

    for (let unitIndex = 0; unitIndex < input.units.length; unitIndex += 1) {
      const unit = input.units[unitIndex];
      const unitPath = `units[${String(unitIndex)}]`;
      requireH265(unit !== undefined, unitPath, "unit is missing");
      requireH265(
        typeof unit.id === "string" && IDENTIFIER_PATTERN.test(unit.id),
        `${unitPath}.id`,
        "unit id is invalid"
      );
      requireH265(!ids.has(unit.id), `${unitPath}.id`, "unit id is duplicated");
      ids.add(unit.id);
      requireH265(
        Array.isArray(unit.accessUnits) && unit.accessUnits.length > 0,
        `${unitPath}.accessUnits`,
        "unit must contain at least one access unit"
      );
      totalAccessUnits += unit.accessUnits.length;
      requireH265(
        Number.isSafeInteger(totalAccessUnits) && totalAccessUnits <= MAX_TOTAL_ACCESS_UNITS,
        `${unitPath}.accessUnits`,
        "total access-unit count exceeds the HEVC inspection budget"
      );

      const orderState = createH265PictureOrderState();
      const decodedPocs = new Set<number>();
      const drafts: DraftSummary[] = [];
      let activeParameterSets: H265ParameterSetState | undefined;
      for (let decodeIndex = 0; decodeIndex < unit.accessUnits.length; decodeIndex += 1) {
        const accessUnit = unit.accessUnits[decodeIndex];
        const path = `${unitPath}.accessUnits[${String(decodeIndex)}]`;
        validateAccessUnitInput(accessUnit, path);
        const nals = splitH265AnnexBAccessUnit(accessUnit.bytes, `${path}.bytes`);
        requireH265(
          nals.every((nal) => nal.prefixLength === 4),
          `${path}.bytes`,
          "stored HEVC access units must use canonical four-byte start codes"
        );
        const inspected = inspectAccessUnitStructure(
          nals,
          accessUnit,
          decodeIndex,
          path,
          activeParameterSets,
          stableParameterSets
        );
        activeParameterSets = inspected.parameterSets;
        if (stableParameterSets === undefined) {
          stableParameterSets = inspected.parameterSets;
          validateParameterSetsAgainstProfile(stableParameterSets, profile, path);
        }
        const { sps } = inspected.parameterSets;
        const pictureOrderCount = deriveH265PictureOrderCount(
          inspected.vcl.type,
          inspected.vcl.temporalId,
          inspected.slice.pictureOrderCountLsb,
          sps.log2MaxPictureOrderCountLsb,
          orderState
        );
        const references = Object.freeze(
          inspected.slice.referencePictureSet.pictures.map(
            (picture) => pictureOrderCount + picture.deltaPoc
          )
        );
        requireH265(
          references.every((reference) => decodedPocs.has(reference)),
          path,
          "slice references a picture outside this independently decoded unit"
        );
        requireH265(
          !decodedPocs.has(pictureOrderCount),
          path,
          "unit contains duplicate picture-order counts"
        );
        decodedPocs.add(pictureOrderCount);
        drafts.push(Object.freeze({
          decodeIndex,
          pictureOrderCount,
          key: accessUnit.key,
          randomAccess: inspected.slice.randomAccess,
          sliceType: inspected.slice.sliceType,
          temporalId: inspected.vcl.temporalId,
          referencedPictureOrderCounts: references,
          nalUnitTypes: Object.freeze(nals.map((nal) => nal.type))
        }));
      }
      const parameterSets = activeParameterSets;
      if (parameterSets === undefined) h265Invalid(unitPath, "unit has no parameter sets");
      const decodeToPresentation = deriveH265PresentationOrder(
        drafts,
        parameterSets.sps.maxNumReorderPics,
        `${unitPath}.accessUnits`
      );
      const accessUnits = Object.freeze(drafts.map((draft) => {
        const presentationIndex = decodeToPresentation[draft.decodeIndex];
        if (presentationIndex === undefined) h265Invalid(unitPath, "presentation order is incomplete");
        return Object.freeze({ ...draft, presentationIndex });
      }));
      units.push(Object.freeze({
        id: unit.id,
        accessUnits,
        decodeToPresentation
      }));
    }

    if (stableParameterSets === undefined) h265Invalid("units", "no HEVC parameter sets found");
    const parameterSet = createParameterSetSummary(stableParameterSets.sps);
    const inspection = Object.freeze({
      parameterSet,
      decoderConfig: createH265VideoDecoderConfig(stableParameterSets.sps),
      units: Object.freeze(units)
    });
    return Object.freeze({
      inspection,
      parameterSetIdentity: Object.freeze([
        stableParameterSets.vps.payloadSignature,
        stableParameterSets.sps.payloadSignature,
        stableParameterSets.pps.payloadSignature
      ] as const)
    });
  } catch (error) {
    if (isFormatError(error)) throw error;
    throw new FormatError("PROFILE_INVALID", "HEVC inspection failed");
  }
}

function inspectAccessUnitStructure(
  nals: readonly H265AnnexBNalUnit[],
  input: H265AccessUnitInput,
  decodeIndex: number,
  path: string,
  activeParameterSets: H265ParameterSetState | undefined,
  stableParameterSets: H265ParameterSetState | undefined
): {
  readonly parameterSets: H265ParameterSetState;
  readonly vcl: H265AnnexBNalUnit;
  readonly slice: ReturnType<typeof parseH265SliceHeader>;
} {
  requireH265(nals[0]?.type === H265_NAL_AUD, path, "access unit must begin with AUD");
  requireH265(
    nals.filter((nal) => nal.type === H265_NAL_AUD).length === 1,
    path,
    "access unit must contain exactly one AUD"
  );
  const vcl = nals.filter((nal) => isH265VclNalType(nal.type));
  requireH265(
    vcl.length === 1,
    path,
    "the production HEVC profile requires one VCL NAL per access unit"
  );
  const picture = vcl[0];
  if (picture === undefined) h265Invalid(path, "access unit contains no picture");
  const randomAccess = isH265RandomAccessNalType(picture.type);
  requireH265(
    input.key === randomAccess,
    `${path}.key`,
    randomAccess
      ? "random-access picture is missing its key assertion"
      : "non-random-access picture has a key assertion"
  );
  requireH265(
    decodeIndex === 0 ? randomAccess : !randomAccess,
    path,
    decodeIndex === 0
      ? "every unit must begin with a random-access picture"
      : "random-access pictures are permitted only at unit start"
  );

  let parameterSets = activeParameterSets;
  if (decodeIndex === 0) {
    requireH265(
      nals.length === 5 &&
        nals[1]?.type === H265_NAL_VPS &&
        nals[2]?.type === H265_NAL_SPS &&
        nals[3]?.type === H265_NAL_PPS &&
        nals[4] === picture,
      path,
      "unit start must contain exactly AUD/VPS/SPS/PPS/VCL"
    );
    const vpsNal = nals[1];
    const spsNal = nals[2];
    const ppsNal = nals[3];
    if (vpsNal === undefined || spsNal === undefined || ppsNal === undefined) {
      h265Invalid(path, "unit parameter sets are missing");
    }
    const vps = parseH265Vps(vpsNal, `${path}.vps`);
    const sps = parseH265Sps(spsNal, `${path}.sps`);
    const pps = parseH265Pps(ppsNal, `${path}.pps`);
    requireH265(sps.videoParameterSetId === vps.id, path, "SPS references an unexpected VPS");
    requireH265(pps.spsId === sps.id, path, "PPS references an unexpected SPS");
    requireH265(
      sameH265ProfileTierLevel(vps.profileTierLevel, sps.profileTierLevel),
      path,
      "VPS and SPS profile-tier-level declarations differ"
    );
    if (stableParameterSets !== undefined) {
      requireH265(
        vps.payloadSignature === stableParameterSets.vps.payloadSignature &&
          sps.payloadSignature === stableParameterSets.sps.payloadSignature &&
          pps.payloadSignature === stableParameterSets.pps.payloadSignature,
        path,
        "HEVC parameter-set bytes changed within the rendition"
      );
    }
    parameterSets = Object.freeze({ vps, sps, pps });
  } else {
    requireH265(
      nals.length === 2 && nals[1] === picture,
      path,
      "later access units must contain exactly AUD/VCL"
    );
  }
  if (parameterSets === undefined) h265Invalid(path, "access unit has no parameter sets");
  const audPictureType = parseAud(nals[0] as H265AnnexBNalUnit, `${path}.aud`);
  const slice = parseH265SliceHeader(
    picture,
    parameterSets.pps,
    parameterSets.sps,
    `${path}.slice`
  );
  requireH265(
    (slice.sliceType === "I" && audPictureType >= 0) ||
      (slice.sliceType === "P" && audPictureType >= 1) ||
      (slice.sliceType === "B" && audPictureType === 2),
    `${path}.aud`,
    "AUD pic_type does not permit the coded slice type"
  );
  return Object.freeze({ parameterSets, vcl: picture, slice });
}

function validateParameterSetsAgainstProfile(
  state: H265ParameterSetState,
  profile: H265MainProfile,
  path: string
): void {
  const { sps } = state;
  const ptl = sps.profileTierLevel;
  requireH265(
    ptl.profileSpace === 0 &&
      ptl.profileIdc === 1 &&
      (ptl.profileCompatibilityFlags & 0x02) !== 0,
    `${path}.sps`,
    "the production HEVC profile requires Main profile compatibility"
  );
  const firstConstraintByte = ptl.constraintIndicatorFlags[0] ?? 0;
  requireH265(
    (firstConstraintByte & 0x80) !== 0 &&
      (firstConstraintByte & 0x40) === 0 &&
      (firstConstraintByte & 0x10) !== 0,
    `${path}.sps`,
    "HEVC must signal progressive, frame-only source constraints"
  );
  requireH265(
    sps.codedWidth === profile.codedWidth && sps.codedHeight === profile.codedHeight,
    `${path}.sps`,
    "SPS coded dimensions do not match the rendition profile"
  );
  const expected = profile.expectedVisibleRect ??
    ([0, 0, profile.codedWidth, profile.codedHeight] as const);
  requireH265(
    sps.crop.left === expected[0] &&
      sps.crop.top === expected[1] &&
      sps.crop.visibleWidth === expected[2] &&
      sps.crop.visibleHeight === expected[3] &&
      sps.crop.right === profile.codedWidth - expected[2] &&
      sps.crop.bottom === profile.codedHeight - expected[3],
    `${path}.sps`,
    "SPS conformance crop does not match the rendition profile"
  );
  requireH265(sps.squareSampleAspect, `${path}.sps`, "square sample aspect is required");
  requireH265(
    !sps.defaultDisplayWindowPresent,
    `${path}.sps`,
    "default-display-window cropping is forbidden"
  );
  requireH265(sps.timing !== undefined, `${path}.sps`, "SPS VUI timing is required");
  requireH265(
    BigInt(sps.timing.timeScale) * BigInt(profile.frameRate.denominator) ===
      BigInt(sps.timing.numUnitsInTick) * BigInt(profile.frameRate.numerator),
    `${path}.sps`,
    "SPS VUI timing does not match the rendition frame rate"
  );
  requireH265(
    !sps.color.fullRange &&
      sps.color.colourPrimaries === 1 &&
      sps.color.transferCharacteristics === 1 &&
      sps.color.matrixCoefficients === 1,
    `${path}.sps`,
    "the production HEVC profile requires BT.709 limited-range colour signalling"
  );
  requireH265(
    !sps.longTermReferencePicturesPresent,
    `${path}.sps`,
    "long-term HEVC references are outside the production profile"
  );
}

function cloneH265Profile(profile: H265MainProfile | undefined): H265MainProfile {
  requireH265(profile !== undefined, "profile", "HEVC profile is required");
  positiveInteger(profile.codedWidth, "profile.codedWidth");
  positiveInteger(profile.codedHeight, "profile.codedHeight");
  requireH265(
    profile.codedWidth % 2 === 0 && profile.codedHeight % 2 === 0,
    "profile",
    "4:2:0 HEVC coded dimensions must be even"
  );
  positiveInteger(profile.frameRate?.numerator, "profile.frameRate.numerator");
  positiveInteger(profile.frameRate?.denominator, "profile.frameRate.denominator");
  requireH265(
    profile.requireBt709LimitedRange === true,
    "profile.requireBt709LimitedRange",
    "the production HEVC profile requires BT.709 limited range"
  );
  const expectedVisibleRect = profile.expectedVisibleRect === undefined
    ? undefined
    : cloneVisibleRect(profile.expectedVisibleRect, profile.codedWidth, profile.codedHeight);
  return Object.freeze({
    codedWidth: profile.codedWidth,
    codedHeight: profile.codedHeight,
    ...(expectedVisibleRect === undefined ? {} : { expectedVisibleRect }),
    frameRate: Object.freeze({
      numerator: profile.frameRate.numerator,
      denominator: profile.frameRate.denominator
    }),
    requireBt709LimitedRange: true as const
  });
}

function cloneVisibleRect(
  value: readonly [0, 0, number, number],
  codedWidth: number,
  codedHeight: number
): readonly [0, 0, number, number] {
  requireH265(
    Array.isArray(value) && value.length === 4 && value[0] === 0 && value[1] === 0,
    "profile.expectedVisibleRect",
    "expected visible rectangle must begin at the coded origin"
  );
  positiveInteger(value[2], "profile.expectedVisibleRect[2]", codedWidth);
  positiveInteger(value[3], "profile.expectedVisibleRect[3]", codedHeight);
  requireH265(
    value[2] % 2 === 0 && value[3] % 2 === 0,
    "profile.expectedVisibleRect",
    "4:2:0 visible dimensions must be even"
  );
  return Object.freeze([0, 0, value[2], value[3]] as const);
}

function validateAccessUnitInput(
  input: H265AccessUnitInput | undefined,
  path: string
): asserts input is H265AccessUnitInput {
  requireH265(input !== undefined, path, "access unit is missing");
  requireH265(input.bytes instanceof Uint8Array, `${path}.bytes`, "bytes must be a Uint8Array");
  requireH265(
    input.bytes.length <= H265_MAX_ACCESS_UNIT_BYTES,
    `${path}.bytes`,
    "access unit exceeds the HEVC byte budget"
  );
  requireH265(typeof input.key === "boolean", `${path}.key`, "key assertion must be boolean");
}

function parseAud(nal: H265AnnexBNalUnit, path: string): number {
  const reader = new H265RbspBitReader(nal.rbsp, path, nal.offset + 2);
  const pictureType = reader.readBits(3, "pic_type");
  requireH265(pictureType <= 2, path, "AUD pic_type is reserved");
  reader.readTrailingBits();
  return pictureType;
}

function createParameterSetSummary(sps: ParsedH265Sps): H265ParameterSetSummary {
  return Object.freeze({
    profileTierLevel: sps.profileTierLevel,
    codec: h265CodecString(sps.profileTierLevel),
    codedWidth: sps.codedWidth,
    codedHeight: sps.codedHeight,
    crop: sps.crop,
    bitDepth: 8 as const,
    chromaFormat: "4:2:0" as const,
    maxNumReorderPics: sps.maxNumReorderPics,
    maxDecPicBuffering: sps.maxDecPicBuffering,
    color: sps.color
  });
}

function positiveInteger(value: unknown, path: string, maximum?: number): void {
  requireH265(
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
