import { DecoderLocalFailureError } from "./decoder.js";
import { DecodedOutputIncompatibleError } from
  "./decoded-output-qualifier.js";

export type RetryableCandidateRejection =
  | Readonly<{ stage: "probe"; cause: "unsupported-config" }>
  | Readonly<{ stage: "configure"; cause: "configure-not-supported" }>
  | Readonly<{
      stage: "decode";
      cause:
        | "decode-not-supported"
        | "decode-encoding-rejected"
        | "decoded-metadata-incompatible";
    }>
  | Readonly<{
      stage: "flush";
      cause: "flush-not-supported" | "flush-encoding-rejected";
    }>
  | Readonly<{ stage: "output"; cause: "decoded-output-incompatible" }>;

export type ProvisionalCandidateOutcome<T> =
  | Readonly<{ kind: "selected"; value: T }>
  | Readonly<{
      kind: "retryable-rejection";
      rejection: Readonly<RetryableCandidateRejection>;
    }>;

export function unsupportedConfigCandidateOutcome(): Readonly<
  Extract<ProvisionalCandidateOutcome<never>, { kind: "retryable-rejection" }>
> {
  return retryableOutcome("probe", "unsupported-config");
}

export function retryableCandidateOutcome(
  failure: unknown
): Readonly<
  Extract<ProvisionalCandidateOutcome<never>, { kind: "retryable-rejection" }>
> | null {
  if (failure instanceof DecodedOutputIncompatibleError) {
    return retryableOutcome("output", "decoded-output-incompatible");
  }
  if (!(failure instanceof DecoderLocalFailureError)) return null;
  const local = failure.failure;
  if (local.kind === "unsupported-config") {
    return unsupportedConfigCandidateOutcome();
  }
  if (local.kind === "decoded-metadata-incompatible") {
    return retryableOutcome("decode", "decoded-metadata-incompatible");
  }
  if (local.phase === "configure") {
    return local.errorName === "NotSupportedError"
      ? retryableOutcome("configure", "configure-not-supported")
      : null;
  }
  if (local.phase === "decode") {
    return local.errorName === "NotSupportedError"
      ? retryableOutcome("decode", "decode-not-supported")
      : retryableOutcome("decode", "decode-encoding-rejected");
  }
  return local.errorName === "NotSupportedError"
    ? retryableOutcome("flush", "flush-not-supported")
    : retryableOutcome("flush", "flush-encoding-rejected");
}

function retryableOutcome<
  TStage extends RetryableCandidateRejection["stage"],
  TCause extends Extract<
    RetryableCandidateRejection,
    { stage: TStage }
  >["cause"]
>(stage: TStage, cause: TCause): Readonly<
  Extract<ProvisionalCandidateOutcome<never>, { kind: "retryable-rejection" }>
> {
  const rejection = Object.freeze({ stage, cause }) as Readonly<
    RetryableCandidateRejection
  >;
  return Object.freeze({ kind: "retryable-rejection", rejection });
}
