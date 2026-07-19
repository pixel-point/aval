import {
  Asset,
  type Edge,
  type Manifest,
  type Rendition,
  type Source,
  type Unit
} from "./asset.js";
import {
  sameGraphPresentation,
  type GraphPresentation,
  type MotionGraphEffect,
  type MotionGraphEngine,
  type MotionGraphResult,
  type MotionGraphSnapshot
} from "@pixel-point/aval-graph";
import { maximumDecodedRgbaBytes } from "@pixel-point/aval-format";
import {
  type DecodeRun,
  type DecodeSample
} from "./decoder.js";
import {
  DecoderPool,
  type DecoderPoolCandidate,
  type DecoderPoolDiagnostic,
  type DecoderPoolLaneId
} from "./decoder-pool.js";
import { ELEMENT_DECODER_CAPACITY } from "./decoder-capacity.js";
import {
  createCodecValidator,
  type CodecValidator
} from "./codec-validator.js";
import { createGraphEngine } from "./graph.js";
import {
  createReadinessPlan,
  type ReadinessPlan
} from "./readiness.js";
import {
  MAX_ROUTE_PREFETCH_INTENTS,
  planRoutePrefetch,
  RoutePrefetchQueue
} from "./route-prefetch.js";
import type {
  Metadata,
  Player,
  PlayerDecoderDiagnostic,
  PlayerInput,
  PlayerSnapshot
} from "./player-contract.js";
import {
  Renderer,
  type RenderLayout
} from "./renderer.js";
import type { AvalPlaybackError } from "./errors.js";
import type {
  AvalRuntimeTraceRecord,
  RuntimeReadinessResult,
  StaticReason
} from "./public-types.js";

type State = Manifest["states"][number];

interface ActiveMediaBase {
  readonly unit: Unit;
  lastIndex: number;
}

interface ResidentMedia extends ActiveMediaBase {
  readonly kind: "resident";
}

interface StreamMedia extends ActiveMediaBase {
  readonly kind: "stream";
  readonly run: DecodeRun;
  drainedIndex: number;
  drain: Promise<void>;
}

type ActiveMedia = ResidentMedia | StreamMedia;

type StreamReservation =
  | Readonly<{ kind: "foreground"; media: StreamMedia }>
  | Readonly<{
      kind: "candidate";
      media: StreamMedia;
      candidate: DecoderPoolCandidate;
    }>;

type PrepareResult = RuntimeReadinessResult;
type CandidateReport = RuntimeReadinessResult["report"]["candidates"][number];

