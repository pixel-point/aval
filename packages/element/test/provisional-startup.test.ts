import { describe, expect, it } from "vitest";

import { DecoderLocalFailureError } from "../src/decoder.js";
import {
  retryableCandidateOutcome,
  type RetryableCandidateRejection
} from "../src/provisional-candidate-outcome.js";
import { DecodedOutputIncompatibleError } from
  "../src/decoded-output-qualifier.js";
import { orchestrateProvisionalCandidates } from
  "../src/provisional-startup.js";

describe("provisional startup orchestration", () => {
  it("retires a typed rejection before touching the next authored candidate", async () => {
    const operations: string[] = [];
    const candidates = ["av1", "vp9", "h265"];
    let index = 0;

    const selected = await orchestrateProvisionalCandidates({
      next: async () => {
        const candidate = candidates[index++]!;
        operations.push(`next:${candidate}`);
        return candidate;
      },
      qualify: async (candidate) => {
        operations.push(`qualify:${candidate}`);
        if (candidate === "av1") throw decoderFailure(
          "decode",
          "EncodingError"
        );
      },
      localFailure: () => undefined,
      retire: async (candidate) => {
        operations.push(`retire:${candidate}`);
        return { retryAllowed: true };
      },
      cancelled: () => false,
      selected: (candidate) => operations.push(`selected:${candidate}`),
      rejected: (candidate, rejection) => {
        operations.push(`rejected:${candidate}:${rejection.cause}`);
      }
    });

    expect(selected).toBe("vp9");
    expect(operations).toEqual([
      "next:av1",
      "qualify:av1",
      "retire:av1",
      "rejected:av1:decode-encoding-rejected",
      "next:vp9",
      "qualify:vp9",
      "selected:vp9"
    ]);
    expect(index).toBe(2);
  });

  it.each([
    ["terminal local failure", new Error("renderer failed"), true],
    ["cleanup refusal", decoderFailure("decode", "EncodingError"), false]
  ] as const)("preserves %s without touching another candidate", async (
    _label,
    failure,
    retryAllowed
  ) => {
    const candidates = ["av1", "vp9"];
    let index = 0;
    const attempt = orchestrateProvisionalCandidates({
      next: async () => candidates[index++]!,
      qualify: async () => { throw failure; },
      localFailure: () => failure,
      retire: async () => ({ retryAllowed }),
      cancelled: () => false,
      selected: () => undefined,
      rejected: () => undefined
    });

    await expect(attempt).rejects.toBe(failure);
    expect(index).toBe(1);
  });

  it("keeps the retryable stage/cause matrix closed", () => {
    const retryable = [
      { stage: "probe", cause: "unsupported-config" },
      { stage: "configure", cause: "configure-not-supported" },
      { stage: "decode", cause: "decode-not-supported" },
      { stage: "decode", cause: "decode-encoding-rejected" },
      { stage: "decode", cause: "decoded-metadata-incompatible" },
      { stage: "flush", cause: "flush-not-supported" },
      { stage: "flush", cause: "flush-encoding-rejected" },
      { stage: "output", cause: "decoded-output-incompatible" }
    ] as const satisfies readonly RetryableCandidateRejection[];

    expect(retryable).toHaveLength(8);
    const renderer: RetryableCandidateRejection = {
      stage: "output",
      // @ts-expect-error renderer failures cannot inhabit the retryable union.
      cause: "renderer-failure"
    };
    const materializer: RetryableCandidateRejection = {
      stage: "output",
      // @ts-expect-error materializer failures cannot inhabit the retryable union.
      cause: "materializer-failure"
    };
    expect([renderer, materializer]).toHaveLength(2);
  });

  it("maps only the exact semantic-output and decoder-operation variants", () => {
    expect(retryableCandidateOutcome(
      new DecodedOutputIncompatibleError()
    )).toEqual({
      kind: "retryable-rejection",
      rejection: {
        stage: "output",
        cause: "decoded-output-incompatible"
      }
    });
    expect(retryableCandidateOutcome(
      decoderFailure("configure", "EncodingError")
    )).toBeNull();
    expect(retryableCandidateOutcome(new Error("transport failure"))).toBeNull();
  });
});

function decoderFailure(
  phase: "configure" | "decode" | "flush",
  errorName: "NotSupportedError" | "EncodingError"
): DecoderLocalFailureError {
  const reason = new Error("candidate decoder rejected the operation");
  reason.name = errorName;
  return new DecoderLocalFailureError(Object.freeze({
    kind: "operation-rejected",
    phase,
    errorName
  }), reason);
}
