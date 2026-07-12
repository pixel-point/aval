import { FORMAT_DEFAULT_BUDGETS, IDENTIFIER_PATTERN } from "../constants.js";
import { FormatError, isFormatError } from "../errors.js";
import {
  AVC_NAL_TYPE_AUD,
  AVC_NAL_TYPE_IDR,
  AVC_NAL_TYPE_NON_IDR,
  AVC_NAL_TYPE_SEI,
  splitAnnexBAccessUnit,
  type AnnexBNalUnit
} from "./annex-b.js";
import { canonicalizeAvcConstraintSet2 } from "./canonicalize.js";
import { requireAvc } from "./failure.js";
import {
  cloneAvcProfile,
  inspectAvcAnnexBEncoderCandidateRendition,
  inspectAvcAnnexBRendition
} from "./inspector.js";
import type {
  AvcAccessUnitInput,
  AvcEncoderRenditionPreparation,
  AvcEncoderRenditionPreparationInput,
  AvcUnitInput
} from "./types.js";

const ENCODER_STREAM_MAX_NAL_UNITS = 65_536;
const FOUR_BYTE_START_CODE = Object.freeze([0, 0, 0, 1] as const);

/**
 * Converts bounded raw FFmpeg output into the one canonical AVC runtime form.
 * SEI is the sole encoder-only NAL type tolerated, and it is removed before
 * either candidate or strict inspection.
 */
export function prepareAvcEncoderRendition(
  input: AvcEncoderRenditionPreparationInput
): AvcEncoderRenditionPreparation {
  try {
    const profile = cloneAvcProfile(input?.profile);
    requireAvc(Array.isArray(input?.units), "units", "units must be an array");
    requireAvc(input.units.length > 0, "units", "at least one unit is required");
    requireAvc(
      input.units.length <= FORMAT_DEFAULT_BUDGETS.maxUnits,
      "units",
      "unit count exceeds the format budget"
    );

    const normalizedUnits: AvcUnitInput[] = [];
    const unitIds = new Set<string>();
    let totalRawBytes = 0;
    let totalAccessUnits = 0;
    for (let index = 0; index < input.units.length; index += 1) {
      const unit = input.units[index];
      const path = `units[${String(index)}]`;
      requireAvc(unit !== undefined, path, "unit is missing");
      requireAvc(
        typeof unit.id === "string" && IDENTIFIER_PATTERN.test(unit.id),
        `${path}.id`,
        "unit id is invalid"
      );
      requireAvc(!unitIds.has(unit.id), `${path}.id`, "unit id is duplicated");
      unitIds.add(unit.id);
      requireAvc(
        unit.bytes instanceof Uint8Array,
        `${path}.bytes`,
        "raw unit stream must be bytes"
      );
      requireAvc(unit.bytes.length > 0, `${path}.bytes`, "raw unit stream is empty");
      requireAvc(
        Number.isSafeInteger(unit.expectedAccessUnitCount) &&
          unit.expectedAccessUnitCount > 0,
        `${path}.expectedAccessUnitCount`,
        "expected access-unit count must be a positive safe integer"
      );
      totalRawBytes += unit.bytes.length;
      totalAccessUnits += unit.expectedAccessUnitCount;
      requireAvc(
        Number.isSafeInteger(totalRawBytes) &&
          totalRawBytes <= FORMAT_DEFAULT_BUDGETS.maxFileBytes,
        `${path}.bytes`,
        "raw rendition bytes exceed the compiled-file budget"
      );
      requireAvc(
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
    inspectAvcAnnexBEncoderCandidateRendition({
      profile,
      units: candidateUnits
    });

    const canonicalizations: {
      readonly unitId: string;
      readonly constraintSet2Canonicalized: boolean;
    }[] = [];
    const canonicalUnits = Object.freeze(
      candidateUnits.map((unit) => {
        let constraintSet2Canonicalized = false;
        const canonical = Object.freeze({
          id: unit.id,
          accessUnits: Object.freeze(
            unit.accessUnits.map((accessUnit) => {
              const bytes = canonicalizeAvcConstraintSet2(accessUnit.bytes);
              if (!bytesEqual(bytes, accessUnit.bytes)) {
                constraintSet2Canonicalized = true;
              }
              return Object.freeze({ key: accessUnit.key, bytes });
            })
          )
        });
        canonicalizations.push(Object.freeze({
          unitId: unit.id,
          constraintSet2Canonicalized
        }));
        return canonical;
      })
    );
    const inspection = inspectAvcAnnexBRendition({
      profile,
      units: canonicalUnits
    });
    return Object.freeze({
      units: canonicalUnits,
      inspection,
      canonicalizations: Object.freeze(canonicalizations)
    });
  } catch (error) {
    if (isFormatError(error)) {
      throw error;
    }
    throw new FormatError(
      "PROFILE_INVALID",
      "AVC encoder rendition could not be prepared"
    );
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function normalizeEncoderUnitStream(
  bytes: Uint8Array,
  expectedAccessUnitCount: number,
  path: string
): readonly AvcAccessUnitInput[] {
  const nals = splitAnnexBAccessUnit(
    bytes,
    path,
    ENCODER_STREAM_MAX_NAL_UNITS,
    true
  );
  requireAvc(
    nals[0]?.type === AVC_NAL_TYPE_AUD,
    path,
    "raw encoder stream must begin with AUD"
  );

  const groups: AnnexBNalUnit[][] = [];
  let current: AnnexBNalUnit[] | undefined;
  for (const nal of nals) {
    if (nal.type === AVC_NAL_TYPE_AUD) {
      if (current !== undefined) {
        groups.push(current);
      }
      current = [nal];
    } else {
      requireAvc(current !== undefined, path, "NAL unit appears before the first AUD");
      current.push(nal);
    }
  }
  if (current !== undefined) {
    groups.push(current);
  }
  requireAvc(
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
): AvcAccessUnitInput {
  const retained = group.filter((nal) => nal.type !== AVC_NAL_TYPE_SEI);
  requireAvc(
    retained[0]?.type === AVC_NAL_TYPE_AUD,
    path,
    "normalized access unit must begin with AUD"
  );
  const vcl = retained.filter(
    (nal) => nal.type === AVC_NAL_TYPE_IDR || nal.type === AVC_NAL_TYPE_NON_IDR
  );
  requireAvc(vcl.length > 0, path, "access unit contains no coded picture");

  let length = 0;
  for (const nal of retained) {
    length += FOUR_BYTE_START_CODE.length + nal.payload.length;
    requireAvc(
      Number.isSafeInteger(length) && length <= FORMAT_DEFAULT_BUDGETS.maxSampleBytes,
      path,
      "normalized access unit exceeds the sample budget"
    );
  }
  const normalized = new Uint8Array(length);
  let offset = 0;
  for (const nal of retained) {
    normalized.set(FOUR_BYTE_START_CODE, offset);
    offset += FOUR_BYTE_START_CODE.length;
    normalized.set(nal.payload, offset);
    offset += nal.payload.length;
  }
  return Object.freeze({
    key: vcl.some((nal) => nal.type === AVC_NAL_TYPE_IDR),
    bytes: normalized
  });
}
