import { expect, test, type Page } from "@playwright/test";

interface BrowserSnapshot {
  readonly state: string;
  readonly virtualFrame: string | null;
  readonly contentFrame: number | null;
  readonly canvasSeams: number;
  readonly underflows: number;
  readonly lateContentFrames: number;
  readonly canvasDrawnFrames: number;
  readonly queuedFrames: number;
  readonly configureCalls: number;
  readonly boundaryFlushCalls: number;
  readonly openFrames: number;
  readonly error: string | null;
}

interface BrowserEvidence {
  readonly selectedCodec: "h264-annexb" | "vp8";
  readonly h264AnnexB: "supported" | "unsupported" | "failed";
  readonly genericLoopReplay: "supported";
  readonly h264KeyAccessUnit?: {
    readonly hasSps: true;
    readonly hasPps: true;
    readonly hasIdr: true;
    readonly nalUnitTypes: readonly number[];
  };
}

interface BrowserStressResult {
  readonly fixture: BrowserEvidence;
  readonly report: {
    readonly passed: true;
    readonly iterations: number;
    readonly outputFrames: number;
    readonly seams: number;
    readonly validatedTags: number;
    readonly throughputMultiple: number;
    readonly minimumThroughput: number;
    readonly metrics: {
      readonly configureCalls: number;
      readonly resetCalls: number;
      readonly boundaryFlushCalls: number;
      readonly terminalFlushCalls: number;
      readonly submittedChunks: number;
      readonly outputFrames: number;
      readonly closedFrames: number;
      readonly openFrames: number;
      readonly maxQueueDepth: number;
      readonly errors: number;
      readonly terminalFlushCompleted: boolean;
      readonly disposed: boolean;
    };
  };
}

interface BrowserApi {
  readonly ready: Promise<BrowserEvidence>;
  runStress(): Promise<BrowserStressResult>;
  snapshot(): BrowserSnapshot | null;
  dispose(): void;
}

test("draws realtime canvas seams without a boundary operation", async ({
  page
}) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto("/");

  const evidence = await waitForReady(page);
  expect(["h264-annexb", "vp8"]).toContain(evidence.selectedCodec);
  expect(["supported", "unsupported", "failed"]).toContain(
    evidence.h264AnnexB
  );
  assertCodecEvidence(evidence);

  await expect
    .poll(async () => (await readSnapshot(page))?.canvasSeams ?? 0, {
      timeout: 10_000
    })
    .toBeGreaterThanOrEqual(2);

  const running = await readSnapshot(page);
  expect(running).toMatchObject({
    state: "running",
    configureCalls: 1,
    boundaryFlushCalls: 0,
    underflows: 0,
    error: null
  });
  expect(running?.canvasDrawnFrames).toBeGreaterThanOrEqual(49);
  expect(running?.queuedFrames).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Pause" }).click();
  await expect.poll(async () => (await readSnapshot(page))?.state).toBe("paused");
  await page.getByRole("button", { name: "Resume" }).click();
  await expect.poll(async () => (await readSnapshot(page))?.state).toBe("running");

  const disposed = await page.evaluate(() => {
    const api = (window as unknown as { __renderedMotionSpike: BrowserApi })
      .__renderedMotionSpike;
    api.dispose();
    return api.snapshot();
  });
  expect(disposed).toMatchObject({ state: "disposed", openFrames: 0 });
  expect(browserErrors).toEqual([]);
});

test("decodes 2,002 tagged frames across exactly 1,000 seams", async ({
  page
}) => {
  test.setTimeout(90_000);
  const browserErrors = collectBrowserErrors(page);
  await page.goto("/");
  await waitForReady(page);

  const result = await page.evaluate(() => {
    const api = (window as unknown as { __renderedMotionSpike: BrowserApi })
      .__renderedMotionSpike;
    return api.runStress();
  });

  assertStressReport(result);
  await expect(page.locator("#stress-result")).toHaveAttribute(
    "data-state",
    "passed"
  );
  expect(browserErrors).toEqual([]);
});

function assertStressReport(result: BrowserStressResult): void {
  expect(result.fixture.genericLoopReplay).toBe("supported");
  expect(["h264-annexb", "vp8"]).toContain(result.fixture.selectedCodec);
  assertCodecEvidence(result.fixture);
  expect(result.report).toMatchObject({
    passed: true,
    iterations: 1_001,
    outputFrames: 2_002,
    seams: 1_000,
    validatedTags: 2_002
  });
  expect(result.report.throughputMultiple).toBeGreaterThanOrEqual(
    result.report.minimumThroughput
  );
  expect(result.report.metrics).toMatchObject({
    configureCalls: 1,
    resetCalls: 0,
    boundaryFlushCalls: 0,
    terminalFlushCalls: 1,
    submittedChunks: 2_002,
    outputFrames: 2_002,
    closedFrames: 2_002,
    openFrames: 0,
    errors: 0,
    terminalFlushCompleted: true,
    disposed: true
  });
  expect(result.report.metrics.maxQueueDepth).toBeLessThanOrEqual(16);
}

function assertCodecEvidence(evidence: BrowserEvidence): void {
  if (evidence.h264AnnexB === "supported") {
    expect(evidence.selectedCodec).toBe("h264-annexb");
    expect(evidence.h264KeyAccessUnit).toMatchObject({
      hasSps: true,
      hasPps: true,
      hasIdr: true
    });
    expect(evidence.h264KeyAccessUnit?.nalUnitTypes).toEqual(
      expect.arrayContaining([7, 8, 5])
    );
    return;
  }

  expect(evidence.selectedCodec).toBe("vp8");
  expect(evidence.h264KeyAccessUnit).toBeUndefined();
}

async function waitForReady(page: Page): Promise<BrowserEvidence> {
  return page.evaluate(() => {
    const api = (window as unknown as { __renderedMotionSpike: BrowserApi })
      .__renderedMotionSpike;
    return api.ready;
  });
}

async function readSnapshot(page: Page): Promise<BrowserSnapshot | null> {
  return page.evaluate(() => {
    const api = (window as unknown as { __renderedMotionSpike: BrowserApi })
      .__renderedMotionSpike;
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
