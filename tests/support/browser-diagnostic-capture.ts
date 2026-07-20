import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
  writeFile,
  type FileHandle
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  parse,
  resolve
} from "node:path";
import { performance as monotonicPerformance } from "node:perf_hooks";

import {
  expect,
  type Locator,
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
  valueNodes: 8_192
});

export const BROWSER_DIAGNOSTIC_LIMITS = Object.freeze({
  ...BROWSER_DIAGNOSTIC_PRODUCER_LIMITS,
  timeoutMilliseconds: 10_000
});

const EVIDENCE_IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const EVIDENCE_IDENTIFIER_MAX_LENGTH = 128;
const EVIDENCE_SESSION_ID_PATTERN =
  /^[0-9]{8}T[0-9]{6}Z(?:-[a-z0-9][a-z0-9-]{0,47})?$/u;
const EVIDENCE_COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const EVIDENCE_SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const EVIDENCE_RUN_IDENTITY_FILENAME = "run-identity.json";
const EVIDENCE_DEMO_IDS = Object.freeze([
  "end-user-playground",
  "grass-rabbit",
  "grass-rabbit-codecs",
  "kinetic-orb"
] as const);
const EVIDENCE_MODES = Object.freeze([
  "forced-h264",
  "full-ladder"
] as const);
const EVIDENCE_EXPECTED_OUTCOMES = Object.freeze([
  "playback",
  "deterministic-error"
] as const);
const EVIDENCE_INTERACTION_PROFILES = Object.freeze([
  "desktop",
  "touch",
  "unsupported"
] as const);
const PLAYBACK_COUNTER_KEYS = Object.freeze([
  "outputsAccepted",
  "drawsCompleted",
  "logicalRunsCreated",
  "candidateCommits",
  "runsClosed",
  "transitionStarts",
  "transitionEnds",
  "loopCrossings"
] as const);
const PLAYBACK_LANE_COUNTER_KEYS = Object.freeze([
  "nativeDecoderCreatesByLane",
  "nativeDecoderClosesByLane"
] as const);
const EVIDENCE_SOAK_MILLISECONDS = 60_000;
const EVIDENCE_EVENT_LIMIT = 4_096;

export type BrowserDiagnosticEvidenceDemoId =
  typeof EVIDENCE_DEMO_IDS[number];
export type BrowserDiagnosticEvidenceMode = typeof EVIDENCE_MODES[number];
export type BrowserDiagnosticExpectedOutcome =
  typeof EVIDENCE_EXPECTED_OUTCOMES[number];
export type BrowserDiagnosticInteractionProfile =
  typeof EVIDENCE_INTERACTION_PROFILES[number];

export interface BrowserDiagnosticPlaybackCounters {
  readonly outputsAccepted: number;
  readonly drawsCompleted: number;
  readonly logicalRunsCreated: number;
  readonly candidateCommits: number;
  readonly runsClosed: number;
  readonly transitionStarts: number;
  readonly transitionEnds: number;
  readonly loopCrossings: number;
  readonly nativeDecoderCreatesByLane: readonly [number, number];
  readonly nativeDecoderClosesByLane: readonly [number, number];
}

export interface BrowserDiagnosticMeasuredRunEvidence {
  readonly interactionProfile: BrowserDiagnosticInteractionProfile;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly terminalFailures: number;
  readonly events: readonly Readonly<{
    readonly type: "transitionstart" | "visualstatechange" | "transitionend";
    readonly atMilliseconds: number;
    readonly from: string | null;
    readonly to: string | null;
    readonly edge: string | null;
  }>[];
  readonly soak: Readonly<{
    readonly requiredMilliseconds: number;
    readonly elapsedMilliseconds: number;
    readonly samples: readonly Readonly<{
      readonly elapsedMilliseconds: number;
      readonly terminalFailures: number;
      readonly counters: Readonly<BrowserDiagnosticPlaybackCounters>;
    }>[];
  }>;
}

export interface BrowserDiagnosticEvidenceTarget {
  readonly runRoot: string;
  readonly slotId: string;
  readonly demoId: BrowserDiagnosticEvidenceDemoId;
  readonly mode: BrowserDiagnosticEvidenceMode;
  readonly checkpoint: string;
}

export interface BrowserDiagnosticEvidenceRunIdentity {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly sourceAttestation: Readonly<{
    readonly headCommit: string;
    readonly trackedDiffSha256: string;
    readonly untrackedSourceTreeSha256: string;
    readonly policySha256: string;
    readonly servedTreeSha256: string;
  }>;
}

export interface BrowserDiagnosticEvidenceArtifacts {
  readonly reportPath: string;
  readonly pngPath: string;
  readonly contextPngPath: string;
  readonly beforePngPath?: string | null;
  readonly pngSha256: string;
  readonly contextPngSha256: string;
  readonly visualState: string | null;
}

export interface BrowserDiagnosticFrameProof {
  readonly beforeCanvasSha256: string;
  readonly afterCanvasSha256: string;
  readonly sampleIntervalMilliseconds: number;
  readonly beforeDrawsCompleted: number | null;
  readonly afterDrawsCompleted: number | null;
}

export interface BrowserDiagnosticEvidenceCheckpointArtifacts
  extends BrowserDiagnosticEvidenceArtifacts {
  readonly id: string;
  readonly advancingFrame: boolean;
  readonly beforePngPath: string | null;
  readonly frameProof: Readonly<BrowserDiagnosticFrameProof> | null;
}

export interface BrowserDiagnosticEvidenceSessionTarget {
  readonly runRoot: string;
  readonly slotId: string;
}

export interface BrowserDiagnosticEvidenceLedgerTarget
  extends BrowserDiagnosticEvidenceSessionTarget {
  readonly demoId: BrowserDiagnosticEvidenceDemoId;
  readonly mode: BrowserDiagnosticEvidenceMode;
}

export interface BrowserDiagnosticEvidenceFinalization {
  readonly demoId: BrowserDiagnosticEvidenceDemoId;
  readonly checkpoints: readonly Readonly<
    BrowserDiagnosticEvidenceCheckpointArtifacts
  >[];
  readonly measuredRun?: Readonly<BrowserDiagnosticMeasuredRunEvidence> | undefined;
}

export interface BrowserDiagnosticArtifactOptions {
  readonly evidence?: Readonly<BrowserDiagnosticEvidenceTarget> | undefined;
  /**
   * Legacy caller hint retained for source compatibility. Evidence capture
   * never trusts this value; expected outcome selects temporal measurement.
   */
  readonly advancingFrame?: boolean | undefined;
  readonly onEvidenceWritten?: (
    artifacts: Readonly<BrowserDiagnosticEvidenceCheckpointArtifacts>
  ) => void;
}

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
    readonly webCryptoSubtleDigest: boolean;
    readonly videoDecoder: boolean;
    readonly videoDecoderIsConfigSupported: boolean;
    readonly videoFrame: boolean;
    readonly offscreenCanvas: boolean;
    readonly webgl2: boolean;
    readonly webgpu: boolean;
    readonly braveBrandApi: boolean;
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

export interface ActiveAvalPlayerEvidence {
  readonly report: Readonly<BrowserDiagnosticReport>;
  readonly screenshot: Uint8Array;
  readonly beforeScreenshot: Uint8Array | null;
  readonly advancingFrame: boolean;
  readonly frameProof: Readonly<BrowserDiagnosticFrameProof> | null;
}

