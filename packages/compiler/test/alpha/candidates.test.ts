import { describe, expect, it } from "vitest";
import { selectAlphaCandidates } from "../../src/alpha/candidates.js";
import type { AlphaCandidate } from "../../src/alpha/types.js";

const candidate = (bytes: number, alphaMae: number, compositeMae: number): AlphaCandidate => ({
  codec: "h265", crf: 20, preset: "slow", cpuUsed: 2, selected: false, pareto: false, bytes, encodeMs: 1,
  metrics: { alphaMae, compositeMae, alphaMaxError: alphaMae, frames: 4 }, arguments: []
});
const limits = { crfs: [20], maxAlphaMae: 3, maxCompositeMae: 3 };

describe("alpha candidate selection", () => {
  it("keeps the smallest qualifying candidate with stable ties and independent Pareto status", () => {
    const input = [candidate(10, 5, 5), candidate(20, 2, 2), candidate(20, 2, 2), candidate(30, 3, 3), candidate(40, 1, 1)];
    const result = selectAlphaCandidates(input, limits);
    expect(result.winner).toBe(1);
    expect(result.candidates.map((item) => item.selected)).toEqual([false, true, false, false, false]);
    expect(result.candidates.map((item) => item.pareto)).toEqual([true, true, true, false, true]);
    expect(input.every((item) => !item.selected && !item.pareto)).toBe(true);
  });
  it("rejects a search without a qualifying candidate", () => {
    expect(() => selectAlphaCandidates([candidate(10, 5, 5)], limits)).toThrow(/No h265 candidate/u);
  });
});
