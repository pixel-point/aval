import {
  FORMAT_DEFAULT_BUDGETS,
  maximumAvcDecodedRgbaBytes,
  validateCompleteAsset,
  type CompiledManifestV01
} from "@rendered-motion/format";
import type { GraphPresentation } from "@rendered-motion/graph";
import {
  BrowserStaticCanvasPlane,
  BrowserStaticSurfaceDecoder,
  DECODER_WORKER_HARD_LIMITS,
  IntegratedPlayer,
  RESOURCE_DECODE_SURFACE_COUNT,
  StaticSurfaceStore,
  asStaticSurfaceCatalog,
  createBrowserOpaqueCandidateComposition,
  createDecoderWorkerClient,
  createOpaqueRenditionCandidates,
  inspectOpaqueRenditionCandidate,
  installRuntimeAssetCatalog,
  timestampForFrame,
  type AllRoutesReadinessEvidence,
  type BrowserOpaqueCandidateComposition,
  type BrowserOpaqueCandidateSnapshot,
  type EffectHostEvent,
  type IntegratedCandidateFactory,
  type IntegratedCandidateAttempt,
  type IntegratedContentTickResult,
  type IntegratedPlaybackSession,
  type RuntimeFailure,
  type RuntimeMediaPresentation,
  type RuntimeOpaqueRenditionCandidate,
  type RuntimeReadinessResult,
  type StaticSurfaceStoreSnapshot
} from "@rendered-motion/player-web";

const MAX_SCRIPT_TICKS = 240;
const MIN_MANUAL_INTERVAL_FACTOR = 0.75;
const MIN_REALTIME_INTERVAL_FACTOR = 0.45;
const MAX_CONTINUOUS_INTERVAL_FACTOR = 1.75;
const MAX_MANUAL_P95_INTERVAL_FACTOR = 1.5;
const MAX_REALTIME_P95_INTERVAL_FACTOR = 1.65;
const MAX_AVERAGE_INTERVAL_FACTOR = 1.25;
const MAX_DRAW_SUBMISSION_LATENCY_FACTOR = 0.5;
const REALTIME_STARTUP_SLACK_FRAMES = 4;
const FIXTURE_SOURCE_ORDINALS = Object.freeze({
  intro: 0,
  "idle-body": 3,
  "hover-shift": 11,
  "hover-body": 17,
  "loading-bridge": 25,
  "loading-body": 26,
  "done-body": 29
} as const);
const TAG_COLUMNS = Object.freeze([
  0b000111,
  0b001011,
  0b001101,
  0b001110,
  0b010011,
  0b100011
]);

export interface M55CandidateSupport {
  readonly id: string;
  readonly rank: number;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly codedArea: number;
  readonly peakBitrate: number;
  readonly exactConfigSupported: boolean;
  readonly reason: string | null;
}

export interface M55BrowserSupport {
  readonly status: "supported" | "unsupported";
  readonly reason: string | null;
  readonly asset: {
    readonly formatVersion: "0.1";
    readonly bytes: number;
    readonly sha256: string;
    readonly readinessPolicy: "all-routes";
  };
  readonly codec: "avc1.42E020";
  readonly webCodecs: boolean;
  readonly moduleWorker: boolean;
  readonly webgl2: boolean;
  readonly staticPng: boolean;
  readonly vp8Substitution: false;
  readonly candidates: readonly Readonly<M55CandidateSupport>[];
}

export interface M55FrameEvidence {
  readonly tick: number;
  readonly graphKind: "intro" | "body" | "locked" | "reversible";
  readonly state: string | null;
  readonly edge: string | null;
  readonly unit: string;
  readonly localFrame: number;
  readonly drawSource: "resident" | "streaming";
  readonly runtimeTag: string | null;
  readonly expectedSourceOrdinal: number;
  readonly observedSourceOrdinal: number;
  readonly observedCode: number;
  readonly minimumLumaMargin: number;
}

interface M55RealtimeProofEvidence {
  readonly selectedRendition: string;
  readonly introBody: readonly string[];
  readonly observedFrames: readonly string[];
  readonly authoredFrameDurationMs: number;
  readonly startedAtMs: number;
  readonly displayCallbackTimestampsMs: readonly number[];
  readonly contentTickTimestampsMs: readonly number[];
  readonly contentDrawTimestampsMs: readonly number[];
  readonly minimumContentIntervalMs: number;
  readonly maximumContentIntervalMs: number;
  readonly p95ContentIntervalMs: number;
  readonly averageContentIntervalMs: number;
  readonly maximumDisplayCallbackIntervalMs: number;
  readonly p95DisplayCallbackIntervalMs: number;
  readonly maximumDrawSubmissionLatencyMs: number;
  readonly elapsedFromStartMs: number;
  readonly contentSpanMs: number;
  readonly loopSeams: number;
  readonly displayCallbacks: number;
  readonly advancedTicks: number;
  readonly underflows: number;
  readonly smoothSession: boolean;
  readonly parkedCallbacks: number;
  readonly workerConfigureCalls: number;
  readonly cleanup: {
    readonly playerDisposed: boolean;
    readonly realtimeDisposed: boolean;
    readonly cancelledCallbacks: number;
    readonly pendingCallbacks: number;
    readonly compositionComplete: boolean;
    readonly workerAlive: boolean;
    readonly rendererLiveResources: number;
    readonly staticRetainedSurfaces: number;
  };
}

interface OrderRecord {
  readonly sequence: number;
  readonly kind: "request" | "event" | "draw" | "static-draw" | "promise";
  readonly label: string;
  readonly requestedState: string | null;
  readonly visualState: string | null;
  readonly isTransitioning: boolean;
}

interface TrackedRequest {
  readonly label: string;
  readonly target: string;
  readonly requestTick: number;
  readonly requestSequence: number;
  promise: Promise<void>;
  outcome: "resolved" | "rejected" | null;
  errorName: string | null;
  settlementSequence: number | null;
}

interface ReadinessSummary {
  readonly policy: "all-routes";
  readonly passed: true;
  readonly warmupOutputs: number;
  readonly authoredFramesPerSecond: number;
  readonly measuredFramesPerSecond: number;
  readonly decodeLeadFrames: number;
  readonly ringCapacity: number;
  readonly directEdgeCount: number;
  readonly loopCount: number;
  readonly endpointCount: number;
  readonly allDeadlineSafe: true;
  readonly allWithinBudget: true;
  readonly resourcePassed: true;
  readonly initialRingPassed: true;
}

interface ReadinessSnapshotWithEvidence {
  readonly policy: "all-routes";
  readonly passed: boolean | null;
  readonly evaluation: BrowserOpaqueCandidateSnapshot["readiness"]["evaluation"];
  readonly evidence?: Readonly<AllRoutesReadinessEvidence> | null;
}

export interface M55IntegratedProofReport {
  readonly status: "supported";
  readonly support: M55BrowserSupport & { readonly status: "supported" };
  readonly selection: {
    readonly candidateOrder: readonly {
      readonly id: string;
      readonly codedArea: number;
      readonly peakBitrate: number;
      readonly rank: number;
    }[];
    readonly selectedRendition: string;
    readonly candidateOutcomes: readonly {
      readonly rendition: string;
      readonly rank: number;
      readonly outcome: "selected" | "rejected";
    }[];
  };
  readonly readiness: Readonly<ReadinessSummary>;
  readonly realtime: Readonly<M55RealtimeProofEvidence>;
  readonly cadence: {
    readonly authoredFrameDurationMs: number;
    readonly ticks: number;
    readonly maxObservedLatenessMs: number;
    readonly minimumObservedIntervalMs: number;
    readonly maximumObservedIntervalMs: number;
    readonly p95ObservedIntervalMs: number;
    readonly averageObservedIntervalMs: number;
    readonly elapsedMs: number;
    readonly burstDebtTicks: number;
    readonly underflows: number;
  };
  readonly frames: readonly Readonly<M55FrameEvidence>[];
  readonly waits: readonly {
    readonly edge: string;
    readonly policy: "portal" | "finish";
    readonly declaredMaximumTicks: number;
    readonly observedTicks: number;
  }[];
  readonly scenarios: {
    readonly introBody: readonly string[];
    readonly loopBoundary: readonly string[];
    readonly bridgeThenTarget: readonly string[];
    readonly finishTarget: string;
    readonly cut: {
      readonly requestTick: number;
      readonly targetTick: number;
      readonly target: string;
      readonly drawSource: "resident" | "streaming";
    };
    readonly activeReversal: {
      readonly requestTick: number;
      readonly adjacentTick: number;
      readonly fromFrame: number;
      readonly adjacentFrame: number;
      readonly drawSource: "resident" | "streaming";
    };
    readonly endpoints: readonly {
      readonly state: "idle" | "hover";
      readonly runwayFrames: number;
      readonly continuationPreparedByFrame: number;
      readonly observedFrame: string;
      readonly observedTick: number;
      readonly drawSource: "resident" | "streaming";
      readonly continuedWithoutUnderflow: boolean;
    }[];
    readonly lockedFollowOn: {
      readonly requested: "done";
      readonly converged: "done";
      readonly settled: true;
    };
    readonly latestWins: {
      readonly requested: readonly ["done", "idle"];
      readonly converged: "idle";
      readonly supersededRejected: true;
      readonly latestSettled: true;
    };
  };
  readonly ordering: {
    readonly records: readonly Readonly<OrderRecord>[];
    readonly animatedTransitionStartSequence: number;
    readonly animatedFirstDrawSequence: number;
    readonly animatedTargetDrawSequence: number;
    readonly animatedVisualStateSequence: number;
    readonly animatedTransitionEndSequence: number;
    readonly animatedPromiseSequence: number;
    readonly recoveryRequestSequence: number;
    readonly fallbackSequence: number;
    readonly staticDrawSequence: number;
    readonly visualStateSequence: number;
    readonly transitionEndSequence: number;
    readonly promiseSequence: number;
  };
  readonly recovery: {
    readonly failureInduced: true;
    readonly requestedState: "hover";
    readonly staticState: "hover";
    readonly readiness: "staticReady";
    readonly selectedRendition: null;
    readonly tickStatus: "stopped";
    readonly reason: "animation-failure";
  };
  readonly worker: {
    readonly configureCalls: number;
    readonly resetCalls: number;
    readonly flushCalls: number;
    readonly boundaryFlushCalls: number;
    readonly outputFrames: number;
    readonly deliveredFrames: number;
    readonly releasedFrames: number;
    readonly terminalReleaseGap: number;
    readonly terminalDisposed: true;
    readonly staleFrames: number;
    readonly closedFrames: number;
    readonly pendingSamples: number;
    readonly submittedFrames: number;
    readonly leasedFrames: number;
    readonly leasedDecodedBytes: number;
    readonly decodeQueueSize: number;
    readonly clientOpenFrames: number;
  };
  readonly cleanup: {
    readonly playerDisposed: boolean;
    readonly workerAlive: boolean;
    readonly workerPendingOperations: number;
    readonly workerPendingWaiters: number;
    readonly clientOpenFrames: number;
    readonly pendingSamples: number;
    readonly submittedFrames: number;
    readonly leasedFrames: number;
    readonly leasedDecodedBytes: number;
    readonly rendererState: string;
    readonly rendererLiveResources: number;
    readonly rendererUploads: number;
    readonly rendererStaleUploads: number;
    readonly rendererClosedSourceFrames: number;
    readonly staticStoreState: string;
    readonly staticRetainedSurfaces: number;
    readonly staticDecodedSurfaces: number;
    readonly staticClosedSurfaces: number;
    readonly pendingCallbacks: number;
    readonly pendingPromises: number;
    readonly traceRecords: number;
  };
}