interface BrowserDiagnosticsApi {
  readonly limits: unknown;
  attach(player: HTMLElement, context?: unknown): unknown;
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

export async function initializeBrowserDiagnosticEvidenceRunRoot(
  runRootValue: string,
  identityValue: Readonly<BrowserDiagnosticEvidenceRunIdentity>
): Promise<Readonly<{ readonly identityPath: string }>> {
  const runRoot = normalizeEvidenceRunRoot(runRootValue);
  const identity = normalizeEvidenceRunIdentity(identityValue);
  assertEvidenceRunRootSuffix(runRoot, identity);
  await mkdir(runRoot, { recursive: true });
  const stat = await lstat(runRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Browser evidence run root must be a real directory");
  }
  const canonical = resolve(await realpath(runRoot));
  if (!sameFilesystemPath(canonical, runRoot)) {
    throw new Error("Browser evidence run root cannot contain symlinks");
  }
  const manifestPath = join(runRoot, "manifest.json");
  if (await pathExists(manifestPath)) {
    throw new Error("Browser evidence run root is already assembled");
  }
  const identityPath = join(runRoot, EVIDENCE_RUN_IDENTITY_FILENAME);
  await writeExclusiveJsonArtifact(identityPath, identity);
  return Object.freeze({ identityPath });
}

export function createBrowserDiagnosticEvidenceTarget(
  value: Readonly<BrowserDiagnosticEvidenceTarget>
): Readonly<BrowserDiagnosticEvidenceTarget> {
  const runRoot = normalizeEvidenceRunRoot(value.runRoot);
  assertEvidenceIdentifier("slot id", value.slotId);
  assertEvidenceIdentifier("checkpoint", value.checkpoint);
  if (!EVIDENCE_DEMO_IDS.includes(value.demoId)) {
    throw new Error(`Unsupported browser evidence demo: ${String(value.demoId)}`);
  }
  if (!EVIDENCE_MODES.includes(value.mode)) {
    throw new Error(`Unsupported browser evidence mode: ${String(value.mode)}`);
  }
  return Object.freeze({ ...value, runRoot });
}

export function browserDiagnosticEvidenceTargetFromEnvironment(
  metadata: Readonly<{
    readonly demoId: BrowserDiagnosticEvidenceDemoId;
    readonly checkpoint: string;
  }>
): Readonly<BrowserDiagnosticEvidenceTarget> | undefined {
  const runRoot = process.env.AVAL_BROWSER_EVIDENCE_RUN_ROOT;
  const slotId = process.env.AVAL_BROWSER_EVIDENCE_SLOT_ID;
  const mode = process.env.AVAL_BROWSER_EVIDENCE_MODE;
  if (runRoot === undefined && slotId === undefined && mode === undefined) {
    return undefined;
  }
  if (runRoot === undefined || slotId === undefined || mode === undefined) {
    throw new Error(
      "Browser evidence capture requires AVAL_BROWSER_EVIDENCE_RUN_ROOT, " +
      "AVAL_BROWSER_EVIDENCE_SLOT_ID, and AVAL_BROWSER_EVIDENCE_MODE together"
    );
  }
  return createBrowserDiagnosticEvidenceTarget({
    runRoot,
    slotId,
    demoId: metadata.demoId,
    mode: mode as BrowserDiagnosticEvidenceMode,
    checkpoint: metadata.checkpoint
  });
}

export function browserDiagnosticCertificationModeFromEnvironment():
  BrowserDiagnosticEvidenceMode | undefined {
  const mode = process.env.AVAL_BROWSER_EVIDENCE_MODE;
  if (mode === undefined) return undefined;
  if (!EVIDENCE_MODES.includes(mode as BrowserDiagnosticEvidenceMode)) {
    throw new Error(`Unsupported browser evidence mode: ${mode}`);
  }
  return mode as BrowserDiagnosticEvidenceMode;
}

export function browserDiagnosticExpectedOutcomeFromEnvironment():
  BrowserDiagnosticExpectedOutcome {
  const outcome = process.env.AVAL_BROWSER_EVIDENCE_EXPECTED_OUTCOME ??
    "playback";
  if (!EVIDENCE_EXPECTED_OUTCOMES.includes(
    outcome as BrowserDiagnosticExpectedOutcome
  )) {
    throw new Error(`Unsupported browser evidence outcome: ${outcome}`);
  }
  return outcome as BrowserDiagnosticExpectedOutcome;
}

export function browserDiagnosticInteractionProfileFromEnvironment():
  BrowserDiagnosticInteractionProfile {
  const profile = process.env.AVAL_BROWSER_EVIDENCE_INTERACTION_PROFILE;
  if (profile === undefined) {
    if (browserDiagnosticEvidenceEnvironmentConfigured()) {
      throw new Error(
        "Browser evidence capture requires " +
        "AVAL_BROWSER_EVIDENCE_INTERACTION_PROFILE"
      );
    }
    return "desktop";
  }
  if (!EVIDENCE_INTERACTION_PROFILES.includes(
    profile as BrowserDiagnosticInteractionProfile
  )) {
    throw new Error(`Unsupported browser evidence interaction profile: ${profile}`);
  }
  return profile as BrowserDiagnosticInteractionProfile;
}

function browserDiagnosticEvidenceEnvironmentConfigured(): boolean {
  return [
    process.env.AVAL_BROWSER_EVIDENCE_RUN_ROOT,
    process.env.AVAL_BROWSER_EVIDENCE_SLOT_ID,
    process.env.AVAL_BROWSER_EVIDENCE_MODE
  ].some((value) => value !== undefined);
}

export async function activateBrowserDiagnosticTarget(
  page: Page,
  target: Locator
): Promise<void> {
  const profile = browserDiagnosticInteractionProfileFromEnvironment();
  if (profile === "unsupported") {
    throw new Error("Unsupported evidence cannot activate an interaction target");
  }
  if (profile === "touch") {
    await target.tap();
    return;
  }
  await target.hover();
}

export async function deactivateBrowserDiagnosticTarget(
  page: Page,
  target: Locator
): Promise<void> {
  const profile = browserDiagnosticInteractionProfileFromEnvironment();
  if (profile === "unsupported") {
    throw new Error("Unsupported evidence cannot deactivate an interaction target");
  }
  if (profile === "touch") {
    const outside = page.locator("[data-aval-browser-diagnostics] summary");
    await expect(outside).toBeVisible();
    await outside.tap();
    return;
  }
  const box = await target.boundingBox();
  const viewport = page.viewportSize() ?? { width: 1440, height: 1100 };
  const candidates = [
    { x: 1, y: 1 },
    { x: viewport.width - 2, y: 1 },
    { x: 1, y: viewport.height - 2 },
    { x: viewport.width - 2, y: viewport.height - 2 }
  ];
  const point = candidates.find(({ x, y }) => box === null ||
    x < box.x || x > box.x + box.width || y < box.y || y > box.y + box.height
  );
  if (point === undefined) {
    throw new Error("Browser evidence cannot find an outside pointer position");
  }
  await page.mouse.move(point.x, point.y);
}

export async function captureBrowserDiagnosticPlaybackSoak(
  page: Page,
  playerSelector: string,
  interactionCycle: (iteration: number) => Promise<void>
): Promise<Readonly<BrowserDiagnosticMeasuredRunEvidence> | undefined> {
  if (!browserDiagnosticEvidenceEnvironmentConfigured()) return undefined;
  if (browserDiagnosticExpectedOutcomeFromEnvironment() !== "playback") {
    throw new Error("Playback soak cannot certify deterministic-error evidence");
  }
  const profile = browserDiagnosticInteractionProfileFromEnvironment();
  if (profile === "unsupported") {
    throw new Error("Playback evidence requires desktop or touch interactions");
  }
  return captureMeasuredBrowserRun(
    page,
    page.locator(playerSelector).last(),
    profile,
    interactionCycle,
    true,
    EVIDENCE_SOAK_MILLISECONDS
  );
}

async function captureMeasuredBrowserRun(
  page: Page,
  player: Locator,
  interactionProfile: BrowserDiagnosticInteractionProfile,
  interactionCycle: (iteration: number) => Promise<void>,
  requireAdvancement: boolean,
  requiredMilliseconds: number
): Promise<Readonly<BrowserDiagnosticMeasuredRunEvidence>> {
  if (!Number.isFinite(requiredMilliseconds) ||
      requiredMilliseconds < EVIDENCE_SOAK_MILLISECONDS) {
    throw new Error("Browser evidence soak must last at least 60 seconds");
  }
  await installMeasuredBrowserLedger(player);
  const first = await readMeasuredBrowserSnapshot(player);
  const startedWallClock = Date.now();
  const startedMonotonic = monotonicPerformance.now();
  let lastMonotonic = startedMonotonic;
  let elapsedMilliseconds = 0;
  let iteration = 0;
  do {
    await interactionCycle(iteration);
    iteration += 1;
    const observed = monotonicPerformance.now();
    if (!Number.isFinite(observed) || observed < lastMonotonic) {
      throw new Error("Browser evidence soak clock is non-monotonic");
    }
    lastMonotonic = observed;
    elapsedMilliseconds = observed - startedMonotonic;
  } while (elapsedMilliseconds < requiredMilliseconds);
  if (elapsedMilliseconds < requiredMilliseconds) {
    throw new Error("Browser evidence soak is too short");
  }
  const last = await readMeasuredBrowserSnapshot(player);
  assertPlaybackCountersMonotonic(first.counters, last.counters);
  if (
    requireAdvancement &&
    (last.counters.outputsAccepted <= first.counters.outputsAccepted ||
      last.counters.drawsCompleted <= first.counters.drawsCompleted)
  ) {
    throw new Error("Browser evidence playback counters did not advance");
  }
  const ledger = await readMeasuredBrowserLedger(player);
  if (
    first.terminalFailures !== 0 ||
    last.terminalFailures !== 0 ||
    ledger.terminalFailures !== 0
  ) {
    throw new Error("Browser evidence soak observed a terminal failure");
  }
  const roundedElapsed = Math.round(elapsedMilliseconds * 1_000) / 1_000;
  return Object.freeze({
    interactionProfile,
    startedAt: new Date(startedWallClock).toISOString(),
    finishedAt: new Date(
      startedWallClock + Math.ceil(roundedElapsed)
    ).toISOString(),
    terminalFailures: 0,
    events: ledger.events,
    soak: Object.freeze({
      requiredMilliseconds,
      elapsedMilliseconds: roundedElapsed,
      samples: Object.freeze([
        Object.freeze({
          elapsedMilliseconds: 0,
          terminalFailures: first.terminalFailures,
          counters: first.counters
        }),
        Object.freeze({
          elapsedMilliseconds: roundedElapsed,
          terminalFailures: last.terminalFailures,
          counters: last.counters
        })
      ])
    })
  });
}

async function installMeasuredBrowserLedger(player: Locator): Promise<void> {
  await player.evaluate((element, maximumEvents) => {
    const target = element as HTMLElement & {
      readonly __avalBrowserEvidenceLedger?: {
        readonly events: Array<{
          readonly type: string;
          readonly atMilliseconds: number;
          readonly from: string | null;
          readonly to: string | null;
          readonly edge: string | null;
        }>;
        terminalFailures: number;
      };
    };
    if (target.__avalBrowserEvidenceLedger !== undefined) {
      throw new Error("Browser evidence ledger is already installed");
    }
    const startedAt = performance.now();
    const ledger = { events: [], terminalFailures: 0 } as {
      events: Array<{
        type: string;
        atMilliseconds: number;
        from: string | null;
        to: string | null;
        edge: string | null;
      }>;
      terminalFailures: number;
    };
    Object.defineProperty(target, "__avalBrowserEvidenceLedger", {
      configurable: false,
      enumerable: false,
      value: ledger,
      writable: false
    });
    for (const type of [
      "transitionstart",
      "visualstatechange",
      "transitionend",
      "error"
    ]) {
      target.addEventListener(type, (event) => {
        const detail = (event as CustomEvent<unknown>).detail;
        if (type === "error") {
          if (
            detail !== null &&
            typeof detail === "object" &&
            (detail as Readonly<Record<string, unknown>>).fatal === true
          ) ledger.terminalFailures += 1;
          return;
        }
        if (ledger.events.length >= maximumEvents) return;
        const record = detail !== null && typeof detail === "object"
          ? detail as Readonly<Record<string, unknown>>
          : {};
        ledger.events.push({
          type,
          atMilliseconds: performance.now() - startedAt,
          from: typeof record.from === "string" ? record.from : null,
          to: typeof record.to === "string" ? record.to : null,
          edge: typeof record.edge === "string" ? record.edge : null
        });
      });
    }
  }, EVIDENCE_EVENT_LIMIT);
}

async function readMeasuredBrowserSnapshot(player: Locator): Promise<Readonly<{
  readonly counters: Readonly<BrowserDiagnosticPlaybackCounters>;
  readonly terminalFailures: number;
}>> {
  const snapshot = await player.evaluate((element) => {
    const target = element as HTMLElement & {
      readonly getDiagnostics?: () => Readonly<Record<string, unknown>>;
      readonly __avalBrowserEvidenceLedger?: Readonly<{
        readonly terminalFailures?: unknown;
      }>;
    };
    const diagnostics = target.getDiagnostics?.();
    const runtime = diagnostics?.runtime as
      Readonly<Record<string, unknown>> | null | undefined;
    return {
      counters: runtime?.playbackLifecycle ?? null,
      terminalFailures:
        target.__avalBrowserEvidenceLedger?.terminalFailures ?? null
    };
  });
  return Object.freeze({
    counters: normalizePlaybackCounters(snapshot.counters),
    terminalFailures: requireSafeCounter(
      snapshot.terminalFailures,
      "Browser evidence terminal failure counter is invalid"
    )
  });
}

async function readMeasuredBrowserLedger(player: Locator): Promise<Readonly<{
  readonly terminalFailures: number;
  readonly events: readonly Readonly<{
    readonly type: "transitionstart" | "visualstatechange" | "transitionend";
    readonly atMilliseconds: number;
    readonly from: string | null;
    readonly to: string | null;
    readonly edge: string | null;
  }>[];
}>> {
  const value = await player.evaluate((element) => {
    const target = element as HTMLElement & {
      readonly __avalBrowserEvidenceLedger?: unknown;
    };
    return target.__avalBrowserEvidenceLedger ?? null;
  });
  if (!isRecord(value) || !Array.isArray(value.events)) {
    throw new Error("Browser evidence page ledger is invalid");
  }
  const terminalFailures = requireSafeCounter(
    value.terminalFailures,
    "Browser evidence terminal failure counter is invalid"
  );
  const events = value.events.map((event) => normalizeMeasuredEvent(event));
  if (events.length > EVIDENCE_EVENT_LIMIT) {
    throw new Error("Browser evidence event ledger exceeds its limit");
  }
  return Object.freeze({ terminalFailures, events: Object.freeze(events) });
}

function normalizeMeasuredEvent(value: unknown): Readonly<{
  readonly type: "transitionstart" | "visualstatechange" | "transitionend";
  readonly atMilliseconds: number;
  readonly from: string | null;
  readonly to: string | null;
  readonly edge: string | null;
}> {
  if (!isRecord(value) ||
      !["transitionstart", "visualstatechange", "transitionend"]
        .includes(String(value.type)) ||
      typeof value.atMilliseconds !== "number" ||
      !Number.isFinite(value.atMilliseconds) ||
      value.atMilliseconds < 0) {
    throw new Error("Browser evidence interaction event is invalid");
  }
  const type = value.type as
    "transitionstart" | "visualstatechange" | "transitionend";
  const from = normalizeMeasuredEventField(value.from, 64);
  const to = normalizeMeasuredEventField(value.to, 64);
  const edge = normalizeMeasuredEventField(value.edge, 129);
  return Object.freeze({
    type,
    atMilliseconds: value.atMilliseconds,
    from,
    to,
    edge
  });
}

function normalizeMeasuredEventField(
  value: unknown,
  maximumLength: number
): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maximumLength) {
    throw new Error("Browser evidence interaction event field is invalid");
  }
  return value;
}

