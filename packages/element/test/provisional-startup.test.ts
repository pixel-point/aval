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
  withProvisionalCandidateFrame
} from
  "../src/provisional-startup.js";
import {
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

  it("retires a progress-stalled AV1 candidate before qualifying VP9", async () => {
    const operations: string[] = [];
    const candidates = ["av1", "vp9"];
    let index = 0;

    const selected = await orchestrateProvisionalCandidates({
      next: async () => candidates[index++]!,
      qualify: async (candidate) => {
        operations.push(`qualify:${candidate}`);
        if (candidate === "av1") throw decoderProgressTimeout("decode");
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
      "qualify:av1",
      "retire:av1",
      "rejected:av1:decode-progress-timeout",
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
      { stage: "decode", cause: "decode-progress-timeout" },
      { stage: "decode", cause: "decoded-metadata-incompatible" },
      { stage: "flush", cause: "flush-not-supported" },
      { stage: "flush", cause: "flush-encoding-rejected" },
      { stage: "flush", cause: "flush-progress-timeout" },
      { stage: "output", cause: "decoded-output-incompatible" }
    ] as const satisfies readonly RetryableCandidateRejection[];

    expect(retryable).toHaveLength(10);
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
    expect(retryableCandidateOutcome(decoderProgressTimeout("flush"))).toEqual({
      kind: "retryable-rejection",
      rejection: {
        stage: "flush",
        cause: "flush-progress-timeout"
      }
    });
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
        operations.push("inspect");
        inspect(source);
        operations.push("upload");
      }
    });

    expect(operations).toEqual([
      "decode:bootstrap:2",
      "prime",
      "inspect",
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
            inspect(rgbaReference(frame, 96));
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
          if (kind === "materializer") throw terminal;
          if (kind === "renderer") {
            inspect(rgbaReference(frame));
            throw terminal;
          }
          inspect(rgbaReference(frame));
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

describe("provisional candidate frame lease", () => {
  it("drains and releases every frame through a witness beyond the decoder ring", async () => {
    const target = 17;
    const operations: string[] = [];
    let cancellations = 0;
    let leased = 0;
    let maximumLeased = 0;
    const frames = Array.from({ length: target + 1 }, (_, index) =>
      Object.freeze({ index }) as unknown as VideoFrame
    );

    await withProvisionalCandidateFrame({
      candidate: {
        unitId: "bootstrap",
        run: {
          frameCount: target + 1,
          take: async (index) => {
            if (leased >= 12) throw new Error("synthetic decoder credit exhausted");
            leased += 1;
            maximumLeased = Math.max(maximumLeased, leased);
            operations.push(`take:${String(index)}`);
            return frames[index]!;
          },
          release: (frame) => {
            const index = (frame as unknown as Readonly<{ index: number }>).index;
            operations.push(`release:${String(index)}`);
            leased -= 1;
          }
        },
        cancel: () => {
          cancellations += 1;
          operations.push("cancel");
        }
      },
      localFrame: target,
      signal: new AbortController().signal,
      use: async (decoded) => {
        operations.push(`use:${String(decoded.localFrame)}`);
        expect(decoded.frame).toBe(frames[target]);
      }
    });

    expect(operations).toEqual([
      ...Array.from({ length: target }, (_, index) => [
        `take:${String(index)}`,
        `release:${String(index)}`
      ]).flat(),
      `take:${String(target)}`,
      `use:${String(target)}`,
      `release:${String(target)}`,
      "cancel"
    ]);
    expect(maximumLeased).toBe(1);
    expect(leased).toBe(0);
    expect(cancellations).toBe(1);
  });

  it("cancels a candidate immediately when its qualification signal aborts", async () => {
    const controller = new AbortController();
    const reason = new DOMException("candidate replaced", "AbortError");
    let rejectTake!: (reason: unknown) => void;
    let cancellations = 0;
    const candidate = {
      unitId: "bootstrap",
      run: {
        frameCount: 18,
        take: () => new Promise<VideoFrame>((_resolve, reject) => {
          rejectTake = reject;
        }),
        release: vi.fn()
      },
      cancel: () => {
        cancellations += 1;
        rejectTake(reason);
      }
    };
    const attempt = withProvisionalCandidateFrame({
      candidate,
      localFrame: 17,
      signal: controller.signal,
      use: vi.fn()
    });
    await Promise.resolve();

    controller.abort(reason);

    await expect(attempt).rejects.toBe(reason);
    expect(cancellations).toBe(1);
    expect(candidate.run.release).not.toHaveBeenCalled();
  });

  it.each([-1, Number.NaN, 18])(
    "rejects invalid witness frame %s while retiring its candidate",
    async (localFrame) => {
      const take = vi.fn();
      const cancel = vi.fn();

      await expect(withProvisionalCandidateFrame({
        candidate: {
          unitId: "bootstrap",
          run: { frameCount: 18, take, release: vi.fn() },
          cancel
        },
        localFrame,
        signal: new AbortController().signal,
        use: vi.fn()
      })).rejects.toThrow("provisional witness frame identity is invalid");
      expect(take).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
    }
  );
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

function decoderProgressTimeout(
  phase: "decode" | "flush"
): DecoderLocalFailureError {
  const reason = new DOMException("AVAL decoder made no progress", "TimeoutError");
  return new DecoderLocalFailureError(Object.freeze({
    kind: "progress-timeout",
    phase
  }), reason);
}
