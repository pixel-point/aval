import { FORMAT_DEFAULT_BUDGETS } from "../constants.js";
import { FormatError } from "../errors.js";
import {
  H264_NAL_TYPE_SPS,
  splitAnnexBAccessUnit
} from "./annex-b.js";
import { requireH264 } from "./failure.js";
import { parseSps } from "./parameter-sets.js";

const CONSTRAINED_BASELINE_C0 = 0xc0;
const CONSTRAINED_BASELINE_E0 = 0xe0;

/**
 * Canonicalizes libx264's valid `42 C0 xx` Baseline declaration to the
 * format's `42 E0 xx` Constrained Baseline declaration. Every SPS is fully
 * parsed before and after the bounded rewrite.
 */
export function canonicalizeH264ConstraintSet2(
  accessUnitBytes: Uint8Array
): Uint8Array {
  const path = "accessUnit";
  requireH264(
    accessUnitBytes instanceof Uint8Array,
    path,
    "access unit must be bytes"
  );
  requireH264(
    accessUnitBytes.length <= FORMAT_DEFAULT_BUDGETS.maxChunkBytes,
    path,
    "access unit exceeds the sample budget"
  );
  const nals = splitAnnexBAccessUnit(accessUnitBytes, path);
  let output: Uint8Array;
  try {
    output = accessUnitBytes.slice();
  } catch {
    throw new FormatError(
      "PROFILE_INVALID",
      `H264 canonicalization allocation of ${String(accessUnitBytes.byteLength)} bytes failed`,
      { path }
    );
  }

  for (let index = 0; index < nals.length; index += 1) {
    const nal = nals[index];
    if (nal?.type !== H264_NAL_TYPE_SPS) continue;

    const nalPath = `${path}.nals[${String(index)}]`;
    parseSps(nal, nalPath, "encoder-candidate");

    const compatibilityOffset = nal.offset + 2;
    const compatibility = output[compatibilityOffset];
    requireH264(
      compatibility === CONSTRAINED_BASELINE_C0 ||
        compatibility === CONSTRAINED_BASELINE_E0,
      nalPath,
      "only an SPS C0 to E0 constraint canonicalization is permitted",
      compatibilityOffset
    );
    output[compatibilityOffset] = CONSTRAINED_BASELINE_E0;
  }

  // Re-tokenize and parse rewritten bytes so this helper cannot emit syntax
  // that the strict final-profile inspector rejects.
  const rewrittenNals = splitAnnexBAccessUnit(output, path);
  for (let index = 0; index < rewrittenNals.length; index += 1) {
    const nal = rewrittenNals[index];
    if (nal?.type !== H264_NAL_TYPE_SPS) continue;

    const parsed = parseSps(nal, `${path}.nals[${String(index)}]`);
    requireH264(
      parsed.constraintSet2,
      `${path}.nals[${String(index)}]`,
      "rewritten Baseline SPS does not assert constraint_set2"
    );
  }
  return output;
}