function normalizePlaybackCounters(
  value: unknown
): Readonly<BrowserDiagnosticPlaybackCounters> {
  if (!isRecord(value)) {
    throw new Error("Browser evidence playback counters are invalid");
  }
  const counters: Record<string, number | readonly [number, number]> = {};
  for (const key of PLAYBACK_COUNTER_KEYS) {
    counters[key] = requireSafeCounter(
      value[key],
      `Browser evidence playback counter is invalid: ${key}`
    );
  }
  for (const key of PLAYBACK_LANE_COUNTER_KEYS) {
    const lanes = value[key];
    if (!Array.isArray(lanes) || lanes.length !== 2) {
      throw new Error(`Browser evidence playback counter is invalid: ${key}`);
    }
    counters[key] = Object.freeze([
      requireSafeCounter(
        lanes[0],
        `Browser evidence playback counter is invalid: ${key}:0`
      ),
      requireSafeCounter(
        lanes[1],
        `Browser evidence playback counter is invalid: ${key}:1`
      )
    ] as const);
  }
  return Object.freeze(counters) as unknown as
    Readonly<BrowserDiagnosticPlaybackCounters>;
}

function requireSafeCounter(value: unknown, message: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(message);
  }
  return value as number;
}

function assertPlaybackCountersMonotonic(
  before: Readonly<BrowserDiagnosticPlaybackCounters>,
  after: Readonly<BrowserDiagnosticPlaybackCounters>
): void {
  for (const key of PLAYBACK_COUNTER_KEYS) {
    if (after[key] < before[key]) {
      throw new Error(`Browser evidence playback counter regressed: ${key}`);
    }
  }
  for (const key of PLAYBACK_LANE_COUNTER_KEYS) {
    for (let lane = 0; lane < 2; lane += 1) {
      if (after[key][lane]! < before[key][lane]!) {
        throw new Error(
          `Browser evidence playback counter regressed: ${key}:${String(lane)}`
        );
      }
    }
  }
}

export async function prepareDeterministicUnsupportedBrowserPlayer(
  page: Page,
  input: Readonly<{
    readonly demoId: BrowserDiagnosticEvidenceDemoId;
    readonly playerSelector: string;
  }>
): Promise<string> {
  if (input.demoId !== "grass-rabbit-codecs") return input.playerSelector;
  const selector = "#aval-unsupported-sentinel";
  await page.evaluate(async ({ sentinelSelector }) => {
    await customElements.whenDefined("aval-player");
    if (document.querySelector(sentinelSelector) !== null) return;
    const response = await fetch(new URL("grass-rabbit/build.json", location.href));
    if (!response.ok) throw new Error("Sentinel build report is unavailable");
    const report = await response.json() as Readonly<{
      readonly assets?: readonly Readonly<{
        readonly codec?: unknown;
        readonly path?: unknown;
        readonly type?: unknown;
        readonly integrity?: unknown;
      }>[];
    }>;
    const asset = report.assets?.find(({ codec }) => codec === "h264");
    if (
      asset === undefined ||
      typeof asset.path !== "string" ||
      typeof asset.type !== "string" ||
      typeof asset.integrity !== "string"
    ) throw new Error("Sentinel H.264 source metadata is invalid");
    const player = document.createElement("aval-player") as HTMLElement & {
      prepare(options?: Readonly<{ timeoutMs?: number }>): Promise<unknown>;
    };
    player.id = sentinelSelector.slice(1);
    player.setAttribute("width", "640");
    player.setAttribute("height", "360");
    player.style.cssText = "display:block;width:640px;height:360px";
    const source = document.createElement("source");
    source.src = new URL(`grass-rabbit/${asset.path}`, location.href).href;
    source.type = asset.type;
    source.setAttribute("integrity", asset.integrity);
    player.append(source);
    document.body.append(player);
    const diagnostics = (window as DiagnosticWindow).avalBrowserDiagnostics;
    if (diagnostics === undefined) {
      throw new Error("Browser diagnostics are unavailable");
    }
    diagnostics.attach?.(player, {
      example: "grass-rabbit-codecs",
      codec: "h264",
      sentinel: true
    });
    await player.prepare({ timeoutMs: 30_000 }).catch(() => undefined);
  }, { sentinelSelector: selector });
  return selector;
}

export async function waitForDeterministicUnsupportedBrowser(
  page: Page,
  playerSelector: string
): Promise<void> {
  await page.waitForFunction((selector) => {
    const player = document.querySelector<HTMLElement>(selector) as
      (HTMLElement & {
        readonly readiness?: string;
        getDiagnostics?: () => Readonly<Record<string, unknown>>;
      }) | null;
    if (player?.readiness !== "error" ||
        typeof player.getDiagnostics !== "function") return false;
    const diagnostics = player.getDiagnostics();
    const failure = diagnostics.lastFailure as
      Readonly<Record<string, unknown>> | null | undefined;
    const runtime = diagnostics.runtime as
      Readonly<Record<string, unknown>> | null | undefined;
    return failure?.code === "unsupported-browser" &&
      runtime?.selectedCodec === null;
  }, playerSelector, {
    timeout: BROWSER_DIAGNOSTIC_LIMITS.timeoutMilliseconds
  });
  await checkpoint(page, "sentinel:unsupported-browser", playerSelector);
}

