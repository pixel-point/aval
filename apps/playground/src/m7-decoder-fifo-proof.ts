import {
  BrowserPresentationPlanes,
  BrowserStaticSurfaceDecoder,
  IntegratedPlayer,
  PlayerWebPageRuntime,
  StaticSurfaceStore,
  asStaticSurfaceCatalog,
  createBrowserAvcCandidateComposition,
  createRuntimePageResourcePolicy,
  type BrowserAvcCandidateComposition,
  type BrowserAvcCleanupSnapshot,
  type BrowserPresentationPlanesSnapshot,
  type IntegratedPlayerContextSnapshot,
  type IntegratedPrepareResult,
  type PlayerWebRuntimeParticipant,
  type PlayerWebRuntimeParticipantSnapshot,
  type RuntimeAssetSession,
  type RuntimeAssetSessionSnapshot,
  type StaticSurfaceStoreSnapshot
} from "@rendered-motion/player-web";
import {
  ManualAnimationFrames,
  assert,
  capabilityFailure,
  countNonTransparentPixels,
  firstDrawAfter,
  instrumentCandidateFactory,
  mountPlanes,
  pageSummary,
  probeCapabilities,
  type M7CandidateInstrumentation,
  type M7PageResourceSummary,
  type M7SessionPlayerCapabilityReport,
  type MountedPlanes
} from "./m7-session-player-proof-support.js";

export interface M7DecoderFifoProofInput {
  readonly players: readonly Readonly<{
    readonly assetUrl: string;
    readonly metricsUrl: string;
  }>[];
}

interface M7FifoPlayerSummary {
  readonly mode: "animated" | "static";
  readonly reason: string | null;
  readonly readiness: string;
  readonly selectedRendition: string | null;
  readonly workerAlive: boolean;
  readonly decoderConfigureCalls: number;
  readonly decoderOutputFrames: number;
  readonly rendererAlive: boolean;
  readonly glResourceCount: number;
  readonly staticVisible: boolean;
  readonly staticNonTransparentPixels: number;
  readonly decoderPending: boolean;
  readonly candidateCreates: number;
}

interface M7FifoTerminalPlayer {
  readonly session: Readonly<RuntimeAssetSessionSnapshot>;
  readonly account: Readonly<{
    readonly disposed: boolean;
    readonly activeLeases: number;
    readonly participantAttached: boolean;
    readonly lifecycleState: string;
    readonly registeredCleanups: number;
    readonly trackedWork: number;
    readonly pendingWaits: number;
  }>;
  readonly candidate: Readonly<BrowserAvcCleanupSnapshot>;
  readonly planes: Readonly<BrowserPresentationPlanesSnapshot>;
  readonly store: Readonly<StaticSurfaceStoreSnapshot> | null;
  readonly context: Readonly<IntegratedPlayerContextSnapshot> | null;
  readonly httpActiveResponses: number;
  readonly connected: false;
}

export type M7DecoderFifoProof =
  | Readonly<{
      readonly status: "unsupported";
      readonly reason: string;
      readonly capabilities: Readonly<M7SessionPlayerCapabilityReport>;
      readonly terminal: readonly Readonly<M7FifoTerminalPlayer>[];
      readonly page: Readonly<M7PageResourceSummary>;
    }>
  | Readonly<{
      readonly status: "supported";
      readonly capabilities: Readonly<M7SessionPlayerCapabilityReport>;
      readonly limit: 2;
      readonly initial: Readonly<{
        readonly players: readonly Readonly<M7FifoPlayerSummary>[];
        readonly page: Readonly<M7PageResourceSummary>;
        readonly decoderQueue: number;
        readonly thirdTicketRetained: true;
      }>;
      readonly promotion: Readonly<{
        readonly hiddenPlayer: number;
        readonly hiddenReadiness: string;
        readonly hiddenStaticVisible: true;
        readonly thirdReadiness: "interactiveReady";
        readonly thirdFirstFreshDraw: "idle-body:0";
        readonly thirdCandidateCreatesBefore: number;
        readonly thirdCandidateCreatesAfter: number;
        readonly thirdWorkerAlive: true;
        readonly thirdDecoderConfigureCalls: number;
        readonly thirdRendererAlive: true;
        readonly thirdGlResourceCount: number;
        readonly page: Readonly<M7PageResourceSummary>;
        readonly decoderQueue: 0;
      }>;
      readonly terminal: readonly Readonly<M7FifoTerminalPlayer>[];
      readonly page: Readonly<M7PageResourceSummary>;
      readonly activeParticipants: 0;
      readonly decoderLeases: 0;
      readonly decoderQueue: 0;
    }>;

