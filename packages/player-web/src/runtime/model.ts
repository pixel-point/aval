import type {
  GraphPresentation,
  MotionGraphEffect,
  MotionGraphOperation,
  MotionGraphReadiness,
  MotionGraphSnapshot
} from "@rendered-motion/graph";

import {
  normalizeRuntimeFailure,
  type RuntimeFailure
} from "./errors.js";

export type RuntimeReadiness =
  | "unready"
  | "metadataReady"
  | "visualReady"
  | "interactiveReady"
  | "staticReady"
  | "disposed"
  | "error";

/** Exhaustive values; use RUNTIME_READINESS_LADDER for preparation order. */
export const RUNTIME_READINESS_LEVELS = Object.freeze([
  "unready",
  "metadataReady",
  "visualReady",
  "interactiveReady",
  "staticReady",
  "disposed",
  "error"
] as const satisfies readonly RuntimeReadiness[]);

/**
 * Player-owned milestones are sequential; successful preparation then branches
 * to exactly one ready mode. Disposed and error are terminal from any phase.
 */
export const RUNTIME_READINESS_LADDER = Object.freeze({
  initial: "unready" as const,
  playerOwned: Object.freeze([
    "metadataReady",
    "visualReady"
  ] as const),
  ready: Object.freeze([
    "interactiveReady",
    "staticReady"
  ] as const),
  terminal: Object.freeze([
    "disposed",
    "error"
  ] as const)
});

export const STATIC_REASONS = Object.freeze([
  "no-opaque-rendition",
  "worker-unavailable",
  "renderer-unavailable",
  "codec-unsupported",
  "resource-budget",
  "readiness-failed",
  "preparation-timeout",
  "animation-failure"
] as const);

export type StaticReason = (typeof STATIC_REASONS)[number];

export const RUNTIME_TRACE_CAPACITY = 512 as const;

export type GraphReadinessTranslation =
  | {
      readonly owner: "player-web";
      readonly readiness: null;
    }
  | {
      readonly owner: "graph";
      readonly readiness:
        | "unready"
        | "interactiveReady"
        | "staticReady"
        | "disposed"
        | "error";
    };

const GRAPH_READINESS_TRANSLATIONS: Readonly<
  Record<MotionGraphReadiness, Readonly<GraphReadinessTranslation>>
> = Object.freeze({
  unready: Object.freeze({ owner: "graph", readiness: "unready" }),
  preparing: Object.freeze({ owner: "player-web", readiness: null }),
  animated: Object.freeze({ owner: "graph", readiness: "interactiveReady" }),
  static: Object.freeze({ owner: "graph", readiness: "staticReady" }),
  disposed: Object.freeze({ owner: "graph", readiness: "disposed" }),
  error: Object.freeze({ owner: "graph", readiness: "error" })
});

/**
 * Translate the graph-owned readiness effects exactly once. `preparing` has no
 * runtime value because metadataReady and visualReady are player-web resource
 * and draw-barrier milestones.
 */
export function translateGraphReadiness(
  readiness: MotionGraphReadiness
): Readonly<GraphReadinessTranslation> {
  return GRAPH_READINESS_TRANSLATIONS[readiness];
}

export interface RuntimeCandidateReport {
  readonly rendition: string;
  readonly rank: number;
  readonly outcome: "eligible" | "selected" | "rejected";
  readonly failure: Readonly<RuntimeFailure> | null;
}

export interface RuntimeReadinessReport {
  readonly readiness: "interactiveReady" | "staticReady";
  readonly selectedRendition: string | null;
  readonly candidates: readonly Readonly<RuntimeCandidateReport>[];
}

export type RuntimeReadinessResult =
  | {
      readonly mode: "animated";
      readonly assurance: "best-effort";
      readonly report: Readonly<RuntimeReadinessReport>;
    }
  | {
      readonly mode: "static";
      readonly reason: StaticReason;
      readonly report: Readonly<RuntimeReadinessReport>;
    };

export function createRuntimeCandidateReport(
  report: RuntimeCandidateReport
): Readonly<RuntimeCandidateReport> {
  if (!Number.isSafeInteger(report.rank) || report.rank < 0) {
    throw new RangeError(
      "runtime candidate rank must be a non-negative integer"
    );
  }
  if (report.rendition.length < 1) {
    throw new RangeError("runtime candidate rendition must not be empty");
  }
  if (report.outcome !== "rejected" && report.failure !== null) {
    throw new RangeError(
      "eligible or selected runtime candidate must not have a failure"
    );
  }
  if (report.outcome === "rejected" && report.failure === null) {
    throw new RangeError("rejected runtime candidate must have a failure");
  }

  return Object.freeze({
    rendition: report.rendition,
    rank: report.rank,
    outcome: report.outcome,
    failure: report.failure === null
      ? null
      : normalizeRuntimeFailure(
          report.failure.code,
          report.failure.message,
          report.failure.context
        )
  });
}

