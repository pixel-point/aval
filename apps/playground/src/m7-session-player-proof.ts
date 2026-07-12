import {
  BrowserPresentationPlanes,
  BrowserStaticSurfaceDecoder,
  IntegratedPlayer,
  PageDecoderLeases,
  PageResourceManager,
  PlayerResourceAccount,
  StaticSurfaceStore,
  asStaticSurfaceCatalog,
  createBrowserAvcCandidateComposition,
  createPlayerWebRuntimeResources,
  openRuntimeAsset,
  type BrowserAvcCandidateComposition,
  type RuntimeAssetSession
} from "@rendered-motion/player-web";
import {
  ManualAnimationFrames,
  advanceOne,
  advanceUntilPresentation,
  assert,
  assertTerminal,
  candidateCategoriesAreZero,
  capabilityFailure,
  countPresentation,
  findCandidateEvent,
  findVisibilityEvent,
  firstDraw,
  firstDrawAfter,
  instrumentCandidateFactory,
  latestDraw,
  mountPlanes,
  pageSummary,
  presentationLabel,
  probeCapabilities,
  realtimeSummary,
  requireContext,
  requireString,
  settleTerminal,
  validateInput,
  visibilitySummary,
  type M7CandidateInstrumentation,
  type M7SessionPlayerProofInput,
  type M7SessionPlayerProofReport,
  type M7SessionPlayerTerminalReport,
  type MountedPlanes
} from "./m7-session-player-proof-support.js";

export type {
  M7SessionPlayerCapabilityReport,
  M7SessionPlayerProofInput,
  M7SessionPlayerProofReport,
  M7SessionPlayerSupportedReport,
  M7SessionPlayerTerminalReport,
  M7SessionPlayerUnsupportedReport
} from "./m7-session-player-proof-support.js";

/**
 * Real M7 composition proof. All player/runtime capabilities come from the
 * package root; the local code only mounts DOM, advances a deterministic RAF,
 * observes public snapshots, and drives the committed HTTP fixture.
 */
