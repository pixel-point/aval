import {
  defineAvalElement,
  type AvalDiagnostics,
  type AvalElement
} from "@pixel-point/aval-element";
import {
  DEFAULT_MAXIMUM_DECODER_LEASES,
  DEFAULT_MAXIMUM_PAGE_PHYSICAL_BYTES,
  DEFAULT_MAXIMUM_PLAYER_LOGICAL_BYTES
} from "@pixel-point/aval-player-web";

import { ForegroundMeasurementGuard, type MeasurementInterruption } from "./foreground-guard.js";
import { deriveBrowserEnvironmentIdentity } from "./environment-identity.js";
import { runLifecycleStress } from "./lifecycle-stress.js";
import { LOCAL_NETWORK_FAULTS, runNetworkFaultStress } from "./network-fault-stress.js";
import { createPublicMotionElement, preparePublicMotion, retirePublicMotion } from "./public-element-host.js";
import { createReportExport, offerReportDownload, type CertificationExport } from "./report-export.js";
import { BrowserResourceLedger } from "./resource-ledger.js";
import { runResourceSoak } from "./resource-soak.js";
import { RouteLedger } from "./route-ledger.js";
import {
  assertRunnableForeground,
  externalIntegrityFromSha256,
  fetchVerifiedSource,
  loadRunConfig,
  type CertificationRunConfig
} from "./run-config.js";
import { PublicRuntimeTraceCollector, type RuntimeTraceCollection } from "./runtime-trace-ledger.js";
import { runVisibilityStress } from "./visibility-stress.js";

export type HarnessStatus = "passed" | "failed" | "inconclusive";

export interface HarnessRunOptions {
  readonly stateTransitions?: number;
  readonly rapidInputs?: number;
  readonly lifecycleCycles?: number;
  readonly soakDurationMs?: number;
  readonly soakPlayers?: number;
}

export interface PublicHarnessReport {
  readonly schemaVersion: "1.0";
  readonly reportKind: "public-path-functional-harness";
  readonly evidenceClass: "playwright-functional-engine" | "named-browser-runtime-input";
  readonly status: HarnessStatus;
  readonly runId: string;
  readonly candidateManifestDigest: string;
  readonly fixtureDigest: string;
  readonly harnessDigest: string;
  readonly commit: string;
  readonly tree: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly source: Readonly<{ sha256: string; byteLength: number; matched: boolean }>;
  readonly capabilities: Readonly<Record<string, boolean | number | string>>;
  readonly publicElement: Readonly<{
    readiness: string;
    mode: string | null;
    assurance: string | null;
    states: readonly string[];
    events: readonly string[];
    bindings: number;
    transitionsRequested: number;
    transitionsCompleted: number;
    rapidInputsRequested: number;
    rapidInputsSettled: number;
    routeEvents: number;
    exactContentIdentityAvailable: boolean;
  }>;
  readonly ledgers: Readonly<{
    frameEntries: number;
    resourceSnapshots: number;
    routeEntries: number;
  }>;
  readonly runtimeTrace: RuntimeTraceCollection;
  readonly measurementInterruptions: readonly Readonly<MeasurementInterruption>[];
  readonly lifecycle: Awaited<ReturnType<typeof runLifecycleStress>>;
  readonly visibility: Awaited<ReturnType<typeof runVisibilityStress>>;
  readonly soak: Awaited<ReturnType<typeof runResourceSoak>>;
  readonly timingCriteria: Readonly<{
    status: "collected" | "failed" | "unsupported" | "inconclusive";
    reason: string;
    callbackTimestampsRelabeledAsDisplayEvidence: false;
    observedDisplayEvidence: false;
  }>;
  readonly failures: readonly string[];
}

export interface ResourceFaultHarnessReport {
  readonly status: HarnessStatus;
  readonly lifecycle: Awaited<ReturnType<typeof runLifecycleStress>>;
  readonly network: Awaited<ReturnType<typeof runNetworkFaultStress>>;
  readonly failures: readonly string[];
}

export interface CertificationBrowserApi {
  readonly ready: Promise<void>;
  getConfig(): CertificationRunConfig | null;
  getLastReport(): PublicHarnessReport | ResourceFaultHarnessReport | null;
  getLastExport(): CertificationExport | null;
  runPublicHarness(options?: HarnessRunOptions): Promise<PublicHarnessReport>;
  runResourceFaultProfile(options?: Readonly<{ full?: boolean }>): Promise<ResourceFaultHarnessReport>;
  abort(): void;
  exportLastReport(): Promise<CertificationExport>;
}

