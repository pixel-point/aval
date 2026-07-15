import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";
import {
  maximumAvcDecodedRgbaBytes,
  type AvcCodecV01
} from "@pixel-point/aval-format";

interface BrowserSupport {
  readonly supported: boolean;
  readonly reason?: string;
  readonly formatVersion: "0.1";
  readonly codec: AvcCodecV01;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly assetBytes: number;
}

interface BrowserFrameEvidence {
  readonly ordinal: number;
  readonly generation: number;
  readonly unitId: string;
  readonly unitInstance: number;
  readonly unitFrame: number;
  readonly timestamp: number;
  readonly duration: number;
  readonly decodedBytes: number;
}

interface BrowserProofReport {
  readonly asset: {
    readonly formatVersion: "0.1";
    readonly bytes: number;
    readonly renditionId: string;
    readonly codec: AvcCodecV01;
    readonly codedWidth: number;
    readonly codedHeight: number;
    readonly frameRate: { readonly numerator: number; readonly denominator: number };
  };
  readonly path: {
    readonly introUnit: "intro";
    readonly idleBodyUnit: "idle-body";
    readonly idleLoopOccurrences: 1_001;
    readonly idleLoopSeams: 1_000;
    readonly edge: "idle-active";
    readonly bridgeUnit: "bridge";
    readonly targetBodyUnit: "active-body";
    readonly occurrenceCount: number;
    readonly frameCount: number;
  };
  readonly frames: readonly BrowserFrameEvidence[];
  readonly validatedOutputFrames: number;
  readonly colorSpaceVariants: readonly {
    readonly fullRange: boolean | null;
    readonly matrix: string | null;
    readonly primaries: string | null;
    readonly transfer: string | null;
  }[];
  readonly credit: {
    readonly limits: {
      readonly maxDecodeQueueSize: number;
      readonly maxPendingSamples: number;
      readonly maxOutstandingFrames: number;
      readonly maxDecodedBytes: number;
    };
    readonly batchCount: number;
    readonly maxBatchFrames: number;
    readonly maxOutstandingFrames: number;
    readonly maxPendingSamples: number;
    readonly maxSubmittedFrames: number;
    readonly maxLeasedFrames: number;
    readonly maxLeasedDecodedBytes: number;
    readonly maxClientOpenFrames: number;
  };
  readonly metrics: {
    readonly configureCalls: number;
    readonly resetCalls: number;
    readonly flushCalls: number;
    readonly boundaryFlushCalls: number;
    readonly acceptedSamples: number;
    readonly submittedChunks: number;
    readonly outputFrames: number;
    readonly deliveredFrames: number;
    readonly releasedFrames: number;
    readonly staleFrames: number;
    readonly closedFrames: number;
    readonly pendingSamples: number;
    readonly submittedFrames: number;
    readonly leasedFrames: number;
    readonly leasedDecodedBytes: number;
    readonly decodeQueueSize: number;
    readonly activeGeneration: number | null;
    readonly nextSubmissionOrdinal: number;
    readonly nextOutputOrdinal: number;
    readonly errors: number;
    readonly disposed: boolean;
  };
  readonly clientOpenFrames: number;
  readonly disposed: true;
}

interface BrowserErrorEvidence {
  readonly name: string;
  readonly message: string;
  readonly code: string | null;
  readonly fatal: boolean | null;
}

interface BrowserNegativeProofReport {
  readonly unsupportedConfiguration: BrowserErrorEvidence;
  readonly malformedSample: BrowserErrorEvidence;
  readonly workerCrash: BrowserErrorEvidence;
  readonly watchdog: BrowserErrorEvidence;
  readonly abortSignal: BrowserErrorEvidence;
  readonly generationCancellation: BrowserErrorEvidence;
  readonly disposal: {
    readonly pendingWait: BrowserErrorEvidence;
    readonly idempotentPromise: boolean;
    readonly clientOpenFrames: number;
  };
}

interface BrowserReversibleProofReport {
  readonly asset: {
    readonly formatVersion: "0.1";
    readonly renditionId: string;
    readonly unitId: string;
    readonly frameCount: number;
  };
  readonly occurrences: 2;
  readonly decodedFrames: number;
  readonly occurrenceStarts: readonly [
    { readonly ordinal: 0; readonly unitFrame: 0; readonly key: true },
    { readonly ordinal: number; readonly unitFrame: 0; readonly key: true }
  ];
  readonly metrics: BrowserProofReport["metrics"];
  readonly disposed: true;
}

