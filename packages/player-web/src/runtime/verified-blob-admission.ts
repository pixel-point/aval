import {
  RuntimePlaybackError,
  isRuntimePlaybackError,
  normalizeRuntimeFailure,
  type RuntimeFailureCode
} from "./errors.js";
import { Sha256IntegrityMismatchError } from "./sha256-verifier.js";

export type VerifiedBlobAdmissionMode = "copied" | "borrowed";

export class VerifiedBlobPromotionError extends Error {
  public declare readonly code: "integrity-mismatch" | "load-failure";

  public constructor(code: "integrity-mismatch" | "load-failure") {
    super("verified blob promotion failed");
    this.name = "VerifiedBlobPromotionError";
    this.code = code;
  }
}

export class StaleBlobLoadError extends Error {
  public constructor() {
    super("verified blob load is stale");
    this.name = "StaleBlobLoadError";
  }
}

export function normalizeVerifiedBlobLoaderFailure(cause: unknown): unknown {
  if (isRuntimePlaybackError(cause)) return cause;
  if (cause instanceof Sha256IntegrityMismatchError) {
    return verifiedBlobRuntimeError("integrity-mismatch");
  }
  if (cause instanceof DOMException && cause.name === "AbortError") {
    return verifiedBlobAbortError();
  }
  return verifiedBlobRuntimeError("load-failure");
}

export function normalizeVerifiedBlobPromotionFailure(cause: unknown): unknown {
  if (isRuntimePlaybackError(cause)) return cause;
  if (cause instanceof Sha256IntegrityMismatchError) {
    return verifiedBlobRuntimeError("integrity-mismatch");
  }
  if (cause instanceof VerifiedBlobPromotionError) {
    return verifiedBlobRuntimeError(cause.code);
  }
  return verifiedBlobRuntimeError("load-failure");
}

export function verifiedBlobRuntimeError(
  code: Extract<
    RuntimeFailureCode,
    "load-failure" | "integrity-mismatch" | "abort"
  >
): RuntimePlaybackError {
  return new RuntimePlaybackError(normalizeRuntimeFailure(code));
}

export function verifiedBlobAbortError(): DOMException {
  return new DOMException("verified blob wait was aborted", "AbortError");
}