interface StateRequest {
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

const PREPARE_MS = 5_000;
type AdvanceOutcome = "progressed" | "waiting-route";

const COLOR = Object.freeze({
  fullRange: false as const,
  matrix: "bt709" as const,
  primaries: "bt709" as const,
  transfer: "bt709" as const
});

export async function createPlayer(
  input: Readonly<PlayerInput>
): Promise<Player> {
  const publications = new PublicationGate(input);
  const deadline = new PreparationDeadline(
    input.signal,
    input.preparationTimeoutMs,
    input.platform
  );
  try {
    return await selectPlayer(publications.input, deadline, publications);
  } catch (error) {
    const timedOut = deadline.timedOut && !input.signal.aborted;
    deadline.dispose();
    if (input.signal.aborted || isAbort(error) && !timedOut) throw error;
    throw input.onPlaybackFailure(
      timedOut ? "watchdog-timeout" : selectionFailureCode(error),
      "prepare"
    );
  }
}

async function selectPlayer(
  input: Readonly<PlayerInput>,
  deadline: PreparationDeadline,
  publications: PublicationGate
): Promise<Player> {
  if (input.sources.length === 0) throw new TypeError("AVAL requires a source");
  let retained: Asset | null = null;
  let unavailable: CandidateRejectionReason = "codec-unsupported";
  const reports: Readonly<CandidateReport>[] = [];
  let selectionDecoderDiagnostics: readonly Readonly<PlayerDecoderDiagnostic>[] =
    Object.freeze([]);
  for (const [inputIndex, source] of input.sources.entries()) {
    const sourceIndex = source.sourceIndex ?? inputIndex;
    deadline.signal.throwIfAborted();
    if (retained !== null) {
      await retained.dispose();
      reportResourceBytes(input, null);
      retained = null;
    }
    const asset = await Asset.open(
      source as Readonly<Source>,
      input.baseUrl,
      input.credentials,
      deadline.signal,
      input.platform
    );
    reportResourceBytes(input, asset);
    retained = asset;
    if (asset.manifest.codec !== sourceCodecFamily(source.codec) ||
      asset.manifest.renditions.length === 0) {
      retained = asset;
      unavailable = "no-video-rendition";
      continue;
    }
    const first = asset.manifest.renditions[0]!;
    const firstRank = reports.length;
    if (deadline.timedOut) {
      await asset.dispose();
      reportResourceBytes(input, null);
      throw preparationTimeout();
    }
    if (!input.visible) {
      return new PlayerImpl(
        input, asset, first, sourceIndex, selectionDecoderDiagnostics, null, null,
        deadline, publications, "visibility-suspended",
        reports, firstRank
      );
    }
    if (reduced(input.motion, input.reduced)) {
      return new PlayerImpl(
        input, asset, first, sourceIndex, selectionDecoderDiagnostics, null, null,
        deadline, publications, "reduced-motion", reports, firstRank
      );
    }
    if (input.platform.Worker === null || input.platform.VideoDecoder === null ||
      input.platform.VideoFrame === null) {
      await asset.dispose();
      reportResourceBytes(input, null);
      throw unsupportedProfileError();
    }
    if (!input.decoderReady()) {
      return new PlayerImpl(
        input, asset, first, sourceIndex, selectionDecoderDiagnostics, null, null,
        deadline, publications, "decoder-queued", reports, firstRank
      );
    }
    for (const rendition of asset.manifest.renditions) {
      deadline.signal.throwIfAborted();
      const rank = reports.length;
      let plan: Readonly<ReadinessPlan>;
      try {
        plan = createReadinessPlan(
          asset.manifest,
          rendition.id,
          asset.blobs
        );
      } catch (error) {
        await asset.dispose();
        reportResourceBytes(input, null);
        throw error;
      }
      const layout = renderLayout(asset.manifest, rendition);
      const config: VideoDecoderConfig = {
        codec: rendition.codec,
        codedWidth: rendition.codedWidth,
        codedHeight: rendition.codedHeight,
        displayAspectWidth: layout.storageWidth,
        displayAspectHeight: layout.storageHeight,
        colorSpace: COLOR,
        hardwareAcceleration: "no-preference",
        optimizeForLatency: true
      };
      let rendererRef: Renderer | null = null;
      let reportedDecodedBytes = 0;
      let reportedEncodedBytes = 0;
      const reportDecoderBytes = (increasing: boolean): void => {
        reportResourceBytes(input, asset, checkedTotal([
          reportedDecodedBytes,
          reportedEncodedBytes
        ]), rendererRef, increasing);
      };
      const decodedBytesChanged = (bytes: number): void => {
        const increasing = bytes > reportedDecodedBytes;
        const previous = reportedDecodedBytes;
        reportedDecodedBytes = bytes;
        try { reportDecoderBytes(increasing); }
        catch (error) {
          reportedDecodedBytes = previous;
          throw error;
        }
      };
      const encodedBytesChanged = (bytes: number): void => {
        const increasing = bytes > reportedEncodedBytes;
        const previous = reportedEncodedBytes;
        reportedEncodedBytes = bytes;
        try { reportDecoderBytes(increasing); }
        catch (error) {
          reportedEncodedBytes = previous;
          throw error;
        }
      };
      const decoders = new DecoderPool(config, {
        codedWidth: rendition.codedWidth,
        codedHeight: rendition.codedHeight,
        displayWidth: layout.storageWidth,
        displayHeight: layout.storageHeight,
        visibleRect: {
          x: 0,
          y: 0,
          width: layout.storageWidth,
          height: layout.storageHeight
        },
        colorSpace: COLOR
      }, {
        maxDecodedBytes: asset.manifest.limits.maxRuntimeBytes,
        onDecodedBytes: decodedBytesChanged,
        onEncodedBytes: encodedBytesChanged,
        Worker: input.platform.Worker,
        VideoFrame: input.platform.VideoFrame,
        setTimeout: input.platform.setTimeout,
        clearTimeout: input.platform.clearTimeout
      });
      const disposeDecoders = (): void => {
        selectionDecoderDiagnostics = mergePlayerDecoderDiagnostics(
          selectionDecoderDiagnostics,
          publishDecoderDiagnostics(
            input,
            decoders.snapshot().decoderDiagnostics,
            sourceIndex,
            rendition
          )
        );
        decoders.dispose();
      };
      let supported = false;
      try { supported = await limit(decoders.supported(), deadline.signal); }
      catch (error) {
        disposeDecoders();
        if (deadline.timedOut) {
          await asset.dispose();
          reportResourceBytes(input, null);
          throw preparationTimeout();
        }
        await asset.dispose();
        reportResourceBytes(input, null);
        throw error;
      }
      if (!supported) {
        disposeDecoders();
        unavailable = "codec-unsupported";
        reports.push(candidateReport(rendition.id, rank, unavailable));
        continue;
      }
      let renderer: Renderer;
      let contextChange:
        ((state: "lost" | "restored" | "error") => void) | null = null;
      try {
        const maxRuntimeBytes = asset.manifest.limits.maxRuntimeBytes;
        renderer = new Renderer(input.canvas, layout, {
          maxTextureBytes: maxRuntimeBytes,
          maxBackingBytes: maxRuntimeBytes,
          maxRuntimeBytes,
          setTimeout: input.platform.setTimeout,
          clearTimeout: input.platform.clearTimeout,
          onContextChange: (state) => contextChange?.(state),
          initialPresentation: {
            width: input.initialPresentation.width,
            height: input.initialPresentation.height,
            dpr: input.initialPresentation.dpr,
            fit: input.initialPresentation.fit ?? asset.manifest.canvas.fit
          }
        });
        rendererRef = renderer;
      } catch (error) {
        disposeDecoders();
        rendererRef?.dispose();
        rendererRef = null;
        await asset.dispose();
        reportResourceBytes(input, null);
        throw error;
      }
      try {
        reportDecoderBytes(true);
        assertCandidateBudget(asset, rendition, renderer, plan);
      }
      catch (error) {
        disposeDecoders();
        renderer.dispose();
        rendererRef = null;
        reportResourceBytes(input, asset);
        if (!admissionFailure(error)) {
          await asset.dispose();
          reportResourceBytes(input, null);
          throw error;
        }
        unavailable = "resource-budget";
        reports.push(candidateReport(rendition.id, rank, unavailable));
        continue;
      }
      const player = new PlayerImpl(
        input, asset, rendition, sourceIndex, selectionDecoderDiagnostics,
        decoders, renderer, deadline, publications, null, reports, rank
      );
      contextChange = (state) => player.contextChanged(state);
      return player;
    }
  }
  if (retained === null) throw new Error("No AVAL source is available");
  const rendition = retained.manifest.renditions[0];
  await retained.dispose();
  reportResourceBytes(input, null);
  if (rendition === undefined) throw new Error("Invalid AVAL asset");
  if (unavailable === "resource-budget") throw resourceBudgetError();
  throw unsupportedProfileError();
}

class PlayerImpl implements Player {
  public readonly metadata: Readonly<Metadata>;
  readonly #input: Readonly<PlayerInput>;
  readonly #asset: Asset;
  readonly #preparationDeadline: PreparationDeadline;
  readonly #publications: PublicationGate;
  readonly #manifest: Readonly<Manifest>;
  readonly #rendition: Readonly<Rendition>;
  readonly #sourceIndex: number;
  readonly #candidateRank: number;
  readonly #candidateReports: readonly Readonly<CandidateReport>[];
  readonly #reportCurrent: boolean;
  #decoders: DecoderPool | null;
  #renderer: Renderer | null;
  #retiredRenderer: Renderer | null = null;
  readonly #validator: CodecValidator;
  #staticReason: StaticReason | null;
  readonly #states: Map<string, State>;
  readonly #units: Map<string, Unit>;
  readonly #edges: readonly Readonly<Edge>[];
  readonly #edgesById: Map<string, Readonly<Edge>>;
  readonly #resident = new Map<string, Promise<void>>();
  readonly #residentReady = new Set<string>();
  readonly #residentFrames = new Map<string, Set<number>>();
  readonly #routePrefetch: RoutePrefetchQueue<DecoderPoolCandidate>;
  readonly #validated = new Set<string>();
  readonly #trace: Readonly<AvalRuntimeTraceRecord>[] = [];
  readonly #requests = new Map<number, StateRequest>();
  readonly #terminalSignal: Promise<never>;
  readonly #rejectTerminalSignal: (reason: unknown) => void;
  #preparation: Promise<PrepareResult> | null = null;
  #recovery: Promise<PrepareResult> | null = null;
  #terminalWork: Promise<AvalPlaybackError> | null = null;
  #graph: MotionGraphEngine | null = null;
  #plan: Readonly<ReadinessPlan> | null = null;
  #initialMedia: Readonly<{ unit: Unit; run: DecodeRun }> | null = null;
  #active: ActiveMedia | null = null;
  #advanceWork: Promise<AdvanceOutcome> | null = null;
  #preparationMediaWork: Promise<Readonly<{
    unit: Unit;
    run: DecodeRun;
  }>> | null = null;
  #ordinal = 0n;
  #animationGeneration = 0;
  #visible: boolean;
  #paused = false;
  #pauseEpoch = 0;
  #disposed = false;
  #failed = false;
  #prepared = false;
  #activated = false;
  #busy = false;
  #raf: number | null = null;
  #deadline = 0;
  #clockOrigin = 0;
  #clockOrdinal = 0n;
  #firstFrame = true;
  #lastDraw = "";
  #settledRequests = 0;
  #cleanedFrames = 0;
  #underflows = 0;
  #incidents = 0;
  #inUnderflow = false;
  #awaitingContextRestore = false;
  #restartRequested = false;
  #contextLosses = 0;
  #contextRecoveries = 0;
  #cleanupFailureCount = 0;
  #animationResourcesRetired = false;
  #animationResourceRetirement: Promise<void> | null = null;
  #decoderDiagnostics: readonly Readonly<PlayerDecoderDiagnostic>[];
  #capturedPoolDiagnostics: readonly Readonly<DecoderPoolDiagnostic>[] =
    Object.freeze([]);
  readonly #decoderUnitByLane: [
    Readonly<{ run: number; unit: string }> | null,
    Readonly<{ run: number; unit: string }> | null
  ] = [null, null];
  readonly #contextRestored: () => void;

  public constructor(
    input: Readonly<PlayerInput>,
    asset: Asset,
    rendition: Readonly<Rendition>,
    sourceIndex: number,
    decoderDiagnostics: readonly Readonly<PlayerDecoderDiagnostic>[],
    decoders: DecoderPool | null,
    renderer: Renderer | null,
    deadline: PreparationDeadline,
    publications: PublicationGate,
    staticReason: StaticReason | null = null,
    candidateReports: readonly Readonly<CandidateReport>[] = [],
    candidateRank = asset.manifest.renditions.findIndex(
      ({ id }) => id === rendition.id
    ),
    reportCurrent = true
  ) {
    let rejectTerminalSignal!: (reason: unknown) => void;
    this.#terminalSignal = new Promise<never>((_resolve, reject) => {
      rejectTerminalSignal = reject;
    });
    this.#rejectTerminalSignal = rejectTerminalSignal;
    void this.#terminalSignal.catch(() => undefined);
    this.#input = input;
    this.#asset = asset;
    this.#preparationDeadline = deadline;
    this.#publications = publications;
    this.#manifest = asset.manifest;
    this.#rendition = rendition;
    this.#sourceIndex = sourceIndex;
    this.#decoderDiagnostics = decoderDiagnostics;
    this.#candidateRank = candidateRank;
    this.#candidateReports = Object.freeze([...candidateReports]);
    this.#reportCurrent = reportCurrent;
    this.#decoders = decoders;
    this.#renderer = renderer;
    const layout = renderLayout(this.#manifest, rendition);
    this.#validator = createCodecValidator({
      codec: rendition.codec,
      bitDepth: rendition.bitDepth,
      codedWidth: rendition.codedWidth,
      codedHeight: rendition.codedHeight,
      visibleWidth: layout.storageWidth,
      visibleHeight: layout.storageHeight,
      frameRate: this.#manifest.frameRate,
      averageBitrate: rendition.bitrate.average
    });
    this.#staticReason = staticReason;
    this.#states = new Map(this.#manifest.states.map((state) => [state.id, state]));
    this.#units = new Map(this.#manifest.units.map((unit) => [unit.id, unit]));
    this.#edges = this.#manifest.edges;
    this.#edgesById = new Map(this.#edges.map((edge) => [edge.id, edge]));
    this.#routePrefetch = new RoutePrefetchQueue({
      signal: deadline.signal,
      preload: (unit, signal) => this.#preloadRun(unit, signal),
      admit: (unit) => this.#createLoadedRun(unit, "candidate"),
      canAdmit: () => this.#decoders?.candidateAvailable === true,
      onFailure: (error) => this.#fail(error)
    });
    this.#visible = input.visible;
    this.#contextRestored = () => {
      if (!this.#awaitingContextRestore || this.#disposed) return;
      this.#awaitingContextRestore = false;
      this.#contextRecoveries += 1;
      const state = this.#graph?.snapshot().requestedState;
      if (state !== null && state !== undefined) this.#input.onRestart(state);
    };
    input.canvas.addEventListener("webglcontextrestored", this.#contextRestored);
    const eventNames = [...new Set(this.#edges.flatMap((edge) =>
      edge.trigger?.type === "event" ? [edge.trigger.name] : []
    ))];
    this.metadata = Object.freeze({
      initialState: this.#manifest.initialState,
      stateNames: Object.freeze(this.#manifest.states.map(({ id }) => id)),
      eventNames: Object.freeze(eventNames),
      bindings: Object.freeze(this.#manifest.bindings.map((binding) =>
        Object.freeze({ ...binding })
      )),
      canvas: Object.freeze({
        width: this.#manifest.canvas.width,
        height: this.#manifest.canvas.height,
        fit: this.#manifest.canvas.fit,
        pixelAspect: this.#manifest.canvas.pixelAspect
      })
    });
    input.onMetadata(this.metadata);
    input.onReadiness("metadataReady");
    if (decoders !== null) {
      void decoders.failure().catch((error) => this.#fail(error));
    }
  }

  public activate(): void {
    if (this.#activated || this.#disposed) return;
    this.#installGraph();
    this.#activated = true;
    this.#publications.activate();
  }

  public prepare(options: Readonly<{
    signal?: AbortSignal;
    timeoutMs?: number;
  }> = {}): Promise<PrepareResult> {
    if (this.#preparation === null) {
      this.#preparation = this.#prepareBounded();
    }
    const operation = this.#terminalWork === null
      ? Promise.race([this.#preparation, this.#terminalSignal])
      : this.#terminalWork.then((error) => Promise.reject(error));
    return limit(operation, options.signal, options.timeoutMs, this.#input.platform);
  }

  public async setState(state: string): Promise<void> {
    if (!this.#states.has(state)) throw new RangeError("Unknown AVAL state");
    await this.prepare();
    const preparedTerminal = this.#terminalWork;
    if (preparedTerminal !== null) throw await preparedTerminal;
    try {
      const result = this.#requireGraph().request(state);
      const promise = this.#register(result);
      this.#applyWithoutDraw(result);
      this.#prepareRoutes(this.#requireGraph().snapshot());
      this.#schedule();
      await promise;
    } catch (error) {
      const terminal = this.#terminalWork;
      if (terminal !== null) throw await terminal;
      throw error;
    }
    const settledTerminal = this.#terminalWork;
    if (settledTerminal !== null) throw await settledTerminal;
  }

  public send(event: string): boolean {
    const graph = this.#graph;
    if (!this.#activated || this.#disposed || this.#failed || graph === null) {
      return false;
    }
    const result = graph.send(event);
    this.#applyWithoutDraw(result);
    if (this.#prepared) this.#prepareRoutes(graph.snapshot());
    this.#schedule();
    return result.accepted === true;
  }

  public canSend(event: string): boolean {
    return this.#activated && !this.#disposed && !this.#failed &&
      (this.#graph?.canSend(event) ?? false);
  }

  public readyFor(state: string): boolean {
    if (this.#disposed || this.#failed || !this.#prepared ||
      this.#staticReason !== null ||
      !this.#states.has(state)) return false;
    const graph = this.#graph;
    if (graph === null) return false;
    const from = graph.snapshot().requestedState;
    if (from === null) return false;
    if (from === state) return true;
    const edge = this.#edges.find((candidate) =>
      candidate.from === from && candidate.to === state
    );
    return edge !== undefined && this.#departureReady(edge);
  }

  public pause(): void {
    this.#pauseEpoch += 1;
    this.#paused = true;
    this.#cancelFrame();
  }

  public async resume(): Promise<void> {
    const epoch = this.#pauseEpoch;
    await this.prepare();
    const preparedTerminal = this.#terminalWork;
    if (preparedTerminal !== null) throw await preparedTerminal;
    if (epoch !== this.#pauseEpoch) return;
    this.#paused = false;
    this.#resetClock();
    this.#schedule();
    const resumedTerminal = this.#terminalWork;
    if (resumedTerminal !== null) throw await resumedTerminal;
  }

  public async setMotion(
    policy: "auto" | "reduce" | "full",
    reducedMotion: boolean
  ): Promise<void> {
    if (this.#terminalWork !== null) throw await this.#terminalWork;
    if (reduced(policy, reducedMotion)) {
      if (this.#staticReason === "reduced-motion") return;
      this.#installGraph();
      this.#staticReason = "reduced-motion";
      this.#preparationDeadline.cancel(abortError());
      await this.#recoverStatic("reduced-motion");
      return;
    }
    if (this.#staticReason === "reduced-motion") {
      if (this.#restartRequested) return;
      const state = this.#requireGraph().snapshot().requestedState;
      if (state !== null) {
        this.#restartRequested = true;
        this.#input.onRestart(state);
      }
      return;
    }
    if (this.#staticReason === null) await this.resume();
  }

  public async suspend(
    reason: "visibility-suspended"
  ): Promise<RuntimeReadinessResult> {
    if (this.#terminalWork !== null) throw await this.#terminalWork;
    if (this.#disposed) throw abortError();
    this.#installGraph();
    this.#staticReason = reason;
    this.#preparationDeadline.cancel(abortError());
    const result = await this.#recoverStatic(reason);
    this.#preparation = Promise.resolve(result);
    return result;
  }

  public setVisibility(visible: boolean): void {
    this.#visible = visible;
    if (visible) {
      this.#resetClock();
      this.#schedule();
    }
    else this.#cancelFrame();
  }

  public contextChanged(state: "lost" | "restored" | "error"): void {
    if (this.#disposed || this.#failed || this.#staticReason !== null) return;
    if (state === "restored") {
      this.#contextRestored();
      return;
    }
    if (state === "lost") {
      this.#awaitingContextRestore = true;
      this.#contextLosses += 1;
      this.#cancelFrame();
      return;
    }
    void this.#terminate("context-loss", "render");
  }

  public resize(width: number, height: number, dpr: number, fit: string): void {
    const renderer = this.#renderer;
    if (renderer === null) return;
    try {
      renderer.resize(width, height, dpr, fit);
      this.#reportResourceBytes();
    } catch (error) {
      void this.#terminate(
        admissionFailure(error) ? "resource-rejection" : playbackFailureCode(error),
        "resize"
      );
    }
  }

  public snapshot(trace: boolean): Readonly<PlayerSnapshot> {
    const asset = this.#asset.snapshot();
    const decoders = this.#decoders?.snapshot() ?? {
      workerCount: 0,
      openFrames: 0,
      openFrameBytes: 0,
      decoderDiagnostics: Object.freeze([])
    };
    this.#captureDecoderDiagnostics(decoders.decoderDiagnostics);
    const presentation = (this.#renderer ?? this.#retiredRenderer)?.snapshot() ?? {
      cssWidth: 0,
      cssHeight: 0,
      backingWidth: 0,
      backingHeight: 0,
      effectiveDprX: 0,
      effectiveDprY: 0,
      contextLossCount: 0,
      contextRecoveryCount: 0,
      stagingBytes: 0,
      residentBytes: 0,
      textureBytes: 0,
      runtimeBytes: 0,
      pendingOperations: 0,
      sourceCopiesInFlight: 0,
      resourceCount: 0,
      contextListenerCount: 0
    };
    const graph = this.#graph?.snapshot();
    return Object.freeze({
      requestedState: graph?.requestedState ?? null,
      visualState: graph?.visualState ?? null,
      transitioning: graph?.isTransitioning ?? false,
      selectedRendition: this.#staticReason === null ? this.#rendition.id : null,
      selectedCodec: this.#staticReason === null ? this.#rendition.codec : null,
      selectedBitDepth: this.#staticReason === null ? this.#rendition.bitDepth : null,
      transportMode: asset.mode,
      declaredFileBytes: asset.declaredFileBytes,
      metadataBytes: asset.metadataBytes,
      verifiedBytes: asset.verifiedBytes,
      residentBlobBytes: asset.residentBlobBytes,
      activeTransportBodies: asset.activeTransportBodies,
      pendingLoads: asset.pendingLoads,
      interestedWaiters: asset.interestedWaiters,
      workerCount: decoders.workerCount,
      openFrames: decoders.openFrames,
      contextLossCount: Math.max(this.#contextLosses, presentation.contextLossCount),
      contextRecoveryCount: Math.max(
        this.#contextRecoveries,
        presentation.contextRecoveryCount
      ),
      cleanupFailureCount: this.#cleanupFailureCount,
      decoderDiagnostics: this.#decoderDiagnostics,
      presentation,
      trace: trace ? Object.freeze([...this.#trace]) : Object.freeze([])
    });
  }

  public async settled(): Promise<void> {
    await Promise.allSettled([
      ...this.#resident.values(),
      this.#routePrefetch.settled(),
      ...(this.#terminalWork === null ? [] : [this.#terminalWork])
    ]);
    await (this.#renderer ?? this.#retiredRenderer)?.settled();
  }

  public async dispose(): Promise<void> {
    if (!this.#disposed) {
      this.#disposed = true;
      this.#animationGeneration += 1;
      this.#input.canvas.removeEventListener(
        "webglcontextrestored",
        this.#contextRestored
      );
      this.#preparationDeadline.dispose();
      this.#cancelFrame();
      const graph = this.#graph;
      if (graph !== null && graph.snapshot().readiness !== "disposed") {
        this.#applyWithoutDraw(graph.dispose({
          ...(graph.snapshot().visualState === null
            ? {}
            : { retainedVisualState: graph.snapshot().visualState! })
        }));
      }
      this.#rejectRequests("AbortError");
    }
    if (this.#animationResourcesRetired) return;
    await this.#retireAnimationResources();
  }

  async #prepareBounded(): Promise<PrepareResult> {
    try {
      const result = await limit(this.#start(), this.#preparationDeadline.signal);
      this.#prepared = true;
      this.#preparationDeadline.complete();
      return result;
    } catch (error) {
      if (this.#disposed || this.#input.signal.aborted) {
        throw playerAbortReason(this.#input.signal);
      }
      if (this.#terminalWork !== null) throw await this.#terminalWork;
      if (policyReason(this.#staticReason)) {
        return this.#recoverStatic(this.#staticReason);
      }
      const code = this.#preparationDeadline.timedOut
        ? "watchdog-timeout" : admissionFailure(error)
          ? "resource-rejection" : preparationFailureCode(error);
      throw await this.#terminate(code, "prepare");
    }
  }

  #installGraph(): MotionGraphEngine {
    if (this.#graph !== null) return this.#graph;
    const initial = this.#states.get(this.#input.initialState ?? this.#manifest.initialState);
    if (initial === undefined) throw new RangeError("Unknown initial AVAL state");
    const graph = createGraphEngine(
      this.#manifest,
      initial.id,
      this.#input.initialBody
    );
    this.#graph = graph;
    this.#seedInitial(graph.snapshot());
    return graph;
  }

  async #start(): Promise<PrepareResult> {
    const graph = this.#installGraph();
    if (this.#preparationDeadline.timedOut) throw preparationTimeout();
    if (this.#staticReason !== null) {
      this.#applyWithoutDraw(graph.beginStatic(this.#staticReason));
      await this.#retireAnimationResources();
      const terminal = this.#terminalWork;
      if (terminal !== null) throw await terminal;
      return this.#result();
    }
    this.#preparationDeadline.signal.throwIfAborted();
    const plan = createReadinessPlan(
      this.#manifest,
      this.#rendition.id,
      this.#asset.blobs
    );
    this.#plan = plan;
    const preparation = this.#prepareLiveStart(plan);
    this.#preparationMediaWork = preparation;
    try { this.#initialMedia = await preparation; }
    finally {
      if (this.#preparationMediaWork === preparation) {
        this.#preparationMediaWork = null;
      }
    }
    this.#preparationDeadline.signal.throwIfAborted();
    const animated = graph.beginAnimated();
    const required = this.#requiredCandidate(animated.presentation);
    const replacement = required === null ? null : this.#reserveStream(required);
    await this.#applyWithDraw(
      animated,
      true,
      this.#input.platform.now(),
      null,
      replacement
    );
    this.#prepareRoutes(graph.snapshot());
    this.#input.onReadiness("visualReady");
    this.#input.onReadiness("interactiveReady");
    this.#resetClock();
    this.#schedule();
    return this.#result();
  }

  #recoverStatic(reason: StaticReason): Promise<PrepareResult> {
    if (!policyReason(reason)) {
      return Promise.reject(new Error("AVAL static recovery is limited to policy suspension"));
    }
    if (this.#recovery !== null) return this.#recovery;
    this.#animationGeneration += 1;
    const operation = Promise.resolve().then(() => this.#performRecovery(reason));
    this.#recovery = operation;
    void operation.finally(() => {
      if (this.#recovery === operation) this.#recovery = null;
    }).catch(() => undefined);
    return operation;
  }

  async #performRecovery(reason: StaticReason): Promise<PrepareResult> {
    if (this.#disposed) throw abortError();
    this.#staticReason = reason;
    this.#cancelFrame();
    const graph = this.#installGraph();
    const snapshot = graph.snapshot();
    let recovery: Readonly<MotionGraphResult> | null = null;
    if (snapshot.readiness === "preparing") {
      recovery = graph.beginStatic(reason);
    } else if (snapshot.readiness !== "disposed" && snapshot.readiness !== "error") {
      recovery = graph.recoverStatic(reason, {
        ...(snapshot.visualState === null
          ? {}
          : { retainedVisualState: snapshot.visualState })
      });
    }
    if (recovery !== null) this.#applyWithoutDraw(recovery);
    await this.#retireAnimationResources();
    const terminal = this.#terminalWork;
    if (terminal !== null) throw await terminal;
    this.#prepared = true;
    this.#preparationDeadline.complete();
    const result = this.#result();
    this.#preparation = Promise.resolve(result);
    return result;
  }

  async #prepareLiveStart(plan: Readonly<ReadinessPlan>): Promise<Readonly<{
    unit: Unit;
    run: DecodeRun;
  }>> {
    const decoders = this.#decoders;
    const renderer = this.#renderer;
    if (decoders === null || renderer === null) {
      throw new Error("AVAL animation resources are unavailable");
    }
    const generation = this.#animationGeneration;
    for (const resident of plan.resident) {
      this.#preparationDeadline.signal.throwIfAborted();
      const unit = this.#unit(resident.unit);
      await this.#cacheResidentFrames(unit, new Set(resident.frames));
      this.#assertAnimation(generation, renderer, decoders);
      if (unit.kind === "reversible") this.#residentReady.add(unit.id);
      this.#reportResourceBytes();
    }
    const state = this.#state(
      this.#input.initialState ?? this.#manifest.initialState
    );
    const initial = this.#unit(
      this.#input.initialBody || state.initialUnit === undefined
        ? state.bodyUnit
        : state.initialUnit
    );
    const run = await this.#newRun(initial, this.#preparationDeadline.signal);
    try {
      await run.ready();
      this.#assertAnimation(generation, renderer, decoders);
      this.#assertRuntimeBudget();
      return Object.freeze({ unit: initial, run });
    } catch (error) {
      run.close();
      throw error;
    }
  }

  async #cacheResidentFrames(
    unit: Unit,
    keep: ReadonlySet<number>
  ): Promise<void> {
    const renderer = this.#renderer;
    const decoders = this.#decoders;
    if (renderer === null || decoders === null) {
      throw new Error("AVAL animation resources are unavailable");
    }
    const generation = this.#animationGeneration;
    const run = await this.#newRun(unit, this.#preparationDeadline.signal);
    this.#assertAnimation(generation, renderer, decoders);
    try {
      for (let index = 0; index < run.frameCount; index += 1) {
        this.#preparationDeadline.signal.throwIfAborted();
        const frame = await run.take(index);
        this.#assertAnimation(generation, renderer, decoders);
        try {
          if (keep.has(index)) {
            if (!this.#hasResident(unit.id, index)) {
              await renderer.store(unit.id, index, frame);
              this.#assertAnimation(generation, renderer, decoders);
              this.#reportResourceBytes();
              const resident = this.#residentFrames.get(unit.id) ?? new Set<number>();
              resident.add(index);
              this.#residentFrames.set(unit.id, resident);
            }
          }
        } finally { this.#release(run, frame); }
      }
      await run.complete();
      this.#assertAnimation(generation, renderer, decoders);
    } finally { run.close(); }
  }

  #assertRuntimeBudget(): void {
    const asset = this.#asset.snapshot();
    const renderer = this.#renderer?.snapshot();
    if (renderer === undefined) throw new Error("AVAL renderer is unavailable");
    const decoders = this.#decoders?.snapshot();
    const encodedBytes = encodedCopyCeiling(this.#asset, this.#rendition);
    const surfaceBytes = decodedSurfaceBytes(this.#manifest, this.#rendition);
    const aggregate = checkedTotal([
      asset.metadataBytes,
      asset.residentBlobBytes,
      encodedBytes,
      Math.max(
        decoders?.openFrameBytes ?? 0,
        checkedTotal(Array.from(
          { length: ELEMENT_DECODER_CAPACITY.totalDecodedSurfaces },
          () => surfaceBytes
        ))
      ),
      renderer.runtimeBytes
    ]);
    if (aggregate > this.#manifest.limits.maxRuntimeBytes) {
      throw resourceBudgetError();
    }
  }

  #retireAnimationResources(): Promise<void> {
    if (this.#animationResourcesRetired) return Promise.resolve();
    if (this.#animationResourceRetirement !== null) {
      return this.#animationResourceRetirement;
    }
    const operation = this.#performAnimationResourceRetirement();
    this.#animationResourceRetirement = operation;
    const clear = (): void => {
      if (this.#animationResourceRetirement === operation) {
        this.#animationResourceRetirement = null;
      }
    };
    void operation.then(clear, clear);
    return operation;
  }

  async #performAnimationResourceRetirement(): Promise<void> {
    this.#cancelFrame();
    this.#preparationDeadline.cancel(abortError());
    const active = this.#active;
    const initialMedia = this.#initialMedia;
    this.#initialMedia = null;
    initialMedia?.run.close();
    this.#closeActive(active);
    if (this.#active === active) this.#active = null;
    const prefetched = this.#routePrefetch.retire();
    const renderer = this.#renderer;
    await Promise.allSettled([
      ...(this.#advanceWork === null ? [] : [this.#advanceWork]),
      ...(this.#preparationMediaWork === null ? [] : [this.#preparationMediaWork]),
      ...(active?.kind === "stream" ? [active.drain] : []),
      prefetched,
      ...this.#resident.values(),
      ...(renderer === null ? [] : [renderer.settled()])
    ]);
    const decoders = this.#decoders;
    if (decoders !== null) {
      this.#captureDecoderDiagnostics(decoders.snapshot().decoderDiagnostics);
      decoders.dispose();
    }
    this.#decoders = null;
    renderer?.dispose();
    this.#renderer = null;
    if (renderer !== null) this.#retiredRenderer = renderer;
    this.#resident.clear();
    this.#residentReady.clear();
    this.#residentFrames.clear();
    await this.#asset.dispose();
    reportResourceBytes(this.#input, null);
    this.#input.onAnimationResourcesRetired();
    this.#animationResourcesRetired = true;
  }

  #reportResourceBytes(): void {
    reportResourceBytes(
      this.#input,
      this.#asset,
      checkedTotal([
        this.#decoders?.snapshot().openFrameBytes ?? 0,
        this.#decoders?.encodedBytes ?? 0
      ]),
      this.#renderer,
      true
    );
  }

  #hasResident(unit: string, frame: number): boolean {
    return this.#residentFrames.get(unit)?.has(frame) === true;
  }

  #result() {
    const candidates = Object.freeze([
      ...this.#candidateReports,
      ...(this.#reportCurrent
        ? [candidateReport(
            this.#rendition.id,
            this.#candidateRank,
            this.#staticReason
          )]
        : [])
    ]);
    if (this.#staticReason !== null) {
      return Object.freeze({
        mode: "static" as const,
        reason: this.#staticReason,
        report: Object.freeze({
          readiness: "staticReady" as const,
          selectedRendition: null,
          candidates
        })
      });
    }
    return Object.freeze({
      mode: "animated" as const,
      assurance: "best-effort" as const,
      report: Object.freeze({
        readiness: "interactiveReady" as const,
        selectedRendition: this.#rendition.id,
        candidates
      })
    });
  }

  #schedule(): void {
    const graph = this.#graph;
    const snapshot = graph?.snapshot();
    if (
      this.#disposed || this.#failed || this.#paused || !this.#visible ||
      this.#staticReason !== null || this.#raf !== null || graph === null ||
      snapshot?.readiness !== "animated" || !this.#needsTick(snapshot)
    ) return;
    this.#raf = this.#input.platform.requestAnimationFrame((time) => {
      this.#raf = null;
      if (time < this.#deadline || this.#busy) {
        this.#schedule();
        return;
      }
      this.#busy = true;
      const work = this.#advance();
      this.#advanceWork = work;
      void work.then((outcome) => {
        if (outcome === "progressed") this.#nextDeadline();
      }).catch((error) => this.#fail(error)).finally(() => {
        if (this.#advanceWork === work) this.#advanceWork = null;
        this.#busy = false;
        this.#schedule();
      });
    });
  }

  #cancelFrame(): void {
    if (this.#raf !== null) this.#input.platform.cancelAnimationFrame(this.#raf);
    this.#raf = null;
  }

  async #advance(): Promise<AdvanceOutcome> {
    this.#routePrefetch.wake();
    const callbackStart = this.#input.platform.now();
    const rationalDeadlineUs = Math.round(this.#deadline * 1000);
    const graph = this.#requireGraph();
    const before = graph.snapshot();
    const departure = this.#departure(before);
    const routeReady = departure === null || this.#departureReady(departure);
    const waiting = !routeReady && routeWaitBlocksPresentation(
      before.presentation,
      departure,
      before.presentation?.kind === "body"
        ? this.#unit(before.presentation.unitId)
        : null
    );
    if (waiting) return this.#waitForRoute(before);
    const tick = {
      contentOrdinal: this.#ordinal,
      routeReady
    };
    const preview = graph.previewTick(tick);
    const required = this.#requiredCandidate(preview.presentation);
    if (required !== null && !this.#routePrefetch.isReady(required.id)) {
      this.#prepareRoutes(before, required);
      return this.#waitForRoute(before);
    }
    this.#inUnderflow = false;
    const replacement = required === null ? null : this.#reserveStream(required);
    try {
      const result = graph.tick(tick);
      if (!sameGraphPresentation(preview.presentation, result.presentation)) {
        throw new Error("AVAL graph preview diverged from its committed tick");
      }
      this.#ordinal += 1n;
      await this.#applyWithDraw(
        result,
        routeReady,
        callbackStart,
        rationalDeadlineUs,
        replacement
      );
      this.#prepareRoutes(graph.snapshot());
      return "progressed";
    } catch (error) {
      this.#cancelReservation(replacement);
      throw error;
    }
  }

  #waitForRoute(snapshot: Readonly<MotionGraphSnapshot>): AdvanceOutcome {
    if (!this.#inUnderflow) {
      this.#inUnderflow = true;
      this.#underflows += 1;
      this.#incidents += 1;
      this.#input.onEvent("underflow", Object.freeze({
        incident: this.#incidents,
        heldPresentationOrdinal: this.#ordinal.toString(),
        cumulativeCount: this.#underflows,
        isTransitioning: snapshot.isTransitioning
      }));
    }
    return "waiting-route";
  }

  #needsTick(snapshot: Readonly<MotionGraphSnapshot>): boolean {
    if (snapshot.phase !== "stable") return snapshot.phase !== "static";
    if (snapshot.pendingEdgeId !== null || snapshot.activeEdgeId !== null ||
      snapshot.followOnEdgeId !== null) return true;
    const presentation = snapshot.presentation;
    if (presentation?.kind !== "body") return presentation !== null;
    const unit = this.#unit(presentation.unitId);
    if (unit.kind !== "body") return true;
    if (unit.playback === "loop" || presentation.frameIndex < unit.frameCount - 1) {
      return true;
    }
    return this.#edges.some((edge) =>
      edge.from === presentation.state && edge.trigger?.type === "completion"
    );
  }

  #resetClock(now = this.#input.platform.now()): void {
    this.#clockOrigin = now;
    this.#clockOrdinal = this.#ordinal;
    this.#deadline = this.#rationalDeadline(this.#ordinal + 1n);
  }

  #nextDeadline(): void {
    const next = this.#rationalDeadline(this.#ordinal + 1n);
    if (next <= this.#input.platform.now()) this.#resetClock();
    else this.#deadline = next;
  }

  #rationalDeadline(ordinal: bigint): number {
    const delta = ordinal - this.#clockOrdinal;
    if (delta < 0n || delta > 1_000_000n) {
      this.#clockOrigin = this.#input.platform.now();
      this.#clockOrdinal = this.#ordinal;
      return this.#clockOrigin + this.#frameMs();
    }
    return this.#clockOrigin + Number(delta) * 1_000 *
      this.#manifest.frameRate.denominator /
      this.#manifest.frameRate.numerator;
  }

  #register(result: Readonly<MotionGraphResult>): Promise<void> {
    const id = result.requestId;
    if (id === undefined || this.#requests.has(id)) {
      throw new Error("Invalid AVAL graph request");
    }
    return new Promise<void>((resolve, reject) => {
      this.#requests.set(id, { resolve, reject });
    });
  }

  #seedInitial(snapshot: Readonly<MotionGraphSnapshot>): void {
    const state = snapshot.requestedState;
    if (state === null || snapshot.visualState !== state) {
      throw new Error("Invalid AVAL graph");
    }
    this.#input.onEvent("requestedstatechange", Object.freeze({
      from: state,
      to: state,
      sequence: 0,
      isTransitioning: false
    }));
    this.#input.onEvent("visualstatechange", Object.freeze({
      from: state,
      to: state,
      isTransitioning: false
    }));
  }

  #applyWithoutDraw(result: Readonly<MotionGraphResult>): void {
    for (const effect of result.effects) this.#applyEffect(effect, result.snapshot);
  }

  async #applyWithDraw(
    result: Readonly<MotionGraphResult>,
    routeReady: boolean,
    callbackStart: number,
    rationalDeadlineUs: number | null,
    replacement: StreamReservation | null
  ): Promise<void> {
    const generation = this.#animationGeneration;
    const renderer = this.#renderer;
    const decoders = this.#decoders;
    if (renderer === null || decoders === null) {
      throw new Error("AVAL animation resources are unavailable");
    }
    const presentation = result.presentation;
    if (presentation === null) throw new Error("Invalid AVAL graph presentation");
    try {
      const post: Readonly<MotionGraphEffect>[] = [];
      for (const effect of result.effects) {
        if (postDraw(effect)) post.push(effect);
        else this.#applyEffect(effect, result.snapshot);
      }
      await this.#draw(presentation, generation, renderer, decoders, replacement);
      this.#assertAnimation(generation, renderer, decoders);
      const submissionComplete = this.#input.platform.now();
      for (const effect of post) {
        this.#assertAnimation(generation, renderer, decoders);
        this.#applyEffect(effect, result.snapshot);
      }
      this.#assertAnimation(generation, renderer, decoders);
      this.#record(
        result,
        routeReady,
        callbackStart,
        submissionComplete,
        rationalDeadlineUs
      );
    } catch (error) {
      this.#cancelReservation(replacement);
      throw error;
    }
  }

  #applyEffect(
    effect: Readonly<MotionGraphEffect>,
    snapshot: Readonly<MotionGraphSnapshot>
  ): void {
    if (effect.type === "readinesschange") {
      if (effect.to === "static") {
        this.#input.onReadiness("staticReady", effect.reason);
      }
      return;
    }
    if (effect.type === "settle") {
      const capabilities = effect.requestIds.map((id) => {
        const capability = this.#requests.get(id);
        if (capability === undefined) throw new Error("Invalid AVAL request settlement");
        this.#requests.delete(id);
        return capability;
      });
      this.#settledRequests += capabilities.length;
      queueMicrotask(() => {
        for (const capability of capabilities) {
          if (effect.outcome.type === "resolve") capability.resolve();
          else capability.reject(requestError(effect.outcome.error));
        }
      });
      return;
    }
    if (effect.type === "requestedstatechange") {
      this.#input.onEvent(effect.type, Object.freeze({
        from: effect.from,
        to: effect.to,
        sequence: effect.sequence,
        isTransitioning: snapshot.isTransitioning
      }));
      return;
    }
    this.#input.onEvent(effect.type, Object.freeze({
      ...(effect.type === "transitionstart"
        ? { edge: effect.edgeId, from: effect.from, to: effect.to,
            sequence: effect.sequence }
        : effect.type === "transitionend"
          ? { edge: effect.edgeId, from: effect.from, to: effect.to }
          : { from: effect.from, to: effect.to }),
      isTransitioning: effect.type === "transitionstart"
        ? true : snapshot.isTransitioning
    }));
  }

  async #draw(
    presentation: Readonly<GraphPresentation>,
    generation: number,
    renderer: Renderer,
    decoders: DecoderPool,
    replacement: StreamReservation | null
  ): Promise<void> {
    if (presentation.kind === "static") {
      if (replacement !== null) throw new Error("Invalid AVAL stream replacement");
      return;
    }
    this.#assertAnimation(generation, renderer, decoders);
    const key = `${presentation.kind}\0${presentation.unitId}\0${String(presentation.frameIndex)}`;
    if (key === this.#lastDraw) {
      if (replacement !== null) throw new Error("Invalid AVAL stream replacement");
      return;
    }
    const unit = this.#unit(presentation.unitId);
    if (presentation.kind === "reversible") {
      if (replacement !== null) throw new Error("Invalid AVAL stream replacement");
      await this.#ensureResident(unit);
      this.#assertAnimation(generation, renderer, decoders);
      const previous = this.#active;
      const resident = previous?.kind === "resident" && previous.unit.id === unit.id
        ? previous
        : {
          kind: "resident" as const,
          unit,
          lastIndex: -1
        };
      await renderer.drawStored(unit.id, presentation.frameIndex);
      this.#assertAnimation(generation, renderer, decoders);
      resident.lastIndex = presentation.frameIndex;
      if (resident !== previous) {
        this.#active = resident;
        this.#closeActive(previous);
      }
    } else {
      const previous = this.#active;
      const replacing = previous === null || previous.kind === "resident" ||
        previous.unit.id !== unit.id || presentation.frameIndex <= previous.lastIndex;
      if (replacing !== (replacement !== null)) {
        throw new Error("Invalid AVAL stream replacement");
      }
      const active = replacement?.media ?? previous;
      if (active === null || active.kind !== "stream" || active.unit.id !== unit.id) {
        throw new Error("Invalid AVAL stream replacement");
      }
      if (this.#hasResident(unit.id, presentation.frameIndex)) {
        await renderer.drawStored(unit.id, presentation.frameIndex);
        this.#assertAnimation(generation, renderer, decoders);
      } else {
        if (active.drainedIndex < presentation.frameIndex - 1) {
          this.#drainThrough(active, presentation.frameIndex - 1);
        }
        await active.drain;
        this.#assertAnimation(generation, renderer, decoders);
        const run = active.run;
        const frame = await run.take(presentation.frameIndex);
        try {
          this.#assertAnimation(generation, renderer, decoders);
          await renderer.draw(frame);
          this.#assertAnimation(generation, renderer, decoders);
        }
        finally { this.#release(run, frame); }
        active.drainedIndex = presentation.frameIndex;
      }
      this.#assertAnimation(generation, renderer, decoders);
      active.lastIndex = presentation.frameIndex;
      if (replacing) {
        if (replacement === null) throw new Error("Invalid AVAL stream replacement");
        if (replacement.kind === "candidate") replacement.candidate.commit();
        this.#active = active;
        if (replacement.kind === "foreground") this.#closeActive(previous);
      }
      if (this.#hasResident(unit.id, presentation.frameIndex)) {
        this.#drainThrough(active, presentation.frameIndex);
      }
    }
    this.#assertAnimation(generation, renderer, decoders);
    this.#lastDraw = key;
    if (this.#firstFrame) {
      this.#assertAnimation(generation, renderer, decoders);
      this.#firstFrame = false;
      this.#input.onDraw();
    }
  }

  #assertAnimation(
    generation: number,
    renderer: Renderer,
    decoders: DecoderPool
  ): void {
    if (this.#disposed || this.#failed || this.#staticReason !== null ||
      this.#animationGeneration !== generation || this.#renderer !== renderer ||
      this.#decoders !== decoders) throw abortError();
  }

  #reserveStream(unit: Unit): StreamReservation {
    const initial = this.#initialMedia;
    if (initial?.unit.id === unit.id) {
      this.#initialMedia = null;
      return Object.freeze({
        kind: "foreground" as const,
        media: this.#streamMedia(unit, initial.run)
      });
    }
    const candidate = this.#routePrefetch.claim(unit.id);
    if (candidate === undefined) {
      throw new Error("AVAL candidate route is unavailable");
    }
    if (candidate.unitId !== unit.id) {
      candidate.cancel();
      throw new Error("AVAL candidate route identity diverged");
    }
    return Object.freeze({
      kind: "candidate" as const,
      media: this.#streamMedia(this.#unit(candidate.unitId), candidate.run),
      candidate
    });
  }

  #streamMedia(unit: Unit, run: DecodeRun): StreamMedia {
    return {
      kind: "stream",
      unit,
      run,
      lastIndex: -1,
      drainedIndex: -1,
      drain: Promise.resolve()
    };
  }

  #cancelReservation(reservation: StreamReservation | null): void {
    if (reservation === null) return;
    if (reservation.kind === "candidate") reservation.candidate.cancel();
    else reservation.media.run.close();
  }

  #drainThrough(active: StreamMedia, index: number): void {
    active.drain = active.drain.then(async () => {
      const run = active.run;
      for (let cursor = active.drainedIndex + 1; cursor <= index; cursor += 1) {
        const frame = await run.take(cursor);
        this.#release(run, frame);
        active.drainedIndex = cursor;
      }
    });
    void active.drain.catch((error) => {
      if (!isAbort(error)) this.#fail(error);
    });
  }

  #closeActive(active: ActiveMedia | null): void {
    if (active?.kind === "stream") active.run.close();
  }

  #prepareRoutes(
    snapshot: Readonly<MotionGraphSnapshot>,
    required: Unit | null = null
  ): void {
    if (this.#staticReason !== null || this.#disposed || this.#failed) return;
    const active = this.#active;
    const pending = this.#edge(snapshot.pendingEdgeId);
    const plan = planRoutePrefetch(
      this.#manifest,
      snapshot,
      active === null
        ? null
        : {
            unitId: active.unit.id,
            mode: active.kind
          },
      ELEMENT_DECODER_CAPACITY.ringSize,
      pending !== null && this.#departureReady(pending)
    );
    for (const unit of plan.resident) void this.#ensureResident(unit);
    if (required === null) {
      this.#routePrefetch.reconcile(plan.decode);
      return;
    }
    const planned = plan.decode.find(({ unit }) => unit.id === required.id);
    const priority = planned ?? Object.freeze({
      unit: required,
      reason: "presentation-continuation" as const
    });
    this.#routePrefetch.reconcile([
      priority,
      ...plan.decode.filter(({ unit }) => unit.id !== required.id)
    ].slice(0, MAX_ROUTE_PREFETCH_INTENTS));
  }

  #requiredCandidate(presentation: Readonly<GraphPresentation> | null): Unit | null {
    if (
      presentation === null || presentation.kind === "static" ||
      presentation.kind === "reversible"
    ) return null;
    const key = `${presentation.kind}\0${presentation.unitId}\0${String(presentation.frameIndex)}`;
    if (key === this.#lastDraw) return null;
    const unit = this.#unit(presentation.unitId);
    const active = this.#active;
    return active === null || active.kind === "resident" || active.unit.id !== unit.id ||
      presentation.frameIndex <= active.lastIndex ? unit : null;
  }

  #departure(snapshot: Readonly<MotionGraphSnapshot>): Readonly<Edge> | null {
    const pending = this.#edge(snapshot.pendingEdgeId);
    if (pending !== null) return pending;
    const presentation = snapshot.presentation;
    if (snapshot.phase !== "stable" || presentation?.kind !== "body") return null;
    const unit = this.#unit(presentation.unitId);
    if (presentation.frameIndex !== unit.frameCount - 1) return null;
    return this.#edges.find((edge) =>
      edge.from === presentation.state && edge.trigger?.type === "completion"
    ) ?? null;
  }

  #departureReady(edge: Readonly<Edge>): boolean {
    if (edge.start.type === "cut") {
      const route = this.#plan?.routes.find(({ edge: id }) => id === edge.id);
      if (
        route === undefined || !route.targetFrames.every((frame) =>
          this.#hasResident(route.targetUnit, frame)
        )
      ) return false;
      const transition = edge.transition;
      return transition?.kind === "reversible"
        ? this.#residentReady.has(transition.unit)
        : this.#routePrefetch.isReady(transition?.unit ?? route.targetUnit);
    }
    const transition = edge.transition;
    if (transition?.kind === "reversible") {
      return this.#residentReady.has(transition.unit);
    }
    const unit = transition === undefined
      ? this.#state(edge.to).bodyUnit
      : transition.unit;
    return this.#routePrefetch.isReady(unit);
  }

  async #newRun(
    unit: Unit,
    signal: AbortSignal = this.#preparationDeadline.signal
  ): Promise<DecodeRun> {
    await this.#preloadRun(unit, signal);
    signal.throwIfAborted();
    return this.#createLoadedRun(unit, "foreground");
  }

  async #preloadRun(unit: Unit, signal: AbortSignal): Promise<void> {
    if (this.#decoders === null) throw new Error("AVAL decoder is unavailable");
    this.#unitSpan(unit);
    await this.#asset.unitBytes(this.#rendition.id, unit.id, signal);
    signal.throwIfAborted();
    this.#reportResourceBytes();
  }

  #createLoadedRun(unit: Unit, role: "foreground"): DecodeRun;
  #createLoadedRun(unit: Unit, role: "candidate"): DecoderPoolCandidate;
  #createLoadedRun(
    unit: Unit,
    role: "foreground" | "candidate"
  ): DecodeRun | DecoderPoolCandidate {
    const decoders = this.#decoders;
    if (decoders === null) throw new Error("AVAL decoder is unavailable");
    const span = this.#unitSpan(unit);
    const copyBytes = encodedUnitCopyBytes(this.#asset, span);
    const decoderBytes = checkedTotal([
      decoders.snapshot().openFrameBytes,
      decoders.encodedBytes,
      copyBytes
    ]);
    if (resourceBytes(this.#asset, decoderBytes, this.#renderer) >
      this.#manifest.limits.maxRuntimeBytes) {
      throw resourceBudgetError();
    }
    const samples: DecodeSample[] = [];
    for (let index = 0; index < span.chunkCount; index += 1) {
      const record = this.#asset.records[span.chunkStart + index];
      if (record === undefined) throw new Error("Invalid AVAL asset");
      samples.push({
        data: this.#asset.chunkBytes(this.#rendition.id, unit.id, index),
        timestamp: record.presentationTimestamp,
        duration: record.duration,
        key: record.randomAccess,
        displayedFrames: record.displayedFrameCount
      });
    }
    if (!this.#validated.has(unit.id)) {
      this.#validator.validate(samples.map((sample) => ({
        bytes: new Uint8Array(sample.data),
        timestamp: sample.timestamp,
        key: sample.key,
        displayedFrames: sample.displayedFrames
      })));
      this.#validated.add(unit.id);
      if (this.#validated.size === this.#units.size) this.#validator.complete();
    }
    if (role === "foreground") {
      const run = decoders.createForegroundRun(samples);
      this.#rememberDecoderUnit(run, unit.id);
      this.#reportResourceBytes();
      if (run.frameCount !== unit.frameCount) {
        run.close();
        throw new Error("Invalid AVAL asset");
      }
      return run;
    }
    const candidate = decoders.createCandidate(unit.id, samples);
    this.#rememberDecoderUnit(candidate.run, unit.id);
    this.#reportResourceBytes();
    if (candidate.run.frameCount !== unit.frameCount) {
      candidate.cancel();
      throw new Error("Invalid AVAL asset");
    }
    return candidate;
  }

  #unitSpan(unit: Unit): Unit["chunks"][number] {
    const span = unit.chunks.find(({ rendition }) => rendition === this.#rendition.id);
    if (span === undefined) throw new Error("Invalid AVAL asset");
    return span;
  }

  #rememberDecoderUnit(run: DecodeRun, unit: string): void {
    const decoders = this.#decoders;
    if (decoders === null) return;
    const { lane } = decoders.identity(run);
    this.#decoderUnitByLane[lane] = Object.freeze({
      run: run.generation,
      unit
    });
  }

  #captureDecoderDiagnostics(
    diagnostics: readonly Readonly<DecoderPoolDiagnostic>[]
  ): void {
    if (diagnostics === this.#capturedPoolDiagnostics) return;
    this.#capturedPoolDiagnostics = diagnostics;
    if (diagnostics.length === 0) return;
    this.#decoderDiagnostics = mergePlayerDecoderDiagnostics(
      this.#decoderDiagnostics,
      publishDecoderDiagnostics(
        this.#input,
        diagnostics,
        this.#sourceIndex,
        this.#rendition,
        (diagnostic) => {
          const current = this.#decoderUnitByLane[diagnostic.lane];
          return current !== null && current.run === diagnostic.run
            ? current.unit
            : null;
        }
      )
    );
  }

  #ensureResident(unit: Unit): Promise<void> {
    if (this.#residentReady.has(unit.id)) return Promise.resolve();
    const existing = this.#resident.get(unit.id);
    if (existing !== undefined) return existing;
    const operation = (async () => {
      const renderer = this.#renderer;
      const decoders = this.#decoders;
      if (renderer === null || decoders === null) {
        throw new Error("AVAL animation resources are unavailable");
      }
      const generation = this.#animationGeneration;
      const run = await this.#newRun(unit);
      this.#assertAnimation(generation, renderer, decoders);
      try {
        for (let index = 0; index < unit.frameCount; index += 1) {
          this.#preparationDeadline.signal.throwIfAborted();
          const frame = await run.take(index);
          this.#assertAnimation(generation, renderer, decoders);
          try {
            if (!this.#hasResident(unit.id, index)) {
              await renderer.store(unit.id, index, frame);
              this.#assertAnimation(generation, renderer, decoders);
              this.#reportResourceBytes();
              const resident = this.#residentFrames.get(unit.id) ?? new Set<number>();
              resident.add(index);
              this.#residentFrames.set(unit.id, resident);
            }
          }
          finally { this.#release(run, frame); }
        }
        await run.complete();
        this.#assertAnimation(generation, renderer, decoders);
        this.#residentReady.add(unit.id);
      } finally { run.close(); }
    })();
    this.#resident.set(unit.id, operation);
    void operation.catch((error) => {
      if (!isAbort(error)) this.#fail(error);
    });
    return operation;
  }

  #record(
    result: Readonly<MotionGraphResult>,
    routeReady: boolean,
    callbackStart: number,
    submissionComplete: number,
    rationalDeadlineUs: number | null
  ): void {
    const presentation = result.presentation === null
      ? null : Object.freeze({ ...result.presentation });
    const active = this.#active;
    if (active === null) throw new Error("Invalid AVAL media state");
    const runId = active.kind === "resident" || this.#decoders === null
      ? null : this.#decoders.identity(active.run).logicalId;
    const graphPresentation = result.presentation;
    const edgeId = graphPresentation !== null &&
      (graphPresentation.kind === "locked" || graphPresentation.kind === "reversible")
      ? graphPresentation.edgeId
      : result.effects.find((effect) => effect.type === "transitionstart")?.edgeId;
    const edge = edgeId === undefined ? null : this.#edge(edgeId);
    const path = edge?.id ?? (graphPresentation !== null &&
      (graphPresentation.kind === "body" || graphPresentation.kind === "intro" ||
        graphPresentation.kind === "static") ? graphPresentation.state : "graph");
    const frame = graphPresentation !== null && graphPresentation.kind !== "static"
      ? graphPresentation.frameIndex : 0;
    const index = this.#trace.length === 0 ? 1 : this.#trace.at(-1)!.index + 1;
    const record = Object.freeze({
      index,
      kind: result.operation === "tick" ? "content-tick" as const : "operation" as const,
      presentationOrdinal: result.snapshot.contentOrdinal?.toString() ?? null,
      rationalDeadlineUs,
      callbackStartMicroseconds: Math.round(callbackStart * 1000),
      canvasSubmissionCompleteMicroseconds: Math.round(submissionComplete * 1000),
      eligibleAnimationFrameOrdinal: null,
      graph: Object.freeze({
        operation: result.operation,
        snapshot: Object.freeze({
          ...result.snapshot,
          contentOrdinal: result.snapshot.contentOrdinal?.toString() ?? null
        }),
        presentation,
        effects: Object.freeze(result.effects.map((effect) =>
          Object.freeze({ ...effect })))
      }),
      routeReady,
      selectedBoundary: edge?.start.type ?? null,
      scheduler: Object.freeze({
        generation: runId,
        activePath: path,
        sourceCursor: null,
        submittedCursor: null,
        decodedCursor: null,
        displayedCursor: Object.freeze({
          path,
          unit: active.unit.id,
          unitInstance: runId ?? 0,
          localFrame: frame
        }),
        ringSize: this.#decoders?.snapshot().openFrames ?? 0,
        ringCapacity: ELEMENT_DECODER_CAPACITY.totalDecodedSurfaces,
        smoothSession: this.#incidents === 0
      }),
      submitted: Object.freeze([]),
      media: Object.freeze({
        kind: "frame",
        frame: Object.freeze({ unit: active.unit.id, localFrame: frame })
      }),
      readbackTag: `${graphPresentation?.kind ?? "static"}:${path}:${active.unit.id}:${String(frame)}`,
      readiness: "interactiveReady" as const,
      decodeLeadFrames: null,
      settledRequestIds: Object.freeze(result.effects.flatMap((effect) =>
        effect.type === "settle" ? effect.requestIds : [])),
      counters: Object.freeze({
        underflows: this.#underflows,
        settledRequests: this.#settledRequests,
        cleanedFrames: this.#cleanedFrames
      })
    }) satisfies AvalRuntimeTraceRecord;
    this.#trace.push(record);
    if (this.#trace.length > 512) this.#trace.splice(0, this.#trace.length - 512);
  }

  #release(run: DecodeRun, frame: VideoFrame): void {
    run.release(frame);
    this.#cleanedFrames += 1;
  }

  #frameMs(): number {
    return 1000 * this.#manifest.frameRate.denominator /
      this.#manifest.frameRate.numerator;
  }

  #state(id: string): State {
    const state = this.#states.get(id);
    if (state === undefined) throw new Error("Invalid AVAL graph");
    return state;
  }

  #unit(id: string): Unit {
    const unit = this.#units.get(id);
    if (unit === undefined) throw new Error("Invalid AVAL graph");
    return unit;
  }

  #edge(id: string | null): Readonly<Edge> | null {
    if (id === null) return null;
    const edge = this.#edgesById.get(id);
    if (edge === undefined) throw new Error("Invalid AVAL graph");
    return edge;
  }

  #requireGraph(): MotionGraphEngine {
    const graph = this.#graph;
    if (graph === null) throw new Error("AVAL graph is not prepared");
    return graph;
  }

  #rejectRequests(reason: string | Error): void {
    const error = typeof reason === "string" ? requestError(reason) : reason;
    for (const capability of this.#requests.values()) capability.reject(error);
    this.#requests.clear();
  }

  #fail(reason: unknown): void {
    if (this.#disposed || this.#failed) return;
    if (isAbort(reason) && (
      this.#input.signal.aborted ||
      this.#staticReason !== null ||
      this.#animationResourceRetirement !== null ||
      this.#animationResourcesRetired
    )) return;
    void this.#terminate(playbackFailureCode(reason), "playback");
  }

  #terminate(
    code: Parameters<PlayerInput["onPlaybackFailure"]>[0],
    operation: string
  ): Promise<AvalPlaybackError> {
    if (this.#terminalWork !== null) return this.#terminalWork;
    let resolveTerminal!: (error: AvalPlaybackError) => void;
    let rejectTerminal!: (reason: unknown) => void;
    const work = new Promise<AvalPlaybackError>((resolve, reject) => {
      resolveTerminal = resolve;
      rejectTerminal = reject;
    });
    this.#terminalWork = work;
    void work.catch(() => undefined);
    this.#failed = true;
    this.#animationGeneration += 1;
    void this.#finishTerminal(code, operation).then(
      resolveTerminal,
      rejectTerminal
    );
    return work;
  }

  async #finishTerminal(
    code: Parameters<PlayerInput["onPlaybackFailure"]>[0],
    operation: string
  ): Promise<AvalPlaybackError> {
    this.#cancelFrame();
    this.#awaitingContextRestore = false;
    this.#input.canvas.removeEventListener(
      "webglcontextrestored",
      this.#contextRestored
    );
    const graph = this.#graph;
    if (graph !== null && graph.snapshot().readiness !== "disposed") {
      try { graph.dispose(); }
      catch { /* cleanup cannot replace the canonical playback error */ }
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.#retireAnimationResources();
        break;
      } catch {
        this.#cleanupFailureCount = Math.min(
          Number.MAX_SAFE_INTEGER,
          this.#cleanupFailureCount + 1
        );
      }
    }
    if (this.#disposed || this.#input.signal.aborted) {
      const error = playerAbortReason(this.#input.signal);
      this.#rejectRequests(error);
      this.#rejectTerminalSignal(error);
      throw error;
    }
    const error = this.#input.onPlaybackFailure(code, operation);
    this.#rejectRequests(error);
    this.#rejectTerminalSignal(error);
    return error;
  }
}

