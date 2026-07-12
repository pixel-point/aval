import { describe, expect, it } from "vitest";

import { validateIntegratedContentTickContext } from "./integrated-player-support.js";

describe("integrated content tick timing validation", () => {
  it.each([
    { field: "callbackStartMicroseconds", value: -1 },
    { field: "callbackStartMicroseconds", value: Number.NaN },
    { field: "callbackStartMicroseconds", value: Number.MAX_SAFE_INTEGER + 1 },
    { field: "eligibleAnimationFrameOrdinal", value: 0 },
    { field: "eligibleAnimationFrameOrdinal", value: -1 },
    { field: "eligibleAnimationFrameOrdinal", value: Number.NaN },
    { field: "eligibleAnimationFrameOrdinal", value: Number.MAX_SAFE_INTEGER + 1 }
  ])("rejects hostile $field=$value", ({ field, value }) => {
    expect(() => validateIntegratedContentTickContext({
      presentationOrdinal: 1n,
      rationalDeadlineUs: 33_333,
      [field]: value
    })).toThrow(/callback start|animation-frame ordinal/u);
  });

  it("accepts the exact nonnegative timing boundaries", () => {
    expect(() => validateIntegratedContentTickContext({
      presentationOrdinal: 1n,
      rationalDeadlineUs: 0,
      callbackStartMicroseconds: 0,
      eligibleAnimationFrameOrdinal: 1
    })).not.toThrow();
  });
});
