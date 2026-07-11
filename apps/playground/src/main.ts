import {
  LoopCanvasPlayer,
  runContinuousLoopStress,
  type ContinuousLoopStressReport,
  type LoopCanvasPlayerSnapshot
} from "@rendered-motion/player-web";

import "./style.css";
import {
  createSyntheticOrbitLoop,
  createSyntheticStressLoop,
  type SyntheticCodecEvidence,
  type SyntheticLoopFixture
} from "./spike/create-synthetic-loop";
import { readFrameTagFromVideoFrame } from "./spike/frame-tag";

interface BrowserStressResult {
  readonly fixture: SyntheticCodecEvidence;
  readonly report: ContinuousLoopStressReport;
}

interface BrowserPlayerSnapshot {
  readonly state: LoopCanvasPlayerSnapshot["state"];
  readonly virtualFrame: string | null;
  readonly contentFrame: number | null;
  readonly canvasSeams: number;
  readonly underflows: number;
  readonly lateContentFrames: number;
  readonly canvasDrawnFrames: number;
  readonly queuedFrames: number;
  readonly decodeQueueSize: number;
  readonly configureCalls: number;
  readonly boundaryFlushCalls: number;
  readonly openFrames: number;
  readonly error: string | null;
}

interface RenderedMotionSpikeApi {
  readonly ready: Promise<SyntheticCodecEvidence>;
  runStress(): Promise<BrowserStressResult>;
  snapshot(): BrowserPlayerSnapshot | null;
  dispose(): void;
}

declare global {
  interface Window {
    __renderedMotionSpike: RenderedMotionSpikeApi;
  }
}

const app = requireElement<HTMLElement>("#app");

app.innerHTML = `
  <div class="page-shell">
    <header class="hero">
      <div>
        <p class="eyebrow">WebCodecs scheduling experiment · M1</p>
        <h1>Continuous rendered motion</h1>
        <p class="lede">
          One encoded loop. One decoder configuration. New rational timestamps
          every iteration—and no seek, reset, or flush at the seam.
        </p>
      </div>
      <div class="status-cluster" aria-live="polite">
        <span class="status-dot" aria-hidden="true"></span>
        <span id="runtime-status">Preparing codec fixture…</span>
      </div>
    </header>

    <main class="experiment-grid">
      <section class="stage-card" aria-labelledby="stage-title">
        <div class="card-heading">
          <div>
            <p class="section-label">Realtime path</p>
            <h2 id="stage-title">Decoded ahead of the seam</h2>
          </div>
          <span id="codec-pill" class="codec-pill">probing</span>
        </div>

        <div class="canvas-wrap">
          <canvas id="motion-canvas" width="256" height="256" aria-label="Synthetic orbit animation"></canvas>
          <div class="frame-chip">
            <span>content frame</span>
            <strong id="overlay-frame">—</strong>
          </div>
        </div>

        <div class="controls" aria-label="Playback controls">
          <button id="pause-button" type="button" disabled>Pause</button>
          <button id="resume-button" type="button" disabled>Resume</button>
          <button id="restart-button" type="button" disabled>Restart</button>
        </div>
      </section>

      <section class="telemetry-card" aria-labelledby="telemetry-title">
        <div class="card-heading">
          <div>
            <p class="section-label">Live telemetry</p>
            <h2 id="telemetry-title">The seam is just another frame</h2>
          </div>
        </div>

        <dl class="metric-grid">
          <div><dt>State</dt><dd id="metric-state">idle</dd></div>
          <div><dt>Virtual frame</dt><dd id="metric-virtual">—</dd></div>
          <div><dt>Canvas seams drawn</dt><dd id="metric-seams">0</dd></div>
          <div><dt>Decoded lead</dt><dd id="metric-queued">0</dd></div>
          <div><dt>Decoder queue</dt><dd id="metric-decode-queue">0</dd></div>
          <div><dt>Underflows</dt><dd id="metric-underflows">0</dd></div>
          <div><dt>Late content frames</dt><dd id="metric-late">0</dd></div>
          <div><dt>Configure calls</dt><dd id="metric-configure">0</dd></div>
          <div><dt>Boundary flush/reset</dt><dd id="metric-boundary">0</dd></div>
          <div><dt>Open VideoFrames</dt><dd id="metric-open">0</dd></div>
        </dl>

        <div class="evidence-block">
          <p class="section-label">Codec evidence</p>
          <p id="codec-evidence">Waiting for a real encoder and decoder allocation.</p>
        </div>
      </section>

      <section class="stress-card" aria-labelledby="stress-title">
        <div>
          <p class="section-label">Deterministic fast path</p>
          <h2 id="stress-title">Prove 1,000 seams without waiting in realtime</h2>
          <p>
            The burst test replays a two-frame key/delta unit 1,001 times,
            reads every decoded frame tag, and audits every lifecycle counter.
          </p>
        </div>
        <div class="stress-actions">
          <button id="stress-button" class="primary-button" type="button" disabled>
            Run 1,000-seam test
          </button>
          <progress id="stress-progress" max="2002" value="0" aria-label="Stress frames validated"></progress>
          <output id="stress-result">Not run yet</output>
        </div>
      </section>

      <aside class="contract-card">
        <p class="section-label">What this milestone proves</p>
        <ul>
          <li>Global timestamps come from exact rational frame ordinals.</li>
          <li>The next key access unit is submitted before the current loop ends.</li>
          <li>Every decoded frame has explicit, testable ownership.</li>
          <li>Headless results prove ordering—not physical display scan-out.</li>
        </ul>
      </aside>
    </main>
  </div>
`;