interface FifoHarness {
  readonly participant: PlayerWebRuntimeParticipant;
  readonly session: RuntimeAssetSession;
  readonly mounted: MountedPlanes;
  readonly planes: BrowserPresentationPlanes;
  readonly composition: Readonly<BrowserAvcCandidateComposition>;
  readonly instrumentation: Readonly<M7CandidateInstrumentation>;
  readonly player: IntegratedPlayer;
  readonly releaseOwnedPlayer: () => void;
  readonly diagnostics: readonly string[];
  readonly metricsUrl: string;
  readonly store: () => StaticSurfaceStore | null;
}

/** Three real session-backed players exercising FIFO decoder reentry. */
export async function runM7DecoderFifoProof(
  input: Readonly<M7DecoderFifoProofInput>
): Promise<Readonly<M7DecoderFifoProof>> {
  validateInput(input);
  const policy = createRuntimePageResourcePolicy({ maximumDecoderLeases: 2 });
  const pageRuntime = new PlayerWebPageRuntime({ policy });
  const participants = input.players.map(() => pageRuntime.createParticipant({
    visibility: "visible",
    phase: "loading"
  }));
  const sessions: RuntimeAssetSession[] = [];
  const harnesses: FifoHarness[] = [];
  let sequence = 0;
  let terminal: readonly Readonly<M7FifoTerminalPlayer>[] | null = null;
  let settlementAttempted = false;
  try {
    for (let index = 0; index < participants.length; index += 1) {
      sessions.push(await participants[index]!.openAsset({
        url: input.players[index]!.assetUrl
      }));
    }
    const capabilities = await probeCapabilities(sessions[0]!);
    const unsupported = capabilityFailure(capabilities);
    if (unsupported !== null) {
      settlementAttempted = true;
      terminal = await settleAll(
        pageRuntime, participants, sessions, harnesses, input.players
      );
      return Object.freeze({
        status: "unsupported" as const,
        reason: unsupported,
        capabilities,
        terminal,
        page: pageSummary(pageRuntime.snapshot().resources)
      });
    }

    for (let index = 0; index < participants.length; index += 1) {
      harnesses.push(await createHarness({
        participant: participants[index]!,
        session: sessions[index]!,
        metricsUrl: input.players[index]!.metricsUrl,
        nextSequence: () => ++sequence
      }));
    }
    const prepared: IntegratedPrepareResult[] = [];
    // Establish the two real owners deterministically before admitting the
    // third participant. The FIFO behavior under proof is reentry after that
    // bounded capacity is full, not network scheduling among initial opens.
    for (const harness of harnesses) {
      prepared.push(await harness.player.prepare({ timeoutMs: 30_000 }));
    }
    await Promise.all(harnesses.map(({ composition }) =>
      composition.controls.settled()
    ));
    assert(prepared[0]?.mode === "animated" && prepared[1]?.mode === "animated",
      `the first two real players did not animate: ${JSON.stringify(
        prepared.map((result, index) => ({
          mode: result.mode,
          reason: result.mode === "static" ? result.reason : null,
          readiness: harnesses[index]!.player.snapshot().readiness,
          decoderPending:
            harnesses[index]!.player.participantSnapshot()?.decoderPending ?? false,
          diagnostics: harnesses[index]!.diagnostics
        }))
      )}`);
    assert(prepared[2]?.mode === "static" &&
      prepared[2].reason === "decoder-queued",
    "the third real player did not settle decoder-queued");
    const initialSnapshot = pageRuntime.snapshot();
    const initialPlayers = Object.freeze(harnesses.map((harness, index) =>
      summarizePlayer(harness, prepared[index]!)
    ));
    assert(initialSnapshot.decoders.activeLeaseCount === 2 &&
      initialSnapshot.decoders.queuedTicketCount === 1,
    "page decoder authority did not expose two owners and one waiter");
    assert(initialPlayers[0]!.workerAlive && initialPlayers[1]!.workerAlive &&
      initialPlayers[0]!.decoderConfigureCalls > 0 &&
      initialPlayers[1]!.decoderConfigureCalls > 0 &&
      initialPlayers[0]!.rendererAlive && initialPlayers[1]!.rendererAlive &&
      initialPlayers[0]!.glResourceCount > 0 &&
      initialPlayers[1]!.glResourceCount > 0,
    "animated players did not own real worker/decoder/WebGL resources");
    assert(initialPlayers[2]!.staticVisible &&
      initialPlayers[2]!.staticNonTransparentPixels > 0 &&
      initialPlayers[2]!.decoderPending,
    "queued player did not retain strict static coverage and its FIFO ticket");
    const initial = Object.freeze({
      players: initialPlayers,
      page: pageSummary(initialSnapshot.resources),
      decoderQueue: initialSnapshot.decoders.queuedTicketCount,
      thirdTicketRetained: true as const
    });

    const third = harnesses[2]!;
    const createsBefore = candidateCreateCount(third);
    const eventOffset = third.instrumentation.events.length;
    harnesses[0]!.mounted.setPhase("fifo-release");
    await harnesses[0]!.player.setVisibility("hidden");
    assert(harnesses[0]!.mounted.staticVisible &&
      countNonTransparentPixels(harnesses[0]!.mounted.staticCanvas) > 0,
    "released decoder owner did not retain strict static coverage");
    await waitForInteractive(third);
    const promotedSnapshot = third.composition.controls.snapshot();
    const freshDraw = firstDrawAfter(third.instrumentation.events, eventOffset);
    const promotedPage = pageRuntime.snapshot();
    assert(freshDraw === "idle-body:0",
      "FIFO grant did not rebuild the current body at frame zero");
    assert(promotedSnapshot.worker.alive &&
      (promotedSnapshot.worker.metrics?.configureCalls ?? 0) > 0 &&
      promotedSnapshot.renderer.backendAlive &&
      promotedSnapshot.renderer.glResourceCount > 0,
    "FIFO grant did not create fresh worker/decoder/WebGL ownership");
    assert(promotedPage.decoders.activeLeaseCount === 2 &&
      promotedPage.decoders.queuedTicketCount === 0,
    "FIFO grant did not replace the released decoder owner exactly");
    const promotion = Object.freeze({
      hiddenPlayer: 0,
      hiddenReadiness: harnesses[0]!.player.snapshot().readiness,
      hiddenStaticVisible: true as const,
      thirdReadiness: "interactiveReady" as const,
      thirdFirstFreshDraw: "idle-body:0" as const,
      thirdCandidateCreatesBefore: createsBefore,
      thirdCandidateCreatesAfter: candidateCreateCount(third),
      thirdWorkerAlive: true as const,
      thirdDecoderConfigureCalls:
        promotedSnapshot.worker.metrics?.configureCalls ?? 0,
      thirdRendererAlive: true as const,
      thirdGlResourceCount: promotedSnapshot.renderer.glResourceCount,
      page: pageSummary(promotedPage.resources),
      decoderQueue: 0 as const
    });
    assert(promotion.thirdCandidateCreatesAfter > createsBefore,
      "FIFO grant did not construct a fresh candidate generation");

    settlementAttempted = true;
    terminal = await settleAll(
      pageRuntime, participants, sessions, harnesses, input.players
    );
    const page = pageRuntime.snapshot();
    const pageResources = pageSummary(page.resources);
    assertTerminal(page, pageResources, terminal);
    return Object.freeze({
      status: "supported" as const,
      capabilities,
      limit: 2 as const,
      initial,
      promotion,
      terminal,
      page: pageResources,
      activeParticipants: 0 as const,
      decoderLeases: 0 as const,
      decoderQueue: 0 as const
    });
  } catch (error) {
    if (!settlementAttempted) {
      settlementAttempted = true;
      await settleAll(
        pageRuntime, participants, sessions, harnesses, input.players
      ).catch(() => undefined);
    }
    throw error;
  }
}

