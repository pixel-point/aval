import { describe, expect, it } from "vitest";

// @ts-expect-error Vite exposes the checked-in binary as a data URL in tests.
import packedFixtureDataUrl from "../../../../fixtures/conformance/m6/packed-alpha-all-routes.rma?url&inline";

import { runIntegratedFuzzSeed } from "./integrated-player-fuzz-support.js";
import { runM7ResourceLifecycleFuzz } from "./m7-resource-lifecycle-fuzz-test-support.js";
import {
  runM7BoundedBodyFuzz,
  runM7IntegrityPromotionFuzz,
  runM7ResponseGrammarFuzz
} from "./m7-transport-fuzz-test-support.js";

const FUZZ_SEEDS = Object.freeze([
  { seed: 1, profile: "opaque" as const },
  { seed: 0x5eed_c0de, profile: "packed" as const },
  { seed: 0x00c0_ffee, profile: "opaque" as const },
  { seed: 0xffff_ffff, profile: "packed" as const }
] as const);
const PACKED_FIXTURE = decodeFixture(packedFixtureDataUrl);

const M7_FUZZ_SEEDS = Object.freeze([
  0x0000_0001,
  0x7f4a_7c15,
  0xa11c_e5ed,
  0xffff_ffff
] as const);
const M7_GRAMMAR_CASES_PER_SEED = 128;
const M7_BODY_CASES_PER_SEED = 72;
const M7_INTEGRITY_CASES_PER_SEED = 12;
const M7_RESOURCE_STEPS_PER_SEED = 256;

describe("IntegratedPlayer fixed-seed model properties", () => {
  for (const { seed, profile } of FUZZ_SEEDS) {
    it(`replays bounded ${profile} seed 0x${seed.toString(16)} deterministically`, async () => {
      const options = profile === "packed"
        ? { bytes: PACKED_FIXTURE }
        : {};
      const first = await runIntegratedFuzzSeed(seed, options);
      const second = await runIntegratedFuzzSeed(seed, options);

      expect(second).toEqual(first);
      expect(first.profile).toBe(profile === "packed"
        ? "avc-annexb-packed-alpha-v0"
        : "avc-annexb-opaque-v0");
      expect(first.abortAction).toBe(true);
      expect(first.resizeActions).toBeGreaterThan(0);
    });
  }
});

describe("M7 fixed-seed adversarial authorities", () => {
  for (const seed of M7_FUZZ_SEEDS) {
    it(`rejects hostile response grammar/entity generations for seed 0x${seed.toString(16)}`, () => {
      runM7ResponseGrammarFuzz(seed, M7_GRAMMAR_CASES_PER_SEED);
    });

    it(`retires every bounded body tape for seed 0x${seed.toString(16)}`, async () => {
      await runM7BoundedBodyFuzz(seed, M7_BODY_CASES_PER_SEED);
    });

    it(`blocks corrupt blob promotion/media entry for seed 0x${seed.toString(16)}`, async () => {
      await runM7IntegrityPromotionFuzz(
        seed,
        M7_INTEGRITY_CASES_PER_SEED,
        PACKED_FIXTURE
      );
    });

    it(`replays resource/lifecycle seed 0x${seed.toString(16)} deterministically`, async () => {
      const first = await runM7ResourceLifecycleFuzz(
        seed,
        M7_RESOURCE_STEPS_PER_SEED
      );
      const second = await runM7ResourceLifecycleFuzz(
        seed,
        M7_RESOURCE_STEPS_PER_SEED
      );
      expect(second).toEqual(first);
      expect(first.injectedAllocationRollbacks).toBeGreaterThan(0);
      expect(first.replacements).toBeGreaterThan(0);
      expect(first.peakPageBytes).toBeLessThanOrEqual(4_096);
      expect(first.peakDecoderLeases).toBeLessThanOrEqual(2);
      expect(first.terminal).toEqual({
        physicalBytes: 0,
        byteLeaseCount: 0,
        decoderLeaseCount: 0,
        decoderQueueLength: 0,
        pendingReclamations: 0,
        participants: 0
      });
    });
  }
});

function decodeFixture(dataUrl: string): Uint8Array {
  const separator = dataUrl.indexOf(",");
  if (
    !dataUrl.startsWith("data:") ||
    separator < 0 ||
    !dataUrl.slice(0, separator).endsWith(";base64")
  ) {
    throw new Error("Vite did not inline the M6 fixture as base64");
  }
  const binary = atob(dataUrl.slice(separator + 1));
  return Uint8Array.from(binary, (value) => value.charCodeAt(0));
}
