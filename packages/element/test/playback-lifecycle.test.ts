import { describe, expect, it } from "vitest";

import {
  emptyPlaybackLifecycleCounters,
  retainPlaybackLifecycleCounters,
  saturatingIncrement
} from "../src/playback-lifecycle.js";

describe("playback lifecycle counters", () => {
  it("publishes the exact frozen, byte-free schema", () => {
    const counters = emptyPlaybackLifecycleCounters();

    expect(Reflect.ownKeys(counters)).toEqual([
      "outputsAccepted",
      "drawsCompleted",
      "logicalRunsCreated",
      "candidateCommits",
      "runsClosed",
      "transitionStarts",
      "transitionEnds",
      "loopCrossings",
      "nativeDecoderCreatesByLane",
      "nativeDecoderClosesByLane"
    ]);
    expect(Object.values(counters).flat()).toEqual(new Array(12).fill(0));
    expect(Object.isFrozen(counters)).toBe(true);
    expect(Object.isFrozen(counters.nativeDecoderCreatesByLane)).toBe(true);
    expect(Object.isFrozen(counters.nativeDecoderClosesByLane)).toBe(true);
  });

  it("uses one saturating increment at the safe-integer ceiling", () => {
    expect(saturatingIncrement(0)).toBe(1);
    expect(saturatingIncrement(Number.MAX_SAFE_INTEGER - 1)).toBe(
      Number.MAX_SAFE_INTEGER
    );
    expect(saturatingIncrement(Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER
    );
  });

  it("retains the monotonic high-water mark and resets only with a new object", () => {
    const retained = retainPlaybackLifecycleCounters(
      {
        ...emptyPlaybackLifecycleCounters(),
        outputsAccepted: 9,
        drawsCompleted: 7,
        nativeDecoderCreatesByLane: [3, 4]
      },
      {
        ...emptyPlaybackLifecycleCounters(),
        outputsAccepted: 4,
        drawsCompleted: 8,
        nativeDecoderCreatesByLane: [5, 2]
      }
    );

    expect(retained).toMatchObject({
      outputsAccepted: 9,
      drawsCompleted: 8,
      nativeDecoderCreatesByLane: [5, 4]
    });
    expect(emptyPlaybackLifecycleCounters()).toEqual({
      outputsAccepted: 0,
      drawsCompleted: 0,
      logicalRunsCreated: 0,
      candidateCommits: 0,
      runsClosed: 0,
      transitionStarts: 0,
      transitionEnds: 0,
      loopCrossings: 0,
      nativeDecoderCreatesByLane: [0, 0],
      nativeDecoderClosesByLane: [0, 0]
    });
  });
});
