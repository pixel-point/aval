export type CompilerErrorCode =
  | "ASSET_INVALID"
  | "AVC_PROFILE_INVALID"
  | "CANCELLED"
  | "CLI_USAGE"
  | "CONTINUITY_FAILED"
  | "FFMPEG_FAILED"
  | "FFMPEG_NOT_FOUND"
  | "FFMPEG_UNSUPPORTED"
  | "FRAME_RANGE_INVALID"
  | "INPUT_INVALID"
  | "IO_FAILED"
  | "OPAQUE_ONLY_M5"
  | "OUTPUT_LIMIT"
  | "PATH_OUTSIDE_ROOT"
  | "PROCESS_TIMEOUT"
  | "SOURCE_LIMIT"
  | "VFR_UNSUPPORTED";

export interface CompilerErrorDetails {
  readonly path?: string;
  readonly field?: string;
  readonly hint?: string;
  readonly cause?: unknown;
}

/** Stable diagnostic boundary for CLI, API, and subprocess failures. */
export class CompilerError extends Error {
  public declare readonly code: CompilerErrorCode;
  public declare readonly path?: string;
  public declare readonly field?: string;
  public declare readonly hint?: string;
  public declare readonly cause?: unknown;

  public constructor(
    code: CompilerErrorCode,
    message: string,
    details: CompilerErrorDetails = {}
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    Object.defineProperties(this, {
      name: { value: "CompilerError", writable: false },
      code: { value: code, enumerable: true, writable: false }
    });
    for (const key of ["path", "field", "hint", "cause"] as const) {
      if (details[key] !== undefined) {
        Object.defineProperty(this, key, {
          value: details[key],
          enumerable: key !== "cause",
          writable: false
        });
      }
    }
    Object.freeze(this);
  }
}

export interface CompilerDiagnostic {
  readonly severity: "error" | "warning" | "info";
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly field?: string;
  readonly hint?: string;
}

export function diagnosticFromError(error: unknown): CompilerDiagnostic {
  if (error instanceof CompilerError) {
    return Object.freeze({
      severity: "error",
      code: error.code,
      message: error.message,
      ...(error.path === undefined ? {} : { path: error.path }),
      ...(error.field === undefined ? {} : { field: error.field }),
      ...(error.hint === undefined ? {} : { hint: error.hint })
    });
  }
  return Object.freeze({
    severity: "error",
    code: "IO_FAILED",
    message: error instanceof Error ? error.message : "Unknown compiler failure"
  });
}

export function formatDiagnostic(diagnostic: CompilerDiagnostic): string {
  const location = [diagnostic.path, diagnostic.field]
    .filter((value): value is string => value !== undefined)
    .join(":");
  return [
    `${diagnostic.severity.toUpperCase()} ${diagnostic.code}`,
    location === "" ? undefined : location,
    diagnostic.message,
    diagnostic.hint === undefined ? undefined : `Hint: ${diagnostic.hint}`
  ].filter((value): value is string => value !== undefined).join(" — ");
}