/** Validate the complete checked asset before any browser capability claim. */
export async function probeM55IntegratedSupport(
  assetBase64: string
): Promise<Readonly<M55BrowserSupport>> {
  const bytes = decodeBase64(assetBase64);
  const { frontIndex } = validateCompleteAsset({ bytes });
  const manifest = frontIndex.manifest;
  requireProof(
    manifest.formatVersion === "0.1" &&
      manifest.readiness.policy === "all-routes",
    "M5.5 proof requires the all-routes format 0.1 fixture"
  );
  const candidates = createOpaqueRenditionCandidates(manifest.renditions);
  requireProof(candidates.length > 0, "M5.5 fixture has no opaque candidates");

  const webCodecs = typeof VideoDecoder !== "undefined";
  const staticPng =
    typeof createImageBitmap === "function" && typeof Blob !== "undefined";
  const webgl2 = probeWebGl2();
  const mainThreadCandidateSupport = await Promise.all(candidates.map(async (candidate) => {
    const rendition = candidate.rendition;
    const config = decoderConfig(rendition.codedWidth, rendition.codedHeight);
    let exactConfigSupported = false;
    let reason: string | null = null;
    if (!webCodecs) {
      reason = "VideoDecoder is unavailable";
    } else {
      try {
        const support = await VideoDecoder.isConfigSupported(config);
        exactConfigSupported =
          support.supported === true &&
          isExactSupportedConfig(support.config, config);
        if (!exactConfigSupported) {
          reason = support.supported
            ? "browser changed the requested AVC configuration"
            : "exact Annex B avc1.42E020 configuration is unsupported";
        }
      } catch (error) {
        reason = `AVC support probe failed: ${errorMessage(error)}`;
      }
    }
    return Object.freeze({
      id: rendition.id,
      rank: candidate.rank,
      codedWidth: rendition.codedWidth,
      codedHeight: rendition.codedHeight,
      codedArea: candidate.codedArea,
      peakBitrate: rendition.bitrate.peak,
      exactConfigSupported,
      reason
    });
  }));
  const workerSupport: Array<Readonly<{
    moduleWorker: boolean;
    exactConfigSupported: boolean;
    reason: string | null;
  }>> = [];
  for (const candidate of candidates) {
    workerSupport.push(await probePackagedDecoderWorker(bytes, candidate));
  }
  const moduleWorker = workerSupport.some(({ moduleWorker }) => moduleWorker);
  const candidateSupport = mainThreadCandidateSupport.map((candidate, index) => {
    const worker = workerSupport[index]!;
    return Object.freeze({
      ...candidate,
      exactConfigSupported:
        candidate.exactConfigSupported && worker.exactConfigSupported,
      reason: candidate.reason ?? worker.reason
    });
  });
  const hasExactCandidate = candidateSupport.some(({ exactConfigSupported }) =>
    exactConfigSupported
  );
  const reason = !moduleWorker
    ? workerSupport[0]?.reason ??
      "packaged decoder module worker is unavailable"
    : !webgl2
      ? "WebGL2 is unavailable"
      : !staticPng
        ? "browser PNG decoding is unavailable"
        : !hasExactCandidate
          ? candidateSupport.map((candidate) =>
              `${candidate.id}: ${candidate.reason ?? "unsupported"}`
            ).join("; ")
          : null;
  const report: M55BrowserSupport = {
    status: reason === null ? "supported" : "unsupported",
    reason,
    asset: {
      formatVersion: "0.1",
      bytes: bytes.byteLength,
      sha256: await sha256(bytes),
      readinessPolicy: "all-routes"
    },
    codec: "avc1.42E020",
    webCodecs,
    moduleWorker,
    webgl2,
    staticPng,
    vp8Substitution: false,
    candidates: candidateSupport
  };
  return deepFreeze(report);
}

async function probePackagedDecoderWorker(
  bytes: Uint8Array,
  candidate: Readonly<RuntimeOpaqueRenditionCandidate>
): Promise<Readonly<{
  moduleWorker: boolean;
  exactConfigSupported: boolean;
  reason: string | null;
}>> {
  if (typeof Worker === "undefined") {
    return Object.freeze({
      moduleWorker: false,
      exactConfigSupported: false,
      reason: "module Worker is unavailable"
    });
  }
  const catalog = installRuntimeAssetCatalog(bytes);
  let client: ReturnType<typeof createDecoderWorkerClient> | null = null;
  let moduleWorker = false;
  try {
    const inspected = inspectOpaqueRenditionCandidate(catalog, candidate);
    if (!inspected.ok) {
      return Object.freeze({
        moduleWorker: false,
        exactConfigSupported: false,
        reason: `packaged worker candidate inspection failed: ${
          inspected.report.failure?.message ?? "unknown inspection failure"
        }`
      });
    }
    const rendition = candidate.rendition;
    const parameterSet = inspected.inspection.parameterSet;
    const maxDecodedBytes = maximumAvcDecodedRgbaBytes(
      parameterSet.codedWidth,
      parameterSet.codedHeight
    ) * RESOURCE_DECODE_SURFACE_COUNT;
    requireProof(
      Number.isSafeInteger(maxDecodedBytes) &&
        maxDecodedBytes <= DECODER_WORKER_HARD_LIMITS.maxDecodedBytes,
      "packaged worker probe decoded-byte limit is unsafe"
    );
    client = createDecoderWorkerClient({
      requestTimeoutMs: 3_000,
      disposeTimeoutMs: 1_000,
      workerName: "rendered-motion-m55-support-probe"
    });
    await client.snapshotMetrics();
    moduleWorker = true;
    await client.configure({
      config: {
        codec: "avc1.42E020",
        codedWidth: rendition.codedWidth,
        codedHeight: rendition.codedHeight,
        hardwareAcceleration: "no-preference",
        optimizeForLatency: true
      },
      avcProfile: {
        codedWidth: rendition.codedWidth,
        codedHeight: rendition.codedHeight,
        frameRate: {
          numerator: catalog.manifest.frameRate.numerator,
          denominator: catalog.manifest.frameRate.denominator
        },
        averageBitrate: rendition.bitrate.average,
        peakBitrate: rendition.bitrate.peak,
        cpbBufferBits: rendition.bitrate.peak,
        requireBt709LimitedRange: true
      },
      expectedOutput: {
        codedWidth: parameterSet.codedWidth,
        codedHeight: parameterSet.codedHeight,
        displayWidth: parameterSet.crop.visibleWidth,
        displayHeight: parameterSet.crop.visibleHeight,
        visibleRect: {
          x: parameterSet.crop.left,
          y: parameterSet.crop.top,
          width: parameterSet.crop.visibleWidth,
          height: parameterSet.crop.visibleHeight
        },
        colorSpace: {
          fullRange: false,
          matrix: "bt709",
          primaries: "bt709",
          transfer: "bt709"
        }
      },
      limits: {
        maxDecodeQueueSize: DECODER_WORKER_HARD_LIMITS.maxDecodeQueueSize,
        maxPendingSamples: DECODER_WORKER_HARD_LIMITS.maxPendingSamples,
        maxOutstandingFrames: RESOURCE_DECODE_SURFACE_COUNT,
        maxDecodedBytes
      }
    });
    const metrics = await client.snapshotMetrics();
    requireProof(
      metrics.configureCalls === 1 && !metrics.disposed,
      "packaged worker probe did not configure exactly once"
    );
    return Object.freeze({
      moduleWorker: true,
      exactConfigSupported: true,
      reason: null
    });
  } catch (error) {
    return Object.freeze({
      moduleWorker,
      exactConfigSupported: false,
      reason: `packaged decoder module-worker probe failed: ${
        errorMessage(error)
      }`
    });
  } finally {
    if (client !== null) await client.dispose().catch(() => undefined);
    catalog.dispose();
  }
}

/**
 * Run one deterministic manual-tick script through the production browser
 * composition. Unsupported platforms return the same explicit probe result.
 */
