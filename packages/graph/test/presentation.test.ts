import { describe, expect, it } from "vitest";

import {
  sameGraphPresentation,
  type GraphPresentation
} from "../src/index.js";

describe("sameGraphPresentation", () => {
  it("compares every presentation identity field", () => {
    const reversible = {
      kind: "reversible" as const,
      edgeId: "idle.hover",
      unitId: "reversible",
      frameIndex: 3,
      direction: "forward" as const
    };
    const presentations: readonly Readonly<GraphPresentation>[] = [
      { kind: "static", state: "idle" },
      { kind: "intro", state: "idle", unitId: "intro", frameIndex: 0 },
      { kind: "body", state: "idle", unitId: "body", frameIndex: 1 },
      { kind: "locked", edgeId: "idle.hover", unitId: "locked", frameIndex: 2 },
      reversible
    ];

    for (const presentation of presentations) {
      expect(sameGraphPresentation(presentation, { ...presentation })).toBe(true);
    }
    expect(sameGraphPresentation(null, null)).toBe(true);
    expect(sameGraphPresentation(null, presentations[0]!)).toBe(false);
    expect(sameGraphPresentation(presentations[1]!, presentations[2]!)).toBe(false);
    expect(sameGraphPresentation(
      reversible,
      { ...reversible, direction: "reverse" }
    )).toBe(false);
  });
});
