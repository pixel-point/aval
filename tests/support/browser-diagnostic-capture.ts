import { writeFile } from "node:fs/promises";

import {
  expect,
  type Page,
  type TestInfo
} from "@playwright/test";

export const BROWSER_DIAGNOSTIC_PRODUCER_LIMITS = Object.freeze({
  authoredSources: 128,
  checkpoints: 32,
  elementTrace: 32,
  generalArray: 128,
  generalObjectKeys: 128,
  maxDepth: 16,
  players: 32,
  reportBytes: 2_097_152,
  reportNodes: 16_384,
  runtimeTrace: 64,
  stringLength: 4_096,
  valueBytes: 524_288,
  valueNodes: 4_096
});

export const BROWSER_DIAGNOSTIC_LIMITS = Object.freeze({
  ...BROWSER_DIAGNOSTIC_PRODUCER_LIMITS,
  timeoutMilliseconds: 10_000
});

export interface BrowserDiagnosticEnvironment {
  readonly userAgent: string;
  readonly userAgentData: Readonly<{
    readonly brands: readonly unknown[];
    readonly mobile: boolean;
    readonly platform: string;
  }> | null;
  readonly secureContext: boolean;
  readonly crossOriginIsolated: boolean;
  readonly viewport: Readonly<{
    readonly width: number;
    readonly height: number;
  }>;
  readonly devicePixelRatio: number;
  readonly reducedMotion: boolean;
  readonly visibilityState: string;
  readonly capabilities: Readonly<{
    readonly videoDecoder: boolean;
    readonly videoDecoderIsConfigSupported: boolean;
    readonly videoFrame: boolean;
    readonly offscreenCanvas: boolean;
    readonly webgl2: boolean;
    readonly webgpu: boolean;
  }>;
}

export interface BrowserDiagnosticCheckpoint {
  readonly sequence: number;
  readonly label: string;
  readonly capturedAt: string;
  readonly elapsedMilliseconds: number;
  readonly playerId: string | null;
  readonly context: unknown;
  readonly event: Readonly<{
    readonly type: string;
    readonly detail: unknown;
  }> | null;
  readonly element: Readonly<Record<string, unknown>> | null;
}

export interface BrowserDiagnosticReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly serializationBudgetExhausted: boolean;
  readonly session: Readonly<{
    readonly startedAt: string;
    readonly startedAtMilliseconds: number;
    readonly url: string;
  }>;
  readonly environment: Readonly<BrowserDiagnosticEnvironment>;
  readonly players: readonly Readonly<Record<string, unknown>>[];
  readonly authoredSources: readonly Readonly<{
    readonly playerId: string;
    readonly context: unknown;
    readonly index: number;
    readonly mimeType: string;
    readonly codec: string | null;
  }>[];
  readonly checkpoints: readonly Readonly<BrowserDiagnosticCheckpoint>[];
  readonly latest: Readonly<{
    readonly checkpointSequence: number;
    readonly playerId: string | null;
    readonly context: unknown;
    readonly element: Readonly<{
      readonly diagnostics?: Readonly<{
        readonly elementTrace?: readonly unknown[];
        readonly runtimeTrace?: readonly unknown[];
        readonly [key: string]: unknown;
      }> | null;
      readonly [key: string]: unknown;
    }>;
  }> | null;
}

interface BrowserDiagnosticsApi {
  readonly limits: unknown;
  checkpoint(label: string, player?: HTMLElement): unknown;
  report(): unknown;
  clear(): void;
}

type DiagnosticWindow = Window & {
  readonly avalBrowserDiagnostics?: BrowserDiagnosticsApi;
};

export type DiagnosticOperationResult<T> =
  | Readonly<{
      readonly outcome: "completed";
      readonly value: T;
      readonly report: BrowserDiagnosticReport;
    }>
  | Readonly<{
      readonly outcome: "error";
      readonly error: string;
      readonly report: BrowserDiagnosticReport;
    }>
  | Readonly<{
      readonly outcome: "timeout";
      readonly report: BrowserDiagnosticReport;
    }>;

export async function openWithDiagnostics(
  page: Page,
  path = "/"
): Promise<void> {
  const url = new URL(path, "http://aval-diagnostics.invalid");
  await page.goto(`${url.pathname}?avalDiagnostics=1`, {
    waitUntil: "domcontentloaded"
  });
  await page.waitForFunction(() =>
    (window as DiagnosticWindow).avalBrowserDiagnostics !== undefined,
  undefined, {
    timeout: BROWSER_DIAGNOSTIC_LIMITS.timeoutMilliseconds
  });
  await expect(page.locator("[data-aval-browser-diagnostics]"))
    .toHaveCount(1);
}