export function createRuntimeReadinessReport(
  report: RuntimeReadinessReport
): Readonly<RuntimeReadinessReport> {
  return Object.freeze({
    readiness: report.readiness,
    selectedRendition: report.selectedRendition,
    candidates: Object.freeze(
      report.candidates.map((candidate) =>
        createRuntimeCandidateReport(candidate)
      )
    )
  });
}

/** Stable authored identity. Equal pixels never merge different keys. */
export interface RuntimeFrameKey {
  readonly rendition: string;
  readonly unit: string;
  readonly localFrame: number;
}

export type RuntimeMediaPresentation =
  | {
      readonly kind: "static";
      readonly state: string;
      readonly staticFrame: string;
      readonly drawSource: "static";
    }
  | {
      readonly kind: "frame";
      readonly graphKind: Exclude<GraphPresentation["kind"], "static">;
      readonly state: string | null;
      readonly edge: string | null;
      readonly path: string;
      readonly frame: Readonly<RuntimeFrameKey>;
      readonly drawSource: "resident" | "streaming";
      readonly generation: number;
      readonly unitInstance: number;
      readonly decodeOrdinal: number;
      readonly timestamp: number;
      readonly intendedPresentationOrdinal: bigint;
    };

export interface RuntimeMediaCursor {
  readonly path: string;
  readonly unit: string;
  readonly unitInstance: number;
  readonly localFrame: number;
}

export interface RuntimeSchedulerSnapshot {
  readonly generation: number | null;
  readonly activePath: string | null;
  readonly sourceCursor: Readonly<RuntimeMediaCursor> | null;
  readonly submittedCursor: Readonly<RuntimeMediaCursor> | null;
  readonly decodedCursor: Readonly<RuntimeMediaCursor> | null;
  readonly displayedCursor: Readonly<RuntimeMediaCursor> | null;
  readonly ringSize: number;
  readonly ringCapacity: number;
  readonly smoothSession: boolean;
}

export interface RuntimeGraphTrace {
  readonly operation: MotionGraphOperation;
  readonly snapshot: Readonly<MotionGraphSnapshot>;
  readonly presentation: Readonly<GraphPresentation> | null;
  readonly effects: readonly Readonly<MotionGraphEffect>[];
}

export interface RuntimeTraceCounters {
  readonly underflows: number;
  readonly fallbacks: number;
  readonly settledRequests: number;
  readonly cleanedFrames: number;
}

/**
 * One bounded operation/content-tick record. Resource handles, payload bytes,
 * and VideoFrame objects deliberately have no field in this contract.
 */
export interface RuntimeTraceRecord {
  readonly index: number;
  readonly kind:
    | "operation"
    | "content-tick"
    | "readiness"
    | "fallback"
    | "cleanup";
  readonly presentationOrdinal: bigint | null;
  readonly rationalDeadlineUs: number | null;
  readonly graph: Readonly<RuntimeGraphTrace> | null;
  readonly routeReady: boolean | null;
  readonly selectedBoundary: string | null;
  readonly scheduler: Readonly<RuntimeSchedulerSnapshot>;
  readonly submitted: readonly Readonly<RuntimeMediaCursor>[];
  readonly media: Readonly<RuntimeMediaPresentation> | null;
  readonly readbackTag: string | null;
  readonly readiness: RuntimeReadiness;
  readonly decodeLeadFrames: number | null;
  readonly settledRequestIds: readonly number[];
  readonly counters: Readonly<RuntimeTraceCounters>;
}

export interface StaticReasonSummaryInput {
  readonly phase: "preparation" | "recovery";
  /** False means failStatic: no successful static result may be summarized. */
  readonly staticReady: boolean;
  readonly deadlineExpired: boolean;
  readonly hasOpaqueRendition: boolean;
  readonly workerAvailable: boolean;
  readonly rendererAvailable: boolean;
  readonly candidateFailures: readonly Readonly<RuntimeFailure>[];
}

/**
 * Deterministic summary precedence from the M5.5 design. `null` means the
 * static installation is incomplete and the caller must enter terminal error.
 */
export function summarizeStaticReason(
  input: StaticReasonSummaryInput
): StaticReason | null {
  if (!input.staticReady) {
    return null;
  }
  if (input.phase === "recovery") {
    return "animation-failure";
  }
  if (input.deadlineExpired) {
    return "preparation-timeout";
  }
  if (!input.hasOpaqueRendition) {
    return "no-opaque-rendition";
  }
  if (!input.workerAvailable) {
    return "worker-unavailable";
  }
  if (!input.rendererAvailable) {
    return "renderer-unavailable";
  }
  if (allFailuresAre(input.candidateFailures, "unsupported-profile")) {
    return "codec-unsupported";
  }
  if (allFailuresAre(input.candidateFailures, "resource-rejection")) {
    return "resource-budget";
  }
  return "readiness-failed";
}

function allFailuresAre(
  failures: readonly Readonly<RuntimeFailure>[],
  code: RuntimeFailure["code"]
): boolean {
  return failures.length > 0 &&
    failures.every((failure) => failure.code === code);
}