function renderLayout(
  manifest: Readonly<Manifest>,
  rendition: Readonly<Rendition>
): Readonly<RenderLayout> {
  const color = rendition.alphaLayout.colorRect;
  const alpha = rendition.alphaLayout.type === "stacked"
    ? rendition.alphaLayout.alphaRect : undefined;
  const width = color[2] + color[2] % 2;
  const paneHeight = color[3] + color[3] % 2;
  const height = alpha === undefined ? paneHeight : paneHeight * 2 + 8;
  return Object.freeze({
    codedWidth: rendition.codedWidth,
    codedHeight: rendition.codedHeight,
    storageWidth: width,
    storageHeight: height,
    logicalWidth: manifest.canvas.width,
    logicalHeight: manifest.canvas.height,
    pixelAspect: manifest.canvas.pixelAspect,
    colorRect: color,
    ...(alpha === undefined ? {} : { alphaRect: alpha })
  });
}

function postDraw(effect: Readonly<MotionGraphEffect>): boolean {
  return effect.type === "transitionstart" || effect.type === "visualstatechange" ||
    effect.type === "transitionend" || effect.type === "settle";
}

function requestError(name: string): Error {
  const error = new Error(name === "AbortError"
    ? "AVAL state request was superseded"
    : name === "RouteError"
      ? "AVAL state route is unavailable"
      : "AVAL state request failed");
  error.name = name;
  return error;
}

