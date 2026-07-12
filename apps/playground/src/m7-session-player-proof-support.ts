import {
  createAvcRenditionCandidates,
  type BrowserAvcCandidateComposition,
  type BrowserAvcCleanupSnapshot,
  type BrowserPresentationPlanes,
  type BrowserPresentationPlanesSnapshot,
  type IntegratedCandidateAttempt,
  type IntegratedCandidateFactory,
  type IntegratedPlayer,
  type IntegratedPlayerContextSnapshot,
  type PageDecoderLeases,
  type PageResourceManager,
  type PlayerResourceAccount,
  type RuntimeAssetSession,
  type RuntimeAssetSessionSnapshot,
  type RuntimePageResourceSnapshot,
  type RuntimeVisibilitySnapshot,
  type StaticSurfaceStore,
  type StaticSurfaceStoreSnapshot
} from "@rendered-motion/player-web";

export interface M7SessionPlayerProofInput {
  readonly assetUrl: string;
  readonly metricsUrl: string;
}

export interface M7SessionPlayerCapabilityReport {
  readonly webCodecs: boolean;
  readonly moduleWorker: boolean;
  readonly webgl2: boolean;
  readonly staticPng: boolean;
  readonly candidates: readonly Readonly<{
    readonly id: string;
    readonly codedWidth: number;
    readonly codedHeight: number;
    readonly exactConfigSupported: boolean;
    readonly reason: string | null;
  }>[];
}

export interface M7RealtimeSummary {
  readonly running: boolean;
  readonly disposed: boolean;
  readonly nextPresentationOrdinal: string;
  readonly nextDeadlineMs: number | null;
  readonly displayCallbacks: number;
  readonly advancedTicks: number;
  readonly underflows: number;
  readonly smoothSession: boolean;
}

export interface M7VisibilitySummary {
  readonly generation: number;
  readonly visibility: "visible" | "hidden";
  readonly suspension: "active" | "suspending" | "suspended";
  readonly frozenPresentationOrdinal: string | null;
  readonly rebuildPending: boolean;
}

export interface M7PageResourceSummary {
  readonly physicalBytes: number;
  readonly byteLeases: number;
  readonly participants: number;
  readonly decoderLeases: number;
  readonly decoderQueue: number;
  readonly pendingReclamations: number;
  readonly categories: Readonly<Record<string, number>>;
}

export interface M7HttpTerminalSummary {
  readonly activeResponses: number;
  readonly completedResponses: number;
  readonly cancelledResponses: number;
}

export interface M7CandidateEvent {
  readonly sequence: number;
  readonly kind:
    | "create"
    | "draw-initial"
    | "draw-content"
    | "dispose-start"
    | "dispose-end";
  readonly candidateId: string;
  readonly rendition: string;
  readonly presentation: string | null;
}

export interface M7CandidateInstrumentation {
  readonly factory: IntegratedCandidateFactory;
  readonly events: readonly Readonly<M7CandidateEvent>[];
}

export interface M7PlaneVisibilityEvent {
  readonly sequence: number;
  readonly phase: string;
  readonly visible: boolean;
  readonly nonTransparentPixels: number;
}

export interface MountedPlanes {
  readonly host: HTMLDivElement;
  readonly animatedCanvas: HTMLCanvasElement;
  readonly staticCanvas: HTMLCanvasElement;
  readonly events: readonly Readonly<M7PlaneVisibilityEvent>[];
  readonly staticVisible: boolean;
  setPhase(phase: string): void;
  setStaticVisible(visible: boolean): void;
  staticNonTransparentPixels(): number;
  dispose(): void;
}