export async function checkpoint(
  page: Page,
  label: string,
  playerSelector?: string
): Promise<void> {
  await page.evaluate(({ checkpointLabel, selector }) => {
    const api = (window as DiagnosticWindow).avalBrowserDiagnostics;
    if (api === undefined) throw new Error("Browser diagnostics are unavailable");
    const player = selector === undefined
      ? undefined
      : document.querySelector<HTMLElement>(selector) ?? undefined;
    api.checkpoint(checkpointLabel, player);
  }, { checkpointLabel: label, selector: playerSelector });
}

export async function readReport(page: Page): Promise<BrowserDiagnosticReport> {
  const serializedCapture = await page.evaluate(() => {
    const api = (window as DiagnosticWindow).avalBrowserDiagnostics;
    if (api === undefined) throw new Error("Browser diagnostics are unavailable");
    return JSON.stringify({ limits: api.limits, report: api.report() });
  });
  if (serializedCapture === undefined) {
    throw new Error("Browser diagnostics could not be serialized");
  }
  const capture = JSON.parse(serializedCapture) as Readonly<{
    readonly limits: unknown;
    readonly report: unknown;
  }>;
  expect(capture.limits).toEqual(BROWSER_DIAGNOSTIC_PRODUCER_LIMITS);
  assertBrowserDiagnosticReport(capture.report);
  return capture.report;
}