export async function runM55IntegratedProof(
  assetBase64: string
): Promise<Readonly<M55IntegratedProofReport | M55BrowserSupport>> {
  const support = await probeM55IntegratedSupport(assetBase64);
  if (support.status === "unsupported") return support;
  const supportedSupport = support as M55BrowserSupport & {
    readonly status: "supported";
  };

  const bytes = decodeBase64(assetBase64);
  const { frontIndex } = validateCompleteAsset({ bytes });
  const manifest = frontIndex.manifest;
  // The public player forbids mixing its realtime owner with manual content
  // ticks. Prove the realtime path in a fully disposed session first, then run
  // the deterministic route script with a non-overlapping worker/renderer.
  const realtime = await runRealtimeIntroLoopProof(bytes, manifest);
  const animatedCanvas = document.createElement("canvas");
  const staticCanvas = document.createElement("canvas");
  const diagnostics: string[] = [];
  const order: OrderRecord[] = [];
  const frames: M55FrameEvidence[] = [];
  let sequence = 0;
  let activeTick = 0;
  let nextPresentationOrdinal = 1n;
  let pendingPromises = 0;
  let underflows = 0;
  let nextCadenceDeadlineMs = 0;
  let lastCadenceTickMs: number | null = null;
  let maxCadenceLatenessMs = 0;
  let minimumCadenceIntervalMs = Number.POSITIVE_INFINITY;
  const cadenceTimestampsMs: number[] = [];
  let burstDebtTicks = 0;
  let cadenceTicks = 0;
  const contentFrameDurationMs =
    1_000 * manifest.frameRate.denominator / manifest.frameRate.numerator;
  let player: IntegratedPlayer | null = null;
  let staticStore: StaticSurfaceStore | null = null;
  let finalReport: M55IntegratedProofReport | null = null;
  let disposed = false;

  const composition: BrowserOpaqueCandidateComposition =
    createBrowserOpaqueCandidateComposition({
      canvas: animatedCanvas,
      clock: { now: () => performance.now() },
      diagnosticsSink: (failure: Readonly<RuntimeFailure>) => diagnostics.push(
        `${failure.code}:${failure.message}`
      )
    });
  const controls = composition.controls;

  const record = (
    kind: OrderRecord["kind"],
    label: string
  ): number => {
    const snapshot = player?.snapshot() ?? null;
    const current = ++sequence;
    order.push(Object.freeze({
      sequence: current,
      kind,
      label,
      requestedState: snapshot?.requestedState ?? null,
      visualState: snapshot?.visualState ?? null,
      isTransitioning: snapshot?.isTransitioning ?? false
    }));
    return current;
  };

  const captureDraw = (
    presentation: Readonly<GraphPresentation>,
    media: Readonly<RuntimeMediaPresentation> | null,
    runtimeTag: string | null
  ): void => {
    requireProof(presentation.kind !== "static", "animated draw became static");
    const unit = presentation.unitId;
    const localFrame = presentation.frameIndex;
    const pixels = controls.readPixels();
    const decoded = decodeFixtureTag(pixels.rgba, pixels.width, pixels.height);
    const expectedSourceOrdinal = sourceOrdinal(unit, localFrame);
    requireProof(
      decoded.sourceOrdinal === expectedSourceOrdinal,
      `GPU tag mismatch for ${unit}:${String(localFrame)}; expected ${String(
        expectedSourceOrdinal
      )}, observed ${String(decoded.sourceOrdinal)}`
    );
    const state = presentation.kind === "body" || presentation.kind === "intro"
      ? presentation.state
      : null;
    const edge = presentation.kind === "locked" ||
        presentation.kind === "reversible"
      ? presentation.edgeId
      : null;
    const drawSource = media?.kind === "frame"
      ? media.drawSource
      : presentation.kind === "reversible"
        ? "resident"
        : "streaming";
    const drawTick = media?.kind === "frame"
      ? safeBigIntToNumber(media.intendedPresentationOrdinal)
      : activeTick;
    frames.push(Object.freeze({
      tick: drawTick,
      graphKind: presentation.kind,
      state,
      edge,
      unit,
      localFrame,
      drawSource,
      runtimeTag,
      expectedSourceOrdinal,
      observedSourceOrdinal: decoded.sourceOrdinal,
      observedCode: decoded.code,
      minimumLumaMargin: decoded.minimumLumaMargin
    }));
    record("draw", frameLabel(frames.at(-1)!));
  };

  const instrumentedFactory = instrumentCandidateFactory(
    composition.factory,
    captureDraw
  );

  try {
    player = new IntegratedPlayer({
      bytes,
      candidateFactory: instrumentedFactory,
      createStaticStore(catalog) {
        const plane = new BrowserStaticCanvasPlane(
          staticCanvas,
          (visible) => {
            if (visible) record("static-draw", "static-cover");
          }
        );
        const created = new StaticSurfaceStore(
          asStaticSurfaceCatalog(catalog),
          new BrowserStaticSurfaceDecoder(),
          plane
        );
        staticStore = created;
        return created;
      },
      eventSink(event) {
        record("event", eventLabel(event));
      },
      diagnosticsSink(failure) {
        diagnostics.push(`${failure.code}:${failure.message}`);
      },
      now: () => performance.now()
    });

    const request = (label: string, target: string): TrackedRequest => {
      const requestSequence = record("request", `${label}:${target}`);
      const tracked: TrackedRequest = {
        label,
        target,
        requestTick: latestFrame(frames).tick,
        requestSequence,
        promise: Promise.resolve(),
        outcome: null,
        errorName: null,
        settlementSequence: null
      };
      pendingPromises += 1;
      const promise = player!.requestState(target);
      tracked.promise = promise;
      void promise.then(
        () => {
          tracked.outcome = "resolved";
          tracked.settlementSequence = record("promise", `${label}:resolve`);
          pendingPromises -= 1;
        },
        (error: unknown) => {
          tracked.outcome = "rejected";
          tracked.errorName = error instanceof Error ? error.name : "unknown";
          tracked.settlementSequence = record(
            "promise",
            `${label}:reject:${tracked.errorName}`
          );
          pendingPromises -= 1;
        }
      );
      return tracked;
    };

    const waitForCadence = async (): Promise<void> => {
      const deadline = nextCadenceDeadlineMs;
      await waitForPresentationDeadline(deadline);
      const actual = performance.now();
      maxCadenceLatenessMs = Math.max(
        maxCadenceLatenessMs,
        Math.max(0, actual - deadline)
      );
      if (lastCadenceTickMs !== null) {
        const interval = actual - lastCadenceTickMs;
        minimumCadenceIntervalMs = Math.min(
          minimumCadenceIntervalMs,
          interval
        );
        if (
          interval <
            contentFrameDurationMs * MIN_MANUAL_INTERVAL_FACTOR
        ) burstDebtTicks += 1;
      }
      lastCadenceTickMs = actual;
      cadenceTimestampsMs.push(actual);
      cadenceTicks += 1;
      // Drop lateness debt. A late callback never causes catch-up ticks.
      nextCadenceDeadlineMs = actual + contentFrameDurationMs;
    };

    const advance = async (): Promise<Readonly<M55FrameEvidence>> => {
      await waitForCadence();
      activeTick = safeBigIntToNumber(nextPresentationOrdinal);
      const before = frames.length;
      const result = player!.tryContentTick({
        presentationOrdinal: nextPresentationOrdinal,
        rationalDeadlineUs: timestampForFrame(
          activeTick,
          manifest.frameRate
        )
      });
      if (result.status === "underflow") {
        underflows += 1;
        const browser = controls.snapshot();
        throw new Error(
          `continuous 30fps cadence underflowed at tick ${String(
            activeTick
          )}; last=${frameLabel(latestFrame(frames))}; player=${safeStringify(
            player!.snapshot()
          )}; browser=${safeStringify({
            scheduler: browser.playback.scheduler,
            cut: browser.playback.cut,
            reversible: browser.playback.reversible,
            worker: browser.worker,
            diagnostics: browser.diagnostics,
            trace: player!.getTrace().slice(-6)
          })}; diagnostics=${diagnostics.join("|")}`
        );
      }
      if (result.status === "stopped") {
        await player!.settled().catch(() => undefined);
        await controls.settled().catch(() => undefined);
        const browser = controls.snapshot();
        throw new Error(
          `animated playback stopped before induced recovery at tick ${String(
            activeTick
          )}; last=${frameLabel(latestFrame(frames))}; player=${JSON.stringify(
            player!.snapshot()
          )}; browser=${safeStringify({
            scheduler: browser.playback.scheduler,
            cut: browser.playback.cut,
            reversible: browser.playback.reversible,
            diagnostics: browser.diagnostics,
            trace: player!.getTrace().slice(-6)
          })}; diagnostics=${diagnostics.join("|")}`
        );
      }
      requireProof(
        frames.length === before + 1,
        "advanced content tick did not draw exactly one frame"
      );
      nextPresentationOrdinal += 1n;
      return latestFrame(frames);
    };

    const advanceUntil = async (
      predicate: (frame: Readonly<M55FrameEvidence>) => boolean,
      label: string,
      maximumTicks = MAX_SCRIPT_TICKS
    ): Promise<Readonly<M55FrameEvidence>> => {
      for (let count = 0; count < maximumTicks; count += 1) {
        let frame: Readonly<M55FrameEvidence>;
        try {
          frame = await advance();
        } catch (error) {
          throw new Error(`while advancing to ${label}: ${errorMessage(error)}`);
        }
        if (predicate(frame)) return frame;
      }
      throw new Error(`manual script did not reach ${label}`);
    };

    activeTick = 0;
    const prepared = await player.prepare({ timeoutMs: 30_000 });
    requireAnimated(prepared, diagnostics, controls.snapshot());
    await controls.settled();
    lastCadenceTickMs = performance.now();
    cadenceTimestampsMs.push(lastCadenceTickMs);
    nextCadenceDeadlineMs = lastCadenceTickMs + contentFrameDurationMs;
    const preparedSnapshot = controls.snapshot();
    requireProof(frames.length === 1, "activation must draw exactly frame zero");
    requireProof(
      frameLabel(frames[0]!) === "intro:0",
      "activation must draw intro frame zero"
    );
    requireProof(
      preparedSnapshot.activeRendition === prepared.report.selectedRendition,
      "browser composition and player selected different renditions"
    );

    await advanceUntil(
      (frame) => frame.unit === "idle-body" && frame.localFrame === 0,
      "intro into idle body zero"
    );
    const introBody = frames.slice(0, 4).map(frameLabel);
    requireLabels(
      introBody,
      ["intro:0", "intro:1", "intro:2", "idle-body:0"],
      "intro/body order"
    );

    let loopBoundary: readonly M55FrameEvidence[] | null = null;
    for (let count = 0; count < 16 && loopBoundary === null; count += 1) {
      const current = await advance();
      const previous = frames.at(-2);
      if (
        previous?.unit === "idle-body" &&
        previous.localFrame === 7 &&
        current.unit === "idle-body" &&
        current.localFrame === 0
      ) loopBoundary = Object.freeze([previous, current]);
    }
    requireProof(loopBoundary !== null, "idle loop did not cross a continuous seam");

    const idleHover = request("idle-hover", "hover");
    const forwardStart = await advanceUntil(
      (frame) => frame.graphKind === "reversible" &&
        frame.edge === "idle-hover" && frame.localFrame === 0,
      "idle-hover reversible entry"
    );
    const hoverEndpointContinuation = await advanceUntil(
      (frame) => frame.unit === "hover-body" && frame.localFrame === 6,
      "hover endpoint continuation"
    );
    await settleRequest(idleHover);
    requireProof(idleHover.outcome === "resolved", "idle-hover did not settle");

    const hoverIdleForInverse = request("hover-idle-inverse", "idle");
    await advanceUntil(
      (frame) => frame.graphKind === "reversible" &&
        frame.edge === "hover-idle" && frame.localFrame === 4,
      "hover-idle reversible interior"
    );
    const reversalFrom = latestFrame(frames);
    const inverse = request("active-inverse", "hover");
    const adjacent = await advance();
    requireProof(
      adjacent.graphKind === "reversible" &&
        Math.abs(adjacent.localFrame - reversalFrom.localFrame) === 1 &&
        adjacent.drawSource === "resident",
      "active reversal did not draw the adjacent resident frame"
    );
    await advanceUntil(
      (frame) => frame.unit === "hover-body" && frame.localFrame === 0,
      "active inverse convergence"
    );
    await settleRequest(hoverIdleForInverse);
    await settleRequest(inverse, () => ({
      player: player!.snapshot(),
      browser: controls.snapshot().playback,
      frames: frames.slice(-10),
      trace: player!.getTrace().slice(-10),
      order: order.slice(-10)
    }));
    requireProof(
      hoverIdleForInverse.outcome === "rejected" &&
        hoverIdleForInverse.errorName === "AbortError" &&
        inverse.outcome === "resolved",
      "active inverse request settlement diverged"
    );

    const hoverIdle = request("hover-idle", "idle");
    const reverseStart = await advanceUntil(
      (frame) => frame.graphKind === "reversible" &&
        frame.edge === "hover-idle" && frame.localFrame === 5,
      "hover-idle reversible entry"
    );
    const idleEndpointContinuation = await advanceUntil(
      (frame) => frame.unit === "idle-body" && frame.localFrame === 6,
      "idle endpoint continuation"
    );
    await settleRequest(hoverIdle);
    requireProof(hoverIdle.outcome === "resolved", "hover-idle did not settle");

    const loading = request("loading-route", "loading");
    const bridge = await advanceUntil(
      (frame) => frame.unit === "loading-bridge" && frame.localFrame === 0,
      "loading bridge"
    );
    const doneFollowOn = request("locked-follow-on", "done");
    const bridgeTarget = await advance();
    requireProof(
      bridgeTarget.unit === "loading-body" && bridgeTarget.localFrame === 0,
      "one-frame bridge was not followed by loading frame zero"
    );
    const done = await advanceUntil(
      (frame) => frame.unit === "done-body" && frame.localFrame === 0,
      "finite finish into done"
    );
    await settleRequest(loading);
    await settleRequest(doneFollowOn);
    requireProof(
      loading.outcome === "rejected" &&
        loading.errorName === "AbortError" &&
        doneFollowOn.outcome === "resolved",
      "locked follow-on did not replace and settle the intermediate request"
    );

    const doneIdle = request("done-idle", "idle");
    const idleAfterDone = await advanceUntil(
      (frame) => frame.unit === "idle-body" && frame.localFrame === 0 &&
        frame.tick > done.tick,
      "transitionless done-idle portal"
    );
    await settleRequest(doneIdle);
    requireProof(doneIdle.outcome === "resolved", "done-idle did not settle");

    const loadingForCut = request("loading-for-cut", "loading");
    await advanceUntil(
      (frame) => frame.unit === "loading-bridge" && frame.tick > idleAfterDone.tick,
      "cut setup bridge"
    );
    await advanceUntil(
      (frame) => frame.unit === "loading-body" && frame.localFrame === 0 &&
        frame.tick > idleAfterDone.tick,
      "cut setup target"
    );
    await settleRequest(loadingForCut);
    requireProof(loadingForCut.outcome === "resolved", "cut setup did not settle");
    const cutRequest = request("loading-idle-cut", "idle");
    const cutTarget = await advance();
    requireProof(
      cutTarget.tick === cutRequest.requestTick + 1 &&
        cutTarget.unit === "idle-body" &&
        cutTarget.localFrame === 0 &&
        cutTarget.drawSource === "resident",
      "cut did not present resident target frame zero on the next tick"
    );
    await settleRequest(cutRequest);
    requireProof(cutRequest.outcome === "resolved", "cut request did not settle");

    const loadingLatest = request("latest-loading", "loading");
    await advanceUntil(
      (frame) => frame.unit === "loading-bridge" && frame.tick > cutTarget.tick,
      "latest-wins bridge"
    );
    const supersededDone = request("latest-done", "done");
    const latestIdle = request("latest-idle", "idle");
    const latestIdleFrame = await advanceUntil(
      (frame) => frame.unit === "idle-body" && frame.localFrame === 0 &&
        frame.tick > cutTarget.tick,
      "latest-wins idle convergence"
    );
    await settleRequest(loadingLatest);
    await settleRequest(supersededDone);
    await settleRequest(latestIdle);
    requireProof(
      supersededDone.outcome === "rejected" &&
        supersededDone.errorName === "AbortError" &&
        latestIdle.outcome === "resolved" &&
        latestIdleFrame.state === "idle",
      "latest locked follow-on did not win"
    );

    // Drain tracked normal-route work before deliberately terminating the
    // worker. Frames still locally owned at the failure boundary are closed
    // without release commands because that transport no longer exists; the
    // bounded terminal gap is reported separately from live-resource cleanup.
    await controls.settled();
    const recoveryRequest = request("recovery-hover", "hover");
    controls.induceWorkerFailure();
    const recoveryTick = await driveUntilStopped(
      player,
      manifest,
      () => {
        activeTick = safeBigIntToNumber(nextPresentationOrdinal);
        return nextPresentationOrdinal;
      },
      () => {
        nextPresentationOrdinal += 1n;
      },
      waitForCadence
    );
    await player.settled();
    await settleRequest(recoveryRequest);
    const recoveryReady = await player.prepare();
    requireStaticRecovery(recoveryReady);
    // Static recovery commits before every worker release acknowledgement is
    // necessarily reflected by the proof controls. Drain this terminal
    // boundary once before asserting exact frame accounting; content ticks do
    // not use settled() and remain a real continuous cadence.
    await controls.settled();
    const recoverySnapshot = player.snapshot();
    requireProof(
      recoverySnapshot.requestedState === "hover" &&
        recoverySnapshot.visualState === "hover" &&
        recoverySnapshot.readiness === "staticReady" &&
        recoverySnapshot.selectedRendition === null,
      "worker failure did not commit the requested static state"
    );
    requireProof(
      diagnostics.some((diagnostic) =>
        diagnostic.startsWith("worker-decode-failure:")
      ),
      "induced worker failure produced no normalized decoder diagnostic"
    );

    const recoveryOrdering = locateRecoveryOrdering(
      order,
      recoveryRequest.requestSequence,
      recoveryRequest.settlementSequence
    );
    const animatedOrdering = locateAnimatedOrdering(
      order,
      idleHover.requestSequence,
      idleHover.settlementSequence
    );
    const readiness = summarizeReadiness(preparedSnapshot, manifest);
    const readinessWithEvidence = preparedSnapshot.readiness as
      ReadinessSnapshotWithEvidence;
    const evidence = readinessWithEvidence.evidence;
    requireProof(evidence !== undefined && evidence !== null,
      "browser readiness did not retain all-routes evidence");
    const endpointScenarios = evidence.endpoints
      .filter(({ state }) => state === "idle" || state === "hover")
      .map((endpoint) => {
        const state = endpoint.state as "idle" | "hover";
        const observed = state === "hover"
          ? hoverEndpointContinuation
          : idleEndpointContinuation;
        return Object.freeze({
          state,
          runwayFrames: endpoint.runwayFrames,
          continuationPreparedByFrame: endpoint.recoveryFrames,
          observedFrame: frameLabel(observed),
          observedTick: observed.tick,
          drawSource: observed.drawSource,
          continuedWithoutUnderflow:
            underflows === 0 &&
            observed.unit === `${state}-body` &&
            observed.localFrame === endpoint.runwayFrames &&
            observed.drawSource === "streaming"
        });
      });
    requireProof(endpointScenarios.length === 2,
      "readiness did not retain both reversible endpoints");
    requireProof(underflows === 0,
      "settled manual playback observed an unexpected underflow");
    const manualCadence = summarizeCadenceTimestamps(
      cadenceTimestampsMs,
      "manual content cadence"
    );
    requireProof(
      manualCadence.intervalCount === cadenceTicks &&
        minimumCadenceIntervalMs === manualCadence.minimumIntervalMs &&
        burstDebtTicks === 0 &&
        manualCadence.minimumIntervalMs >=
          contentFrameDurationMs * MIN_MANUAL_INTERVAL_FACTOR &&
        manualCadence.maximumIntervalMs <=
          contentFrameDurationMs * MAX_CONTINUOUS_INTERVAL_FACTOR &&
        manualCadence.p95IntervalMs <=
          contentFrameDurationMs * MAX_MANUAL_P95_INTERVAL_FACTOR &&
        manualCadence.averageIntervalMs <=
          contentFrameDurationMs * MAX_AVERAGE_INTERVAL_FACTOR &&
        manualCadence.spanMs <=
          cadenceTicks * contentFrameDurationMs *
            MAX_AVERAGE_INTERVAL_FACTOR &&
        maxCadenceLatenessMs <=
          contentFrameDurationMs *
            (MAX_CONTINUOUS_INTERVAL_FACTOR - 1),
      `manual cadence was not continuously 30fps: ${safeStringify({
        authoredFrameDurationMs: contentFrameDurationMs,
        cadenceTicks,
        maxCadenceLatenessMs,
        burstDebtTicks,
        manualCadence
      })}`
    );

    const postRecovery = controls.snapshot();
    const metrics = requireWorkerMetrics(postRecovery);
    requireTerminalWorkerAccounting(metrics);
    const disposeA = player.dispose();
    const disposeB = player.dispose();
    requireProof(disposeA === disposeB, "player disposal promise is not idempotent");
    await disposeA;
    disposed = true;
    await controls.settled().catch(() => undefined);
    await Promise.resolve();
    const traceRecords = player.getTrace().length;
    const finalComposition = controls.snapshot();
    const finalStatic = requireStaticSnapshot(staticStore);
    const finalPlayer = player.snapshot();
    requireProof(finalPlayer.disposed, "player did not enter disposed state");
    assertCompleteCleanup(
      finalComposition,
      finalStatic,
      pendingPromises
    );
    const finalMetrics = requireWorkerMetrics(finalComposition);

    const candidateOutcomes = prepared.report.candidates.map((candidate) => ({
      rendition: candidate.rendition,
      rank: candidate.rank,
      outcome: candidate.outcome === "selected" ? "selected" as const :
        "rejected" as const
    }));
    const selectedRendition = prepared.report.selectedRendition;
    requireProof(selectedRendition !== null, "animated result has no rendition");
    const selectionOrder = support.candidates.map((candidate) => ({
      id: candidate.id,
      codedArea: candidate.codedArea,
      peakBitrate: candidate.peakBitrate,
      rank: candidate.rank
    }));
    requireProof(
      preparedSnapshot.candidateOrder.every((candidate, index: number) =>
        candidate.id === selectionOrder[index]?.id &&
        candidate.area === selectionOrder[index]?.codedArea &&
        candidate.peakBitrate === selectionOrder[index]?.peakBitrate
      ),
      "attempted browser candidates diverged from deterministic ordering"
    );

    finalReport = {
      status: "supported",
      support: supportedSupport,
      selection: {
        candidateOrder: selectionOrder,
        selectedRendition,
        candidateOutcomes
      },
      readiness,
      realtime,
      cadence: {
        authoredFrameDurationMs: contentFrameDurationMs,
        ticks: cadenceTicks,
        maxObservedLatenessMs: maxCadenceLatenessMs,
        minimumObservedIntervalMs: minimumCadenceIntervalMs,
        maximumObservedIntervalMs: manualCadence.maximumIntervalMs,
        p95ObservedIntervalMs: manualCadence.p95IntervalMs,
        averageObservedIntervalMs: manualCadence.averageIntervalMs,
        elapsedMs: manualCadence.spanMs,
        burstDebtTicks,
        underflows
      },
      frames: [...frames],
      waits: [
        waitEvidence("idle-hover", "portal", 12, idleHover, forwardStart),
        waitEvidence("hover-idle", "portal", 12, hoverIdle, reverseStart),
        waitEvidence("idle-loading", "portal", 24, loading, bridge),
        waitEvidence("loading-done", "finish", 12, doneFollowOn, done),
        waitEvidence("done-idle", "portal", 12, doneIdle, idleAfterDone)
      ],
      scenarios: {
        introBody,
        loopBoundary: loopBoundary.map(frameLabel),
        bridgeThenTarget: [frameLabel(bridge), frameLabel(bridgeTarget)],
        finishTarget: frameLabel(done),
        cut: {
          requestTick: cutRequest.requestTick,
          targetTick: cutTarget.tick,
          target: frameLabel(cutTarget),
          drawSource: cutTarget.drawSource
        },
        activeReversal: {
          requestTick: inverse.requestTick,
          adjacentTick: adjacent.tick,
          fromFrame: reversalFrom.localFrame,
          adjacentFrame: adjacent.localFrame,
          drawSource: adjacent.drawSource
        },
        endpoints: endpointScenarios,
        lockedFollowOn: {
          requested: "done",
          converged: "done",
          settled: true
        },
        latestWins: {
          requested: ["done", "idle"],
          converged: "idle",
          supersededRejected: true,
          latestSettled: true
        }
      },
      ordering: {
        records: [...order],
        ...animatedOrdering,
        recoveryRequestSequence: recoveryRequest.requestSequence,
        ...recoveryOrdering
      },
      recovery: {
        failureInduced: true,
        requestedState: "hover",
        staticState: recoverySnapshot.visualState as "hover",
        readiness: "staticReady",
        selectedRendition: null,
        tickStatus: recoveryTick.status,
        reason: recoveryReady.reason
      },
      worker: workerSummary(postRecovery),
      cleanup: {
        playerDisposed: finalPlayer.disposed,
        workerAlive: finalComposition.worker.alive,
        workerPendingOperations: finalComposition.worker.pendingRequests,
        workerPendingWaiters: finalComposition.worker.pendingWaiters,
        clientOpenFrames: finalComposition.worker.openFrames,
        pendingSamples: finalMetrics.pendingSamples,
        submittedFrames: finalMetrics.submittedFrames,
        leasedFrames: finalMetrics.leasedFrames,
        leasedDecodedBytes: finalMetrics.leasedDecodedBytes,
        rendererState: finalComposition.renderer.snapshot!.state,
        rendererLiveResources: finalComposition.renderer.glResourceCount,
        rendererUploads:
          finalComposition.renderer.snapshot!.residentUploads +
          finalComposition.renderer.snapshot!.streamingUploads,
        rendererStaleUploads:
          finalComposition.renderer.snapshot!.staleUploads,
        rendererClosedSourceFrames:
          finalComposition.renderer.snapshot!.closedSourceFrames,
        staticStoreState: finalStatic.state,
        staticRetainedSurfaces: finalStatic.retainedSurfaces,
        staticDecodedSurfaces: finalStatic.decodedSurfaces,
        staticClosedSurfaces: finalStatic.closedSurfaces,
        pendingCallbacks: finalComposition.playback.pendingCallbacks,
        pendingPromises:
          pendingPromises + finalComposition.playback.pendingPromises,
        traceRecords
      }
    };
  } finally {
    if (!disposed && player !== null) {
      await player.dispose().catch(() => undefined);
      await controls.settled().catch(() => undefined);
    }
  }

  requireProof(finalReport !== null, "M5.5 proof produced no report");
  return deepFreeze(finalReport);
}

