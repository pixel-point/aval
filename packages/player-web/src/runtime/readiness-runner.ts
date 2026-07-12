import type { UnitV01 } from "@rendered-motion/format";
import type { GraphEdgeDefinition } from "@rendered-motion/graph";

import {
  evaluateAllRoutesReadiness,
  type CutReadinessEvidence,
  type EdgeDryRunEvidence,
  type EndpointRecoveryEvidence,
  type InverseReadinessEvidence,
  type LoopReadinessEvidence,
  type RoutePhaseEvidence
} from "./readiness-evaluator.js";
import { calculateReadinessMetrics } from "./readiness-metrics.js";
import {
  selectedReadinessRingCapacity,
  targetProbeFramesForMetrics
} from "./readiness-route-validation.js";
import {
  normalizeRuntimeFailure,
  type RuntimeFailure
} from "./errors.js";
import type {
  ReadinessRunnerAdapters,
  ReadinessRunnerInput,
  ReadinessRunnerResult,
  WarmupAdapterInput
} from "./readiness-runner-types.js";

type BodyUnit = Extract<UnitV01, { readonly kind: "body" }>;
type LoopBodyUnit = BodyUnit & { readonly playback: "loop" };
type ReversibleUnit = Extract<UnitV01, { readonly kind: "reversible" }>;

interface RunnerMeasurementContext {
  readonly base: Readonly<WarmupAdapterInput>;
  readonly adapters: ReadinessRunnerAdapters;
  readonly ringCapacity: number;
  readonly targetProbeFrames: number;
}

interface EdgeEvidenceGroup {
  readonly edgeDryRuns: EdgeDryRunEvidence[];
  readonly cuts: CutReadinessEvidence[];
  readonly phases: RoutePhaseEvidence[];
}

interface ResidentEvidenceGroup {
  readonly endpoints: EndpointRecoveryEvidence[];
  readonly inverses: InverseReadinessEvidence[];
}

export type {
  CutAdapterResult,
  EdgeAdapterInput,
  EdgeDryRunAdapterResult,
  EndpointAdapterInput,
  EndpointAdapterResult,
  InitialRingAdapterInput,
  InverseAdapterInput,
  InverseAdapterResult,
  LoopAdapterInput,
  LoopAdapterResult,
  ReadinessRunnerAdapters,
  ReadinessRunnerInput,
  ReadinessRunnerResult,
  ResourceAdapterInput,
  RoutePhaseAdapterResult,
  WarmupAdapterInput,
  WarmupAdapterResult
} from "./readiness-runner-types.js";

const RUNNER_OPERATION = "all-routes-readiness-runner";

export async function runAllRoutesReadiness(
  input: ReadinessRunnerInput
): Promise<Readonly<ReadinessRunnerResult>> {
  const { manifest, graph, adapters } = input;
  const base = Object.freeze({ manifest, graph });
  try {
    const warmup = await adapters.measureWarmup(base);
    const warmupMetrics = calculateReadinessMetrics({
      frameRate: manifest.frameRate,
      measurements: warmup.measurements
    });
    if (!warmupMetrics.passed || warmupMetrics.ringCapacity === null) {
      return Object.freeze({
        passed: false,
        evaluation: null,
        failure: readinessFailure("warm-up readiness metrics failed")
      });
    }
    const ringCapacity = selectedReadinessRingCapacity(warmupMetrics);
    const targetProbeFrames = targetProbeFramesForMetrics(warmupMetrics);
    const context = Object.freeze({
      base,
      adapters,
      ringCapacity,
      targetProbeFrames
    });
    const loops = await collectLoopEvidence(context);
    const { edgeDryRuns, cuts, phases } = await collectEdgeEvidence(context);
    const { endpoints, inverses } = await collectResidentEvidence(context);

    const resourceResult = await adapters.measureResource(Object.freeze({
      ...context.base,
      ringCapacity,
      targetProbeFrames
    }));
    const resource = Object.freeze({
      passed: resourceResult.passed,
      totalBytes: resourceResult.totalBytes,
      capBytes: resourceResult.capBytes
    });
    const ringResult = await adapters.fillInitialRing(Object.freeze({
      ...context.base,
      ringCapacity
    }));
    const initialRing = Object.freeze({
      passed: ringResult.passed,
      frameCount: ringResult.frameCount
    });

    const evaluation = evaluateAllRoutesReadiness({
      manifest,
      graph,
      evidence: Object.freeze({
        warmupMetrics,
        loops: Object.freeze(loops),
        edgeDryRuns: Object.freeze(edgeDryRuns),
        cuts: Object.freeze(cuts),
        endpoints: Object.freeze(endpoints),
        phases: Object.freeze(phases),
        inverses: Object.freeze(inverses),
        resource,
        initialRing
      })
    });
    if (evaluation.passed) {
      return Object.freeze({ passed: true, evaluation, failure: null });
    }
    return Object.freeze({
      passed: false,
      evaluation,
      failure: readinessFailure()
    });
  } catch (cause) {
    return Object.freeze({
      passed: false,
      evaluation: null,
      failure: readinessFailure(cause)
    });
  }
}