interface BrowserHarness {
  probeM5OpaqueAvcWorker(assetBase64: string): Promise<BrowserSupport>;
  runM5OpaqueAvcWorkerProof(assetBase64: string): Promise<BrowserProofReport>;
  runM5OpaqueAvcWorkerNegativeProof(
    assetBase64: string
  ): Promise<BrowserNegativeProofReport>;
  runM5ReversibleUnitWorkerProof(
    assetBase64: string
  ): Promise<BrowserReversibleProofReport>;
}

const FIXTURE_PATH = fileURLToPath(
  new URL("../../fixtures/conformance/m5/opaque-path.avl", import.meta.url)
);
const FIXTURE_SHA256 =
  "21f9d8665eccd2f5a84a99ae2d4c61138d32a8700d1ab2b3f3f95c53d1c95a08";
const REVERSIBLE_FIXTURE_PATH = fileURLToPath(
  new URL("../../fixtures/conformance/m5/opaque-reversible.avl", import.meta.url)
);
const REVERSIBLE_FIXTURE_SHA256 =
  "ae5f059de4a16e76bf19787ba8348a378526edaf7619b0c4957dcfc08db4301d";
const EXPECTED_FRAME_COUNT = 2_008;

test("decodes the compiled opaque path through one dedicated worker", async ({
  page
}) => {
  test.setTimeout(90_000);
  const browserErrors = collectBrowserErrors(page);
  const fixture = await readFile(FIXTURE_PATH);
  const assetBase64 = fixture.toString("base64");
  const fixtureSha256 = createHash("sha256").update(fixture).digest("hex");

  // Use a same-origin module resource as the document so the existing demo UI
  // and its synthetic decoders are never started by this conformance test.
  await page.goto("/src/m5-worker-proof.ts");
  const support = await callHarness<BrowserSupport>(page, assetBase64, "probe");
  test.skip(
    !support.supported,
    `exact AVC worker configuration unsupported: ${support.reason ?? "no reason"}`
  );

  expect(support).toMatchObject({
    supported: true,
    formatVersion: "0.1",
    codec: "avc1.42E015",
    codedWidth: 32,
    codedHeight: 32,
    assetBytes: fixture.byteLength
  });
  expect(fixtureSha256).toBe(FIXTURE_SHA256);

  const report = await callHarness<BrowserProofReport>(page, assetBase64, "run");
  expect(report.asset).toEqual({
    formatVersion: "0.1",
    bytes: fixture.byteLength,
    renditionId: "opaque.1x",
    codec: "avc1.42E015",
    codedWidth: 32,
    codedHeight: 32,
    frameRate: { numerator: 30, denominator: 1 }
  });
  expect(report.path).toEqual({
    introUnit: "intro",
    idleBodyUnit: "idle-body",
    idleLoopOccurrences: 1_001,
    idleLoopSeams: 1_000,
    edge: "idle-active",
    bridgeUnit: "bridge",
    targetBodyUnit: "active-body",
    occurrenceCount: 1_004,
    frameCount: EXPECTED_FRAME_COUNT
  });
  expect(report.validatedOutputFrames).toBe(EXPECTED_FRAME_COUNT);
  expect(report.frames).toHaveLength(EXPECTED_FRAME_COUNT);
  assertExactPathMetadata(report.frames, report.asset.frameRate);

  expect(report.colorSpaceVariants.length).toBeGreaterThan(0);
  for (const color of report.colorSpaceVariants) {
    const limitedBt709 = color.fullRange !== true &&
      [null, "bt709"].includes(color.matrix) &&
      [null, "bt709"].includes(color.primaries) &&
      [null, "bt709"].includes(color.transfer);
    const webKitNormalizedBt709 = color.fullRange === true &&
      color.matrix === "bt709" &&
      color.primaries === "bt709" &&
      color.transfer === "iec61966-2-1";
    expect(limitedBt709 || webKitNormalizedBt709).toBe(true);
  }

  expect(report.credit).toMatchObject({
    limits: {
      maxDecodeQueueSize: 8,
      maxPendingSamples: 12,
      maxOutstandingFrames: 12,
      maxDecodedBytes: maximumAvcDecodedRgbaBytes(
        report.asset.codedWidth,
        report.asset.codedHeight
      ) * 12
    },
    batchCount: 168,
    maxBatchFrames: 12,
    maxClientOpenFrames: 12
  });
  expect(report.credit.maxOutstandingFrames).toBeLessThanOrEqual(12);
  expect(report.credit.maxPendingSamples).toBeLessThanOrEqual(12);
  expect(report.credit.maxSubmittedFrames).toBeLessThanOrEqual(12);
  expect(report.credit.maxLeasedFrames).toBeLessThanOrEqual(12);
  expect(report.credit.maxLeasedDecodedBytes).toBeLessThanOrEqual(
    report.credit.limits.maxDecodedBytes
  );

  expect(report.metrics).toMatchObject({
    configureCalls: 1,
    resetCalls: 0,
    flushCalls: 0,
    boundaryFlushCalls: 0,
    acceptedSamples: EXPECTED_FRAME_COUNT,
    submittedChunks: EXPECTED_FRAME_COUNT,
    outputFrames: EXPECTED_FRAME_COUNT,
    deliveredFrames: EXPECTED_FRAME_COUNT,
    releasedFrames: EXPECTED_FRAME_COUNT,
    staleFrames: 0,
    closedFrames: 0,
    pendingSamples: 0,
    submittedFrames: 0,
    leasedFrames: 0,
    leasedDecodedBytes: 0,
    decodeQueueSize: 0,
    activeGeneration: 1,
    nextSubmissionOrdinal: EXPECTED_FRAME_COUNT,
    nextOutputOrdinal: EXPECTED_FRAME_COUNT,
    errors: 0,
    disposed: false
  });
  expect(report.clientOpenFrames).toBe(0);
  expect(report.disposed).toBe(true);
  expect(browserErrors).toEqual([]);
});