async function runRealtimeIntroLoopProof(
  bytes: Uint8Array,
  manifest: Readonly<CompiledManifestV01>
): Promise<Readonly<M55RealtimeProofEvidence>> {
  const animatedCanvas = document.createElement("canvas");
  const staticCanvas = document.createElement("canvas");
  const diagnostics: string[] = [];
  const observedFrames: string[] = [];
  const displayCallbackTimestampsMs: number[] = [];
  const contentTickTimestampsMs: number[] = [];
  const contentDrawTimestampsMs: number[] = [];
  // Nearest-rank p95 needs at least 20 intervals; the former 18-interval
  // sample made p95 identical to the single maximum. Forty-two intervals
  // retain an independent max bound while making the percentile meaningful.
  const stopAtFrameCount = 44;
  const expectedLoopSeams = 5;
  const authoredFrameDurationMs =
    1_000 * manifest.frameRate.denominator / manifest.frameRate.numerator;
  let nextHandle = 1;
  let cancelledCallbacks = 0;
  let observerUnderflows = 0;
  let realtimeStartedAtMs: number | null = null;
  let activeDisplayCallbackTimestampMs: number | null = null;
  let staticStore: StaticSurfaceStore | null = null;
  let player: IntegratedPlayer | null = null;
  let disposed = false;
  const callbacks = new Map<number, number | null>();

  const composition = createBrowserOpaqueCandidateComposition({
    canvas: animatedCanvas,
    clock: { now: () => performance.now() },
    diagnosticsSink: (failure: Readonly<RuntimeFailure>) => diagnostics.push(
      `${failure.code}:${failure.message}`
    )
  });
  const controls = composition.controls;
  const factory = instrumentCandidateFactory(
    composition.factory,
    (presentation) => {
      requireProof(presentation.kind !== "static",
        "realtime animated draw became static");
      // The route proof below performs tolerant GPU readback across more than
      // 30 boundary frames. Repeating synchronous readPixels() inside every
      // realtime RAF opportunity would benchmark a proof-only GPU stall that
      // production playback never performs, and can itself perturb pacing.
      // Keep this cadence drive on the production draw path while still
      // validating that every reported media identity belongs to the fixture.
      sourceOrdinal(
        presentation.unitId,
        presentation.frameIndex
      );
      if (realtimeStartedAtMs !== null) {
        requireProof(activeDisplayCallbackTimestampMs !== null,
          "realtime content draw occurred outside its RAF opportunity");
        contentTickTimestampsMs.push(activeDisplayCallbackTimestampMs);
        contentDrawTimestampsMs.push(performance.now());
      }
      observedFrames.push(
        `${presentation.unitId}:${String(presentation.frameIndex)}`
      );
    }
  );

  try {
    player = new IntegratedPlayer({
      bytes,
      candidateFactory: factory,
      createStaticStore(catalog) {
        const created = new StaticSurfaceStore(
          asStaticSurfaceCatalog(catalog),
          new BrowserStaticSurfaceDecoder(),
          new BrowserStaticCanvasPlane(staticCanvas, () => undefined)
        );
        staticStore = created;
        return created;
      },
      diagnosticsSink(failure) {
        diagnostics.push(`${failure.code}:${failure.message}`);
      },
      now: () => performance.now(),
      realtime: {
        requestFrame(callback) {
          const handle = nextHandle++;
          requireProof(Number.isSafeInteger(handle),
            "realtime callback handle exceeded the safe range");
          if (observedFrames.length >= stopAtFrameCount) {
            callbacks.set(handle, null);
            return handle;
          }
          const nativeHandle = requestAnimationFrame((timestamp) => {
            callbacks.delete(handle);
            if (realtimeStartedAtMs !== null) {
              displayCallbackTimestampsMs.push(timestamp);
            }
            activeDisplayCallbackTimestampMs = timestamp;
            try {
              callback(timestamp);
            } finally {
              activeDisplayCallbackTimestampMs = null;
            }
          });
          callbacks.set(handle, nativeHandle);
          return handle;
        },
        cancelFrame(handle) {
          const nativeHandle = callbacks.get(handle);
          if (nativeHandle === undefined) return;
          callbacks.delete(handle);
          if (nativeHandle !== null) cancelAnimationFrame(nativeHandle);
          cancelledCallbacks += 1;
        },
        now: () => performance.now(),
        onUnderflow: () => {
          observerUnderflows += 1;
        }
      }
    });

    const prepared = await player.prepare({ timeoutMs: 30_000 });
    requireAnimated(prepared, diagnostics, controls.snapshot());
    await controls.settled();
    requireProof(
      observedFrames.length === 1 && observedFrames[0] === "intro:0",
      "realtime activation did not install exactly intro frame zero"
    );

    realtimeStartedAtMs = performance.now();
    player.startRealtime();
    await waitForProofCondition(
      () => observedFrames.length >= stopAtFrameCount,
      "five realtime idle loop seams",
      10_000
    );
    await waitForProofCondition(
      () => [...callbacks.values()].filter((handle) => handle === null)
        .length === 1,
      "parked realtime callback",
      1_000
    );

    const running = player.realtimeSnapshot();
    requireProof(running !== null, "player retained no realtime snapshot");
    const introBody = observedFrames.slice(0, 4);
    requireLabels(
      introBody,
      ["intro:0", "intro:1", "intro:2", "idle-body:0"],
      "realtime intro/body order"
    );
    let loopSeams = 0;
    for (let index = 1; index < observedFrames.length; index += 1) {
      if (
        observedFrames[index - 1] === "idle-body:7" &&
        observedFrames[index] === "idle-body:0"
      ) loopSeams += 1;
    }
    const parkedCallbacks = [...callbacks.values()].filter((handle) =>
      handle === null
    ).length;
    const observedFrameCount = observedFrames.slice().length;
    requireProof(realtimeStartedAtMs !== null,
      "realtime start timestamp was not captured");
    const callbackCadence = summarizeCadenceTimestamps(
      displayCallbackTimestampsMs,
      "realtime display callback cadence"
    );
    // RAF timestamps identify the opportunity selected by the rational
    // driver; the synchronous draw completes later inside that callback.
    // Grade visible canvas submission cadence from the post-draw timestamps,
    // while callback health remains an independent bound above.
    const contentCadence = summarizeCadenceTimestamps(
      contentDrawTimestampsMs,
      "realtime content draw cadence"
    );
    const drawSubmissionLatenciesMs = contentDrawTimestampsMs.map(
      (drawTimestamp, index) =>
        drawTimestamp - contentTickTimestampsMs[index]!
    );
    const maximumDrawSubmissionLatencyMs = Math.max(
      ...drawSubmissionLatenciesMs
    );
    const elapsedFromStartMs =
      contentDrawTimestampsMs.at(-1)! - realtimeStartedAtMs;
    requireProof(
      observedFrameCount === stopAtFrameCount &&
        loopSeams === expectedLoopSeams &&
        running.running &&
        !running.disposed &&
        running.displayCallbacks >= running.advancedTicks &&
        running.advancedTicks === stopAtFrameCount - 1 &&
        running.nextPresentationOrdinal === BigInt(stopAtFrameCount) &&
        running.underflows === 0 &&
        observerUnderflows === 0 &&
        running.smoothSession &&
        parkedCallbacks === 1 &&
        displayCallbackTimestampsMs.length === running.displayCallbacks &&
        contentTickTimestampsMs.length === running.advancedTicks &&
        contentDrawTimestampsMs.length === running.advancedTicks &&
        contentTickTimestampsMs.every((timestamp) =>
          displayCallbackTimestampsMs.includes(timestamp)
        ) &&
        drawSubmissionLatenciesMs.every((latency) =>
          Number.isFinite(latency) && latency >= 0
        ) &&
        maximumDrawSubmissionLatencyMs <=
          authoredFrameDurationMs * MAX_DRAW_SUBMISSION_LATENCY_FACTOR &&
        callbackCadence.maximumIntervalMs <=
          authoredFrameDurationMs * MAX_CONTINUOUS_INTERVAL_FACTOR &&
        callbackCadence.p95IntervalMs <=
          authoredFrameDurationMs * MAX_REALTIME_P95_INTERVAL_FACTOR &&
        // A late 30fps deadline may land on the immediately following 60Hz
        // display opportunity. Distinct callback timestamps prove that this
        // is never a same-callback catch-up burst.
        contentCadence.minimumIntervalMs >=
          authoredFrameDurationMs * MIN_REALTIME_INTERVAL_FACTOR &&
        contentCadence.maximumIntervalMs <=
          authoredFrameDurationMs * MAX_CONTINUOUS_INTERVAL_FACTOR &&
        contentCadence.p95IntervalMs <=
          authoredFrameDurationMs * MAX_REALTIME_P95_INTERVAL_FACTOR &&
        contentCadence.averageIntervalMs <=
          authoredFrameDurationMs * MAX_AVERAGE_INTERVAL_FACTOR &&
        elapsedFromStartMs <=
          (running.advancedTicks + REALTIME_STARTUP_SLACK_FRAMES) *
            authoredFrameDurationMs,
      `realtime cadence diverged: ${safeStringify({
        observedFrames,
        loopSeams,
        running,
        parkedCallbacks,
        observerUnderflows,
        authoredFrameDurationMs,
        displayCallbackTimestampsMs,
        contentTickTimestampsMs,
        contentDrawTimestampsMs,
        drawSubmissionLatenciesMs,
        maximumDrawSubmissionLatencyMs,
        callbackCadence,
        contentCadence,
        elapsedFromStartMs,
        diagnostics
      })}`
    );

    const selectedRendition = prepared.report.selectedRendition;
    requireProof(selectedRendition !== null,
      "realtime session selected no rendition");
    const runningComposition = controls.snapshot();
    const workerConfigureCalls = requireWorkerMetrics(runningComposition)
      .configureCalls;
    requireProof(workerConfigureCalls === 1,
      "realtime worker was configured more than once");

    const disposeA = player.dispose();
    const disposeB = player.dispose();
    requireProof(disposeA === disposeB,
      "realtime player disposal promise is not idempotent");
    await disposeA;
    disposed = true;
    await controls.settled().catch(() => undefined);
    await Promise.resolve();

    const finalRealtime = player.realtimeSnapshot();
    const finalPlayer = player.snapshot();
    const finalComposition = controls.snapshot();
    const finalStatic = requireStaticSnapshot(staticStore);
    requireProof(
      finalRealtime !== null &&
        finalRealtime.disposed &&
        !finalRealtime.running &&
        finalPlayer.disposed &&
        callbacks.size === 0 &&
        cancelledCallbacks >= 1,
      "realtime player did not cancel its owned callback on disposal"
    );
    assertCompleteCleanup(finalComposition, finalStatic, 0);

    return Object.freeze({
      selectedRendition,
      introBody: Object.freeze([...introBody]),
      observedFrames: Object.freeze([...observedFrames]),
      authoredFrameDurationMs,
      startedAtMs: realtimeStartedAtMs,
      displayCallbackTimestampsMs: Object.freeze([
        ...displayCallbackTimestampsMs
      ]),
      contentTickTimestampsMs: Object.freeze([...contentTickTimestampsMs]),
      contentDrawTimestampsMs: Object.freeze([...contentDrawTimestampsMs]),
      minimumContentIntervalMs: contentCadence.minimumIntervalMs,
      maximumContentIntervalMs: contentCadence.maximumIntervalMs,
      p95ContentIntervalMs: contentCadence.p95IntervalMs,
      averageContentIntervalMs: contentCadence.averageIntervalMs,
      maximumDisplayCallbackIntervalMs: callbackCadence.maximumIntervalMs,
      p95DisplayCallbackIntervalMs: callbackCadence.p95IntervalMs,
      maximumDrawSubmissionLatencyMs,
      elapsedFromStartMs,
      contentSpanMs: contentCadence.spanMs,
      loopSeams,
      displayCallbacks: running.displayCallbacks,
      advancedTicks: running.advancedTicks,
      underflows: running.underflows,
      smoothSession: running.smoothSession,
      parkedCallbacks,
      workerConfigureCalls,
      cleanup: Object.freeze({
        playerDisposed: finalPlayer.disposed,
        realtimeDisposed: finalRealtime.disposed,
        cancelledCallbacks,
        pendingCallbacks:
          callbacks.size + finalComposition.playback.pendingCallbacks,
        compositionComplete: finalComposition.cleanup.complete,
        workerAlive: finalComposition.worker.alive,
        rendererLiveResources: finalComposition.renderer.glResourceCount,
        staticRetainedSurfaces: finalStatic.retainedSurfaces
      })
    });
  } finally {
    if (!disposed && player !== null) {
      await player.dispose().catch(() => undefined);
      await controls.settled().catch(() => undefined);
    }
  }
}

