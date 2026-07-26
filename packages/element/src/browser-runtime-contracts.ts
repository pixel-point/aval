import type {
  Binding,
  BrowserPresentationPlanesSnapshot,
  IntegratedPlayerSnapshot,
  MotionPolicy,
  PresentationFit,
  RuntimeReadinessResult,
  RuntimeVisibilitySnapshot,
  RuntimeVisibilityState
} from "@pixel-point/aval-player-web";

import type { AvalRing, AvalRuntimeTraceRecord } from "./public-types.js";

export interface BrowserRuntimeMetadata {
  readonly initialState: string;
  readonly stateNames: readonly string[];
  readonly eventNames: readonly string[];
  readonly bindings: readonly Readonly<Binding>[];
  /** Absent when the asset declares no ring. */
  readonly rings?: readonly Readonly<AvalRing>[];
  readonly renditions: readonly Readonly<{
    id: string;
    codec: string;
    bitDepth: 8 | 10;
  }>[];
  readonly canvas: Readonly<{
    width: number;
    height: number;
    fit: PresentationFit;
    pixelAspect: readonly [number, number];
  }>;
}

export interface BrowserRuntimePlayerSnapshot {
  readonly player: Readonly<IntegratedPlayerSnapshot>;
  readonly visibility: Readonly<RuntimeVisibilitySnapshot>;
  readonly presentation: Readonly<BrowserPresentationPlanesSnapshot>;
  readonly selectedRendition: string | null;
  readonly selectedCodec: string | null;
  readonly selectedBitDepth: 8 | 10 | null;
  readonly transportMode: "range" | "full";
  readonly declaredFileBytes: number;
  readonly metadataBytes: number;
  readonly verifiedBytes: number;
  readonly residentBlobBytes: number;
  readonly activeTransportBodies: number;
  readonly pendingLoads: number;
  readonly interestedWaiters: number;
  readonly pageTrackedBytes: number;
  readonly pagePhysicalBytes: number;
  readonly activeLeaseCount: number;
  readonly decoderLeaseState: string | null;
  readonly reclamationCount: number;
  readonly effectiveMotion: "reduce" | "full";
  readonly actualMotion: string;
  readonly contextLossCount: number;
  readonly contextRecoveryCount: number;
  readonly runtimeTrace: readonly Readonly<AvalRuntimeTraceRecord>[];
}

export interface BrowserRuntimePlayer {
  readonly metadata: Readonly<BrowserRuntimeMetadata>;
  activate(): void;
  prepare(options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>): Promise<RuntimeReadinessResult>;
  requestState(state: string): Promise<void>;
  canSend(event: string): boolean;
  send(event: string): boolean;
  readyFor(state: string): boolean;
  planFor(state: string): readonly string[] | null;
  pause(): void;
  resume(): Promise<void>;
  setMotionPolicy(policy: MotionPolicy): Promise<unknown>;
  setHostReducedMotion(value: boolean): Promise<unknown>;
  setVisibility(value: RuntimeVisibilityState): Promise<unknown>;
  resize(input: Readonly<{
    cssWidth: number;
    cssHeight: number;
    devicePixelRatio: number;
    fit?: PresentationFit;
  }>): void;
  snapshot(): Readonly<BrowserRuntimePlayerSnapshot>;
  settled(): Promise<void>;
  dispose(): Promise<void>;
}
