import { CompilerError } from "../diagnostics.js";
import type { AlphaCandidate, AlphaCompileOptions } from "./types.js";

/** Select within one codec; ties preserve authored search order. */
export function selectAlphaCandidates(candidates: readonly AlphaCandidate[], limits: AlphaCompileOptions["optimize"]) {
  let winner = -1;
  for (const [index, candidate] of candidates.entries()) {
    const qualifies = !limits || candidate.metrics.alphaMae <= limits.maxAlphaMae &&
      candidate.metrics.compositeMae <= limits.maxCompositeMae;
    if (qualifies && (winner < 0 || candidate.bytes < candidates[winner]!.bytes)) winner = index;
  }
  if (winner < 0) throw new CompilerError("ALPHA_POLICY_REJECTED", `No ${candidates[0]?.codec ?? "video"} candidate meets the requested alpha/composite error limits`);
  return {
    winner,
    candidates: candidates.map((candidate, index) => ({
      ...candidate, selected: index === winner, pareto: !candidates.some((other) => dominates(other, candidate))
    }))
  };
}

function dominates(left: AlphaCandidate, right: AlphaCandidate): boolean {
  return left.bytes <= right.bytes && left.metrics.alphaMae <= right.metrics.alphaMae &&
    left.metrics.compositeMae <= right.metrics.compositeMae &&
    (left.bytes < right.bytes || left.metrics.alphaMae < right.metrics.alphaMae || left.metrics.compositeMae < right.metrics.compositeMae);
}