export async function soakDeterministicUnsupportedBrowser(
  page: Page,
  playerSelector: string,
  milliseconds = 60_000
): Promise<Readonly<BrowserDiagnosticMeasuredRunEvidence>> {
  if (milliseconds < 60_000) {
    throw new Error("Unsupported-browser evidence soak must last 60 seconds");
  }
  if (browserDiagnosticInteractionProfileFromEnvironment() !== "unsupported") {
    throw new Error(
      "Unsupported-browser evidence requires the unsupported interaction profile"
    );
  }
  const player = page.locator(playerSelector).last();
  const measuredRun = await captureMeasuredBrowserRun(
    page,
    player,
    "unsupported",
    async () => {
      await player.evaluate((element) => {
        const candidate = element as HTMLElement & {
          readonly readiness?: string;
          getDiagnostics?: () => Readonly<Record<string, unknown>>;
        };
        const diagnostics = candidate.getDiagnostics?.();
        const failure = diagnostics?.lastFailure as
          Readonly<Record<string, unknown>> | null | undefined;
        const runtime = diagnostics?.runtime as
          Readonly<Record<string, unknown>> | null | undefined;
        if (
          candidate.readiness !== "error" ||
          failure?.code !== "unsupported-browser" ||
          runtime?.selectedCodec !== null
        ) throw new Error("Unsupported-browser sentinel did not remain stable");
      });
      await page.waitForTimeout(250);
    },
    false,
    milliseconds
  );
  await checkpoint(page, "sentinel:unsupported-browser-soaked", playerSelector);
  return measuredRun;
}

export async function captureDeterministicUnsupportedBrowserEvidence(
  page: Page,
  testInfo: TestInfo,
  input: Readonly<{
    readonly demoId: BrowserDiagnosticEvidenceDemoId;
    readonly playerSelector: string;
    readonly artifactName: string;
  }>
): Promise<BrowserDiagnosticReport> {
  testInfo.setTimeout(Math.max(testInfo.timeout, 90_000));
  const selector = await prepareDeterministicUnsupportedBrowserPlayer(
    page,
    input
  );
  const evidenceCheckpoints: BrowserDiagnosticEvidenceCheckpointArtifacts[] = [];
  await waitForDeterministicUnsupportedBrowser(page, selector);
  await captureBrowserDiagnosticArtifacts(
    page,
    testInfo,
    `${input.artifactName}-unsupported`,
    {
      evidence: browserDiagnosticEvidenceTargetFromEnvironment({
        demoId: input.demoId,
        checkpoint: "unsupported"
      }),
      advancingFrame: false,
      onEvidenceWritten: (artifacts) => evidenceCheckpoints.push(artifacts)
    }
  );
  const measuredRun = await soakDeterministicUnsupportedBrowser(page, selector);
  const report = await captureBrowserDiagnosticArtifacts(
    page,
    testInfo,
    `${input.artifactName}-unsupported-soaked`,
    {
      evidence: browserDiagnosticEvidenceTargetFromEnvironment({
        demoId: input.demoId,
        checkpoint: "unsupported-soaked"
      }),
      advancingFrame: false,
      onEvidenceWritten: (artifacts) => evidenceCheckpoints.push(artifacts)
    }
  );
  assertDeterministicUnsupportedBrowserReport(report);
  await finalizeBrowserDiagnosticEvidenceFromEnvironment({
    demoId: input.demoId,
    checkpoints: evidenceCheckpoints,
    measuredRun
  });
  return report;
}

function assertDeterministicUnsupportedBrowserReport(
  report: Readonly<BrowserDiagnosticReport>
): void {
  const element = report.latest?.element;
  const diagnostics = element?.diagnostics;
  const failure = diagnostics?.lastFailure as
    Readonly<Record<string, unknown>> | null | undefined;
  const runtime = diagnostics?.runtime as
    Readonly<Record<string, unknown>> | null | undefined;
  if (
    element?.readiness !== "error" ||
    failure?.code !== "unsupported-browser" ||
    runtime?.selectedCodec !== null
  ) {
    throw new Error("Browser evidence did not reach deterministic unsupported-browser");
  }
}

export async function openWithDiagnostics(
  page: Page,
  path = "/"
): Promise<void> {
  const url = new URL(path, "http://aval-diagnostics.invalid");
  const certificationMode = browserDiagnosticCertificationModeFromEnvironment();
  if (certificationMode === "forced-h264") {
    await installForcedH264SourcePolicy(page);
  }
  const query = new URLSearchParams({ avalDiagnostics: "1" });
  if (certificationMode !== undefined) {
    query.set("avalCertificationMode", certificationMode);
  }
  await page.goto(`${url.pathname}?${query.toString()}`, {
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

async function installForcedH264SourcePolicy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const h264 = /(?:avc1|avc3|h264)/iu;
    const prune = (root: Node) => {
      if (!(root instanceof Element || root instanceof Document)) return;
      if (
        root instanceof HTMLSourceElement &&
        root.parentElement?.localName === "aval-player" &&
        !h264.test(root.getAttribute("type") ?? "")
      ) {
        root.remove();
      }
      for (const source of root.querySelectorAll("aval-player > source")) {
        if (!h264.test(source.getAttribute("type") ?? "")) source.remove();
      }
    };
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) prune(node);
      }
      prune(document);
    }).observe(document, { childList: true, subtree: true });
  });
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
    expect.stringMatching(
      /^\/[^?#]*\?avalDiagnostics=1(?:&avalCertificationMode=(?:forced-h264|full-ladder))?$/u
    )
  );
  const sessionUrl = new URL(
    String(session.url),
    "http://aval-diagnostics.invalid"
  );
  expect(sessionUrl.origin).toBe("http://aval-diagnostics.invalid");
  expect(sessionUrl.hash).toBe("");
  const certificationMode = sessionUrl.searchParams.get("avalCertificationMode");
  const expectedParameters = certificationMode === null
    ? [["avalDiagnostics", "1"]]
    : [
        ["avalDiagnostics", "1"],
        ["avalCertificationMode", certificationMode]
      ];
  expect(Array.from(sessionUrl.searchParams.entries())).toEqual(
    expectedParameters
  );
  expect(session.url).toBe(
    `${sessionUrl.pathname}?${sessionUrl.searchParams.toString()}`
  );
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
      webCryptoSubtleDigest: expect.any(Boolean),
      videoDecoder: expect.any(Boolean),
      videoDecoderIsConfigSupported: expect.any(Boolean),
      videoFrame: expect.any(Boolean),
      offscreenCanvas: expect.any(Boolean),
      webgl2: expect.any(Boolean),
      webgpu: expect.any(Boolean),
      braveBrandApi: expect.any(Boolean)
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
  name: string,
  options: Readonly<BrowserDiagnosticArtifactOptions> = {}
): Promise<BrowserDiagnosticReport> {
  const safeName = name.replace(/[^a-z0-9_-]+/giu, "-").replace(/^-|-$/gu, "") ||
    "browser-diagnostics";
  let report = await readReport(page);
  const jsonPath = testInfo.outputPath(`${safeName}.json`);
  const screenshotPath = testInfo.outputPath(`${safeName}.png`);
  const expectedOutcome = browserDiagnosticExpectedOutcomeFromEnvironment();
  let activeEvidence = options.evidence === undefined || expectedOutcome !== "playback"
    ? undefined
    : await captureActiveAvalPlayerEvidence(page, report, {
        measureAdvancement: true
      });
  if (activeEvidence !== undefined) report = activeEvidence.report;
  const screenshot = await page.screenshot({ fullPage: true });
  if (options.evidence !== undefined && expectedOutcome === "deterministic-error") {
    activeEvidence = Object.freeze({
      report,
      screenshot,
      beforeScreenshot: null,
      advancingFrame: false,
      frameProof: null
    });
  }
  const reportBytes = `${JSON.stringify(report, null, 2)}\n`;
  await Promise.all([
    writeFile(jsonPath, reportBytes, "utf8"),
    writeFile(screenshotPath, screenshot)
  ]);
  await testInfo.attach(`${safeName}-json`, {
    path: jsonPath,
    contentType: "application/json"
  });
  await testInfo.attach(`${safeName}-screenshot`, {
    path: screenshotPath,
    contentType: "image/png"
  });
  if (options.evidence !== undefined) {
    const artifacts = await writeBrowserDiagnosticEvidencePair(
      options.evidence,
      report,
      activeEvidence?.screenshot as Uint8Array,
      activeEvidence?.beforeScreenshot === null
        ? undefined
        : activeEvidence?.beforeScreenshot,
      screenshot
    );
    options.onEvidenceWritten?.(Object.freeze({
      ...artifacts,
      id: options.evidence.checkpoint,
      beforePngPath: artifacts.beforePngPath ?? null,
      advancingFrame: activeEvidence?.advancingFrame === true,
      frameProof: activeEvidence?.frameProof ?? null
    }));
  }
  return report;
}

const FRAME_SAMPLE_DELAYS_MILLISECONDS = Object.freeze([50, 50]);