async function createHarness(input: Readonly<{
  participant: PlayerWebRuntimeParticipant;
  session: RuntimeAssetSession;
  metricsUrl: string;
  nextSequence: () => number;
}>): Promise<FifoHarness> {
  const { participant, session } = input;
  const mounted = mountPlanes(session, input.nextSequence);
  const planes = await BrowserPresentationPlanes.create({
    animatedCanvas: mounted.animatedCanvas,
    staticCanvas: mounted.staticCanvas,
    canvas: session.catalog.manifest.canvas,
    maxBackingBytes: 16 * 1024 * 1024,
    setStaticVisible: (visible) => mounted.setStaticVisible(visible),
    backingResources: participant.resources.canvasBacking
  });
  await planes.resizeWithAdmission({
    cssWidth: session.catalog.manifest.canvas.width,
    cssHeight: session.catalog.manifest.canvas.height,
    devicePixelRatio: 1,
    fit: "fill"
  });
  const frames = new ManualAnimationFrames();
  const composition = createBrowserAvcCandidateComposition({
    canvas: mounted.animatedCanvas,
    presentationPlanes: planes,
    renderer: { preserveDrawingBuffer: true },
    clock: { now: () => frames.now },
    resourceAuthority: participant.resources.candidate
  });
  const instrumentation = instrumentCandidateFactory(
    composition.factory, input.nextSequence
  );
  const decoder = new BrowserStaticSurfaceDecoder({
    resourceHost: participant.resources.staticDecoder
  });
  const diagnostics: string[] = [];
  let store: StaticSurfaceStore | null = null;
  const player = new IntegratedPlayer({
    assetSession: session,
    assetSessionOwnership: "external",
    candidateFactory: instrumentation.factory,
    participantBinding: participant.resources.participant,
    createStaticStore(catalog) {
      store = new StaticSurfaceStore(
        asStaticSurfaceCatalog(catalog), decoder, planes.staticPlane,
        {
          resourceHost: participant.resources.staticSurfaces,
          retainOptionalSurfaces: true
        }
      );
      return store;
    },
    motionPolicy: "full",
    now: () => frames.now,
    realtime: {
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      now: () => frames.now
    },
    diagnosticsSink: (failure) => {
      diagnostics.push(`${failure.code}:${failure.context.operation ?? "unknown"}`);
    }
  });
  return Object.freeze({
    participant,
    session,
    mounted,
    planes,
    composition,
    instrumentation,
    player,
    releaseOwnedPlayer: participant.ownPlayer(player),
    diagnostics,
    metricsUrl: input.metricsUrl,
    store: () => store
  });
}

