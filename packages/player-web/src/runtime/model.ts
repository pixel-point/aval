import {
  MOTION_GRAPH_STATIC_REASONS
} from "@pixel-point/aval-graph";
import type {
  MotionGraphStaticReason,
  GraphPresentation,
  MotionGraphEffect,
  MotionGraphOperation,
  MotionGraphReadiness,
  MotionGraphSnapshot
} from "@pixel-point/aval-graph";

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

/** Alias of the graph-owned policy vocabulary; player-web adds no reasons. */
export const STATIC_REASONS = MOTION_GRAPH_STATIC_REASONS;

export type StaticReason = MotionGraphStaticReason;

export type StaticReasonClassification = "transient" | "sticky";

/** The only reasons that may automatically attempt fresh animation readiness. */
export const TRANSIENT_STATIC_REASONS = Object.freeze([
  "visibility-suspended",
  "decoder-queued"
] as const satisfies readonly StaticReason[]);

export const STATIC_REASON_CLASSIFICATIONS: Readonly<
  Record<StaticReason, StaticReasonClassification>
> = Object.freeze({
  "reduced-motion": "sticky",
  "visibility-suspended": "transient",
  "decoder-queued": "transient"
});

export function isTransientStaticReason(reason: StaticReason): boolean {
  return STATIC_REASON_CLASSIFICATIONS[reason] === "transient";
}

/** Closed host-controlled asset request. Transport details are not overridable. */
export interface RuntimeAssetRequest {
  readonly url: string | URL;
  readonly integrity?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly credentials?: "omit" | "same-origin" | "include";
}

/** Fully normalized finite loader bounds used by one asset generation. */
export interface RuntimeLoaderPolicy {
  readonly maximumFileBytes: number;
  readonly maximumRangeBytes: number;
  readonly maximumConcurrentPayloadBodies: number;
  readonly overallTimeoutMs: number;
  readonly firstByteTimeoutMs: number;
  readonly idleBodyTimeoutMs: number;
}

export const RUNTIME_TRANSPORT_MODES = Object.freeze([
  "range",
  "full"
] as const);

export type RuntimeTransportMode = (typeof RUNTIME_TRANSPORT_MODES)[number];

/** Internal identity for bytes that may be assembled into one asset generation. */
export type RuntimeEntityIdentity =
  | {
      readonly mode: "range";
      readonly generation: number;
      readonly finalUrl: string;
      readonly declaredTotalBytes: number;
      readonly strongEntityTag: string;
    }
  | {
      readonly mode: "full";
      readonly generation: number;
      readonly finalUrl: string;
      readonly declaredTotalBytes: number;
      readonly strongEntityTag: string | null;
    };

export const RUNTIME_BLOB_RESIDENCY_STATES = Object.freeze([
  "absent",
  "loading",
  "verified"
] as const);

export type RuntimeBlobResidencyState =
  (typeof RUNTIME_BLOB_RESIDENCY_STATES)[number];

export interface RuntimeBlobResidencySnapshot {
  readonly total: number;
  readonly absent: number;
  readonly loading: number;
  readonly verified: number;
  readonly verifiedBytes: number;
}

/** Sanitized catalog observation: it deliberately carries no URL or ETag. */
export interface RuntimeAssetResidencySnapshot {
  readonly generation: number;
  readonly mode: RuntimeTransportMode;
  readonly declaredFileBytes: number;
  readonly metadataBytes: number;
  readonly verifiedPayloadBytes: number;
  readonly unitBlobs: Readonly<RuntimeBlobResidencySnapshot>;
}

export const RUNTIME_BYTE_CATEGORIES = Object.freeze([
  "asset-metadata",
  "asset-full",
  "response-body",
  "quarantine",
  "blob-assembly",
  "verified-unit",
  "worker-transfer",
  "decoder-output",
  "persistent-animation",
  "streaming-texture",
  "frame-staging",
  "animated-canvas-backing",
] as const);