export async function captureActiveAvalPlayerEvidence(
  page: Page,
  report: Readonly<BrowserDiagnosticReport>,
  options: Readonly<{ readonly measureAdvancement: boolean }>
): Promise<Readonly<ActiveAvalPlayerEvidence>> {
  const binding = diagnosticActivePlayerBinding(report);
  const players = page.locator("aval-player");
  const count = await players.count();
  if (count === 0) {
    throw activePlayerBindingError();
  }
  const matchingPlayers: Array<ReturnType<Page["locator"]>> = [];
  for (let index = 0; index < count; index += 1) {
    const player = players.nth(index);
    const elementId = await player.getAttribute("id") ?? "";
    if (elementId !== (binding.elementId ?? "")) continue;
    if (!await playerMatchesAuthoredSources(player, binding.authoredSources)) {
      continue;
    }
    matchingPlayers.push(player);
  }
  if (matchingPlayers.length !== 1) throw activePlayerBindingError();
  const player = matchingPlayers[0]!;
  if (!await player.isVisible()) throw activePlayerBindingError();
  const canvas = await visibleAnimatedCanvas(player);
  const before = await sampleActivePlayerCanvas(player, canvas);
  if (!options.measureAdvancement) {
    const postSampleReport = await checkpointBoundPlayerAndReadReport(
      page,
      player,
      report,
      binding
    );
    return Object.freeze({
      report: postSampleReport,
      screenshot: before.screenshot,
      beforeScreenshot: null,
      advancingFrame: false,
      frameProof: null
    });
  }
  const beforeCanvasSha256 = sha256Bytes(before.screenshot);
  let after = before;
  let afterCanvasSha256 = beforeCanvasSha256;
  for (const delay of FRAME_SAMPLE_DELAYS_MILLISECONDS) {
    await page.waitForTimeout(delay);
    after = await sampleActivePlayerCanvas(player, canvas);
    afterCanvasSha256 = sha256Bytes(after.screenshot);
    if (
      afterCanvasSha256 !== beforeCanvasSha256 &&
      drawsAdvanced(before.drawsCompleted, after.drawsCompleted)
    ) break;
  }
  const frameProof = Object.freeze({
    beforeCanvasSha256,
    afterCanvasSha256,
    sampleIntervalMilliseconds: boundedSampleInterval(
      before.sampledAtMilliseconds,
      after.sampledAtMilliseconds
    ),
    beforeDrawsCompleted: before.drawsCompleted,
    afterDrawsCompleted: after.drawsCompleted
  });
  const postSampleReport = await checkpointBoundPlayerAndReadReport(
    page,
    player,
    report,
    binding
  );
  return Object.freeze({
    report: postSampleReport,
    screenshot: after.screenshot,
    beforeScreenshot: before.screenshot,
    advancingFrame:
      beforeCanvasSha256 !== afterCanvasSha256 &&
      drawsAdvanced(before.drawsCompleted, after.drawsCompleted),
    frameProof
  });
}

async function checkpointBoundPlayerAndReadReport(
  page: Page,
  player: Locator,
  beforeReport: Readonly<BrowserDiagnosticReport>,
  beforeBinding: Readonly<DiagnosticActivePlayerBinding>
): Promise<Readonly<BrowserDiagnosticReport>> {
  await player.evaluate((element) => {
    const diagnostics = (window as DiagnosticWindow).avalBrowserDiagnostics;
    if (diagnostics === undefined || typeof diagnostics.checkpoint !== "function") {
      throw new Error("Browser diagnostics checkpoint is unavailable");
    }
    diagnostics.checkpoint("evidence:post-frame-sample", element as HTMLElement);
  });
  const report = await readReport(page);
  const binding = diagnosticActivePlayerBinding(report);
  const beforeState = exactDiagnosticVisualState(beforeReport);
  const afterState = exactDiagnosticVisualState(report);
  if (
    binding.playerId !== beforeBinding.playerId ||
    binding.elementId !== beforeBinding.elementId ||
    JSON.stringify(binding.authoredSources) !==
      JSON.stringify(beforeBinding.authoredSources) ||
    beforeState === undefined ||
    afterState === undefined ||
    afterState !== beforeState
  ) {
    throw new Error(
      "Browser evidence state or active-player binding changed during frame sampling"
    );
  }
  return report;
}

function exactDiagnosticVisualState(
  report: Readonly<BrowserDiagnosticReport>
): string | null | undefined {
  const value = report.latest?.element.visualState;
  return value === null || typeof value === "string" ? value : undefined;
}

interface DiagnosticActivePlayerBinding {
  readonly playerId: string;
  readonly elementId: string | null;
  readonly authoredSources: readonly Readonly<{
    readonly index: number;
    readonly mimeType: string;
    readonly codec: string | null;
  }>[];
}

function diagnosticActivePlayerBinding(
  report: Readonly<BrowserDiagnosticReport>
): Readonly<DiagnosticActivePlayerBinding> {
  const latest = report.latest;
  const playerId = latest?.playerId;
  if (
    latest === null ||
    typeof playerId !== "string" ||
    playerId.length === 0
  ) {
    throw activePlayerBindingError();
  }
  const metadata = report.players.filter((entry) =>
    isRecord(entry) && entry.playerId === playerId
  );
  if (metadata.length !== 1) throw activePlayerBindingError();
  const player = metadata[0]!;
  if (
    player.tagName !== "aval-player" ||
    latest.element.tagName !== "aval-player"
  ) throw activePlayerBindingError();
  const metadataId = diagnosticElementId(player.elementId);
  const latestId = diagnosticElementId(latest.element.elementId);
  if (metadataId === undefined || latestId === undefined || metadataId !== latestId) {
    throw activePlayerBindingError();
  }
  const authoredSources = report.authoredSources
    .filter((entry) => entry.playerId === playerId)
    .sort((left, right) => left.index - right.index);
  if (
    authoredSources.length === 0 ||
    authoredSources.some((source, index) =>
      source.index !== index ||
      source.mimeType.length === 0 ||
      (source.codec !== null && source.codec.length === 0)
    )
  ) throw activePlayerBindingError();
  return Object.freeze({
    playerId,
    elementId: latestId,
    authoredSources: Object.freeze(authoredSources.map((source) =>
      Object.freeze({
        index: source.index,
        mimeType: source.mimeType,
        codec: source.codec
      })
    ))
  });
}