function summarizePlayer(
  harness: FifoHarness,
  result: Readonly<IntegratedPrepareResult>
): Readonly<M7FifoPlayerSummary> {
  const candidate = harness.composition.controls.snapshot();
  const participant = harness.player.participantSnapshot();
  return Object.freeze({
    mode: result.mode,
    reason: result.mode === "static" ? result.reason : null,
    readiness: harness.player.snapshot().readiness,
    selectedRendition: harness.player.snapshot().selectedRendition,
    workerAlive: candidate.worker.alive,
    decoderConfigureCalls: candidate.worker.metrics?.configureCalls ?? 0,
    decoderOutputFrames: candidate.worker.metrics?.outputFrames ?? 0,
    rendererAlive: candidate.renderer.backendAlive,
    glResourceCount: candidate.renderer.glResourceCount,
    staticVisible: harness.mounted.staticVisible,
    staticNonTransparentPixels: countNonTransparentPixels(
      harness.mounted.staticCanvas
    ),
    decoderPending: participant?.decoderPending ?? false,
    candidateCreates: candidateCreateCount(harness)
  });
}

async function waitForInteractive(harness: FifoHarness): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await harness.player.settled();
    await harness.composition.controls.settled();
    if (harness.player.snapshot().readiness === "interactiveReady") return;
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
  }
  throw new Error(`M7 FIFO rebuild did not animate: ${JSON.stringify({
    player: harness.player.snapshot(),
    participant: harness.player.participantSnapshot(),
    candidate: harness.composition.controls.snapshot(),
    diagnostics: harness.diagnostics
  })}`);
}