async function collectLoopEvidence(
  context: Readonly<RunnerMeasurementContext>
): Promise<LoopReadinessEvidence[]> {
  const { manifest, graph } = context.base;
  const loops: LoopReadinessEvidence[] = [];
  const units = orderByHints(
    manifest.units.filter(isLoopBodyUnit),
    manifest.readiness.bootstrapUnits,
    ({ id }) => id
  );
  for (const unit of units) {
    const measured = await context.adapters.measureLoop(Object.freeze({
      ...context.base,
      unit,
      states: Object.freeze(graph.definition.states.filter(
        ({ body }) => body.unitId === unit.id
      )),
      ringCapacity: context.ringCapacity
    }));
    loops.push(Object.freeze({
      unit: unit.id,
      seamReady: measured.seamReady,
      availableHeadroomFrames: measured.availableHeadroomFrames
    }));
  }
  return loops;
}

async function collectEdgeEvidence(
  context: Readonly<RunnerMeasurementContext>
): Promise<Readonly<EdgeEvidenceGroup>> {
  const { manifest, graph } = context.base;
  const graphStates = new Map(
    graph.definition.states.map((state) => [state.id, state] as const)
  );
  const manifestEdges = new Map(
    manifest.edges.map((edge) => [edge.id, edge] as const)
  );
  const edgeDryRuns: EdgeDryRunEvidence[] = [];
  const cuts: CutReadinessEvidence[] = [];
  const phases: RoutePhaseEvidence[] = [];
  const edges = orderByHints(
    graph.definition.edges,
    manifest.readiness.immediateEdges,
    ({ id }) => id
  );

  for (const edge of edges) {
    const edgeInput = Object.freeze({
      ...context.base,
      edge,
      manifestEdge: requireMapValue(manifestEdges, edge.id, "manifest edge"),
      source: requireMapValue(graphStates, edge.from, "source state"),
      target: requireMapValue(graphStates, edge.to, "target state"),
      ringCapacity: context.ringCapacity,
      targetProbeFrames: context.targetProbeFrames
    });
    const phase = await context.adapters.simulateRoutePhases(edgeInput);
    phases.push(Object.freeze({
      edge: edge.id,
      pendingCancellationReady: phase.pendingCancellationReady,
      pendingReplacementReady: phase.pendingReplacementReady,
      prospectiveTargetReady: phase.prospectiveTargetReady,
      lockedFollowOnReady: phase.lockedFollowOnReady
    }));
    if (edge.start.type === "cut") {
      cuts.push(await collectCutEvidence(context, edgeInput));
    } else if (!isReversibleEdge(edge)) {
      edgeDryRuns.push(await collectDryRunEvidence(context, edgeInput));
    }
  }
  return Object.freeze({ edgeDryRuns, cuts, phases });
}

async function collectCutEvidence(
  context: Readonly<RunnerMeasurementContext>,
  edgeInput: Parameters<ReadinessRunnerAdapters["prepareCut"]>[0]
): Promise<Readonly<CutReadinessEvidence>> {
  const measured = await context.adapters.prepareCut(edgeInput);
  return Object.freeze({
    edge: edgeInput.edge.id,
    runwayPrepared: measured.runwayPrepared,
    responseFrames: measured.responseFrames,
    runwayFrames: measured.runwayFrames,
    continuationFrame: measured.continuationFrame,
    recoveryFrames: measured.recoveryFrames,
    deadlineSafe: measured.deadlineSafe,
    withinBudget: measured.withinBudget
  });
}