export interface M7SessionPlayerTerminalReport {
  readonly session: Readonly<RuntimeAssetSessionSnapshot>;
  readonly beforeAccountDispose: Readonly<M7PageResourceSummary>;
  readonly page: Readonly<M7PageResourceSummary>;
  readonly candidate: Readonly<BrowserAvcCleanupSnapshot> | null;
  readonly planes: Readonly<BrowserPresentationPlanesSnapshot> | null;
  readonly store: Readonly<StaticSurfaceStoreSnapshot> | null;
  readonly context: Readonly<IntegratedPlayerContextSnapshot> | null;
  readonly http: Readonly<M7HttpTerminalSummary>;
  readonly connected: false;
}

export interface M7SessionPlayerUnsupportedReport {
  readonly status: "unsupported";
  readonly reason: string;
  readonly capabilities: Readonly<M7SessionPlayerCapabilityReport>;
  readonly terminal: Readonly<M7SessionPlayerTerminalReport>;
}

export interface M7SessionPlayerSupportedReport {
  readonly status: "supported";
  readonly capabilities: Readonly<M7SessionPlayerCapabilityReport>;
  readonly preparation: Readonly<{
    readonly mode: "animated";
    readonly selectedRendition: string;
    readonly session: Readonly<RuntimeAssetSessionSnapshot>;
    readonly page: Readonly<M7PageResourceSummary>;
    readonly initialPresentation: string;
    readonly currentPresentation: string;
    readonly introDraws: number;
  }>;
  readonly visibility: Readonly<{
    readonly before: Readonly<M7RealtimeSummary>;
    readonly hidden: Readonly<M7RealtimeSummary>;
    readonly afterWallTime: Readonly<M7RealtimeSummary>;
    readonly afterResume: Readonly<M7RealtimeSummary>;
    readonly afterNextFrame: Readonly<M7RealtimeSummary>;
    readonly suspension: Readonly<M7VisibilitySummary>;
    readonly resumed: Readonly<M7VisibilitySummary>;
    readonly hiddenPage: Readonly<M7PageResourceSummary>;
    readonly resumedPage: Readonly<M7PageResourceSummary>;
    readonly hiddenCandidate: Readonly<BrowserAvcCleanupSnapshot>;
    readonly resumedPresentation: string;
    readonly nextPresentation: string;
    readonly staticVisible: true;
    readonly staticNonTransparentPixels: number;
    readonly coverBeforeCandidateCleanup: true;
    readonly introDraws: number;
  }>;
  readonly contextRecovery: Readonly<{
    readonly defaultPrevented: true;
    readonly staticCoveredSynchronously: true;
    readonly staticNonTransparentPixels: number;
    readonly immediate: Readonly<IntegratedPlayerContextSnapshot>;
    readonly lost: Readonly<IntegratedPlayerContextSnapshot>;
    readonly restored: Readonly<IntegratedPlayerContextSnapshot>;
    readonly before: Readonly<M7RealtimeSummary>;
    readonly lostRealtime: Readonly<M7RealtimeSummary>;
    readonly afterWallTime: Readonly<M7RealtimeSummary>;
    readonly afterRestore: Readonly<M7RealtimeSummary>;
    readonly afterNextFrame: Readonly<M7RealtimeSummary>;
    readonly lostPage: Readonly<M7PageResourceSummary>;
    readonly restoredPage: Readonly<M7PageResourceSummary>;
    readonly lostCandidate: Readonly<BrowserAvcCleanupSnapshot>;
    readonly restoredPresentation: string;
    readonly nextPresentation: string;
    readonly coverBeforeCandidateCleanup: true;
    readonly introDraws: number;
  }>;
  readonly candidates: readonly Readonly<M7CandidateEvent>[];
  readonly visibilityEvents: readonly Readonly<M7PlaneVisibilityEvent>[];
  readonly diagnostics: readonly string[];
  readonly terminal: Readonly<M7SessionPlayerTerminalReport>;
}

export type M7SessionPlayerProofReport =
  | M7SessionPlayerUnsupportedReport
  | M7SessionPlayerSupportedReport;