async function waitForProofCondition(
  predicate: () => boolean,
  label: string,
  timeoutMs: number
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
  }
}

interface CadenceTimestampSummary {
  readonly intervalCount: number;
  readonly minimumIntervalMs: number;
  readonly maximumIntervalMs: number;
  readonly p95IntervalMs: number;
  readonly averageIntervalMs: number;
  readonly spanMs: number;
}

function summarizeCadenceTimestamps(
  timestampsMs: readonly number[],
  label: string
): Readonly<CadenceTimestampSummary> {
  requireProof(timestampsMs.length >= 2,
    `${label} did not record at least two timestamps`);
  const intervals: number[] = [];
  for (let index = 0; index < timestampsMs.length; index += 1) {
    const timestamp = timestampsMs[index]!;
    requireProof(Number.isFinite(timestamp) && timestamp >= 0,
      `${label} recorded an invalid timestamp`);
    if (index === 0) continue;
    const interval = timestamp - timestampsMs[index - 1]!;
    requireProof(Number.isFinite(interval) && interval > 0,
      `${label} timestamps were not strictly increasing`);
    intervals.push(interval);
  }
  const sorted = [...intervals].sort((left, right) => left - right);
  const percentileIndex = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * 0.95) - 1)
  );
  const spanMs = timestampsMs.at(-1)! - timestampsMs[0]!;
  return Object.freeze({
    intervalCount: intervals.length,
    minimumIntervalMs: sorted[0]!,
    maximumIntervalMs: sorted.at(-1)!,
    p95IntervalMs: sorted[percentileIndex]!,
    averageIntervalMs: spanMs / intervals.length,
    spanMs
  });
}

