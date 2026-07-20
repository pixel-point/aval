import { FORMAT_DEFAULT_BUDGETS, IDENTIFIER_PATTERN } from "../constants.js";
import { FormatError, isFormatError } from "../errors.js";
import {
  H264_NAL_TYPE_AUD,
  H264_NAL_TYPE_IDR,
  H264_NAL_TYPE_NON_IDR,
  H264_NAL_TYPE_SEI,
  splitAnnexBAccessUnit,
  type AnnexBNalUnit
} from "./annex-b.js";
import { canonicalizeH264ConstraintSet2 } from "./canonicalize.js";
import { requireH264 } from "./failure.js";
import {
  cloneH264Profile,
  inspectH264AnnexBEncoderCandidateRendition,
  inspectH264AnnexBRendition
} from "./inspector.js";
import type {
  H264AccessUnitInput,
  H264EncoderRenditionPreparation,
  H264EncoderRenditionPreparationInput,
  H264UnitInput
} from "./types.js";

const MAX_ENCODER_NAL_UNITS_PER_ACCESS_UNIT = 4;
const MAX_ENCODER_PARAMETER_SET_NAL_UNITS = 2;
const FOUR_BYTE_START_CODE = Object.freeze([0, 0, 0, 1] as const);

/**
 * Converts bounded raw FFmpeg output into the one canonical H264 runtime form.
 * SEI is the sole encoder-only NAL type tolerated, and it is removed before
 * either candidate or strict inspection.
 */
export function prepareH264EncoderRendition(
  input: H264EncoderRenditionPreparationInput
): H264EncoderRenditionPreparation {
  try {
    const profile = cloneH264Profile(input?.profile);
    requireH264(Array.isArray(input?.units), "units", "units must be an array");
    requireH264(input.units.length > 0, "units", "at least one unit is required");
    requireH264(
      input.units.length <= FORMAT_DEFAULT_BUDGETS.maxUnits,
      "units",
      "unit count exceeds the format budget"
    );

    const normalizedUnits: H264UnitInput[] = [];
    const unitIds = new Set<string>();
    let totalRawBytes = 0;
    let totalAccessUnits = 0;
    for (let index = 0; index < input.units.length; index += 1) {
      const unit = input.units[index];
      const path = `units[${String(index)}]`;
      requireH264(unit !== undefined, path, "unit is missing");
      requireH264(
        typeof unit.id === "string" && IDENTIFIER_PATTERN.test(unit.id),
        `${path}.id`,
        "unit id is invalid"
      );
      requireH264(!unitIds.has(unit.id), `${path}.id`, "unit id is duplicated");
      unitIds.add(unit.id);
      requireH264(
        unit.bytes instanceof Uint8Array,
        `${path}.bytes`,
        "raw unit stream must be bytes"
      );
      requireH264(unit.bytes.length > 0, `${path}.bytes`, "raw unit stream is empty");
      requireH264(
        Number.isSafeInteger(unit.expectedAccessUnitCount) &&
          unit.expectedAccessUnitCount > 0,
        `${path}.expectedAccessUnitCount`,
        "expected access-unit count must be a positive safe integer"
      );
      totalRawBytes += unit.bytes.length;
      totalAccessUnits += unit.expectedAccessUnitCount;
      requireH264(
        Number.isSafeInteger(totalRawBytes) &&
          totalRawBytes <= FORMAT_DEFAULT_BUDGETS.maxFileBytes,
        `${path}.bytes`,
        "raw rendition bytes exceed the compiled-file budget"
      );
      requireH264(
        Number.isSafeInteger(totalAccessUnits) &&
          totalAccessUnits <= FORMAT_DEFAULT_BUDGETS.maxTotalUnitFrames,
        `${path}.expectedAccessUnitCount`,
        "total access-unit count exceeds the format budget"
      );

      normalizedUnits.push(
        Object.freeze({
          id: unit.id,
          accessUnits: normalizeEncoderUnitStream(
            unit.bytes,
            unit.expectedAccessUnitCount,
            `${path}.bytes`
          )
        })
      );
    }
    const candidateUnits = Object.freeze(normalizedUnits);
    const candidateInspection = inspectH264AnnexBEncoderCandidateRendition({
      profile,
      units: candidateUnits
    });
    requireH264(
      candidateInspection.parameterSet.profile === "constrained-baseline",
      "units",
      "encoder candidates must use Constrained Baseline profile"
    );
    const canonicalUnits = Object.freeze(
      candidateUnits.map((unit) => Object.freeze({
        id: unit.id,
        accessUnits: Object.freeze(
          unit.accessUnits.map((accessUnit) => Object.freeze({
            key: accessUnit.key,
            bytes: canonicalizeH264ConstraintSet2(accessUnit.bytes)
          }))
        )
      }))
    );
    const inspection = inspectH264AnnexBRendition({
      profile,
      units: canonicalUnits
    });
    return Object.freeze({
      units: canonicalUnits,
      inspection
    });
  } catch (error) {
    if (isFormatError(error)) {
      throw error;
    }
    throw new FormatError(
      "PROFILE_INVALID",
      "H264 encoder rendition could not be prepared"
    );
  }
}

