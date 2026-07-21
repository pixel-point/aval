import type {
  Rational,
  VideoBitDepth,
  VideoCodec
} from "@pixel-point/aval-format";

/** Closed, structured-clone-safe protocol for the dedicated decoder worker. */

export const DECODER_WORKER_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_DECODER_WAIT_TIMEOUT_MS = 2_000 as const;
export const DECODER_WORKER_HARD_LIMITS = Object.freeze({
  maxDecodeQueueSize: 12,
  maxPendingSamples: 24,
  maxOutstandingFrames: 12,
  maxSampleBytes: Number.MAX_SAFE_INTEGER,
  maxDecodedBytes: Number.MAX_SAFE_INTEGER
});

export type DecoderWorkerRequestOperation =
  | "probe-config"
  | "configure"
  | "activate-generation"
  | "submit"
  | "abort-generation";

export type DecoderWorkerAckOperation = Exclude<
  DecoderWorkerRequestOperation,
  "probe-config"
>;

/**
 * Decoder configuration is intentionally the platform dictionary. Runtime
 * validation closes it to the supported WebCodecs members and rejects codec
 * descriptions because every current wire-1.1 AVAL video asset carries
 * elementary chunks.
 */
export type DecoderWorkerVideoConfig = Readonly<VideoDecoderConfig>;
export type DecoderWorkerProbeConfig = DecoderWorkerVideoConfig;

export interface DecoderWorkerVideoProfile {
  readonly codecFamily: VideoCodec;
  readonly bitDepth: VideoBitDepth;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly frameRate: Rational;
  readonly requireBt709LimitedRange: true;
}

export interface DecoderWorkerVisibleRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DecoderWorkerColorSpaceExpectation {
  readonly fullRange: false;
  readonly matrix: "bt709";
  readonly primaries: "bt709";
  readonly transfer: "bt709";
}

export interface DecoderWorkerOutputExpectation {
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly visibleRect: DecoderWorkerVisibleRect;
  readonly colorSpace: DecoderWorkerColorSpaceExpectation;
}

export interface DecoderWorkerLimits {
  /** Maximum native decoder input queue depth. */
  readonly maxDecodeQueueSize: number;
  /** Maximum accepted chunks waiting to enter WebCodecs. */
  readonly maxPendingSamples: number;
  /** Pending, submitted, buffered, and transferred displayed-frame ceiling. */
  readonly maxOutstandingFrames: number;
  /** Logical RGBA bytes owned by buffered and transferred frames. */
  readonly maxDecodedBytes: number;
}

/**
 * One owned wire-1.1 encoded chunk in decoder submission order.
 *
 * `presentationIndices` maps every displayed output carried by this chunk to
 * its authored frame inside the unit. Hidden VP9/AV1 chunks use an empty array
 * and `displayedFrameCount: 0`. Posting transfers `data`; callers must not
 * retain or mutate that ArrayBuffer afterward.
 */
export interface DecoderWorkerSample {
  readonly unitId: string;
  readonly unitInstance: number;
  readonly decodeIndex: number;
  readonly unitChunkCount: number;
  readonly unitFrameCount: number;
  readonly presentationOrdinalBase: number;
  readonly presentationIndices: readonly number[];
  readonly presentationTimestamp: number;
  readonly duration: number;
  readonly randomAccess: boolean;
  readonly displayedFrameCount: number;
  readonly data: ArrayBuffer;
}

export interface DecoderWorkerConfigureCommand {
  readonly type: "configure";
  readonly protocolVersion: typeof DECODER_WORKER_PROTOCOL_VERSION;
  readonly requestId: number;
  readonly config: DecoderWorkerVideoConfig;
  readonly videoProfile: DecoderWorkerVideoProfile;
  readonly expectedOutput: DecoderWorkerOutputExpectation;
  readonly limits: DecoderWorkerLimits;
}

export interface DecoderWorkerProbeConfigCommand {
  readonly type: "probe-config";
  readonly protocolVersion: typeof DECODER_WORKER_PROTOCOL_VERSION;
  readonly requestId: number;
  readonly config: DecoderWorkerProbeConfig;
}

export interface DecoderWorkerActivateGenerationCommand {
  readonly type: "activate-generation";
  readonly protocolVersion: typeof DECODER_WORKER_PROTOCOL_VERSION;
  readonly requestId: number;
  readonly generation: number;
}

export interface DecoderWorkerSubmitCommand {
  readonly type: "submit";
  readonly protocolVersion: typeof DECODER_WORKER_PROTOCOL_VERSION;
  readonly requestId: number;
  readonly generation: number;
  readonly samples: readonly DecoderWorkerSample[];
}

export interface DecoderWorkerAbortGenerationCommand {
  readonly type: "abort-generation";
  readonly protocolVersion: typeof DECODER_WORKER_PROTOCOL_VERSION;
  readonly requestId: number;
  readonly generation: number;
}

export interface DecoderWorkerReleaseFrameCommand {
  readonly type: "release-frame";
  readonly protocolVersion: typeof DECODER_WORKER_PROTOCOL_VERSION;
  readonly frameId: number;
}

