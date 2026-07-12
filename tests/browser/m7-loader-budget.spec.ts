import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import {
  ZERO_TERMINAL,
  assertLoaderTelemetryTerminal,
  decoderFifoFailureProof,
  decoderFifoProof,
  loaderProof,
  metrics,
  sessionPlayerProof,
  uniqueSession
} from "./m7-loader-budget.support.js";

const PROVENANCE_PATH = fileURLToPath(new URL(
  "../../fixtures/conformance/m7/reference-packed.provenance.json",
  import.meta.url
));


test("loads and verifies the sparse fixture through only public runtime exports", async ({ page }) => {
  const provenance = JSON.parse(await readFile(PROVENANCE_PATH, "utf8"));
  const session = uniqueSession("public-range");
  await page.goto("/");

  const report = await loaderProof(page, session, "exact-range", {
    initialStatic: provenance.initialStatic.staticFrame,
    rendition: provenance.selectedRendition.id
  });
  expect(report.status).toBe("loaded");
  if (report.status !== "loaded") {
    throw new Error(`exact-range loader proof failed: ${report.code}`);
  }
  expect(report.mode).toBe("range");
  expect(report.terminal).toEqual(ZERO_TERMINAL);
  expect(report.phases?.map(({ phase }) => phase)).toEqual([
    "metadata",
    "initial-static",
    "all-statics",
    "rendition"
  ]);
  expect(report.phases?.[0]?.residency).toMatchObject({
    mode: "range",
    metadataBytes: provenance.metadata.frontIndex.length,
    verifiedPayloadBytes: 0,
    unitBlobs: { verified: 0 },
    staticBlobs: { verified: 0 }
  });
  expect(report.phases?.[1]?.residency.staticBlobs.verified).toBe(1);
  expect(report.phases?.[2]?.residency.staticBlobs.verified).toBe(3);
  expect(report.phases?.[3]?.residency.unitBlobs.verified).toBe(
    provenance.blobs.filter((blob: { kind: string; rendition?: string }) =>
      blob.kind === "unit" &&
      blob.rendition === provenance.selectedRendition.id
    ).length
  );
  const expectedDigestBytes = provenance.blobs
    .filter((blob: { kind: string; rendition?: string }) =>
      blob.kind === "static" ||
      blob.rendition === provenance.selectedRendition.id
    )
    .reduce((sum: number, blob: { length: number }) => sum + blob.length, 0);
  expect(report.telemetry).toMatchObject({
    activeBodies: 0,
    activeReaders: 0,
    peakActiveBodies: 1,
    peakActiveReaders: 1,
    cancelledReaders: 0,
    releasedReaders: 5,
    digestCalls: 10,
    digestBytes: expectedDigestBytes,
    parserCalls: { header: 1, frontIndex: 1, completeAsset: 0 },
    pngGateCalls: 3,
    mediaGateCalls: 1,
    resources: {
      reservationFailures: 0,
      peakCategories: {
        "asset-metadata": provenance.metadata.frontIndex.length,
        "verified-static": provenance.blobs
          .filter((blob: { kind: string }) => blob.kind === "static")
          .reduce((sum: number, blob: { length: number }) => sum + blob.length, 0)
      }
    }
  });
  expect(report.telemetry.bodies).toHaveLength(5);
  expect(report.telemetry.bodies.every((body) =>
    body.completed && !body.cancelled && !body.readFailed &&
    body.declaredBytes === body.observedBytes
  )).toBe(true);
  expect(report.telemetry.resources.responseBodyPeakBytes).toBeGreaterThan(0);
  expect(report.telemetry.resources.assemblyPeakBytes).toBeGreaterThan(0);
  assertLoaderTelemetryTerminal(report.telemetry);

  const snapshot = await metrics(page, session);
  expect(snapshot.activeResponses).toBe(0);
  expect(snapshot.peakActiveResponses).toBe(1);
  expect(snapshot.requests.map(({ range }) => range)).toEqual([
    "bytes=0-63",
    `bytes=64-${String(provenance.metadata.frontIndex.length - 1)}`,
    `bytes=${String(provenance.expectedRangePlans.currentStatic[0].offset)}-${String(
      provenance.expectedRangePlans.currentStatic[0].offset +
      provenance.expectedRangePlans.currentStatic[0].length - 1
    )}`,
    `bytes=${String(provenance.expectedRangePlans.allStatics[0].offset)}-${String(
      provenance.expectedRangePlans.currentStatic[0].offset - 1
    )}`,
    `bytes=${String(provenance.expectedRangePlans.selectedRendition[0].offset)}-${String(
      provenance.expectedRangePlans.selectedRendition[0].offset +
      provenance.expectedRangePlans.selectedRendition[0].length - 1
    )}`
  ]);
  for (const request of snapshot.requests.slice(1)) {
    expect(request.ifRange).toBe(provenance.asset.strongEntityTag);
  }
});

