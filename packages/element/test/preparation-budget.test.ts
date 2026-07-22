import { describe, expect, it } from "vitest";

import {
  ASSET_ADMISSION_REQUEST_LIMIT,
  ASSET_ADMISSION_TIMEOUT_MS,
  ASSET_REQUEST_TIMEOUT_MS
} from "../src/asset-timing-policy.js";
import { DECODER_PROGRESS_TIMEOUT_MS } from
  "../src/decoder-timing-policy.js";
import {
  CANDIDATE_INSTALLATION_TIMEOUT_MS,
  CANDIDATE_PREPARATION_TIMEOUT_MS,
  ELEMENT_SETUP_TIMEOUT_MS,
  MAX_PREPARATION_TIMEOUT_MS,
  playerPreparationBudgetMs,
  preparationBudgetMs
} from "../src/preparation-budget.js";

describe("preparation budget", () => {
  it("derives one asset admission from the canonical three-request watchdog", () => {
    expect(ASSET_ADMISSION_REQUEST_LIMIT).toBe(3);
    expect(ASSET_REQUEST_TIMEOUT_MS).toBe(5_000);
    expect(ASSET_ADMISSION_TIMEOUT_MS).toBe(15_000);
  });

  it("owns separate setup, installation, and qualification windows", () => {
    expect(ELEMENT_SETUP_TIMEOUT_MS).toBe(5_000);
    expect(CANDIDATE_INSTALLATION_TIMEOUT_MS).toBe(5_000);
    expect(CANDIDATE_PREPARATION_TIMEOUT_MS).toBe(2_500);
  });

  it("covers admission, probing, installation, and qualification per rendition", () => {
    expect(playerPreparationBudgetMs(1)).toBe(98_000);
    expect(preparationBudgetMs(1)).toBe(103_000);
  });

  it("adds setup to the complete four-source player ladder maximum", () => {
    expect(MAX_PREPARATION_TIMEOUT_MS).toBe(397_000);
    expect(preparationBudgetMs(4)).toBe(MAX_PREPARATION_TIMEOUT_MS);
    expect(preparationBudgetMs(5)).toBe(MAX_PREPARATION_TIMEOUT_MS);
    expect(playerPreparationBudgetMs(4)).toBe(
      16 * (
        ASSET_ADMISSION_TIMEOUT_MS + DECODER_PROGRESS_TIMEOUT_MS +
        CANDIDATE_INSTALLATION_TIMEOUT_MS +
        CANDIDATE_PREPARATION_TIMEOUT_MS
      )
    );
    expect(MAX_PREPARATION_TIMEOUT_MS).toBe(
      ELEMENT_SETUP_TIMEOUT_MS + playerPreparationBudgetMs(4)
    );
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid source count %s",
    (sourceCount) => {
      expect(() => preparationBudgetMs(sourceCount)).toThrow(
        "AVAL source count is invalid"
      );
    }
  );
});