async function settleAll(
  pageRuntime: PlayerWebPageRuntime,
  participants: readonly PlayerWebRuntimeParticipant[],
  sessions: readonly RuntimeAssetSession[],
  harnesses: readonly FifoHarness[],
  endpoints: M7DecoderFifoProofInput["players"]
): Promise<readonly Readonly<M7FifoTerminalPlayer>[]> {
  const terminal: M7FifoTerminalPlayer[] = [];
  const failures: unknown[] = [];
  try {
    for (let index = 0; index < participants.length; index += 1) {
      const harness = harnesses[index];
      const session = sessions[index];
      const participant = participants[index]!;
      let candidate = zeroCandidateCleanup();
      let planes = zeroPlanesSnapshot();
      let store: Readonly<StaticSurfaceStoreSnapshot> | null = null;
      let context: Readonly<IntegratedPlayerContextSnapshot> | null = null;
      if (harness !== undefined) {
        const playerDisposed = await cleanupStep(
          `player ${String(index)} dispose`, failures,
          () => harness.player.dispose()
        );
        await cleanupStep(
          `candidate ${String(index)} settle`, failures,
          () => harness.composition.controls.settled()
        );
        if (playerDisposed) {
          await cleanupStep(
            `player ${String(index)} ownership release`, failures,
            () => harness.releaseOwnedPlayer()
          );
        }
        candidate = cleanupSnapshot(
          `candidate ${String(index)} snapshot`, failures,
          zeroCandidateCleanup,
          () => harness.composition.controls.snapshot().cleanup
        );
        store = cleanupSnapshot(
          `static store ${String(index)} snapshot`, failures,
          () => null,
          () => harness.store()?.snapshot() ?? null
        );
        context = cleanupSnapshot(
          `context ${String(index)} snapshot`, failures,
          () => null,
          () => harness.player.contextSnapshot()
        );
        await cleanupStep(
          `planes ${String(index)} dispose`, failures,
          () => harness.planes.dispose()
        );
        planes = cleanupSnapshot(
          `planes ${String(index)} snapshot`, failures,
          zeroPlanesSnapshot,
          () => harness.planes.snapshot()
        );
        await cleanupStep(
          `mount ${String(index)} dispose`, failures,
          () => harness.mounted.dispose()
        );
      }
      if (session !== undefined) {
        await cleanupStep(
          `session ${String(index)} dispose`, failures,
          () => session.dispose()
        );
      }
      await cleanupStep(
        `participant ${String(index)} dispose`, failures,
        () => participant.dispose()
      );
      const account = cleanupSnapshot(
        `participant ${String(index)} snapshot`, failures,
        zeroParticipantSummary,
        () => summarizeParticipant(participant.snapshot())
      );
      const sessionSnapshot = cleanupSnapshot(
        `session ${String(index)} snapshot`, failures,
        zeroSessionSnapshot,
        () => session?.snapshot() ?? zeroSessionSnapshot()
      );
      let httpActiveResponses = -1;
      try {
        httpActiveResponses = await fetchActiveResponses(
          endpoints[index]!.metricsUrl
        );
      } catch (error) {
        failures.push(cleanupError(
          `metrics ${String(index)} read`, error
        ));
      }
      terminal.push(Object.freeze({
        session: sessionSnapshot,
        account,
        candidate,
        planes,
        store,
        context,
        httpActiveResponses,
        connected: false as const
      }));
    }
  } finally {
    await cleanupStep("page runtime dispose", failures, () => pageRuntime.dispose());
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "M7 FIFO terminal cleanup failed");
  }
  return Object.freeze(terminal);
}

async function cleanupStep(
  operation: string,
  failures: unknown[],
  action: () => void | PromiseLike<void>
): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    failures.push(cleanupError(operation, error));
    return false;
  }
}

function cleanupSnapshot<T>(
  operation: string,
  failures: unknown[],
  fallback: () => T,
  capture: () => T
): T {
  try {
    return capture();
  } catch (error) {
    failures.push(cleanupError(operation, error));
    return fallback();
  }
}

function cleanupError(operation: string, cause: unknown): Error {
  return new Error(`M7 FIFO ${operation} failed`, { cause });
}

function summarizeParticipant(
  snapshot: Readonly<PlayerWebRuntimeParticipantSnapshot>
) {
  return Object.freeze({
    disposed: snapshot.disposed,
    activeLeases: snapshot.account.activeLeaseCount,
    participantAttached: snapshot.account.participant !== null,
    lifecycleState: snapshot.lifecycle.state,
    registeredCleanups: snapshot.lifecycle.registeredCleanupCount,
    trackedWork: snapshot.lifecycle.trackedWorkCount,
    pendingWaits: snapshot.lifecycle.pendingWaitCount
  });
}