test("uses bounded full fallbacks and externally gates the complete entity", async ({ page }) => {
  const provenance = JSON.parse(await readFile(PROVENANCE_PATH, "utf8"));
  await page.goto("/");

  for (const scenario of [
    "ignored-initial-range",
    "no-validator",
    "weak-etag"
  ] as const) {
    const session = uniqueSession(`public-${scenario}`);
    const report = await loaderProof(page, session, scenario, {
      initialStatic: provenance.initialStatic.staticFrame,
      rendition: provenance.selectedRendition.id,
      stopAfter: "metadata"
    });
    expect(report).toMatchObject({
      status: "loaded",
      mode: "full",
      terminal: ZERO_TERMINAL
    });
    expect(report.telemetry).toMatchObject({
      digestCalls: 0,
      parserCalls: { header: 0, frontIndex: 0, completeAsset: 1 },
      pngGateCalls: 0,
      mediaGateCalls: 0,
      resources: {
        quarantinePeakBytes: provenance.asset.bytes,
        assemblyPeakBytes: 0,
        peakCategories: { "asset-full": provenance.asset.bytes }
      }
    });
    assertLoaderTelemetryTerminal(report.telemetry);
    const snapshot = await metrics(page, session);
    expect(snapshot.activeResponses).toBe(0);
    expect(snapshot.requests).toHaveLength(
      scenario === "ignored-initial-range" ? 1 : 2
    );
    if (snapshot.requests.length === 2) {
      expect(snapshot.requests[1]?.range).toBeNull();
      expect(snapshot.requests[1]?.ifRange).toBeNull();
    }
  }

  const validSession = uniqueSession("public-external-valid");
  const valid = await loaderProof(
    page,
    validSession,
    "valid-external-integrity",
    {
      initialStatic: provenance.initialStatic.staticFrame,
      rendition: provenance.selectedRendition.id,
      integrity: provenance.asset.externalIntegrity,
      stopAfter: "metadata"
    }
  );
  expect(valid).toMatchObject({
    status: "loaded",
    mode: "full",
    terminal: ZERO_TERMINAL
  });
  expect(valid.telemetry).toMatchObject({
    digestCalls: 1,
    digestBytes: provenance.asset.bytes,
    parserCalls: { header: 0, frontIndex: 0, completeAsset: 1 },
    pngGateCalls: 0,
    mediaGateCalls: 0,
    resources: {
      quarantinePeakBytes: provenance.asset.bytes,
      peakCategories: { "asset-full": provenance.asset.bytes }
    }
  });
  assertLoaderTelemetryTerminal(valid.telemetry);
  expect((await metrics(page, validSession)).requests).toEqual([
    expect.objectContaining({ range: null, ifRange: null })
  ]);

  const invalidSession = uniqueSession("public-external-invalid");
  const invalid = await loaderProof(
    page,
    invalidSession,
    "invalid-external-integrity",
    {
      initialStatic: provenance.initialStatic.staticFrame,
      rendition: provenance.selectedRendition.id,
      integrity:
        "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      stopAfter: "metadata"
    }
  );
  expect(invalid).toMatchObject({
    status: "failed",
    code: "integrity-mismatch",
    openedMode: null,
    terminal: ZERO_TERMINAL
  });
  expect(invalid.telemetry).toMatchObject({
    digestCalls: 1,
    digestBytes: provenance.asset.bytes,
    parserCalls: { header: 0, frontIndex: 0, completeAsset: 0 },
    pngGateCalls: 0,
    mediaGateCalls: 0,
    resources: {
      unpromotedFullReleases: 1,
      quarantinePeakBytes: provenance.asset.bytes,
      peakCategories: { "asset-full": 0 }
    }
  });
  assertLoaderTelemetryTerminal(invalid.telemetry);
  expect((await metrics(page, invalidSession)).requests).toEqual([
    expect.objectContaining({ range: null, ifRange: null })
  ]);
});

