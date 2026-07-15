import {
  FORMAT_DEFAULT_BUDGETS,
  isAvcCodec,
  maximumAvcDecodedRgbaBytes,
  maximumAvcDecoderSurfaceDimension,
  validateCompleteAsset,
  type AccessUnitRecord,
  type AvcCodecV01,
  type CompiledManifestV01,
  type ParsedFrontIndex,
  type RenditionV01,
  type UnitV01
} from "@pixel-point/aval-format";
import {
  createDecoderWorkerClient,
  durationForFrame,
  timestampForFrame,
  type DecoderWorkerAvcConfig,
  type DecoderWorkerLimits,
  type DecoderWorkerMetrics,
  type DecoderWorkerSample,
  type ManagedDecoderWorkerFrame
} from "@pixel-point/aval-player-web";

const GENERATION = 1;
const IDLE_LOOP_OCCURRENCES = 1_001;
const MAX_BATCH_FRAMES = 12;
const WAIT_TIMEOUT_MS = 5_000;

type OpaqueRendition = Extract<
  RenditionV01,
  { readonly profile: "avc-annexb-opaque-v0" }
>;

interface FixtureUnit {
  readonly unit: UnitV01;
  readonly records: readonly AccessUnitRecord[];
}

interface FixtureContract {
  readonly bytes: Uint8Array;
  readonly frontIndex: ParsedFrontIndex;
  readonly rendition: OpaqueRendition;
  readonly renditionIndex: number;
  readonly intro: FixtureUnit;
  readonly idleBody: FixtureUnit;
  readonly bridge: FixtureUnit;
  readonly activeBody: FixtureUnit;
}

interface ReversibleFixtureContract {
  readonly bytes: Uint8Array;
  readonly frontIndex: ParsedFrontIndex;
  readonly rendition: OpaqueRendition;
  readonly unit: UnitV01 & { readonly kind: "reversible" };
  readonly records: readonly AccessUnitRecord[];
}

interface PlannedFrame {
  readonly ordinal: number;
  readonly generation: number;
  readonly unitId: string;
  readonly unitInstance: number;
  readonly unitFrame: number;
  readonly unitFrameCount: number;
  readonly type: EncodedVideoChunkType;
  readonly timestamp: number;
  readonly duration: number;
  readonly record: AccessUnitRecord;
}

export interface M5WorkerFrameEvidence {
  readonly ordinal: number;
  readonly generation: number;
  readonly unitId: string;
  readonly unitInstance: number;
  readonly unitFrame: number;
  readonly timestamp: number;
  readonly duration: number;
  readonly decodedBytes: number;
}

export interface M5WorkerColorSpaceEvidence {
  readonly fullRange: boolean | null;
  readonly matrix: VideoMatrixCoefficients | null;
  readonly primaries: VideoColorPrimaries | null;
  readonly transfer: VideoTransferCharacteristics | null;
}

export type M5WorkerSupport =
  | {
      readonly supported: true;
      readonly formatVersion: "0.1";
      readonly codec: AvcCodecV01;
      readonly codedWidth: number;
      readonly codedHeight: number;
      readonly assetBytes: number;
    }
  | {
      readonly supported: false;
      readonly reason: string;
      readonly formatVersion: "0.1";
      readonly codec: AvcCodecV01;
      readonly codedWidth: number;
      readonly codedHeight: number;
      readonly assetBytes: number;
    };