function reportResourceBytes(
  input: Readonly<PlayerInput>,
  asset: Asset | null,
  decodedBytes = 0,
  renderer: Renderer | null = null,
  enforce = false
): void {
  if (asset === null) {
    input.onResourceBytes(0);
    return;
  }
  const bytes = resourceBytes(asset, decodedBytes, renderer);
  if (enforce && bytes > asset.manifest.limits.maxRuntimeBytes) {
    throw resourceBudgetError();
  }
  input.onResourceBytes(bytes);
}

function resourceBytes(
  asset: Asset,
  decoderBytes: number,
  renderer: Renderer | null
): number {
  const snapshot = asset.snapshot();
  return checkedTotal([
    snapshot.metadataBytes,
    snapshot.residentBlobBytes,
    decoderBytes,
    renderer?.snapshot().runtimeBytes ?? 0
  ]);
}

function encodedUnitCopyBytes(
  asset: Asset,
  span: Readonly<{ chunkStart: number; chunkCount: number }>
): number {
  let bytes = 0;
  for (let index = 0; index < span.chunkCount; index += 1) {
    const record = asset.records[span.chunkStart + index];
    if (record === undefined) throw new Error("Invalid AVAL asset");
    bytes = checkedTotal([bytes, record.length]);
  }
  return bytes;
}

