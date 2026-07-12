import type { ReadinessV01 } from "@rendered-motion/format";

import { CompilerError } from "../diagnostics.js";
import type { SourceProjectV01 } from "../model.js";

/** Derive the minimal route set required before animated initial readiness. */
export function deriveReadiness(project: SourceProjectV01): ReadinessV01 {
  const states = new Map(project.states.map((state) => [state.id, state]));
  const initial = states.get(project.initialState);
  if (initial === undefined) {
    throw new CompilerError("INPUT_INVALID", "Initial state is unavailable");
  }
  const bootstrap = new Set<string>([initial.bodyUnit]);
  if (initial.initialUnit !== undefined) bootstrap.add(initial.initialUnit);
  const immediateEdges = project.edges
    .filter(({ from }) => from === project.initialState)
    .map((edge) => {
      const target = states.get(edge.to);
      if (target === undefined) {
        throw new CompilerError(
          "INPUT_INVALID",
          `Immediate edge ${edge.id} has no target state`
        );
      }
      bootstrap.add(target.bodyUnit);
      if (edge.transition !== undefined) bootstrap.add(edge.transition.unit);
      return edge.id;
    })
    .sort();
  return Object.freeze({
    policy: "all-routes",
    bootstrapUnits: Object.freeze([...bootstrap].sort()),
    immediateEdges: Object.freeze(immediateEdges)
  });
}