test("contains hostile transport and payload failures with zero retained resources", async ({ page }) => {
  const provenance = JSON.parse(await readFile(PROVENANCE_PATH, "utf8"));
  await page.goto("/");
  const cases = [
    { scenario: "changed-etag", stopAfter: "metadata", code: "entity-changed" },
    { scenario: "wrong-total", stopAfter: "metadata", code: "range-response-invalid" },
    { scenario: "truncated-body", stopAfter: "metadata", code: "watchdog-timeout" },
    { scenario: "oversized-body", stopAfter: "metadata", code: "range-response-invalid" },
    { scenario: "compressed-body", stopAfter: "metadata", code: "load-failure" },
    { scenario: "corrupt-static", stopAfter: "initial-static", code: "integrity-mismatch" },
    { scenario: "nonzero-padding", stopAfter: "rendition", code: "load-failure" },
    { scenario: "corrupt-unit", stopAfter: "rendition", code: "integrity-mismatch" },
    {
      scenario: "stalled-body",
      stopAfter: "metadata",
      timeoutMs: 250,
      code: "watchdog-timeout"
    }
  ] as const;

  for (const entry of cases) {
    const session = uniqueSession(`public-${entry.scenario}`);
    const report = await loaderProof(page, session, entry.scenario, {
      initialStatic: provenance.initialStatic.staticFrame,
      rendition: provenance.selectedRendition.id,
      stopAfter: entry.stopAfter,
      ...("timeoutMs" in entry
        ? { timeoutMs: entry.timeoutMs }
        : {})
    });
    expect(report.status, entry.scenario).toBe("failed");
    if (report.status !== "failed") {
      throw new Error(`${entry.scenario} unexpectedly loaded`);
    }
    expect(report.code, entry.scenario).toBe(entry.code);
    expect(report.terminal, entry.scenario).toEqual(ZERO_TERMINAL);
    expect(report.telemetry.mediaGateCalls, entry.scenario).toBe(0);
    assertLoaderTelemetryTerminal(report.telemetry);
    if (entry.scenario === "corrupt-static") {
      expect(report.telemetry).toMatchObject({
        digestCalls: 1,
        pngGateCalls: 0,
        parserCalls: { header: 1, frontIndex: 1, completeAsset: 0 }
      });
    }
    if (entry.scenario === "corrupt-unit") {
      expect(report.telemetry.digestCalls).toBeGreaterThan(3);
      expect(report.telemetry.pngGateCalls).toBe(3);
      expect(report.telemetry.parserCalls.completeAsset).toBe(0);
    }
    if (entry.scenario === "stalled-body") {
      expect(report.telemetry.cancelledReaders).toBe(1);
      expect(report.telemetry.timers.fired).toBeGreaterThan(0);
      expect(report.telemetry.bodies[0]).toMatchObject({
        declaredBytes: 64,
        observedBytes: 32,
        cancelled: true
      });
    }
    if (entry.scenario === "oversized-body") {
      expect(report.telemetry.cancelledReaders).toBe(1);
      expect(report.telemetry.bodies[0]).toMatchObject({
        declaredBytes: 64,
        observedBytes: 65,
        cancelled: true
      });
    }
    await expect.poll(
      async () => (await metrics(page, session)).activeResponses,
      { message: entry.scenario }
    ).toBe(0);
  }
});

