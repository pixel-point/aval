import { FORMAT_DEFAULT_BUDGETS } from "@pixel-point/aval-format";
import { ASSET_ADMISSION_TIMEOUT_MS } from "./asset-timing-policy.js";
import { DECODER_PROGRESS_TIMEOUT_MS } from "./decoder-timing-policy.js";
import { SOURCE_CODEC_PRIORITY } from "./source-codec-policy.js";

export const CANDIDATE_PREPARATION_TIMEOUT_MS = 2_500;
export const DEFAULT_PREPARATION_TIMEOUT_MS = 5_000;
export const ELEMENT_SETUP_TIMEOUT_MS = 5_000;
export const CANDIDATE_INSTALLATION_TIMEOUT_MS = 5_000;

/**
 * Every format-admitted rendition can consume one bounded asset admission,
 * decoder probe, candidate installation, and qualification window. Selection
 * currently retires the asset after a rejected rendition, so the next
 * rendition reopens it. The absolute cap therefore covers the complete
 * codec-family/rendition matrix. Element intersection/module setup has its own
 * boundary and intentionally is not charged to this player ladder reserve.
 */
const CANDIDATE_SELECTION_TIMEOUT_MS =
  ASSET_ADMISSION_TIMEOUT_MS + DECODER_PROGRESS_TIMEOUT_MS +
  CANDIDATE_INSTALLATION_TIMEOUT_MS + CANDIDATE_PREPARATION_TIMEOUT_MS;

const MAX_PLAYER_PREPARATION_TIMEOUT_MS =
  SOURCE_CODEC_PRIORITY.length * FORMAT_DEFAULT_BUDGETS.maxRenditions *
  CANDIDATE_SELECTION_TIMEOUT_MS;

export const MAX_PREPARATION_TIMEOUT_MS =
  ELEMENT_SETUP_TIMEOUT_MS + MAX_PLAYER_PREPARATION_TIMEOUT_MS;

export function playerPreparationBudgetMs(sourceCount: number): number {
  if (!Number.isSafeInteger(sourceCount) || sourceCount < 1) {
    throw new RangeError("AVAL source count is invalid");
  }
  const candidateCapacity = Math.min(
    sourceCount,
    SOURCE_CODEC_PRIORITY.length
  ) * FORMAT_DEFAULT_BUDGETS.maxRenditions;
  return Math.min(
    MAX_PLAYER_PREPARATION_TIMEOUT_MS,
    Math.max(
      DEFAULT_PREPARATION_TIMEOUT_MS,
      candidateCapacity * CANDIDATE_SELECTION_TIMEOUT_MS
    )
  );
}

export function preparationBudgetMs(sourceCount: number): number {
  return ELEMENT_SETUP_TIMEOUT_MS + playerPreparationBudgetMs(sourceCount);
}
