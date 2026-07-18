export const AVAL_TAG_NAME = "aval-player" as const;
export const AVAL_ELEMENT_API_MAJOR = 1 as const;

export type AvalAutoplay = "visible" | "manual";
export type AvalBindings = "auto" | "none";
export type AvalCrossOrigin = "anonymous" | "use-credentials";
export type AvalFit = "contain" | "cover" | "fill" | "none";
export type AvalMotion = "auto" | "reduce" | "full";
export type AvalMode = "animated" | "static" | null;

export type BindingSource =
  | "activate"
  | "engagement.off"
  | "engagement.on"
  | "focus.in"
  | "focus.out"
  | "hidden"
  | "pointer.enter"
  | "pointer.leave"
  | "visible";

export interface Binding {
  readonly source: BindingSource;
  readonly event: string;
}

export type RuntimeReadiness =
  | "unready"
  | "metadataReady"
  | "visualReady"
  | "interactiveReady"
  | "staticReady"
  | "disposed"
  | "error";

export type StaticReason =
  | "reduced-motion"
  | "visibility-suspended"
  | "decoder-queued";

export type RuntimeFailureCode =
  | "invalid-asset"
  | "load-failure"
  | "range-response-invalid"
  | "entity-changed"
  | "integrity-mismatch"
  | "unsupported-profile"
  | "resource-rejection"
  | "readiness-failure"
  | "worker-decode-failure"
  | "renderer-failure"
  | "context-loss"
  | "watchdog-timeout"
  | "underflow"
  | "abort"
  | "disposed";

interface RuntimeFailureContext {
  readonly rendition?: string;
  readonly profile?: string;
  readonly codec?: string;
  readonly unit?: string;
  readonly state?: string;
  readonly edge?: string;
  readonly path?: string;
  readonly operation?: string;
  readonly sourceCode?: string;
  readonly sourcePath?: string;
  readonly alphaStatistic?: string;
  readonly policyPhase?: string;
  readonly lifecyclePhase?: string;
  readonly offset?: number;
  readonly width?: number;
  readonly height?: number;
  readonly generation?: number;
  readonly ordinal?: number;
  readonly decodeIndex?: number;
  readonly localFrame?: number;
  readonly rank?: number;
  readonly requestOrdinal?: number;
  readonly httpStatus?: number;
  readonly expectedBytes?: number;
  readonly observedBytes?: number;
  readonly declaredTotalBytes?: number;
  readonly playerBytes?: number;
  readonly pageBytes?: number;
}

interface RuntimeFailure {
  readonly code: RuntimeFailureCode;
  readonly message: string;
  readonly context: Readonly<RuntimeFailureContext>;
}

interface RuntimeCandidateReport {
  readonly rendition: string;
  readonly rank: number;
  readonly outcome: "eligible" | "selected" | "rejected";
  readonly failure: Readonly<RuntimeFailure> | null;
}

