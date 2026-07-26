import type { BrowserRuntimePlayerSnapshot } from "./browser-runtime-factory.js";
import { createElementDiagnostics } from "./diagnostics.js";
import type { ElementConfiguration } from "./element-configuration.js";
import type { ElementDesiredSnapshot } from "./element-desired-state.js";
import type { ElementPublicState } from "./element-public-state.js";
import type { ElementOwnershipLedger } from "./element-ownership-ledger.js";
import type { ElementReconcilerMetrics } from "./element-reconciler-metrics.js";
import type { ElementTrace } from "./element-trace.js";
import type {
  AvalCleanupReceipt,
  AvalDiagnostics,
  AvalDiagnosticsCounters,
  AvalElementOwnershipSnapshot,
  AvalTerminalCleanupProof
} from "./public-types.js";

export interface ElementReconcilerDiagnosticInput {
  readonly desired: Readonly<ElementDesiredSnapshot>;
  readonly publicState: ElementPublicState;
  readonly connected: boolean;
  readonly finalDisposed: boolean;
  readonly sourceGeneration: number;
  readonly inputGeneration: number;
  readonly motionGeneration: number;
  readonly visibilityGeneration: number;
  readonly resizeGeneration: number;
  readonly counters: Readonly<AvalDiagnosticsCounters>;
  readonly cleanup: Readonly<AvalCleanupReceipt> | null;
  readonly ownership: Readonly<AvalElementOwnershipSnapshot>;
  readonly terminalCleanup: Readonly<AvalTerminalCleanupProof> | null;
  readonly runtime: Readonly<BrowserRuntimePlayerSnapshot> | null;
  readonly trace: ElementTrace;
}

export function createReconcilerDiagnostics(
  input: Readonly<ElementReconcilerDiagnosticInput>,
  includeTrace: boolean
): Readonly<AvalDiagnostics> {
  const desired = input.desired;
  const state = input.publicState;
  const configuration = desired.configuration ?? DEFAULT_CONFIGURATION;
  return createElementDiagnostics({
    elementGeneration: 1,
    sourceGeneration: input.sourceGeneration,
    inputGeneration: input.inputGeneration,
    motionGeneration: input.motionGeneration,
    visibilityGeneration: input.visibilityGeneration,
    resizeGeneration: input.resizeGeneration,
    connected: input.connected,
    finalDisposed: input.finalDisposed,
    readiness: state.readiness,
    mode: state.mode,
    assurance: state.assurance,
    staticReason: state.staticReason,
    requestedState: state.requestedState,
    visualState: state.visualState,
    isTransitioning: state.transitioning,
    paused: !desired.manualPlaying,
    effectivelyVisible: desired.effectivelyVisible,
    stateNames: state.stateNames,
    eventNames: state.eventNames,
    inputBindings: state.inputBindings,
    rings: state.rings,
    configuredMotion: configuration.motion,
    hostReducedMotion: desired.hostReducedMotion,
    autoplay: configuration.autoplay,
    manualPlaying: desired.manualPlaying,
    fit: configuration.fit,
    visibility: Object.freeze({
      documentVisible: desired.documentVisible,
      intersecting: desired.intersecting,
      positiveBox: desired.positiveBox,
      effectivelyVisible: desired.effectivelyVisible,
      observerSupported: desired.observerSupported
    }),
    box: desired.box,
    lastFailure: state.lastFailure,
    counters: input.counters,
    cleanup: input.cleanup,
    elementOwnership: input.ownership,
    terminalCleanup: input.terminalCleanup,
    runtime: input.runtime,
    trace: input.trace
  }, includeTrace);
}

export const DEFAULT_CONFIGURATION: Readonly<ElementConfiguration> = Object.freeze({
  sourceCandidates: Object.freeze([]),
  crossOrigin: "anonymous",
  motion: "auto",
  autoplay: "visible",
  fit: null,
  bindings: "auto",
  state: null,
  interactionFor: "",
  width: null,
  height: null
});

export class ElementReconcilerDiagnosticsView {
  readonly #desired: () => Readonly<ElementDesiredSnapshot>;
  readonly #state: ElementPublicState;
  readonly #ownership: ElementOwnershipLedger;
  readonly #metrics: ElementReconcilerMetrics;
  readonly #dynamic: () => Readonly<{
    connected: boolean;
    finalDisposed: boolean;
    sourceGeneration: number;
    cleanup: Readonly<AvalCleanupReceipt> | null;
    terminalCleanup: Readonly<AvalTerminalCleanupProof> | null;
    runtime: Readonly<BrowserRuntimePlayerSnapshot> | null;
  }>;
  readonly #trace: ElementTrace;

  public constructor(input: Readonly<{
    desired(): Readonly<ElementDesiredSnapshot>;
    state: ElementPublicState;
    ownership: ElementOwnershipLedger;
    metrics: ElementReconcilerMetrics;
    dynamic(): Readonly<{
      connected: boolean;
      finalDisposed: boolean;
      sourceGeneration: number;
      cleanup: Readonly<AvalCleanupReceipt> | null;
      terminalCleanup: Readonly<AvalTerminalCleanupProof> | null;
      runtime: Readonly<BrowserRuntimePlayerSnapshot> | null;
    }>;
    trace: ElementTrace;
  }>) {
    this.#desired = input.desired;
    this.#state = input.state;
    this.#ownership = input.ownership;
    this.#metrics = input.metrics;
    this.#dynamic = input.dynamic;
    this.#trace = input.trace;
  }

  public get(options: Readonly<{ trace?: boolean }> = {}): Readonly<AvalDiagnostics> {
    if (
      options === null || typeof options !== "object" ||
      Object.keys(options).some((key) => key !== "trace") ||
      (options.trace !== undefined && typeof options.trace !== "boolean")
    ) throw new TypeError("diagnostic options are invalid");
    const dynamic = this.#dynamic();
    return createReconcilerDiagnostics({
      desired: this.#desired(),
      publicState: this.#state,
      sourceGeneration: dynamic.sourceGeneration,
      inputGeneration: this.#metrics.generation("input"),
      motionGeneration: this.#metrics.generation("motion"),
      visibilityGeneration: this.#metrics.generation("visibility"),
      resizeGeneration: this.#metrics.generation("resize"),
      connected: dynamic.connected,
      finalDisposed: dynamic.finalDisposed,
      counters: this.#metrics.counters(),
      cleanup: dynamic.cleanup,
      ownership: Object.freeze({ ...this.#ownership.snapshot() }),
      terminalCleanup: dynamic.terminalCleanup,
      runtime: dynamic.runtime,
      trace: this.#trace
    }, options.trace === true);
  }
}