async function collectDryRunEvidence(
  context: Readonly<RunnerMeasurementContext>,
  edgeInput: Parameters<ReadinessRunnerAdapters["dryRunEdge"]>[0]
): Promise<Readonly<EdgeDryRunEvidence>> {
  const measured = await context.adapters.dryRunEdge(edgeInput);
  return Object.freeze({
    edge: edgeInput.edge.id,
    metrics: calculateReadinessMetrics({
      frameRate: context.base.manifest.frameRate,
      measurements: measured.measurements
    }),
    availableConsecutiveFrames: measured.availableConsecutiveFrames,
    transitionFrames: measured.transitionFrames,
    targetProbeFrames: measured.targetProbeFrames,
    sequenceFrameCount: measured.sequenceFrameCount,
    completeSequence: measured.completeSequence,
    deadlineSafe: measured.deadlineSafe,
    withinBudget: measured.withinBudget
  });
}

async function collectResidentEvidence(
  context: Readonly<RunnerMeasurementContext>
): Promise<Readonly<ResidentEvidenceGroup>> {
  const endpoints: EndpointRecoveryEvidence[] = [];
  const inverses: InverseReadinessEvidence[] = [];
  const units = orderByHints(
    context.base.manifest.units.filter(isReversibleUnit),
    context.base.manifest.readiness.bootstrapUnits,
    ({ id }) => id
  );
  for (const unit of units) {
    for (const endpoint of unit.residency.endpoints) {
      const measured = await context.adapters.prepareEndpoint(Object.freeze({
        ...context.base,
        unit,
        endpoint,
        ringCapacity: context.ringCapacity
      }));
      endpoints.push(Object.freeze({
        unit: unit.id,
        state: endpoint.state,
        port: endpoint.port,
        runwayPrepared: measured.runwayPrepared,
        runwayFrames: measured.runwayFrames,
        continuationFrame: measured.continuationFrame,
        recoveryFrames: measured.recoveryFrames,
        deadlineSafe: measured.deadlineSafe,
        withinBudget: measured.withinBudget
      }));
    }
    const inverse = await context.adapters.measureActiveInverse(Object.freeze({
      ...context.base,
      unit,
      ringCapacity: context.ringCapacity
    }));
    inverses.push(Object.freeze({
      unit: unit.id,
      responseFrames: inverse.responseFrames,
      adjacentFrame: inverse.adjacentFrame
    }));
  }
  return Object.freeze({ endpoints, inverses });
}

function readinessFailure(cause?: unknown): Readonly<RuntimeFailure> {
  return normalizeRuntimeFailure(
    "readiness-failure",
    cause,
    Object.freeze({ operation: RUNNER_OPERATION })
  );
}

function orderByHints<T>(
  values: readonly T[],
  hints: readonly string[],
  idOf: (value: T) => string
): readonly T[] {
  const byId = new Map(values.map((value) => [idOf(value), value] as const));
  const seen = new Set<string>();
  const ordered: T[] = [];
  for (const hint of hints) {
    const value = byId.get(hint);
    if (value !== undefined && !seen.has(hint)) {
      ordered.push(value);
      seen.add(hint);
    }
  }
  for (const value of values) {
    const id = idOf(value);
    if (!seen.has(id)) {
      ordered.push(value);
      seen.add(id);
    }
  }
  return Object.freeze(ordered);
}

function requireMapValue<K, V>(
  values: ReadonlyMap<K, V>,
  key: K,
  label: string
): V {
  const value = values.get(key);
  if (value === undefined) {
    throw new RangeError(`readiness runner has no ${label}`);
  }
  return value;
}

function isLoopBodyUnit(unit: UnitV01): unit is LoopBodyUnit {
  return unit.kind === "body" && unit.playback === "loop";
}

function isReversibleUnit(unit: UnitV01): unit is ReversibleUnit {
  return unit.kind === "reversible";
}

function isReversibleEdge(edge: Readonly<GraphEdgeDefinition>): boolean {
  return edge.transition?.kind === "reversible";
}
