import { describe, expect, it } from "vitest";

import {
  encodedCopyCeilingForUnits,
  routeWaitBlocksPresentation
} from "../src/player.js";

describe("player runtime planning", () => {
  it("classifies only a held finite endpoint as a route-wait underflow", () => {
    const portal = { start: { type: "portal" as const } };
    const cut = { start: { type: "cut" as const } };
    const finite = {
      id: "finite", kind: "body" as const, playback: "finite" as const,
      frameCount: 3, ports: [], chunks: []
    };
    const loop = { ...finite, id: "loop", playback: "loop" as const };

    expect(routeWaitBlocksPresentation(
      { kind: "body", state: "a", unitId: "finite", frameIndex: 2 },
      portal,
      finite
    )).toBe(true);
    expect(routeWaitBlocksPresentation(
      { kind: "body", state: "a", unitId: "finite", frameIndex: 1 },
      portal,
      finite
    )).toBe(false);
    expect(routeWaitBlocksPresentation(
      { kind: "body", state: "a", unitId: "loop", frameIndex: 2 },
      portal,
      loop
    )).toBe(false);
    expect(routeWaitBlocksPresentation(
      { kind: "body", state: "a", unitId: "finite", frameIndex: 2 },
      cut,
      finite
    )).toBe(false);
  });

  it("budgets four queued, one active, and one retiring encoded copy exactly", () => {
    expect(encodedCopyCeilingForUnits([10])).toBe(30);
    expect(encodedCopyCeilingForUnits([10, 8, 6, 4, 2])).toBe(48);
    expect(encodedCopyCeilingForUnits([])).toBe(0);
    expect(() => encodedCopyCeilingForUnits([
      Number.MAX_SAFE_INTEGER
    ])).toThrow(/resource budget/i);
  });
});
