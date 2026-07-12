/** Closed, structured-clone-safe protocol for the dedicated decoder worker. */

export const DECODER_WORKER_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_DECODER_WAIT_TIMEOUT_MS = 2_000 as const;
export const DECODER_WORKER_HARD_LIMITS = Object.freeze({
  maxDecodeQueueSize: 12,
  maxPendingSamples: 24,
  maxOutstandingFrames: 12,
  maxSampleBytes: 2 * 1024 * 1024,
  maxDecodedBytes: 64 * 1024 * 1024
});

export type DecoderWorkerRequestOperation =
  | "configure"
  | "activate-generation"
  | "submit"
  | "abort-generation";

export interface DecoderWorkerVisibleRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DecoderWorkerColorSpaceExpectation {
  readonly fullRange: boolean | null;
  readonly matrix: VideoMatrixCoefficients | null;
  readonly primaries: VideoColorPrimaries | null;
  readonly transfer: VideoTransferCharacteristics | null;
}

export interface DecoderWorkerOutputExpectation {
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly visibleRect: DecoderWorkerVisibleRect;
  /** Null skips color-space comparison; geometry and timing remain mandatory. */
  readonly colorSpace: DecoderWorkerColorSpaceExpectation | null;
}

export interface DecoderWorkerAvcProfile {
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly frameRate: {
    readonly numerator: number;
    readonly denominator: number;
  };
  readonly averageBitrate: number;
  readonly peakBitrate: number;
  readonly cpbBufferBits: number;
  readonly requireBt709LimitedRange: true;
}

export interface DecoderWorkerAvcConfig {
  readonly codec: "avc1.42E020";
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly hardwareAcceleration: HardwareAcceleration;
  readonly optimizeForLatency: true;
  readonly description?: never;
}

export interface DecoderWorkerLimits {
  /** Maximum native decoder input queue depth. */
  readonly maxDecodeQueueSize: number;
  /** Maximum accepted samples waiting to enter WebCodecs. */
  readonly maxPendingSamples: number;
  /** Combined submitted-output and transferred-frame credit ceiling. */
  readonly maxOutstandingFrames: number;
  /** Logical RGBA bytes leased to the main thread at once. */
  readonly maxDecodedBytes: number;
}

/**
 * One owned access unit. Posting a submit command transfers `data`; callers
 * must not retain or mutate that ArrayBuffer afterward.
 */
export interface DecoderWorkerSample {
  readonly ordinal: number;
  readonly unitId: string;
  readonly unitInstance: number;
  readonly unitFrame: number;
  readonly unitFrameCount: number;
  readonly type: EncodedVideoChunkType;
  readonly timestamp: number;
  readonly duration: number;
  readonly data: ArrayBuffer;
}

export interface DecoderWorkerConfigureCommand {
  readonly type: "configure";
  readonly protocolVersion: typeof DECODER_WORKER_PROTOCOL_VERSION;
  readonly requestId: number;
  readonly config: DecoderWorkerAvcConfig;
  readonly avcProfile: DecoderWorkerAvcProfile;
  readonly expectedOutput: DecoderWorkerOutputExpectation;
  readonly limits: DecoderWorkerLimits;
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
  readonly operation: DecoderWorkerRequestOperation;
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
  readonly timestamp: number;
  readonly duration: number;
  readonly decodedBytes: number;
  readonly frame: VideoFrame;
}

export interface DecoderWorkerMetrics {
  readonly configureCalls: number;
  readonly resetCalls: 0;
  readonly flushCalls: 0;
  readonly boundaryFlushCalls: 0;
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
  addEventListener(
    type: "error",
    listener: (event: ErrorEvent) => void
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
  removeEventListener(
    type: "messageerror",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
  removeEventListener(
    type: "error",
    listener: (event: ErrorEvent) => void
  ): void;
  terminate?(): void;
}