function instrumentCandidateFactory(
  factory: IntegratedCandidateFactory,
  onDraw: (
    presentation: Readonly<GraphPresentation>,
    media: Readonly<RuntimeMediaPresentation> | null,
    runtimeTag: string | null
  ) => void
): IntegratedCandidateFactory {
  const instrumented: IntegratedCandidateFactory = {
    availability: factory.availability,
    create(context) {
      const attempt = factory.create(context);
      const playback = attempt.playback;
      const instrumentedPlayback: IntegratedPlaybackSession = {
        prepareContentTick: (tickContext) =>
          playback.prepareContentTick(tickContext),
        drawContentTick: (prepared, presentation) => {
          const runtimeTag = playback.drawContentTick(prepared, presentation);
          onDraw(presentation, prepared.media, runtimeTag);
          return runtimeTag;
        },
        synchronizeGraph: (result) => playback.synchronizeGraph(result),
        traceState: () => playback.traceState()
      };
      Object.freeze(instrumentedPlayback);
      const instrumentedAttempt: IntegratedCandidateAttempt = {
        playback: instrumentedPlayback,
        prepare: (options) => attempt.prepare(options),
        prepareActivation: (options) => attempt.prepareActivation(options),
        drawInitial: (activation, presentation) => {
          attempt.drawInitial(activation, presentation);
          onDraw(presentation, null, null);
        },
        dispose: () => attempt.dispose()
      };
      return Object.freeze(instrumentedAttempt);
    }
  };
  return Object.freeze(instrumented);
}

async function settleRequest(
  request: TrackedRequest,
  diagnostics?: () => unknown
): Promise<void> {
  for (let count = 0; count < 32 && request.outcome === null; count += 1) {
    await Promise.resolve();
    if (request.outcome === null) {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    }
  }
  requireProof(request.outcome !== null,
    `request ${request.label} did not settle within the microtask bound${
      diagnostics === undefined ? "" : `: ${safeStringify(diagnostics())}`
    }`);
}