function diagnosticElementId(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function playerMatchesAuthoredSources(
  player: ReturnType<Page["locator"]>,
  expected: Readonly<DiagnosticActivePlayerBinding>["authoredSources"]
): Promise<boolean> {
  const sources = player.locator(":scope > source");
  if (await sources.count() !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    const actual = parseAuthoredSourceType(
      await sources.nth(index).getAttribute("type")
    );
    const wanted = expected[index]!;
    if (
      actual === null ||
      actual.mimeType !== wanted.mimeType ||
      actual.codec !== wanted.codec
    ) return false;
  }
  return true;
}

function parseAuthoredSourceType(value: string | null): Readonly<{
  mimeType: string;
  codec: string | null;
}> | null {
  if (value === null) return null;
  const mimeType = value.split(";", 1)[0]?.trim() ?? "";
  if (mimeType.length === 0) return null;
  const match = /(?:^|;)\s*codecs\s*=\s*["']?([^;"']+)/iu.exec(value);
  return Object.freeze({
    mimeType,
    codec: match?.[1]?.trim() ?? null
  });
}

async function visibleAnimatedCanvas(
  player: ReturnType<Page["locator"]>
): Promise<ReturnType<Page["locator"]>> {
  const canvases = player.locator('canvas[data-aval-layer="animated"]');
  const visible = [];
  const count = await canvases.count();
  for (let index = 0; index < count; index += 1) {
    const canvas = canvases.nth(index);
    if (await canvas.isVisible()) visible.push(canvas);
  }
  if (visible.length !== 1) {
    throw new Error(
      "Browser evidence requires one visible animated canvas on the diagnostic active player"
    );
  }
  return visible[0]!;
}

interface ActivePlayerCanvasSample {
  readonly screenshot: Uint8Array;
  readonly sampledAtMilliseconds: number;
  readonly drawsCompleted: number | null;
}

async function sampleActivePlayerCanvas(
  player: ReturnType<Page["locator"]>,
  canvas: ReturnType<Page["locator"]>
): Promise<Readonly<ActivePlayerCanvasSample>> {
  const snapshot = await player.evaluate((element) => {
    const getDiagnostics = (element as HTMLElement & {
      readonly getDiagnostics?: () => unknown;
    }).getDiagnostics;
    let drawsCompleted: number | null = null;
    if (typeof getDiagnostics === "function") {
      try {
        const diagnostics = getDiagnostics.call(element) as Readonly<{
          readonly runtime?: Readonly<{
            readonly playbackLifecycle?: Readonly<{
              readonly drawsCompleted?: unknown;
            }>;
          }>;
        }>;
        const value = diagnostics.runtime?.playbackLifecycle?.drawsCompleted;
        if (Number.isSafeInteger(value) && (value as number) >= 0) {
          drawsCompleted = value as number;
        }
      } catch { /* Missing counters fail the advancing-frame proof closed. */ }
    }
    return {
      sampledAtMilliseconds: performance.now(),
      drawsCompleted
    };
  });
  if (
    !Number.isFinite(snapshot.sampledAtMilliseconds) ||
    snapshot.sampledAtMilliseconds < 0 ||
    (snapshot.drawsCompleted !== null &&
      (!Number.isSafeInteger(snapshot.drawsCompleted) ||
        snapshot.drawsCompleted < 0))
  ) throw new Error("Browser evidence active-player sample is invalid");
  return Object.freeze({
    screenshot: await canvas.screenshot({ type: "png" }),
    sampledAtMilliseconds: snapshot.sampledAtMilliseconds,
    drawsCompleted: snapshot.drawsCompleted
  });
}

function drawsAdvanced(before: number | null, after: number | null): boolean {
  return before !== null && after !== null && after > before;
}

function boundedSampleInterval(before: number, after: number): number {
  if (!Number.isFinite(before) || !Number.isFinite(after) || after < before) {
    throw new Error("Browser evidence frame sample interval is invalid");
  }
  return Math.round((after - before) * 1_000) / 1_000;
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function activePlayerBindingError(): Error {
  return new Error(
    "Browser evidence cannot bind the diagnostic active player to a visible animated canvas"
  );
}

export async function writeBrowserDiagnosticEvidencePair(
  input: Readonly<BrowserDiagnosticEvidenceTarget>,
  report: Readonly<BrowserDiagnosticReport>,
  screenshot: Uint8Array,
  beforeScreenshot: Uint8Array | undefined,
  contextScreenshot: Uint8Array
): Promise<Readonly<BrowserDiagnosticEvidenceArtifacts>> {
  const target = createBrowserDiagnosticEvidenceTarget(input);
  await assertRealEvidenceRunRoot(target.runRoot);

  const slotRoot = join(target.runRoot, target.slotId);
  const demoRoot = join(slotRoot, target.demoId);
  await ensureRealEvidenceDirectory(slotRoot);
  await ensureRealEvidenceDirectory(demoRoot);

  const stem = `${target.mode}-${target.checkpoint}`;
  const relativeReportPath = `${target.slotId}/${target.demoId}/${stem}.json`;
  const relativePngPath = `${target.slotId}/${target.demoId}/${stem}.png`;
  const relativeBeforePngPath =
    `${target.slotId}/${target.demoId}/${stem}-before.png`;
  const relativeContextPngPath =
    `${target.slotId}/${target.demoId}/${stem}-context.png`;
  const reportPath = join(demoRoot, `${stem}.json`);
  const pngPath = join(demoRoot, `${stem}.png`);
  const beforePngPath = join(demoRoot, `${stem}-before.png`);
  const contextPngPath = join(demoRoot, `${stem}-context.png`);
  const reportBytes = `${JSON.stringify(report, null, 2)}\n`;
  await writeExclusiveEvidencePair(
    reportPath,
    reportBytes,
    pngPath,
    screenshot,
    beforeScreenshot === undefined ? undefined : beforePngPath,
    beforeScreenshot,
    contextPngPath,
    contextScreenshot
  );

  return Object.freeze({
    reportPath: relativeReportPath,
    pngPath: relativePngPath,
    contextPngPath: relativeContextPngPath,
    ...(beforeScreenshot === undefined
      ? {}
      : { beforePngPath: relativeBeforePngPath }),
    pngSha256: createHash("sha256").update(screenshot).digest("hex"),
    contextPngSha256: createHash("sha256")
      .update(contextScreenshot)
      .digest("hex"),
    visualState: diagnosticVisualState(report)
  });
}

export async function writeBrowserDiagnosticEvidenceSession(
  input: Readonly<BrowserDiagnosticEvidenceSessionTarget>,
  session: unknown
): Promise<Readonly<{ readonly sessionPath: string }>> {
  const runRoot = normalizeEvidenceRunRoot(input.runRoot);
  assertEvidenceIdentifier("slot id", input.slotId);
  const identity = await assertRealEvidenceRunRoot(runRoot);
  assertEvidenceSessionRunIdentity(session, input.slotId, identity);
  const slotRoot = join(runRoot, input.slotId);
  await ensureRealEvidenceDirectory(slotRoot);
  const relativePath = `${input.slotId}/session.json`;
  await writeExclusiveJsonArtifact(join(slotRoot, "session.json"), session);
  return Object.freeze({ sessionPath: relativePath });
}

export async function writeBrowserDiagnosticInteractionLedger(
  input: Readonly<BrowserDiagnosticEvidenceLedgerTarget>,
  ledger: unknown
): Promise<Readonly<{ readonly ledgerPath: string }>> {
  const runRoot = normalizeEvidenceRunRoot(input.runRoot);
  assertEvidenceIdentifier("slot id", input.slotId);
  if (!EVIDENCE_DEMO_IDS.includes(input.demoId)) {
    throw new Error(`Unsupported browser evidence demo: ${String(input.demoId)}`);
  }
  if (!EVIDENCE_MODES.includes(input.mode)) {
    throw new Error(`Unsupported browser evidence mode: ${String(input.mode)}`);
  }
  await assertRealEvidenceRunRoot(runRoot);
  const slotRoot = join(runRoot, input.slotId);
  const demoRoot = join(slotRoot, input.demoId);
  await ensureRealEvidenceDirectory(slotRoot);
  await ensureRealEvidenceDirectory(demoRoot);
  const filename = `${input.mode}-interaction-ledger.json`;
  const relativePath = `${input.slotId}/${input.demoId}/${filename}`;
  await writeExclusiveJsonArtifact(join(demoRoot, filename), ledger);
  return Object.freeze({ ledgerPath: relativePath });
}

export async function finalizeBrowserDiagnosticEvidenceFromEnvironment(
  input: Readonly<BrowserDiagnosticEvidenceFinalization>
): Promise<Readonly<{
  readonly sessionPath: string;
  readonly ledgerPath: string;
}> | undefined> {
  const runRoot = process.env.AVAL_BROWSER_EVIDENCE_RUN_ROOT;
  const slotId = process.env.AVAL_BROWSER_EVIDENCE_SLOT_ID;
  const mode = browserDiagnosticCertificationModeFromEnvironment();
  if (runRoot === undefined && slotId === undefined && mode === undefined) {
    assertNoDetachedEvidenceMetadata();
    return undefined;
  }
  if (runRoot === undefined || slotId === undefined || mode === undefined) {
    throw new Error(
      "Browser evidence finalization requires run root, slot id, and mode"
    );
  }
  const target = createBrowserDiagnosticEvidenceTarget({
    runRoot,
    slotId,
    demoId: input.demoId,
    mode,
    checkpoint: input.checkpoints[0]?.id ?? "missing"
  });
  const checkpoints = validateEvidenceCheckpointArtifacts(input.checkpoints);
  assertEvidenceStateCoverage(
    input.demoId,
    browserDiagnosticExpectedOutcomeFromEnvironment(),
    checkpoints
  );
  const session = parseEvidenceMetadataEnvironment(
    "AVAL_BROWSER_EVIDENCE_SESSION_JSON"
  );
  const ledgerTemplate = parseEvidenceMetadataEnvironment(
    "AVAL_BROWSER_EVIDENCE_LEDGER_JSON"
  );
  assertEvidenceSessionIdentity(session, target);
  const ledger = createExactInteractionLedger(
    ledgerTemplate,
    target,
    checkpoints,
    requireMeasuredRunEvidence(input.measuredRun, target)
  );

  const sessionPath = `${target.slotId}/session.json`;
  try {
    await writeBrowserDiagnosticEvidenceSession(target, session);
  } catch (error) {
    if (!hasNodeErrorCode(error, "EEXIST")) throw error;
    await assertExistingExactJsonArtifact(
      join(target.runRoot, sessionPath),
      session
    );
  }
  const { ledgerPath } = await writeBrowserDiagnosticInteractionLedger(
    target,
    ledger
  );
  return Object.freeze({ sessionPath, ledgerPath });
}

function assertNoDetachedEvidenceMetadata(): void {
  if (
    process.env.AVAL_BROWSER_EVIDENCE_SESSION_JSON !== undefined ||
    process.env.AVAL_BROWSER_EVIDENCE_LEDGER_JSON !== undefined ||
    process.env.AVAL_BROWSER_EVIDENCE_INTERACTION_PROFILE !== undefined
  ) {
    throw new Error(
      "Browser evidence metadata cannot be supplied without an evidence target"
    );
  }
}

function parseEvidenceMetadataEnvironment(name: string): Record<string, unknown> {
  const serialized = process.env[name];
  if (serialized === undefined) {
    throw new Error(`Browser evidence finalization requires ${name}`);
  }
  if (new TextEncoder().encode(serialized).byteLength > 2_097_152) {
    throw new Error(`Browser evidence metadata exceeds the limit: ${name}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`Browser evidence metadata is invalid JSON: ${name}`, {
      cause: error
    });
  }
  if (!isRecord(value)) {
    throw new Error(`Browser evidence metadata must be an object: ${name}`);
  }
  return value;
}

function validateEvidenceCheckpointArtifacts(
  value: readonly Readonly<BrowserDiagnosticEvidenceCheckpointArtifacts>[]
): readonly Readonly<BrowserDiagnosticEvidenceCheckpointArtifacts>[] {
  if (value.length < 2 || value.length > 64) {
    throw new Error("Browser evidence requires between 2 and 64 checkpoints");
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const checkpoint of value) {
    assertEvidenceIdentifier("checkpoint", checkpoint.id);
    if (ids.has(checkpoint.id)) {
      throw new Error(`Browser evidence checkpoint is duplicated: ${checkpoint.id}`);
    }
    ids.add(checkpoint.id);
    for (const path of [
      checkpoint.reportPath,
      checkpoint.pngPath,
      checkpoint.contextPngPath,
      ...(checkpoint.beforePngPath === null ? [] : [checkpoint.beforePngPath])
    ]) {
      if (paths.has(path)) {
        throw new Error(`Browser evidence artifact path is duplicated: ${path}`);
      }
      paths.add(path);
    }
    if (!/^[a-f0-9]{64}$/u.test(checkpoint.pngSha256)) {
      throw new Error(`Browser evidence PNG digest is invalid: ${checkpoint.id}`);
    }
    if (!/^[a-f0-9]{64}$/u.test(checkpoint.contextPngSha256)) {
      throw new Error(`Browser evidence context PNG digest is invalid: ${checkpoint.id}`);
    }
    const proof = checkpoint.frameProof;
    if (proof === null) {
      if (checkpoint.advancingFrame || checkpoint.beforePngPath !== null) {
        throw new Error(`Browser evidence frame proof is invalid: ${checkpoint.id}`);
      }
      continue;
    }
    if (checkpoint.beforePngPath === null ||
        proof.afterCanvasSha256 !== checkpoint.pngSha256 ||
        !/^[a-f0-9]{64}$/u.test(proof.beforeCanvasSha256) ||
        !/^[a-f0-9]{64}$/u.test(proof.afterCanvasSha256) ||
        proof.sampleIntervalMilliseconds < 1 ||
        proof.sampleIntervalMilliseconds > 5_000 ||
        proof.beforeDrawsCompleted === null ||
        proof.afterDrawsCompleted === null ||
        proof.afterDrawsCompleted < proof.beforeDrawsCompleted ||
        checkpoint.advancingFrame !== (
          proof.beforeCanvasSha256 !== proof.afterCanvasSha256 &&
          proof.afterDrawsCompleted > proof.beforeDrawsCompleted
        )) {
      throw new Error(`Browser evidence frame proof is invalid: ${checkpoint.id}`);
    }
  }
  return Object.freeze([...value]);
}

function assertEvidenceStateCoverage(
  demoId: BrowserDiagnosticEvidenceDemoId,
  expectedOutcome: BrowserDiagnosticExpectedOutcome,
  checkpoints: readonly Readonly<BrowserDiagnosticEvidenceCheckpointArtifacts>[]
): void {
  if (expectedOutcome === "deterministic-error") {
    if (checkpoints.some((checkpoint) =>
      checkpoint.visualState !== null || checkpoint.advancingFrame ||
      checkpoint.frameProof !== null
    )) {
      throw new Error("Unsupported-browser evidence cannot claim animated state");
    }
    return;
  }
  const expectedStates = demoId === "end-user-playground"
    ? ["idle", "engaged"]
    : ["idle", "entering", "hover", "exiting"];
  const capturedStates = new Set(checkpoints.map(({ visualState }) => visualState));
  for (const state of expectedStates) {
    if (!capturedStates.has(state)) {
      throw new Error(`Browser evidence is missing a rendered state: ${state}`);
    }
  }
  if (!checkpoints.some(({ advancingFrame }) => advancingFrame)) {
    throw new Error("Browser evidence is missing measured advancing playback");
  }
}

function assertEvidenceSessionIdentity(
  value: Readonly<Record<string, unknown>>,
  target: Readonly<BrowserDiagnosticEvidenceTarget>
): void {
  if (value.schemaVersion !== 1 || value.slotId !== target.slotId) {
    throw new Error("Browser evidence session identity does not match the target");
  }
  for (const field of [
    "sessionId",
    "sourceCommit",
    "tunnelUrl",
    "tunnelCreatedAt",
    "testedAt"
  ]) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error(`Browser evidence session is missing exact ${field}`);
    }
  }
  const browser = requireEvidenceRecord(value.browser, "session browser");
  for (const field of ["brand", "version", "engine"]) {
    if (typeof browser[field] !== "string" || browser[field].length === 0) {
      throw new Error(`Browser evidence session is missing exact browser ${field}`);
    }
  }
  const engineVersion = browser.engineVersion;
  if (
    engineVersion === null
      ? browser.engine !== "WebKit"
      : typeof engineVersion !== "string" ||
        !/^[0-9]+(?:\.[0-9]+){1,3}$/u.test(engineVersion)
  ) {
    throw new Error(
      "Browser evidence session requires an exact compatible engine version"
    );
  }
  const provider = requireEvidenceRecord(value.provider, "session provider");
  if (
    typeof provider.kind !== "string" || provider.kind.length === 0 ||
    typeof provider.sessionId !== "string" || provider.sessionId.length === 0
  ) {
    throw new Error("Browser evidence session requires exact provider identity");
  }
  const os = requireEvidenceRecord(value.os, "session OS");
  if (
    typeof os.name !== "string" || os.name.length === 0 ||
    typeof os.version !== "string" || os.version.length === 0
  ) {
    throw new Error("Browser evidence session requires exact OS identity");
  }
  if (value.device !== null) {
    const device = requireEvidenceRecord(value.device, "session device");
    if (typeof device.name !== "string" || device.name.length === 0) {
      throw new Error("Browser evidence session requires an exact device name");
    }
  }
}

function createExactInteractionLedger(
  template: Readonly<Record<string, unknown>>,
  target: Readonly<BrowserDiagnosticEvidenceTarget>,
  checkpoints: readonly Readonly<BrowserDiagnosticEvidenceCheckpointArtifacts>[],
  measuredRun: Readonly<BrowserDiagnosticMeasuredRunEvidence>
): Readonly<Record<string, unknown>> {
  if (
    template.schemaVersion !== 1 ||
    template.slotId !== target.slotId ||
    template.demoId !== target.demoId ||
    template.mode !== target.mode
  ) {
    throw new Error("Browser evidence ledger identity does not match the target");
  }
  const visualCheckpoints = checkpoints.map((checkpoint) => Object.freeze({
    id: checkpoint.id,
    visualState: checkpoint.visualState,
    advancingFrame: checkpoint.advancingFrame,
    pngSha256: checkpoint.pngSha256,
    contextPngSha256: checkpoint.contextPngSha256,
    frameProof: checkpoint.frameProof === null ? null : Object.freeze({
      beforePngSha256: checkpoint.frameProof.beforeCanvasSha256,
      afterPngSha256: checkpoint.frameProof.afterCanvasSha256,
      sampleIntervalMilliseconds:
        checkpoint.frameProof.sampleIntervalMilliseconds,
      beforeDrawsCompleted: checkpoint.frameProof.beforeDrawsCompleted,
      afterDrawsCompleted: checkpoint.frameProof.afterDrawsCompleted
    })
  }));
  if (template.visualCheckpoints !== undefined) {
    const supplied = JSON.stringify(template.visualCheckpoints);
    const captured = JSON.stringify(visualCheckpoints);
    if (supplied !== captured) {
      throw new Error(
        "Browser evidence ledger checkpoints do not match captured PNG evidence"
      );
    }
  }
  return Object.freeze({
    ...template,
    interactionProfile: measuredRun.interactionProfile,
    startedAt: measuredRun.startedAt,
    finishedAt: measuredRun.finishedAt,
    terminalFailures: measuredRun.terminalFailures,
    events: measuredRun.events,
    visualCheckpoints,
    soak: measuredRun.soak
  });
}

function requireMeasuredRunEvidence(
  value: Readonly<BrowserDiagnosticMeasuredRunEvidence> | undefined,
  target: Readonly<BrowserDiagnosticEvidenceTarget>
): Readonly<BrowserDiagnosticMeasuredRunEvidence> {
  if (value === undefined) {
    throw new Error("Browser evidence finalization requires a measured 60-second run");
  }
  const expectedProfile = browserDiagnosticInteractionProfileFromEnvironment();
  const expectedOutcome = browserDiagnosticExpectedOutcomeFromEnvironment();
  if (
    value.interactionProfile !== expectedProfile ||
    (expectedOutcome === "playback" && expectedProfile === "unsupported") ||
    (expectedOutcome === "deterministic-error" && expectedProfile !== "unsupported") ||
    value.terminalFailures !== 0 ||
    !Array.isArray(value.events) ||
    value.events.length > EVIDENCE_EVENT_LIMIT ||
    value.soak.requiredMilliseconds !== EVIDENCE_SOAK_MILLISECONDS ||
    !Number.isFinite(value.soak.elapsedMilliseconds) ||
    value.soak.elapsedMilliseconds < value.soak.requiredMilliseconds ||
    !Array.isArray(value.soak.samples) ||
    value.soak.samples.length < 2 ||
    value.soak.samples.length > 128
  ) {
    throw new Error("Browser evidence measured run is invalid");
  }
  const startedAt = Date.parse(value.startedAt);
  const finishedAt = Date.parse(value.finishedAt);
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(finishedAt) ||
    finishedAt - startedAt < value.soak.elapsedMilliseconds
  ) {
    throw new Error("Browser evidence measured run clock is invalid");
  }
  for (const event of value.events) normalizeMeasuredEvent(event);
  let previous = value.soak.samples[0];
  if (
    previous === undefined ||
    previous.elapsedMilliseconds !== 0 ||
    previous.terminalFailures !== 0
  ) {
    throw new Error("Browser evidence measured run start sample is invalid");
  }
  normalizePlaybackCounters(previous.counters);
  for (const sample of value.soak.samples.slice(1)) {
    if (
      !Number.isFinite(sample.elapsedMilliseconds) ||
      sample.elapsedMilliseconds < previous.elapsedMilliseconds ||
      sample.terminalFailures !== 0
    ) {
      throw new Error("Browser evidence measured run sample is invalid");
    }
    assertPlaybackCountersMonotonic(
      normalizePlaybackCounters(previous.counters),
      normalizePlaybackCounters(sample.counters)
    );
    previous = sample;
  }
  if (
    previous.elapsedMilliseconds < EVIDENCE_SOAK_MILLISECONDS ||
    previous.elapsedMilliseconds > value.soak.elapsedMilliseconds
  ) {
    throw new Error("Browser evidence measured run sample window is invalid");
  }
  const firstCounters = normalizePlaybackCounters(
    value.soak.samples[0]!.counters
  );
  const lastCounters = normalizePlaybackCounters(previous.counters);
  if (
    expectedOutcome === "playback" &&
    (lastCounters.outputsAccepted <= firstCounters.outputsAccepted ||
      lastCounters.drawsCompleted <= firstCounters.drawsCompleted)
  ) {
    throw new Error("Browser evidence measured playback did not advance");
  }
  if (target.slotId.length === 0) {
    throw new Error("Browser evidence measured run target is invalid");
  }
  return value;
}

function requireEvidenceRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Browser evidence ${label} is invalid`);
  return value;
}

async function assertExistingExactJsonArtifact(
  path: string,
  value: unknown
): Promise<void> {
  const expected = `${JSON.stringify(value, null, 2)}\n`;
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new Error("Existing browser evidence session is not a stable file");
  }
  const actual = await readFile(path, "utf8");
  const after = await lstat(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    actual !== expected
  ) {
    throw new Error("Existing browser evidence session differs from exact metadata");
  }
}

async function assertRealEvidenceRunRoot(
  runRoot: string
): Promise<Readonly<BrowserDiagnosticEvidenceRunIdentity>> {
  const stat = await lstat(runRoot).catch((error: unknown) => {
    throw new Error("Browser evidence run root must already exist", {
      cause: error
    });
  });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(
      "Browser evidence run root must be a real, existing directory"
    );
  }
  const canonical = resolve(await realpath(runRoot));
  const comparableRunRoot = process.platform === "win32"
    ? runRoot.toLowerCase()
    : runRoot;
  const comparableCanonical = process.platform === "win32"
    ? canonical.toLowerCase()
    : canonical;
  if (comparableCanonical !== comparableRunRoot) {
    throw new Error("Browser evidence run root cannot contain symlinks");
  }
  const manifestPath = join(runRoot, "manifest.json");
  if (await pathExists(manifestPath)) {
    throw new Error("Browser evidence run root is already assembled");
  }
  const identity = await readStableEvidenceRunIdentity(runRoot);
  assertEvidenceRunRootSuffix(runRoot, identity);
  return identity;
}

async function readStableEvidenceRunIdentity(
  runRoot: string
): Promise<Readonly<BrowserDiagnosticEvidenceRunIdentity>> {
  const path = join(runRoot, EVIDENCE_RUN_IDENTITY_FILENAME);
  const before = await lstat(path).catch((error: unknown) => {
    throw new Error(
      `Browser evidence run root requires ${EVIDENCE_RUN_IDENTITY_FILENAME}`,
      { cause: error }
    );
  });
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1 ||
    before.size < 2 ||
    before.size > 65_536
  ) {
    throw new Error("Browser evidence run identity is not a stable regular file");
  }
  const serialized = await readFile(path, "utf8");
  const after = await lstat(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error("Browser evidence run identity changed while reading");
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new Error("Browser evidence run identity is invalid JSON", {
      cause: error
    });
  }
  return normalizeEvidenceRunIdentity(value);
}

function normalizeEvidenceRunIdentity(
  value: unknown
): Readonly<BrowserDiagnosticEvidenceRunIdentity> {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion",
    "sessionId",
    "createdAt",
    "sourceAttestation"
  ]) || value.schemaVersion !== 1 ||
      typeof value.sessionId !== "string" ||
      !EVIDENCE_SESSION_ID_PATTERN.test(value.sessionId) ||
      typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      !isRecord(value.sourceAttestation) ||
      !hasExactKeys(value.sourceAttestation, [
        "headCommit",
        "trackedDiffSha256",
        "untrackedSourceTreeSha256",
        "policySha256",
        "servedTreeSha256"
      ])) {
    throw new Error("Browser evidence run identity is invalid");
  }
  const attestation = value.sourceAttestation;
  if (
    typeof attestation.headCommit !== "string" ||
    !EVIDENCE_COMMIT_PATTERN.test(attestation.headCommit) ||
    [
      attestation.trackedDiffSha256,
      attestation.untrackedSourceTreeSha256,
      attestation.policySha256,
      attestation.servedTreeSha256
    ].some((digest) =>
      typeof digest !== "string" || !EVIDENCE_SHA256_PATTERN.test(digest)
    )
  ) {
    throw new Error("Browser evidence run identity attestation is invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    sessionId: value.sessionId,
    createdAt: value.createdAt,
    sourceAttestation: Object.freeze({
      headCommit: attestation.headCommit,
      trackedDiffSha256: attestation.trackedDiffSha256 as string,
      untrackedSourceTreeSha256:
        attestation.untrackedSourceTreeSha256 as string,
      policySha256: attestation.policySha256 as string,
      servedTreeSha256: attestation.servedTreeSha256 as string
    })
  });
}