test("enforces two page decoders and advances the third player FIFO", async ({ page }) => {
  test.setTimeout(120_000);
  const sessions = [
    uniqueSession("public-fifo-first"),
    uniqueSession("public-fifo-second"),
    uniqueSession("public-fifo-third")
  ] as const;
  await page.goto("/");
  const report = await decoderFifoProof(page, sessions);

  expect(report.terminal).toHaveLength(3);
  for (const terminal of report.terminal) {
    expect(terminal.session).toMatchObject({
      disposed: true,
      metadataBytes: 0,
      verifiedPayloadBytes: 0,
      activeTransportBodies: 0,
      pendingLoads: 0,
      interestedWaiters: 0
    });
    expect(terminal.account).toEqual({
      disposed: true,
      activeLeases: 0,
      participantAttached: false,
      lifecycleState: "disposed",
      registeredCleanups: 0,
      trackedWork: 0,
      pendingWaits: 0
    });
    expect(terminal.candidate).toMatchObject({
      workersAlive: 0,
      openFrames: 0,
      renderersAlive: 0,
      glResourceCount: 0,
      rendererStagingBytes: 0,
      sourceCopiesInFlight: 0,
      pendingOperations: 0,
      complete: true
    });
    expect(terminal.planes).toMatchObject({
      backendAttached: false,
      contextListeners: 0,
      resourceReservations: 0,
      liveResourceTotals: [],
      geometry: null
    });
    if (terminal.store !== null) {
      expect(terminal.store).toMatchObject({
        state: "disposed",
        retainedSurfaces: 0,
        retainedRgbaBytes: 0
      });
    }
    if (terminal.context !== null) {
      expect(terminal.context).toMatchObject({
        state: "disposed",
        listenerCount: 0,
        pendingOperations: 0
      });
    }
    expect(terminal.httpActiveResponses).toBe(0);
    expect(terminal.connected).toBe(false);
  }
  expect(report.page).toMatchObject({
    physicalBytes: 0,
    byteLeases: 0,
    participants: 0,
    decoderLeases: 0,
    decoderQueue: 0,
    pendingReclamations: 0
  });
  for (const session of sessions) {
    expect((await metrics(page, session)).activeResponses).toBe(0);
  }

  if (report.status === "unsupported") {
    expect(report.reason).toBeTruthy();
    test.skip(true, `exact M7 FIFO browser profile unsupported: ${report.reason}`);
    return;
  }

  expect(report.capabilities).toMatchObject({
    webCodecs: true,
    moduleWorker: true,
    webgl2: true,
    staticPng: true
  });
  expect(report.capabilities.candidates.some(
    ({ exactConfigSupported }) => exactConfigSupported
  )).toBe(true);
  expect(report.limit).toBe(2);
  expect(report.initial.players).toHaveLength(3);
  expect(report.initial.players.map(({ mode }) => mode)).toEqual([
    "animated", "animated", "static"
  ]);
  expect(report.initial.players[2]).toMatchObject({
    mode: "static",
    reason: "decoder-queued",
    staticVisible: true,
    decoderPending: true,
    workerAlive: false,
    rendererAlive: false,
    glResourceCount: 0
  });
  expect(report.initial.players[2]!.staticNonTransparentPixels)
    .toBeGreaterThan(0);
  for (const animated of report.initial.players.slice(0, 2)) {
    expect(animated).toMatchObject({
      mode: "animated",
      workerAlive: true,
      rendererAlive: true
    });
    expect(animated.decoderConfigureCalls).toBeGreaterThan(0);
    expect(animated.decoderOutputFrames).toBeGreaterThan(0);
    expect(animated.glResourceCount).toBeGreaterThan(0);
  }
  expect(report.initial.page).toMatchObject({
    participants: 3,
    decoderLeases: 2,
    decoderQueue: 1
  });
  expect(report.initial.decoderQueue).toBe(1);
  expect(report.initial.thirdTicketRetained).toBe(true);

  expect(report.promotion).toMatchObject({
    hiddenPlayer: 0,
    hiddenReadiness: "staticReady",
    hiddenStaticVisible: true,
    thirdReadiness: "interactiveReady",
    thirdFirstFreshDraw: "idle-body:0",
    thirdWorkerAlive: true,
    thirdRendererAlive: true,
    decoderQueue: 0,
    page: { participants: 3, decoderLeases: 2, decoderQueue: 0 }
  });
  expect(report.promotion.thirdCandidateCreatesAfter)
    .toBeGreaterThan(report.promotion.thirdCandidateCreatesBefore);
  expect(report.promotion.thirdDecoderConfigureCalls).toBeGreaterThan(0);
  expect(report.promotion.thirdGlResourceCount).toBeGreaterThan(0);
  expect(report).toMatchObject({
    activeParticipants: 0,
    decoderLeases: 0,
    decoderQueue: 0
  });
});

test("retires all FIFO owners after partial setup or reporting failure", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  const baselineCanvases = await page.locator("canvas").count();
  const partialSessions = [
    uniqueSession("public-fifo-partial-first"),
    uniqueSession("public-fifo-partial-second"),
    uniqueSession("public-fifo-partial-third")
  ] as const;
  const partialFailure = await decoderFifoFailureProof(page,
    partialSessions.map((session, index) => ({
      assetPath: `/__m7__/asset?session=${session}&scenario=${
        index === 2 ? "changed-etag" : "exact-range"
      }`,
      metricsPath: `/__m7__/metrics?session=${session}`
    }))
  );
  expect(partialFailure).toContain("entity");
  for (const session of partialSessions) {
    await expect.poll(async () => (await metrics(page, session)).activeResponses)
      .toBe(0);
  }
  expect(await page.locator("canvas").count()).toBe(baselineCanvases);

  const reportingSessions = [
    uniqueSession("public-fifo-report-first"),
    uniqueSession("public-fifo-report-second"),
    uniqueSession("public-fifo-report-third")
  ] as const;
  const reportingFailure = await decoderFifoFailureProof(page,
    reportingSessions.map((session, index) => ({
      assetPath: `/__m7__/asset?session=${session}&scenario=exact-range`,
      metricsPath: index === 0
        ? "/__m7__/metrics"
        : `/__m7__/metrics?session=${session}`
    }))
  );
  expect(reportingFailure).toContain("terminal cleanup failed");
  for (const session of reportingSessions) {
    expect((await metrics(page, session)).activeResponses).toBe(0);
  }
  expect(await page.locator("canvas").count()).toBe(baselineCanvases);
});

