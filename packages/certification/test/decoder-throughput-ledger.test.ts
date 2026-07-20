import { describe, expect, it } from "vitest";

import { evaluateDecoderThroughputLedger } from "../src/decoder-throughput-ledger.js";

const DEFAULT_RENDITION = Object.freeze({
  id: "alpha.1x",
  codecFamily: "h264",
  codec: "avc1.42E00B",
  bitDepth: 8,
  codedWidth: 64,
  codedHeight: 72,
  alphaLayout: {
    type: "stacked",
    colorRect: [0, 0, 64, 32],
    alphaRect: [0, 40, 64, 32]
  },
  frameRateNumerator: 30,
  frameRateDenominator: 1
});

function validLedger(
  selectedRendition: Record<string, unknown> = DEFAULT_RENDITION,
  submittedChunks = 324
): unknown {
  const warmup = 24;
  const measured = 300;
  const outputCount = warmup + measured;
  return {
    schemaVersion: "1.0",
    ledgerKind: "decoder-output-throughput",
    candidateManifestDigest: "a".repeat(64),
    fixtureDigest: "b".repeat(64),
    selectedRendition,
    outputs: Array.from({ length: outputCount }, (_, outputOrdinal) => ({
      outputOrdinal,
      phase: outputOrdinal < warmup ? "warmup" : "measured",
      mediaTimestampMicroseconds: outputOrdinal * 33_333,
      mediaDurationMicroseconds: 33_333,
      callbackMicroseconds: outputOrdinal * 10_000,
      renditionId: selectedRendition.id,
      unitId: "idle-body",
      unitInstance: Math.floor(outputOrdinal / 2),
      localFrame: outputOrdinal % 2
    })),
    events: [
      { eventOrdinal: 0, kind: "configure", atMicroseconds: 0, outputOrdinal: null },
      ...Array.from({ length: outputCount }, (_, outputOrdinal) => [
        { eventOrdinal: outputOrdinal * 2 + 1, kind: "output-callback", atMicroseconds: outputOrdinal * 10_000, outputOrdinal },
        { eventOrdinal: outputOrdinal * 2 + 2, kind: "frame-close", atMicroseconds: outputOrdinal * 10_000, outputOrdinal }
      ]).flat(),
      { eventOrdinal: outputCount * 2 + 1, kind: "terminal", atMicroseconds: outputCount * 10_000, outputOrdinal: null }
    ],
    terminal: {
      decoderClosed: true,
      configureCalls: 1,
      resetCalls: 0,
      flushCalls: 0,
      boundaryFlushCalls: 0,
      acceptedSamples: submittedChunks,
      submittedChunks,
      outputFrames: outputCount,
      deliveredFrames: outputCount,
      releasedFrames: outputCount,
      staleFrames: 0,
      workerClosedFrames: 0,
      errors: 0,
      openFrames: 0,
      pendingFrames: 0,
      decodeQueueSize: 0
    }
  };
}