export async function runM7SessionPlayerProof(
  input: Readonly<M7SessionPlayerProofInput>
): Promise<Readonly<M7SessionPlayerProofReport>> {
  validateInput(input);
  const manager = new PageResourceManager();
  const decoders = new PageDecoderLeases(manager);
  const account = new PlayerResourceAccount(manager, {
    generation: 1,
    visibility: "visible",
    phase: "loading"
  });
  const resources = createPlayerWebRuntimeResources(account, decoders);
  let session: RuntimeAssetSession | null = null;
  let mounted: MountedPlanes | null = null;
  let planes: BrowserPresentationPlanes | null = null;
  let composition: Readonly<BrowserAvcCandidateComposition> | null = null;
  let store: StaticSurfaceStore | null = null;
  let player: IntegratedPlayer | null = null;
  let instrumentation: Readonly<M7CandidateInstrumentation> | null = null;
  let terminal: Readonly<M7SessionPlayerTerminalReport> | null = null;

  try {
    session = await openRuntimeAsset({ url: input.assetUrl }, {
      resources: resources.assetSession,
      generation: 1
    });
    const capabilities = await probeCapabilities(session);
    const unsupportedReason = capabilityFailure(capabilities);
    if (unsupportedReason !== null) {
      terminal = await settleTerminal({
        manager,
        decoders,
        account,
        session,
        mounted,
        planes,
        composition,
        store,
        player,
        metricsUrl: input.metricsUrl
      });
      assertTerminal(terminal);
      return Object.freeze({
        status: "unsupported" as const,
        reason: unsupportedReason,
        capabilities,
        terminal
      });
    }

    let sequence = 0;
    const nextSequence = (): number => ++sequence;
    mounted = mountPlanes(session, nextSequence);
    planes = await BrowserPresentationPlanes.create({
      animatedCanvas: mounted.animatedCanvas,
      staticCanvas: mounted.staticCanvas,
      canvas: session.catalog.manifest.canvas,
      maxBackingBytes: 16 * 1024 * 1024,
      setStaticVisible: (visible) => mounted!.setStaticVisible(visible),
      backingResources: resources.canvasBacking
    });
    await planes.resizeWithAdmission({
      cssWidth: session.catalog.manifest.canvas.width,
      cssHeight: session.catalog.manifest.canvas.height,
      devicePixelRatio: 1,
      fit: "fill"
    });
    const frames = new ManualAnimationFrames();
    composition = createBrowserAvcCandidateComposition({
      canvas: mounted.animatedCanvas,
      presentationPlanes: planes,
      renderer: { preserveDrawingBuffer: true },
      clock: { now: () => frames.now },
      resourceAuthority: resources.candidate
    });
    instrumentation = instrumentCandidateFactory(
      composition.factory,
      nextSequence
    );
    const decoder = new BrowserStaticSurfaceDecoder({
      resourceHost: resources.staticDecoder
    });
    const diagnostics: string[] = [];
    player = new IntegratedPlayer({
      assetSession: session,
      assetSessionOwnership: "player",
      candidateFactory: instrumentation.factory,
      participantBinding: resources.participant,
      createStaticStore(catalog) {
        const created = new StaticSurfaceStore(
          asStaticSurfaceCatalog(catalog),
          decoder,
          planes!.staticPlane,
          {
            resourceHost: resources.staticSurfaces,
            retainOptionalSurfaces: true
          }
        );
        store = created;
        return created;
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

    mounted.setPhase("prepare");
    const prepared = await player.prepare({ timeoutMs: 30_000 });
    await composition.controls.settled();
    if (prepared.mode !== "animated") {
      throw new Error(`M7 production candidate did not animate: ${JSON.stringify({
        prepared,
        diagnostics,
        page: pageSummary(manager.snapshot()),
        session: session.snapshot(),
        candidate: composition.controls.snapshot(),
        participant: player.participantSnapshot()
      })}`);
    }
    const initialPresentation = firstDraw(instrumentation.events);
    assert(initialPresentation === "intro:0", "initial draw was not intro frame zero");
    player.startRealtime();
    await advanceUntilPresentation(
      player,
      composition,
      frames,
      instrumentation.events,
      "idle-body:0"
    );
    const preparation = Object.freeze({
      mode: "animated" as const,
      selectedRendition: requireString(
        player.snapshot().selectedRendition,
        "selected rendition"
      ),
      session: session.snapshot(),
      page: pageSummary(manager.snapshot()),
      initialPresentation,
      currentPresentation: latestDraw(instrumentation.events),
      introDraws: countPresentation(instrumentation.events, "intro:0")
    });
    assert(preparation.session.staticBlobs.verified === 3,
      "animated preparation did not verify every strict static");
    assert(preparation.page.decoderLeases === 1,
      "animated preparation did not own exactly one decoder");

    mounted.setPhase("hide");
    const beforeHide = realtimeSummary(player);
    const hideStartSequence = sequence;
    await player.setVisibility("hidden");
    await player.settled();
    await composition.controls.settled();
    const hidden = realtimeSummary(player);
    const hiddenVisibility = visibilitySummary(player.visibilitySnapshot());
    const hiddenPage = pageSummary(manager.snapshot());
    const hiddenCandidate = composition.controls.snapshot().cleanup;
    const hideCover = findVisibilityEvent(
      mounted.events,
      "hide",
      true,
      hideStartSequence
    );
    const hideDispose = findCandidateEvent(
      instrumentation.events,
      "dispose-start",
      hideStartSequence
    );
    assert(hiddenVisibility.suspension === "suspended",
      "hide did not settle suspended");
    assert(hiddenVisibility.frozenPresentationOrdinal !== null,
      "hide did not retain the frozen ordinal");
    assert(hidden.nextPresentationOrdinal === beforeHide.nextPresentationOrdinal,
      "hide changed the next rational ordinal");
    assert(frames.pending === 0, "hide retained an animation callback");
    assert(hiddenPage.decoderLeases === 0,
      "hide retained a page decoder lease");
    assert(candidateCategoriesAreZero(hiddenPage),
      "hide retained candidate byte categories");
    assert(hiddenCandidate.complete,
      "hide did not retire the active browser candidate");
    assert(hideCover.nonTransparentPixels > 0,
      "hide covered with transparent static pixels");
    assert(hideCover.sequence < hideDispose.sequence,
      "hide candidate cleanup began before static coverage");

    frames.elapse(60_000);
    const afterHiddenWallTime = realtimeSummary(player);
    assert(afterHiddenWallTime.nextPresentationOrdinal ===
      beforeHide.nextPresentationOrdinal,
    "hidden wall time advanced the rational ordinal");

    mounted.setPhase("show");
    const drawsBeforeShow = instrumentation.events.length;
    await player.setVisibility("visible");
    await player.settled();
    await composition.controls.settled();
    const afterResume = realtimeSummary(player);
    const resumedVisibility = visibilitySummary(player.visibilitySnapshot());
    const resumedPage = pageSummary(manager.snapshot());
    const resumedPresentation = firstDrawAfter(
      instrumentation.events,
      drawsBeforeShow
    );
    assert(resumedVisibility.suspension === "active",
      "show did not return to active visibility");
    assert(afterResume.running, "show did not resume the prior realtime owner");
    assert(afterResume.nextPresentationOrdinal === beforeHide.nextPresentationOrdinal,
      "show skipped or replayed a logical ordinal");
    assert(resumedPresentation === "idle-body:0",
      "show did not rebuild the current state's body frame zero");
    assert(countPresentation(instrumentation.events, "intro:0") === 1,
      "show replayed the authored intro");
    assert(resumedPage.decoderLeases === 1,
      "show did not reacquire exactly one decoder");
    await advanceOne(player, composition, frames);
    const afterResumeFrame = realtimeSummary(player);
    const nextVisibilityPresentation = latestDraw(instrumentation.events);
    assert(
      BigInt(afterResumeFrame.nextPresentationOrdinal) ===
        BigInt(beforeHide.nextPresentationOrdinal) + 1n,
      "first post-show frame was not the next logical ordinal"
    );

    const visibility = Object.freeze({
      before: beforeHide,
      hidden,
      afterWallTime: afterHiddenWallTime,
      afterResume,
      afterNextFrame: afterResumeFrame,
      suspension: hiddenVisibility,
      resumed: resumedVisibility,
      hiddenPage,
      resumedPage,
      hiddenCandidate,
      resumedPresentation,
      nextPresentation: nextVisibilityPresentation,
      staticVisible: true as const,
      staticNonTransparentPixels: hideCover.nonTransparentPixels,
      coverBeforeCandidateCleanup: true as const,
      introDraws: countPresentation(instrumentation.events, "intro:0")
    });

    mounted.setPhase("context-loss");
    const beforeContext = realtimeSummary(player);
    const contextLossStartSequence = sequence;
    const lossEvent = new Event("webglcontextlost", { cancelable: true });
    mounted.animatedCanvas.dispatchEvent(lossEvent);
    const contextImmediate = requireContext(player);
    const contextCover = findVisibilityEvent(
      mounted.events,
      "context-loss",
      true,
      contextLossStartSequence
    );
    const coveredSynchronously = mounted.staticVisible &&
      contextCover.nonTransparentPixels > 0;
    assert(lossEvent.defaultPrevented,
      "context loss was not synchronously prevented");
    assert(coveredSynchronously,
      "context loss did not synchronously reveal strict static pixels");
    assert(frames.pending === 0,
      "context loss did not synchronously cancel the realtime callback");

    await player.settled();
    await composition.controls.settled();
    const lostContext = requireContext(player);
    const lostRealtime = realtimeSummary(player);
    const lostPage = pageSummary(manager.snapshot());
    const lostCandidate = composition.controls.snapshot().cleanup;
    const contextDispose = findCandidateEvent(
      instrumentation.events,
      "dispose-start",
      contextLossStartSequence
    );
    assert(lostContext.state === "lost", "context did not settle lost");
    assert(lostPage.decoderLeases === 0,
      "context loss retained a decoder lease");
    assert(candidateCategoriesAreZero(lostPage),
      "context loss retained candidate byte categories");
    assert(lostCandidate.complete,
      "context loss did not retire candidate resources");
    assert(contextCover.sequence < contextDispose.sequence,
      "context candidate cleanup began before synchronous coverage");
    assert(lostRealtime.nextPresentationOrdinal ===
      beforeContext.nextPresentationOrdinal,
    "context loss changed the next rational ordinal");

    frames.elapse(60_000);
    const afterContextWallTime = realtimeSummary(player);
    mounted.setPhase("context-restore");
    const drawsBeforeRestore = instrumentation.events.length;
    mounted.animatedCanvas.dispatchEvent(new Event("webglcontextrestored"));
    await player.settled();
    await composition.controls.settled();
    const restoredContext = requireContext(player);
    const afterRestore = realtimeSummary(player);
    const restoredPage = pageSummary(manager.snapshot());
    const restoredPresentation = firstDrawAfter(
      instrumentation.events,
      drawsBeforeRestore
    );
    assert(restoredContext.state === "ready",
      "context restoration did not settle ready");
    assert(restoredContext.successfulRestorations === 1,
      "context restoration count diverged");
    assert(afterRestore.running, "context restoration did not resume realtime");
    assert(afterRestore.nextPresentationOrdinal ===
      beforeContext.nextPresentationOrdinal,
    "context restoration skipped or replayed a logical ordinal");
    assert(restoredPresentation === "idle-body:0",
      "context restoration did not draw current body frame zero");
    assert(countPresentation(instrumentation.events, "intro:0") === 1,
      "context restoration replayed the authored intro");
    assert(restoredPage.decoderLeases === 1,
      "context restoration did not reacquire exactly one decoder");
    await advanceOne(player, composition, frames);
    const afterContextFrame = realtimeSummary(player);
    const nextContextPresentation = latestDraw(instrumentation.events);
    assert(
      BigInt(afterContextFrame.nextPresentationOrdinal) ===
        BigInt(beforeContext.nextPresentationOrdinal) + 1n,
      "first post-context frame was not the next logical ordinal"
    );

    const contextRecovery = Object.freeze({
      defaultPrevented: true as const,
      staticCoveredSynchronously: true as const,
      staticNonTransparentPixels: contextCover.nonTransparentPixels,
      immediate: contextImmediate,
      lost: lostContext,
      restored: restoredContext,
      before: beforeContext,
      lostRealtime,
      afterWallTime: afterContextWallTime,
      afterRestore,
      afterNextFrame: afterContextFrame,
      lostPage,
      restoredPage,
      lostCandidate,
      restoredPresentation,
      nextPresentation: nextContextPresentation,
      coverBeforeCandidateCleanup: true as const,
      introDraws: countPresentation(instrumentation.events, "intro:0")
    });

    terminal = await settleTerminal({
      manager,
      decoders,
      account,
      session,
      mounted,
      planes,
      composition,
      store,
      player,
      metricsUrl: input.metricsUrl
    });
    assertTerminal(terminal);
    return Object.freeze({
      status: "supported" as const,
      capabilities,
      preparation,
      visibility,
      contextRecovery,
      candidates: Object.freeze(instrumentation.events.slice()),
      visibilityEvents: Object.freeze(mounted.events.slice()),
      diagnostics: Object.freeze(diagnostics.slice()),
      terminal
    });
  } catch (error) {
    if (terminal === null && session !== null) {
      await settleTerminal({
        manager,
        decoders,
        account,
        session,
        mounted,
        planes,
        composition,
        store,
        player,
        metricsUrl: input.metricsUrl
      }).catch(() => undefined);
    }
    throw error;
  }
}