const canvas = requireElement<HTMLCanvasElement>("#motion-canvas");
const status = requireElement<HTMLElement>("#runtime-status");
const codecPill = requireElement<HTMLElement>("#codec-pill");
const codecEvidence = requireElement<HTMLElement>("#codec-evidence");
const pauseButton = requireElement<HTMLButtonElement>("#pause-button");
const resumeButton = requireElement<HTMLButtonElement>("#resume-button");
const restartButton = requireElement<HTMLButtonElement>("#restart-button");
const stressButton = requireElement<HTMLButtonElement>("#stress-button");
const stressProgress = requireElement<HTMLProgressElement>("#stress-progress");
const stressResult = requireElement<HTMLOutputElement>("#stress-result");

let orbitFixture: SyntheticLoopFixture | null = null;
let player: LoopCanvasPlayer | null = null;
let latestSnapshot: LoopCanvasPlayerSnapshot | null = null;
let stressPromise: Promise<BrowserStressResult> | null = null;
let lastTelemetryPaint = 0;

let resolveReady: (evidence: SyntheticCodecEvidence) => void;
let rejectReady: (reason: unknown) => void;
const ready = new Promise<SyntheticCodecEvidence>((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});
void ready.catch(() => undefined);

window.__renderedMotionSpike = {
  ready,
  runStress,
  snapshot: () =>
    latestSnapshot === null ? null : serializeSnapshot(latestSnapshot),
  dispose: () => {
    player?.dispose();
    player = null;
  }
};

pauseButton.addEventListener("click", () => {
  player?.pause();
});
resumeButton.addEventListener("click", () => {
  void player?.resume().catch(showRuntimeError);
});
restartButton.addEventListener("click", () => {
  void restartRealtimePlayer().catch(showRuntimeError);
});
stressButton.addEventListener("click", () => {
  void runStress().catch((error: unknown) => {
    stressResult.dataset.state = "failed";
    stressResult.textContent = normalizeError(error).message;
  });
});

void initialize().catch((error: unknown) => {
  const normalized = normalizeError(error);
  rejectReady(normalized);
  showRuntimeError(normalized);
});

async function initialize(): Promise<void> {
  assertSecureBrowserContext();
  orbitFixture = await createSyntheticOrbitLoop({
    frameCount: 24,
    frameRate: { numerator: 30, denominator: 1 },
    width: 256,
    height: 256
  });
  renderCodecEvidence(orbitFixture.evidence);
  await createAndStartPlayer(orbitFixture);
  stressButton.disabled = false;
  restartButton.disabled = false;
  resolveReady(orbitFixture.evidence);
}

async function createAndStartPlayer(
  fixture: SyntheticLoopFixture
): Promise<void> {
  player?.dispose();
  player = new LoopCanvasPlayer(canvas, fixture.unit, {
    prebufferFrames: 8,
    onSnapshot: renderPlayerSnapshot
  });
  await player.start();
}

async function restartRealtimePlayer(): Promise<void> {
  if (orbitFixture === null) {
    throw new Error("The realtime fixture is not ready");
  }
  await createAndStartPlayer(orbitFixture);
}

async function runStress(): Promise<BrowserStressResult> {
  await ready;
  if (stressPromise !== null) {
    return stressPromise;
  }

  stressPromise = runStressOnce();
  return stressPromise;
}

async function runStressOnce(): Promise<BrowserStressResult> {
  const shouldResume = player?.state === "running";
  player?.pause();
  stressButton.disabled = true;
  stressProgress.value = 0;
  stressResult.dataset.state = "running";
  stressResult.textContent = "Encoding the two-frame unit…";

  try {
    const fixture = await createSyntheticStressLoop({
      frameRate: { numerator: 30, denominator: 1 },
      width: 256,
      height: 256
    });
    stressResult.textContent = "Decoding and checking 2,002 frames…";
    const report = await runContinuousLoopStress(fixture.unit, {
      readTag: async (frame) => (await readFrameTagFromVideoFrame(frame)).value,
      onValidatedFrame: (_expected, count) => {
        if (count % 50 === 0 || count === 2_002) {
          stressProgress.value = count;
          stressResult.textContent = `${count.toLocaleString()} / 2,002 frames validated`;
        }
      }
    });

    stressResult.dataset.state = "passed";
    stressResult.textContent = [
      `${report.seams.toLocaleString()} seams passed`,
      `${report.throughputMultiple.toFixed(1)}× realtime`,
      `${report.metrics.boundaryFlushCalls} boundary flushes`,
      `${report.metrics.openFrames} leaked frames`
    ].join(" · ");

    return { fixture: fixture.evidence, report };
  } catch (error) {
    stressResult.dataset.state = "failed";
    stressResult.textContent = normalizeError(error).message;
    stressPromise = null;
    throw error;
  } finally {
    stressButton.disabled = false;
    if (shouldResume && player?.state === "paused") {
      await player.resume();
    }
  }
}

