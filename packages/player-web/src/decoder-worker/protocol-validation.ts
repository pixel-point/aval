import {
  DECODER_WORKER_PROTOCOL_VERSION,
  type DecoderWorkerCommand,
  type DecoderWorkerErrorCode,
  type DecoderWorkerEvent,
  type DecoderWorkerMetrics,
  type DecoderWorkerRequestOperation
} from "./protocol.js";

export function isDecoderWorkerCommand(
  value: unknown
): value is DecoderWorkerCommand {
  if (!isRecord(value) || value.protocolVersion !== DECODER_WORKER_PROTOCOL_VERSION) {
    return false;
  }

  switch (value.type) {
    case "configure":
      return hasRequestId(value) && hasExactKeys(value, [
        "type",
        "protocolVersion",
        "requestId",
        "config",
        "avcProfile",
        "expectedOutput",
        "limits"
      ]);
    case "activate-generation":
    case "abort-generation":
      return (
        hasRequestId(value) &&
        Number.isSafeInteger(value.generation) &&
        hasExactKeys(value, [
          "type",
          "protocolVersion",
          "requestId",
          "generation"
        ])
      );
    case "submit":
      return (
        hasRequestId(value) &&
        Number.isSafeInteger(value.generation) &&
        Array.isArray(value.samples) &&
        hasExactKeys(value, [
          "type",
          "protocolVersion",
          "requestId",
          "generation",
          "samples"
        ])
      );
    case "release-frame":
      return (
        Number.isSafeInteger(value.frameId) &&
        hasExactKeys(value, ["type", "protocolVersion", "frameId"])
      );
    case "snapshot":
    case "dispose":
      return (
        hasRequestId(value) &&
        hasExactKeys(value, ["type", "protocolVersion", "requestId"])
      );
    default:
      return false;
  }
}

export function isDecoderWorkerEvent(value: unknown): value is DecoderWorkerEvent {
  if (!isRecord(value) || value.protocolVersion !== DECODER_WORKER_PROTOCOL_VERSION) {
    return false;
  }
  switch (value.type) {
    case "ack":
      return (
        hasRequestId(value) &&
        isRequestOperation(value.operation) &&
        hasExactKeys(value, [
          "type",
          "protocolVersion",
          "requestId",
          "operation"
        ])
      );
    case "frame":
      return (
        isPositiveSafeInteger(value.frameId) &&
        isPositiveSafeInteger(value.generation) &&
        isNonNegativeSafeInteger(value.ordinal) &&
        typeof value.unitId === "string" &&
        isNonNegativeSafeInteger(value.unitInstance) &&
        isNonNegativeSafeInteger(value.unitFrame) &&
        isNonNegativeSafeInteger(value.timestamp) &&
        isPositiveSafeInteger(value.duration) &&
        isPositiveSafeInteger(value.decodedBytes) &&
        isClosableFrame(value.frame) &&
        hasExactKeys(value, [
          "type",
          "protocolVersion",
          "frameId",
          "generation",
          "ordinal",
          "unitId",
          "unitInstance",
          "unitFrame",
          "timestamp",
          "duration",
          "decodedBytes",
          "frame"
        ])
      );
    case "snapshot":
      return (
        hasRequestId(value) &&
        isMetrics(value.metrics) &&
        hasExactKeys(value, [
          "type",
          "protocolVersion",
          "requestId",
          "metrics"
        ])
      );
    case "error":
      return (
        (value.requestId === null || isPositiveSafeInteger(value.requestId)) &&
        isErrorCode(value.code) &&
        typeof value.message === "string" &&
        typeof value.fatal === "boolean" &&
        hasExactKeys(value, [
          "type",
          "protocolVersion",
          "requestId",
          "code",
          "message",
          "fatal"
        ])
      );
    case "disposed":
      return (
        hasRequestId(value) &&
        hasExactKeys(value, ["type", "protocolVersion", "requestId"])
      );
    default:
      return false;
  }
}

function hasRequestId(value: Record<string, unknown>): boolean {
  return isPositiveSafeInteger(value.requestId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isClosableFrame(value: unknown): value is VideoFrame {
  return isRecord(value) && typeof value.close === "function";
}

function isRequestOperation(
  value: unknown
): value is DecoderWorkerRequestOperation {
  return (
    value === "configure" ||
    value === "activate-generation" ||
    value === "submit" ||
    value === "abort-generation"
  );
}

function isErrorCode(value: unknown): value is DecoderWorkerErrorCode {
  return (
    value === "PROTOCOL_ERROR" ||
    value === "NOT_CONFIGURED" ||
    value === "ALREADY_CONFIGURED" ||
    value === "GENERATION_MISMATCH" ||
    value === "BACKPRESSURE_LIMIT" ||
    value === "DECODER_CONFIGURE_FAILED" ||
    value === "DECODER_SUBMIT_FAILED" ||
    value === "DECODER_OUTPUT_INVALID" ||
    value === "DECODED_BYTE_BUDGET_EXCEEDED" ||
    value === "FRAME_RELEASE_INVALID" ||
    value === "TRANSPORT_FAILED" ||
    value === "DISPOSED"
  );
}

function isMetrics(value: unknown): value is DecoderWorkerMetrics {
  if (!isRecord(value) || !hasExactKeys(value, [
    "configureCalls",
    "resetCalls",
    "flushCalls",
    "boundaryFlushCalls",
    "acceptedSamples",
    "submittedChunks",
    "outputFrames",
    "deliveredFrames",
    "releasedFrames",
    "staleFrames",
    "closedFrames",
    "pendingSamples",
    "submittedFrames",
    "leasedFrames",
    "leasedDecodedBytes",
    "decodeQueueSize",
    "activeGeneration",
    "nextSubmissionOrdinal",
    "nextOutputOrdinal",
    "errors",
    "disposed"
  ])) {
    return false;
  }
  if (
    value.resetCalls !== 0 ||
    value.flushCalls !== 0 ||
    value.boundaryFlushCalls !== 0 ||
    typeof value.disposed !== "boolean" ||
    (value.activeGeneration !== null &&
      !isPositiveSafeInteger(value.activeGeneration))
  ) {
    return false;
  }
  for (const key of [
    "configureCalls",
    "acceptedSamples",
    "submittedChunks",
    "outputFrames",
    "deliveredFrames",
    "releasedFrames",
    "staleFrames",
    "closedFrames",
    "pendingSamples",
    "submittedFrames",
    "leasedFrames",
    "leasedDecodedBytes",
    "decodeQueueSize",
    "nextSubmissionOrdinal",
    "nextOutputOrdinal",
    "errors"
  ] as const) {
    if (!isNonNegativeSafeInteger(value[key])) {
      return false;
    }
  }
  return true;
}