function assertEvidenceRunRootSuffix(
  runRoot: string,
  identity: Readonly<BrowserDiagnosticEvidenceRunIdentity>
): void {
  const sessionSegment = parse(runRoot).base;
  const commitSegment = parse(parse(runRoot).dir).base;
  if (
    sessionSegment !== identity.sessionId ||
    commitSegment !== identity.sourceAttestation.headCommit
  ) {
    throw new Error(
      "Browser evidence run root does not match its immutable identity"
    );
  }
}

function assertEvidenceSessionRunIdentity(
  session: unknown,
  slotId: string,
  identity: Readonly<BrowserDiagnosticEvidenceRunIdentity>
): void {
  if (
    !isRecord(session) ||
    session.schemaVersion !== 1 ||
    session.slotId !== slotId ||
    session.sessionId !== identity.sessionId ||
    session.sourceCommit !== identity.sourceAttestation.headCommit
  ) {
    throw new Error("Browser evidence session does not match run identity");
  }
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    [...expected].sort().every((key, index) => actual[index] === key);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function ensureRealEvidenceDirectory(path: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if (!hasNodeErrorCode(error, "EEXIST")) throw error;
  }
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Browser evidence layout contains a non-directory component");
  }
}

async function writeExclusiveEvidencePair(
  reportPath: string,
  report: string,
  pngPath: string,
  screenshot: Uint8Array,
  beforePngPath?: string,
  beforeScreenshot?: Uint8Array,
  contextPngPath?: string,
  contextScreenshot?: Uint8Array
): Promise<void> {
  let reportHandle: FileHandle | null = null;
  let pngHandle: FileHandle | null = null;
  let beforePngHandle: FileHandle | null = null;
  let contextPngHandle: FileHandle | null = null;
  let failure: unknown = null;
  try {
    reportHandle = await open(reportPath, "wx", 0o444);
    pngHandle = await open(pngPath, "wx", 0o444);
    if (beforePngPath !== undefined && beforeScreenshot !== undefined) {
      beforePngHandle = await open(beforePngPath, "wx", 0o444);
    }
    if (contextPngPath === undefined || contextScreenshot === undefined) {
      throw new Error("Browser evidence context screenshot is required");
    }
    contextPngHandle = await open(contextPngPath, "wx", 0o444);
    const writes: Promise<unknown>[] = [
      reportHandle.writeFile(report, "utf8"),
      pngHandle.writeFile(screenshot),
      contextPngHandle.writeFile(contextScreenshot)
    ];
    if (beforePngHandle !== null && beforeScreenshot !== undefined) {
      writes.push(beforePngHandle.writeFile(beforeScreenshot));
    }
    await Promise.all(writes);
    const syncs: Promise<unknown>[] = [
      reportHandle.sync(),
      pngHandle.sync(),
      contextPngHandle.sync()
    ];
    if (beforePngHandle !== null) syncs.push(beforePngHandle.sync());
    await Promise.all(syncs);
  } catch (error) {
    failure = error;
  } finally {
    await Promise.allSettled([
      reportHandle?.close(),
      pngHandle?.close(),
      beforePngHandle?.close(),
      contextPngHandle?.close()
    ]);
  }
  if (failure === null) return;
  await Promise.allSettled([
    reportHandle === null ? undefined : unlink(reportPath),
    pngHandle === null ? undefined : unlink(pngPath),
    beforePngHandle === null || beforePngPath === undefined
      ? undefined
      : unlink(beforePngPath),
    contextPngHandle === null || contextPngPath === undefined
      ? undefined
      : unlink(contextPngPath)
  ]);
  throw failure;
}