function renderPlayerSnapshot(snapshot: LoopCanvasPlayerSnapshot): void {
  latestSnapshot = snapshot;
  const now = performance.now();
  const stateChanged =
    requireElement<HTMLElement>("#metric-state").textContent !== snapshot.state;
  if (!stateChanged && now - lastTelemetryPaint < 100) {
    return;
  }
  lastTelemetryPaint = now;

  setText("#metric-state", snapshot.state);
  setText("#metric-virtual", snapshot.virtualFrame?.toString() ?? "—");
  setText("#metric-seams", snapshot.canvasSeams.toLocaleString());
  setText("#metric-queued", snapshot.decoder.queuedFrames.toString());
  setText("#metric-decode-queue", snapshot.decoder.decodeQueueSize.toString());
  setText("#metric-underflows", snapshot.underflows.toString());
  setText("#metric-late", snapshot.lateContentFrames.toString());
  setText("#metric-configure", snapshot.decoder.configureCalls.toString());
  setText(
    "#metric-boundary",
    (snapshot.decoder.boundaryFlushCalls + snapshot.decoder.resetCalls).toString()
  );
  setText("#metric-open", snapshot.decoder.openFrames.toString());
  setText("#overlay-frame", snapshot.contentFrame?.toString() ?? "—");

  status.textContent = statusText(snapshot);
  status.parentElement?.setAttribute("data-state", snapshot.state);
  pauseButton.disabled = snapshot.state !== "running";
  resumeButton.disabled = snapshot.state !== "paused";
}

function renderCodecEvidence(evidence: SyntheticCodecEvidence): void {
  codecPill.textContent = evidence.selectedCodec;
  codecPill.dataset.codec = evidence.selectedCodec;
  const h264 =
    evidence.h264AnnexB === "supported"
      ? "H.264 Annex B verified with in-band SPS/PPS/IDR"
      : `H.264 Annex B ${evidence.h264AnnexB}: ${
          evidence.h264AnnexBReason ?? "no reason reported"
        }`;
  codecEvidence.textContent = `${h264}. Active fixture: ${evidence.selectedCodec}; ${evidence.encoderOutputCount} encoded and ${evidence.decoderOutputCount} decoded during allocation proof.`;
}

function serializeSnapshot(
  snapshot: LoopCanvasPlayerSnapshot
): BrowserPlayerSnapshot {
  return {
    state: snapshot.state,
    virtualFrame: snapshot.virtualFrame?.toString() ?? null,
    contentFrame: snapshot.contentFrame,
    canvasSeams: snapshot.canvasSeams,
    underflows: snapshot.underflows,
    lateContentFrames: snapshot.lateContentFrames,
    canvasDrawnFrames: snapshot.canvasDrawnFrames,
    queuedFrames: snapshot.decoder.queuedFrames,
    decodeQueueSize: snapshot.decoder.decodeQueueSize,
    configureCalls: snapshot.decoder.configureCalls,
    boundaryFlushCalls:
      snapshot.decoder.boundaryFlushCalls + snapshot.decoder.resetCalls,
    openFrames: snapshot.decoder.openFrames,
    error: snapshot.error
  };
}

function statusText(snapshot: LoopCanvasPlayerSnapshot): string {
  switch (snapshot.state) {
    case "idle":
      return "Idle";
    case "preparing":
      return "Building decoded lead…";
    case "ready":
      return "Ready";
    case "running":
      return "Running continuously";
    case "paused":
      return "Paused on a valid frame";
    case "error":
      return snapshot.error ?? "Playback failed";
    case "disposed":
      return "Disposed";
  }
}

function showRuntimeError(error: unknown): void {
  const normalized = normalizeError(error);
  status.textContent = normalized.message;
  status.parentElement?.setAttribute("data-state", "error");
  codecPill.textContent = "static fallback";
  pauseButton.disabled = true;
  resumeButton.disabled = true;
}

function assertSecureBrowserContext(): void {
  if (!window.isSecureContext) {
    throw new Error("Animated mode requires HTTPS or the localhost secure-context exception");
  }
}

function setText(selector: string, value: string): void {
  requireElement<HTMLElement>(selector).textContent = value;
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Missing required element ${selector}`);
  }
  return element;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("Rendered motion spike failed", { cause: error });
}
