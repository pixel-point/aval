import { describe, expect, it, vi } from "vitest";

import { DecoderLocalFailureError } from "../src/decoder.js";
import {
  decodedOutputIncompatibleCandidateOutcome,
  retryableCandidateOutcome,
  type RetryableCandidateRejection
} from "../src/provisional-candidate-outcome.js";
import { DecodedOutputIncompatibleError } from
  "../src/decoded-output-qualifier.js";
import {
  orchestrateProvisionalCandidates,
  qualifyProvisionalOutput,
  UnsupportedPlaybackProfileError
} from
  "../src/provisional-startup.js";
import {
  legacyPackedManifest,
  opaqueQualifiedManifest,
  packedQualifiedManifest,
  rgbaReference,
  witnessLayout
} from "./support/provisional-output-harness.js";

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

  it("maps semantic output only through its dedicated closed mapper", () => {
    expect(decodedOutputIncompatibleCandidateOutcome(
      new DecodedOutputIncompatibleError()
    )).toEqual({
      kind: "retryable-rejection",
      rejection: {
        stage: "output",
        cause: "decoded-output-incompatible"
      }
    });
    expect(retryableCandidateOutcome(
      new DecodedOutputIncompatibleError()
    )).toBeNull();
    expect(retryableCandidateOutcome(
      decoderFailure("configure", "EncodingError")
    )).toBeNull();
    expect(retryableCandidateOutcome(new Error("transport failure"))).toBeNull();
  });
});

describe("provisional decoded-output qualification", () => {
  it("qualifies the exact decoded witness identity before priming", async () => {
    const operations: string[] = [];
    const frame = {} as VideoFrame;
    const source = rgbaReference(frame);

    await qualifyProvisionalOutput({
      manifest: packedQualifiedManifest(),
      renditionId: "main",
      layout: witnessLayout,
      withDecodedFrame: async (unit, localFrame, use) => {
        operations.push(`decode:${unit}:${String(localFrame)}`);
        await use(Object.freeze({ frame, unit, localFrame }));
        operations.push("release-frame");
      },
      inspectAndPrime: async (actual, inspect) => {
        expect(actual).toBe(frame);
        operations.push("prime");
        await inspect(Object.freeze({
          frame: source.frame,
          rgba: async () => {
            operations.push("rgba");
            return source.rgba();
          }
        }));
        operations.push("upload");
      }
    });

    expect(operations).toEqual([
      "decode:bootstrap:2",
      "prime",
      "rgba",
      "upload",
      "release-frame"
    ]);
  });

  it("does no decode or renderer priming for opaque output", async () => {
    const decode = vi.fn();
    const prime = vi.fn();

    await qualifyProvisionalOutput({
      manifest: opaqueQualifiedManifest(),
      renditionId: "main",
      layout: witnessLayout,
      withDecodedFrame: decode,
      inspectAndPrime: prime
    });

    expect(decode).not.toHaveBeenCalled();
    expect(prime).not.toHaveBeenCalled();
  });

  it("rejects legacy packed-alpha as a typed terminal profile failure", async () => {
    const decode = vi.fn();
    const prime = vi.fn();

    const attempt = qualifyProvisionalOutput({
      manifest: legacyPackedManifest(),
      renditionId: "main",
      layout: witnessLayout,
      withDecodedFrame: decode,
      inspectAndPrime: prime
    });
    await expect(attempt).rejects.toMatchObject({
      name: "NotSupportedError"
    });
    await expect(attempt).rejects.toBeInstanceOf(UnsupportedPlaybackProfileError);
    expect(decode).not.toHaveBeenCalled();
    expect(prime).not.toHaveBeenCalled();
  });

  it("retries only a witnessed semantic mismatch after candidate retirement", async () => {
    const operations: string[] = [];
    const frame = {} as VideoFrame;
    let candidate = 0;
    const selected = await orchestrateProvisionalCandidates({
      next: async () => ++candidate,
      qualify: async (current) => {
        operations.push(`qualify:${String(current)}`);
        await qualifyProvisionalOutput({
          manifest: current === 1
            ? packedQualifiedManifest()
            : opaqueQualifiedManifest(),
          renditionId: "main",
          layout: witnessLayout,
          withDecodedFrame: async (unit, localFrame, use) => {
            await use(Object.freeze({ frame, unit, localFrame }));
          },
          inspectAndPrime: async (_actual, inspect) => {
            await inspect(rgbaReference(frame, 96));
          }
        });
      },
      localFailure: () => undefined,
      retire: async (current) => {
        operations.push(`retire:${String(current)}`);
        return { retryAllowed: true };
      },
      cancelled: () => false,
      selected: (current) => operations.push(`selected:${String(current)}`),
      rejected: (current, rejection) => {
        operations.push(`rejected:${String(current)}:${rejection.cause}`);
      }
    });

    expect(selected).toBe(2);
    expect(operations).toEqual([
      "qualify:1",
      "retire:1",
      "rejected:1:decoded-output-incompatible",
      "qualify:2",
      "selected:2"
    ]);
  });

  it.each([
    ["materializer", "copy failed"],
    ["renderer", "upload failed"],
    ["identity", "decoded witness frame identity is invalid"]
  ] as const)("keeps a %s failure terminal", async (kind, message) => {
    const terminal = new Error(message);
    const frame = {} as VideoFrame;
    let candidates = 0;
    const attempt = orchestrateProvisionalCandidates({
      next: async () => ++candidates,
      qualify: async () => qualifyProvisionalOutput({
        manifest: packedQualifiedManifest(),
        renditionId: "main",
        layout: witnessLayout,
        withDecodedFrame: async (unit, localFrame, use) => {
          await use(Object.freeze({
            frame,
            unit: kind === "identity" ? "wrong-unit" : unit,
            localFrame
          }));
        },
        inspectAndPrime: async (_actual, inspect) => {
          if (kind === "renderer") {
            await inspect(rgbaReference(frame));
            throw terminal;
          }
          await inspect(rgbaReference(frame, 48, terminal));
        }
      }),
      localFailure: () => undefined,
      retire: async () => ({ retryAllowed: true }),
      cancelled: () => false,
      selected: () => undefined,
      rejected: () => undefined
    });

    if (kind === "identity") await expect(attempt).rejects.toThrow(message);
    else await expect(attempt).rejects.toBe(terminal);
    expect(candidates).toBe(1);
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