export async function probeCapabilities(
  session: RuntimeAssetSession
): Promise<Readonly<M7SessionPlayerCapabilityReport>> {
  const webCodecs = typeof VideoDecoder !== "undefined";
  const moduleWorker = typeof Worker !== "undefined";
  const webgl2 = probeWebGl2();
  const staticPng = typeof createImageBitmap === "function" &&
    typeof ImageData !== "undefined";
  const candidates = createAvcRenditionCandidates(
    session.catalog.manifest.renditions,
    session.catalog.manifest.canvas
  );
  const results = await Promise.all(candidates.map(async ({ rendition }) => {
    const config: VideoDecoderConfig = {
      codec: "avc1.42E020",
      codedWidth: rendition.codedWidth,
      codedHeight: rendition.codedHeight,
      hardwareAcceleration: "no-preference",
      optimizeForLatency: true
    };
    if (!webCodecs) return Object.freeze({
      id: rendition.id,
      codedWidth: rendition.codedWidth,
      codedHeight: rendition.codedHeight,
      exactConfigSupported: false,
      reason: "VideoDecoder is unavailable"
    });
    try {
      const support = await VideoDecoder.isConfigSupported(config);
      const exact = support.supported === true &&
        exactSupportedConfig(support.config, config);
      return Object.freeze({
        id: rendition.id,
        codedWidth: rendition.codedWidth,
        codedHeight: rendition.codedHeight,
        exactConfigSupported: exact,
        reason: exact ? null : "exact Annex B AVC configuration is unsupported"
      });
    } catch {
      return Object.freeze({
        id: rendition.id,
        codedWidth: rendition.codedWidth,
        codedHeight: rendition.codedHeight,
        exactConfigSupported: false,
        reason: "VideoDecoder capability probe failed"
      });
    }
  }));
  return Object.freeze({
    webCodecs,
    moduleWorker,
    webgl2,
    staticPng,
    candidates: Object.freeze(results)
  });
}

export function capabilityFailure(
  report: Readonly<M7SessionPlayerCapabilityReport>
): string | null {
  if (!report.moduleWorker) return "module Worker is unavailable";
  if (!report.webCodecs) return "VideoDecoder is unavailable";
  if (!report.webgl2) return "WebGL2 is unavailable";
  if (!report.staticPng) return "browser PNG decoding is unavailable";
  return report.candidates.some(({ exactConfigSupported }) => exactConfigSupported)
    ? null
    : "no exact Annex B AVC candidate is supported";
}

function exactSupportedConfig(
  returned: VideoDecoderConfig | undefined,
  expected: VideoDecoderConfig
): boolean {
  if (returned === undefined) return false;
  const extended = returned as VideoDecoderConfig & {
    readonly flip?: boolean;
    readonly rotation?: number;
  };
  const allowedKeys = new Set([
    "codec", "codedWidth", "codedHeight", "hardwareAcceleration",
    "optimizeForLatency", "flip", "rotation"
  ]);
  return Object.keys(returned).every((key) => allowedKeys.has(key)) &&
    returned.codec === expected.codec &&
    returned.codedWidth === expected.codedWidth &&
    returned.codedHeight === expected.codedHeight &&
    returned.hardwareAcceleration === expected.hardwareAcceleration &&
    returned.optimizeForLatency === expected.optimizeForLatency &&
    returned.description === undefined &&
    (extended.flip === undefined || extended.flip === false) &&
    (extended.rotation === undefined || extended.rotation === 0);
}

function probeWebGl2(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: true
    });
    if (context === null) return false;
    context.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch { return false; }
}

