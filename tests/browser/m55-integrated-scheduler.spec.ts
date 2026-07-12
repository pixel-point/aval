import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

interface CandidateSupport {
  readonly id: string;
  readonly rank: number;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly codedArea: number;
  readonly peakBitrate: number;
  readonly exactConfigSupported: boolean;
  readonly reason: string | null;
}

interface M55BrowserSupport {
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
  readonly candidates: readonly CandidateSupport[];
}

interface FrameEvidence {
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

interface WaitEvidence {
  readonly edge: string;
  readonly policy: "portal" | "finish";
  readonly declaredMaximumTicks: number;
  readonly observedTicks: number;
}

interface M55IntegratedProofReport {
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
  readonly readiness: {
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
  };
  readonly realtime: {
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
  };
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
  readonly frames: readonly FrameEvidence[];
  readonly waits: readonly WaitEvidence[];
  readonly scenarios: {
    readonly introBody: readonly [
      "intro:0",
      "intro:1",
      "intro:2",
      "idle-body:0"
    ];
    readonly loopBoundary: readonly ["idle-body:7", "idle-body:0"];
    readonly bridgeThenTarget: readonly [
      "loading-bridge:0",
      "loading-body:0"
    ];
    readonly finishTarget: "done-body:0";
    readonly cut: {
      readonly requestTick: number;
      readonly targetTick: number;
      readonly target: "idle-body:0";
      readonly drawSource: "resident";
    };
    readonly activeReversal: {
      readonly requestTick: number;
      readonly adjacentTick: number;
      readonly fromFrame: number;
      readonly adjacentFrame: number;
      readonly drawSource: "resident";
    };
    readonly endpoints: readonly {
      readonly state: "idle" | "hover";
      readonly runwayFrames: number;
      readonly continuationPreparedByFrame: number;
      readonly observedFrame: string;
      readonly observedTick: number;
      readonly drawSource: "resident" | "streaming";
      readonly continuedWithoutUnderflow: true;
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
    readonly records: readonly {
      readonly sequence: number;
      readonly kind: "request" | "event" | "draw" | "static-draw" | "promise";
      readonly label: string;
      readonly requestedState: string | null;
      readonly visualState: string | null;
      readonly isTransitioning: boolean;
    }[];
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
    readonly playerDisposed: true;
    readonly workerAlive: false;
    readonly workerPendingOperations: 0;
    readonly workerPendingWaiters: 0;
    readonly clientOpenFrames: 0;
    readonly pendingSamples: 0;
    readonly submittedFrames: 0;
    readonly leasedFrames: 0;
    readonly leasedDecodedBytes: 0;
    readonly rendererState: "disposed";
    readonly rendererLiveResources: 0;
    readonly rendererUploads: number;
    readonly rendererStaleUploads: number;
    readonly rendererClosedSourceFrames: number;
    readonly staticStoreState: "disposed";
    readonly staticRetainedSurfaces: 0;
    readonly staticDecodedSurfaces: number;
    readonly staticClosedSurfaces: number;
    readonly pendingCallbacks: 0;
    readonly pendingPromises: 0;
    readonly traceRecords: number;
  };
}

interface M55BrowserHarness {
  probeM55IntegratedSupport(assetBase64: string): Promise<M55BrowserSupport>;
  runM55IntegratedProof(
    assetBase64: string
  ): Promise<M55IntegratedProofReport | M55BrowserSupport>;
}

const FIXTURE_PATH = fileURLToPath(
  new URL("../../fixtures/conformance/m55/opaque-all-routes.rma", import.meta.url)
);
const FIXTURE_SHA256 =
  "28bbd6ca250fff5571ff9ef8a95a69d878e198641a05e8923743a521106f70d5";

test("reports exact M5.5 browser support without a codec substitute", async ({
  page
}) => {
  const fixture = await readFile(FIXTURE_PATH);
  expect(createHash("sha256").update(fixture).digest("hex"))
    .toBe(FIXTURE_SHA256);

  await page.goto("/src/m55-integrated-proof.ts");
  const support = await callProbe(page, fixture.toString("base64"));

  expect(support.asset).toEqual({
    formatVersion: "0.1",
    bytes: fixture.byteLength,
    sha256: FIXTURE_SHA256,
    readinessPolicy: "all-routes"
  });
  expect(support.codec).toBe("avc1.42E020");
  expect(support.vp8Substitution).toBe(false);
  expect(support.candidates.map(({ id, rank, codedWidth, codedHeight,
    codedArea, peakBitrate }) => ({
    id,
    rank,
    codedWidth,
    codedHeight,
    codedArea,
    peakBitrate
  }))).toEqual([
    {
      id: "opaque.1x",
      rank: 0,
      codedWidth: 32,
      codedHeight: 32,
      codedArea: 1_024,
      peakBitrate: 600_000
    },
    {
      id: "opaque.0.5x",
      rank: 1,
      codedWidth: 16,
      codedHeight: 16,
      codedArea: 256,
      peakBitrate: 200_000
    }
  ]);

  if (support.status === "unsupported") {
    expect(support.reason).toEqual(expect.any(String));
    expect(support.reason?.length).toBeGreaterThan(0);
    expect(support.candidates.every(({ exactConfigSupported }) =>
      !exactConfigSupported
    ) || !support.webgl2 || !support.moduleWorker || !support.staticPng)
      .toBe(true);
  } else {
    expect(support.reason).toBeNull();
    expect(support.webCodecs).toBe(true);
    expect(support.moduleWorker).toBe(true);
    expect(support.webgl2).toBe(true);
    expect(support.staticPng).toBe(true);
    expect(support.candidates.some(({ exactConfigSupported }) =>
      exactConfigSupported
    )).toBe(true);
  }
});

test("drives every M5.5 route through the real worker and WebGL2 renderer", async ({
  page
}, testInfo) => {
  test.setTimeout(120_000);
  const browserErrors = collectBrowserErrors(page);
  const fixture = await readFile(FIXTURE_PATH);
  const assetBase64 = fixture.toString("base64");

  await page.goto("/src/m55-integrated-proof.ts");
  const support = await callProbe(page, assetBase64);
  test.skip(
    support.status === "unsupported",
    `exact M5.5 browser profile unsupported: ${support.reason ?? "no reason"}`
  );

  const result = await page.evaluate(async (base64) => {
    const moduleUrl = "/src/m55-integrated-proof.ts";
    const harness = (await import(moduleUrl)) as unknown as M55BrowserHarness;
    return harness.runM55IntegratedProof(base64);
  }, assetBase64);
  expect(result.status).toBe("supported");
  const report = result as M55IntegratedProofReport;

  const supportedOrder = report.support.candidates
    .filter(({ exactConfigSupported }) => exactConfigSupported)
    .map(({ id }) => id);
  expect(supportedOrder.length).toBeGreaterThan(0);
  expect(report.selection).toMatchObject({
    candidateOrder: [
      { id: "opaque.1x", codedArea: 1_024, peakBitrate: 600_000, rank: 0 },
      { id: "opaque.0.5x", codedArea: 256, peakBitrate: 200_000, rank: 1 }
    ],
    selectedRendition: supportedOrder[0]
  });
  expect(report.selection.candidateOutcomes.at(-1)).toEqual({
    rendition: supportedOrder[0],
    rank: report.support.candidates.find(({ id }) => id === supportedOrder[0])
      ?.rank,
    outcome: "selected"
  });

  expect(report.readiness).toMatchObject({
    policy: "all-routes",
    passed: true,
    authoredFramesPerSecond: 30,
    directEdgeCount: 6,
    loopCount: 2,
    endpointCount: 2,
    allDeadlineSafe: true,
    allWithinBudget: true,
    resourcePassed: true,
    initialRingPassed: true
  });
  expect(report.readiness.warmupOutputs).toBeGreaterThanOrEqual(24);
  expect(report.readiness.measuredFramesPerSecond).toBeGreaterThanOrEqual(45);
  expect(report.readiness.decodeLeadFrames).toBeLessThanOrEqual(11);
  expect(report.readiness.ringCapacity).toBeGreaterThanOrEqual(6);
  expect(report.readiness.ringCapacity).toBeLessThanOrEqual(12);
  expect(report.realtime).toMatchObject({
    selectedRendition: supportedOrder[0],
    introBody: ["intro:0", "intro:1", "intro:2", "idle-body:0"],
    loopSeams: 5,
    advancedTicks: 43,
    underflows: 0,
    smoothSession: true,
    parkedCallbacks: 1,
    workerConfigureCalls: 1,
    cleanup: {
      playerDisposed: true,
      realtimeDisposed: true,
      pendingCallbacks: 0,
      compositionComplete: true,
      workerAlive: false,
      rendererLiveResources: 0,
      staticRetainedSurfaces: 0
    }
  });
  expect(report.realtime.observedFrames).toHaveLength(44);
  expect(report.realtime.displayCallbacks).toBeGreaterThanOrEqual(
    report.realtime.advancedTicks
  );
  expect(report.realtime.authoredFrameDurationMs).toBeCloseTo(1_000 / 30, 6);
  expect(report.realtime.displayCallbackTimestampsMs).toHaveLength(
    report.realtime.displayCallbacks
  );
  expect(report.realtime.contentDrawTimestampsMs).toHaveLength(
    report.realtime.advancedTicks
  );
  expect(report.realtime.contentTickTimestampsMs).toHaveLength(
    report.realtime.advancedTicks
  );
  expect(report.realtime.contentDrawTimestampsMs[0]).toBeGreaterThanOrEqual(
    report.realtime.startedAtMs
  );
  expectStrictlyIncreasing(report.realtime.displayCallbackTimestampsMs);
  expectStrictlyIncreasing(report.realtime.contentTickTimestampsMs);
  expectStrictlyIncreasing(report.realtime.contentDrawTimestampsMs);
  for (const timestamp of report.realtime.contentTickTimestampsMs) {
    expect(report.realtime.displayCallbackTimestampsMs).toContain(timestamp);
  }
  expect(report.realtime.minimumContentIntervalMs).toBeGreaterThanOrEqual(
    report.realtime.authoredFrameDurationMs * 0.45
  );
  expect(report.realtime.maximumContentIntervalMs).toBeLessThanOrEqual(
    report.realtime.authoredFrameDurationMs * 1.75
  );
  expect(report.realtime.p95ContentIntervalMs).toBeLessThanOrEqual(
    report.realtime.authoredFrameDurationMs * 1.65
  );
  expect(report.realtime.averageContentIntervalMs).toBeLessThanOrEqual(
    report.realtime.authoredFrameDurationMs * 1.25
  );
  expect(report.realtime.maximumDisplayCallbackIntervalMs)
    .toBeLessThanOrEqual(report.realtime.authoredFrameDurationMs * 1.75);
  expect(report.realtime.p95DisplayCallbackIntervalMs).toBeLessThanOrEqual(
    report.realtime.authoredFrameDurationMs * 1.65
  );
  expect(report.realtime.maximumDrawSubmissionLatencyMs).toBeLessThanOrEqual(
    report.realtime.authoredFrameDurationMs * 0.5
  );
  expect(report.realtime.elapsedFromStartMs).toBeLessThanOrEqual(
    (report.realtime.advancedTicks + 4) *
      report.realtime.authoredFrameDurationMs
  );
  expect(report.realtime.contentSpanMs).toBeLessThanOrEqual(
    (report.realtime.advancedTicks - 1) *
      report.realtime.authoredFrameDurationMs * 1.25
  );
  expect(report.realtime.cleanup.cancelledCallbacks).toBeGreaterThanOrEqual(1);
  expect(report.cadence.authoredFrameDurationMs).toBeCloseTo(1_000 / 30, 6);
  expect(report.cadence.ticks).toBeGreaterThan(30);
  expect(report.cadence.underflows).toBe(0);
  expect(report.cadence.burstDebtTicks).toBe(0);
  expect(report.cadence.minimumObservedIntervalMs).toBeGreaterThanOrEqual(
    report.cadence.authoredFrameDurationMs * 0.75
  );
  expect(report.cadence.maximumObservedIntervalMs).toBeLessThanOrEqual(
    report.cadence.authoredFrameDurationMs * 1.75
  );
  expect(report.cadence.p95ObservedIntervalMs).toBeLessThanOrEqual(
    report.cadence.authoredFrameDurationMs * 1.5
  );
  expect(report.cadence.averageObservedIntervalMs).toBeLessThanOrEqual(
    report.cadence.authoredFrameDurationMs * 1.25
  );
  expect(report.cadence.elapsedMs).toBeLessThanOrEqual(
    report.cadence.ticks * report.cadence.authoredFrameDurationMs * 1.25
  );
  expect(report.cadence.maxObservedLatenessMs).toBeLessThanOrEqual(
    report.cadence.authoredFrameDurationMs * 0.75
  );

  expect(report.scenarios.introBody).toEqual([
    "intro:0",
    "intro:1",
    "intro:2",
    "idle-body:0"
  ]);
  expect(report.scenarios.loopBoundary).toEqual([
    "idle-body:7",
    "idle-body:0"
  ]);
  expect(new Set(report.waits.map(({ edge }) => edge))).toEqual(new Set([
    "idle-hover",
    "hover-idle",
    "idle-loading",
    "loading-done",
    "done-idle"
  ]));
  for (const wait of report.waits) {
    expect(wait.observedTicks).toBeGreaterThanOrEqual(0);
    expect(wait.observedTicks).toBeLessThanOrEqual(wait.declaredMaximumTicks);
  }
  expect(report.scenarios.bridgeThenTarget).toEqual([
    "loading-bridge:0",
    "loading-body:0"
  ]);
  expect(report.scenarios.finishTarget).toBe("done-body:0");
  expect(report.scenarios.cut).toMatchObject({
    target: "idle-body:0",
    drawSource: "resident"
  });
  expect(report.scenarios.cut.targetTick - report.scenarios.cut.requestTick)
    .toBe(1);
  expect(report.scenarios.activeReversal).toMatchObject({
    drawSource: "resident"
  });
  expect(
    report.scenarios.activeReversal.adjacentTick -
      report.scenarios.activeReversal.requestTick
  ).toBe(1);
  expect(Math.abs(
    report.scenarios.activeReversal.adjacentFrame -
      report.scenarios.activeReversal.fromFrame
  )).toBe(1);
  expect(report.scenarios.endpoints.map(({ state }) => state).sort())
    .toEqual(["hover", "idle"]);
  for (const endpoint of report.scenarios.endpoints) {
    expect(endpoint.runwayFrames).toBe(6);
    expect(endpoint.continuationPreparedByFrame)
      .toBeLessThan(endpoint.runwayFrames);
    expect(endpoint.observedFrame).toBe(`${endpoint.state}-body:6`);
    expect(endpoint.observedTick).toBeGreaterThan(0);
    expect(endpoint.drawSource).toBe("streaming");
    expect(endpoint.continuedWithoutUnderflow).toBe(true);
  }
  expect(report.scenarios.lockedFollowOn).toEqual({
    requested: "done",
    converged: "done",
    settled: true
  });
  expect(report.scenarios.latestWins).toEqual({
    requested: ["done", "idle"],
    converged: "idle",
    supersededRejected: true,
    latestSettled: true
  });

  expect(report.frames.length).toBeGreaterThan(30);
  for (const frame of report.frames) {
    expect(frame.observedSourceOrdinal).toBe(frame.expectedSourceOrdinal);
    expect(frame.minimumLumaMargin).toBeGreaterThan(0);
  }

  expect(report.ordering.animatedTransitionStartSequence)
    .toBeLessThan(report.ordering.animatedFirstDrawSequence);
  expect(report.ordering.animatedFirstDrawSequence)
    .toBeLessThan(report.ordering.animatedTargetDrawSequence);
  expect(report.ordering.animatedTargetDrawSequence)
    .toBeLessThan(report.ordering.animatedVisualStateSequence);
  expect(report.ordering.animatedVisualStateSequence)
    .toBeLessThan(report.ordering.animatedTransitionEndSequence);
  expect(report.ordering.animatedTransitionEndSequence)
    .toBeLessThan(report.ordering.animatedPromiseSequence);
  const animatedTargetDraw = report.ordering.records.find(({ sequence }) =>
    sequence === report.ordering.animatedTargetDrawSequence
  );
  const animatedVisualState = report.ordering.records.find(({ sequence }) =>
    sequence === report.ordering.animatedVisualStateSequence
  );
  const animatedPromise = report.ordering.records.find(({ sequence }) =>
    sequence === report.ordering.animatedPromiseSequence
  );
  expect(animatedTargetDraw).toMatchObject({
    kind: "draw",
    requestedState: "hover",
    visualState: "idle",
    isTransitioning: true
  });
  expect(animatedVisualState).toMatchObject({
    kind: "event",
    requestedState: "hover",
    visualState: "hover"
  });
  expect(animatedPromise).toMatchObject({
    kind: "promise",
    requestedState: "hover",
    visualState: "hover",
    isTransitioning: false
  });
  expect(report.ordering.recoveryRequestSequence)
    .toBeLessThan(report.ordering.fallbackSequence);
  expect(report.ordering.fallbackSequence)
    .toBeLessThan(report.ordering.staticDrawSequence);
  expect(report.ordering.staticDrawSequence)
    .toBeLessThan(report.ordering.visualStateSequence);
  expect(report.ordering.visualStateSequence)
    .toBeLessThan(report.ordering.transitionEndSequence);
  expect(report.ordering.transitionEndSequence)
    .toBeLessThan(report.ordering.promiseSequence);
  const recoveryDraw = report.ordering.records.find(({ sequence }) =>
    sequence === report.ordering.staticDrawSequence
  );
  const recoveryVisual = report.ordering.records.find(({ sequence }) =>
    sequence === report.ordering.visualStateSequence
  );
  const recoveryPromise = report.ordering.records.find(({ sequence }) =>
    sequence === report.ordering.promiseSequence
  );
  expect(recoveryDraw).toMatchObject({
    kind: "static-draw",
    requestedState: "hover",
    visualState: "idle",
    isTransitioning: true
  });
  expect(recoveryVisual).toMatchObject({
    requestedState: "hover",
    visualState: "hover"
  });
  expect(recoveryPromise).toMatchObject({
    kind: "promise",
    requestedState: "hover",
    visualState: "hover",
    isTransitioning: false
  });
  const orderSequences = report.ordering.records.map(({ sequence }) =>
    sequence
  );
  expect(orderSequences).toEqual(
    [...orderSequences].sort((left, right) => left - right)
  );

  expect(report.recovery).toEqual({
    failureInduced: true,
    requestedState: "hover",
    staticState: "hover",
    readiness: "staticReady",
    selectedRendition: null,
    tickStatus: "stopped",
    reason: "animation-failure"
  });
  expect(report.worker).toMatchObject({
    configureCalls: 1,
    resetCalls: 0,
    flushCalls: 0,
    boundaryFlushCalls: 0,
    terminalDisposed: true,
    pendingSamples: 0,
    submittedFrames: 0,
    leasedFrames: 0,
    leasedDecodedBytes: 0,
    decodeQueueSize: 0,
    clientOpenFrames: 0
  });
  expect(report.worker.terminalReleaseGap).toBe(
    report.worker.deliveredFrames - report.worker.releasedFrames
  );
  expect(report.worker.terminalReleaseGap).toBeGreaterThanOrEqual(0);
  expect(report.worker.terminalReleaseGap).toBeLessThanOrEqual(12);
  expect(report.worker.closedFrames).toBeGreaterThanOrEqual(
    report.worker.staleFrames
  );
  expect(report.worker.outputFrames).toBeGreaterThanOrEqual(
    report.worker.deliveredFrames
  );
  expect(report.cleanup).toMatchObject({
    playerDisposed: true,
    workerAlive: false,
    workerPendingOperations: 0,
    workerPendingWaiters: 0,
    clientOpenFrames: 0,
    pendingSamples: 0,
    submittedFrames: 0,
    leasedFrames: 0,
    leasedDecodedBytes: 0,
    rendererState: "disposed",
    rendererLiveResources: 0,
    staticStoreState: "disposed",
    staticRetainedSurfaces: 0,
    pendingCallbacks: 0,
    pendingPromises: 0
  });
  expect(report.cleanup.staticDecodedSurfaces)
    .toBe(report.cleanup.staticClosedSurfaces);
  expect(report.cleanup.rendererClosedSourceFrames).toBe(
    report.cleanup.rendererUploads + report.cleanup.rendererStaleUploads
  );
  expect(report.cleanup.traceRecords).toBeGreaterThan(0);
  expect(report.cleanup.traceRecords).toBeLessThanOrEqual(512);
  expect(browserErrors).toEqual([]);

  const evidenceCapture = {
    support: report.support,
    selection: report.selection,
    readiness: report.readiness,
    realtime: {
      selectedRendition: report.realtime.selectedRendition,
      observedFrameCount: report.realtime.observedFrames.length,
      authoredFrameDurationMs: report.realtime.authoredFrameDurationMs,
      minimumContentIntervalMs: report.realtime.minimumContentIntervalMs,
      maximumContentIntervalMs: report.realtime.maximumContentIntervalMs,
      p95ContentIntervalMs: report.realtime.p95ContentIntervalMs,
      averageContentIntervalMs: report.realtime.averageContentIntervalMs,
      maximumDisplayCallbackIntervalMs:
        report.realtime.maximumDisplayCallbackIntervalMs,
      p95DisplayCallbackIntervalMs:
        report.realtime.p95DisplayCallbackIntervalMs,
      maximumDrawSubmissionLatencyMs:
        report.realtime.maximumDrawSubmissionLatencyMs,
      elapsedFromStartMs: report.realtime.elapsedFromStartMs,
      contentSpanMs: report.realtime.contentSpanMs,
      loopSeams: report.realtime.loopSeams,
      displayCallbacks: report.realtime.displayCallbacks,
      advancedTicks: report.realtime.advancedTicks,
      underflows: report.realtime.underflows,
      smoothSession: report.realtime.smoothSession,
      parkedCallbacks: report.realtime.parkedCallbacks,
      workerConfigureCalls: report.realtime.workerConfigureCalls,
      cleanup: report.realtime.cleanup
    },
    cadence: report.cadence,
    frameEvidenceCount: report.frames.length,
    waits: report.waits,
    worker: report.worker,
    cleanup: report.cleanup
  } as const;
  const evidenceJson = JSON.stringify(evidenceCapture, null, 2);
  if (process.env.M55_EVIDENCE_CAPTURE === "1") {
    process.stdout.write(`M55_EVIDENCE ${evidenceJson}\n`);
  }
  await testInfo.attach("m55-integrated-evidence", {
    body: Buffer.from(evidenceJson),
    contentType: "application/json"
  });
});

function expectStrictlyIncreasing(values: readonly number[]): void {
  expect(values.length).toBeGreaterThanOrEqual(2);
  for (let index = 1; index < values.length; index += 1) {
    expect(values[index]).toBeGreaterThan(values[index - 1]!);
  }
}

async function callProbe(
  page: Page,
  assetBase64: string
): Promise<M55BrowserSupport> {
  return page.evaluate(async (base64) => {
    const moduleUrl = "/src/m55-integrated-proof.ts";
    const harness = (await import(moduleUrl)) as unknown as M55BrowserHarness;
    return harness.probeM55IntegratedSupport(base64);
  }, assetBase64);
}

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  return errors;
}