test("decodes a reversible unit twice as independently keyed forward streams", async ({
  page
}) => {
  test.setTimeout(30_000);
  const browserErrors = collectBrowserErrors(page);
  const supportFixture = await readFile(FIXTURE_PATH);
  const fixture = await readFile(REVERSIBLE_FIXTURE_PATH);
  const fixtureSha256 = createHash("sha256").update(fixture).digest("hex");

  await page.goto("/src/m5-worker-proof.ts");
  const support = await callHarness<BrowserSupport>(
    page,
    supportFixture.toString("base64"),
    "probe"
  );
  test.skip(
    !support.supported,
    `exact AVC worker configuration unsupported: ${support.reason ?? "no reason"}`
  );
  expect(fixtureSha256).toBe(REVERSIBLE_FIXTURE_SHA256);

  const report = await page.evaluate(async (assetBase64) => {
    const moduleUrl = "/src/m5-worker-proof.ts";
    const harness = (await import(moduleUrl)) as unknown as BrowserHarness;
    return harness.runM5ReversibleUnitWorkerProof(assetBase64);
  }, fixture.toString("base64"));

  expect(report.asset).toEqual({
    formatVersion: "0.1",
    renditionId: "opaque.1x",
    unitId: "state-change",
    frameCount: 6
  });
  expect(report).toMatchObject({
    occurrences: 2,
    decodedFrames: 12,
    occurrenceStarts: [
      { ordinal: 0, unitFrame: 0, key: true },
      { ordinal: 6, unitFrame: 0, key: true }
    ],
    disposed: true
  });
  expect(report.metrics).toMatchObject({
    configureCalls: 1,
    resetCalls: 0,
    flushCalls: 0,
    boundaryFlushCalls: 0,
    acceptedSamples: 12,
    submittedChunks: 12,
    outputFrames: 12,
    deliveredFrames: 12,
    releasedFrames: 12,
    staleFrames: 0,
    closedFrames: 0,
    pendingSamples: 0,
    submittedFrames: 0,
    leasedFrames: 0,
    leasedDecodedBytes: 0,
    decodeQueueSize: 0,
    activeGeneration: 1,
    nextSubmissionOrdinal: 12,
    nextOutputOrdinal: 12,
    errors: 0,
    disposed: false
  });
  expect(browserErrors).toEqual([]);
});

