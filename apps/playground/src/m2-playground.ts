import {
  BrowserWebGl2FrameBackend,
  ContinuousPathDecoder,
  ResidentReversiblePlayer,
  WebGlFrameRenderer,
  createResidentFramePlan,
  preflightResidentPathRecovery,
  prepareResidentFrames,
  runResidentReversalStress,
  type ResidentFramePlan,
  type ResidentFramePreparationReport,
  type ResidentPathRecoveryEndpointReport,
  type ResidentReversalStressReport,
  type ResidentReversiblePlayerSnapshot
} from "@rendered-motion/player-web";

import {
  SYNTHETIC_REVERSIBLE_RENDITION_ID,
  createSyntheticReversibleFixture,
  decodeSyntheticReversibleTag,
  type SyntheticReversibleCodecEvidence,
  type SyntheticReversibleFixture
} from "./spike/create-synthetic-reversible";
import { readFrameTagFromRgba } from "./spike/frame-tag";

type DemoEndpoint = "resting" | "engaged";

interface M2Session {
  readonly generation: number;
  readonly plan: ResidentFramePlan;
  readonly renderer: WebGlFrameRenderer;
  readonly decoder: ContinuousPathDecoder;
  readonly player: ResidentReversiblePlayer<DemoEndpoint>;
  readonly preparation: ResidentFramePreparationReport;
  readonly recoveryPreflight: readonly Readonly<
    ResidentPathRecoveryEndpointReport<DemoEndpoint>
  >[];
}

interface SerializedM2Snapshot {
  readonly sessionGeneration: number;
  readonly resident: {
    readonly layerCount: number;
    readonly residentBytes: number;
    readonly trackedBytes: number;
    readonly preparationFrames: number;
  };
  readonly recoveryPreflight: readonly Readonly<
    ResidentPathRecoveryEndpointReport<DemoEndpoint>
  >[];
  readonly state: string;
  readonly requestedState: string;
  readonly visualState: string;
  readonly isTransitioning: boolean;
  readonly phase: string;
  readonly direction: string | null;
  readonly clipFrame: number | null;
  readonly runwayFrame: number | null;
  readonly contentTicks: number;
  readonly canvasDraws: number;
  readonly underflows: number;
  readonly directionChanges: number;
  readonly activePathEndpoint: string | null;
  readonly pathGeneration: number | null;
  readonly preparedStreamFrames: number;
  readonly lastBodyContentFrame: number | null;
  readonly lastBodyPathFrame: string | null;
  readonly recoveryMisses: number;
  readonly stalePreparedFrames: number;
  readonly decoder: Omit<
    ResidentReversiblePlayerSnapshot<DemoEndpoint>["decoder"],
    "nextDecodeOrdinal"
  > & { readonly nextDecodeOrdinal: string };
  readonly renderer: ResidentReversiblePlayerSnapshot<DemoEndpoint>["renderer"];
  readonly recovery: ResidentReversiblePlayerSnapshot<DemoEndpoint>["recovery"];
  readonly error: string | null;
}

interface BrowserM2StressResult {
  readonly report: ResidentReversalStressReport<DemoEndpoint>;
  readonly validatedTags: number;
  readonly elapsedMs: number;
  readonly renderer: ResidentReversiblePlayerSnapshot<DemoEndpoint>["renderer"];
}

interface SerializedDisposedSession {
  readonly sessionGeneration: number;
  readonly playerState: string;
  readonly decoderDisposed: boolean;
  readonly openFrames: number;
  readonly rendererState: string;
  readonly allocatedLayers: number;
}

interface PendingContextRestore {
  readonly visualState: DemoEndpoint;
  readonly requestedState: DemoEndpoint;
  readonly resumeRunning: boolean;
}