test("evicts and re-decodes a real static surface without another network read", async ({ page }) => {
  const session = uniqueSession("public-static-lru");
  await page.goto("/");
  const report = await page.evaluate(async (session) => {
    const moduleUrl = "/src/m7-loader-budget-proof.ts";
    const proof = await import(/* @vite-ignore */ moduleUrl) as {
      runM7StaticEvictionProof(assetUrl: string): Promise<{
        readonly evictedByPagePressure: true;
        readonly evictedStatic: string;
        readonly redecodedStatic: string;
        readonly retainedBefore: number;
        readonly retainedAfterEviction: number;
        readonly redecodedSurfaces: number;
        readonly staticCounters: Readonly<{
          readonly decodedSurfaces: number;
          readonly redecodedSurfaces: number;
          readonly evictions: number;
          readonly closedBeforeDispose: number;
          readonly closedAfterDispose: number;
          readonly peakRetainedSurfaces: number;
          readonly peakRetainedRgbaBytes: number;
          readonly leaseReservations: number;
          readonly leaseReleasesBeforeDispose: number;
          readonly leaseReleasesAfterDispose: number;
        }>;
        readonly visibility: readonly boolean[];
        readonly terminal: typeof ZERO_TERMINAL;
      }>;
    };
    const assetUrl = new URL(
      `/__m7__/asset?session=${session}&scenario=exact-range`,
      globalThis.location.href
    ).href;
    return proof.runM7StaticEvictionProof(assetUrl);
  }, session);

  expect(report.evictedByPagePressure).toBe(true);
  expect(report.evictedStatic).toBe("static.00");
  expect(report.evictedStatic).toBe(report.redecodedStatic);
  expect(report.retainedBefore).toBe(3);
  expect(report.retainedAfterEviction).toBe(2);
  expect(report.redecodedSurfaces).toBeGreaterThanOrEqual(1);
  expect(report.staticCounters).toEqual({
    decodedSurfaces: 4,
    redecodedSurfaces: 1,
    evictions: 1,
    closedBeforeDispose: 1,
    closedAfterDispose: 4,
    peakRetainedSurfaces: 3,
    peakRetainedRgbaBytes: 14_580,
    leaseReservations: 4,
    leaseReleasesBeforeDispose: 1,
    leaseReleasesAfterDispose: 4
  });
  expect(report.visibility.length).toBeGreaterThan(0);
  expect(report.visibility.every(Boolean)).toBe(true);
  expect(report.terminal).toEqual(ZERO_TERMINAL);
  const transport = await metrics(page, session);
  expect(transport.activeResponses).toBe(0);
  expect(transport.requests).toHaveLength(3);
});