async function writeExclusiveJsonArtifact(
  path: string,
  value: unknown
): Promise<void> {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new Error("Browser evidence JSON value is not serializable");
  }
  let handle: FileHandle | null = null;
  let failure: unknown = null;
  try {
    handle = await open(path, "wx", 0o444);
    await handle.writeFile(`${serialized}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    failure = error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  if (failure === null) return;
  if (handle !== null) await unlink(path).catch(() => undefined);
  throw failure;
}

function diagnosticVisualState(
  report: Readonly<BrowserDiagnosticReport>
): string | null {
  const value = report.latest?.element.visualState;
  return typeof value === "string" ? value : null;
}

function assertEvidenceIdentifier(label: string, value: string): void {
  if (
    value.length > EVIDENCE_IDENTIFIER_MAX_LENGTH ||
    !EVIDENCE_IDENTIFIER_PATTERN.test(value)
  ) {
    throw new Error(`Browser evidence ${label} is unsafe`);
  }
}

function normalizeEvidenceRunRoot(runRoot: string): string {
  if (!isAbsolute(runRoot)) {
    throw new Error("Browser evidence run root must be an absolute path");
  }
  const absolute = resolve(runRoot);
  if (absolute === parse(absolute).root) {
    throw new Error("Browser evidence run root cannot be a filesystem root");
  }
  return absolute;
}

function sameFilesystemPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
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
