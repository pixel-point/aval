import type {
  Binding,
  RuntimeReadiness,
  StaticReason
} from "@pixel-point/aval-player-web";

import type { BrowserRuntimePlayerSnapshot } from "./browser-runtime-factory.js";
import type { ElementTrace } from "./element-trace.js";
import { addElementCount } from "./element-sequence.js";
import type {
  AvalAutoplay,
  AvalDiagnostics,
  AvalDiagnosticsCounters,
  AvalElementOwnershipSnapshot,
  AvalCleanupReceipt,
  AvalFit,
  AvalMode,
  AvalMotion,
  AvalPublicFailure,
  AvalRing,
  AvalTerminalCleanupProof
} from "./public-types.js";

export interface ElementDiagnosticState {
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
  readonly rings?: readonly Readonly<AvalRing>[];
  readonly configuredMotion: AvalMotion;
  readonly hostReducedMotion: boolean | null;
  readonly autoplay: AvalAutoplay;
  readonly manualPlaying: boolean;
  readonly fit: AvalFit | null;
  readonly visibility: Readonly<{
    documentVisible: boolean;
    intersecting: boolean;
    positiveBox: boolean;
    effectivelyVisible: boolean;
    observerSupported: boolean;
  }>;
  readonly box: Readonly<{ width: number; height: number }>;
  readonly lastFailure: Readonly<AvalPublicFailure> | null;
  readonly counters: Readonly<AvalDiagnosticsCounters>;
  readonly cleanup: Readonly<AvalCleanupReceipt> | null;
  readonly elementOwnership: Readonly<AvalElementOwnershipSnapshot>;
  readonly terminalCleanup: Readonly<AvalTerminalCleanupProof> | null;
  readonly runtime: Readonly<BrowserRuntimePlayerSnapshot> | null;
  readonly trace: ElementTrace;
}