test("runs a session-backed player through visibility and WebGL recovery with exact cleanup", async ({
  page
}) => {
  test.setTimeout(120_000);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => {
    browserErrors.push(`pageerror:${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(`console:${message.text()}`);
    }
  });
  const provenance = JSON.parse(await readFile(PROVENANCE_PATH, "utf8"));
  const session = uniqueSession("public-session-player");
  await page.goto("/");

  const report = await sessionPlayerProof(page, session);
  expect(report.terminal.session).toMatchObject({
    disposed: true,
    metadataBytes: 0,
    verifiedPayloadBytes: 0,
    activeTransportBodies: 0,
    pendingLoads: 0,
    interestedWaiters: 0
  });
  expect(report.terminal.beforeAccountDispose).toMatchObject({
    physicalBytes: 0,
    byteLeases: 0,
    participants: 1,
    decoderLeases: 0,
    decoderQueue: 0,
    pendingReclamations: 0
  });
  expect(report.terminal.page).toMatchObject({
    physicalBytes: 0,
    byteLeases: 0,
    participants: 0,
    decoderLeases: 0,
    decoderQueue: 0,
    pendingReclamations: 0
  });
  expect(report.terminal.http.activeResponses).toBe(0);
  expect(report.terminal.http.cancelledResponses).toBe(0);
  expect(report.terminal.connected).toBe(false);
  expect(browserErrors).toEqual([]);

  if (report.status === "unsupported") {
    expect(report.reason).toBeTruthy();
    expect(
      !report.capabilities.moduleWorker ||
      !report.capabilities.webCodecs ||
      !report.capabilities.webgl2 ||
      !report.capabilities.staticPng ||
      report.capabilities.candidates.every(
        ({ exactConfigSupported }) => !exactConfigSupported
      )
    ).toBe(true);
    expect(report.terminal.http.completedResponses).toBe(2);
    test.skip(true, `exact M7 browser profile unsupported: ${report.reason}`);
    return;
  }

  expect(report.terminal.http.completedResponses).toBe(7);

  expect(report.capabilities).toMatchObject({
    webCodecs: true,
    moduleWorker: true,
    webgl2: true,
    staticPng: true
  });
  expect(report.capabilities.candidates.some(
    ({ exactConfigSupported }) => exactConfigSupported
  )).toBe(true);
  expect(report.preparation).toMatchObject({
    mode: "animated",
    selectedRendition: provenance.selectedRendition.id,
    initialPresentation: "intro:0",
    currentPresentation: "idle-body:0",
    introDraws: 1,
    session: {
      mode: "range",
      metadataBytes: provenance.metadata.frontIndex.length,
      staticBlobs: { verified: 3 }
    },
    page: { decoderLeases: 1, participants: 1 }
  });
  expect(report.preparation?.session.unitBlobs.verified).toBe(
    provenance.blobs.filter((blob: { kind: string; rendition?: string }) =>
      blob.kind === "unit" &&
      blob.rendition === provenance.selectedRendition.id
    ).length
  );
  expect(report.preparation?.page.categories["asset-metadata"])
    .toBe(provenance.metadata.frontIndex.length);

  const visibility = report.visibility!;
  expect(visibility.suspension).toMatchObject({
    visibility: "hidden",
    suspension: "suspended",
    rebuildPending: false
  });
  expect(visibility.suspension.frozenPresentationOrdinal).toBe(
    (BigInt(visibility.before.nextPresentationOrdinal) - 1n).toString()
  );
  expect(visibility.hidden.nextPresentationOrdinal)
    .toBe(visibility.before.nextPresentationOrdinal);
  expect(visibility.afterWallTime.nextPresentationOrdinal)
    .toBe(visibility.before.nextPresentationOrdinal);
  expect(visibility.afterResume.nextPresentationOrdinal)
    .toBe(visibility.before.nextPresentationOrdinal);
  expect(BigInt(visibility.afterNextFrame.nextPresentationOrdinal)).toBe(
    BigInt(visibility.before.nextPresentationOrdinal) + 1n
  );
  expect(visibility.hidden.running).toBe(false);
  expect(visibility.afterResume.running).toBe(true);
  expect(visibility.hiddenPage.decoderLeases).toBe(0);
  expect(visibility.resumedPage.decoderLeases).toBe(1);
  for (const category of [
    "worker-transfer",
    "decoder-output",
    "persistent-animation",
    "streaming-texture",
    "frame-staging"
  ]) expect(visibility.hiddenPage.categories[category]).toBe(0);
  expect(visibility.hiddenCandidate.complete).toBe(true);
  expect(visibility.resumedPresentation).toBe("idle-body:0");
  expect(visibility.nextPresentation).toBe("idle-body:1");
  expect(visibility.staticNonTransparentPixels).toBeGreaterThan(0);
  expect(visibility.coverBeforeCandidateCleanup).toBe(true);
  expect(visibility.introDraws).toBe(1);
  expect(visibility.afterNextFrame.underflows).toBe(0);
  expect(visibility.afterNextFrame.smoothSession).toBe(true);

  const context = report.contextRecovery!;
  expect(context.defaultPrevented).toBe(true);
  expect(context.staticCoveredSynchronously).toBe(true);
  expect(context.staticNonTransparentPixels).toBeGreaterThan(0);
  expect(context.immediate).toMatchObject({
    state: "lost",
    lossCount: 1,
    listenerCount: 2
  });
  expect(context.lost).toMatchObject({
    state: "lost",
    lossCount: 1,
    pendingOperations: 0
  });
  expect(context.restored).toMatchObject({
    state: "ready",
    lossCount: 1,
    restorationCount: 1,
    successfulRestorations: 1,
    listenerCount: 2,
    pendingOperations: 0
  });
  expect(context.lostRealtime.nextPresentationOrdinal)
    .toBe(context.before.nextPresentationOrdinal);
  expect(context.afterWallTime.nextPresentationOrdinal)
    .toBe(context.before.nextPresentationOrdinal);
  expect(context.afterRestore.nextPresentationOrdinal)
    .toBe(context.before.nextPresentationOrdinal);
  expect(BigInt(context.afterNextFrame.nextPresentationOrdinal)).toBe(
    BigInt(context.before.nextPresentationOrdinal) + 1n
  );
  expect(context.lostPage.decoderLeases).toBe(0);
  expect(context.restoredPage.decoderLeases).toBe(1);
  expect(context.lostCandidate.complete).toBe(true);
  expect(context.restoredPresentation).toBe("idle-body:0");
  expect(context.nextPresentation).toBe("idle-body:1");
  expect(context.coverBeforeCandidateCleanup).toBe(true);
  expect(context.introDraws).toBe(1);
  expect(context.afterNextFrame.underflows).toBe(0);
  expect(context.afterNextFrame.smoothSession).toBe(true);

  expect(report.candidates?.filter(({ kind }) => kind === "create"))
    .toHaveLength(3);
  expect(report.candidates?.filter(({ kind }) => kind === "draw-initial")
    .map(({ presentation }) => presentation)).toEqual([
      "intro:0",
      "idle-body:0",
      "idle-body:0"
    ]);
  expect(report.diagnostics).toEqual([]);
  expect(report.terminal.candidate).toMatchObject({
    workersAlive: 0,
    openFrames: 0,
    renderersAlive: 0,
    glResourceCount: 0,
    rendererStagingBytes: 0,
    sourceCopiesInFlight: 0,
    pendingOperations: 0,
    complete: true
  });
  expect(report.terminal.planes).toMatchObject({
    backendAttached: false,
    contextListeners: 0,
    resourceReservations: 0,
    liveResourceTotals: [],
    geometry: null
  });
  expect(report.terminal.store).toMatchObject({
    state: "disposed",
    retainedSurfaces: 0,
    retainedRgbaBytes: 0
  });
  expect(report.terminal.context).toMatchObject({
    state: "disposed",
    listenerCount: 0,
    pendingOperations: 0
  });

  const transport = await metrics(page, session);
  expect(transport.activeResponses).toBe(0);
  expect(transport.cancelledResponses).toBe(0);
  expect(transport.requests.map(({ range }) => range)).toEqual([
    "bytes=0-63",
    `bytes=64-${String(provenance.metadata.frontIndex.length - 1)}`,
    `bytes=${String(provenance.expectedRangePlans.currentStatic[0].offset)}-${String(
      provenance.expectedRangePlans.currentStatic[0].offset +
      provenance.expectedRangePlans.currentStatic[0].length - 1
    )}`,
    `bytes=${String(provenance.expectedRangePlans.allStatics[0].offset)}-${String(
      provenance.expectedRangePlans.currentStatic[0].offset - 1
    )}`,
    `bytes=${String(provenance.expectedRangePlans.selectedRendition[0].offset)}-${String(
      provenance.expectedRangePlans.selectedRendition[0].offset +
      provenance.expectedRangePlans.selectedRendition[0].length - 1
    )}`,
    // Visibility and context recovery deliberately release evictable encoded
    // animation bytes, then reacquire the exact verified entity range.
    `bytes=${String(provenance.expectedRangePlans.selectedRendition[0].offset)}-${String(
      provenance.expectedRangePlans.selectedRendition[0].offset +
      provenance.expectedRangePlans.selectedRendition[0].length - 1
    )}`,
    `bytes=${String(provenance.expectedRangePlans.selectedRendition[0].offset)}-${String(
      provenance.expectedRangePlans.selectedRendition[0].offset +
      provenance.expectedRangePlans.selectedRendition[0].length - 1
    )}`
  ]);
  for (const request of transport.requests.slice(1)) {
    expect(request.ifRange).toBe(provenance.asset.strongEntityTag);
  }
});

test("serves exact entity-pinned ranges through real browser Fetch", async ({ page }) => {
  const provenance = JSON.parse(await readFile(PROVENANCE_PATH, "utf8"));
  const session = uniqueSession("exact");
  await page.goto("/");

  const result = await page.evaluate(async ({ session, etag }) => {
    const endpoint = `/__m7__/asset?session=${session}&scenario=exact-range`;
    const first = await fetch(endpoint, {
      headers: { Range: "bytes=0-63" },
      cache: "no-store"
    });
    const header = new Uint8Array(await first.arrayBuffer());
    const second = await fetch(endpoint, {
      headers: {
        Range: "bytes=64-127",
        "If-Range": etag
      },
      cache: "no-store"
    });
    const tail = new Uint8Array(await second.arrayBuffer());
    return {
      first: {
        status: first.status,
        contentRange: first.headers.get("content-range"),
        etag: first.headers.get("etag"),
        encoding: first.headers.get("content-encoding"),
        length: header.byteLength,
        magic: [...header.slice(0, 4)]
      },
      second: {
        status: second.status,
        contentRange: second.headers.get("content-range"),
        length: tail.byteLength
      }
    };
  }, { session, etag: provenance.asset.strongEntityTag });

  expect(result).toEqual({
    first: {
      status: 206,
      contentRange: `bytes 0-63/${String(provenance.asset.bytes)}`,
      etag: provenance.asset.strongEntityTag,
      encoding: "identity",
      length: 64,
      magic: [82, 77, 65, 70]
    },
    second: {
      status: 206,
      contentRange: `bytes 64-127/${String(provenance.asset.bytes)}`,
      length: 64
    }
  });
  expect(await metrics(page, session)).toEqual({
    requests: [
      {
        ordinal: 1,
        method: "GET",
        range: "bytes=0-63",
        ifRange: null,
        scenario: "exact-range"
      },
      {
        ordinal: 2,
        method: "GET",
        range: "bytes=64-127",
        ifRange: provenance.asset.strongEntityTag,
        scenario: "exact-range"
      }
    ],
    activeResponses: 0,
    peakActiveResponses: 1,
    completedResponses: 2,
    cancelledResponses: 0
  });
});

test("exercises ignored-range and no-validator full-restart contracts", async ({ page }) => {
  const provenance = JSON.parse(await readFile(PROVENANCE_PATH, "utf8"));
  await page.goto("/");
  for (const scenario of ["ignored-initial-range", "no-validator"] as const) {
    const session = uniqueSession(scenario);
    const result = await page.evaluate(async ({ session, scenario }) => {
      const endpoint = `/__m7__/asset?session=${session}&scenario=${scenario}`;
      const first = await fetch(endpoint, {
        headers: { Range: "bytes=0-63" },
        cache: "no-store"
      });
      const firstBytes = new Uint8Array(await first.arrayBuffer());
      if (first.status === 200) {
        return {
          firstStatus: first.status,
          firstBytes: firstBytes.byteLength,
          firstEtag: first.headers.get("etag"),
          second: null
        };
      }
      const second = await fetch(endpoint, { cache: "no-store" });
      return {
        firstStatus: first.status,
        firstBytes: firstBytes.byteLength,
        firstEtag: first.headers.get("etag"),
        second: {
          status: second.status,
          bytes: (await second.arrayBuffer()).byteLength,
          etag: second.headers.get("etag")
        }
      };
    }, { session, scenario });

    if (scenario === "ignored-initial-range") {
      expect(result).toEqual({
        firstStatus: 200,
        firstBytes: provenance.asset.bytes,
        firstEtag: provenance.asset.strongEntityTag,
        second: null
      });
    } else {
      expect(result).toEqual({
        firstStatus: 206,
        firstBytes: 64,
        firstEtag: null,
        second: {
          status: 200,
          bytes: provenance.asset.bytes,
          etag: provenance.asset.strongEntityTag
        }
      });
    }
  }
});

test("retires a browser-aborted stalled response with bounded telemetry", async ({ page }) => {
  const session = uniqueSession("stalled");
  await page.goto("/");
  const outcome = await page.evaluate(async (session) => {
    const controller = new AbortController();
    const pending = fetch(
      `/__m7__/asset?session=${session}&scenario=stalled-body`,
      {
        headers: { Range: "bytes=0-63" },
        signal: controller.signal,
        cache: "no-store"
      }
    ).then(async (response) => response.arrayBuffer());
    setTimeout(() => controller.abort(), 50);
    try {
      await pending;
      return "resolved";
    } catch (error) {
      return error instanceof DOMException ? error.name : "unknown";
    }
  }, session);
  expect(outcome).toBe("AbortError");

  await expect.poll(async () => (await metrics(page, session)).activeResponses)
    .toBe(0);
  const snapshot = await metrics(page, session);
  expect(snapshot.requests).toHaveLength(1);
  expect(snapshot.cancelledResponses).toBe(1);
});