export function mountPlanes(
  session: RuntimeAssetSession,
  nextSequence: () => number
): MountedPlanes {
  const canvas = session.catalog.manifest.canvas;
  const host = document.createElement("div");
  Object.assign(host.style, {
    position: "relative",
    width: `${String(canvas.width * 4)}px`,
    height: `${String(canvas.height * 4)}px`,
    overflow: "hidden",
    isolation: "isolate"
  });
  const animatedCanvas = document.createElement("canvas");
  const staticCanvas = document.createElement("canvas");
  for (const plane of [animatedCanvas, staticCanvas]) {
    Object.assign(plane.style, {
      position: "absolute", inset: "0", width: "100%", height: "100%"
    });
    host.append(plane);
  }
  animatedCanvas.style.zIndex = "1";
  staticCanvas.style.zIndex = "2";
  staticCanvas.style.visibility = "hidden";
  document.body.append(host);
  const events: M7PlaneVisibilityEvent[] = [];
  let phase = "setup";
  let visible = false;
  let disposed = false;
  return Object.freeze({
    host,
    animatedCanvas,
    staticCanvas,
    events,
    get staticVisible() { return visible; },
    setPhase(value: string) { phase = value; },
    setStaticVisible(nextVisible: boolean) {
      visible = nextVisible;
      staticCanvas.style.visibility = nextVisible ? "visible" : "hidden";
      events.push(Object.freeze({
        sequence: nextSequence(),
        phase,
        visible: nextVisible,
        nonTransparentPixels: nextVisible
          ? countNonTransparentPixels(staticCanvas)
          : 0
      }));
    },
    staticNonTransparentPixels: () => countNonTransparentPixels(staticCanvas),
    dispose() {
      if (disposed) return;
      disposed = true;
      host.remove();
    }
  });
}

