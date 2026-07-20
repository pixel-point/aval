import type {
  AvalPlaybackLifecycleCounters,
  AvalRuntimeTraceRecord,
  Binding,
  RuntimeFailureCode,
  RuntimeReadinessResult
} from "./public-types.js";
import type { AvalPlaybackError } from "./errors.js";
import type { DecoderFailureDiagnostic } from "./decoder-diagnostics.js";
import type { DecoderPoolLaneId } from "./decoder-pool.js";
import type { RendererFailureDiagnostic } from "./renderer-diagnostics.js";

export interface Source {
  readonly src: string;
  readonly codec: string;
  readonly integrity: string;
  /** Original direct-child source position before invalid candidates are filtered. */
  readonly sourceIndex?: number;
}

export interface Metadata {
  readonly initialState: string;
  readonly stateNames: readonly string[];
  readonly eventNames: readonly string[];
  readonly bindings: readonly Readonly<Binding>[];
  readonly canvas: Readonly<{
    width: number;
    height: number;
    pixelAspect: readonly [number, number];
    fit: "contain" | "cover" | "fill" | "none";
  }>;
}

export interface PlayerDecoderDiagnostic extends DecoderFailureDiagnostic {
  readonly sourceIndex: number;
  readonly rendition: string;
  readonly codec: string;
  readonly unit: string | null;
  readonly lane: DecoderPoolLaneId;
  readonly logicalRunId: number | null;
  readonly role: "foreground" | "candidate" | null;
  readonly graph: Readonly<{
    readonly requestedState: string | null;
    readonly visualState: string | null;
    readonly activeUnit: string | null;
    readonly pendingUnit: string | null;
  }>;
}

export interface PlayerRendererDiagnostic extends RendererFailureDiagnostic {
  readonly sourceIndex: number;
  readonly rendition: string;
  readonly codec: string;
}

export interface PlayerSnapshot {
  readonly requestedState: string | null;
  readonly visualState: string | null;
  readonly transitioning: boolean;
  readonly selectedRendition: string | null;
  readonly selectedCodec: string | null;
  readonly rendererBackend: "webgl2" | "canvas2d" | null;
  readonly selectedBitDepth: 8 | 10 | null;
  readonly transportMode: "range" | "full" | null;
  readonly declaredFileBytes: number;
  readonly metadataBytes: number;
  readonly verifiedBytes: number;
  readonly residentBlobBytes: number;
  readonly activeTransportBodies: number;
  readonly pendingLoads: number;
  readonly interestedWaiters: number;
  readonly workerCount: number;
  readonly openFrames: number;
  readonly contextLossCount: number;
  readonly contextRecoveryCount: number;
  readonly cleanupFailureCount?: number;
  readonly playbackLifecycle: Readonly<AvalPlaybackLifecycleCounters>;
  readonly decoderDiagnostics: readonly Readonly<PlayerDecoderDiagnostic>[];
  readonly rendererDiagnostics: readonly Readonly<PlayerRendererDiagnostic>[];
  readonly presentation: Readonly<{
    cssWidth: number;
    cssHeight: number;
    backingWidth: number;
    backingHeight: number;
    effectiveDprX: number;
    effectiveDprY: number;
    stagingBytes?: number;
    residentBytes?: number;
    textureBytes?: number;
    runtimeBytes?: number;
    pendingOperations?: number;
    sourceCopiesInFlight?: number;
    resourceCount?: number;
    contextListenerCount?: number;
  }>;
  readonly trace: readonly Readonly<AvalRuntimeTraceRecord>[];
}

export interface Player {
  readonly metadata: Readonly<Metadata>;
  activate(options?: Readonly<{ publish?: boolean }>): void;
  publish(): void;
  prepare(options?: Readonly<{
    signal?: AbortSignal;
    timeoutMs?: number;
  }>): Promise<RuntimeReadinessResult>;
  setState(state: string): Promise<void>;
  canSend(event: string): boolean;
  send(event: string): boolean;
  readyFor(state: string): boolean;
  pause(): void;
  resume(): Promise<void>;
  setMotion(policy: "auto" | "reduce" | "full", reduced: boolean): Promise<void>;
  suspend(reason: "visibility-suspended"): Promise<RuntimeReadinessResult>;
  setVisibility(visible: boolean): void;
  resize(width: number, height: number, dpr: number, fit: string): void;
  snapshot(trace: boolean): Readonly<PlayerSnapshot>;
  settled(): Promise<void>;
  dispose(): Promise<void>;
}

export interface PlayerInput {
  readonly canvas: HTMLCanvasElement;
  /** Immutable capabilities captured from the element's owner window for this generation. */
  readonly platform: Readonly<{
    readonly fetch: typeof globalThis.fetch;
    readonly Worker: typeof globalThis.Worker | null;
    readonly VideoDecoder: typeof globalThis.VideoDecoder | null;
    readonly VideoFrame: typeof globalThis.VideoFrame | null;
    readonly requestAnimationFrame: (callback: FrameRequestCallback) => number;
    readonly cancelAnimationFrame: (handle: number) => void;
    readonly now: () => number;
    readonly setTimeout: (callback: () => void, delay: number) => number;
    readonly clearTimeout: (handle: number) => void;
    readonly crypto: Crypto;
  }>;
  readonly initialPresentation: Readonly<{
    readonly width: number;
    readonly height: number;
    readonly dpr: number;
    readonly fit: "contain" | "cover" | "fill" | "none" | null;
  }>;
  readonly baseUrl: string;
  readonly sources: readonly Readonly<Source>[];
  readonly credentials: RequestCredentials;
  readonly signal: AbortSignal;
  readonly preparationTimeoutMs: number;
  readonly motion: "auto" | "reduce" | "full";
  readonly reduced: boolean;
  readonly initialState: string | null;
  readonly initialBody: boolean;
  readonly visible: boolean;
  readonly decoderReady: () => boolean;
  /** Configures a provisional player before startup qualification and publication. */
  readonly onCandidate?: (player: Player) => Promise<void>;
  readonly onResourceBytes: (bytes: number) => void;
  readonly onMetadata: (metadata: Readonly<Metadata>) => void;
  readonly onReadiness: (value: string, reason?: string) => void;
  /** Called only after every animated resource from the retired generation is gone. */
  readonly onAnimationResourcesRetired: () => void;
  readonly onDraw: () => void;
  readonly onRestart: (state: string) => void;
  readonly onEvent: (type: string, detail: Readonly<Record<string, unknown>>) => void;
  readonly onFailure: (
    code: RuntimeFailureCode,
    operation: string,
    fatal: boolean
  ) => void;
  /** Returns the generation's canonical public error for a terminal playback failure. */
  readonly onPlaybackFailure: (
    code: RuntimeFailureCode,
    operation: string
  ) => AvalPlaybackError;
  readonly onDecoderDiagnostics?: (
    diagnostics: readonly Readonly<PlayerDecoderDiagnostic>[]
  ) => void;
  readonly onRendererDiagnostics?: (
    diagnostics: readonly Readonly<PlayerRendererDiagnostic>[]
  ) => void;
}