interface RuntimeReadinessReport {
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

export interface AvalSourceCandidate {
  readonly src: string;
  readonly type: `application/vnd.aval; codecs="${string}"`;
  readonly codec: string;
  readonly integrity: string;
}

export interface AvalPrepareOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface AvalPublicFailure {
  readonly code: RuntimeFailureCode | AvalElementFailureCode;
  readonly message: string;
  readonly operation: string | null;
}

export type AvalElementFailureCode =
  | "invalid-configuration"
  | "unsupported-browser"
  | "interaction-target-unavailable"
  | "element-cleanup-incomplete";

export interface AvalReadinessChangeDetail {
  readonly generation: number;
  readonly from: RuntimeReadiness;
  readonly to: RuntimeReadiness;
  readonly reason?: StaticReason;
}

export interface AvalRequestedStateChangeDetail {
  readonly generation: number;
  readonly from: string;
  readonly to: string;
  readonly sequence: number;
}

export interface AvalVisualStateChangeDetail {
  readonly generation: number;
  readonly from: string;
  readonly to: string;
}

export interface AvalTransitionDetail {
  readonly generation: number;
  readonly edge: string;
  readonly from: string;
  readonly to: string;
  readonly sequence?: number;
}

export interface AvalUnderflowDetail {
  readonly generation: number;
  readonly incident: number;
  readonly heldPresentationOrdinal: string;
  readonly cumulativeCount: number;
}

export interface AvalErrorDetail {
  readonly generation: number;
  readonly failure: Readonly<AvalPublicFailure>;
  readonly fatal: boolean;
}

export interface AvalElementEventMap {
  readonly readinesschange: CustomEvent<Readonly<AvalReadinessChangeDetail>>;
  readonly requestedstatechange: CustomEvent<Readonly<AvalRequestedStateChangeDetail>>;
  readonly visualstatechange: CustomEvent<Readonly<AvalVisualStateChangeDetail>>;
  readonly transitionstart: CustomEvent<Readonly<AvalTransitionDetail>>;
  readonly transitionend: CustomEvent<Readonly<AvalTransitionDetail>>;
  readonly underflow: CustomEvent<Readonly<AvalUnderflowDetail>>;
  readonly error: CustomEvent<Readonly<AvalErrorDetail>>;
}

export interface AvalTraceRecord {
  readonly index: number;
  readonly kind: string;
  readonly generation: number;
}

export interface AvalRuntimeMediaCursor {
  readonly path: string;
  readonly unit: string;
  readonly unitInstance: number;
  readonly localFrame: number;
}

export interface AvalRuntimeTraceRecord {
  readonly index: number;
  readonly kind: "operation" | "content-tick" | "readiness" | "cleanup";
  readonly presentationOrdinal: string | null;
  readonly rationalDeadlineUs: number | null;
  readonly callbackStartMicroseconds: number | null;
  readonly canvasSubmissionCompleteMicroseconds: number | null;
  readonly eligibleAnimationFrameOrdinal: number | null;
  readonly graph: Readonly<{
    readonly operation: string;
    readonly snapshot: Readonly<Record<string, unknown>>;
    readonly presentation: Readonly<Record<string, unknown>> | null;
    readonly effects: readonly Readonly<Record<string, unknown>>[];
  }> | null;
  readonly routeReady: boolean | null;
  readonly selectedBoundary: string | null;
  readonly scheduler: Readonly<{
    readonly generation: number | null;
    readonly activePath: string | null;
    readonly sourceCursor: Readonly<AvalRuntimeMediaCursor> | null;
    readonly submittedCursor: Readonly<AvalRuntimeMediaCursor> | null;
    readonly decodedCursor: Readonly<AvalRuntimeMediaCursor> | null;
    readonly displayedCursor: Readonly<AvalRuntimeMediaCursor> | null;
    readonly ringSize: number;
    readonly ringCapacity: number;
    readonly smoothSession: boolean;
  }>;
  readonly submitted: readonly Readonly<AvalRuntimeMediaCursor>[];
  readonly media: Readonly<Record<string, unknown>> | null;
  readonly readbackTag: string | null;
  readonly readiness: RuntimeReadiness;
  readonly decodeLeadFrames: number | null;
  readonly settledRequestIds: readonly number[];
  readonly counters: Readonly<{
    readonly underflows: number;
    readonly settledRequests: number;
    readonly cleanedFrames: number;
  }>;
}

export interface AvalDiagnosticsCounters {
  readonly prepare: number;
  readonly sourceReplacement: number;
  readonly pause: number;
  readonly resume: number;
  readonly underflow: number;
  readonly contextRecovery: number;
  readonly cleanup: number;
}

/**
 * Immutable terminal ownership proof for the most recently retired source.
 * Participant-scoped fields must reach zero even when other elements still
 * share the page runtime; page-scoped totals are therefore reported
 * separately.
 */
export interface AvalCleanupReceipt {
  readonly elementGeneration: number;
  readonly sourceGeneration: number;
  readonly completed: boolean;
  readonly failureCount: number;
  readonly playerDisposed: boolean;
  readonly participantDisposed: boolean;
  readonly participantRegistered: boolean;
  readonly participantLogicalBytes: number;
  readonly participantActiveLeaseCount: number;
  readonly participantRegisteredCleanupCount: number;
  readonly participantTrackedWorkCount: number;
  readonly participantPendingWaitCount: number;
  readonly participantDecoderTicketCount: number;
  readonly participantDecoderState: string | null;
  readonly workerCount: number;
  readonly openFrames: number;
  readonly pendingRuntimeOperations: number;
  readonly sourceCopiesInFlight: number;
  readonly rendererStagingBytes: number;
  readonly pendingLoads: number;
  readonly activeTransportBodies: number;
  readonly interestedWaiters: number;
  readonly rendererResourceCount: number;
  readonly contextListenerCount: number;
  readonly stalePublicationCount: number;
  readonly pagePhysicalBytes: number;
  readonly pageParticipantCount: number;
  readonly pageActiveDecoderSlotCount: number;
  readonly pageQueuedDecoderTicketCount: number;
  readonly pageParkedDecoderTicketCount: number;
}

export interface AvalElementOwnershipSnapshot {
  readonly listenerCount: number;
  readonly observerCount: number;
  readonly brokerSubscriptionCount: number;
  readonly timerCount: number;
  readonly pendingCommandCount: number;
  readonly failedReleaseCount: number;
  readonly retainedRetryCount: number;
  readonly releaseFailureCount: number;
  readonly completed: boolean;
}

export interface AvalTerminalCleanupProof {
  readonly completed: boolean;
  readonly sourceCleanupCompleted: boolean;
  readonly elementOwnership: Readonly<AvalElementOwnershipSnapshot>;
}

export interface AvalDiagnostics {
  readonly elementGeneration: number;
  readonly sourceGeneration: number;
  readonly inputGeneration: number;
  readonly motionGeneration: number;
  readonly visibilityGeneration: number;
  readonly resizeGeneration: number;
  readonly connected: boolean;
  readonly finalDisposed: boolean;
  readonly readiness: RuntimeReadiness;
  readonly mode: AvalMode;
  readonly assurance: "best-effort" | null;
  readonly staticReason: StaticReason | null;
  readonly requestedState: string | null;
  readonly visualState: string | null;
  readonly isTransitioning: boolean;
  readonly paused: boolean;
  readonly effectivelyVisible: boolean;
  readonly stateNames: readonly string[];
  readonly eventNames: readonly string[];
  readonly inputBindings: readonly Readonly<Binding>[];
  readonly configuredMotion: AvalMotion;
  readonly hostReducedMotion: boolean | null;
  readonly autoplay: AvalAutoplay;
  readonly fit: AvalFit | null;
  readonly lastFailure: Readonly<AvalPublicFailure> | null;
  readonly counters: Readonly<AvalDiagnosticsCounters>;
  readonly cleanup: Readonly<AvalCleanupReceipt> | null;
  readonly elementOwnership: Readonly<AvalElementOwnershipSnapshot>;
  readonly terminalCleanup: Readonly<AvalTerminalCleanupProof> | null;
  readonly outstanding: Readonly<Record<string, number>>;
  readonly runtime: Readonly<{
    selectedRendition: string | null;
    selectedCodec: string | null;
    selectedBitDepth: 8 | 10 | null;
    transportMode: "range" | "full" | null;
    declaredFileBytes: number;
    metadataBytes: number;
    verifiedBytes: number;
    residentBlobBytes: number;
    activeTransportBodies: number;
    pendingLoads: number;
    interestedWaiters: number;
    stalePublicationCount: number;
    playerTrackedBytes: number;
    pagePhysicalBytes: number;
    activeLeaseCount: number;
    decoderLeaseState: string | null;
    pageActiveDecoderSlotCount: number;
    pageQueuedDecoderTicketCount: number;
    pageParkedDecoderTicketCount: number;
    pageParticipantCount: number;
    reclamationCount: number;
    contextLossCount: number;
    contextRecoveryCount: number;
    cleanupFailureCount: number;
  }>;
  readonly motion: Readonly<{
    configured: AvalMotion;
    hostReducedMotion: boolean | null;
    effective: "reduce" | "full";
    actual: string | null;
  }>;
  readonly playIntent: Readonly<{
    autoplay: AvalAutoplay;
    manualPlaying: boolean;
    paused: boolean;
  }>;
  readonly visibility: Readonly<{
    documentVisible: boolean;
    intersecting: boolean;
    positiveBox: boolean;
    effectivelyVisible: boolean;
    observerSupported: boolean;
    runtimeVisibility: "visible" | "hidden" | null;
    runtimeSuspension: "active" | "suspending" | "suspended" | null;
    rebuildPending: boolean;
  }>;
  readonly presentation: Readonly<{
    fit: AvalFit | null;
    cssWidth: number;
    cssHeight: number;
    backingWidth: number;
    backingHeight: number;
    effectiveDprX: number;
    effectiveDprY: number;
    resolutionScale: number;
    clampReasons: readonly string[];
  }>;
  readonly elementTrace?: readonly Readonly<AvalTraceRecord>[];
  readonly runtimeTrace?: readonly Readonly<AvalRuntimeTraceRecord>[];
}

export interface AvalElementAttributes {
  readonly crossorigin?: AvalCrossOrigin | "";
  readonly motion?: AvalMotion;
  readonly autoplay?: AvalAutoplay;
  readonly fit?: AvalFit;
  readonly bindings?: AvalBindings;
  readonly state?: string;
  readonly "interaction-for"?: string;
  readonly width?: number | `${number}`;
  readonly height?: number | `${number}`;
}

export interface AvalElement extends HTMLElement {
  crossOrigin: AvalCrossOrigin;
  motion: AvalMotion;
  autoplay: AvalAutoplay;
  fit: AvalFit | null;
  bindings: AvalBindings;
  state: string | null;
  interactionFor: string;
  interactionTarget: Element | null;
  width: number | null;
  height: number | null;

