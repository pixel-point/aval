import { expect, test, type Page } from "@playwright/test";

interface M2CodecEvidence {
  readonly selectedCodec: "h264-annexb" | "vp8";
  readonly selectedCodecString: string;
  readonly compatibleIndependentUnits: "supported";
  readonly h264AnnexB: "supported" | "unsupported" | "failed";
  readonly encoderOutputCount: number;
  readonly sequentialDecoderOutputCount: number;
  readonly decodedTagCount: number;
  readonly units: readonly {
    readonly unitId: string;
    readonly encoderOutputCount: number;
    readonly independentDecoderOutputCount: number;
    readonly firstAccessUnitType: "key";
    readonly deltaAccessUnitCount: number;
    readonly h264KeyAccessUnit?: {
      readonly hasSps: true;
      readonly hasPps: true;
      readonly hasIdr: true;
      readonly nalUnitTypes: readonly number[];
    };
  }[];
}

interface M2Snapshot {
  readonly sessionGeneration: number;
  readonly state: string;
  readonly requestedState: string;
  readonly visualState: string;
  readonly phase: string;
  readonly direction: "forward" | "reverse" | null;
  readonly clipFrame: number | null;
  readonly underflows: number;
  readonly pathGeneration: number | null;
  readonly lastBodyPathFrame: string | null;
  readonly lastBodyContentFrame: number | null;
  readonly recoveryMisses: number;
  readonly resident: {
    readonly layerCount: number;
    readonly residentBytes: number;
    readonly trackedBytes: number;
    readonly preparationFrames: number;
  };
  readonly recoveryPreflight: readonly {
    readonly endpoint: "resting" | "engaged";
    readonly cachedRunwayFrames: number;
    readonly firstContinuationPathFrame: number;
    readonly elapsedMs: number;
    readonly requiredContentFrames: number;
    readonly ready: boolean;
  }[];
  readonly recovery: {
    readonly endpoint: string;
    readonly firstContinuationPathFrame: string;
    readonly recoveredBeforeRunwayEnd: boolean | null;
  } | null;
  readonly decoder: {
    readonly configureCalls: number;
    readonly resetCalls: number;
    readonly flushCalls: number;
    readonly boundaryFlushCalls: number;
    readonly openFrames: number;
    readonly staleOutputs: number;
    readonly cachedRunwayOutputs: number;
    readonly errors: number;
  };
  readonly renderer: {
    readonly state: string;
    readonly stagingBytes: number;
    readonly allocatedLayers: number;
    readonly uploadedResidentLayers: number;
    readonly closedSourceFrames: number;
    readonly errors: number;
    readonly draws: number;
  };
  readonly error: string | null;
}

interface M2StressResult {
  readonly report: {
    readonly directionChanges: number;
    readonly residentDraws: number;
    readonly validatedDraws: number;
    readonly lowerBounceFrame: number;
    readonly upperBounceFrame: number;
    readonly finalEndpoint: string;
    readonly finalPhase: "stable";
    readonly adjacentFrameFailures: 0;
  };
  readonly validatedTags: number;
  readonly elapsedMs: number;
  readonly renderer: M2Snapshot["renderer"];
}

interface BrowserM2Api {
  readonly ready: Promise<M2CodecEvidence>;
  snapshot(): M2Snapshot | null;
  request(endpoint: "resting" | "engaged"): number;
  readCanvasIdentity(): {
    readonly unitRole: "source-body" | "reversible-clip" | "target-body";
    readonly localFrame: number;
    readonly tagValue: number;
  } | undefined;
  runStress(): Promise<M2StressResult>;
  rebuild(): Promise<M2Snapshot>;
  loseAndRestoreContext(): Promise<M2Snapshot>;
  lastDisposedSession(): {
    readonly sessionGeneration: number;
    readonly playerState: string;
    readonly decoderDisposed: boolean;
    readonly openFrames: number;
    readonly rendererState: string;
    readonly allocatedLayers: number;
  } | null;
  dispose(): void;
}

