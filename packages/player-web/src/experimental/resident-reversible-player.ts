import {
  ContinuousPathDecoder,
  PathDecoderDisposedError,
  PathDecoderSupersededError,
  type ContinuousPathDecoderMetrics,
  type ManagedPathFrame
} from "./continuous-path-decoder.js";
import type { RationalFrameRate } from "./rational-time.js";
import {
  durationForFrame,
  timestampForFrame,
  validateFrameRate
} from "./rational-time.js";
import {
  STREAMING_SLOT_COUNT,
  type ResidentFramePlan
} from "./resident-frame-plan.js";
import {
  ReversibleClipController,
  type ReversibleClipFollowOn,
  type ReversibleClipTraceRecord
} from "./reversible-clip-controller.js";
import {
  WebGlFrameRenderer,
  type RenderFrameHandle,
  type StreamingFrameHandle,
  type WebGlFrameRendererSnapshot
} from "./webgl-frame-renderer.js";

const DEFAULT_INITIAL_STREAM_LEAD = 2;
const DEFAULT_DECODE_TIMEOUT_MS = 5_000;

export type ResidentReversiblePlayerState =
  | "idle"
  | "preparing"
  | "ready"
  | "running"
  | "paused"
  | "error"
  | "disposed";

export interface ResidentReversibleEndpoint<TEndpoint extends string> {
  readonly endpoint: TEndpoint;
  readonly bodyUnitId: string;
  readonly bodyFrameCount: number;
  readonly portalFrames: readonly number[];
}

export interface ResidentReversibleVisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

export interface ResidentReversiblePlayerOptions<TEndpoint extends string> {
  readonly plan: ResidentFramePlan;
  readonly frameRate: Readonly<RationalFrameRate>;
  readonly source: Readonly<ResidentReversibleEndpoint<TEndpoint>>;
  readonly target: Readonly<ResidentReversibleEndpoint<TEndpoint>>;
  readonly decoder: ContinuousPathDecoder;
  readonly renderer: WebGlFrameRenderer;
  readonly initialEndpoint?: TEndpoint;
  readonly initialStreamLead?: number;
  readonly decodeTimeoutMs?: number;
  readonly canFollow?: (
    prospectiveEndpoint: TEndpoint,
    destination: TEndpoint
  ) => boolean;
  readonly onSnapshot?: (
    snapshot: ResidentReversiblePlayerSnapshot<TEndpoint>
  ) => void;
  readonly onFollowOn?: (
    followOn: Readonly<ReversibleClipFollowOn<TEndpoint>>
  ) => void;
  readonly requestFrame?: typeof requestAnimationFrame;
  readonly cancelFrame?: typeof cancelAnimationFrame;
  readonly now?: () => number;
  readonly visibilitySource?: ResidentReversibleVisibilitySource;
}

export interface ResidentRecoverySnapshot<TEndpoint extends string> {
  readonly endpoint: TEndpoint;
  readonly pathGeneration: number;
  readonly runwayFrames: number;
  readonly startedAtTick: number;
  readonly firstContinuationPathFrame: string;
  readonly readyAtTick: number | null;
  readonly runwayStartedAtTick: number | null;
  readonly runwayCompletedAtTick: number | null;
  readonly recoveredBeforeRunwayEnd: boolean | null;
}

export type ResidentReversibleDraw =
  | {
      readonly kind: "resident";
      readonly layer: number;
      readonly handle: RenderFrameHandle;
    }
  | {
      readonly kind: "stream";
      readonly slot: number;
      readonly pathGeneration: number;
      readonly pathFrame: string;
      readonly contentFrame: number;
      readonly handle: StreamingFrameHandle;
    }
  | {
      readonly kind: "held";
      readonly reason: "stream-underflow";
    };

export interface ResidentReversiblePlayerTick<TEndpoint extends string> {
  readonly contentTick: number;
  readonly portalEndpoint: TEndpoint | null;
  readonly controller: ReversibleClipTraceRecord<TEndpoint>;
  readonly draw: ResidentReversibleDraw;
  readonly pathGeneration: number;
}