export type RuntimeByteCategory = (typeof RUNTIME_BYTE_CATEGORIES)[number];

declare const participantIdBrand: unique symbol;
declare const byteLeaseIdBrand: unique symbol;
declare const decoderTicketIdBrand: unique symbol;
declare const decoderLeaseIdBrand: unique symbol;
declare const reclamationTokenBrand: unique symbol;
declare const runtimeByteLeaseBrand: unique symbol;
declare const runtimeDecoderTicketBrand: unique symbol;
declare const runtimeDecoderLeaseBrand: unique symbol;

export type RuntimeParticipantId = number & {
  readonly [participantIdBrand]: true;
};
export type RuntimeByteLeaseId = number & {
  readonly [byteLeaseIdBrand]: true;
};
export type RuntimeDecoderTicketId = number & {
  readonly [decoderTicketIdBrand]: true;
};
export type RuntimeDecoderLeaseId = number & {
  readonly [decoderLeaseIdBrand]: true;
};
export type RuntimeReclamationToken = number & {
  readonly [reclamationTokenBrand]: true;
};

export interface RuntimePageResourcePolicyInput {
  readonly maximumDecoderLeases?: number;
  readonly maximumPagePhysicalBytes?: number;
  readonly maximumPlayerLogicalBytes?: number;
  readonly allowUncertifiedHigherLimits?: boolean;
}

export interface RuntimePageResourcePolicy {
  readonly maximumDecoderLeases: number;
  readonly maximumPagePhysicalBytes: number;
  readonly maximumPlayerLogicalBytes: number;
  readonly referenceProfile: boolean;
}

export type RuntimeParticipantVisibility = "visible" | "hidden";
export type RuntimeParticipantPhase =
  | "loading"
  | "preparing"
  | "animated"
  | "static"
  | "suspended";

export interface RuntimeCategoryBytesSnapshot {
  readonly category: RuntimeByteCategory;
  readonly bytes: number;
}

export interface RuntimeParticipantState {
  readonly id: RuntimeParticipantId;
  readonly generation: number;
  readonly visibility: RuntimeParticipantVisibility;
  readonly phase: RuntimeParticipantPhase;
  readonly lastTouchSequence: number;
  readonly logicalBytes: number;
  readonly reclaimable: readonly Readonly<RuntimeCategoryBytesSnapshot>[];
}

export interface RuntimeByteLeaseSnapshot {
  readonly id: RuntimeByteLeaseId;
  readonly participantId: RuntimeParticipantId;
  readonly category: RuntimeByteCategory;
  readonly bytes: number;
  readonly released: boolean;
}

/** Manager-issued byte ownership; hosts cannot construct a valid lease. */
export interface RuntimeByteLease {
  readonly [runtimeByteLeaseBrand]: true;
  snapshot(): Readonly<RuntimeByteLeaseSnapshot>;
  resize(nextBytes: number): Promise<void>;
  release(): void;
}

export type RuntimeDecoderTicketState =
  | "queued"
  | "parked"
  | "granted"
  | "cancelled";

export interface RuntimeDecoderTicketSnapshot {
  readonly id: RuntimeDecoderTicketId;
  readonly participantId: RuntimeParticipantId;
  readonly generation: number;
  readonly ordinal: number;
  readonly state: RuntimeDecoderTicketState;
}

export interface RuntimeDecoderLeaseSnapshot {
  readonly id: RuntimeDecoderLeaseId;
  readonly participantId: RuntimeParticipantId;
  readonly generation: number;
  readonly released: boolean;
}

export interface RuntimeDecoderTicket {
  readonly [runtimeDecoderTicketBrand]: true;
  snapshot(): Readonly<RuntimeDecoderTicketSnapshot>;
  wait(): Promise<RuntimeDecoderLease>;
  cancel(): void;
}

export interface RuntimeDecoderLease {
  readonly [runtimeDecoderLeaseBrand]: true;
  snapshot(): Readonly<RuntimeDecoderLeaseSnapshot>;
  release(): void;
}