export class CertificationApp implements CertificationBrowserApi {
  public readonly ready: Promise<void>;
  readonly #root: HTMLElement;
  readonly #stage: HTMLElement;
  readonly #status: HTMLElement;
  readonly #banner: HTMLElement;
  readonly #report: HTMLPreElement;
  #config: CertificationRunConfig | null = null;
  #lastReport: PublicHarnessReport | ResourceFaultHarnessReport | null = null;
  #lastExport: CertificationExport | null = null;
  #abortController: AbortController | null = null;

  public constructor(root: HTMLElement) {
    this.#root = root;
    this.#banner = required(root, "[data-certification-banner]");
    this.#status = required(root, "[data-certification-status]");
    this.#stage = required(root, "[data-certification-stage]");
    this.#report = required(root, "[data-certification-report]");
    this.ready = this.#initialize();
  }

  public getConfig(): CertificationRunConfig | null { return this.#config; }
  public getLastReport(): PublicHarnessReport | ResourceFaultHarnessReport | null { return this.#lastReport; }
  public getLastExport(): CertificationExport | null { return this.#lastExport; }

  public abort(): void {
    this.#abortController?.abort();
    this.#setStatus("Abort requested; the partial report will remain inconclusive.", "pending");
  }

  public async runPublicHarness(options: HarnessRunOptions = {}): Promise<PublicHarnessReport> {
    await this.ready;
    const config = requireConfig(this.#config);
    if (this.#abortController !== null) throw new Error("a certification run is already active");
    this.#abortController = new AbortController();
    const signal = this.#abortController.signal;
    const loadedSource = await fetchVerifiedSource(config.sourceUrl, config.fixtureDigest);
    const source = loadedSource.evidence;
    const sourceIntegrity = externalIntegrityFromSha256(config.fixtureDigest);
    assertRunnableForeground(config, source.matched);
    const foreground = new ForegroundMeasurementGuard(config.mode === "named");
    const startedAt = new Date().toISOString();
    const routeLedger = new RouteLedger(100_000);
    const resourceLedger = new BrowserResourceLedger(10_000);
    let traceCollector = new PublicRuntimeTraceCollector(config.mode === "named" ? 2_000_000 : 100_000);
    const failures: string[] = [];
    let element: AvalElement | null = null;
    let readiness: Readonly<AvalDiagnostics> | null = null;
    let transitionsCompleted = 0;
    let rapidInputsSettled = 0;
    let selectedRendition: string | null = null;
    const counts = runCounts(config, options);
    let lifecycle = emptyLifecycle(counts.lifecycleCycles);
    let visibility = emptyVisibility();
    let soak = emptySoak(counts.soakDurationMs, counts.soakPlayers);
    try {
      this.#setStatus("Running the public package path…", "running");
      element = createPublicMotionElement(config.sourceUrl, this.#stage, routeLedger, sourceIntegrity);
      const activeElement = element;
      readiness = await preparePublicMotion(activeElement, 20_000, signal);
      resourceLedger.append("interactive-ready", readiness);
      selectedRendition = readiness.runtime.selectedRendition;
      const warmupTrace = new PublicRuntimeTraceCollector(1_024);
      drainRuntimeTrace(activeElement, warmupTrace);
      if (readiness.readiness === "interactiveReady") await waitForTraceFrames(activeElement, warmupTrace, 2, signal, foreground);
      traceCollector = new PublicRuntimeTraceCollector(config.mode === "named" ? 2_000_000 : 100_000);
      primeRuntimeTrace(activeElement, traceCollector);
      if (readiness.readiness === "interactiveReady") {
        if (config.mode === "named") await waitForTraceCoverage(activeElement, traceCollector, ({ loopBoundaries }) => loopBoundaries >= 1_000, "1,000 loop boundaries", 20 * 60 * 1_000, signal, foreground);
        else await waitForTraceFrames(activeElement, traceCollector, 2, signal, foreground);
      }
      this.#setStatus("Running authored state transitions…", "running");
      const states = readiness.stateNames;
      if (states.length < 2) failures.push("fixture-does-not-expose-user-defined-states");
      for (let index = 0; index < counts.stateTransitions && !signal.aborted; index += 1) {
        const target = await nextReadyTarget(activeElement, states, index, signal);
        if (target === null) throw new Error("no authored state route became ready");
        await activeElement.setState(target);
        transitionsCompleted += 1;
        drainRuntimeTrace(activeElement, traceCollector);
      }
      this.#setStatus("Settling rapid authored inputs…", "running");
      const rapid: Promise<void>[] = [];
      for (let index = 0; index < counts.rapidInputs; index += 1) {
        const available = states.filter((state) => activeElement.readyFor(state));
        const target = available[(index * 17 + 3) % available.length] ?? activeElement.requestedState;
        if (target === null) throw new Error("rapid input has no accepted public target");
        rapid.push(activeElement.setState(target));
      }
      const outcomes = await Promise.allSettled(rapid);
      rapidInputsSettled = outcomes.length;
      drainRuntimeTrace(activeElement, traceCollector);
      activeElement.pause();
      await activeElement.resume();
      resourceLedger.append("after-public-operations", activeElement.getDiagnostics({ trace: true }));
      this.#setStatus("Running visibility stress…", "running");
      visibility = await runVisibilityStress(activeElement, this.#stage, config.mode === "named" ? 100 : 2);
      if (visibility.status === "failed") failures.push(...visibility.failures);
      drainRuntimeTrace(activeElement, traceCollector);
      const primaryTerminal = await retirePublicMotion(activeElement);
      resourceLedger.append("primary-terminal", primaryTerminal);
      element = null;
      this.#setStatus("Running lifecycle stress…", "running");
      const alternate = alternateSource(config.sourceUrl);
      lifecycle = await runLifecycleStress({
        parent: this.#stage,
        sourceUrl: config.sourceUrl,
        sourceIntegrity,
        alternateSourceUrl: alternate,
        alternateSourceIntegrity: sourceIntegrity,
        cycles: counts.lifecycleCycles,
        signal
      });
      if (lifecycle.status === "failed") failures.push(...lifecycle.failures);
      this.#setStatus("Running bounded resource soak…", "running");
      soak = await runResourceSoak({
        parent: this.#stage,
        sourceUrl: config.sourceUrl,
        sourceIntegrity,
        durationMs: counts.soakDurationMs,
        players: counts.soakPlayers,
        sampleIntervalMs: config.mode === "named" ? 1_000 : 50,
        signal
      });
      if (soak.status === "failed") failures.push(...soak.failures);
    } catch (error) {
      if (!signal.aborted) failures.push(error instanceof Error ? error.message : "unknown harness failure");
    } finally {
      if (element !== null) {
        const terminal = await retirePublicMotion(element).catch((error: unknown) => {
          failures.push(error instanceof Error ? error.message : "terminal element cleanup failed");
          return null;
        });
        if (terminal !== null) resourceLedger.append("terminal", terminal);
      }
    }
    foreground.stop();
    const diagnostics = readiness;
    const trace = traceCollector.snapshot();
    if (trace.coverage.traceGaps !== 0) failures.push("runtime-trace-gap");
    if (trace.coverage.underflows !== 0) failures.push("runtime-format-underflow");
    if (trace.coverage.wrongContentIdentities !== 0) failures.push("runtime-content-identity");
    const interruptions = foreground.snapshot();
    const interrupted = signal.aborted || interruptions.length > 0 || lifecycle.status === "inconclusive" || soak.status === "inconclusive";
    const status: HarnessStatus = interrupted
      ? "inconclusive"
      : failures.length === 0 ? "passed" : "failed";
    const report: PublicHarnessReport = Object.freeze({
      schemaVersion: "1.0",
      reportKind: "public-path-functional-harness",
      evidenceClass: config.mode === "named" ? "named-browser-runtime-input" : "playwright-functional-engine",
      status,
      runId: config.runId,
      candidateManifestDigest: config.candidateManifestDigest,
      fixtureDigest: config.fixtureDigest,
      harnessDigest: config.harnessDigest,
      commit: config.commit,
      tree: config.tree,
      startedAt,
      endedAt: new Date().toISOString(),
      source,
      capabilities: browserCapabilities(),
      publicElement: Object.freeze({
        readiness: diagnostics?.readiness ?? "unready",
        mode: diagnostics?.mode ?? null,
        assurance: diagnostics?.assurance ?? null,
        states: Object.freeze([...(diagnostics?.stateNames ?? [])]),
        events: Object.freeze([...(diagnostics?.eventNames ?? [])]),
        bindings: diagnostics?.inputBindings.length ?? 0,
        transitionsRequested: counts.stateTransitions,
        transitionsCompleted,
        rapidInputsRequested: counts.rapidInputs,
        rapidInputsSettled,
        routeEvents: routeLedger.snapshot().length,
        exactContentIdentityAvailable: trace.frames.length > 0 && trace.coverage.wrongContentIdentities === 0
      }),
      ledgers: Object.freeze({
        frameEntries: trace.frames.length,
        resourceSnapshots: resourceLedger.snapshot().length,
        routeEntries: routeLedger.snapshot().length
      }),
      runtimeTrace: trace,
      measurementInterruptions: interruptions,
      lifecycle,
      visibility,
      soak,
      timingCriteria: Object.freeze({
        status: interrupted ? "inconclusive" : selectedRendition === null ? "unsupported" : failures.length === 0 ? "collected" : "failed",
        reason: interrupted
          ? "measurement-interrupted"
          : selectedRendition === null
            ? "animated-production-rendition-unavailable"
            : failures.length === 0 ? "raw-evidence-collected-for-independent-validator" : "runtime-or-throughput-collection-failed",
        callbackTimestampsRelabeledAsDisplayEvidence: false,
        observedDisplayEvidence: false
      }),
      failures: Object.freeze(failures)
    });
    await this.#recordReport(report);
    this.#abortController = null;
    return report;
  }

  public async runResourceFaultProfile(
    options: Readonly<{ full?: boolean }> = {}
  ): Promise<ResourceFaultHarnessReport> {
    await this.ready;
    const config = requireConfig(this.#config);
    if (this.#abortController !== null) throw new Error("a certification run is already active");
    this.#abortController = new AbortController();
    const signal = this.#abortController.signal;
    const sourceIntegrity = externalIntegrityFromSha256(config.fixtureDigest);
    const full = options.full === true || config.mode === "named";
    const lifecycle = await runLifecycleStress({
      parent: this.#stage,
      sourceUrl: config.sourceUrl,
      sourceIntegrity,
      alternateSourceUrl: alternateSource(config.sourceUrl),
      alternateSourceIntegrity: sourceIntegrity,
      cycles: full ? 100 : 3,
      signal
    });
    const scenarios = full
      ? LOCAL_NETWORK_FAULTS
      : (["fatal-boundary-network"] as const);
    const environmentIdentity = await deriveBrowserEnvironmentIdentity(config.environment);
    const network = signal.aborted
      ? Object.freeze([])
      : await runNetworkFaultStress({
          parent: this.#stage,
          scenarios,
          timeoutMs: full ? 20_000 : 8_000,
          candidateManifestDigest: config.candidateManifestDigest,
          fixtureDigest: config.fixtureDigest,
          harnessDigest: config.harnessDigest,
          runId: config.runId,
          profileId: environmentIdentity.profileId,
          environmentDigest: environmentIdentity.environmentDigest
        });
    const failures = [
      ...(lifecycle.status === "failed" ? lifecycle.failures : []),
      ...network.filter(({ status }) => status === "failed").map(({ scenario }) => `network-fault-${scenario}`)
    ];
    const report: ResourceFaultHarnessReport = Object.freeze({
      status: signal.aborted || lifecycle.status === "inconclusive" || network.some(({ status }) => status === "inconclusive")
        ? "inconclusive"
        : failures.length === 0 ? "passed" : "failed",
      lifecycle,
      network,
      failures: Object.freeze(failures)
    });
    await this.#recordReport(report);
    this.#abortController = null;
    return report;
  }

  public async exportLastReport(): Promise<CertificationExport> {
    if (this.#lastReport === null) throw new Error("no certification report is available");
    const exported = await createReportExport(this.#lastReport);
    this.#lastExport = exported;
    return exported;
  }

  async #initialize(): Promise<void> {
    defineAvalElement();
    this.#config = await loadRunConfig();
    this.#banner.textContent = this.#config.mode === "named"
      ? "Named browser runtime certification input — visible foreground required"
      : "Playwright functional engine run — not branded-browser or observed-display certification";
    this.#banner.dataset.mode = this.#config.mode;
    this.#bindControls();
    this.#setStatus("Harness ready. No certification result has been produced.", "ready");
  }

  #bindControls(): void {
    this.#root.querySelector<HTMLButtonElement>("[data-action='run']")?.addEventListener("click", () => {
      void this.runPublicHarness().catch((error: unknown) => this.#fatal(error));
    });
    this.#root.querySelector<HTMLButtonElement>("[data-action='faults']")?.addEventListener("click", () => {
      void this.runResourceFaultProfile().catch((error: unknown) => this.#fatal(error));
    });
    this.#root.querySelector<HTMLButtonElement>("[data-action='abort']")?.addEventListener("click", () => this.abort());
    this.#root.querySelector<HTMLButtonElement>("[data-action='export']")?.addEventListener("click", () => {
      void this.exportLastReport().then((result) => offerReportDownload(result, "aval-certification-report.json")).catch((error: unknown) => this.#fatal(error));
    });
  }

  async #recordReport(report: PublicHarnessReport | ResourceFaultHarnessReport): Promise<void> {
    this.#lastReport = report;
    this.#lastExport = await createReportExport(report);
    this.#report.textContent = this.#lastExport.canonicalJson;
    this.#setStatus(`Run ${report.status}; report SHA-256 ${this.#lastExport.sha256}.`, report.status);
  }

  #fatal(error: unknown): void {
    this.#setStatus(error instanceof Error ? error.message : "unknown harness failure", "failed");
    this.#abortController = null;
  }

  #setStatus(message: string, status: string): void {
    this.#status.textContent = message;
    this.#status.dataset.status = status;
  }
}

function runCounts(config: CertificationRunConfig, options: HarnessRunOptions): Readonly<{
  stateTransitions: number;
  rapidInputs: number;
  lifecycleCycles: number;
  soakDurationMs: number;
  soakPlayers: number;
}> {
  const named = config.mode === "named";
  return Object.freeze({
    stateTransitions: bounded(options.stateTransitions ?? (named ? 1_000 : 8), 1, 1_000, "state transitions"),
    rapidInputs: bounded(options.rapidInputs ?? (named ? 1_000 : 32), 1, 10_000, "rapid inputs"),
    lifecycleCycles: bounded(options.lifecycleCycles ?? (named ? 100 : 2), 1, 100, "lifecycle cycles"),
    soakDurationMs: bounded(options.soakDurationMs ?? (named ? 30 * 60 * 1_000 : 100), 0, 30 * 60 * 1_000, "soak duration"),
    soakPlayers: bounded(options.soakPlayers ?? 3, 1, 16, "soak players")
  });
}

function browserCapabilities(): Readonly<Record<string, boolean | number | string>> {
  const canvas = document.createElement("canvas");
  const gl2 = canvas.getContext("webgl2");
  return Object.freeze({
    evidenceClass: "functional-engine",
    secureContext: isSecureContext,
    webCodecsVideoDecoder: "VideoDecoder" in globalThis,
    worker: "Worker" in globalThis,
    webgl2: gl2 !== null,
    contextLossExtension: gl2?.getExtension("WEBGL_lose_context") !== null,
    documentVisible: document.visibilityState === "visible",
    documentFocused: document.hasFocus(),
    devicePixelRatio: devicePixelRatio,
    maximumDecoderLeases: DEFAULT_MAXIMUM_DECODER_LEASES,
    maximumPagePhysicalBytes: DEFAULT_MAXIMUM_PAGE_PHYSICAL_BYTES,
    maximumPlayerLogicalBytes: DEFAULT_MAXIMUM_PLAYER_LOGICAL_BYTES
  });
}

function alternateSource(sourceUrl: string): string {
  const url = new URL(sourceUrl, location.href);
  url.hash = "aval-certification-alternate";
  return `${url.pathname}${url.search}${url.hash}`;
}

function emptyLifecycle(requestedCycles: number): Awaited<ReturnType<typeof runLifecycleStress>> {
  return Object.freeze({
    requestedCycles,
    completedCycles: 0,
    sourceReplacements: 0,
    adoptionCycles: 0,
    status: "inconclusive",
    failures: Object.freeze([]),
    peakCounters: Object.freeze({}),
    terminalCounters: Object.freeze({}),
    routeEvents: 0
  });
}

function emptyVisibility(): Awaited<ReturnType<typeof runVisibilityStress>> {
  return Object.freeze({ status: "unsupported", transitions: 0, failures: Object.freeze([]) });
}

function emptySoak(durationMs: number, playerCount: number): Awaited<ReturnType<typeof runResourceSoak>> {
  return Object.freeze({
    status: "inconclusive",
    requestedDurationMs: durationMs,
    elapsedMs: 0,
    playerCount,
    samples: 0,
    defaultPolicy: Object.freeze({
      maximumDecoderLeases: DEFAULT_MAXIMUM_DECODER_LEASES,
      maximumPagePhysicalBytes: DEFAULT_MAXIMUM_PAGE_PHYSICAL_BYTES,
      maximumPlayerLogicalBytes: DEFAULT_MAXIMUM_PLAYER_LOGICAL_BYTES
    }),
    peakCounters: Object.freeze({}),
    terminalCounters: Object.freeze([]),
    failures: Object.freeze([])
  });
}

function bounded(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${name} must be in ${String(minimum)}..${String(maximum)}`);
  return value;
}

function drainRuntimeTrace(element: AvalElement, collector: PublicRuntimeTraceCollector): void {
  const records = element.getDiagnostics({ trace: true }).runtimeTrace ?? [];
  collector.drain(records as unknown as readonly Readonly<Record<string, unknown>>[]);
}

function primeRuntimeTrace(element: AvalElement, collector: PublicRuntimeTraceCollector): void {
  const records = element.getDiagnostics({ trace: true }).runtimeTrace ?? [];
  collector.prime(records as unknown as readonly Readonly<Record<string, unknown>>[]);
}

async function waitForTraceFrames(
  element: AvalElement,
  collector: PublicRuntimeTraceCollector,
  minimumFrames: number,
  signal: AbortSignal,
  foreground: ForegroundMeasurementGuard
): Promise<void> {
  const timeoutMs = minimumFrames >= 1_000 ? 20 * 60 * 1_000 : 20_000;
  const deadline = performance.now() + timeoutMs;
  while (collector.snapshot().coverage.frameCount < minimumFrames) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("trace collection aborted", "AbortError");
    foreground.assertActive();
    if (performance.now() >= deadline) {
      const diagnostics = element.getDiagnostics({ trace: true });
      const records = diagnostics.runtimeTrace ?? [];
      const last = records.at(-1);
      throw new Error([
        `runtime trace did not reach ${String(minimumFrames)} frames`,
        `readiness=${diagnostics.readiness}`,
        `paused=${String(diagnostics.paused)}`,
        `records=${String(records.length)}`,
        `last=${last?.kind ?? "none"}`,
        `lastGraph=${String(last?.graph !== null)}`,
        `lastMedia=${last?.media?.kind ?? "none"}`,
        `lastSubmission=${last?.canvasSubmissionCompleteMicroseconds === null ? "none" : "present"}`,
        `scheduler=${last === undefined ? "none" : JSON.stringify(last.scheduler)}`,
        `runtimeUnderflows=${String(diagnostics.counters.underflow)}`,
        `failure=${diagnostics.lastFailure?.code ?? "none"}`
      ].join(";"));
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    drainRuntimeTrace(element, collector);
  }
}

async function waitForTraceCoverage(
  element: AvalElement,
  collector: PublicRuntimeTraceCollector,
  predicate: (coverage: RuntimeTraceCollection["coverage"]) => boolean,
  description: string,
  timeoutMs: number,
  signal: AbortSignal,
  foreground: ForegroundMeasurementGuard
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate(collector.snapshot().coverage)) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("trace collection aborted", "AbortError");
    foreground.assertActive();
    if (performance.now() >= deadline) throw new Error(`runtime trace did not reach ${description}`);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    drainRuntimeTrace(element, collector);
  }
}

async function nextReadyTarget(
  element: AvalElement,
  states: readonly string[],
  sequence: number,
  signal: AbortSignal
): Promise<string | null> {
  const deadline = performance.now() + 5_000;
  while (!signal.aborted && performance.now() < deadline) {
    const available = states.filter((state) => state !== element.requestedState && element.readyFor(state));
    const selected = available[sequence % available.length];
    if (selected !== undefined) return selected;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return null;
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (element === null) throw new Error(`certification UI is missing ${selector}`);
  return element;
}

function requireConfig(config: CertificationRunConfig | null): CertificationRunConfig {
  if (config === null) throw new Error("certification run config is unavailable");
  return config;
}
