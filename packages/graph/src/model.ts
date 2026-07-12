export type GraphStateId = string;
export type GraphEdgeId = string;
export type GraphUnitId = string;

export interface GraphPortDefinition {
  readonly id: string;
  readonly entryFrame: 0;
  readonly portalFrames: readonly number[];
}

export type GraphBodyKind = "loop" | "finite" | "held";

export interface GraphBodyDefinition {
  readonly unitId: GraphUnitId;
  readonly kind: GraphBodyKind;
  readonly frameCount: number;
  readonly ports: readonly GraphPortDefinition[];
}

export interface GraphInitialUnitDefinition {
  readonly unitId: GraphUnitId;
  readonly frameCount: number;
}

export interface GraphStateDefinition {
  readonly id: GraphStateId;
  readonly staticFrameId: string;
  readonly body: GraphBodyDefinition;
  readonly initialUnit?: GraphInitialUnitDefinition;
}

export type GraphStartPolicy =
  | {
      readonly type: "portal";
      readonly sourcePort: string;
      readonly targetPort: string;
      readonly maxWaitFrames: number;
    }
  | {
      readonly type: "finish";
      readonly targetPort: string;
      readonly maxWaitFrames: number;
    }
  | {
      readonly type: "cut";
      readonly targetPort: string;
      readonly maxWaitFrames: 1;
    };

export type GraphTransitionDefinition =
  | {
      readonly kind: "locked";
      readonly unitId: GraphUnitId;
      readonly frameCount: number;
    }
  | {
      readonly kind: "reversible";
      readonly unitId: GraphUnitId;
      readonly frameCount: number;
      readonly direction: "forward" | "reverse";
      readonly reverseOf?: GraphEdgeId;
    };

export type GraphEdgeTrigger =
  | { readonly type: "event"; readonly name: string }
  | { readonly type: "completion" };

export type GraphContinuity = "exact-authored" | "exact-reverse" | "cut";

export interface GraphEdgeDefinition {
  readonly id: GraphEdgeId;
  readonly from: GraphStateId;
  readonly to: GraphStateId;
  readonly trigger?: GraphEdgeTrigger;
  readonly start: GraphStartPolicy;
  readonly transition?: GraphTransitionDefinition;
  readonly continuity: GraphContinuity;
}

export interface MotionGraphDefinition {
  readonly initialState: GraphStateId;
  readonly states: readonly GraphStateDefinition[];
  readonly edges: readonly GraphEdgeDefinition[];
}

declare const validatedMotionGraphBrand: unique symbol;

export interface ValidatedMotionGraph {
  readonly definition: Readonly<MotionGraphDefinition>;
  readonly [validatedMotionGraphBrand]: true;
}

export type MotionGraphReadiness =
  | "unready"
  | "preparing"
  | "animated"
  | "static"
  | "disposed"
  | "error";

export type MotionGraphPhase =
  | "unready"
  | "preparing"
  | "intro"
  | "stable"
  | "waiting"
  | "locked"
  | "reversible"
  | "static"
  | "disposed"
  | "error";

export type GraphPresentation =
  | {
      readonly kind: "static";
      readonly state: GraphStateId;
      readonly staticFrameId: string;
    }
  | {
      readonly kind: "intro";
      readonly state: GraphStateId;
      readonly unitId: GraphUnitId;
      readonly frameIndex: number;
    }
  | {
      readonly kind: "body";
      readonly state: GraphStateId;
      readonly unitId: GraphUnitId;
      readonly frameIndex: number;
    }
  | {
      readonly kind: "locked";
      readonly edgeId: GraphEdgeId;
      readonly unitId: GraphUnitId;
      readonly frameIndex: number;
    }
  | {
      readonly kind: "reversible";
      readonly edgeId: GraphEdgeId;
      readonly unitId: GraphUnitId;
      readonly frameIndex: number;
      readonly direction: "forward" | "reverse";
    };

export type GraphSettlementError =
  | "NotReadyError"
  | "RouteError"
  | "InputOverflowError"
  | "AbortError"
  | "PlaybackFallbackError";

export type GraphSettlement =
  | {
      readonly type: "resolve";
      readonly timing: "microtask";
      readonly reason: "stable-noop" | "target-committed" | "static-recovery";
    }
  | {
      readonly type: "reject";
      readonly timing: "microtask";
      readonly error: GraphSettlementError;
    };

export type MotionGraphEffect =
  | {
      readonly type: "readinesschange";
      readonly from: MotionGraphReadiness;
      readonly to: MotionGraphReadiness;
      readonly reason?: string;
    }
  | {
      readonly type: "requestedstatechange";
      readonly from: GraphStateId;
      readonly to: GraphStateId;
      readonly sequence: number;
    }
  | {
      readonly type: "transitionstart";
      readonly edgeId: GraphEdgeId;
      readonly from: GraphStateId;
      readonly to: GraphStateId;
      readonly sequence: number;
    }
  | {
      readonly type: "visualstatechange";
      readonly from: GraphStateId;
      readonly to: GraphStateId;
    }
  | {
      readonly type: "transitionend";
      readonly edgeId: GraphEdgeId;
      readonly from: GraphStateId;
      readonly to: GraphStateId;
    }
  | {
      readonly type: "fallback";
      readonly reason: string;
    }
  | {
      readonly type: "settle";
      readonly requestIds: readonly number[];
      readonly outcome: GraphSettlement;
    };

export interface MotionGraphSnapshot {
  readonly readiness: MotionGraphReadiness;
  readonly phase: MotionGraphPhase;
  readonly requestedState: GraphStateId | null;
  readonly visualState: GraphStateId | null;
  readonly prospectiveState: GraphStateId | null;
  readonly isTransitioning: boolean;
  readonly presentation: Readonly<GraphPresentation> | null;
  readonly pendingEdgeId: GraphEdgeId | null;
  readonly activeEdgeId: GraphEdgeId | null;
  readonly followOnEdgeId: GraphEdgeId | null;
  readonly direction: "forward" | "reverse" | null;
  readonly contentOrdinal: bigint | null;
  readonly inputSequence: number;
  readonly pendingRequestCount: number;
  readonly inputsSinceTick: number;
  readonly routeOperationsLastTick: number;
}

export type MotionGraphOperation =
  | "install"
  | "begin-animated"
  | "begin-static"
  | "recover-static"
  | "fail-static"
  | "request"
  | "send"
  | "tick"
  | "dispose";

export interface MotionGraphResult {
  readonly operation: MotionGraphOperation;
  readonly accepted?: boolean;
  readonly joined?: boolean;
  readonly sequence?: number;
  readonly requestId?: number;
  readonly presentation: Readonly<GraphPresentation> | null;
  readonly effects: readonly Readonly<MotionGraphEffect>[];
  readonly snapshot: Readonly<MotionGraphSnapshot>;
}

export interface MotionGraphTickOptions {
  readonly contentOrdinal: bigint;
  readonly routeReady?: boolean;
}

/** Host-supplied last successful draw identity for a failed presentation. */
export interface MotionGraphStaticFailureOptions {
  readonly retainedVisualState?: GraphStateId;
}

/** Last pixels actually drawn when an animated graph tick failed mid-barrier. */
export interface MotionGraphRecoveryOptions {
  readonly retainedVisualState?: GraphStateId;
}

/** Host-supplied last successful draw identity for terminal disposal. */
export interface MotionGraphDisposeOptions {
  readonly retainedVisualState?: GraphStateId;
}

export interface MotionGraphTraceRecord {
  readonly index: number;
  readonly result: Readonly<MotionGraphResult>;
}