describe("decoder throughput raw ledger", () => {
  it.each([
    ["h264", "avc1.42E00B", 8],
    ["h264", "avc1.64000A", 8],
    ["h265", "hvc1.1.6.L30.90", 8],
    ["vp9", "vp09.00.10.08.01.01.01.01.00", 8],
    ["av1", "av01.0.00M.10.0.110.01.01.01.0", 10]
  ] as const)("accepts a canonical %s rendition identity", (codecFamily, codec, bitDepth) => {
    const selectedRendition = { ...DEFAULT_RENDITION, codecFamily, codec, bitDepth };
    const result = evaluateDecoderThroughputLedger(validLedger(selectedRendition));
    expect(result.ledger.selectedRendition).toMatchObject({ codecFamily, codec, bitDepth });
    expect(result.evaluation.passed).toBe(true);
  });

  it("accepts an opaque rendition layout", () => {
    const selectedRendition = {
      ...DEFAULT_RENDITION,
      codedHeight: 32,
      alphaLayout: { type: "opaque", colorRect: [0, 0, 64, 32] }
    };
    expect(evaluateDecoderThroughputLedger(validLedger(selectedRendition)).evaluation.passed).toBe(true);
  });

  it.each([
    ["family mismatch", { codecFamily: "h265" }, /canonical h265 codec/u],
    ["unsupported non-AV1 depth", { codecFamily: "vp9", codec: "vp09.00.10.10.01.01.01.01.00", bitDepth: 10 }, /must be 8 for vp9/u],
    ["AV1 depth mismatch", { codecFamily: "av1", codec: "av01.0.00M.10.0.110.01.01.01.0", bitDepth: 8 }, /matching bit depth/u],
    ["noncanonical codec", { codec: "avc1.42e00B" }, /canonical h264 codec/u]
  ])("rejects %s", (_name, replacement, message) => {
    expect(() => evaluateDecoderThroughputLedger(validLedger({
      ...DEFAULT_RENDITION,
      ...replacement
    }))).toThrow(message);
  });

  it("rejects obsolete profile fields", () => {
    expect(() => evaluateDecoderThroughputLedger(validLedger({
      ...DEFAULT_RENDITION,
      profile: "removed-profile"
    }))).toThrow(/unknown field/u);
  });

  it("permits hidden chunks and multiple outputs per chunk", () => {
    expect(evaluateDecoderThroughputLedger(validLedger(DEFAULT_RENDITION, 327)).evaluation.passed).toBe(true);
    expect(evaluateDecoderThroughputLedger(validLedger(DEFAULT_RENDITION, 319)).evaluation.passed).toBe(true);
  });

  it("binds accepted samples to chunks and output counters to callbacks", () => {
    const accepted = validLedger() as any;
    accepted.terminal.acceptedSamples += 1;
    expect(evaluateDecoderThroughputLedger(accepted).evaluation.failures).toContain(
      "terminal-accepted-sample-count-mismatch"
    );

    const outputs = validLedger() as any;
    outputs.terminal.outputFrames -= 1;
    expect(evaluateDecoderThroughputLedger(outputs).evaluation.failures).toContain(
      "terminal-output-count:outputFrames"
    );
  });

  it("excludes warm-up and recomputes sample count, elapsed media time, and ratio", () => {
    const result = evaluateDecoderThroughputLedger(validLedger());
    expect(result.evaluation).toMatchObject({
      passed: true,
      warmupOutputs: 24,
      measuredOutputs: 300
    });
    expect(result.evaluation.elapsedMicroseconds).toBe(2_990_000);
    expect(result.evaluation.mediaDurationMicroseconds).toBe(9_966_567);
    expect(result.evaluation.ratioMillionths).toBeGreaterThan(3_000_000);
  });

  it.each([
    ["insufficient samples", (ledger: any) => {
      ledger.outputs.splice(-1, 1);
      ledger.events = ledger.events.filter((event: any) => event.outputOrdinal !== 323);
      ledger.events.at(-1).eventOrdinal -= 2;
      for (const name of ["outputFrames", "deliveredFrames", "releasedFrames"]) ledger.terminal[name] -= 1;
    }, "throughput-sample-count-below-300"],
    ["slow callbacks", (ledger: any) => { ledger.outputs.forEach((output: any) => { output.callbackMicroseconds = output.outputOrdinal * 30_000; }); }, "throughput-below-1.5x"],
    ["ordinal gap", (ledger: any) => { ledger.outputs[100].outputOrdinal += 1; }, "output-ordinal"],
    ["wrong rendition", (ledger: any) => { ledger.outputs[100].renditionId = "other"; }, "rendition-identity"],
    ["flush", (ledger: any) => { ledger.events.splice(-1, 0, { ...ledger.events.at(-1), kind: "flush" }); ledger.events.forEach((event: any, index: number) => { event.eventOrdinal = index; }); }, "forbidden-counter:flush"],
    ["missing close", (ledger: any) => { ledger.events = ledger.events.filter((event: any) => !(event.kind === "frame-close" && event.outputOrdinal === 100)); ledger.events.forEach((event: any, index: number) => { event.eventOrdinal = index; }); }, "frame-close"],
    ["callback mismatch", (ledger: any) => { ledger.events.find((event: any) => event.kind === "output-callback" && event.outputOrdinal === 100).atMicroseconds += 1; }, "output-callback-binding"]
  ])("rejects or fails %s", (_name, mutate, expected) => {
    const ledger = validLedger() as any;
    mutate(ledger);
    try {
      const result = evaluateDecoderThroughputLedger(ledger);
      expect(result.evaluation.passed).toBe(false);
      expect(result.evaluation.failures.join("\n")).toMatch(new RegExp(expected));
    } catch (error) {
      expect(String(error)).toMatch(new RegExp(expected));
    }
  });

  it("rejects fields that could smuggle a self-declared ratio", () => {
    const ledger = validLedger() as any;
    ledger.ratioMillionths = 9_999_999;
    expect(() => evaluateDecoderThroughputLedger(ledger)).toThrow(/unknown field/u);
  });
});
