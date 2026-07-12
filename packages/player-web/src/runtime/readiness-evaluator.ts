import type {
  AllRoutesReadinessInput,
  AllRoutesReadinessReport,
  ReadinessEdgeReport
} from "./readiness-evaluator-types.js";
import {
  createReadinessFailureCollector,
  indexReadinessEvidence
} from "./readiness-evidence-index.js";
import {
  verifyInitialRing,
  verifyResource,
  verifyReversibleUnits
} from "./readiness-resident-validation.js";
import {
  safePlannerLead,
  selectedReadinessRingCapacity,
  targetProbeFramesForMetrics,
  verifyCut,
  verifyEdgeDryRun,
  verifyGraphCorrespondence,
  verifyLoops,
  verifyRoutePhases,
  verifyWarmup
} from "./readiness-route-validation.js";
import { enumerateEdgeSourceFrames } from "./readiness-scenario-enumerator.js";

export type {
  AllRoutesReadinessEvidence,
  AllRoutesReadinessInput,
  AllRoutesReadinessReport,
  CutReadinessEvidence,
  EdgeDryRunEvidence,
  EndpointRecoveryEvidence,
  InitialRingReadinessEvidence,
  InverseReadinessEvidence,
  LoopReadinessEvidence,
  ReadinessEdgeReport,
  ReadinessEvaluationFailure,
  ReadinessEvaluationFailureCode,
  ReadinessSourceFrameReport,
  ResourceReadinessEvidence,
  RoutePhaseEvidence
} from "./readiness-evaluator-types.js";

/**
 * Pure all-routes proof. Startup hints are deliberately not accepted here:
 * the complete manifest is the only source of the readiness set.
 */
export function evaluateAllRoutesReadiness(
  input: AllRoutesReadinessInput
): Readonly<AllRoutesReadinessReport> {
  const collector = createReadinessFailureCollector();
  const { manifest, graph, evidence } = input;
  const warmupMetrics = deepFreezeClone(evidence.warmupMetrics);
  const ringCapacity = selectedReadinessRingCapacity(warmupMetrics);
  const targetProbeFrames = targetProbeFramesForMetrics(warmupMetrics);

  verifyWarmup(manifest, warmupMetrics, collector);
  const indexed = indexReadinessEvidence(evidence, collector);
  verifyLoops(manifest, indexed.loops, ringCapacity, collector);

  const graphEdges = new Map(
    graph.definition.edges.map((edge) => [edge.id, edge] as const)
  );
  const graphStates = new Map(
    graph.definition.states.map((state) => [state.id, state] as const)
  );
  verifyGraphCorrespondence(manifest, graph, graphEdges, collector);

  const edgeReports: ReadinessEdgeReport[] = [];
  for (const manifestEdge of manifest.edges) {
    const edge = graphEdges.get(manifestEdge.id);
    if (edge === undefined) {
      continue;
    }
    const source = graphStates.get(edge.from);
    if (source === undefined) {
      collector.add(
        "manifest-graph",
        "an evaluated edge has no graph source state",
        { edge: edge.id, state: edge.from }
      );
      continue;
    }

    const failureCountBeforeEdge = collector.failures.length;
    const dryRun = verifyEdgeDryRun(
      edge,
      indexed.dryRuns.get(edge.id),
      ringCapacity,
      targetProbeFrames,
      collector
    );
    verifyRoutePhases(edge, indexed.phases.get(edge.id), collector);
    if (edge.start.type === "cut") {
      verifyCut(manifestEdge, indexed.cuts.get(edge.id), collector);
    }

    const sourceFrames = enumerateEdgeSourceFrames(
      graph.definition.edges,
      edge,
      source,
      ringCapacity,
      safePlannerLead(edge, dryRun, ringCapacity),
      collector
    );
    edgeReports.push(Object.freeze({
      edge: edge.id,
      sourceState: source.id,
      sourceFrames: Object.freeze(sourceFrames),
      passed:
        collector.failures.length === failureCountBeforeEdge &&
        sourceFrames.every(({ passed }) => passed)
    }));
  }

  verifyReversibleUnits(
    manifest,
    indexed.endpoints,
    indexed.inverses,
    collector
  );
  verifyResource(evidence.resource, collector);
  verifyInitialRing(evidence.initialRing, ringCapacity, collector);

  const failures = Object.freeze(
    collector.failures.map((failure) => Object.freeze(failure))
  );
  return Object.freeze({
    passed: failures.length === 0,
    warmupMetrics,
    ringCapacity,
    targetProbeFrames,
    evaluatedEdgeIds: Object.freeze(manifest.edges.map(({ id }) => id)),
    edges: Object.freeze(edgeReports),
    failures
  });
}

function deepFreezeClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => deepFreezeClone(item))) as T;
  }
  if (value !== null && typeof value === "object") {
    const clone: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      clone[key] = deepFreezeClone(item);
    }
    return Object.freeze(clone) as T;
  }
  return value;
}