test("contains unsupported, malformed, crash, watchdog, cancellation, and disposal failures", async ({
  page
}) => {
  test.setTimeout(30_000);
  const fixture = await readFile(FIXTURE_PATH);
  await page.goto("/src/m5-worker-proof.ts");
  const support = await callHarness<BrowserSupport>(
    page,
    fixture.toString("base64"),
    "probe"
  );
  test.skip(
    !support.supported,
    `exact AVC worker configuration unsupported: ${support.reason ?? "no reason"}`
  );
  const report = await page.evaluate(async (assetBase64) => {
    const moduleUrl = "/src/m5-worker-proof.ts";
    const harness = (await import(moduleUrl)) as unknown as BrowserHarness;
    return harness.runM5OpaqueAvcWorkerNegativeProof(assetBase64);
  }, fixture.toString("base64"));

  expect(report.unsupportedConfiguration).toMatchObject({
    name: "DecoderWorkerRemoteError",
    code: "DECODER_CONFIGURE_FAILED",
    fatal: true
  });
  expect(report.malformedSample).toMatchObject({
    name: "DecoderWorkerRemoteError",
    code: "DECODER_SUBMIT_FAILED",
    fatal: true
  });
  expect(report.workerCrash).toMatchObject({
    name: "DecoderWorkerTransportError",
    code: null,
    fatal: null
  });
  expect(report.workerCrash.message).toBe("decoder worker failed");
  expect(report.workerCrash.message).not.toContain(
    "intentional M5 conformance worker crash"
  );
  expect(report.watchdog).toMatchObject({
    name: "DecoderWorkerWatchdogError",
    code: null,
    fatal: null
  });
  expect(report.abortSignal).toMatchObject({
    name: "AbortError",
    code: null,
    fatal: null
  });
  expect(report.generationCancellation).toMatchObject({
    name: "DecoderWorkerGenerationAbortedError",
    code: null,
    fatal: null
  });
  expect(report.disposal).toEqual({
    pendingWait: expect.objectContaining({
      name: "AbortError",
      code: null,
      fatal: null
    }),
    idempotentPromise: true,
    clientOpenFrames: 0
  });
});

function assertExactPathMetadata(
  frames: readonly BrowserFrameEvidence[],
  frameRate: { readonly numerator: number; readonly denominator: number }
): void {
  for (let ordinal = 0; ordinal < frames.length; ordinal += 1) {
    const frame = frames[ordinal];
    expect(frame).toBeDefined();
    if (frame === undefined) continue;
    const expected = expectedUnitMetadata(ordinal);
    expect(frame).toMatchObject({
      ordinal,
      generation: 1,
      ...expected,
      timestamp: timestampForFrame(ordinal, frameRate),
      duration:
        timestampForFrame(ordinal + 1, frameRate) -
        timestampForFrame(ordinal, frameRate)
    });
    expect(frame.decodedBytes).toBeGreaterThanOrEqual(32 * 32 * 4);
    expect(frame.decodedBytes).toBeLessThanOrEqual(48 * 48 * 4);
  }
}

function expectedUnitMetadata(ordinal: number): {
  readonly unitId: string;
  readonly unitInstance: number;
  readonly unitFrame: number;
} {
  if (ordinal < 2) {
    return { unitId: "intro", unitInstance: 0, unitFrame: ordinal };
  }
  if (ordinal < 2_004) {
    const loopFrame = ordinal - 2;
    return {
      unitId: "idle-body",
      unitInstance: 1 + Math.floor(loopFrame / 2),
      unitFrame: loopFrame % 2
    };
  }
  if (ordinal < 2_006) {
    return { unitId: "bridge", unitInstance: 1_002, unitFrame: ordinal - 2_004 };
  }
  return {
    unitId: "active-body",
    unitInstance: 1_003,
    unitFrame: ordinal - 2_006
  };
}

function timestampForFrame(
  ordinal: number,
  rate: { readonly numerator: number; readonly denominator: number }
): number {
  const divisor = BigInt(rate.numerator);
  const dividend =
    BigInt(ordinal) * 1_000_000n * BigInt(rate.denominator);
  const quotient = dividend / divisor;
  const remainder = dividend % divisor;
  return Number(quotient + (remainder * 2n >= divisor ? 1n : 0n));
}

async function callHarness<T>(
  page: Page,
  assetBase64: string,
  operation: "probe" | "run"
): Promise<T> {
  return page.evaluate(
    async ({ base64, selectedOperation }) => {
      const moduleUrl = "/src/m5-worker-proof.ts";
      const harness = (await import(moduleUrl)) as unknown as BrowserHarness;
      return selectedOperation === "probe"
        ? harness.probeM5OpaqueAvcWorker(base64)
        : harness.runM5OpaqueAvcWorkerProof(base64);
    },
    { base64: assetBase64, selectedOperation: operation }
  ) as Promise<T>;
}

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (message.location().url.endsWith("/favicon.ico") && message.text().includes("404")) return;
    errors.push(message.text());
  });
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  return errors;
}
