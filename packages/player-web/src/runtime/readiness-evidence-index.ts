import type {
  AllRoutesReadinessEvidence,
  CutReadinessEvidence,
  EdgeDryRunEvidence,
  EndpointRecoveryEvidence,
  InverseReadinessEvidence,
  LoopReadinessEvidence,
  ReadinessEvaluationFailure,
  ReadinessFailureCollector,
  ReadinessFailureContext,
  RoutePhaseEvidence
} from "./readiness-evaluator-types.js";

export interface IndexedReadinessEvidence {
  readonly loops: ReadonlyMap<string, Readonly<LoopReadinessEvidence>>;
  readonly dryRuns: ReadonlyMap<string, Readonly<EdgeDryRunEvidence>>;
  readonly cuts: ReadonlyMap<string, Readonly<CutReadinessEvidence>>;
  readonly endpoints: ReadonlyMap<string, Readonly<EndpointRecoveryEvidence>>;
  readonly phases: ReadonlyMap<string, Readonly<RoutePhaseEvidence>>;
  readonly inverses: ReadonlyMap<string, Readonly<InverseReadinessEvidence>>;
}

export function indexReadinessEvidence(
  evidence: Readonly<AllRoutesReadinessEvidence>,
  collector: ReadinessFailureCollector
): Readonly<IndexedReadinessEvidence> {
  return Object.freeze({
    loops: uniqueMap(
      evidence.loops,
      ({ unit }) => unit,
      collector,
      ({ unit }) => ({ unit })
    ),
    dryRuns: uniqueMap(
      evidence.edgeDryRuns,
      ({ edge }) => edge,
      collector,
      ({ edge }) => ({ edge })
    ),
    cuts: uniqueMap(
      evidence.cuts,
      ({ edge }) => edge,
      collector,
      ({ edge }) => ({ edge })
    ),
    endpoints: uniqueMap(
      evidence.endpoints,
      endpointEvidenceKey,
      collector,
      ({ unit, state }) => ({ unit, state })
    ),
    phases: uniqueMap(
      evidence.phases,
      ({ edge }) => edge,
      collector,
      ({ edge }) => ({ edge })
    ),
    inverses: uniqueMap(
      evidence.inverses,
      ({ unit }) => unit,
      collector,
      ({ unit }) => ({ unit })
    )
  });
}

export function createReadinessFailureCollector(): ReadinessFailureCollector {
  const failures: ReadinessEvaluationFailure[] = [];
  return {
    failures,
    add(code, message, context = {}) {
      failures.push({ code, message, ...context });
    }
  };
}

export function endpointEvidenceKey(value: {
  readonly unit: string;
  readonly state: string;
  readonly port: string;
}): string {
  return `${value.unit}\u0000${value.state}\u0000${value.port}`;
}

function uniqueMap<T>(
  values: readonly Readonly<T>[],
  keyOf: (value: Readonly<T>) => string,
  collector: ReadinessFailureCollector,
  contextOf: (value: Readonly<T>) => ReadinessFailureContext
): ReadonlyMap<string, Readonly<T>> {
  const result = new Map<string, Readonly<T>>();
  for (const value of values) {
    const key = keyOf(value);
    if (result.has(key)) {
      collector.add(
        "duplicate-evidence",
        "readiness evidence contains a duplicate identity",
        contextOf(value)
      );
      continue;
    }
    result.set(key, value);
  }
  return result;
}