export interface ResidentReversiblePlayerSnapshot<TEndpoint extends string> {
  readonly state: ResidentReversiblePlayerState;
  readonly requestedState: TEndpoint;
  readonly visualState: TEndpoint;
  readonly isTransitioning: boolean;
  readonly phase: ReturnType<ReversibleClipController<TEndpoint>["snapshot"]>["phase"];
  readonly direction: ReturnType<ReversibleClipController<TEndpoint>["snapshot"]>["direction"];
  readonly clipFrame: number | null;
  readonly runwayFrame: number | null;
  readonly contentTicks: number;
  readonly canvasDraws: number;
  readonly heldFrames: number;
  readonly underflows: number;
  readonly lateContentFrames: number;
  readonly directionChanges: number;
  readonly activePathEndpoint: TEndpoint | null;
  readonly pathGeneration: number | null;
  readonly preparedStreamFrames: number;
  readonly lastBodyContentFrame: number | null;
  readonly lastBodyPathFrame: string | null;
  readonly armedPortal: TEndpoint | null;
  readonly recovery: Readonly<ResidentRecoverySnapshot<TEndpoint>> | null;
  readonly recoveryMisses: number;
  readonly stalePreparedFrames: number;
  readonly decoder: ContinuousPathDecoderMetrics;
  readonly renderer: WebGlFrameRendererSnapshot;
  readonly error: string | null;
}

interface PreparedStreamFrame {
  readonly handle: StreamingFrameHandle;
  readonly pathGeneration: number;
  readonly pathFrame: bigint;
  readonly contentFrame: number;
}

interface MutableRecovery<TEndpoint extends string> {
  readonly endpoint: TEndpoint;
  readonly pathGeneration: number;
  readonly runwayFrames: number;
  readonly startedAtTick: number;
  readonly firstContinuationPathFrame: bigint;
  readyAtTick: number | null;
  runwayStartedAtTick: number | null;
  runwayCompletedAtTick: number | null;
  recoveredBeforeRunwayEnd: boolean | null;
}

interface ResidentRunwayTail<TEndpoint extends string> {
  readonly endpoint: TEndpoint;
  nextFrameIndex: number;
}

/**
 * M2-only player for one arbitrary reversible endpoint pair. Resident clip and
 * runway presentation is synchronous; forward body decoding and RGBA upload
 * are prepared ahead into three reusable, versioned streaming slots.
 */
export class ResidentReversiblePlayer<TEndpoint extends string = string> {
  readonly #plan: ResidentFramePlan;
  readonly #frameRate: Readonly<RationalFrameRate>;
  readonly #source: Readonly<ResidentReversibleEndpoint<TEndpoint>>;
  readonly #target: Readonly<ResidentReversibleEndpoint<TEndpoint>>;
  readonly #decoder: ContinuousPathDecoder;
  readonly #renderer: WebGlFrameRenderer;
  readonly #controller: ReversibleClipController<TEndpoint>;
  readonly #initialStreamLead: number;
  readonly #decodeTimeoutMs: number;
  readonly #onSnapshot:
    | ((snapshot: ResidentReversiblePlayerSnapshot<TEndpoint>) => void)
    | null;
  readonly #onFollowOn:
    | ((followOn: Readonly<ReversibleClipFollowOn<TEndpoint>>) => void)
    | null;
  readonly #requestFrame: typeof requestAnimationFrame;
  readonly #cancelFrame: typeof cancelAnimationFrame;
  readonly #now: () => number;
  readonly #visibilitySource: ResidentReversibleVisibilitySource | null;
  readonly #visibilityListener: () => void;

  #state: ResidentReversiblePlayerState = "idle";
  #preparation: Promise<void> | null = null;
  #desiredRunning = false;
  #resumeAfterVisibility = false;
  #lifecycleGeneration = 0;
  #animationFrame: number | null = null;
  #clockAnchorMs = 0;
  #pauseStartedMs: number | null = null;
  #manualTicksSincePause = false;
  #nextPresentationFrame = 0n;
  #activePathEndpoint: TEndpoint | null = null;
  #pathGeneration: number | null = null;
  #nextExpectedPathFrame = 0n;
  #streamQueue: PreparedStreamFrame[] = [];
  #freeStreamingSlots: number[] = createStreamingSlots();
  #pumpToken = 0;
  #pumpTail: Promise<void> = Promise.resolve();
  readonly #pumpByToken = new Map<number, Promise<void>>();
  #contentTicks = 0;
  #canvasDraws = 0;
  #heldFrames = 0;
  #underflows = 0;
  #lateContentFrames = 0;
  #directionChanges = 0;
  #lastBodyContentFrame: number | null = null;
  #lastBodyPathFrame: bigint | null = null;
  #lastBodyEndpoint: TEndpoint | null = null;
  #armedPortal: TEndpoint | null = null;
  #residentRunwayTail: ResidentRunwayTail<TEndpoint> | null = null;
  #recovery: MutableRecovery<TEndpoint> | null = null;
  #recoveryMisses = 0;
  #stalePreparedFrames = 0;
  #error: Error | null = null;

