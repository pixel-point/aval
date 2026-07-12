import type {
  GraphBodyDefinition,
  GraphEdgeDefinition,
  GraphStartPolicy
} from "@rendered-motion/graph";

import type {
  DecoderWorkerLimits,
  DecoderWorkerMetrics,
  DecoderWorkerSample
} from "../decoder-worker/protocol.js";
import type {
  DecoderWorkerWaitOptions,
  ManagedDecoderWorkerFrame
} from "../decoder-worker/client.js";
import type { DecodeTimeline } from "./decode-timeline.js";
import type {
  RuntimeFrameKey,
  RuntimeMediaPresentation,
  RuntimeSchedulerSnapshot
} from "./model.js";
import type { SourceBodyCursor } from "./submission-horizon.js";
import type { WorkerSampleFactory } from "./worker-samples.js";

/** Decoder-worker surface required by the active-path scheduler. */
export interface PathSchedulerWorkerAdapter {
  readonly activeGeneration: number | null;
  readonly queuedFrames: number;
  readonly openFrames: number;
  activateGeneration(generation: number): Promise<void>;
  submit(
    generation: number,
    samples: readonly DecoderWorkerSample[]
  ): Promise<void>;
  abortGeneration(generation: number): Promise<void>;
  takeFrame(): ManagedDecoderWorkerFrame | undefined;
  waitForFrames(minimum?: number, options?: DecoderWorkerWaitOptions): Promise<void>;
  snapshotMetrics(): Promise<DecoderWorkerMetrics>;
}

export interface PathSchedulerClock {
  now(): number;
}

export interface PathSchedulerOptions {
  readonly timeline: DecodeTimeline;
  readonly samples: WorkerSampleFactory;
  readonly worker: PathSchedulerWorkerAdapter;
  readonly rendition: string;
  readonly ringCapacity: number;
  readonly limits: DecoderWorkerLimits;
  readonly clock: PathSchedulerClock;
  readonly maxBatchSamples?: number;
}

export interface StartScheduledBodyInput {
  readonly state: string;
  readonly body: GraphBodyDefinition;
  readonly outgoingStarts: readonly GraphStartPolicy[];
  readonly path: string;
  readonly firstPresentationOrdinal?: bigint;
}

export interface PrepareScheduledRouteInput {
  readonly edge: GraphEdgeDefinition;
  readonly targetState: string;
  readonly targetBody: GraphBodyDefinition;
  readonly replacementPath?: string;
  readonly signal?: AbortSignal;
  /** Keeps an uploaded source reservation across pending-route replacement. */
  readonly preserveReservedSource?: boolean;
}

export interface PathSchedulerResidentFrame {
  readonly frame: Readonly<RuntimeFrameKey>;
  readonly unitInstance: number;
  readonly decodeOrdinal: number;
  readonly timestamp: number;
}

export interface StartResidentRunwayInput {
  readonly edgeId: string;
  readonly targetState: string;
  readonly targetBody: GraphBodyDefinition;
  readonly frames: readonly PathSchedulerResidentFrame[];
  readonly path: string;
  readonly signal?: AbortSignal;
  readonly firstPresentationOrdinal?: bigint;
}

/** Scheduler-issued, identity-stable reservation for one resident runway. */
export interface PathSchedulerResidentRunwayTransaction {
  readonly generation: number;
  readonly path: string;
  readonly edgeId: string;
  readonly targetState: string;
  readonly media: readonly Readonly<Extract<
    RuntimeMediaPresentation,
    { readonly kind: "frame" }
  >>[];
}

export interface CommitResidentRunwayOptions {
  /** Browser draw-barrier commits frame zero; compatibility activation uses 0. */
  readonly alreadyPresented?: 0 | 1;
}

/** One-shot lazy worker activation; invoke only inside the media lane. */
export type PathSchedulerWorkerActivation = () => Promise<void>;

export interface PathSchedulerPumpOptions {
  readonly targetRingFrames?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface PathSchedulerPumpReport {
  readonly submittedFrames: number;
  readonly decodedFrames: number;
  readonly discardedFrames: number;
  readonly staleFrames: number;
  readonly waits: number;
  readonly ringSize: number;
  readonly expectedOutputs: number;
}

export type PathSchedulerStatus = "idle" | "active" | "error" | "disposed";
export type PathSchedulerFramePurpose = "source" | "bridge" | "target";

export type PathSchedulerTakeResult =
  | {
      readonly kind: "frame";
      readonly purpose: PathSchedulerFramePurpose;
      readonly media: Extract<
        RuntimeMediaPresentation,
        { readonly kind: "frame" }
      >;
      readonly frame: ManagedDecoderWorkerFrame;
    }
  | {
      readonly kind: "resident";
      readonly media: Extract<
        RuntimeMediaPresentation,
        { readonly kind: "frame" }
      >;
    }
  | { readonly kind: "route-blocked" }
  | { readonly kind: "underflow" }
  | { readonly kind: "held" };

export interface PathSchedulerTraceRecord {
  readonly index: number;
  readonly operation:
    | "activate"
    | "submit"
    | "output"
    | "discard-output"
    | "stale-output"
    | "present"
    | "resident-present"
    | "route-select"
    | "route-commit"
    | "generation-retire"
    | "underflow"
    | "watchdog"
    | "failure"
    | "dispose";
  readonly generation: number | null;
  readonly path: string | null;
  readonly unit: string | null;
  readonly unitInstance: number | null;
  readonly unitFrame: number | null;
  readonly decodeOrdinal: number | null;
  readonly intendedPresentationOrdinal: bigint | null;
  readonly ringSize: number;
  readonly expectedOutputs: number;
  readonly reason: string | null;
}

export interface PathSchedulerSnapshot extends RuntimeSchedulerSnapshot {
  readonly status: PathSchedulerStatus;
  readonly pendingEdge: string | null;
  readonly expectedOutputs: number;
  readonly residentFrames: number;
  readonly discardedDependencyFrames: number;
  readonly staleFrames: number;
  readonly nextDecodeOrdinal: number;
  readonly submittedSource: Readonly<SourceBodyCursor> | null;
  readonly displayedSource: Readonly<SourceBodyCursor> | null;
  readonly unresolvedMaximumSubmitted: Readonly<SourceBodyCursor> | null;
}