async function driveUntilStopped(
  player: IntegratedPlayer,
  manifest: Readonly<CompiledManifestV01>,
  currentOrdinal: () => bigint,
  acceptAdvanced: () => void,
  waitForCadence: () => Promise<void>
): Promise<Readonly<Extract<IntegratedContentTickResult, { status: "stopped" }>>> {
  for (let count = 0; count < MAX_SCRIPT_TICKS; count += 1) {
    await waitForCadence();
    const ordinal = currentOrdinal();
    const result = player.tryContentTick({
      presentationOrdinal: ordinal,
      rationalDeadlineUs: timestampForFrame(
        safeBigIntToNumber(ordinal),
        manifest.frameRate
      )
    });
    if (result.status === "stopped") return result;
    if (result.status === "underflow") {
      throw new Error("induced worker failure surfaced as an underflow");
    }
    if (result.status === "advanced") acceptAdvanced();
  }
  throw new Error("induced worker failure did not stop animated playback");
}

function summarizeReadiness(
  snapshot: Readonly<BrowserOpaqueCandidateSnapshot>,
  manifest: Readonly<CompiledManifestV01>
): Readonly<ReadinessSummary> {
  const readiness = snapshot.readiness as ReadinessSnapshotWithEvidence;
  const evaluation = readiness.evaluation;
  const evidence = readiness.evidence;
  requireProof(
    readiness.policy === "all-routes" &&
      readiness.passed === true &&
      evaluation?.passed === true &&
      evidence !== undefined &&
      evidence !== null,
    "browser candidate did not pass retained all-routes readiness"
  );
  const warmup = evaluation.warmupMetrics;
  const authoredFramesPerSecond =
    warmup.frameRate.numerator / warmup.frameRate.denominator;
  const allDeadlineSafe = [
    ...evidence.edgeDryRuns,
    ...evidence.cuts,
    ...evidence.endpoints
  ].every(({ deadlineSafe }) => deadlineSafe);
  const allWithinBudget = [
    ...evidence.edgeDryRuns,
    ...evidence.cuts,
    ...evidence.endpoints
  ].every(({ withinBudget }) => withinBudget);
  const allPhasesReady = evidence.phases.every((phase) =>
    phase.pendingCancellationReady &&
      phase.pendingReplacementReady &&
      phase.prospectiveTargetReady &&
      phase.lockedFollowOnReady
  );
  const allInversesReady = evidence.inverses.every((inverse) =>
    inverse.responseFrames === 1 && inverse.adjacentFrame
  );
  requireProof(
    warmup.passed &&
      warmup.ringCapacity === evaluation.ringCapacity &&
      evaluation.evaluatedEdgeIds.length === manifest.edges.length &&
      evaluation.edges.every(({ passed }) => passed) &&
      evidence.loops.every(({ seamReady, availableHeadroomFrames }) =>
        seamReady && availableHeadroomFrames >= evaluation.ringCapacity
      ) &&
      evidence.cuts.every(({ runwayPrepared, responseFrames }) =>
        runwayPrepared && responseFrames === 1
      ) &&
      evidence.endpoints.every(({ runwayPrepared }) => runwayPrepared) &&
      allDeadlineSafe &&
      allWithinBudget &&
      allPhasesReady &&
      allInversesReady &&
      evidence.resource.passed &&
      evidence.initialRing.passed,
    "retained readiness evidence contains an unproven route"
  );
  return Object.freeze({
    policy: "all-routes",
    passed: true,
    warmupOutputs: warmup.sampleCount,
    authoredFramesPerSecond,
    measuredFramesPerSecond:
      authoredFramesPerSecond * warmup.throughputMultiple,
    decodeLeadFrames: warmup.decodeLeadFrames,
    ringCapacity: evaluation.ringCapacity,
    directEdgeCount: evaluation.evaluatedEdgeIds.length,
    loopCount: evidence.loops.length,
    endpointCount: evidence.endpoints.length,
    allDeadlineSafe: true,
    allWithinBudget: true,
    resourcePassed: true,
    initialRingPassed: true
  });
}

function waitEvidence(
  edge: string,
  policy: "portal" | "finish",
  declaredMaximumTicks: number,
  request: TrackedRequest,
  firstTargetFrame: Readonly<M55FrameEvidence>
) {
  const observedTicks = firstTargetFrame.tick - request.requestTick;
  requireProof(
    observedTicks >= 0 && observedTicks <= declaredMaximumTicks,
    `${edge} exceeded its declared ${policy} wait bound`
  );
  return Object.freeze({
    edge,
    policy,
    declaredMaximumTicks,
    observedTicks
  });
}

function locateRecoveryOrdering(
  records: readonly Readonly<OrderRecord>[],
  requestSequence: number,
  promiseSequence: number | null
) {
  const fallbackSequence = requireOrderSequence(
    records,
    requestSequence,
    (record) => record.kind === "event" && record.label === "fallback",
    "fallback event"
  );
  const staticDrawSequence = requireOrderSequence(
    records,
    fallbackSequence,
    (record) => record.kind === "static-draw",
    "static draw barrier"
  );
  const visualStateSequence = requireOrderSequence(
    records,
    staticDrawSequence,
    (record) => record.kind === "event" &&
      record.label === "visualstatechange:hover",
    "recovery visualstatechange"
  );
  const transitionEndSequence = requireOrderSequence(
    records,
    visualStateSequence,
    (record) => record.kind === "event" && record.label === "transitionend",
    "recovery transitionend"
  );
  requireProof(
    promiseSequence !== null && promiseSequence > transitionEndSequence,
    "recovery promise did not settle after transitionend"
  );
  return Object.freeze({
    fallbackSequence,
    staticDrawSequence,
    visualStateSequence,
    transitionEndSequence,
    promiseSequence
  });
}

function locateAnimatedOrdering(
  records: readonly Readonly<OrderRecord>[],
  requestSequence: number,
  promiseSequence: number | null
) {
  const animatedTransitionStartSequence = requireOrderSequence(
    records,
    requestSequence,
    (record) => record.kind === "event" && record.label === "transitionstart",
    "animated transitionstart"
  );
  const animatedFirstDrawSequence = requireOrderSequence(
    records,
    animatedTransitionStartSequence,
    (record) => record.kind === "draw" && record.label === "hover-shift:0",
    "first reversible draw"
  );
  const animatedTargetDrawSequence = requireOrderSequence(
    records,
    animatedFirstDrawSequence,
    (record) => record.kind === "draw" && record.label === "hover-body:0",
    "animated target draw"
  );
  const animatedVisualStateSequence = requireOrderSequence(
    records,
    animatedTargetDrawSequence,
    (record) => record.kind === "event" &&
      record.label === "visualstatechange:hover",
    "animated visualstatechange"
  );
  const animatedTransitionEndSequence = requireOrderSequence(
    records,
    animatedVisualStateSequence,
    (record) => record.kind === "event" && record.label === "transitionend",
    "animated transitionend"
  );
  requireProof(
    promiseSequence !== null && promiseSequence > animatedTransitionEndSequence,
    "animated request promise did not settle after transitionend"
  );
  return Object.freeze({
    animatedTransitionStartSequence,
    animatedFirstDrawSequence,
    animatedTargetDrawSequence,
    animatedVisualStateSequence,
    animatedTransitionEndSequence,
    animatedPromiseSequence: promiseSequence
  });
}

function requireOrderSequence(
  records: readonly Readonly<OrderRecord>[],
  after: number,
  predicate: (record: Readonly<OrderRecord>) => boolean,
  label: string
): number {
  const record = records.find((candidate) =>
    candidate.sequence > after && predicate(candidate)
  );
  requireProof(record !== undefined, `ordering trace has no ${label}`);
  return record.sequence;
}

function requireAnimated(
  result: Readonly<RuntimeReadinessResult>,
  diagnostics: readonly string[],
  browser: Readonly<BrowserOpaqueCandidateSnapshot>
): asserts result is Extract<RuntimeReadinessResult, { mode: "animated" }> {
  requireProof(
    result.mode === "animated" &&
      result.report.readiness === "interactiveReady" &&
      result.report.selectedRendition !== null,
    result.mode === "static"
      ? `browser candidate fell back during preparation: ${result.reason}; ${
          JSON.stringify(result.report.candidates)
        }; readiness=${JSON.stringify(describeReadinessFailure(browser))}; ${
          `diagnostics=${diagnostics.join("|")}`
        }`
      : "browser candidate did not become interactive-ready"
  );
}

function describeReadinessFailure(
  browser: Readonly<BrowserOpaqueCandidateSnapshot>
) {
  const evaluation = browser.readiness.evaluation;
  const evidence = browser.readiness.evidence;
  return {
    passed: browser.readiness.passed,
    failures: evaluation?.failures ?? [],
    warmup: evaluation === null ? null : {
      passed: evaluation.warmupMetrics.passed,
      reasons: evaluation.warmupMetrics.failureReasons,
      samples: evaluation.warmupMetrics.sampleCount,
      throughput: evaluation.warmupMetrics.throughputMultiple,
      lead: evaluation.warmupMetrics.decodeLeadFrames,
      ring: evaluation.ringCapacity
    },
    evidence: evidence === null ? null : {
      loops: evidence.loops,
      dryRuns: evidence.edgeDryRuns.map(({ edge, completeSequence,
        deadlineSafe, withinBudget }) => ({
        edge,
        completeSequence,
        deadlineSafe,
        withinBudget
      })),
      cuts: evidence.cuts,
      endpoints: evidence.endpoints,
      phases: evidence.phases,
      inverses: evidence.inverses,
      resource: evidence.resource,
      initialRing: evidence.initialRing
    }
  };
}

function requireStaticRecovery(
  result: Readonly<RuntimeReadinessResult>
): asserts result is Extract<RuntimeReadinessResult, { mode: "static" }> & {
  readonly reason: "animation-failure";
} {
  requireProof(
    result.mode === "static" &&
      result.reason === "animation-failure" &&
      result.report.readiness === "staticReady" &&
      result.report.selectedRendition === null,
    "induced worker failure did not produce animation-failure static readiness"
  );
}

function requireWorkerMetrics(
  snapshot: Readonly<BrowserOpaqueCandidateSnapshot>
) {
  const metrics = snapshot.worker.metrics;
  requireProof(metrics !== null, "browser worker retained no protocol metrics");
  return metrics;
}