function normalizeEncoderUnitStream(
  bytes: Uint8Array,
  expectedAccessUnitCount: number,
  path: string
): readonly H264AccessUnitInput[] {
  const maximumNalUnits =
    expectedAccessUnitCount * MAX_ENCODER_NAL_UNITS_PER_ACCESS_UNIT +
    MAX_ENCODER_PARAMETER_SET_NAL_UNITS;
  requireH264(
    Number.isSafeInteger(maximumNalUnits),
    path,
    "derived encoder NAL-unit budget is not representable"
  );
  const nals = splitAnnexBAccessUnit(
    bytes,
    path,
    maximumNalUnits,
    true
  );
  requireH264(
    nals[0]?.type === H264_NAL_TYPE_AUD,
    path,
    "raw encoder stream must begin with AUD"
  );

  const groups: AnnexBNalUnit[][] = [];
  let current: AnnexBNalUnit[] | undefined;
  for (const nal of nals) {
    if (nal.type === H264_NAL_TYPE_AUD) {
      if (current !== undefined) {
        groups.push(current);
      }
      current = [nal];
    } else {
      requireH264(current !== undefined, path, "NAL unit appears before the first AUD");
      current.push(nal);
    }
  }
  if (current !== undefined) {
    groups.push(current);
  }
  requireH264(
    groups.length === expectedAccessUnitCount,
    path,
    `expected ${String(expectedAccessUnitCount)} access units but found ${String(
      groups.length
    )}`
  );

  return Object.freeze(
    groups.map((group, groupIndex) =>
      normalizeEncoderAccessUnit(group, `${path}.accessUnits[${String(groupIndex)}]`)
    )
  );
}

function normalizeEncoderAccessUnit(
  group: readonly AnnexBNalUnit[],
  path: string
): H264AccessUnitInput {
  const retained = group.filter((nal) => nal.type !== H264_NAL_TYPE_SEI);
  requireH264(
    retained[0]?.type === H264_NAL_TYPE_AUD,
    path,
    "normalized access unit must begin with AUD"
  );
  const vcl = retained.filter(
    (nal) => nal.type === H264_NAL_TYPE_IDR || nal.type === H264_NAL_TYPE_NON_IDR
  );
  requireH264(vcl.length > 0, path, "access unit contains no coded picture");

  let length = 0;
  for (const nal of retained) {
    length += FOUR_BYTE_START_CODE.length + nal.payload.length;
    requireH264(
      Number.isSafeInteger(length) && length <= FORMAT_DEFAULT_BUDGETS.maxChunkBytes,
      path,
      "normalized access unit exceeds the sample budget"
    );
  }
  let normalized: Uint8Array;
  try {
    normalized = new Uint8Array(length);
  } catch {
    throw new FormatError(
      "PROFILE_INVALID",
      `normalized H264 access-unit allocation of ${String(length)} bytes failed`,
      { path }
    );
  }
  let offset = 0;
  for (const nal of retained) {
    normalized.set(FOUR_BYTE_START_CODE, offset);
    offset += FOUR_BYTE_START_CODE.length;
    normalized.set(nal.payload, offset);
    offset += nal.payload.length;
  }
  return Object.freeze({
    key: vcl.some((nal) => nal.type === H264_NAL_TYPE_IDR),
    bytes: normalized
  });
}