export interface M5WorkerProofReport {
  readonly asset: {
    readonly formatVersion: "0.1";
    readonly bytes: number;
    readonly renditionId: string;
    readonly codec: AvcCodecV01;
    readonly codedWidth: number;
    readonly codedHeight: number;
    readonly frameRate: {
      readonly numerator: number;
      readonly denominator: number;
    };
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
  readonly frames: readonly M5WorkerFrameEvidence[];
  readonly validatedOutputFrames: number;
  readonly colorSpaceVariants: readonly M5WorkerColorSpaceEvidence[];
  readonly credit: {
    readonly limits: DecoderWorkerLimits;
    readonly batchCount: number;
    readonly maxBatchFrames: number;
    readonly maxOutstandingFrames: number;
    readonly maxPendingSamples: number;
    readonly maxSubmittedFrames: number;
    readonly maxLeasedFrames: number;
    readonly maxLeasedDecodedBytes: number;
    readonly maxClientOpenFrames: number;
  };
  readonly metrics: DecoderWorkerMetrics;
  readonly clientOpenFrames: number;
  readonly disposed: true;
}

export interface M5WorkerErrorEvidence {
  readonly name: string;
  readonly message: string;
  readonly code: string | null;
  readonly fatal: boolean | null;
}

export interface M5WorkerNegativeProofReport {
  readonly unsupportedConfiguration: M5WorkerErrorEvidence;
  readonly malformedSample: M5WorkerErrorEvidence;
  readonly workerCrash: M5WorkerErrorEvidence;
  readonly watchdog: M5WorkerErrorEvidence;
  readonly abortSignal: M5WorkerErrorEvidence;
  readonly generationCancellation: M5WorkerErrorEvidence;
  readonly disposal: {
    readonly pendingWait: M5WorkerErrorEvidence;
    readonly idempotentPromise: boolean;
    readonly clientOpenFrames: 0;
  };
}

export interface M5ReversibleWorkerProofReport {
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
  readonly metrics: DecoderWorkerMetrics;
  readonly disposed: true;
}

/** Validates the compiled fixture before asking the browser for exact AVC support. */
export async function probeM5OpaqueAvcWorker(
  assetBase64: string
): Promise<M5WorkerSupport> {
  const fixture = readFixture(assetBase64);
  const config = decoderConfig(fixture.rendition);
  const common = {
    formatVersion: fixture.frontIndex.manifest.formatVersion,
    codec: fixture.rendition.codec,
    codedWidth: fixture.rendition.codedWidth,
    codedHeight: fixture.rendition.codedHeight,
    assetBytes: fixture.bytes.byteLength
  } as const;

  if (typeof VideoDecoder === "undefined") {
    return { supported: false, reason: "VideoDecoder is unavailable", ...common };
  }

  try {
    const support = await VideoDecoder.isConfigSupported(config);
    if (!support.supported || !isExactSupportedConfig(support.config, config)) {
      return {
        supported: false,
        reason: support.supported
          ? `browser changed the requested AVC configuration: ${JSON.stringify(
              support.config
            ).slice(0, 500)}`
          : `exact Annex B ${fixture.rendition.codec} configuration is unsupported`,
        ...common
      };
    }
  } catch (error) {
    return {
      supported: false,
      reason: `AVC support probe failed: ${errorMessage(error)}`,
      ...common
    };
  }
  return { supported: true, ...common };
}

/**
 * Decodes the complete M5 path through one dedicated worker and one decoder.
 * Every transferred VideoFrame is validated, recorded, and closed immediately.
 */
export async function runM5OpaqueAvcWorkerProof(
  assetBase64: string
): Promise<M5WorkerProofReport> {
  const fixture = readFixture(assetBase64);
  const plan = createPathPlan(fixture);
  const limits = decoderLimits(fixture.rendition);
  const client = createDecoderWorkerClient({ workerName: "m5-opaque-avc-proof" });
  let report: Omit<M5WorkerProofReport, "disposed"> | undefined;

  try {
    await client.configure({
      config: decoderConfig(fixture.rendition),
      avcProfile: {
        codedWidth: fixture.rendition.codedWidth,
        codedHeight: fixture.rendition.codedHeight,
        frameRate: fixture.frontIndex.manifest.frameRate,
        averageBitrate: fixture.rendition.bitrate.average,
        peakBitrate: fixture.rendition.bitrate.peak,
        cpbBufferBits: fixture.rendition.bitrate.peak,
        requireBt709LimitedRange: true,
        // M5 is a frozen v0 compatibility proof, not a live candidate path.
        quantizationPolicy: "fixed-qp26-v0"
      },
      expectedOutput: {
        codedWidth: fixture.rendition.codedWidth,
        codedHeight: fixture.rendition.codedHeight,
        displayWidth: fixture.rendition.codedWidth,
        displayHeight: fixture.rendition.codedHeight,
        visibleRect: {
          x: 0,
          y: 0,
          width: fixture.rendition.codedWidth,
          height: fixture.rendition.codedHeight
        },
        // Chromium may expose absent-but-noncontradictory color fields. The
        // worker still rejects full-range or non-BT.709 output independently.
        colorSpace: null
      },
      limits
    });
    await client.activateGeneration(GENERATION);

    const frames: M5WorkerFrameEvidence[] = [];
    const colorSpaces = new Map<string, M5WorkerColorSpaceEvidence>();
    const credit = {
      batchCount: 0,
      maxBatchFrames: 0,
      maxOutstandingFrames: 0,
      maxPendingSamples: 0,
      maxSubmittedFrames: 0,
      maxLeasedFrames: 0,
      maxLeasedDecodedBytes: 0,
      maxClientOpenFrames: 0
    };

    for (let start = 0; start < plan.length; start += MAX_BATCH_FRAMES) {
      const batchPlan = plan.slice(start, start + MAX_BATCH_FRAMES);
      const samples = batchPlan.map((frame) => sampleForFrame(frame, fixture.bytes));
      await client.submit(GENERATION, samples);
      credit.batchCount += 1;
      credit.maxBatchFrames = Math.max(credit.maxBatchFrames, samples.length);
      updateCreditEvidence(credit, await client.snapshotMetrics(), client.openFrames);

      await client.waitForFrames(batchPlan.length, { timeoutMs: WAIT_TIMEOUT_MS });
      updateCreditEvidence(credit, await client.snapshotMetrics(), client.openFrames);

      for (const expected of batchPlan) {
        const managed = client.takeFrame();
        if (managed === undefined) {
          fail(`decoded frame ${String(expected.ordinal)} was not queued`);
        }
        try {
          assertManagedMetadata(managed, expected);
          assertNativeOutput(managed, expected, fixture.rendition);
          const colorSpace = readColorSpace(managed.frame.colorSpace);
          colorSpaces.set(JSON.stringify(colorSpace), colorSpace);
          frames.push({
            ordinal: managed.ordinal,
            generation: managed.generation,
            unitId: managed.unitId,
            unitInstance: managed.unitInstance,
            unitFrame: managed.unitFrame,
            timestamp: managed.timestamp,
            duration: managed.duration,
            decodedBytes: managed.decodedBytes
          });
        } finally {
          managed.close();
        }
      }
      updateCreditEvidence(credit, await client.snapshotMetrics(), client.openFrames);
    }

    const metrics = await client.snapshotMetrics();
    assertSettledMetrics(metrics, plan.length, client.openFrames);
    report = {
      asset: {
        formatVersion: fixture.frontIndex.manifest.formatVersion,
        bytes: fixture.bytes.byteLength,
        renditionId: fixture.rendition.id,
        codec: fixture.rendition.codec,
        codedWidth: fixture.rendition.codedWidth,
        codedHeight: fixture.rendition.codedHeight,
        frameRate: fixture.frontIndex.manifest.frameRate
      },
      path: {
        introUnit: "intro",
        idleBodyUnit: "idle-body",
        idleLoopOccurrences: IDLE_LOOP_OCCURRENCES,
        idleLoopSeams: 1_000,
        edge: "idle-active",
        bridgeUnit: "bridge",
        targetBodyUnit: "active-body",
        occurrenceCount: IDLE_LOOP_OCCURRENCES + 3,
        frameCount: plan.length
      },
      frames,
      validatedOutputFrames: frames.length,
      colorSpaceVariants: [...colorSpaces.values()],
      credit: { limits, ...credit },
      metrics,
      clientOpenFrames: client.openFrames
    };
  } finally {
    await client.dispose();
  }

  if (report === undefined) {
    return fail("worker proof did not produce a report");
  }
  return { ...report, disposed: true };
}

/** Runs the browser-only failure and teardown matrix through real Workers. */
export async function runM5OpaqueAvcWorkerNegativeProof(
  assetBase64: string
): Promise<M5WorkerNegativeProofReport> {
  const fixture = readFixture(assetBase64);

  const unsupportedConfiguration = await configureFailure(
    fixture,
    new URL("./m5-unsupported-worker.ts", import.meta.url),
    "m5-unsupported-proof"
  );

  const malformedClient = createDecoderWorkerClient({
    workerName: "m5-malformed-proof",
    disposeTimeoutMs: 100
  });
  let malformedSample: M5WorkerErrorEvidence;
  try {
    await configureFixtureClient(malformedClient, fixture);
    await malformedClient.activateGeneration(1);
    const planned = createPathPlan(fixture)[0];
    if (planned === undefined) fail("malformed proof sample is missing");
    const sample = sampleForFrame(planned, fixture.bytes);
    const corrupted = new Uint8Array(sample.data.slice(0));
    corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
    malformedSample = await expectFailure(
      malformedClient.submit(1, [{ ...sample, data: corrupted.buffer }]),
      "malformed AVC sample unexpectedly succeeded"
    );
  } finally {
    await malformedClient.dispose();
  }

  const workerCrash = await configureFailure(
    fixture,
    new URL("./m5-crash-worker.ts", import.meta.url),
    "m5-crash-proof"
  );

  const lifecycleClient = createDecoderWorkerClient({
    workerName: "m5-lifecycle-proof",
    disposeTimeoutMs: 100
  });
  let watchdog: M5WorkerErrorEvidence;
  let abortSignal: M5WorkerErrorEvidence;
  let generationCancellation: M5WorkerErrorEvidence;
  let pendingWait: M5WorkerErrorEvidence;
  let idempotentPromise = false;
  try {
    await configureFixtureClient(lifecycleClient, fixture);
    await lifecycleClient.activateGeneration(1);
    watchdog = await expectFailure(
      lifecycleClient.waitForFrames(1, { timeoutMs: 10 }),
      "watchdog wait unexpectedly succeeded"
    );

    const controller = new AbortController();
    const abortWait = lifecycleClient.waitForFrames(1, {
      signal: controller.signal,
      timeoutMs: 1_000
    });
    controller.abort(new DOMException("intentional M5 cancellation", "AbortError"));
    abortSignal = await expectFailure(
      abortWait,
      "abortable wait unexpectedly succeeded"
    );

    const generationWait = lifecycleClient.waitForFrames(1, {
      timeoutMs: 1_000
    });
    await lifecycleClient.abortGeneration(1);
    generationCancellation = await expectFailure(
      generationWait,
      "generation wait unexpectedly succeeded"
    );

    await lifecycleClient.activateGeneration(2);
    const disposalWait = lifecycleClient.waitForFrames(1, {
      timeoutMs: 1_000
    });
    const firstDispose = lifecycleClient.dispose();
    const secondDispose = lifecycleClient.dispose();
    idempotentPromise = firstDispose === secondDispose;
    pendingWait = await expectFailure(
      disposalWait,
      "disposed wait unexpectedly succeeded"
    );
    await firstDispose;
  } finally {
    await lifecycleClient.dispose();
  }

  return {
    unsupportedConfiguration,
    malformedSample,
    workerCrash,
    watchdog,
    abortSignal,
    generationCancellation,
    disposal: {
      pendingWait,
      idempotentPromise,
      clientOpenFrames: requireZero(lifecycleClient.openFrames)
    }
  };
}

/** Decodes a compiled reversible unit twice as an ordinary forward stream. */
export async function runM5ReversibleUnitWorkerProof(
  assetBase64: string
): Promise<M5ReversibleWorkerProofReport> {
  const fixture = readReversibleFixture(assetBase64);
  const limits = decoderLimits(fixture.rendition);
  const client = createDecoderWorkerClient({
    workerName: "m5-reversible-forward-proof"
  });
  let report: Omit<M5ReversibleWorkerProofReport, "disposed"> | undefined;
  try {
    await client.configure({
      config: decoderConfig(fixture.rendition),
      avcProfile: avcProfile(fixture.rendition, fixture.frontIndex.manifest),
      expectedOutput: outputExpectation(fixture.rendition),
      limits
    });
    await client.activateGeneration(GENERATION);

    let ordinal = 0;
    for (let unitInstance = 0; unitInstance < 2; unitInstance += 1) {
      const plan = fixture.records.map((record, unitFrame): PlannedFrame => ({
        ordinal: ordinal++,
        generation: GENERATION,
        unitId: fixture.unit.id,
        unitInstance,
        unitFrame,
        unitFrameCount: fixture.unit.frameCount,
        type: record.key ? "key" : "delta",
        timestamp: timestampForFrame(
          ordinal - 1,
          fixture.frontIndex.manifest.frameRate
        ),
        duration: durationForFrame(
          ordinal - 1,
          fixture.frontIndex.manifest.frameRate
        ),
        record
      }));
      await client.submit(
        GENERATION,
        plan.map((frame) => sampleForFrame(frame, fixture.bytes))
      );
      await client.waitForFrames(plan.length, { timeoutMs: WAIT_TIMEOUT_MS });
      for (const expected of plan) {
        const managed = client.takeFrame();
        if (managed === undefined) fail("reversible proof frame was not queued");
        try {
          assertManagedMetadata(managed, expected);
          assertNativeOutput(managed, expected, fixture.rendition);
        } finally {
          managed.close();
        }
      }
    }
    const metrics = await client.snapshotMetrics();
    assertSettledMetrics(metrics, ordinal, client.openFrames);
    report = {
      asset: {
        formatVersion: fixture.frontIndex.manifest.formatVersion,
        renditionId: fixture.rendition.id,
        unitId: fixture.unit.id,
        frameCount: fixture.unit.frameCount
      },
      occurrences: 2,
      decodedFrames: ordinal,
      occurrenceStarts: [
        { ordinal: 0, unitFrame: 0, key: true },
        { ordinal: fixture.unit.frameCount, unitFrame: 0, key: true }
      ],
      metrics
    };
  } finally {
    await client.dispose();
  }
  if (report === undefined) fail("reversible proof did not produce a report");
  return { ...report, disposed: true };
}

async function configureFailure(
  fixture: FixtureContract,
  entryUrl: URL,
  workerName: string
): Promise<M5WorkerErrorEvidence> {
  const client = createDecoderWorkerClient({
    entryUrl,
    workerName,
    disposeTimeoutMs: 100
  });
  try {
    return await expectFailure(
      configureFixtureClient(client, fixture),
      `${workerName} unexpectedly configured`
    );
  } finally {
    await client.dispose();
  }
}

async function configureFixtureClient(
  client: ReturnType<typeof createDecoderWorkerClient>,
  fixture: FixtureContract
): Promise<void> {
  await client.configure({
    config: decoderConfig(fixture.rendition),
    avcProfile: avcProfile(fixture.rendition, fixture.frontIndex.manifest),
    expectedOutput: outputExpectation(fixture.rendition),
    limits: decoderLimits(fixture.rendition)
  });
}

function avcProfile(
  rendition: OpaqueRendition,
  manifest: CompiledManifestV01
) {
  return {
    codedWidth: rendition.codedWidth,
    codedHeight: rendition.codedHeight,
    frameRate: manifest.frameRate,
    averageBitrate: rendition.bitrate.average,
    peakBitrate: rendition.bitrate.peak,
    cpbBufferBits: rendition.bitrate.peak,
    requireBt709LimitedRange: true,
    // M5 fixtures intentionally retain the historical v0 quantizer contract.
    quantizationPolicy: "fixed-qp26-v0"
  } as const;
}

function outputExpectation(rendition: OpaqueRendition) {
  return {
    codedWidth: rendition.codedWidth,
    codedHeight: rendition.codedHeight,
    displayWidth: rendition.codedWidth,
    displayHeight: rendition.codedHeight,
    visibleRect: {
      x: 0,
      y: 0,
      width: rendition.codedWidth,
      height: rendition.codedHeight
    },
    colorSpace: null
  } as const;
}

async function expectFailure(
  operation: Promise<unknown>,
  successMessage: string
): Promise<M5WorkerErrorEvidence> {
  try {
    await operation;
  } catch (error) {
    const value = error as {
      readonly name?: unknown;
      readonly message?: unknown;
      readonly code?: unknown;
      readonly fatal?: unknown;
    };
    return {
      name: typeof value.name === "string" ? value.name : "Error",
      message:
        typeof value.message === "string" ? value.message.slice(0, 500) : String(error),
      code: typeof value.code === "string" ? value.code : null,
      fatal: typeof value.fatal === "boolean" ? value.fatal : null
    };
  }
  return fail(successMessage);
}

function requireZero(value: number): 0 {
  requireFixture(value === 0, "worker proof leaked client frames");
  return 0;
}

function readFixture(assetBase64: string): FixtureContract {
  const bytes = decodeBase64(assetBase64);
  const { frontIndex } = validateCompleteAsset({ bytes });
  const manifest = frontIndex.manifest;
  requireFixture(manifest.formatVersion === "0.1", "fixture must use format 0.1");
  requireFixture(manifest.initialState === "idle", "fixture initial state must be idle");
  requireFixture(manifest.renditions.length === 1, "fixture must have one rendition");
  const rendition = manifest.renditions[0];
  requireFixture(
    rendition?.profile === "avc-annexb-opaque-v0" &&
      isAvcCodec(rendition.codec),
    "fixture must have one opaque Annex B AVC rendition"
  );
  requireFixture(
    rendition.alphaLayout.colorRect[0] === 0 &&
      rendition.alphaLayout.colorRect[1] === 0 &&
      rendition.alphaLayout.colorRect[2] === rendition.codedWidth &&
      rendition.alphaLayout.colorRect[3] === rendition.codedHeight,
    "fixture opaque color rectangle must cover the coded frame"
  );
  requireFixture(
    manifest.canvas.width === rendition.codedWidth &&
      manifest.canvas.height === rendition.codedHeight,
    "fixture canvas and rendition dimensions must match"
  );
  requireGraphContract(manifest);

  return {
    bytes,
    frontIndex,
    rendition,
    renditionIndex: 0,
    intro: fixtureUnit(frontIndex, "intro", "one-shot", 0),
    idleBody: fixtureUnit(frontIndex, "idle-body", "body", 0),
    bridge: fixtureUnit(frontIndex, "bridge", "bridge", 0),
    activeBody: fixtureUnit(frontIndex, "active-body", "body", 0)
  };
}

function readReversibleFixture(
  assetBase64: string
): ReversibleFixtureContract {
  const bytes = decodeBase64(assetBase64);
  const { frontIndex } = validateCompleteAsset({ bytes });
  const manifest = frontIndex.manifest;
  requireFixture(manifest.renditions.length === 1, "fixture must have one rendition");
  const rendition = manifest.renditions[0];
  requireFixture(
    rendition?.profile === "avc-annexb-opaque-v0" &&
      isAvcCodec(rendition.codec),
    "reversible fixture must have one opaque AVC rendition"
  );
  const unitIndex = manifest.units.findIndex((candidate) => candidate.kind === "reversible");
  const candidate = manifest.units[unitIndex];
  requireFixture(
    candidate?.kind === "reversible",
    "fixture must contain a reversible unit"
  );
  const records = frontIndex.records.filter(
    (record) => record.unitIndex === unitIndex && record.renditionIndex === 0
  );
  requireFixture(
    records.length === candidate.frameCount && records[0]?.key === true,
    "reversible unit must have a complete independently keyed forward stream"
  );
  for (let frameIndex = 0; frameIndex < records.length; frameIndex += 1) {
    requireFixture(
      records[frameIndex]?.frameIndex === frameIndex,
      "reversible access units must be in canonical frame order"
    );
  }
  return { bytes, frontIndex, rendition, unit: candidate, records };
}

function requireGraphContract(manifest: CompiledManifestV01): void {
  requireFixture(manifest.states.length === 2, "fixture must have two states");
  const idle = manifest.states.find(({ id }) => id === "idle");
  const active = manifest.states.find(({ id }) => id === "active");
  requireFixture(
    idle?.bodyUnit === "idle-body" && idle.initialUnit === "intro",
    "idle state must use intro then idle-body"
  );
  requireFixture(
    active?.bodyUnit === "active-body" && active.initialUnit === undefined,
    "active state must use active-body"
  );
  requireFixture(manifest.edges.length === 1, "fixture must have one edge");
  const edge = manifest.edges[0];
  requireFixture(
    edge?.id === "idle-active" &&
      edge.from === "idle" &&
      edge.to === "active" &&
      edge.start.type === "portal" &&
      edge.transition?.kind === "locked" &&
      edge.transition.unit === "bridge",
    "idle-active must be the locked bridge route"
  );
  requireFixture(manifest.units.length === 4, "fixture must have four units");
}

function fixtureUnit(
  frontIndex: ParsedFrontIndex,
  id: string,
  kind: UnitV01["kind"],
  renditionIndex: number
): FixtureUnit {
  const unitIndex = frontIndex.manifest.units.findIndex((unit) => unit.id === id);
  const unit = frontIndex.manifest.units[unitIndex];
  requireFixture(unit?.kind === kind, `${id} must be a ${kind} unit`);
  requireFixture(unit.frameCount === 2, `${id} must contain exactly two frames`);
  if (unit.kind === "body") {
    requireFixture(unit.playback === "loop", `${id} must be a looping body`);
  }
  const records = frontIndex.records.filter(
    (record) =>
      record.unitIndex === unitIndex && record.renditionIndex === renditionIndex
  );
  requireFixture(records.length === 2, `${id} must have two selected samples`);
  requireFixture(
    records[0]?.frameIndex === 0 && records[0].key &&
      records[1]?.frameIndex === 1 && !records[1].key,
    `${id} samples must be independent key/delta pairs`
  );
  return { unit, records };
}

function createPathPlan(fixture: FixtureContract): readonly PlannedFrame[] {
  const occurrences: FixtureUnit[] = [fixture.intro];
  for (let iteration = 0; iteration < IDLE_LOOP_OCCURRENCES; iteration += 1) {
    occurrences.push(fixture.idleBody);
  }
  occurrences.push(fixture.bridge, fixture.activeBody);

  const plan: PlannedFrame[] = [];
  for (let unitInstance = 0; unitInstance < occurrences.length; unitInstance += 1) {
    const occurrence = occurrences[unitInstance];
    if (occurrence === undefined) fail("path occurrence is missing");
    for (let unitFrame = 0; unitFrame < occurrence.records.length; unitFrame += 1) {
      const record = occurrence.records[unitFrame];
      if (record === undefined) fail("path access unit is missing");
      const ordinal = plan.length;
      plan.push({
        ordinal,
        generation: GENERATION,
        unitId: occurrence.unit.id,
        unitInstance,
        unitFrame,
        unitFrameCount: occurrence.unit.frameCount,
        type: record.key ? "key" : "delta",
        timestamp: timestampForFrame(ordinal, fixture.frontIndex.manifest.frameRate),
        duration: durationForFrame(ordinal, fixture.frontIndex.manifest.frameRate),
        record
      });
    }
  }
  return plan;
}

function sampleForFrame(
  planned: PlannedFrame,
  assetBytes: Uint8Array
): DecoderWorkerSample {
  const end = planned.record.payloadOffset + planned.record.payloadLength;
  const data = assetBytes.slice(planned.record.payloadOffset, end).buffer;
  return {
    ordinal: planned.ordinal,
    unitId: planned.unitId,
    unitInstance: planned.unitInstance,
    unitFrame: planned.unitFrame,
    unitFrameCount: planned.unitFrameCount,
    type: planned.type,
    timestamp: planned.timestamp,
    duration: planned.duration,
    data
  };
}

function assertManagedMetadata(
  actual: ManagedDecoderWorkerFrame,
  expected: PlannedFrame
): void {
  const matches =
    actual.ordinal === expected.ordinal &&
    actual.generation === expected.generation &&
    actual.unitId === expected.unitId &&
    actual.unitInstance === expected.unitInstance &&
    actual.unitFrame === expected.unitFrame &&
    actual.timestamp === expected.timestamp &&
    actual.duration === expected.duration;
  requireFixture(matches, `decoded metadata mismatch at ordinal ${String(expected.ordinal)}`);
}

function assertNativeOutput(
  managed: ManagedDecoderWorkerFrame,
  expected: PlannedFrame,
  rendition: OpaqueRendition
): void {
  const frame = managed.frame;
  const rect = frame.visibleRect;
  const maximumCodedWidth = maximumAvcDecoderSurfaceDimension(
    rendition.codedWidth
  );
  const maximumCodedHeight = maximumAvcDecoderSurfaceDimension(
    rendition.codedHeight
  );
  requireFixture(
    frame.timestamp === expected.timestamp &&
      frame.duration === expected.duration &&
      frame.displayWidth === rendition.codedWidth &&
      frame.displayHeight === rendition.codedHeight &&
      rect !== null &&
      rect.x === 0 &&
      rect.y === 0 &&
      rect.width === rendition.codedWidth &&
      rect.height === rendition.codedHeight &&
      frame.codedWidth >= rect.x + rect.width &&
      frame.codedHeight >= rect.y + rect.height &&
      frame.codedWidth <= maximumCodedWidth &&
      frame.codedHeight <= maximumCodedHeight,
    `decoded VideoFrame mismatch at ordinal ${String(expected.ordinal)}`
  );
  const color = frame.colorSpace;
  requireFixture(
    matchesDecodedBt709ColorSpace(color),
    `decoded color metadata contradicts BT.709 limited range at ordinal ${String(
      expected.ordinal
    )}`
  );
  requireFixture(
    managed.decodedBytes === frame.codedWidth * frame.codedHeight * 4,
    `decoded byte accounting mismatch at ordinal ${String(expected.ordinal)}`
  );
}

function matchesDecodedBt709ColorSpace(color: VideoColorSpace): boolean {
  const limitedBt709 = color.fullRange !== true &&
    (color.matrix === null || color.matrix === "bt709") &&
    (color.primaries === null || color.primaries === "bt709") &&
    (color.transfer === null || color.transfer === "bt709");
  const webKitNormalizedBt709 = color.fullRange === true &&
    color.matrix === "bt709" &&
    color.primaries === "bt709" &&
    color.transfer === "iec61966-2-1";
  return limitedBt709 || webKitNormalizedBt709;
}

function updateCreditEvidence(
  credit: {
    maxOutstandingFrames: number;
    maxPendingSamples: number;
    maxSubmittedFrames: number;
    maxLeasedFrames: number;
    maxLeasedDecodedBytes: number;
    maxClientOpenFrames: number;
  },
  metrics: DecoderWorkerMetrics,
  clientOpenFrames: number
): void {
  credit.maxOutstandingFrames = Math.max(
    credit.maxOutstandingFrames,
    metrics.pendingSamples + metrics.submittedFrames + metrics.leasedFrames
  );
  credit.maxPendingSamples = Math.max(credit.maxPendingSamples, metrics.pendingSamples);
  credit.maxSubmittedFrames = Math.max(
    credit.maxSubmittedFrames,
    metrics.submittedFrames
  );
  credit.maxLeasedFrames = Math.max(credit.maxLeasedFrames, metrics.leasedFrames);
  credit.maxLeasedDecodedBytes = Math.max(
    credit.maxLeasedDecodedBytes,
    metrics.leasedDecodedBytes
  );
  credit.maxClientOpenFrames = Math.max(
    credit.maxClientOpenFrames,
    clientOpenFrames
  );
}

function assertSettledMetrics(
  metrics: DecoderWorkerMetrics,
  expectedFrames: number,
  clientOpenFrames: number
): void {
  requireFixture(metrics.configureCalls === 1, "worker must configure exactly once");
  requireFixture(
    metrics.resetCalls === 0 &&
      metrics.flushCalls === 0 &&
      metrics.boundaryFlushCalls === 0,
    "worker must not reset or flush"
  );
  requireFixture(
    metrics.acceptedSamples === expectedFrames &&
      metrics.submittedChunks === expectedFrames &&
      metrics.outputFrames === expectedFrames &&
      metrics.deliveredFrames === expectedFrames &&
      metrics.releasedFrames === expectedFrames,
    "worker frame counters must match the complete path"
  );
  requireFixture(
    metrics.staleFrames === 0 &&
      metrics.closedFrames === 0 &&
      metrics.pendingSamples === 0 &&
      metrics.submittedFrames === 0 &&
      metrics.leasedFrames === 0 &&
      metrics.leasedDecodedBytes === 0 &&
      metrics.decodeQueueSize === 0 &&
      metrics.errors === 0 &&
      clientOpenFrames === 0,
    "worker path must settle without stale output, errors, or frame leaks"
  );
  requireFixture(
    metrics.nextSubmissionOrdinal === expectedFrames &&
      metrics.nextOutputOrdinal === expectedFrames,
    "worker ordinals must settle at the complete path length"
  );
}

function decoderConfig(rendition: OpaqueRendition): DecoderWorkerAvcConfig {
  return {
    codec: rendition.codec,
    codedWidth: rendition.codedWidth,
    codedHeight: rendition.codedHeight,
    hardwareAcceleration: "no-preference",
    optimizeForLatency: true
  };
}

function decoderLimits(rendition: OpaqueRendition): DecoderWorkerLimits {
  const maximumSurfaceBytes = maximumAvcDecodedRgbaBytes(
    rendition.codedWidth,
    rendition.codedHeight
  );
  return {
    maxDecodeQueueSize: 8,
    maxPendingSamples: 12,
    maxOutstandingFrames: 12,
    maxDecodedBytes: Math.min(64 * 1024 * 1024, maximumSurfaceBytes * 12)
  };
}

function isExactSupportedConfig(
  value: VideoDecoderConfig | undefined,
  expected: DecoderWorkerAvcConfig
): boolean {
  if (value === undefined) return false;
  const returned = value as VideoDecoderConfig & {
    readonly flip?: boolean;
    readonly rotation?: number;
  };
  const keys = Object.keys(value);
  const allowedKeys = [
    "codec",
    "codedWidth",
    "codedHeight",
    "hardwareAcceleration",
    "optimizeForLatency",
    // Current WebCodecs returns these standardized no-op defaults even when
    // callers omit them. They do not alter the requested decode semantics.
    "flip",
    "rotation"
  ];
  return (
    keys.every((key) => allowedKeys.includes(key)) &&
    returned.codec === expected.codec &&
    returned.codedWidth === expected.codedWidth &&
    returned.codedHeight === expected.codedHeight &&
    returned.hardwareAcceleration === expected.hardwareAcceleration &&
    returned.optimizeForLatency === expected.optimizeForLatency &&
    (returned.flip === undefined || returned.flip === false) &&
    (returned.rotation === undefined || returned.rotation === 0) &&
    returned.description === undefined
  );
}

function readColorSpace(value: VideoColorSpace): M5WorkerColorSpaceEvidence {
  return {
    fullRange: value.fullRange,
    matrix: value.matrix,
    primaries: value.primaries,
    transfer: value.transfer
  };
}

function decodeBase64(value: string): Uint8Array {
  requireFixture(typeof value === "string" && value.length > 0, "asset base64 is required");
  const maximumBase64Length = Math.ceil(FORMAT_DEFAULT_BUDGETS.maxFileBytes / 3) * 4 + 4;
  requireFixture(value.length <= maximumBase64Length, "asset base64 exceeds the format budget");
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return fail("asset base64 is invalid");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function requireFixture(condition: boolean, message: string): asserts condition {
  if (!condition) fail(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "unknown support error";
}

function fail(message: string): never {
  throw new Error(`M5 worker proof: ${message}`);
}