function reduced(policy: string, host: boolean): boolean {
  return policy === "reduce" || policy === "auto" && host;
}

function sourceCodecFamily(codec: string): Manifest["codec"] {
  return codec.startsWith("av01.") ? "av1"
    : codec.startsWith("vp09.") ? "vp9"
      : codec.startsWith("hvc1.") ? "h265" : "h264";
}

function decodedSurfaceBytes(
  manifest: Readonly<Manifest>,
  rendition: Readonly<Rendition>
): number {
  return maximumDecodedRgbaBytes(
    manifest.codec,
    rendition.codedWidth,
    rendition.codedHeight
  );
}

export function routeWaitBlocksPresentation(
  presentation: Readonly<GraphPresentation> | null,
  departure: Readonly<{
    start: Readonly<{ type: Edge["start"]["type"] }>;
  }> | null,
  unit: Readonly<Unit> | null
): boolean {
  return departure !== null && presentation?.kind === "body" &&
    departure.start.type !== "cut" &&
    unit?.kind === "body" && unit.playback === "finite" &&
    presentation.frameIndex === unit.frameCount - 1;
}

/** Exact encoded-copy ceiling implied by four queued wants plus active and retiring runs. */
export function encodedCopyCeilingForUnits(unitCopyBytes: readonly number[]): number {
  const ordered = unitCopyBytes.map((value) => checkedTotal([value]))
    .sort((left, right) => right - left);
  const maximum = ordered[0] ?? 0;
  return checkedTotal([
    maximum,
    maximum,
    ...ordered.slice(0, MAX_ROUTE_PREFETCH_INTENTS)
  ]);
}