  public constructor(options: ResidentReversiblePlayerOptions<TEndpoint>) {
    this.#plan = options.plan;
    this.#frameRate = Object.freeze({ ...options.frameRate });
    validateFrameRate(this.#frameRate);
    this.#source = validateEndpoint(options.source, "source");
    this.#target = validateEndpoint(options.target, "target");
    if (this.#source.endpoint === this.#target.endpoint) {
      throw new RangeError("reversible player endpoints must differ");
    }
    validatePlanAgainstEndpoints(this.#plan, this.#source, this.#target);
    this.#decoder = options.decoder;
    this.#renderer = options.renderer;
    this.#initialStreamLead = validateInitialLead(
      options.initialStreamLead ?? DEFAULT_INITIAL_STREAM_LEAD
    );
    this.#decodeTimeoutMs = validateTimeout(
      options.decodeTimeoutMs ?? DEFAULT_DECODE_TIMEOUT_MS
    );
    this.#controller = new ReversibleClipController({
      sourceEndpoint: this.#source.endpoint,
      targetEndpoint: this.#target.endpoint,
      clipFrameCount: this.#plan.clipLayers.length,
      sourceRunwayFrameCount: this.#plan.sourceRunwayLayers.length,
      targetRunwayFrameCount: this.#plan.targetRunwayLayers.length,
      ...(options.initialEndpoint === undefined
        ? {}
        : { initialEndpoint: options.initialEndpoint }),
      ...(options.canFollow === undefined ? {} : { canFollow: options.canFollow })
    });
    this.#onSnapshot = options.onSnapshot ?? null;
    this.#onFollowOn = options.onFollowOn ?? null;
    this.#requestFrame =
      options.requestFrame ?? window.requestAnimationFrame.bind(window);
    this.#cancelFrame =
      options.cancelFrame ?? window.cancelAnimationFrame.bind(window);
    this.#now = options.now ?? (() => performance.now());
    this.#visibilitySource = options.visibilitySource ?? defaultVisibilitySource();
    this.#visibilityListener = () => {
      const source = this.#visibilitySource;
      if (source === null) {
        return;
      }
      if (source.hidden) {
        this.#resumeAfterVisibility = this.#desiredRunning || this.#state === "running";
        if (this.#state !== "disposed" && this.#state !== "error") {
          this.#pauseInternal();
        }
        return;
      }
      if (this.#resumeAfterVisibility) {
        this.#resumeAfterVisibility = false;
        void this.resume().catch((error: unknown) => {
          this.#fail(error);
        });
      }
    };
    this.#visibilitySource?.addEventListener("change", this.#visibilityListener);
    this.#emitSnapshot();
  }

  public get state(): ResidentReversiblePlayerState {
    return this.#state;
  }

  public request(destination: TEndpoint): number {
    this.#assertUsable();
    return this.#controller.request(destination);
  }

  public async prepare(): Promise<void> {
    this.#assertUsable();
    if (
      this.#state === "ready" ||
      this.#state === "running" ||
      this.#state === "paused"
    ) {
      return;
    }
    if (this.#preparation !== null) {
      return this.#preparation;
    }
    const rendererSnapshot = this.#renderer.snapshot();
    if (
      rendererSnapshot.state !== "active" ||
      rendererSnapshot.uploadedResidentLayers !== this.#plan.layerCount
    ) {
      throw new Error("resident texture cache must be complete before player preparation");
    }

    this.#state = "preparing";
    this.#emitSnapshot();
    this.#preparation = (async () => {
      const endpoint = this.#controller.snapshot().visualEndpoint;
      this.#beginPath(endpoint, 0);
      await this.#ensureStreamLead(this.#initialStreamLead);
      if (this.#state === "disposed") {
        throw new PathDecoderDisposedError();
      }
      this.#drawNextStreamFrame(false);
      this.#queueStreamPump();
      this.#state = "ready";
      this.#emitSnapshot();
    })().catch((error: unknown) => {
      const normalized = normalizeError(error, "resident player preparation failed");
      if (this.#state !== "disposed") {
        this.#fail(normalized);
      }
      throw normalized;
    });
    return this.#preparation;
  }

  public async start(): Promise<void> {
    this.#assertUsable();
    if (this.#state === "running") {
      return;
    }
    this.#desiredRunning = true;
    const generation = ++this.#lifecycleGeneration;
    await this.prepare();
    if (!this.#canRun(generation)) {
      this.#settlePausedIntent();
      return;
    }
    this.#enterRunning();
  }

  public pause(): void {
    this.#assertUsable();
    this.#resumeAfterVisibility = false;
    this.#pauseInternal();
  }

  #pauseInternal(): void {
    if (this.#state === "paused" && !this.#desiredRunning) {
      return;
    }
    this.#desiredRunning = false;
    this.#lifecycleGeneration += 1;
    this.#cancelScheduledFrame();
    this.#pauseStartedMs ??= this.#now();
    if (this.#state !== "idle" && this.#state !== "preparing") {
      this.#state = "paused";
    }
    this.#emitSnapshot();
  }

  public async resume(): Promise<void> {
    this.#assertUsable();
    if (this.#state === "running") {
      return;
    }
    this.#desiredRunning = true;
    const generation = ++this.#lifecycleGeneration;
    await this.prepare();
    await this.#ensureStreamLead(1);
    if (!this.#canRun(generation)) {
      this.#settlePausedIntent();
      return;
    }
    this.#enterRunning();
  }

  /** Advances one and only one content tick outside the realtime clock. */
  public tickOnce(): ResidentReversiblePlayerTick<TEndpoint> {
    this.#assertUsable();
    if (this.#state !== "ready" && this.#state !== "paused") {
      throw new Error(`tickOnce requires a ready or paused player, not ${this.#state}`);
    }
    const tick = this.#presentContentTick();
    this.#nextPresentationFrame += 1n;
    this.#manualTicksSincePause = true;
    return tick;
  }

  public snapshot(): ResidentReversiblePlayerSnapshot<TEndpoint> {
    const controller = this.#controller.snapshot();
    return Object.freeze({
      state: this.#state,
      requestedState: controller.requestedEndpoint,
      visualState: controller.visualEndpoint,
      isTransitioning: controller.inTransition,
      phase: controller.phase,
      direction: controller.direction,
      clipFrame: controller.clipFrameIndex,
      runwayFrame: controller.runwayFrameIndex,
      contentTicks: this.#contentTicks,
      canvasDraws: this.#canvasDraws,
      heldFrames: this.#heldFrames,
      underflows: this.#underflows,
      lateContentFrames: this.#lateContentFrames,
      directionChanges: this.#directionChanges,
      activePathEndpoint: this.#activePathEndpoint,
      pathGeneration: this.#pathGeneration,
      preparedStreamFrames: this.#streamQueue.length,
      lastBodyContentFrame: this.#lastBodyContentFrame,
      lastBodyPathFrame:
        this.#lastBodyPathFrame === null ? null : String(this.#lastBodyPathFrame),
      armedPortal: this.#armedPortal,
      recovery: freezeRecovery(this.#recovery),
      recoveryMisses: this.#recoveryMisses,
      stalePreparedFrames: this.#stalePreparedFrames,
      decoder: this.#decoder.snapshotMetrics(),
      renderer: this.#renderer.snapshot(),
      error: this.#error?.message ?? null
    });
  }

  public dispose(): void {
    if (this.#state === "disposed") {
      return;
    }
    this.#desiredRunning = false;
    this.#lifecycleGeneration += 1;
    this.#pumpToken += 1;
    this.#cancelScheduledFrame();
    this.#visibilitySource?.removeEventListener("change", this.#visibilityListener);
    this.#clearPreparedStreams();
    this.#decoder.dispose();
    this.#renderer.dispose();
    this.#state = "disposed";
    this.#emitSnapshot();
  }

  #presentContentTick(): ResidentReversiblePlayerTick<TEndpoint> {
    const portalEndpoint = this.#consumeArmedPortal();
    const trace = this.#controller.tick(
      portalEndpoint === null ? {} : { portalEndpoint }
    );
    if (
      trace.before.phase === "clip" &&
      trace.snapshot.phase === "clip" &&
      trace.before.direction !== trace.snapshot.direction
    ) {
      this.#directionChanges += 1;
    }
    if (trace.emittedFollowOn !== null) {
      this.#onFollowOn?.(trace.emittedFollowOn);
    }

    this.#updateResidentRunwayTail(trace);
    this.#ensureProspectivePath(trace);
    const draw = this.#drawPresentation(trace);
    this.#contentTicks += 1;
    this.#recordRunwayProgress(trace);
    this.#queueStreamPump();
    this.#emitSnapshot();
    const pathGeneration = this.#pathGeneration;
    if (pathGeneration === null) {
      throw new Error("resident player has no active decoder generation");
    }
    return Object.freeze({
      contentTick: this.#contentTicks,
      portalEndpoint,
      controller: trace,
      draw,
      pathGeneration
    });
  }

  #ensureProspectivePath(
    trace: ReversibleClipTraceRecord<TEndpoint>
  ): void {
    if (
      trace.presentation.kind !== "clip" &&
      trace.presentation.kind !== "runway"
    ) {
      return;
    }
    const endpoint = trace.snapshot.prospectiveEndpoint;
    if (endpoint === this.#activePathEndpoint) {
      return;
    }
    this.#beginPath(endpoint, this.#runwayFramesFor(endpoint));
  }

  #drawPresentation(
    trace: ReversibleClipTraceRecord<TEndpoint>
  ): ResidentReversibleDraw {
    const presentation = trace.presentation;
    if (presentation.kind === "stable") {
      const runwayFallback = this.#drawResidentRunwayTail(trace);
      if (runwayFallback !== null) {
        return runwayFallback;
      }
      return this.#drawNextStreamFrame(true);
    }
    const layer =
      presentation.kind === "clip"
        ? this.#plan.clipLayers[presentation.frameIndex]
        : this.#runwayLayersFor(presentation.endpoint)[presentation.frameIndex];
    if (layer === undefined) {
      throw new Error("controller selected an unplanned resident frame");
    }
    const handle = this.#renderer.residentHandle(layer);
    this.#renderer.draw(handle);
    this.#canvasDraws += 1;
    if (presentation.kind === "runway") {
      this.#recordResidentBodyFrame(
        presentation.endpoint,
        presentation.frameIndex
      );
    }
    return Object.freeze({ kind: "resident", layer, handle });
  }

  #updateResidentRunwayTail(
    trace: ReversibleClipTraceRecord<TEndpoint>
  ): void {
    if (
      trace.before.phase === "runway" &&
      trace.presentation.kind === "stable" &&
      trace.before.runwayFrameIndex !== null
    ) {
      this.#residentRunwayTail = {
        endpoint: trace.before.prospectiveEndpoint,
        nextFrameIndex: trace.before.runwayFrameIndex + 1
      };
      return;
    }
    if (
      trace.snapshot.phase !== "waiting" &&
      trace.snapshot.phase !== "stable"
    ) {
      this.#residentRunwayTail = null;
    }
  }

  #drawResidentRunwayTail(
    trace: ReversibleClipTraceRecord<TEndpoint>
  ): ResidentReversibleDraw | null {
    const fallback = this.#residentRunwayTail;
    if (
      fallback === null ||
      (trace.snapshot.phase !== "waiting" && trace.snapshot.phase !== "stable")
    ) {
      return null;
    }
    const layer = this.#runwayLayersFor(fallback.endpoint)[fallback.nextFrameIndex];
    if (layer === undefined) {
      this.#residentRunwayTail = null;
      return null;
    }
    const frameIndex = fallback.nextFrameIndex;
    fallback.nextFrameIndex += 1;
    const handle = this.#renderer.residentHandle(layer);
    this.#renderer.draw(handle);
    this.#canvasDraws += 1;
    this.#recordResidentBodyFrame(fallback.endpoint, frameIndex);
    return Object.freeze({ kind: "resident", layer, handle });
  }

  #recordResidentBodyFrame(endpoint: TEndpoint, frameIndex: number): void {
    this.#lastBodyContentFrame = frameIndex;
    this.#lastBodyPathFrame = BigInt(frameIndex);
    this.#lastBodyEndpoint = endpoint;
    this.#armPortalFromDrawnBodyFrame();
  }

  #drawNextStreamFrame(countUnderflow: boolean): ResidentReversibleDraw {
    const prepared = this.#streamQueue.shift();
    if (prepared === undefined) {
      if (countUnderflow) {
        this.#underflows += 1;
        this.#heldFrames += 1;
      }
      return Object.freeze({ kind: "held", reason: "stream-underflow" });
    }
    if (prepared.pathGeneration !== this.#pathGeneration) {
      this.#releaseStreamingSlot(prepared.handle.slot);
      this.#stalePreparedFrames += 1;
      return this.#drawNextStreamFrame(countUnderflow);
    }

    this.#renderer.draw(prepared.handle);
    this.#releaseStreamingSlot(prepared.handle.slot);
    this.#canvasDraws += 1;
    this.#lastBodyContentFrame = prepared.contentFrame;
    this.#lastBodyPathFrame = prepared.pathFrame;
    this.#lastBodyEndpoint = this.#activePathEndpoint;
    this.#armPortalFromDrawnBodyFrame();
    return Object.freeze({
      kind: "stream",
      slot: prepared.handle.slot,
      pathGeneration: prepared.pathGeneration,
      pathFrame: String(prepared.pathFrame),
      contentFrame: prepared.contentFrame,
      handle: prepared.handle
    });
  }

  #beginPath(endpoint: TEndpoint, cachedRunwayFrames: number): void {
    const descriptor = this.#descriptorFor(endpoint);
    this.#pumpToken += 1;
    this.#clearPreparedStreams();
    const generation = this.#decoder.startPath(descriptor.bodyUnitId, {
      cachedRunwayFrames,
      aheadFrames: Math.min(
        this.#decoder.maxInFlight,
        Math.max(STREAMING_SLOT_COUNT, cachedRunwayFrames + STREAMING_SLOT_COUNT)
      )
    });
    this.#activePathEndpoint = endpoint;
    this.#pathGeneration = generation;
    this.#nextExpectedPathFrame = BigInt(cachedRunwayFrames);
    this.#lastBodyContentFrame = null;
    this.#lastBodyPathFrame = null;
    this.#lastBodyEndpoint = null;
    this.#armedPortal = null;
    this.#recovery = {
      endpoint,
      pathGeneration: generation,
      runwayFrames: cachedRunwayFrames,
      startedAtTick: this.#contentTicks,
      firstContinuationPathFrame: BigInt(cachedRunwayFrames),
      readyAtTick: null,
      runwayStartedAtTick: null,
      runwayCompletedAtTick: null,
      recoveredBeforeRunwayEnd: null
    };
    this.#queueStreamPump();
  }

  #queueStreamPump(): Promise<void> {
    const token = this.#pumpToken;
    const generation = this.#pathGeneration;
    if (generation === null || this.#state === "disposed" || this.#state === "error") {
      return Promise.resolve();
    }
    const existing = this.#pumpByToken.get(token);
    if (existing !== undefined) {
      return existing;
    }
    const operation = this.#pumpTail
      .catch(() => undefined)
      .then(async () => {
        await this.#pumpStreamFrames(token, generation);
      });
    const handled = operation.catch((error: unknown) => {
      if (token === this.#pumpToken && this.#state !== "disposed") {
        this.#fail(error);
      }
    });
    this.#pumpTail = handled;
    this.#pumpByToken.set(token, operation);
    void operation.finally(() => {
      if (this.#pumpByToken.get(token) === operation) {
        this.#pumpByToken.delete(token);
      }
    }).catch(() => undefined);
    return operation;
  }

  async #pumpStreamFrames(token: number, generation: number): Promise<void> {
    while (
      token === this.#pumpToken &&
      generation === this.#pathGeneration &&
      this.#freeStreamingSlots.length > 0 &&
      this.#state !== "disposed" &&
      this.#state !== "error"
    ) {
      let frame = this.#decoder.takeFrame();
      if (frame === undefined) {
        try {
          await this.#decoder.waitForFrames(1, {
            timeoutMs: this.#decodeTimeoutMs
          });
        } catch (error) {
          if (
            error instanceof PathDecoderSupersededError ||
            error instanceof PathDecoderDisposedError ||
            token !== this.#pumpToken
          ) {
            return;
          }
          throw error;
        }
        if (token !== this.#pumpToken || generation !== this.#pathGeneration) {
          return;
        }
        frame = this.#decoder.takeFrame();
        if (frame === undefined) {
          throw new Error("path decoder waiter resolved without a continuation frame");
        }
      }

      if (
        frame.pathGeneration !== generation ||
        frame.pathFrame !== this.#nextExpectedPathFrame
      ) {
        frame.close();
        throw new Error("path decoder produced a non-consecutive continuation frame");
      }
      this.#nextExpectedPathFrame += 1n;
      const slot = this.#freeStreamingSlots.shift();
      if (slot === undefined) {
        frame.close();
        return;
      }
      const handle = await this.#renderer.uploadStreaming(
        slot,
        generation,
        frame
      );
      if (
        handle === null ||
        token !== this.#pumpToken ||
        generation !== this.#pathGeneration
      ) {
        this.#releaseStreamingSlot(slot);
        this.#stalePreparedFrames += 1;
        continue;
      }
      this.#streamQueue.push({
        handle,
        pathGeneration: generation,
        pathFrame: frame.pathFrame,
        contentFrame: frame.contentFrame
      });
      if (
        this.#recovery?.pathGeneration === generation &&
        this.#recovery.readyAtTick === null &&
        frame.pathFrame === this.#recovery.firstContinuationPathFrame
      ) {
        this.#recovery.readyAtTick = this.#contentTicks;
      }
    }
  }

  async #ensureStreamLead(minimum: number): Promise<void> {
    while (this.#streamQueue.length < minimum) {
      const generation = this.#pathGeneration;
      await this.#queueStreamPump();
      if (generation !== this.#pathGeneration) {
        continue;
      }
      if (this.#streamQueue.length < minimum) {
        throw new Error(
          `prepared stream lead stopped at ${String(this.#streamQueue.length)} frame(s)`
        );
      }
    }
  }

  #clearPreparedStreams(): void {
    this.#streamQueue = [];
    this.#freeStreamingSlots = createStreamingSlots();
  }

  #releaseStreamingSlot(slot: number): void {
    if (!this.#freeStreamingSlots.includes(slot)) {
      this.#freeStreamingSlots.push(slot);
      this.#freeStreamingSlots.sort((left, right) => left - right);
    }
  }

  #recordRunwayProgress(
    trace: ReversibleClipTraceRecord<TEndpoint>
  ): void {
    const recovery = this.#recovery;
    if (recovery === null) {
      return;
    }
    if (
      trace.presentation.kind === "runway" &&
      trace.presentation.endpoint === recovery.endpoint &&
      trace.presentation.frameIndex === 0
    ) {
      recovery.runwayStartedAtTick = this.#contentTicks;
    }
    if (
      trace.before.phase === "runway" &&
      trace.snapshot.phase === "stable" &&
      trace.snapshot.visualEndpoint === recovery.endpoint &&
      recovery.runwayCompletedAtTick === null
    ) {
      recovery.runwayCompletedAtTick = this.#contentTicks;
      recovery.recoveredBeforeRunwayEnd =
        recovery.readyAtTick !== null &&
        recovery.readyAtTick <= this.#contentTicks;
      if (!recovery.recoveredBeforeRunwayEnd) {
        this.#recoveryMisses += 1;
      }
    }
  }

  #armPortalFromDrawnBodyFrame(): void {
    const endpoint = this.#lastBodyEndpoint;
    const frame = this.#lastBodyContentFrame;
    if (endpoint === null || frame === null) {
      this.#armedPortal = null;
      return;
    }
    const descriptor = this.#descriptorFor(endpoint);
    this.#armedPortal = descriptor.portalFrames.includes(frame)
      ? endpoint
      : null;
  }

  #consumeArmedPortal(): TEndpoint | null {
    const portal = this.#armedPortal;
    this.#armedPortal = null;
    return portal;
  }

  #descriptorFor(
    endpoint: TEndpoint
  ): Readonly<ResidentReversibleEndpoint<TEndpoint>> {
    if (endpoint === this.#source.endpoint) {
      return this.#source;
    }
    if (endpoint === this.#target.endpoint) {
      return this.#target;
    }
    throw new RangeError(`endpoint ${JSON.stringify(endpoint)} has no body descriptor`);
  }

  #runwayFramesFor(endpoint: TEndpoint): number {
    return this.#runwayLayersFor(endpoint).length;
  }

  #runwayLayersFor(endpoint: TEndpoint): readonly number[] {
    return endpoint === this.#source.endpoint
      ? this.#plan.sourceRunwayLayers
      : this.#plan.targetRunwayLayers;
  }

  #enterRunning(): void {
    const now = this.#now();
    if (this.#pauseStartedMs === null || this.#manualTicksSincePause) {
      this.#clockAnchorMs =
        now - timestampForFrame(this.#nextPresentationFrame, this.#frameRate) / 1_000;
    } else {
      this.#clockAnchorMs += now - this.#pauseStartedMs;
    }
    this.#pauseStartedMs = null;
    this.#manualTicksSincePause = false;
    this.#state = "running";
    this.#emitSnapshot();
    this.#scheduleNextFrame();
  }

  #scheduleNextFrame(): void {
    if (this.#animationFrame !== null || this.#state !== "running") {
      return;
    }
    this.#animationFrame = this.#requestFrame((now) => {
      this.#animationFrame = null;
      try {
        this.#presentDueFrame(now);
      } catch (error) {
        this.#fail(error);
      }
      this.#scheduleNextFrame();
    });
  }

  #presentDueFrame(now: number): void {
    if (this.#state !== "running") {
      return;
    }
    const due = this.#dueTimeMs(this.#nextPresentationFrame);
    if (now < due) {
      return;
    }
    const durationMs =
      durationForFrame(this.#nextPresentationFrame, this.#frameRate) / 1_000;
    if (now - due >= durationMs) {
      this.#lateContentFrames += Math.floor((now - due) / durationMs);
      this.#clockAnchorMs += now - due;
    }
    this.#presentContentTick();
    this.#nextPresentationFrame += 1n;
  }

  #dueTimeMs(frame: bigint): number {
    return this.#clockAnchorMs + timestampForFrame(frame, this.#frameRate) / 1_000;
  }

  #cancelScheduledFrame(): void {
    if (this.#animationFrame === null) {
      return;
    }
    this.#cancelFrame(this.#animationFrame);
    this.#animationFrame = null;
  }

  #canRun(generation: number): boolean {
    return (
      generation === this.#lifecycleGeneration &&
      this.#desiredRunning &&
      this.#state !== "disposed" &&
      this.#state !== "error" &&
      this.#visibilitySource?.hidden !== true
    );
  }

  #settlePausedIntent(): void {
    if (this.#state === "disposed" || this.#state === "error") {
      return;
    }
    if (!this.#desiredRunning || this.#visibilitySource?.hidden === true) {
      if (this.#desiredRunning && this.#visibilitySource?.hidden === true) {
        this.#resumeAfterVisibility = true;
      }
      this.#state = "paused";
      this.#pauseStartedMs ??= this.#now();
      this.#emitSnapshot();
    }
  }

  #fail(error: unknown): void {
    if (this.#state === "disposed" || this.#state === "error") {
      return;
    }
    this.#desiredRunning = false;
    this.#lifecycleGeneration += 1;
    this.#pumpToken += 1;
    this.#cancelScheduledFrame();
    this.#error = normalizeError(error, "resident reversible player failed");
    this.#state = "error";
    this.#clearPreparedStreams();
    this.#decoder.dispose();
    this.#renderer.dispose();
    this.#emitSnapshot();
  }

  #assertUsable(): void {
    if (this.#state === "disposed") {
      throw new Error("the resident reversible player is disposed");
    }
    if (this.#state === "error") {
      throw this.#error ?? new Error("the resident reversible player failed");
    }
  }

  #emitSnapshot(): void {
    this.#onSnapshot?.(this.snapshot());
  }
}