export interface RenderedMotionM2Api {
  readonly ready: Promise<SyntheticReversibleCodecEvidence>;
  snapshot(): SerializedM2Snapshot | null;
  request(endpoint: DemoEndpoint): number;
  readCanvasIdentity(): ReturnType<typeof decodeSyntheticReversibleTag>;
  runStress(): Promise<BrowserM2StressResult>;
  rebuild(): Promise<SerializedM2Snapshot>;
  loseAndRestoreContext(): Promise<SerializedM2Snapshot>;
  lastDisposedSession(): SerializedDisposedSession | null;
  dispose(): void;
}

declare global {
  interface Window {
    __renderedMotionM2: RenderedMotionM2Api;
  }
}

export function mountM2Playground(
  root: HTMLElement,
  startWhen: Promise<unknown> = Promise.resolve()
): RenderedMotionM2Api {
  root.innerHTML = `
    <section class="m2-lab" aria-labelledby="m2-title">
      <div class="m2-heading">
        <div>
          <p class="eyebrow">Resident interaction experiment · M2</p>
          <h2 id="m2-title">Reverse now, decode ahead</h2>
          <p>
            Hover or focus the control, then leave before it finishes. The
            cached clip changes direction on the next content frame while one
            decoder quietly prepares whichever body wins.
          </p>
        </div>
        <div class="m2-ready-badge" id="m2-ready-badge" data-state="preparing" role="status" aria-live="polite">
          <span aria-hidden="true"></span>
          <strong id="m2-runtime-status">Preparing resident frames…</strong>
        </div>
      </div>

      <div class="m2-grid">
        <div class="m2-stage-panel">
          <button class="motion-host" id="m2-motion-host" type="button" disabled>
            <canvas id="m2-canvas" width="256" height="256" aria-hidden="true"></canvas>
            <span class="motion-host-copy">
              <small>Semantic host control</small>
              <strong>Hover, focus, reverse</strong>
            </span>
          </button>

          <div class="state-route" aria-label="Current motion route">
            <span id="m2-source-state" class="state-node is-current">resting</span>
            <span class="route-track"><i id="m2-route-progress"></i></span>
            <span id="m2-target-state" class="state-node">engaged</span>
          </div>

          <div class="controls m2-controls" aria-label="Resident interaction controls">
            <button id="m2-rest-button" type="button" disabled>Resting</button>
            <button id="m2-engage-button" type="button" disabled>Engaged</button>
            <button id="m2-rebuild-button" type="button" disabled>Rebuild cache</button>
          </div>
        </div>

        <div class="m2-telemetry-panel">
          <div class="card-heading">
            <div>
              <p class="section-label">Live route</p>
              <h3>Every boundary is explicit</h3>
            </div>
            <span id="m2-codec-pill" class="codec-pill">probing</span>
          </div>

          <dl class="metric-grid m2-metrics">
            <div><dt>Requested</dt><dd id="m2-requested">resting</dd></div>
            <div><dt>Visible</dt><dd id="m2-visual">resting</dd></div>
            <div><dt>Phase</dt><dd id="m2-phase">preparing</dd></div>
            <div><dt>Direction</dt><dd id="m2-direction">—</dd></div>
            <div><dt>Clip / runway</dt><dd id="m2-cursor">—</dd></div>
            <div><dt>Path generation</dt><dd id="m2-generation">—</dd></div>
            <div><dt>Resident layers</dt><dd id="m2-layers">0</dd></div>
            <div><dt>Tracked memory</dt><dd id="m2-memory">0 MiB</dd></div>
            <div><dt>Direction changes</dt><dd id="m2-reversals">0</dd></div>
            <div><dt>Underflows</dt><dd id="m2-underflows">0</dd></div>
            <div><dt>Boundary flush/reset</dt><dd id="m2-boundary">0</dd></div>
            <div><dt>Resident frames closed</dt><dd id="m2-closed">0</dd></div>
          </dl>

          <div class="m2-recovery" id="m2-recovery">
            Waiting for the first endpoint recovery trace.
          </div>
        </div>
      </div>

      <div class="m2-proof-row">
        <div>
          <p class="section-label">Accelerated GPU correctness</p>
          <h3>1,000 cached reversal draws</h3>
          <p>
            Alternates adjacent cached frames, draws every layer through
            WebGL2, and decodes the machine tag from framebuffer readback. It
            validates canvas/GPU ordering, not physical display scan-out.
          </p>
        </div>
        <div class="stress-actions">
          <button id="m2-stress-button" class="primary-button" type="button" disabled>
            Run reversal proof
          </button>
          <progress id="m2-stress-progress" max="1000" value="0" aria-label="Cached reversal draws validated"></progress>
          <output id="m2-stress-result" aria-live="polite">Not run yet</output>
        </div>
      </div>
    </section>
  `;

  const canvas = requireElement<HTMLCanvasElement>(root, "#m2-canvas");
  const host = requireElement<HTMLButtonElement>(root, "#m2-motion-host");
  const restButton = requireElement<HTMLButtonElement>(root, "#m2-rest-button");
  const engageButton = requireElement<HTMLButtonElement>(root, "#m2-engage-button");
  const rebuildButton = requireElement<HTMLButtonElement>(root, "#m2-rebuild-button");
  const stressButton = requireElement<HTMLButtonElement>(root, "#m2-stress-button");
  const stressProgress = requireElement<HTMLProgressElement>(root, "#m2-stress-progress");
  const stressResult = requireElement<HTMLOutputElement>(root, "#m2-stress-result");
  const runtimeStatus = requireElement<HTMLElement>(root, "#m2-runtime-status");
  const readyBadge = requireElement<HTMLElement>(root, "#m2-ready-badge");
  const codecPill = requireElement<HTMLElement>(root, "#m2-codec-pill");

  let fixture: Readonly<SyntheticReversibleFixture> | null = null;
  let session: M2Session | null = null;
  let sessionGeneration = 0;
  let rebuildGeneration = 0;
  let pointerEngaged = false;
  let focusEngaged = false;
  let latestRequestedEndpoint: DemoEndpoint = "resting";
  let stressPromise: Promise<BrowserM2StressResult> | null = null;
  let contextRestorePromise: Promise<SerializedM2Snapshot> | null = null;
  let pendingContextRestore: PendingContextRestore | null = null;
  let lastDisposedSession: SerializedDisposedSession | null = null;
  let disposed = false;

  let resolveReady: (evidence: SyntheticReversibleCodecEvidence) => void;
  let rejectReady: (reason: unknown) => void;
  const ready = new Promise<SyntheticReversibleCodecEvidence>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => undefined);

  const api: RenderedMotionM2Api = {
    ready,
    snapshot: () =>
      session === null
        ? null
        : serializeSnapshot(
            session.player.snapshot(),
            session.generation,
            session.plan,
            session.preparation,
            session.recoveryPreflight,
            latestRequestedEndpoint
          ),
    request(endpoint) {
      return queueEndpoint(endpoint);
    },
    readCanvasIdentity() {
      const current = requireSession(session);
      const tag = readFrameTagFromRgba({
        data: current.renderer.readPixels(),
        width: current.plan.width,
        height: current.plan.height
      });
      return decodeSyntheticReversibleTag(tag.value);
    },
    runStress,
    rebuild: () => rebuildCurrentSession(),
    loseAndRestoreContext,
    lastDisposedSession: () => lastDisposedSession,
    dispose() {
      disposed = true;
      rebuildGeneration += 1;
      disposeCurrentSession();
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
    }
  };
  window.__renderedMotionM2 = api;

  host.addEventListener("pointerenter", () => {
    pointerEngaged = true;
    updateEngagement();
  });
  host.addEventListener("pointerleave", () => {
    pointerEngaged = false;
    updateEngagement();
  });
  host.addEventListener("focusin", () => {
    focusEngaged = true;
    updateEngagement();
  });
  host.addEventListener("focusout", () => {
    focusEngaged = false;
    updateEngagement();
  });
  restButton.addEventListener("click", () => requestEndpoint("resting"));
  engageButton.addEventListener("click", () => requestEndpoint("engaged"));
  rebuildButton.addEventListener("click", () => {
    void api.rebuild().catch(showError);
  });
  stressButton.addEventListener("click", () => {
    void runStress().catch(showError);
  });
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);

  void startWhen
    .catch(() => undefined)
    .then(initialize)
    .catch((error: unknown) => {
      rejectReady(error);
      showError(error);
    });

  return api;

  async function initialize(): Promise<void> {
    fixture = await createSyntheticReversibleFixture({
      sourceEndpoint: "resting",
      targetEndpoint: "engaged"
    });
    renderCodecEvidence(fixture.evidence);
    await rebuildSession("resting", true);
    resolveReady(fixture.evidence);
  }

  async function createSession(
    initialEndpoint: DemoEndpoint,
    generation: number
  ): Promise<M2Session> {
    const currentFixture = requireFixture(fixture);
    const backend = new BrowserWebGl2FrameBackend(canvas);
    const plan = createResidentFramePlan({
      width: currentFixture.width,
      height: currentFixture.height,
      sourceRunway: currentFixture.sourceRunway.keys,
      clip: currentFixture.reversibleClip.frames.map(({ key }) => key),
      targetRunway: currentFixture.targetRunway.keys,
      deviceLimits: backend.limits
    });
    const renderer = new WebGlFrameRenderer(backend, plan);
    let decoder: ContinuousPathDecoder | null = null;

    try {
      const preparation = await prepareResidentFrames(
        plan,
        currentFixture.units.map(({ id, unit }) => ({
          rendition: SYNTHETIC_REVERSIBLE_RENDITION_ID,
          id,
          unit
        })),
        renderer
      );
      const recoveryPreflight = await preflightResidentPathRecovery(
        [
          {
            endpoint: "resting",
            unitId: currentFixture.sourceBody.id,
            unit: currentFixture.sourceBody.unit,
            cachedRunwayFrames: currentFixture.sourceRunway.frameCount
          },
          {
            endpoint: "engaged",
            unitId: currentFixture.targetBody.id,
            unit: currentFixture.targetBody.unit,
            cachedRunwayFrames: currentFixture.targetRunway.frameCount
          }
        ],
        {
          uploadContinuation: async (frame) => {
            const handle = await renderer.uploadStreaming(
              0,
              frame.pathGeneration,
              frame
            );
            if (handle === null) {
              throw new DOMException(
                "M2 recovery preflight upload was superseded",
                "AbortError"
              );
            }
          }
        }
      );
      decoder = new ContinuousPathDecoder(
        [
          { id: currentFixture.sourceBody.id, unit: currentFixture.sourceBody.unit },
          { id: currentFixture.targetBody.id, unit: currentFixture.targetBody.unit }
        ],
        { maxInFlight: 12 }
      );
      const player = new ResidentReversiblePlayer<DemoEndpoint>({
        plan,
        frameRate: currentFixture.frameRate,
        source: {
          endpoint: "resting",
          bodyUnitId: currentFixture.sourceBody.id,
          bodyFrameCount: currentFixture.sourceBody.frameCount,
          portalFrames: [3, 7, 11, 15]
        },
        target: {
          endpoint: "engaged",
          bodyUnitId: currentFixture.targetBody.id,
          bodyFrameCount: currentFixture.targetBody.frameCount,
          portalFrames: [3, 7, 11, 15]
        },
        initialEndpoint,
        decoder,
        renderer,
        onSnapshot: renderSnapshot
      });
      await player.prepare();
      if (generation !== rebuildGeneration || disposed) {
        player.dispose();
        throw new DOMException("M2 session rebuild was superseded", "AbortError");
      }
      return {
        generation: ++sessionGeneration,
        plan,
        renderer,
        decoder,
        player,
        preparation,
        recoveryPreflight
      };
    } catch (error) {
      decoder?.dispose();
      renderer.dispose();
      throw error;
    }
  }

  async function rebuildSession(
    initialEndpoint: DemoEndpoint,
    resumeRunning: boolean,
    requestedEndpoint: DemoEndpoint = initialEndpoint
  ): Promise<SerializedM2Snapshot> {
    if (disposed) {
      throw new Error("M2 playground is disposed");
    }
    latestRequestedEndpoint = requestedEndpoint;
    const generation = ++rebuildGeneration;
    setReadyState("preparing", "Rebuilding resident cache…");
    setControlsDisabled(true);
    disposeCurrentSession();
    const replacement = await createSession(initialEndpoint, generation);
    if (generation !== rebuildGeneration || disposed) {
      replacement.player.dispose();
      throw new DOMException("M2 session rebuild was superseded", "AbortError");
    }
    session = replacement;
    if (requestedEndpoint !== initialEndpoint) {
      replacement.player.request(requestedEndpoint);
      // Apply the retained semantic intent before exposing the rebuilt
      // session; context loss itself is a discontinuity, but intent is not.
      replacement.player.tickOnce();
    }
    if (resumeRunning) {
      await replacement.player.start();
    }
    setControlsDisabled(false);
    setReadyState(
      "ready",
      `${String(replacement.recoveryPreflight.length)} paths · ${String(replacement.plan.layerCount)} resident layers ready`
    );
    renderSnapshot(replacement.player.snapshot());
    return serializeSnapshot(
      replacement.player.snapshot(),
      replacement.generation,
      replacement.plan,
      replacement.preparation,
      replacement.recoveryPreflight,
      latestRequestedEndpoint
    );
  }

  function requestEndpoint(endpoint: DemoEndpoint): void {
    if (stressPromise !== null) {
      return;
    }
    const current = session;
    if (current === null) {
      return;
    }
    queueEndpoint(endpoint);
    renderSnapshot(current.player.snapshot());
  }

  function updateEngagement(): void {
    requestEndpoint(pointerEngaged || focusEngaged ? "engaged" : "resting");
  }

  function runStress(): Promise<BrowserM2StressResult> {
    if (stressPromise !== null) {
      return stressPromise;
    }
    const current = requireSession(session);
    const operation = (async () => {
      const wasRunning = current.player.state === "running";
      const m1WasRunning =
        window.__renderedMotionSpike.snapshot()?.state === "running";
      current.player.pause();
      if (m1WasRunning) {
        window.__renderedMotionSpike.pause();
      }
      try {
        await current.renderer.settled();
        stressProgress.value = 0;
        stressResult.dataset.state = "running";
        stressResult.textContent = "Validating cached resident layer tags…";
        setControlsDisabled(true);
        let validatedTags = 0;
        const startedAt = performance.now();
        const report = await runResidentReversalStress({
          plan: current.plan,
          renderer: current.renderer,
          sourceEndpoint: "resting" as const,
          targetEndpoint: "engaged" as const,
          validateDraw: ({ reversal, expectedKey }) => {
            const pixels = current.renderer.readPixels();
            const tag = readFrameTagFromRgba({
              data: pixels,
              width: current.plan.width,
              height: current.plan.height
            });
            const identity = decodeSyntheticReversibleTag(tag.value);
            if (
              identity === undefined ||
              identity.unitRole !== expectedKey.unit ||
              identity.localFrame !== expectedKey.localFrame
            ) {
              throw new Error(
                `WebGL readback expected ${expectedKey.unit}:${String(expectedKey.localFrame)}, received ${identity?.unitRole ?? "unknown"}:${String(identity?.localFrame ?? -1)}`
              );
            }
            validatedTags += 1;
            if (reversal !== null && reversal % 20 === 0) {
              stressProgress.value = reversal;
            }
          }
        });
        stressProgress.value = report.directionChanges;
        stressResult.dataset.state = "passed";
        const elapsedMs = performance.now() - startedAt;
        stressResult.textContent = `${report.directionChanges.toLocaleString()} cached reversal draws passed · ${validatedTags.toLocaleString()} GPU tags · ${elapsedMs.toFixed(1)} ms`;
        return Object.freeze({
          report,
          validatedTags,
          elapsedMs,
          renderer: current.renderer.snapshot()
        });
      } finally {
        if (wasRunning && session === current) {
          await current.player.resume();
        }
        if (m1WasRunning) {
          await window.__renderedMotionSpike.resume();
        }
      }
    })();
    const shared = operation.finally(() => {
      if (stressPromise === shared) {
        stressPromise = null;
      }
      setControlsDisabled(session === null);
    });
    stressPromise = shared;
    return shared;
  }

  function onContextLost(event: Event): void {
    event.preventDefault();
    freezeForContextLoss();
  }

  function freezeForContextLoss(): void {
    const current = session;
    if (current === null) {
      return;
    }
    setReadyState("lost", "WebGL context lost · logical time frozen");
    setControlsDisabled(true);
    if (pendingContextRestore === null) {
      const snapshot = current.player.snapshot();
      pendingContextRestore = {
        visualState: snapshot.visualState,
        requestedState: latestRequestedEndpoint,
        resumeRunning: current.player.state === "running"
      };
    } else {
      pendingContextRestore = {
        ...pendingContextRestore,
        requestedState: latestRequestedEndpoint
      };
    }
    if (
      current.player.state !== "paused" &&
      current.player.state !== "error" &&
      current.player.state !== "disposed"
    ) {
      current.player.pause();
    }
    current.renderer.markContextLost();
  }

  function onContextRestored(): void {
    const restore = pendingContextRestore ?? {
      visualState: currentVisualState(),
      requestedState: currentRequestedState(),
      resumeRunning: currentWasRunning()
    };
    pendingContextRestore = null;
    void rebuildSession(
      restore.visualState,
      restore.resumeRunning,
      restore.requestedState
    ).catch(showError);
  }

  async function loseAndRestoreContext(): Promise<SerializedM2Snapshot> {
    if (contextRestorePromise !== null) {
      return contextRestorePromise;
    }
    const gl = canvas.getContext("webgl2");
    const extension = gl?.getExtension("WEBGL_lose_context");
    if (extension === null || extension === undefined) {
      throw new Error("WEBGL_lose_context is unavailable");
    }
    const beforeGeneration = session?.generation ?? 0;
    const expectRunning = session?.player.state === "running";
    contextRestorePromise = new Promise<SerializedM2Snapshot>((resolve, reject) => {
      let poll = 0;
      const timeout = window.setTimeout(() => {
        window.clearInterval(poll);
        reject(new Error("WebGL context restoration timed out"));
      }, 8_000);
      poll = window.setInterval(() => {
        const current = session;
        if (
          current !== null &&
          current.generation > beforeGeneration &&
          (expectRunning
            ? current.player.state === "running"
            : current.player.state === "ready" || current.player.state === "paused")
        ) {
          window.clearInterval(poll);
          window.clearTimeout(timeout);
          resolve(
            serializeSnapshot(
              current.player.snapshot(),
              current.generation,
              current.plan,
              current.preparation,
              current.recoveryPreflight,
              latestRequestedEndpoint
            )
          );
        }
      }, 25);
      // Freeze logical time and invalidate handles synchronously. The browser
      // may dispatch webglcontextlost after another animation callback.
      freezeForContextLoss();
      extension.loseContext();
      window.setTimeout(() => extension.restoreContext(), 80);
    }).finally(() => {
      contextRestorePromise = null;
    });
    return contextRestorePromise;
  }

  function renderCodecEvidence(evidence: SyntheticReversibleCodecEvidence): void {
    codecPill.textContent =
      evidence.selectedCodec === "h264-annexb" ? "H.264 Annex B" : "VP8 fallback";
    codecPill.dataset.codec = evidence.selectedCodec;
  }

  function renderSnapshot(
    snapshot: ResidentReversiblePlayerSnapshot<DemoEndpoint>
  ): void {
    setText(root, "#m2-requested", latestRequestedEndpoint);
    setText(root, "#m2-visual", snapshot.visualState);
    setText(root, "#m2-phase", snapshot.phase);
    setText(root, "#m2-direction", snapshot.direction ?? "—");
    setText(
      root,
      "#m2-cursor",
      snapshot.clipFrame === null
        ? snapshot.runwayFrame === null
          ? "—"
          : `runway ${String(snapshot.runwayFrame)}`
        : `clip ${String(snapshot.clipFrame)}`
    );
    setText(root, "#m2-generation", snapshot.pathGeneration ?? "—");
    setText(root, "#m2-layers", snapshot.renderer.uploadedResidentLayers);
    setText(root, "#m2-memory", formatMebibytes(session?.plan.trackedBytes ?? 0));
    setText(root, "#m2-reversals", snapshot.directionChanges);
    setText(root, "#m2-underflows", snapshot.underflows);
    setText(
      root,
      "#m2-boundary",
      snapshot.decoder.boundaryFlushCalls + snapshot.decoder.resetCalls
    );
    setText(root, "#m2-closed", session?.preparation.sourceFramesClosed ?? 0);

    const resting = requireElement<HTMLElement>(root, "#m2-source-state");
    const engaged = requireElement<HTMLElement>(root, "#m2-target-state");
    resting.classList.toggle("is-current", snapshot.visualState === "resting");
    resting.classList.toggle(
      "is-requested",
      latestRequestedEndpoint === "resting"
    );
    engaged.classList.toggle("is-current", snapshot.visualState === "engaged");
    engaged.classList.toggle(
      "is-requested",
      latestRequestedEndpoint === "engaged"
    );
    const progress = requireElement<HTMLElement>(root, "#m2-route-progress");
    progress.style.transform = `scaleX(${String(routeProgress(snapshot))})`;
    progress.style.transformOrigin = "left center";

    const recovery = requireElement<HTMLElement>(root, "#m2-recovery");
    if (snapshot.recovery !== null && snapshot.recovery.runwayFrames > 0) {
      const ready = snapshot.recovery.readyAtTick;
      recovery.textContent = ready === null
        ? `${snapshot.recovery.endpoint} continuation is decoding behind the resident runway.`
        : `${snapshot.recovery.endpoint} body frame ${snapshot.recovery.firstContinuationPathFrame} was stream-ready at content tick ${String(ready)}.`;
      recovery.dataset.state =
        snapshot.recovery.recoveredBeforeRunwayEnd === false ? "miss" : "ready";
    }
  }

  function setReadyState(state: string, message: string): void {
    readyBadge.dataset.state = state;
    runtimeStatus.textContent = message;
  }

  function setControlsDisabled(disabled: boolean): void {
    host.disabled = disabled;
    restButton.disabled = disabled;
    engageButton.disabled = disabled;
    rebuildButton.disabled = disabled;
    stressButton.disabled = disabled;
  }

  function showError(error: unknown): void {
    const normalized = normalizeError(error);
    setReadyState("error", normalized.message);
    readyBadge.dataset.state = "error";
    stressResult.dataset.state = "failed";
    stressResult.textContent = normalized.message;
    setControlsDisabled(true);
  }

  function currentVisualState(): DemoEndpoint {
    return session?.player.snapshot().visualState ?? "resting";
  }

  function currentWasRunning(): boolean {
    return session?.player.state === "running";
  }

  function currentRequestedState(): DemoEndpoint {
    return latestRequestedEndpoint;
  }

  function queueEndpoint(endpoint: DemoEndpoint): number {
    const current = session;
    if (current === null) {
      throw new Error("M2 session is not ready");
    }
    latestRequestedEndpoint = endpoint;
    if (pendingContextRestore !== null) {
      pendingContextRestore = {
        ...pendingContextRestore,
        requestedState: endpoint
      };
    }
    return current.player.request(endpoint);
  }

  function rebuildCurrentSession(): Promise<SerializedM2Snapshot> {
    return rebuildSession(
      currentVisualState(),
      currentWasRunning(),
      currentRequestedState()
    );
  }

  function disposeCurrentSession(): void {
    const current = session;
    if (current === null) {
      return;
    }
    current.player.dispose();
    const snapshot = current.player.snapshot();
    lastDisposedSession = Object.freeze({
      sessionGeneration: current.generation,
      playerState: snapshot.state,
      decoderDisposed: snapshot.decoder.disposed,
      openFrames: snapshot.decoder.openFrames,
      rendererState: snapshot.renderer.state,
      allocatedLayers: snapshot.renderer.allocatedLayers
    });
    session = null;
  }
}