function encodedCopyCeiling(
  asset: Asset,
  rendition: Readonly<Rendition>
): number {
  const copies = asset.blobs
    .filter(({ rendition: id }) => id === rendition.id)
    .map(({ length }) => length);
  if (copies.length !== asset.manifest.units.length) {
    throw new Error("Invalid AVAL asset");
  }
  return encodedCopyCeilingForUnits(copies);
}

function assertCandidateBudget(
  asset: Asset,
  rendition: Readonly<Rendition>,
  renderer: Renderer,
  plan: Readonly<ReadinessPlan>
): void {
  const resident = new Map<string, Set<number>>();
  for (const entry of plan.resident) {
    resident.set(entry.unit, new Set(entry.frames));
  }
  let residentFrames = 0;
  for (const frames of resident.values()) {
    residentFrames = checkedTotal([residentFrames, frames.size]);
  }
  const rendererAdmission = renderer.admit(residentFrames);
  const assetSnapshot = asset.snapshot();
  const residentBlobBytes = assetSnapshot.mode === "full"
    ? assetSnapshot.residentBlobBytes : plan.encodedBytes;
  const aggregate = checkedTotal([
    assetSnapshot.metadataBytes,
    residentBlobBytes,
    encodedCopyCeiling(asset, rendition),
    checkedProduct([
      ELEMENT_DECODER_CAPACITY.totalDecodedSurfaces,
      decodedSurfaceBytes(asset.manifest, rendition)
    ]),
    rendererAdmission.runtimeBytes
  ]);
  if (aggregate > asset.manifest.limits.maxRuntimeBytes) {
    throw resourceBudgetError();
  }
}