export function assertBrowserDiagnosticReport(
  value: unknown
): asserts value is BrowserDiagnosticReport {
  if (!isRecord(value)) throw new Error("Diagnostic report must be an object");
  expect(value.schemaVersion).toBe(1);
  expect(value.generatedAt).toEqual(expect.any(String));
  expect(value.serializationBudgetExhausted).toEqual(expect.any(Boolean));
  expect(value.session).toEqual(expect.objectContaining({
    startedAt: expect.any(String),
    startedAtMilliseconds: expect.any(Number),
    url: expect.any(String)
  }));
  const session = value.session as Readonly<Record<string, unknown>>;
  expect(session.url).toEqual(
    expect.stringMatching(/^\/[^?#]*\?avalDiagnostics=1$/u)
  );
  const sessionUrl = new URL(
    String(session.url),
    "http://aval-diagnostics.invalid"
  );
  expect(sessionUrl.origin).toBe("http://aval-diagnostics.invalid");
  expect(sessionUrl.hash).toBe("");
  expect(Array.from(sessionUrl.searchParams.entries())).toEqual([
    ["avalDiagnostics", "1"]
  ]);
  expect(session.url).toBe(`${sessionUrl.pathname}?avalDiagnostics=1`);
  expect(value.environment).toEqual(expect.objectContaining({
    userAgent: expect.any(String),
    secureContext: expect.any(Boolean),
    crossOriginIsolated: expect.any(Boolean),
    viewport: expect.objectContaining({
      width: expect.any(Number),
      height: expect.any(Number)
    }),
    devicePixelRatio: expect.any(Number),
    reducedMotion: expect.any(Boolean),
    visibilityState: expect.any(String),
    capabilities: expect.objectContaining({
      videoDecoder: expect.any(Boolean),
      videoDecoderIsConfigSupported: expect.any(Boolean),
      videoFrame: expect.any(Boolean),
      offscreenCanvas: expect.any(Boolean),
      webgl2: expect.any(Boolean),
      webgpu: expect.any(Boolean)
    })
  }));
  expect(Array.isArray(value.players)).toBe(true);
  expect(Array.isArray(value.authoredSources)).toBe(true);
  expect(Array.isArray(value.checkpoints)).toBe(true);

  const players = value.players as unknown[];
  expect(players.length).toBeLessThanOrEqual(
    BROWSER_DIAGNOSTIC_LIMITS.players
  );
  const authoredSources = value.authoredSources as unknown[];
  expect(authoredSources.length).toBeLessThanOrEqual(
    BROWSER_DIAGNOSTIC_LIMITS.authoredSources
  );

  const checkpoints = value.checkpoints as unknown[];
  expect(checkpoints.length).toBeLessThanOrEqual(
    BROWSER_DIAGNOSTIC_LIMITS.checkpoints
  );
  for (const entry of checkpoints) {
    expect(entry).toEqual(expect.objectContaining({
      sequence: expect.any(Number),
      label: expect.any(String),
      capturedAt: expect.any(String),
      elapsedMilliseconds: expect.any(Number)
    }));
  }

  const aggregate = { nodes: 0 };
  assertBoundedSerializableValue(value, 0, aggregate);
  expect(aggregate.nodes).toBeLessThanOrEqual(
    BROWSER_DIAGNOSTIC_LIMITS.reportNodes
  );
  expect(new TextEncoder().encode(JSON.stringify(value)).byteLength)
    .toBeLessThanOrEqual(BROWSER_DIAGNOSTIC_LIMITS.reportBytes);
  if (value.latest === null) return;
  expect(value.latest).toEqual(expect.objectContaining({
    checkpointSequence: expect.any(Number),
    element: expect.any(Object)
  }));
  const latest = value.latest as Record<string, unknown>;
  const element = isRecord(latest.element) ? latest.element : null;
  const diagnostics = element !== null && isRecord(element.diagnostics)
    ? element.diagnostics
    : null;
  const elementTrace = diagnostics?.elementTrace;
  const runtimeTrace = diagnostics?.runtimeTrace;
  if (Array.isArray(elementTrace)) {
    expect(elementTrace.length).toBeLessThanOrEqual(
      BROWSER_DIAGNOSTIC_LIMITS.elementTrace
    );
  }
  if (Array.isArray(runtimeTrace)) {
    expect(runtimeTrace.length).toBeLessThanOrEqual(
      BROWSER_DIAGNOSTIC_LIMITS.runtimeTrace
    );
  }
}

export async function captureOperation<T>(
  page: Page,
  label: string,
  operation: () => Promise<T>,
  options: Readonly<{
    readonly playerSelector?: string;
    readonly timeoutMilliseconds?: number;
  }> = {}
): Promise<DiagnosticOperationResult<T>> {
  const timeoutMilliseconds = options.timeoutMilliseconds ??
    BROWSER_DIAGNOSTIC_LIMITS.timeoutMilliseconds;
  await checkpoint(page, `before:${label}`, options.playerSelector);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Readonly<{ readonly outcome: "timeout" }>>(
    (resolve) => {
      timer = setTimeout(
        () => resolve({ outcome: "timeout" }),
        timeoutMilliseconds
      );
    }
  );
  const attempted = Promise.resolve()
    .then(operation)
    .then(
      (value) => Object.freeze({ outcome: "completed" as const, value }),
      (error) => Object.freeze({
        outcome: "error" as const,
        error: error instanceof Error ? error.message : String(error)
      })
    );
  const outcome = await Promise.race([attempted, timeout]);
  if (timer !== undefined) clearTimeout(timer);

  if (outcome.outcome === "completed") {
    await checkpoint(page, `after:${label}`, options.playerSelector);
    return Object.freeze({
      ...outcome,
      report: await readReport(page)
    });
  }
  if (outcome.outcome === "error") {
    await checkpoint(page, `error:${label}`, options.playerSelector);
    return Object.freeze({
      ...outcome,
      report: await readReport(page)
    });
  }
  await checkpoint(page, `timeout:${label}`, options.playerSelector);
  return Object.freeze({
    outcome: "timeout",
    report: await readReport(page)
  });
}

export async function captureBrowserDiagnosticArtifacts(
  page: Page,
  testInfo: TestInfo,
  name: string
): Promise<BrowserDiagnosticReport> {
  const safeName = name.replace(/[^a-z0-9_-]+/giu, "-").replace(/^-|-$/gu, "") ||
    "browser-diagnostics";
  const report = await readReport(page);
  const jsonPath = testInfo.outputPath(`${safeName}.json`);
  const screenshotPath = testInfo.outputPath(`${safeName}.png`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(`${safeName}-json`, {
    path: jsonPath,
    contentType: "application/json"
  });
  await testInfo.attach(`${safeName}-screenshot`, {
    path: screenshotPath,
    contentType: "image/png"
  });
  return report;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertBoundedSerializableValue(
  value: unknown,
  depth = 0,
  aggregate: { nodes: number }
): void {
  aggregate.nodes += 1;
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) return;
  if (typeof value === "string") {
    if (value.length > BROWSER_DIAGNOSTIC_LIMITS.stringLength) {
      throw new Error("Diagnostic report contains an over-limit string");
    }
    return;
  }

  if (depth >= BROWSER_DIAGNOSTIC_LIMITS.maxDepth) {
    throw new Error("Diagnostic report exceeds the producer depth limit");
  }
  if (Array.isArray(value)) {
    if (value.length > BROWSER_DIAGNOSTIC_LIMITS.generalArray) {
      throw new Error("Diagnostic report contains an over-limit array");
    }
    for (const entry of value) {
      assertBoundedSerializableValue(entry, depth + 1, aggregate);
    }
    return;
  }
  if (!isRecord(value)) {
    throw new Error(
      `Diagnostic report contains a non-serializable ${typeof value} value`
    );
  }
  const entries = Object.entries(value);
  if (entries.length > BROWSER_DIAGNOSTIC_LIMITS.generalObjectKeys) {
    throw new Error("Diagnostic report contains an over-limit object");
  }
  for (const [key, entry] of entries) {
    if (key.length > BROWSER_DIAGNOSTIC_LIMITS.stringLength) {
      throw new Error("Diagnostic report contains an over-limit object key");
    }
    assertBoundedSerializableValue(entry, depth + 1, aggregate);
  }
}