export class ManualAnimationFrames {
  readonly #callbacks = new Map<number, FrameRequestCallback>();
  #nextHandle = 1;
  public now = performance.now();
  public get pending(): number { return this.#callbacks.size; }
  public readonly request = (callback: FrameRequestCallback): number => {
    const handle = this.#nextHandle++;
    this.#callbacks.set(handle, callback);
    return handle;
  };
  public readonly cancel = (handle: number): void => {
    this.#callbacks.delete(handle);
  };
  public elapse(milliseconds: number): void {
    assert(this.#callbacks.size === 0,
      "logical wall-time gap still owned an animation callback");
    this.now += milliseconds;
  }
  public run(timestamp: number): void {
    assert(this.#callbacks.size === 1,
      `expected one animation callback, observed ${String(this.#callbacks.size)}`);
    const entry = this.#callbacks.entries().next().value as
      [number, FrameRequestCallback] | undefined;
    assert(entry !== undefined, "animation callback disappeared");
    this.#callbacks.delete(entry[0]);
    this.now = timestamp;
    entry[1](timestamp);
  }
}

export async function advanceUntilPresentation(
  player: IntegratedPlayer,
  composition: Readonly<BrowserAvcCandidateComposition>,
  frames: ManualAnimationFrames,
  events: readonly Readonly<M7CandidateEvent>[],
  expected: string
): Promise<void> {
  for (let attempt = 0; attempt < 48; attempt += 1) {
    if (latestDraw(events) === expected) return;
    await advanceOne(player, composition, frames);
  }
  throw new Error(`M7 realtime did not reach ${expected}`);
}

export async function advanceOne(
  player: IntegratedPlayer,
  composition: Readonly<BrowserAvcCandidateComposition>,
  frames: ManualAnimationFrames
): Promise<void> {
  await composition.controls.settled();
  const snapshot = player.realtimeSnapshot();
  assert(snapshot !== null, "realtime snapshot is unavailable");
  assert(snapshot.running, "realtime owner is not running");
  assert(snapshot.nextDeadlineMs !== null, "realtime deadline is unavailable");
  assert(frames.pending === 1, "realtime owner lost its sole callback");
  frames.run(snapshot.nextDeadlineMs + 0.001);
  await composition.controls.settled();
}

export async function settleTerminal(input: Readonly<{
  manager: PageResourceManager;
  decoders: PageDecoderLeases;
  account: PlayerResourceAccount;
  session: RuntimeAssetSession;
  mounted: MountedPlanes | null;
  planes: BrowserPresentationPlanes | null;
  composition: Readonly<BrowserAvcCandidateComposition> | null;
  store: StaticSurfaceStore | null;
  player: IntegratedPlayer | null;
  metricsUrl: string;
}>): Promise<Readonly<M7SessionPlayerTerminalReport>> {
  if (input.player === null) await input.session.dispose();
  else await input.player.dispose();
  await input.composition?.controls.settled();
  const store = input.store?.snapshot() ?? null;
  const context = input.player?.contextSnapshot() ?? null;
  input.planes?.dispose();
  const planes = input.planes?.snapshot() ?? null;
  const candidate = input.composition?.controls.snapshot().cleanup ?? null;
  input.decoders.dispose();
  const beforeAccountDispose = pageSummary(input.manager.snapshot());
  input.account.dispose();
  input.mounted?.dispose();
  const page = pageSummary(input.manager.snapshot());
  const session = input.session.snapshot();
  const http = await httpTerminal(input.metricsUrl);
  return Object.freeze({
    session, beforeAccountDispose, page, candidate, planes, store, context,
    http, connected: false as const
  });
}

export function assertTerminal(
  report: Readonly<M7SessionPlayerTerminalReport>
): void {
  assert(report.session.disposed && report.session.metadataBytes === 0 &&
    report.session.verifiedPayloadBytes === 0 &&
    report.session.activeTransportBodies === 0 &&
    report.session.pendingLoads === 0 && report.session.interestedWaiters === 0,
  "session retained bytes or async owners");
  assert(report.beforeAccountDispose.physicalBytes === 0 &&
    report.beforeAccountDispose.byteLeases === 0 &&
    report.beforeAccountDispose.decoderLeases === 0 &&
    report.beforeAccountDispose.decoderQueue === 0,
  "runtime owners relied on account disposal to clear resources");
  assert(report.page.physicalBytes === 0 && report.page.byteLeases === 0 &&
    report.page.participants === 0 && report.page.decoderLeases === 0 &&
    report.page.decoderQueue === 0 && report.page.pendingReclamations === 0,
  "page authority did not settle to zero");
  assert(report.candidate?.complete !== false && (report.candidate === null || (
    report.candidate.workersAlive === 0 && report.candidate.openFrames === 0 &&
    report.candidate.renderersAlive === 0 &&
    report.candidate.glResourceCount === 0 &&
    report.candidate.rendererStagingBytes === 0 &&
    report.candidate.sourceCopiesInFlight === 0 &&
    report.candidate.pendingOperations === 0
  )), "candidate terminal counters were nonzero");
  assert(report.planes === null || (!report.planes.backendAttached &&
    report.planes.contextListeners === 0 &&
    report.planes.resourceReservations === 0 &&
    report.planes.liveResourceTotals.length === 0 &&
    report.planes.geometry === null),
  "presentation planes retained resources or listeners");
  assert(report.store === null || (report.store.state === "disposed" &&
    report.store.retainedSurfaces === 0 &&
    report.store.retainedRgbaBytes === 0),
  "static store retained decoded surfaces");
  assert(report.context === null || (report.context.state === "disposed" &&
    report.context.listenerCount === 0 &&
    report.context.pendingOperations === 0),
  "context owner retained listeners or operations");
  assert(report.http.activeResponses === 0,
    "HTTP fixture retained an active response");
}

async function httpTerminal(
  metricsUrl: string
): Promise<Readonly<M7HttpTerminalSummary>> {
  const response = await fetch(metricsUrl, { cache: "no-store" });
  if (!response.ok) throw new Error("M7 metrics endpoint rejected the proof");
  const value = await response.json() as Partial<M7HttpTerminalSummary>;
  return Object.freeze({
    activeResponses: requireCounter(value.activeResponses, "active responses"),
    completedResponses: requireCounter(
      value.completedResponses, "completed responses"
    ),
    cancelledResponses: requireCounter(
      value.cancelledResponses, "cancelled responses"
    )
  });
}

export function realtimeSummary(
  player: IntegratedPlayer
): Readonly<M7RealtimeSummary> {
  const snapshot = player.realtimeSnapshot();
  assert(snapshot !== null, "realtime snapshot is unavailable");
  return Object.freeze({
    running: snapshot.running,
    disposed: snapshot.disposed,
    nextPresentationOrdinal: snapshot.nextPresentationOrdinal.toString(),
    nextDeadlineMs: snapshot.nextDeadlineMs,
    displayCallbacks: snapshot.displayCallbacks,
    advancedTicks: snapshot.advancedTicks,
    underflows: snapshot.underflows,
    smoothSession: snapshot.smoothSession
  });
}

export function visibilitySummary(
  snapshot: Readonly<RuntimeVisibilitySnapshot>
): Readonly<M7VisibilitySummary> {
  return Object.freeze({
    generation: snapshot.generation,
    visibility: snapshot.visibility,
    suspension: snapshot.suspension,
    frozenPresentationOrdinal:
      snapshot.frozenPresentationOrdinal?.toString() ?? null,
    rebuildPending: snapshot.rebuildPending
  });
}

export function pageSummary(
  snapshot: Readonly<RuntimePageResourceSnapshot>
): Readonly<M7PageResourceSummary> {
  return Object.freeze({
    physicalBytes: snapshot.physicalBytes,
    byteLeases: snapshot.byteLeaseCount,
    participants: snapshot.participants.length,
    decoderLeases: snapshot.decoderLeaseCount,
    decoderQueue: snapshot.decoderQueueLength,
    pendingReclamations: snapshot.pendingReclamations,
    categories: Object.freeze(Object.fromEntries(
      snapshot.categories.map(({ category, bytes }) => [category, bytes])
    ))
  });
}

export function candidateCategoriesAreZero(
  page: Readonly<M7PageResourceSummary>
): boolean {
  return [
    "worker-transfer", "decoder-output", "persistent-animation",
    "streaming-texture", "frame-staging"
  ].every((category) => page.categories[category] === 0);
}

export function requireContext(
  player: IntegratedPlayer
): IntegratedPlayerContextSnapshot {
  const snapshot = player.contextSnapshot();
  assert(snapshot !== null, "integrated context owner is unavailable");
  return snapshot;
}

export function presentationLabel(
  presentation: Parameters<IntegratedCandidateAttempt["drawInitial"]>[1]
): string {
  return presentation.kind === "static"
    ? `static:${presentation.state}`
    : `${presentation.unitId}:${String(presentation.frameIndex)}`;
}

export function instrumentCandidateFactory(
  factory: IntegratedCandidateFactory,
  nextSequence: () => number
): Readonly<M7CandidateInstrumentation> {
  const events: M7CandidateEvent[] = [];
  let nextCandidate = 0;
  const wrapped: IntegratedCandidateFactory = {
    availability: factory.availability,
    ...(factory.resourceHost === undefined
      ? {}
      : { resourceHost: factory.resourceHost }),
    ...(factory.contextTarget === undefined
      ? {}
      : { contextTarget: factory.contextTarget }),
    create(context) {
      const candidateId = `candidate-${String(++nextCandidate)}`;
      const rendition = context.candidate.rendition.id;
      record("create", candidateId, rendition, null);
      const attempt = factory.create(context);
      const playback = attempt.playback;
      let disposalStarted = false;
      const instrumentedPlayback: IntegratedCandidateAttempt["playback"] = {
        prepareContentTick: (tickContext) =>
          playback.prepareContentTick(tickContext),
        drawContentTick: (prepared, presentation) => {
          const tag = playback.drawContentTick(prepared, presentation);
          record(
            "draw-content", candidateId, rendition,
            presentationLabel(presentation)
          );
          return tag;
        },
        synchronizeGraph: (result) => playback.synchronizeGraph(result),
        traceState: () => playback.traceState()
      };
      return Object.freeze({
        playback: Object.freeze(instrumentedPlayback),
        prepare: (options) => attempt.prepare(options),
        prepareActivation: (options) => attempt.prepareActivation(options),
        drawInitial: (activation, presentation) => {
          attempt.drawInitial(activation, presentation);
          record(
            "draw-initial", candidateId, rendition,
            presentationLabel(presentation)
          );
        },
        dispose: async () => {
          if (!disposalStarted) {
            disposalStarted = true;
            record("dispose-start", candidateId, rendition, null);
          }
          try { await attempt.dispose(); } finally {
            record("dispose-end", candidateId, rendition, null);
          }
        }
      } satisfies IntegratedCandidateAttempt);
    }
  };
  return Object.freeze({ factory: Object.freeze(wrapped), events });

  function record(
    kind: M7CandidateEvent["kind"],
    candidateId: string,
    rendition: string,
    presentation: string | null
  ): void {
    events.push(Object.freeze({
      sequence: nextSequence(), kind, candidateId, rendition, presentation
    }));
  }
}

export function firstDraw(events: readonly Readonly<M7CandidateEvent>[]): string {
  const event = events.find(({ kind }) =>
    kind === "draw-initial" || kind === "draw-content"
  );
  return requireString(event?.presentation ?? null, "first draw");
}

export function firstDrawAfter(
  events: readonly Readonly<M7CandidateEvent>[],
  offset: number
): string {
  const event = events.slice(offset).find(({ kind }) =>
    kind === "draw-initial" || kind === "draw-content"
  );
  return requireString(event?.presentation ?? null, "fresh candidate draw");
}

export function latestDraw(
  events: readonly Readonly<M7CandidateEvent>[]
): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind === "draw-initial" || event.kind === "draw-content") {
      return requireString(event.presentation, "latest draw");
    }
  }
  throw new Error("M7 proof has no candidate draw");
}