function serializeSnapshot(
  snapshot: ResidentReversiblePlayerSnapshot<DemoEndpoint>,
  sessionGeneration = 0,
  plan?: ResidentFramePlan,
  preparation?: ResidentFramePreparationReport,
  recoveryPreflight: readonly Readonly<
    ResidentPathRecoveryEndpointReport<DemoEndpoint>
  >[] = Object.freeze([]),
  requestedState = snapshot.requestedState
): SerializedM2Snapshot {
  return Object.freeze({
    sessionGeneration,
    resident: Object.freeze({
      layerCount: plan?.layerCount ?? 0,
      residentBytes: plan?.residentBytes ?? 0,
      trackedBytes: plan?.trackedBytes ?? 0,
      preparationFrames: preparation?.sourceFramesClosed ?? 0
    }),
    recoveryPreflight,
    state: snapshot.state,
    requestedState,
    visualState: snapshot.visualState,
    isTransitioning: snapshot.isTransitioning,
    phase: snapshot.phase,
    direction: snapshot.direction,
    clipFrame: snapshot.clipFrame,
    runwayFrame: snapshot.runwayFrame,
    contentTicks: snapshot.contentTicks,
    canvasDraws: snapshot.canvasDraws,
    underflows: snapshot.underflows,
    directionChanges: snapshot.directionChanges,
    activePathEndpoint: snapshot.activePathEndpoint,
    pathGeneration: snapshot.pathGeneration,
    preparedStreamFrames: snapshot.preparedStreamFrames,
    lastBodyContentFrame: snapshot.lastBodyContentFrame,
    lastBodyPathFrame: snapshot.lastBodyPathFrame,
    recoveryMisses: snapshot.recoveryMisses,
    stalePreparedFrames: snapshot.stalePreparedFrames,
    decoder: {
      ...snapshot.decoder,
      nextDecodeOrdinal: String(snapshot.decoder.nextDecodeOrdinal)
    },
    renderer: snapshot.renderer,
    recovery: snapshot.recovery,
    error: snapshot.error
  });
}

function routeProgress(
  snapshot: ResidentReversiblePlayerSnapshot<DemoEndpoint>
): number {
  if (snapshot.phase === "stable") {
    return snapshot.visualState === "engaged" ? 1 : 0;
  }
  if (snapshot.clipFrame !== null) {
    return Math.max(0.05, Math.min(0.95, (snapshot.clipFrame + 1) / 12));
  }
  return snapshot.visualState === "engaged" ? 1 : 0;
}

function requireFixture(
  fixture: Readonly<SyntheticReversibleFixture> | null
): Readonly<SyntheticReversibleFixture> {
  if (fixture === null) {
    throw new Error("Synthetic reversible fixture is unavailable");
  }
  return fixture;
}

function requireSession(session: M2Session | null): M2Session {
  if (session === null) {
    throw new Error("M2 session is unavailable");
  }
  return session;
}

function requireElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Missing M2 playground element ${selector}`);
  }
  return element;
}

function setText(root: ParentNode, selector: string, value: string | number): void {
  requireElement<HTMLElement>(root, selector).textContent = String(value);
}

function formatMebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
