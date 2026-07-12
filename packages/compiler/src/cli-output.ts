import {
  serializeCanonicalJsonWithLimits,
  type CanonicalJsonValue
} from "@rendered-motion/format";
import { boundedUtf8Text } from "./bounded-text.js";
import type { CompilerDiagnostic, CompilerErrorCode } from "./diagnostics.js";

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const decoder = new TextDecoder();
const MAX_JSON_STRING_BYTES = 4_096;
const CLI_JSON_LIMITS = Object.freeze({
  maxBytes: 32 * 1024 * 1024,
  maxDepth: 128,
  maxNodes: 1_000_000,
  maxStringBytes: MAX_JSON_STRING_BYTES
});

/** Emit exactly one canonical JSON value followed by one line feed. */
export function writeJsonResult(io: CliIo, value: unknown): void {
  io.stdout(canonicalJsonLine(value));
}

/** Emit one canonical diagnostic object as JSON Lines. */
export function writeJsonDiagnostic(io: CliIo, diagnostic: CompilerDiagnostic): void {
  io.stderr(canonicalJsonLine(diagnostic));
}

export function writeTextResult(io: CliIo, text: string): void {
  io.stdout(`${sanitizeTerminalBlock(text)}\n`);
}

export function writeTextDiagnostic(io: CliIo, diagnostic: CompilerDiagnostic): void {
  const location = [diagnostic.path, diagnostic.field]
    .filter((value): value is string => value !== undefined)
    .join(":");
  const pieces = [
    `${diagnostic.severity.toUpperCase()} ${diagnostic.code}`,
    location === "" ? undefined : location,
    diagnostic.message,
    diagnostic.hint === undefined ? undefined : `Hint: ${diagnostic.hint}`
  ].filter((value): value is string => value !== undefined);
  io.stderr(`${pieces.map(sanitizeTerminalText).join(" — ")}\n`);
}

/** Prevent media paths and tool diagnostics from injecting terminal controls. */
export function sanitizeTerminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "�");
}

function sanitizeTerminalBlock(value: string): string {
  return value
    .split("\n")
    .map((line) => sanitizeTerminalText(line))
    .join("\n");
}

export function exitStatusForCode(code: CompilerErrorCode): number {
  switch (code) {
    case "CANCELLED":
      return 130;
    case "FFMPEG_NOT_FOUND":
    case "FFMPEG_UNSUPPORTED":
    case "PROCESS_TIMEOUT":
    case "PATH_OUTSIDE_ROOT":
      return 3;
    case "AVC_PROFILE_INVALID":
    case "FFMPEG_FAILED":
    case "OPAQUE_ONLY_M5":
      return 4;
    case "ASSET_INVALID":
    case "OUTPUT_LIMIT":
      return 5;
    case "IO_FAILED":
      return 6;
    case "CLI_USAGE":
    case "CONTINUITY_FAILED":
    case "FRAME_RANGE_INVALID":
    case "INPUT_INVALID":
    case "SOURCE_LIMIT":
    case "VFR_UNSUPPORTED":
      return 2;
  }
}

function canonicalJsonLine(value: unknown): string {
  return `${decoder.decode(serializeCanonicalJsonWithLimits(
    jsonValue(value),
    CLI_JSON_LIMITS
  ))}\n`;
}

function jsonValue(value: unknown): CanonicalJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return typeof value === "string"
      ? boundedUtf8Text(value, MAX_JSON_STRING_BYTES)
      : value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      return String(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(jsonValue);
  }
  if (typeof value === "object") {
    const result: Record<string, CanonicalJsonValue> = Object.create(null) as Record<
      string,
      CanonicalJsonValue
    >;
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = jsonValue(item);
    }
    return result;
  }
  return String(value);
}