function validateEndpoint<TEndpoint extends string>(
  endpoint: ResidentReversibleEndpoint<TEndpoint>,
  label: string
): Readonly<ResidentReversibleEndpoint<TEndpoint>> {
  if (endpoint === null || typeof endpoint !== "object") {
    throw new TypeError(`${label} endpoint descriptor must be an object`);
  }
  if (
    typeof endpoint.endpoint !== "string" ||
    endpoint.endpoint.length === 0 ||
    typeof endpoint.bodyUnitId !== "string" ||
    endpoint.bodyUnitId.length === 0
  ) {
    throw new TypeError(`${label} endpoint and body unit ids must be non-empty strings`);
  }
  if (!Number.isSafeInteger(endpoint.bodyFrameCount) || endpoint.bodyFrameCount <= 0) {
    throw new RangeError(`${label} body frame count must be a positive safe integer`);
  }
  if (!Array.isArray(endpoint.portalFrames) || endpoint.portalFrames.length === 0) {
    throw new RangeError(`${label} endpoint needs at least one portal frame`);
  }
  const portalFrames = [...new Set(endpoint.portalFrames)].sort((a, b) => a - b);
  for (const frame of portalFrames) {
    if (
      !Number.isSafeInteger(frame) ||
      frame < 0 ||
      frame >= endpoint.bodyFrameCount
    ) {
      throw new RangeError(`${label} portal frame is outside its body`);
    }
  }
  return Object.freeze({ ...endpoint, portalFrames: Object.freeze(portalFrames) });
}