  readonly readiness: RuntimeReadiness;
  readonly mode: AvalMode;
  readonly assurance: "best-effort" | null;
  readonly staticReason: StaticReason | null;
  readonly requestedState: string | null;
  readonly visualState: string | null;
  readonly isTransitioning: boolean;
  readonly paused: boolean;
  readonly effectivelyVisible: boolean;
  readonly stateNames: readonly string[];
  readonly eventNames: readonly string[];
  readonly inputBindings: readonly Readonly<Binding>[];

  prepare(options?: Readonly<AvalPrepareOptions>): Promise<RuntimeReadinessResult>;
  setState(name: string): Promise<void>;
  send(event: string): boolean;
  readyFor(state: string): boolean;
  pause(): void;
  resume(): Promise<void>;
  getDiagnostics(options?: Readonly<{ readonly trace?: boolean }>): Readonly<AvalDiagnostics>;
  dispose(): Promise<void>;

  addEventListener<K extends keyof AvalElementEventMap>(
    type: K,
    listener: (this: AvalElement, event: AvalElementEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions
  ): void;
  addEventListener<K extends keyof HTMLElementEventMap>(
    type: K,
    listener: (this: HTMLElement, event: HTMLElementEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ): void;
  removeEventListener<K extends keyof AvalElementEventMap>(
    type: K,
    listener: (this: AvalElement, event: AvalElementEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions
  ): void;
  removeEventListener<K extends keyof HTMLElementEventMap>(
    type: K,
    listener: (this: HTMLElement, event: HTMLElementEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions
  ): void;
}

export type AvalElementConstructor = CustomElementConstructor & {
  readonly prototype: AvalElement;
};

declare global {
  interface HTMLElementTagNameMap {
    "aval-player": AvalElement;
  }
}