export type RuntimeReclamationReason =
  | "abandoned-animation"
  | "hidden-animation"
  | "optional-cache"
  | "requester-fallback"
  | "policy-reduction"
  | "participant-disposal";

export interface RuntimeReclamationRequest {
  readonly token: RuntimeReclamationToken;
  readonly participantId: RuntimeParticipantId;
  readonly generation: number;
  readonly reason: RuntimeReclamationReason;
  readonly requestedBytes: number;
}

export interface RuntimeReclamationResult {
  readonly token: RuntimeReclamationToken;
  readonly releasedBytes: number;
  readonly covered: boolean;
}

export interface RuntimePageResourceSnapshot {
  readonly policy: Readonly<RuntimePageResourcePolicy>;
  readonly physicalBytes: number;
  readonly byteLeaseCount: number;
  readonly decoderLeaseCount: number;
  readonly decoderQueueLength: number;
  readonly pendingReclamations: number;
  readonly touchSequence: number;
  readonly categories: readonly Readonly<RuntimeCategoryBytesSnapshot>[];
  readonly participants: readonly Readonly<RuntimeParticipantState>[];
}

export type RuntimeVisibilityState = "visible" | "hidden";
export type RuntimeSuspensionState = "active" | "suspending" | "suspended";

export interface RuntimeVisibilitySnapshot {
  readonly generation: number;
  readonly visibility: RuntimeVisibilityState;
  readonly suspension: RuntimeSuspensionState;
  readonly frozenPresentationOrdinal: bigint | null;
  readonly rebuildPending: boolean;
}

export type RuntimeContextRecoveryPhase =
  | "stable"
  | "lost"
  | "restoring"
  | "static"
  | "disposed";

export interface RuntimeContextRecoverySnapshot {
  readonly generation: number;
  readonly phase: RuntimeContextRecoveryPhase;
  readonly lossCount: number;
  readonly recoveryCount: number;
  readonly staticCoverVisible: boolean;
}

export type RuntimeLoaderPhase =
  | "initial-range"
  | "front-index"
  | "payload-range"
  | "full-fallback"
  | "external-integrity"
  | "disposed";

export interface RuntimeLoaderDiagnosticSnapshot {
  readonly generation: number;
  readonly phase: RuntimeLoaderPhase;
  readonly requestCount: number;
  readonly activeBodyCount: number;
  readonly retainedBytes: number;
  readonly verifiedBytes: number;
  readonly failure: Readonly<RuntimeFailure> | null;
}

export interface RuntimeResourceDiagnosticSnapshot {
  readonly generation: number;
  readonly playerBytes: number;
  readonly pageBytes: number;
  readonly byteLeaseCount: number;
  readonly decoderLeaseCount: number;
  readonly pendingReclamations: number;
  readonly failure: Readonly<RuntimeFailure> | null;
}

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
      readonly drawSource: "state";
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

export type RuntimeGraphEffect = MotionGraphEffect;

export interface RuntimeGraphTrace {
  readonly operation: MotionGraphOperation;
  readonly snapshot: Readonly<MotionGraphSnapshot>;
  readonly presentation: Readonly<GraphPresentation> | null;
  readonly effects: readonly Readonly<RuntimeGraphEffect>[];
}

export interface RuntimeTraceCounters {
  readonly underflows: number;
  readonly staticTransitions: number;
  readonly settledRequests: number;
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
    | "static-transition"
    | "cleanup";
  readonly presentationOrdinal: bigint | null;
  readonly rationalDeadlineUs: number | null;
  /** Monotonic host-clock time at entry to the eligible animation-frame callback. */
  readonly callbackStartMicroseconds: number | null;
  /**
   * First safe host-clock observation after canvas submission and semantic
   * commit. This is a conservative upper bound, not a display/scan-out time.
   */
  readonly canvasSubmissionCompleteMicroseconds: number | null;
  /** One-based animation-frame callback ordinal that made this content tick eligible. */
  readonly eligibleAnimationFrameOrdinal: number | null;
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