function assertTerminal(
  page: ReturnType<PlayerWebPageRuntime["snapshot"]>,
  resources: Readonly<M7PageResourceSummary>,
  terminal: readonly Readonly<M7FifoTerminalPlayer>[]
): void {
  assert(page.disposed && page.activeParticipants === 0 &&
    resources.physicalBytes === 0 && resources.byteLeases === 0 &&
    resources.participants === 0 && resources.decoderLeases === 0 &&
    resources.decoderQueue === 0 && resources.pendingReclamations === 0 &&
    page.decoders.activeLeaseCount === 0 &&
    page.decoders.queuedTicketCount === 0,
  "page runtime retained account or decoder ownership");
  for (const player of terminal) {
    assert(player.session.disposed && player.session.metadataBytes === 0 &&
      player.session.verifiedPayloadBytes === 0 &&
      player.session.activeTransportBodies === 0 &&
      player.session.pendingLoads === 0 &&
      player.session.interestedWaiters === 0,
    "terminal FIFO session retained loader ownership");
    assert(player.account.disposed && player.account.activeLeases === 0 &&
      !player.account.participantAttached &&
      player.account.lifecycleState === "disposed" &&
      player.account.registeredCleanups === 0 &&
      player.account.trackedWork === 0 && player.account.pendingWaits === 0,
    "terminal FIFO participant retained lifecycle or account ownership");
    assert(player.candidate.complete && player.candidate.workersAlive === 0 &&
      player.candidate.openFrames === 0 &&
      player.candidate.renderersAlive === 0 &&
      player.candidate.glResourceCount === 0 &&
      player.candidate.rendererStagingBytes === 0 &&
      player.candidate.sourceCopiesInFlight === 0 &&
      player.candidate.pendingOperations === 0,
    "terminal FIFO candidate retained worker/decoder/GL ownership");
    assert(!player.planes.backendAttached && player.planes.contextListeners === 0 &&
      player.planes.resourceReservations === 0 &&
      player.planes.liveResourceTotals.length === 0 &&
      player.planes.geometry === null,
    "terminal FIFO planes retained GL resources or listeners");
    assert(player.store === null || (player.store.state === "disposed" &&
      player.store.retainedSurfaces === 0 &&
      player.store.retainedRgbaBytes === 0),
    "terminal FIFO static store retained surfaces");
    assert(player.context === null || (player.context.state === "disposed" &&
      player.context.listenerCount === 0 &&
      player.context.pendingOperations === 0),
    "terminal FIFO context retained listeners");
    assert(player.httpActiveResponses === 0,
      "terminal FIFO HTTP fixture retained an active response");
  }
}

function candidateCreateCount(harness: FifoHarness): number {
  return harness.instrumentation.events.filter(({ kind }) => kind === "create").length;
}

async function fetchActiveResponses(metricsUrl: string): Promise<number> {
  const response = await fetch(metricsUrl, { cache: "no-store" });
  if (!response.ok) throw new Error("M7 FIFO metrics endpoint rejected proof");
  const value = await response.json() as { readonly activeResponses?: unknown };
  if (!Number.isSafeInteger(value.activeResponses) ||
    (value.activeResponses as number) < 0) {
    throw new Error("M7 FIFO active-response counter is invalid");
  }
  return value.activeResponses as number;
}

function validateInput(input: Readonly<M7DecoderFifoProofInput>): void {
  if (input === null || typeof input !== "object" ||
    !Array.isArray(input.players) || input.players.length !== 3 ||
    input.players.some((entry) => entry === null || typeof entry !== "object" ||
      typeof entry.assetUrl !== "string" || entry.assetUrl.length === 0 ||
      typeof entry.metricsUrl !== "string" || entry.metricsUrl.length === 0)) {
    throw new TypeError("M7 FIFO proof requires exactly three player endpoints");
  }
}

function zeroCandidateCleanup(): BrowserAvcCleanupSnapshot {
  return Object.freeze({
    workersAlive: 0, openFrames: 0, renderersAlive: 0, glResourceCount: 0,
    rendererStagingBytes: 0, sourceCopiesInFlight: 0, pendingOperations: 0,
    complete: true
  });
}

function zeroPlanesSnapshot(): BrowserPresentationPlanesSnapshot {
  return Object.freeze({
    generation: 0,
    resizeCount: 0,
    equivalentResizeCount: 0,
    geometry: null,
    backendAttached: false,
    contextListeners: 0,
    resourceReservations: 0,
    effectiveMaxBackingBytes: 0,
    liveResourceTotals: Object.freeze([])
  });
}

function zeroParticipantSummary(): M7FifoTerminalPlayer["account"] {
  return Object.freeze({
    disposed: true,
    activeLeases: 0,
    participantAttached: false,
    lifecycleState: "disposed",
    registeredCleanups: 0,
    trackedWork: 0,
    pendingWaits: 0
  });
}

function zeroSessionSnapshot(): RuntimeAssetSessionSnapshot {
  const emptyBlobs = Object.freeze({
    total: 0,
    absent: 0,
    loading: 0,
    verified: 0,
    verifiedBytes: 0
  });
  return Object.freeze({
    generation: 0,
    mode: "range",
    declaredFileBytes: 0,
    metadataBytes: 0,
    verifiedPayloadBytes: 0,
    unitBlobs: emptyBlobs,
    staticBlobs: emptyBlobs,
    disposed: true,
    activeTransportBodies: 0,
    pendingLoads: 0,
    interestedWaiters: 0
  });
}
