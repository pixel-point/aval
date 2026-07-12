import { describe, expect, it } from "vitest";

import {
  graphBodyFrameAt,
  manifestBodyFrameAt
} from "./body-frame-semantics.js";

describe("authored body frame semantics", () => {
  it("wraps only loop bodies", () => {
    expect(Array.from({ length: 7 }, (_, frame) =>
      graphBodyFrameAt({ kind: "loop", frameCount: 4 }, frame)
    )).toEqual([0, 1, 2, 3, 0, 1, 2]);
    expect(Array.from({ length: 7 }, (_, frame) =>
      manifestBodyFrameAt({ playback: "loop", frameCount: 4 }, frame)
    )).toEqual([0, 1, 2, 3, 0, 1, 2]);
  });

  it("saturates finite and held bodies at the terminal frame", () => {
    expect(Array.from({ length: 7 }, (_, frame) =>
      graphBodyFrameAt({ kind: "finite", frameCount: 4 }, frame)
    )).toEqual([0, 1, 2, 3, 3, 3, 3]);
    expect(Array.from({ length: 4 }, (_, frame) =>
      graphBodyFrameAt({ kind: "held", frameCount: 1 }, frame)
    )).toEqual([0, 0, 0, 0]);
    expect(Array.from({ length: 7 }, (_, frame) =>
      manifestBodyFrameAt({ playback: "finite", frameCount: 4 }, frame)
    )).toEqual([0, 1, 2, 3, 3, 3, 3]);
  });
});