export function createElementDiagnostics(
  state: Readonly<ElementDiagnosticState>,
  trace: boolean
): Readonly<AvalDiagnostics> {
  const runtime = state.runtime;
  const cleanup = state.cleanup;
  const outstanding = Object.freeze({
    player: runtime?.player.disposed === false
      ? 1
      : cleanup?.playerDisposed === false ? 1 : 0,
    decoder: runtime?.decoderLeaseState === "granted"
      ? 1
      : cleanup?.participantDecoderTicketCount ?? 0,
    bytes: runtime?.pageTrackedBytes ?? cleanup?.participantLogicalBytes ?? 0
  });
  const geometry = runtime?.presentation.geometry ?? null;
  const diagnostics: AvalDiagnostics = {
    elementGeneration: state.elementGeneration,
    sourceGeneration: state.sourceGeneration,
    inputGeneration: state.inputGeneration,
    motionGeneration: state.motionGeneration,
    visibilityGeneration: state.visibilityGeneration,
    resizeGeneration: state.resizeGeneration,
    connected: state.connected,
    finalDisposed: state.finalDisposed,
    readiness: state.readiness,
    mode: state.mode,
    assurance: state.assurance,
    staticReason: state.staticReason,
    requestedState: state.requestedState,
    visualState: state.visualState,
    isTransitioning: state.isTransitioning,
    paused: state.paused,
    effectivelyVisible: state.effectivelyVisible,
    stateNames: Object.freeze([...state.stateNames]),
    rings: Object.freeze([...(state.rings ?? [])]),
    eventNames: Object.freeze([...state.eventNames]),
    inputBindings: Object.freeze(state.inputBindings.map((binding) =>
      Object.freeze({ source: binding.source, event: binding.event })
    )),
    configuredMotion: state.configuredMotion,
    hostReducedMotion: state.hostReducedMotion,
    autoplay: state.autoplay,
    fit: state.fit,
    lastFailure: state.lastFailure,
    counters: Object.freeze({
      ...state.counters,
      contextRecovery: addElementCount(
        state.counters.contextRecovery,
        runtime?.contextRecoveryCount ?? 0,
        "context recovery"
      )
    }),
    cleanup,
    elementOwnership: Object.freeze({ ...state.elementOwnership }),
    terminalCleanup: state.terminalCleanup === null
      ? null
      : Object.freeze({
          completed: state.terminalCleanup.completed,
          sourceCleanupCompleted: state.terminalCleanup.sourceCleanupCompleted,
          elementOwnership: Object.freeze({
            ...state.terminalCleanup.elementOwnership
          })
        }),
    outstanding,
    runtime: Object.freeze({
      selectedRendition: runtime?.selectedRendition ?? null,
      selectedCodec: runtime?.selectedCodec ?? null,
      selectedBitDepth: runtime?.selectedBitDepth ?? null,
      transportMode: runtime?.transportMode ?? null,
      declaredFileBytes: runtime?.declaredFileBytes ?? 0,
      metadataBytes: runtime?.metadataBytes ?? 0,
      verifiedBytes: runtime?.verifiedBytes ?? 0,
      residentBlobBytes: runtime?.residentBlobBytes ?? 0,
      activeTransportBodies: runtime?.activeTransportBodies ?? 0,
      pendingLoads: runtime?.pendingLoads ?? 0,
      interestedWaiters: runtime?.interestedWaiters ?? 0,
      playerTrackedBytes: runtime?.pageTrackedBytes ?? 0,
      pagePhysicalBytes: runtime?.pagePhysicalBytes ?? 0,
      activeLeaseCount: runtime?.activeLeaseCount ?? 0,
      decoderLeaseState: runtime?.decoderLeaseState ?? null,
      reclamationCount: runtime?.reclamationCount ?? 0,
      contextLossCount: runtime?.contextLossCount ?? 0,
      contextRecoveryCount: runtime?.contextRecoveryCount ?? 0
    }),
    motion: Object.freeze({
      configured: state.configuredMotion,
      hostReducedMotion: state.hostReducedMotion,
      effective: runtime?.effectiveMotion ?? (
        state.configuredMotion === "reduce" ||
        (state.configuredMotion === "auto" && state.hostReducedMotion === true)
          ? "reduce"
          : "full"
      ),
      actual: runtime?.actualMotion ?? null
    }),
    playIntent: Object.freeze({
      autoplay: state.autoplay,
      manualPlaying: state.manualPlaying,
      paused: state.paused
    }),
    visibility: Object.freeze({
      documentVisible: state.visibility.documentVisible,
      intersecting: state.visibility.intersecting,
      positiveBox: state.visibility.positiveBox,
      effectivelyVisible: state.visibility.effectivelyVisible,
      observerSupported: state.visibility.observerSupported,
      runtimeVisibility: runtime?.visibility.visibility ?? null,
      runtimeSuspension: runtime?.visibility.suspension ?? null,
      rebuildPending: runtime?.visibility.rebuildPending ?? false
    }),
    presentation: Object.freeze({
      fit: geometry?.fit ?? state.fit,
      cssWidth: state.box.width,
      cssHeight: state.box.height,
      backingWidth: geometry?.backing.width ?? 0,
      backingHeight: geometry?.backing.height ?? 0,
      effectiveDprX: geometry?.effectiveDevicePixelRatio.x ?? 0,
      effectiveDprY: geometry?.effectiveDevicePixelRatio.y ?? 0,
      resolutionScale: geometry?.resolutionScale ?? 0,
      clampReasons: Object.freeze([...(geometry?.clampReasons ?? [])])
    }),
    ...(trace
      ? {
          elementTrace: state.trace.snapshot(),
          runtimeTrace: Object.freeze(runtime?.runtimeTrace.map((record) =>
            Object.freeze({ ...record })
          ) ?? [])
        }
      : {})
  };
  return Object.freeze(diagnostics);
}