test("reverses the visible resident clip on the next content tick", async ({
  page
}) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto("/");
  const evidence = await waitForM2Ready(page);
  assertCodecEvidence(evidence);

  await expect
    .poll(async () => (await readM2Snapshot(page))?.state)
    .toBe("running");
  const ready = await readM2Snapshot(page);
  expect(ready).toMatchObject({
    visualState: "resting",
    phase: "stable",
    underflows: 0,
    resident: {
      layerCount: 28,
      preparationFrames: 28
    },
    decoder: {
      configureCalls: 1,
      resetCalls: 0,
      flushCalls: 0,
      boundaryFlushCalls: 0,
      errors: 0
    },
    renderer: {
      state: "active",
      stagingBytes: 256 * 256 * 4,
      allocatedLayers: 28,
      uploadedResidentLayers: 28,
      errors: 0
    },
    error: null
  });
  expect(ready?.resident.residentBytes).toBe(28 * 256 * 256 * 4);
  expect(ready?.resident.trackedBytes).toBe(10_420_224);
  expect(ready?.recoveryPreflight).toHaveLength(2);
  expect(ready?.recoveryPreflight.map(({ endpoint }) => endpoint)).toEqual([
    "resting",
    "engaged"
  ]);
  for (const report of ready?.recoveryPreflight ?? []) {
    expect(report).toMatchObject({
      cachedRunwayFrames: 8,
      firstContinuationPathFrame: 8,
      ready: true
    });
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(report.requiredContentFrames).toBeLessThanOrEqual(8);
  }

  const reversal = await page.evaluate(async () => {
    const api = (window as unknown as { __renderedMotionM2: BrowserM2Api })
      .__renderedMotionM2;
    const wait = async (
      predicate: (snapshot: M2Snapshot) => boolean,
      timeoutMs = 5_000
    ): Promise<M2Snapshot> => {
      const start = performance.now();
      while (performance.now() - start < timeoutMs) {
        const snapshot = api.snapshot();
        if (snapshot !== null && predicate(snapshot)) {
          return snapshot;
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      throw new Error("timed out waiting for M2 trace");
    };

    api.request("engaged");
    const before = await wait(
      (snapshot) =>
        snapshot.phase === "clip" &&
        snapshot.direction === "forward" &&
        snapshot.clipFrame !== null &&
        snapshot.clipFrame >= 3 &&
        snapshot.clipFrame <= 9
    );
    api.request("resting");
    const after = await wait(
      (snapshot) =>
        snapshot.phase === "clip" && snapshot.direction === "reverse"
    );
    const afterIdentity = api.readCanvasIdentity();
    return { before, after, afterIdentity };
  });

  expect(reversal.before.clipFrame).not.toBeNull();
  expect(reversal.after.clipFrame).toBe(
    (reversal.before.clipFrame as number) - 1
  );
  expect(reversal.after.pathGeneration).toBeGreaterThan(
    reversal.before.pathGeneration ?? 0
  );
  expect(reversal.afterIdentity).toMatchObject({
    unitRole: "reversible-clip",
    localFrame: reversal.after.clipFrame
  });
  expect(reversal.after).toMatchObject({
    direction: "reverse",
    visualState: "resting",
    underflows: 0,
    decoder: {
      configureCalls: 1,
      resetCalls: 0,
      boundaryFlushCalls: 0
    }
  });

  await expect
    .poll(async () => {
      const snapshot = await readM2Snapshot(page);
      return `${snapshot?.phase}:${snapshot?.visualState}`;
    })
    .toBe("stable:resting");
  expect((await readM2Snapshot(page))?.recovery).toMatchObject({
    endpoint: "resting",
    firstContinuationPathFrame: "8",
    recoveredBeforeRunwayEnd: true
  });
  const stableCanvas = await page.evaluate(() => {
    const api = (window as unknown as { __renderedMotionM2: BrowserM2Api })
      .__renderedMotionM2;
    return { snapshot: api.snapshot(), identity: api.readCanvasIdentity() };
  });
  expect(stableCanvas.identity).toMatchObject({
    unitRole: "source-body",
    localFrame: stableCanvas.snapshot?.lastBodyContentFrame
  });
  expect(browserErrors).toEqual([]);
});

test("draws and reads back 1,000 exact cached reversal changes", async ({
  page
}) => {
  test.setTimeout(90_000);
  const browserErrors = collectBrowserErrors(page);
  await page.goto("/");
  await waitForM2Ready(page);

  const stress = await page.evaluate(async () => {
    const api = (window as unknown as { __renderedMotionM2: BrowserM2Api })
      .__renderedMotionM2;
    const beforeDraws = api.snapshot()?.renderer.draws ?? 0;
    const first = api.runStress();
    const second = api.runStress();
    const samePromise = first === second;
    const [result, duplicate] = await Promise.all([first, second]);
    const afterDraws = api.snapshot()?.renderer.draws ?? 0;
    return { result, duplicate, samePromise, beforeDraws, afterDraws };
  });
  const { result } = stress;

  expect(stress.samePromise).toBe(true);
  expect(stress.duplicate.report).toEqual(result.report);
  expect(result.report).toMatchObject({
    directionChanges: 1_000,
    lowerBounceFrame: 5,
    upperBounceFrame: 6,
    finalEndpoint: "resting",
    finalPhase: "stable",
    adjacentFrameFailures: 0
  });
  expect(result.report.residentDraws).toBeGreaterThan(1_000);
  expect(result.report.validatedDraws).toBe(result.validatedTags);
  expect(result.validatedTags).toBeGreaterThan(1_000);
  expect(result.elapsedMs).toBeGreaterThan(0);
  expect(result.renderer).toMatchObject({
    state: "active",
    allocatedLayers: 28,
    uploadedResidentLayers: 28,
    errors: 0
  });
  expect(stress.afterDraws - stress.beforeDraws).toBe(
    result.report.residentDraws
  );
  expect((await readM2Snapshot(page))?.underflows).toBe(0);
  await expect(page.locator("#m2-stress-result")).toHaveAttribute(
    "data-state",
    "passed"
  );
  expect(browserErrors).toEqual([]);
});

test("retains latest intent queued immediately before and during context loss", async ({
  page
}) => {
  test.setTimeout(45_000);
  const browserErrors = collectBrowserErrors(page);
  await page.goto("/");
  await waitForM2Ready(page);

  const recovery = await page.evaluate(async () => {
    const api = (window as unknown as { __renderedMotionM2: BrowserM2Api })
      .__renderedMotionM2;
    const beforeGeneration = api.snapshot()?.sessionGeneration ?? 0;
    api.request("engaged");
    const restoring = api.loseAndRestoreContext();
    api.request("resting");
    api.request("engaged");
    const immediate = api.snapshot();
    const restored = await restoring;
    return { beforeGeneration, immediate, restored };
  });

  expect(recovery.immediate?.requestedState).toBe("engaged");
  expect(recovery.restored).toMatchObject({
    requestedState: "engaged",
    underflows: 0,
    recoveryPreflight: [
      { endpoint: "resting", ready: true },
      { endpoint: "engaged", ready: true }
    ]
  });
  expect(recovery.restored.sessionGeneration).toBeGreaterThan(
    recovery.beforeGeneration
  );
  await expect
    .poll(async () => {
      const snapshot = await readM2Snapshot(page);
      return `${snapshot?.phase}:${snapshot?.visualState}:${snapshot?.requestedState}`;
    }, { timeout: 10_000 })
    .toBe("stable:engaged:engaged");
  expect(browserErrors).toEqual([]);
});

test("recovers both bodies and retains intent across mid-clip context loss", async ({
  page
}) => {
  test.setTimeout(45_000);
  const browserErrors = collectBrowserErrors(page);
  await page.goto("/");
  await waitForM2Ready(page);

  await requestAndWaitForStable(page, "engaged");
  const engaged = await readM2Snapshot(page);
  expect(engaged).toMatchObject({
    visualState: "engaged",
    phase: "stable",
    underflows: 0,
    recoveryMisses: 0,
    recovery: {
      endpoint: "engaged",
      firstContinuationPathFrame: "8",
      recoveredBeforeRunwayEnd: true
    }
  });
  expect(Number(engaged?.lastBodyPathFrame)).toBeGreaterThanOrEqual(8);

  await requestAndWaitForStable(page, "resting");
  const resting = await readM2Snapshot(page);
  expect(resting).toMatchObject({
    visualState: "resting",
    phase: "stable",
    underflows: 0,
    recoveryMisses: 0,
    recovery: {
      endpoint: "resting",
      firstContinuationPathFrame: "8",
      recoveredBeforeRunwayEnd: true
    }
  });

  const restored = await page.evaluate(async () => {
    const api = (window as unknown as { __renderedMotionM2: BrowserM2Api })
      .__renderedMotionM2;
    api.request("engaged");
    const startedAt = performance.now();
    let before = api.snapshot();
    while (
      (before?.phase !== "clip" ||
        before.direction !== "forward" ||
        before.clipFrame === null ||
        before.clipFrame < 3) &&
      performance.now() - startedAt < 5_000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      before = api.snapshot();
    }
    if (before?.phase !== "clip") {
      throw new Error("context-loss test never entered the resident clip");
    }
    const after = await api.loseAndRestoreContext();
    return { before, after, disposed: api.lastDisposedSession() };
  });
  expect(restored.before).not.toBeNull();
  expect(restored.after.sessionGeneration).toBeGreaterThan(
    restored.before?.sessionGeneration ?? 0
  );
  expect(restored.after).toMatchObject({
    state: "running",
    visualState: "resting",
    requestedState: "engaged",
    underflows: 0,
    resident: { layerCount: 28, preparationFrames: 28 },
    renderer: {
      state: "active",
      allocatedLayers: 28,
      uploadedResidentLayers: 28,
      errors: 0
    },
    decoder: {
      configureCalls: 1,
      resetCalls: 0,
      boundaryFlushCalls: 0,
      errors: 0
    }
  });
  expect(restored.disposed).toMatchObject({
    sessionGeneration: restored.before?.sessionGeneration,
    playerState: "disposed",
    decoderDisposed: true,
    openFrames: 0,
    rendererState: "disposed",
    allocatedLayers: 0
  });

  await expect
    .poll(async () => {
      const snapshot = await readM2Snapshot(page);
      return `${snapshot?.phase}:${snapshot?.visualState}:${snapshot?.requestedState}`;
    }, { timeout: 10_000 })
    .toBe("stable:engaged:engaged");

  const rebuilt = await page.evaluate(async () => {
    const api = (window as unknown as { __renderedMotionM2: BrowserM2Api })
      .__renderedMotionM2;
    return api.rebuild();
  });
  expect(rebuilt.sessionGeneration).toBeGreaterThan(
    restored.after.sessionGeneration
  );
  expect(rebuilt).toMatchObject({
    state: "running",
    visualState: "engaged",
    requestedState: "engaged",
    underflows: 0,
    resident: { layerCount: 28, preparationFrames: 28 },
    renderer: { uploadedResidentLayers: 28, errors: 0 }
  });
  const finalDisposal = await page.evaluate(() => {
    const api = (window as unknown as { __renderedMotionM2: BrowserM2Api })
      .__renderedMotionM2;
    api.dispose();
    return api.lastDisposedSession();
  });
  expect(finalDisposal).toMatchObject({
    sessionGeneration: rebuilt.sessionGeneration,
    playerState: "disposed",
    decoderDisposed: true,
    openFrames: 0,
    rendererState: "disposed",
    allocatedLayers: 0
  });
  expect(browserErrors).toEqual([]);
});

function assertCodecEvidence(evidence: M2CodecEvidence): void {
  expect(evidence.compatibleIndependentUnits).toBe("supported");
  expect(evidence.encoderOutputCount).toBe(44);
  expect(evidence.sequentialDecoderOutputCount).toBe(44);
  expect(evidence.decodedTagCount).toBe(44);
  expect(evidence.units.map(({ encoderOutputCount }) => encoderOutputCount)).toEqual([
    16, 12, 16
  ]);
  expect(
    evidence.units.map(({ independentDecoderOutputCount }) =>
      independentDecoderOutputCount
    )
  ).toEqual([16, 12, 16]);
  expect(evidence.units.every(({ firstAccessUnitType }) => firstAccessUnitType === "key")).toBe(
    true
  );

  if (evidence.h264AnnexB === "supported") {
    expect(evidence.selectedCodec).toBe("h264-annexb");
    for (const unit of evidence.units) {
      expect(unit.h264KeyAccessUnit).toMatchObject({
        hasSps: true,
        hasPps: true,
        hasIdr: true
      });
      expect(unit.h264KeyAccessUnit?.nalUnitTypes).toEqual(
        expect.arrayContaining([7, 8, 5])
      );
    }
  } else {
    expect(evidence.selectedCodec).toBe("vp8");
  }
}

async function requestAndWaitForStable(
  page: Page,
  endpoint: "resting" | "engaged"
): Promise<void> {
  await page.evaluate((destination) => {
    const api = (window as unknown as { __renderedMotionM2: BrowserM2Api })
      .__renderedMotionM2;
    api.request(destination);
  }, endpoint);
  await expect
    .poll(async () => {
      const snapshot = await readM2Snapshot(page);
      return `${snapshot?.phase}:${snapshot?.visualState}`;
    }, { timeout: 10_000 })
    .toBe(`stable:${endpoint}`);
}

async function waitForM2Ready(page: Page): Promise<M2CodecEvidence> {
  return page.evaluate(() => {
    const api = (window as unknown as { __renderedMotionM2: BrowserM2Api })
      .__renderedMotionM2;
    return api.ready;
  });
}

async function readM2Snapshot(page: Page): Promise<M2Snapshot | null> {
  return page.evaluate(() => {
    const api = (window as unknown as { __renderedMotionM2: BrowserM2Api })
      .__renderedMotionM2;
    return api.snapshot();
  });
}

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  return errors;
}