function candidateReport(
  rendition: string,
  rank: number,
  reason: StaticReason | CandidateRejectionReason | null
) {
  if (reason === null) {
    return Object.freeze({ rendition, rank, outcome: "selected" as const, failure: null });
  }
  if (reason === "reduced-motion" || reason === "visibility-suspended" ||
    reason === "decoder-queued") {
    return Object.freeze({ rendition, rank, outcome: "eligible" as const, failure: null });
  }
  const code = reason === "resource-budget"
    ? "resource-rejection" as const
    : "unsupported-profile" as const;
  return Object.freeze({
    rendition,
    rank,
    outcome: "rejected" as const,
    failure: Object.freeze({
      code,
      message: "animation candidate was rejected",
      context: Object.freeze({ rendition, rank })
    })
  });
}

type CandidateRejectionReason =
  | "codec-unsupported"
  | "no-video-rendition"
  | "resource-budget";

function abortError(): Error {
  return new DOMException("AVAL operation was superseded", "AbortError");
}

function playerAbortReason(signal: AbortSignal): Error {
  return signal.aborted && signal.reason instanceof Error
    ? signal.reason
    : abortError();
}

function limit<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  timeoutMs?: number,
  platform?: Pick<PlayerInput["platform"], "setTimeout" | "clearTimeout">
): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) {
    return Promise.reject(new RangeError("timeoutMs must be a positive integer"));
  }
  if (signal === undefined && timeoutMs === undefined) return operation;
  return new Promise<T>((resolve, reject) => {
    let timer: number | undefined;
    let settled = false;
    const cleanup = (): void => {
      signal?.removeEventListener("abort", abort);
      if (timer !== undefined) (platform?.clearTimeout ?? clearTimeout)(timer);
    };
    const resolveOnce = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (reason: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(reason);
    };
    const abort = (): void => rejectOnce(signal?.reason ?? abortError());
    signal?.addEventListener("abort", abort, { once: true });
    if (timeoutMs !== undefined) timer = (platform?.setTimeout ?? setTimeout)(() => {
      rejectOnce(new DOMException("AVAL preparation timed out", "TimeoutError"));
    }, timeoutMs);
    operation.then(resolveOnce, rejectOnce);
  });
}

