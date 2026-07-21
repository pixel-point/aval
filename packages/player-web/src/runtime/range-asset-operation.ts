import { FormatError } from "@pixel-point/aval-format";

import type { BoundedBodyByteLease } from "./bounded-body-reader.js";
import {
  RuntimePlaybackError,
  isRuntimePlaybackError,
  normalizeRuntimeFailure,
  type RuntimeFailureCode,
  type RuntimeFailureContext
} from "./errors.js";

export type RuntimeRangeLifecyclePhase =
  | "initial-range"
  | "manifest-prefix"
  | "front-index"
  | "payload-range";

interface CurrentRangeOperationInput {
  readonly generation: number;
  readonly request: { readonly signal: AbortSignal | null };
  readonly isGenerationCurrent: (generation: number) => boolean;
}

export function failureContext(
  input: { readonly generation: number },
  requestOrdinal: number,
  lifecyclePhase: RuntimeRangeLifecyclePhase
): Readonly<RuntimeFailureContext> {
  return Object.freeze({ generation: input.generation, requestOrdinal, lifecyclePhase });
}

export function normalizeRangeFailure(
  cause: unknown,
  context: Readonly<RuntimeFailureContext>
): RuntimePlaybackError {
  if (isRuntimePlaybackError(cause)) {
    return runtimeError(cause.code, {
      ...context,
      ...cause.failure.context
    });
  }
  if (cause instanceof FormatError) {
    return runtimeError("invalid-asset", {
      ...context,
      sourceCode: cause.code,
      ...(cause.offset === undefined ? {} : { offset: cause.offset }),
      ...(cause.path === undefined ? {} : { sourcePath: cause.path })
    });
  }
  if (cause instanceof DOMException && cause.name === "AbortError") {
    return runtimeError("abort", context);
  }
  return runtimeError("load-failure", context);
}

export function runtimeError(
  code: RuntimeFailureCode,
  context: Readonly<RuntimeFailureContext> = {}
): RuntimePlaybackError {
  return new RuntimePlaybackError(normalizeRuntimeFailure(code, undefined, context));
}

export function assertCurrent(
  input: Readonly<CurrentRangeOperationInput>,
  signal: AbortSignal
): void {
  if (!operationIsCurrent(input, signal)) throw runtimeError("abort");
}

export function operationIsCurrent(
  input: Readonly<CurrentRangeOperationInput>,
  signal: AbortSignal
): boolean {
  if (signal.aborted || input.request.signal?.aborted === true) return false;
  try { return input.isGenerationCurrent(input.generation) === true; } catch {
    return false;
  }
}

export function safeRelease(lease: BoundedBodyByteLease | null): void {
  if (lease === null) return;
  try { lease.release(); } catch {}
}
