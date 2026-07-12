import { CompilerError } from "./diagnostics.js";

/** Normalize caller cancellation at every compiler boundary. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new CompilerError("CANCELLED", "Compiler operation was cancelled", {
      cause: signal.reason
    });
  }
}