class PreparationDeadline {
  readonly #controller = new AbortController();
  readonly #parent: AbortSignal;
  readonly #platform: Pick<PlayerInput["platform"], "setTimeout" | "clearTimeout">;
  readonly #parentAbort: () => void;
  #timer: number | undefined;
  public timedOut = false;

  public constructor(
    parent: AbortSignal,
    timeoutMs = PREPARE_MS,
    platform: Pick<PlayerInput["platform"], "setTimeout" | "clearTimeout">
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PREPARE_MS) {
      throw new RangeError("AVAL preparation timeout is invalid");
    }
    this.#parent = parent;
    this.#platform = platform;
    this.#parentAbort = () => this.#controller.abort(parent.reason);
    if (parent.aborted) this.#parentAbort();
    else parent.addEventListener("abort", this.#parentAbort, { once: true });
    if (!this.#controller.signal.aborted) {
      this.#timer = platform.setTimeout(() => {
        this.timedOut = true;
        this.#controller.abort(preparationTimeout());
      }, timeoutMs);
    }
  }

  public get signal(): AbortSignal { return this.#controller.signal; }

  public complete(): void {
    if (this.#timer !== undefined) this.#platform.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  public cancel(reason: unknown): void {
    this.complete();
    this.#controller.abort(reason);
  }

  public dispose(): void {
    this.complete();
    this.#parent.removeEventListener("abort", this.#parentAbort);
    this.#controller.abort(abortError());
  }
}

function preparationTimeout(): DOMException {
  return new DOMException("AVAL preparation timed out", "TimeoutError");
}

function resourceBudgetError(): Error {
  const error = new RangeError("AVAL runtime resource budget is insufficient");
  error.name = "ResourceBudgetError";
  return error;
}

function unsupportedProfileError(): Error {
  const error = new Error("AVAL has no supported animated rendition");
  error.name = "NotSupportedError";
  return error;
}

function admissionFailure(error: unknown): boolean {
  return errorString(error, "name") === "ResourceBudgetError" ||
    /resource declarations|resource budget|byte cap|byte ceiling/i.test(
      errorString(error, "message") ?? ""
    );
}

function playbackFailureCode(reason: unknown): "renderer-failure" | "worker-decode-failure" {
  const message = errorString(reason, "message") ?? "";
  return /canvas|context|draw|renderer|texture|viewport|webgl/i.test(message)
    ? "renderer-failure"
    : "worker-decode-failure";
}

function preparationFailureCode(reason: unknown):
  "readiness-failure" | "renderer-failure" | "worker-decode-failure" {
  const message = errorString(reason, "message") ?? "";
  if (/canvas|context|draw|renderer|texture|viewport|webgl/i.test(message)) {
    return "renderer-failure";
  }
  if (/codec|decode|decoder|frame|video/i.test(message)) {
    return "worker-decode-failure";
  }
  return "readiness-failure";
}

function selectionFailureCode(reason: unknown):
  | "invalid-asset"
  | "resource-rejection"
  | "renderer-failure"
  | "worker-decode-failure"
  | "readiness-failure"
  | "unsupported-profile" {
  const name = errorString(reason, "name") ?? "";
  const message = errorString(reason, "message") ?? "";
  if (name === "NotSupportedError") return "unsupported-profile";
  if (admissionFailure(reason)) return "resource-rejection";
  if (/canvas|context|draw|renderer|texture|viewport|webgl/i.test(message)) {
    return "renderer-failure";
  }
  if (/codec|decode|decoder|frame|video|worker/i.test(message)) {
    return "worker-decode-failure";
  }
  if (/invalid aval|manifest|asset/i.test(message)) return "invalid-asset";
  return "readiness-failure";
}

function policyReason(reason: StaticReason | null): reason is
  "reduced-motion" | "visibility-suspended" | "decoder-queued" {
  return reason === "reduced-motion" || reason === "visibility-suspended" ||
    reason === "decoder-queued";
}

function checkedTotal(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || total > Number.MAX_SAFE_INTEGER - value) {
      throw resourceBudgetError();
    }
    total += value;
  }
  return total;
}

function checkedProduct(values: readonly number[]): number {
  let product = 1;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 ||
      value !== 0 && product > Math.floor(Number.MAX_SAFE_INTEGER / value)) {
      throw resourceBudgetError();
    }
    product *= value;
  }
  return product;
}

function publishDecoderDiagnostics(
  input: Readonly<PlayerInput>,
  diagnostics: readonly Readonly<DecoderPoolDiagnostic>[],
  sourceIndex: number,
  rendition: Readonly<Rendition>,
  unitFor: (diagnostic: Readonly<DecoderPoolDiagnostic>) => string | null =
    () => null
): readonly Readonly<PlayerDecoderDiagnostic>[] {
  const enriched = Object.freeze(diagnostics.map((diagnostic) =>
    Object.freeze({
      ...diagnostic,
      sourceIndex,
      rendition: rendition.id,
      codec: rendition.codec,
      unit: unitFor(diagnostic)
    }) satisfies Readonly<PlayerDecoderDiagnostic>
  ));
  if (enriched.length > 0) {
    try { input.onDecoderDiagnostics?.(enriched); }
    catch { /* diagnostics cannot replace the playback outcome */ }
  }
  return enriched;
}

function mergePlayerDecoderDiagnostics(
  current: readonly Readonly<PlayerDecoderDiagnostic>[],
  incoming: readonly Readonly<PlayerDecoderDiagnostic>[]
): readonly Readonly<PlayerDecoderDiagnostic>[] {
  if (incoming.length === 0) return current;
  const byLane = new Map(
    current.map((diagnostic) => [diagnostic.lane, diagnostic] as const)
  );
  for (const diagnostic of incoming.slice(0, 2)) {
    byLane.set(diagnostic.lane, diagnostic);
  }
  return Object.freeze(
    [...byLane.values()]
      .sort((left, right) => left.lane - right.lane)
      .slice(0, 2)
  );
}

class PublicationGate {
  public readonly input: Readonly<PlayerInput>;
  readonly #pending: Array<() => void> = [];
  #active = false;
  #flushing = false;

  public constructor(target: Readonly<PlayerInput>) {
    const publish = (operation: () => void): void => {
      if (this.#active && !this.#flushing) operation();
      else this.#pending.push(operation);
    };
    this.input = Object.freeze({
      ...target,
      onResourceBytes: (bytes: number) => publish(() => target.onResourceBytes(bytes)),
      onMetadata: (metadata: Readonly<Metadata>) =>
        publish(() => target.onMetadata(metadata)),
      onReadiness: (value: string, reason?: string) =>
        publish(() => target.onReadiness(value, reason)),
      onAnimationResourcesRetired: () =>
        publish(() => target.onAnimationResourcesRetired()),
      onDraw: () => publish(() => target.onDraw()),
      onRestart: (state: string) => publish(() => target.onRestart(state)),
      onEvent: (type: string, detail: Readonly<Record<string, unknown>>) =>
        publish(() => target.onEvent(type, detail)),
      onFailure: (
        code: Parameters<PlayerInput["onFailure"]>[0],
        operation: string,
        fatal: boolean
      ) =>
        publish(() => target.onFailure(code, operation, fatal)),
      onPlaybackFailure: (
        code: Parameters<PlayerInput["onPlaybackFailure"]>[0],
        operation: string
      ) => target.onPlaybackFailure(code, operation),
      onDecoderDiagnostics: (
        diagnostics: readonly Readonly<PlayerDecoderDiagnostic>[]
      ) =>
        target.onDecoderDiagnostics?.(diagnostics)
    });
  }

  public activate(): void {
    if (this.#active) return;
    this.#active = true;
    this.#flushing = true;
    try {
      while (this.#pending.length > 0) this.#pending.shift()!();
    } finally {
      this.#flushing = false;
    }
  }
}

function isAbort(error: unknown): boolean {
  return errorString(error, "name") === "AbortError";
}

function errorString(value: unknown, key: "name" | "message"): string | null {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return null;
  }
  try {
    const field = (value as { readonly name?: unknown; readonly message?: unknown })[key];
    return typeof field === "string" ? field : null;
  } catch { return null; }
}