export function countPresentation(
  events: readonly Readonly<M7CandidateEvent>[], presentation: string
): number {
  return events.filter((event) => event.presentation === presentation).length;
}

export function findVisibilityEvent(
  events: readonly Readonly<M7PlaneVisibilityEvent>[],
  phase: string,
  visible: boolean,
  afterSequence: number
): Readonly<M7PlaneVisibilityEvent> {
  const event = events.find((entry) => entry.sequence > afterSequence &&
    entry.phase === phase && entry.visible === visible);
  if (event === undefined) throw new Error(`M7 proof has no ${phase} cover`);
  return event;
}

export function findCandidateEvent(
  events: readonly Readonly<M7CandidateEvent>[],
  kind: M7CandidateEvent["kind"],
  afterSequence: number
): Readonly<M7CandidateEvent> {
  const event = events.find((entry) =>
    entry.sequence > afterSequence && entry.kind === kind
  );
  if (event === undefined) throw new Error(`M7 proof has no ${kind} event`);
  return event;
}

export function countNonTransparentPixels(canvas: HTMLCanvasElement): number {
  if (canvas.width === 0 || canvas.height === 0) return 0;
  const context = canvas.getContext("2d", { alpha: true });
  if (context === null) return 0;
  const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let count = 0;
  for (let offset = 3; offset < rgba.length; offset += 4) {
    if (rgba[offset]! > 0) count += 1;
  }
  return count;
}

export function validateInput(input: Readonly<M7SessionPlayerProofInput>): void {
  if (input === null || typeof input !== "object" ||
    typeof input.assetUrl !== "string" || input.assetUrl.length === 0 ||
    typeof input.metricsUrl !== "string" || input.metricsUrl.length === 0) {
    throw new TypeError("M7 session player proof input is invalid");
  }
}

export function requireString(value: string | null, label: string): string {
  if (value === null || value.length === 0) {
    throw new Error(`M7 proof has no ${label}`);
  }
  return value;
}

function requireCounter(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`M7 ${label} counter is invalid`);
  }
  return value as number;
}

export function assert(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new Error(`M7 session player proof: ${message}`);
}
