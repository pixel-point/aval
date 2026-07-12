import { describe, expect, it } from "vitest";

import { runIntegratedFuzzSeed } from "./integrated-player-fuzz-support.js";

const FUZZ_SEEDS = Object.freeze([
  1,
  0x5eed_c0de,
  0x00c0_ffee,
  0xffff_ffff
] as const);

describe("IntegratedPlayer fixed-seed model properties", () => {
  for (const seed of FUZZ_SEEDS) {
    it(`replays bounded seed 0x${seed.toString(16)} deterministically`, async () => {
      const first = await runIntegratedFuzzSeed(seed);
      const second = await runIntegratedFuzzSeed(seed);

      expect(second).toEqual(first);
    });
  }
});