function requireTerminalWorkerAccounting(
  metrics: ReturnType<typeof requireWorkerMetrics>
): void {
  const terminalReleaseGap =
    metrics.deliveredFrames - metrics.releasedFrames;
  requireProof(
    metrics.configureCalls === 1 &&
      metrics.resetCalls === 0 &&
      metrics.flushCalls === 0 &&
      metrics.boundaryFlushCalls === 0 &&
      metrics.disposed &&
      metrics.activeGeneration === null &&
      terminalReleaseGap >= 0 &&
      terminalReleaseGap <= RESOURCE_DECODE_SURFACE_COUNT &&
      metrics.pendingSamples === 0 &&
      metrics.submittedFrames === 0 &&
      metrics.leasedFrames === 0 &&
      metrics.leasedDecodedBytes === 0 &&
      metrics.decodeQueueSize === 0 &&
      metrics.closedFrames >= metrics.staleFrames &&
      metrics.outputFrames >= metrics.deliveredFrames,
    `selected worker configuration, flush, or frame accounting diverged: ${
      safeStringify(metrics)
    }`
  );
}

function workerSummary(snapshot: Readonly<BrowserOpaqueCandidateSnapshot>) {
  const metrics = requireWorkerMetrics(snapshot);
  requireProof(metrics.disposed,
    "terminal worker summary was captured before disposal");
  return Object.freeze({
    configureCalls: metrics.configureCalls,
    resetCalls: metrics.resetCalls,
    flushCalls: metrics.flushCalls,
    boundaryFlushCalls: metrics.boundaryFlushCalls,
    outputFrames: metrics.outputFrames,
    deliveredFrames: metrics.deliveredFrames,
    releasedFrames: metrics.releasedFrames,
    terminalReleaseGap: metrics.deliveredFrames - metrics.releasedFrames,
    terminalDisposed: metrics.disposed,
    staleFrames: metrics.staleFrames,
    closedFrames: metrics.closedFrames,
    pendingSamples: metrics.pendingSamples,
    submittedFrames: metrics.submittedFrames,
    leasedFrames: metrics.leasedFrames,
    leasedDecodedBytes: metrics.leasedDecodedBytes,
    decodeQueueSize: metrics.decodeQueueSize,
    clientOpenFrames: snapshot.worker.openFrames
  });
}

function requireStaticSnapshot(
  store: StaticSurfaceStore | null
): Readonly<StaticSurfaceStoreSnapshot> {
  requireProof(store !== null, "integrated player created no static store");
  return store.snapshot();
}

function assertCompleteCleanup(
  composition: Readonly<BrowserOpaqueCandidateSnapshot>,
  staticStore: Readonly<StaticSurfaceStoreSnapshot>,
  pendingPromises: number
): void {
  const metrics = requireWorkerMetrics(composition);
  const renderer = composition.renderer.snapshot;
  requireProof(renderer !== null, "browser renderer retained no final snapshot");
  requireProof(
    composition.cleanup.complete &&
      composition.cleanup.workersAlive === 0 &&
      composition.cleanup.openFrames === 0 &&
      composition.cleanup.renderersAlive === 0 &&
      composition.cleanup.glResourceCount === 0 &&
      composition.cleanup.pendingOperations === 0 &&
      !composition.worker.alive &&
      composition.worker.openFrames === 0 &&
      composition.worker.pendingRequests === 0 &&
      composition.worker.pendingWaiters === 0 &&
      metrics.pendingSamples === 0 &&
      metrics.submittedFrames === 0 &&
      metrics.leasedFrames === 0 &&
      metrics.leasedDecodedBytes === 0 &&
      metrics.decodeQueueSize === 0 &&
      renderer.state === "disposed" &&
      renderer.closedSourceFrames ===
        renderer.residentUploads + renderer.streamingUploads +
          renderer.staleUploads &&
      !composition.renderer.backendAlive &&
      composition.renderer.glResourceCount === 0 &&
      composition.playback.pendingCallbacks === 0 &&
      composition.playback.pendingPromises === 0 &&
      staticStore.state === "disposed" &&
      staticStore.retainedSurfaces === 0 &&
      staticStore.decodedSurfaces === staticStore.closedSurfaces &&
      pendingPromises === 0,
    "browser proof leaked a worker, frame, GL/static resource, callback, or promise"
  );
}

function frameLabel(frame: Readonly<M55FrameEvidence>): string {
  return `${frame.unit}:${String(frame.localFrame)}`;
}

function latestFrame(
  frames: readonly Readonly<M55FrameEvidence>[]
): Readonly<M55FrameEvidence> {
  const frame = frames.at(-1);
  requireProof(frame !== undefined, "proof has no presented frame");
  return frame;
}

function requireLabels(
  actual: readonly string[],
  expected: readonly string[],
  label: string
): void {
  requireProof(
    actual.length === expected.length &&
      actual.every((value, index) => value === expected[index]),
    `${label} diverged: ${actual.join(",")}`
  );
}

function eventLabel(event: Readonly<EffectHostEvent>): string {
  switch (event.type) {
    case "readinesschange":
      return `readinesschange:${event.to}`;
    case "requestedstatechange":
      return `requestedstatechange:${event.to}`;
    case "visualstatechange":
      return `visualstatechange:${event.to}`;
    case "transitionstart":
      return "transitionstart";
    case "transitionend":
      return "transitionend";
    case "fallback":
      return "fallback";
  }
}

function sourceOrdinal(unit: string, localFrame: number): number {
  const start = FIXTURE_SOURCE_ORDINALS[
    unit as keyof typeof FIXTURE_SOURCE_ORDINALS
  ];
  requireProof(start !== undefined, `unknown fixture unit ${unit}`);
  const ordinal = start + localFrame;
  requireProof(
    Number.isSafeInteger(localFrame) && localFrame >= 0 && ordinal < 30,
    "fixture frame identity is out of range"
  );
  return ordinal;
}

function decodeFixtureTag(
  rgba: Uint8Array,
  width: number,
  height: number
): {
  readonly sourceOrdinal: number;
  readonly code: number;
  readonly minimumLumaMargin: number;
} {
  requireProof(
    Number.isSafeInteger(width) && width === 32 &&
      Number.isSafeInteger(height) && height === 32 &&
      rgba.byteLength === width * height * 4,
    "GPU readback does not match the 32x32 logical fixture canvas"
  );
  let code = 0;
  let minimumDistance = Number.POSITIVE_INFINITY;
  for (let bit = 0; bit < 6; bit += 1) {
    let sum = 0;
    let samples = 0;
    const startX = 4 + bit * 4;
    for (let y = 14; y < 18; y += 1) {
      for (let x = startX + 1; x < startX + 3; x += 1) {
        const offset = (y * width + x) * 4;
        const red = rgba[offset]!;
        const green = rgba[offset + 1]!;
        const blue = rgba[offset + 2]!;
        sum += (54 * red + 183 * green + 19 * blue) / 256;
        samples += 1;
      }
    }
    const luminance = sum / samples;
    minimumDistance = Math.min(minimumDistance, Math.abs(luminance - 128));
    if (luminance > 128) code |= 1 << bit;
  }
  const sourceOrdinal = Array.from({ length: 30 }, (_, index) => index)
    .find((index) => fixtureTagCode(index) === code);
  requireProof(sourceOrdinal !== undefined,
    `GPU marker code ${String(code)} is not a fixture source ordinal`);
  return Object.freeze({
    sourceOrdinal,
    code,
    minimumLumaMargin: minimumDistance / 96
  });
}

function fixtureTagCode(frameIndex: number): number {
  const gray = frameIndex ^ (frameIndex >> 1);
  return TAG_COLUMNS.reduce(
    (code, column, bit) => (gray & (1 << bit)) === 0
      ? code
      : code ^ column,
    0
  );
}

function decoderConfig(
  codedWidth: number,
  codedHeight: number
): VideoDecoderConfig {
  return {
    codec: "avc1.42E020",
    codedWidth,
    codedHeight,
    hardwareAcceleration: "no-preference",
    optimizeForLatency: true
  };
}

function isExactSupportedConfig(
  value: VideoDecoderConfig | undefined,
  expected: VideoDecoderConfig
): boolean {
  if (value === undefined) return false;
  const returned = value as VideoDecoderConfig & {
    readonly flip?: boolean;
    readonly rotation?: number;
  };
  const allowedKeys = new Set([
    "codec",
    "codedWidth",
    "codedHeight",
    "hardwareAcceleration",
    "optimizeForLatency",
    "flip",
    "rotation"
  ]);
  return Object.keys(value).every((key) => allowedKeys.has(key)) &&
    returned.codec === expected.codec &&
    returned.codedWidth === expected.codedWidth &&
    returned.codedHeight === expected.codedHeight &&
    returned.hardwareAcceleration === expected.hardwareAcceleration &&
    returned.optimizeForLatency === expected.optimizeForLatency &&
    returned.description === undefined &&
    (returned.flip === undefined || returned.flip === false) &&
    (returned.rotation === undefined || returned.rotation === 0);
}

function probeWebGl2(): boolean {
  try {
    const context = document.createElement("canvas").getContext("webgl2", {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true
    });
    if (context === null) return false;
    context.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function decodeBase64(value: string): Uint8Array {
  requireProof(typeof value === "string" && value.length > 0,
    "asset base64 is required");
  const maximumLength =
    Math.ceil(FORMAT_DEFAULT_BUDGETS.maxFileBytes / 3) * 4 + 4;
  requireProof(value.length <= maximumLength,
    "asset base64 exceeds the format file budget");
  let binary: string;
  try {
    binary = atob(value);
  } catch (error) {
    throw new Error(`asset base64 is invalid: ${errorMessage(error)}`);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  requireProof(bytes.byteLength <= FORMAT_DEFAULT_BUDGETS.maxFileBytes,
    "decoded asset exceeds the format file budget");
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function safeBigIntToNumber(value: bigint): number {
  requireProof(value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER),
    "presentation ordinal exceeds the safe number range");
  return Number(value);
}

async function waitForPresentationDeadline(deadlineMs: number): Promise<void> {
  requireProof(Number.isFinite(deadlineMs) && deadlineMs >= 0,
    "presentation deadline is invalid");
  for (;;) {
    const remaining = deadlineMs - performance.now();
    if (remaining <= 0) return;
    // The manual route proof owns an absolute 30fps clock. Waiting for an
    // additional RAF after approaching the deadline introduces a systematic
    // 8-16ms phase slip; the independent realtime proof above exercises the
    // production RAF owner. Timers may wake early, so retain the deadline loop.
    await new Promise<void>((resolve) =>
      globalThis.setTimeout(resolve, Math.max(0, remaining))
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) =>
    typeof child === "bigint" ? child.toString() : child
  );
}

function requireProof(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new Error(message);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (Array.isArray(value)) {
    for (const child of value) deepFreeze(child);
    return Object.freeze(value) as Readonly<T>;
  }
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value) as Readonly<T>;
  }
  return value;
}