function validatePlanAgainstEndpoints<TEndpoint extends string>(
  plan: ResidentFramePlan,
  source: ResidentReversibleEndpoint<TEndpoint>,
  target: ResidentReversibleEndpoint<TEndpoint>
): void {
  if (
    plan.sourceRunwayLayers.length > source.bodyFrameCount ||
    plan.targetRunwayLayers.length > target.bodyFrameCount
  ) {
    throw new RangeError("endpoint runway exceeds its encoded body frame count");
  }
}

function validateInitialLead(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > STREAMING_SLOT_COUNT) {
    throw new RangeError("initial stream lead must be an integer from 1 through 3");
  }
  return value;
}

function validateTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("decode timeout must be positive and finite");
  }
  return value;
}

function createStreamingSlots(): number[] {
  return Array.from({ length: STREAMING_SLOT_COUNT }, (_, index) => index);
}

function freezeRecovery<TEndpoint extends string>(
  recovery: MutableRecovery<TEndpoint> | null
): Readonly<ResidentRecoverySnapshot<TEndpoint>> | null {
  if (recovery === null) {
    return null;
  }
  return Object.freeze({
    endpoint: recovery.endpoint,
    pathGeneration: recovery.pathGeneration,
    runwayFrames: recovery.runwayFrames,
    startedAtTick: recovery.startedAtTick,
    firstContinuationPathFrame: String(recovery.firstContinuationPathFrame),
    readyAtTick: recovery.readyAtTick,
    runwayStartedAtTick: recovery.runwayStartedAtTick,
    runwayCompletedAtTick: recovery.runwayCompletedAtTick,
    recoveredBeforeRunwayEnd: recovery.recoveredBeforeRunwayEnd
  });
}

function defaultVisibilitySource(): ResidentReversibleVisibilitySource | null {
  if (typeof document === "undefined") {
    return null;
  }
  return {
    get hidden() {
      return document.visibilityState === "hidden";
    },
    addEventListener(_type, listener) {
      document.addEventListener("visibilitychange", listener);
    },
    removeEventListener(_type, listener) {
      document.removeEventListener("visibilitychange", listener);
    }
  };
}

function normalizeError(error: unknown, context: string): Error {
  return error instanceof Error ? error : new Error(context, { cause: error });
}
