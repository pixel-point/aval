import type {
  GraphBodyDefinition,
  GraphEdgeDefinition
} from "@pixel-point/aval-graph";

import type { BorrowedVideoFrame } from "./frame-renderer.js";
import type {
  RenderFrameHandle,
  ResidentFrameHandle,
  StreamingFrameHandle
} from "./frame-renderer.js";
import type { RuntimeFailure } from "./errors.js";
import type { RuntimeMediaPresentation } from "./model.js";
import type {
  PathSchedulerPumpOptions,
  PathSchedulerPumpReport,
  PathSchedulerResidentFrame,
  PathSchedulerResidentRunwayTransaction,
  PathSchedulerSnapshot,
  PathSchedulerTakeResult,
  PathSchedulerWorkerActivation,
  CommitResidentRunwayOptions,
  StartResidentRunwayInput
} from "./path-scheduler.js";

export type CutFrameMedia = Extract<
  RuntimeMediaPresentation,
  { readonly kind: "frame" }
>;

export interface CutPresentationScheduler {
  stageResidentRunway(
    input: StartResidentRunwayInput
  ): Readonly<PathSchedulerResidentRunwayTransaction>;
  commitResidentRunway(
    transaction: Readonly<PathSchedulerResidentRunwayTransaction>,
    options: Readonly<CommitResidentRunwayOptions>
  ): PathSchedulerWorkerActivation;
  rollbackResidentRunway(
    transaction: Readonly<PathSchedulerResidentRunwayTransaction>
  ): boolean;
  pump(options?: PathSchedulerPumpOptions): Promise<Readonly<PathSchedulerPumpReport>>;
  takeNext(): Readonly<PathSchedulerTakeResult>;
  takeStreamingContinuation(): Readonly<PathSchedulerTakeResult>;
  commitResidentPresentation(media: Readonly<CutFrameMedia>): void;
  commitPreparedPresentation(media: Readonly<CutFrameMedia>): void;
  discardPreparedPresentation(): void;
  snapshot(): Readonly<PathSchedulerSnapshot>;
}

/** The concrete FrameRenderer satisfies this boundary directly. */
export interface CutPresentationRenderer {
  readonly resourceGeneration: number;
  residentHandle(layer: number): ResidentFrameHandle;
  uploadStreaming(
    slot: number,
    pathGeneration: number,
    source: BorrowedVideoFrame,
    resourceGeneration?: number
  ): Promise<StreamingFrameHandle | null>;
  draw(handle: RenderFrameHandle): void;
}

export interface CutResidentRunwayFrame extends PathSchedulerResidentFrame {
  /** Persistent interaction-cache layer, never a streaming-ring slot. */
  readonly layer: number;
}

export interface CutActivationInput {
  readonly edge: Readonly<GraphEdgeDefinition>;
  readonly targetState: string;
  readonly targetBody: Readonly<GraphBodyDefinition>;
  readonly runway: readonly Readonly<CutResidentRunwayFrame>[];
  readonly path: string;
  /** Reversible endpoint recovery uses the same resident-runway machinery. */
  readonly entryMode?: "cut" | "endpoint";
  /** Defaults to one streamed frame prepared behind the resident runway. */
  readonly continuationTargetFrames?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Exact graph ordinal of resident runway frame zero. */
  readonly firstPresentationOrdinal?: bigint;
  /** The graph will admit this authored completion cut on the same tick. */
  readonly completionStart?: boolean;
}

export interface CutActivationReport {
  readonly activation: number;
  readonly generation: number;
  readonly runwayFrames: number;
  readonly pump: Readonly<PathSchedulerPumpReport>;
}

export interface CutPresentationCoordinatorOptions {
  readonly scheduler: CutPresentationScheduler;
  readonly renderer: CutPresentationRenderer;
  readonly streamingSlots?: number;
  /** First upload slot; browser composition uses it to pin prior pixels. */
  readonly firstStreamingSlot?: number;
  /** Browser session adopts the aligned scheduler after its first stream draw. */
  readonly handoffAfterFirstStreaming?: boolean;
  /** Decoder and upload work share the browser owner's serialization lane. */
  readonly enqueueMediaOperation: <T>(
    operation: (signal?: AbortSignal) => Promise<T>
  ) => Promise<T>;
  readonly onStaticRecovery?: (failure: Readonly<RuntimeFailure>) => void;
  readonly readbackTag?: (
    media: Readonly<CutFrameMedia>,
    handle: Readonly<RenderFrameHandle>
  ) => string | null;
}

export type CutPresentationStatus =
  | "idle"
  | "ready"
  | "error"
  | "disposed";

export interface CutPresentationSnapshot {
  readonly status: CutPresentationStatus;
  readonly activation: number;
  readonly edge: string | null;
  readonly targetState: string | null;
  readonly generation: number | null;
  readonly runwayFrames: number;
  readonly residentFramesPresented: number;
  readonly streamingFramesPresented: number;
  readonly uploadPending: boolean;
  readonly streamingReady: boolean;
}

export class CutPresentationInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CutPresentationInvariantError";
  }
}

/** A normal latest-intent outcome; callers must not convert it to fallback. */
export class CutPresentationSupersededError extends Error {
  public constructor(message = "prepared cut presentation was superseded") {
    super(message);
    this.name = "CutPresentationSupersededError";
  }
}
