import {
  freezeDecoderFailureDiagnostic,
  isDecoderFailureDiagnostic,
  type DecoderFailureDiagnostic
} from "./decoder-diagnostics.js";
import { isPlainRecord } from "./plain-record.js";

export const DECODER_RING_SIZE = 12 as const;

export type DecoderChunk = Readonly<{
  data: ArrayBuffer;
  timestamp: number;
  duration: number;
  key: boolean;
}>;

export type DecoderCommand =
  | Readonly<{ t: "configure"; config: VideoDecoderConfig }>
  | Readonly<{ t: "start"; run: number }>
  | Readonly<{ t: "decode"; run: number; chunks: readonly DecoderChunk[] }>
  | Readonly<{ t: "flush"; run: number }>
  | Readonly<{ t: "close"; run: number }>
  | Readonly<{ t: "dispose" }>;

export type DecoderRunEvent =
  | Readonly<{ t: "started"; run: number }>
  | Readonly<{ t: "accepted"; run: number }>
  | Readonly<{
    t: "frame";
    run: number;
    timestamp: number;
    frame: VideoFrame;
  }>
  | Readonly<{ t: "flushed"; run: number }>
  | Readonly<{ t: "closed"; run: number }>;

export type DecoderTerminalEvent = Extract<
  DecoderRunEvent,
  Readonly<{ t: "flushed" | "closed" }>
>;

export type DecoderWorkerEvent =
  | Readonly<{ t: "configured"; supported: boolean }>
  | Readonly<{ t: "error"; diagnostic: Readonly<DecoderFailureDiagnostic> }>
  | DecoderRunEvent;

export function isDecoderCommand(value: unknown): value is DecoderCommand {
  if (!isRecord(value) || typeof value.t !== "string") return false;
  if (value.t === "configure") {
    return hasExactKeys(value, ["t", "config"]) &&
      isRecord(value.config) &&
      typeof value.config.codec === "string" &&
      value.config.codec.length > 0;
  }
  if (value.t === "dispose") return hasExactKeys(value, ["t"]);
  if (!validRun(value.run)) return false;
  if (value.t === "decode") {
    return hasExactKeys(value, ["t", "run", "chunks"]) &&
      isDecoderChunks(value.chunks);
  }
  return (
    value.t === "start" ||
    value.t === "flush" ||
    value.t === "close"
  ) && hasExactKeys(value, ["t", "run"]);
}

export function isDecoderWorkerEvent(
  value: unknown,
  VideoFrameConstructor: typeof globalThis.VideoFrame
): value is DecoderWorkerEvent {
  if (!isRecord(value) || typeof value.t !== "string") return false;
  if (value.t === "configured") {
    return hasExactKeys(value, ["t", "supported"]) &&
      typeof value.supported === "boolean";
  }
  if (value.t === "error") {
    if (
      !hasExactKeys(value, ["t", "diagnostic"]) ||
      !isDecoderFailureDiagnostic(value.diagnostic)
    ) return false;
    try {
      freezeDecoderFailureDiagnostic(value.diagnostic);
      Object.freeze(value);
    } catch {
      return false;
    }
    return true;
  }
  if (!validRun(value.run)) return false;
  if (value.t === "frame") {
    return hasExactKeys(value, ["t", "run", "timestamp", "frame"]) &&
      Number.isSafeInteger(value.timestamp) &&
      Number(value.timestamp) >= 0 &&
      value.frame instanceof VideoFrameConstructor;
  }
  return (
    value.t === "started" ||
    value.t === "accepted" ||
    value.t === "flushed" ||
    value.t === "closed"
  ) && hasExactKeys(value, ["t", "run"]);
}

export function isDecoderTerminalEvent(
  event: DecoderRunEvent
): event is DecoderTerminalEvent {
  return event.t === "flushed" || event.t === "closed";
}

function isDecoderChunk(value: unknown): value is DecoderChunk {
  return isRecord(value) &&
    hasExactKeys(value, ["data", "timestamp", "duration", "key"]) &&
    value.data instanceof ArrayBuffer &&
    value.data.byteLength >= 1 &&
    Number.isSafeInteger(value.timestamp) &&
    Number(value.timestamp) >= 0 &&
    Number.isSafeInteger(value.duration) &&
    Number(value.duration) >= 0 &&
    typeof value.key === "boolean";
}

function isDecoderChunks(value: unknown): value is DecoderChunk[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > DECODER_RING_SIZE
  ) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || !isDecoderChunk(value[index])) return false;
  }
  return true;
}

function validRun(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): boolean {
  let actual: readonly PropertyKey[];
  try { actual = Reflect.ownKeys(value); }
  catch { return false; }
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}