export interface DecoderWorkerSnapshotCommand {
  readonly type: "snapshot";
  readonly protocolVersion: typeof DECODER_WORKER_PROTOCOL_VERSION;
  readonly requestId: number;
}

export interface DecoderWorkerDisposeCommand {
  readonly type: "dispose";
  readonly protocolVersion: typeof DECODER_WORKER_PROTOCOL_VERSION;
  readonly requestId: number;
}

export type DecoderWorkerCommand =
  | DecoderWorkerProbeConfigCommand
  | DecoderWorkerConfigureCommand
  | DecoderWorkerActivateGenerationCommand
  | DecoderWorkerSubmitCommand
  | DecoderWorkerAbortGenerationCommand
  | DecoderWorkerReleaseFrameCommand
  | DecoderWorkerSnapshotCommand
  | DecoderWorkerDisposeCommand;

export interface DecoderWorkerAckEvent {
  readonly type: "ack";
  readonly protocolVersion: typeof DECODER_WORKER_PROTOCOL_VERSION;
  readonly requestId: number;
  readonly operation: DecoderWorkerAckOperation;
}

export interface DecoderWorkerProbeResultEvent {
  readonly type: "probe-result";
  readonly protocolVersion: typeof DECODER_WORKER_PROTOCOL_VERSION;
  readonly requestId: number;
  readonly supported: boolean;
}

export interface DecoderWorkerFrameEvent {
  readonly type: "frame";
  readonly protocolVersion: typeof DECODER_WORKER_PROTOCOL_VERSION;
  readonly frameId: number;
  readonly generation: number;
  readonly ordinal: number;
  readonly unitId: string;
  readonly unitInstance: number;
  readonly unitFrame: number;
  readonly decodeIndex: number;
  readonly timestamp: number;
  readonly duration: number;
  /** Worker host-clock observation captured at VideoDecoder output callback entry. */
  readonly outputCallbackMicroseconds: number;
  readonly decodedBytes: number;
  readonly frame: VideoFrame;
}

/**
 * Stable telemetry shape. `submittedFrames` is the complete accepted display
 * obligation: frames represented by pending chunks, decoder-owned callbacks,
 * and worker-buffered presentation output. Pending chunk count is reported
 * separately by `pendingSamples`.
 */
export interface DecoderWorkerMetrics {
  readonly configureCalls: number;
  readonly resetCalls: 0;
  readonly flushCalls: number;
  readonly boundaryFlushCalls: number;
  readonly acceptedSamples: number;
  readonly submittedChunks: number;
  readonly outputFrames: number;
  readonly deliveredFrames: number;
  readonly releasedFrames: number;
  readonly staleFrames: number;
  readonly closedFrames: number;
  readonly pendingSamples: number;
  readonly submittedFrames: number;
  readonly leasedFrames: number;
  readonly leasedDecodedBytes: number;
  readonly decodeQueueSize: number;
  readonly activeGeneration: number | null;
  readonly nextSubmissionOrdinal: number;
  readonly nextOutputOrdinal: number;
  readonly errors: number;
  readonly disposed: boolean;
}

export interface DecoderWorkerSnapshotEvent {
  readonly type: "snapshot";
  readonly protocolVersion: typeof DECODER_WORKER_PROTOCOL_VERSION;
  readonly requestId: number;
  readonly metrics: DecoderWorkerMetrics;
}

export type DecoderWorkerErrorCode =
  | "PROTOCOL_ERROR"
  | "NOT_CONFIGURED"
  | "ALREADY_CONFIGURED"
  | "GENERATION_MISMATCH"
  | "BACKPRESSURE_LIMIT"
  | "DECODER_PROBE_FAILED"
  | "DECODER_CONFIGURE_FAILED"
  | "DECODER_SUBMIT_FAILED"
  | "DECODER_OUTPUT_INVALID"
  | "DECODED_BYTE_BUDGET_EXCEEDED"
  | "FRAME_RELEASE_INVALID"
  | "TRANSPORT_FAILED"
  | "DISPOSED";

export interface DecoderWorkerErrorEvent {
  readonly type: "error";
  readonly protocolVersion: typeof DECODER_WORKER_PROTOCOL_VERSION;
  readonly requestId: number | null;
  readonly code: DecoderWorkerErrorCode;
  readonly message: string;
  readonly fatal: boolean;
}

export interface DecoderWorkerDisposedEvent {
  readonly type: "disposed";
  readonly protocolVersion: typeof DECODER_WORKER_PROTOCOL_VERSION;
  readonly requestId: number;
}

export type DecoderWorkerEvent =
  | DecoderWorkerAckEvent
  | DecoderWorkerProbeResultEvent
  | DecoderWorkerFrameEvent
  | DecoderWorkerSnapshotEvent
  | DecoderWorkerErrorEvent
  | DecoderWorkerDisposedEvent;

export interface DecoderWorkerMessagePort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
  addEventListener(
    type: "messageerror",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
  removeEventListener(
    type: "messageerror",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
}

export interface DecoderWorkerClientPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
  addEventListener(
    type: "messageerror",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
  removeEventListener(
    type: "messageerror",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
  removeEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  terminate?(): void;
}
