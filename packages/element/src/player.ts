import { Asset } from "./asset.js";
import {
  sameGraphPresentation,
  type GraphPresentation,
  type MotionGraphEffect,
  type MotionGraphEngine,
  type MotionGraphResult,
  type MotionGraphSnapshot
} from "@pixel-point/aval-graph";
import {
  maximumDecodedRgbaBytes,
  parseVideoCodecString,
  type CompiledManifest as Manifest,
  type Edge,
  type ProductionRendition as Rendition,
  type Unit
} from "@pixel-point/aval-format";
import {
  type DecodeRun,
  type DecodeSample
} from "./decoder.js";
import {
  DecoderPool,
  type DecoderPoolCandidate,
  type DecoderPoolDiagnostic
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
  PlayerRendererDiagnostic,
  PlayerSnapshot
} from "./player-contract.js";
import {
  Renderer,
  type RenderLayout,
  type RendererContextChange
} from "./renderer.js";
import { deriveRenderLayout } from "./renderer-geometry.js";
import {
  RendererFailureError,
  type RendererFailureDiagnostic
} from "./renderer-diagnostics.js";
import { AvalPlaybackError } from "./errors.js";
import type {
  AvalPlaybackLifecycleCounters,
  AvalRuntimeTraceRecord,
  RuntimeFailureCode,
  RuntimeReadinessResult,
  StaticReason
} from "./public-types.js";
import {
  emptyPlaybackLifecycleCounters,
  freezePlaybackLifecycleCounters,
  retainPlaybackLifecycleCounters,
  saturatingIncrement
} from "./playback-lifecycle.js";
import {
  retryableCandidateOutcome,
  unsupportedConfigCandidateOutcome,
  type RetryableCandidateRejection
} from "./provisional-candidate-outcome.js";
import {
  orchestrateProvisionalCandidates,
  qualifyProvisionalOutput,
  UnsupportedPlaybackProfileError,
  withProvisionalCandidateFrame
} from "./provisional-startup.js";

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
  needsDecoderRunQualification: boolean;
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

interface SelectionCursor {
  readonly sourceInputIndex: number;
  readonly renditionIndex: number;
}

interface SelectionState {
  cursor: SelectionCursor;
  reports: Readonly<CandidateReport>[];
  decoderDiagnostics: readonly Readonly<PlayerDecoderDiagnostic>[];
  lastRejectionCode: RuntimeFailureCode;
}

interface ProvisionalPlayer {
  readonly player: PlayerImpl;
  readonly publications: PublicationGate;
  readonly sourceIndex: number;
  readonly rendition: Readonly<Rendition>;
  readonly rank: number;
  readonly requiresQualification: boolean;
}

interface StateRequest {
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

const PREPARE_MS = 5_000;
const CANDIDATE_PREPARE_MS = 2_500;
const CONTEXT_RESTORE_MS = 5_000;
const MAX_RETAINED_DECODER_DIAGNOSTICS = 16;
const MAX_RETAINED_RENDERER_DIAGNOSTICS = 16;
const EMPTY_RENDERER_PRESENTATION: PlayerSnapshot["presentation"] = Object.freeze({
  cssWidth: 0,
  cssHeight: 0,
  backingWidth: 0,
  backingHeight: 0,
  effectiveDprX: 0,
  effectiveDprY: 0,
  stagingBytes: 0,
  residentBytes: 0,
  textureBytes: 0,
  runtimeBytes: 0,
  pendingOperations: 0,
  sourceCopiesInFlight: 0,
  resourceCount: 0,
  contextListenerCount: 0
});
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
  const deadline = new PreparationDeadline(
    input.signal,
    input.preparationTimeoutMs,
    input.platform
  );
  const state: SelectionState = {
    cursor: Object.freeze({ sourceInputIndex: 0, renditionIndex: 0 }),
    reports: [],
    decoderDiagnostics: Object.freeze([]),
    lastRejectionCode: "unsupported-profile"
  };
  try {
    const candidate = await orchestrateProvisionalCandidates<ProvisionalPlayer>({
      next: async () => {
        const publications = new PublicationGate(
          input,
          provisionalPlaybackFailure
        );
        try {
          return await selectPlayer(
            publications.input,
            deadline,
            publications,
            state
          );
        } catch (error) {
          publications.discard();
          throw error;
        }
      },
      qualify: async (current) => {
        await input.onCandidate?.(current.player);
        if (current.requiresQualification) {
          await current.player.prepare();
          deadline.complete();
          current.player.adoptPreparationParent(deadline);
        }
      },
      localFailure: (current) => current.player.provisionalFailure(),
      retire: async (current) => {
        current.publications.discard();
        let snapshot: Readonly<PlayerSnapshot> | null = null;
        let snapshotError: unknown;
        try {
          snapshot = current.player.snapshot(false);
          state.decoderDiagnostics = mergePlayerDecoderDiagnostics(
            state.decoderDiagnostics,
            snapshot.decoderDiagnostics
          );
        } catch (error) {
          snapshotError = error;
        }
        let disposalError: unknown;
        try { await current.player.dispose(); }
        catch (error) { disposalError = error; }
        if (disposalError !== undefined) throw disposalError;
        if (snapshot === null) throw snapshotError;
        return Object.freeze({
          retryAllowed: (snapshot.cleanupFailureCount ?? 0) === 0
        });
      },
      cancelled: () => deadline.timedOut || input.signal.aborted,
      selected: (current) => current.publications.commit(),
      rejected: (current, rejection) => {
        const code = candidateRejectionFailureCode(rejection);
        state.lastRejectionCode = code;
        state.reports.push(candidateReport(
          current.rendition.id,
          current.rank,
          code
        ));
      }
    });
    return candidate.player;
  } catch (error) {
    const timedOut = deadline.timedOut && !input.signal.aborted;
    deadline.dispose();
    if (input.signal.aborted || isAbort(error) && !timedOut) throw error;
    throw input.onPlaybackFailure(
      timedOut
        ? "watchdog-timeout"
        : playbackErrorFailureCode(error) ?? selectionFailureCode(error),
      "prepare"
    );
  }
}

async function selectPlayer(
  input: Readonly<PlayerInput>,
  deadline: PreparationDeadline,
  publications: PublicationGate,
  state: SelectionState
): Promise<ProvisionalPlayer> {
  if (input.sources.length === 0) throw new TypeError("AVAL requires a source");
  let retained: Asset | null = null;
  let unavailable: CandidateRejectionReason = "codec-unsupported";
  for (
    let inputIndex = state.cursor.sourceInputIndex;
    inputIndex < input.sources.length;
    inputIndex += 1
  ) {
    const source = input.sources[inputIndex]!;
    const sourceIndex = source.sourceIndex ?? inputIndex;
    const firstRenditionIndex = inputIndex === state.cursor.sourceInputIndex
      ? state.cursor.renditionIndex
      : 0;
    deadline.signal.throwIfAborted();
    if (retained !== null) {
      await retained.dispose();
      reportResourceBytes(input, null);
      retained = null;
    }
    const sourceCodec = parseVideoCodecString(source.codec);
    if (sourceCodec === undefined) throw unsupportedProfileError();
    const asset = await Asset.open(
      source,
      input.baseUrl,
      input.credentials,
      deadline.signal,
      input.platform
    );
    reportResourceBytes(input, asset);
    retained = asset;
    if (asset.manifest.codec !== sourceCodec.family ||
      asset.manifest.renditions.length === 0) {
      retained = asset;
      unavailable = "no-video-rendition";
      state.lastRejectionCode = "unsupported-profile";
      state.cursor = Object.freeze({
        sourceInputIndex: inputIndex + 1,
        renditionIndex: 0
      });
      continue;
    }
    const first = asset.manifest.renditions[0]!;
    const firstRank = state.reports.length;
    if (deadline.timedOut) {
      await asset.dispose();
      reportResourceBytes(input, null);
      throw preparationTimeout();
    }
    if (!input.visible) {
      const player = new PlayerImpl(
        input, asset, first, sourceIndex, state.decoderDiagnostics, null, null,
        deadline, publications, "visibility-suspended",
        state.reports, firstRank
      );
      return Object.freeze({
        player,
        publications,
        sourceIndex,
        rendition: first,
        rank: firstRank,
        requiresQualification: false
      });
    }
    if (reduced(input.motion, input.reduced)) {
      const player = new PlayerImpl(
        input, asset, first, sourceIndex, state.decoderDiagnostics, null, null,
        deadline, publications, "reduced-motion", state.reports, firstRank
      );
      return Object.freeze({
        player,
        publications,
        sourceIndex,
        rendition: first,
        rank: firstRank,
        requiresQualification: false
      });
    }
    if (input.platform.Worker === null || input.platform.VideoDecoder === null ||
      input.platform.VideoFrame === null) {
      await asset.dispose();
      reportResourceBytes(input, null);
      throw unsupportedProfileError();
    }
    if (!input.decoderReady()) {
      const player = new PlayerImpl(
        input, asset, first, sourceIndex, state.decoderDiagnostics, null, null,
        deadline, publications, "decoder-queued", state.reports, firstRank
      );
      return Object.freeze({
        player,
        publications,
        sourceIndex,
        rendition: first,
        rank: firstRank,
        requiresQualification: false
      });
    }
    for (
      let renditionIndex = firstRenditionIndex;
      renditionIndex < asset.manifest.renditions.length;
      renditionIndex += 1
    ) {
      const rendition = asset.manifest.renditions[renditionIndex]!;
      deadline.signal.throwIfAborted();
      const rank = state.reports.length;
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
        clearTimeout: input.platform.clearTimeout,
        sampleFrameRate: asset.manifest.frameRate
      });
      const disposeDecoders = (): void => {
        const diagnostics = decoders.snapshot().decoderDiagnostics;
        state.decoderDiagnostics = mergePlayerDecoderDiagnostics(
          state.decoderDiagnostics,
          publishDecoderDiagnostics(
            input,
            diagnostics,
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
        const outcome = retryableCandidateOutcome(error);
        if (!deadline.signal.aborted &&
          outcome?.rejection.stage === "probe") {
          unavailable = "codec-unsupported";
          state.lastRejectionCode = "unsupported-profile";
          state.reports.push(candidateReport(rendition.id, rank, unavailable));
          continue;
        }
        await asset.dispose();
        reportResourceBytes(input, null);
        throw error;
      }
      if (!supported) {
        disposeDecoders();
        const outcome = unsupportedConfigCandidateOutcome();
        unavailable = "codec-unsupported";
        state.lastRejectionCode = "unsupported-profile";
        state.reports.push(candidateReport(
          rendition.id,
          rank,
          candidateRejectionFailureCode(outcome.rejection)
        ));
        continue;
      }
      let renderer: Renderer;
      let contextChange:
        ((change: Readonly<RendererContextChange>) => void) | null = null;
      try {
        const maxRuntimeBytes = asset.manifest.limits.maxRuntimeBytes;
        renderer = new Renderer(input.canvas, layout, {
          maxTextureBytes: maxRuntimeBytes,
          maxBackingBytes: maxRuntimeBytes,
          maxRuntimeBytes,
          setTimeout: input.platform.setTimeout,
          clearTimeout: input.platform.clearTimeout,
          onContextChange: (change) => contextChange?.(change),
          initialPresentation: {
            width: input.initialPresentation.width,
            height: input.initialPresentation.height,
            dpr: input.initialPresentation.dpr,
            fit: input.initialPresentation.fit ?? asset.manifest.canvas.fit
          }
        });
        rendererRef = renderer;
      } catch (error) {
        if (error instanceof RendererFailureError) {
          publishRendererDiagnostics(
            input,
            Object.freeze([error.diagnostic]),
            sourceIndex,
            rendition
          );
        }
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
        await asset.dispose();
        reportResourceBytes(input, null);
        throw error;
      }
      const nextRenditionIndex = renditionIndex + 1;
      state.cursor = nextRenditionIndex < asset.manifest.renditions.length
        ? Object.freeze({ sourceInputIndex: inputIndex, renditionIndex: nextRenditionIndex })
        : Object.freeze({ sourceInputIndex: inputIndex + 1, renditionIndex: 0 });
      let candidateDeadline: PreparationDeadline;
      try {
        candidateDeadline = deadline.fork(CANDIDATE_PREPARE_MS);
      } catch (error) {
        disposeDecoders();
        renderer.dispose();
        rendererRef = null;
        await asset.dispose();
        reportResourceBytes(input, null);
        throw error;
      }
      const player = new PlayerImpl(
        input, asset, rendition, sourceIndex, state.decoderDiagnostics,
        decoders, renderer, candidateDeadline, publications, null,
        state.reports, rank
      );
      contextChange = (change) => player.contextChanged(change);
      return Object.freeze({
        player,
        publications,
        sourceIndex,
        rendition,
        rank,
        requiresQualification: true
      });
    }
    state.cursor = Object.freeze({
      sourceInputIndex: inputIndex + 1,
      renditionIndex: 0
    });
  }
  if (retained === null) throw new SelectionExhaustedError(state.lastRejectionCode);
  const rendition = retained.manifest.renditions[0];
  await retained.dispose();
  reportResourceBytes(input, null);
  if (rendition === undefined) throw new Error("Invalid AVAL asset");
  throw new SelectionExhaustedError(state.lastRejectionCode);
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
  #preparationParent: PreparationDeadline | null = null;
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
  #provisionalFailure: unknown = undefined;
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
  #published = false;
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
  #drawsCompleted = 0;
  #transitionStarts = 0;
  #transitionEnds = 0;
  #loopCrossings = 0;
  #decoderLifecycle: Readonly<AvalPlaybackLifecycleCounters> =
    emptyPlaybackLifecycleCounters();
  #incidents = 0;
  #inUnderflow = false;
  #awaitingContextRestore = false;
  #contextRestoreTimer: number | null = null;
  #restartRequested = false;
  #contextLosses = 0;
  #contextRecoveries = 0;
  #cleanupFailureCount = 0;
  #animationResourcesRetired = false;
  #animationResourceRetirement: Promise<void> | null = null;
  #decoderDiagnostics: readonly Readonly<PlayerDecoderDiagnostic>[];
  #capturedPoolDiagnostics: readonly Readonly<DecoderPoolDiagnostic>[] =
    Object.freeze([]);
  #rendererDiagnostics: readonly Readonly<PlayerRendererDiagnostic>[] =
    Object.freeze([]);
  #capturedRendererDiagnostic: Readonly<RendererFailureDiagnostic> | null = null;
  readonly #decoderUnitByLane: [
    Readonly<{
      logicalRunId: number;
      unit: string;
      role: "foreground" | "candidate";
    }> | null,
    Readonly<{
      logicalRunId: number;
      unit: string;
      role: "foreground" | "candidate";
    }> | null
  ] = [null, null];

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

  public activate(options: Readonly<{ publish?: boolean }> = {}): void {
    if (this.#disposed || this.#failed) return;
    if (!this.#activated) {
      this.#installGraph();
      this.#activated = true;
    }
    if (options.publish !== false) this.publish();
  }

  public publish(): void {
    if (!this.#activated || this.#published || this.#disposed || this.#failed) return;
    this.#publications.activate();
    if (this.#disposed || this.#failed) return;
    this.#published = true;
    if (this.#prepared) this.#resetClock();
    this.#schedule();
  }

  public adoptPreparationParent(parent: PreparationDeadline): void {
    if (this.#preparationParent !== null || this.#disposed) {
      throw new Error("AVAL preparation parent ownership is invalid");
    }
    this.#preparationParent = parent;
  }

  public provisionalFailure(): unknown {
    return this.#provisionalFailure;
  }

  public prepare(options: Readonly<{
    signal?: AbortSignal;
    timeoutMs?: number;
  }> = {}): Promise<PrepareResult> {
    if (this.#terminalWork !== null) {
      return limit(
        this.#terminalWork.then((error) => Promise.reject(error)),
        options.signal,
        options.timeoutMs,
        this.#input.platform
      );
    }
    if (this.#preparation === null) {
      this.#preparation = this.#prepareBounded();
    }
    const operation = Promise.race([this.#preparation, this.#terminalSignal]);
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

  public contextChanged(change: Readonly<RendererContextChange>): void {
    if (change.state === "error") {
      this.#clearContextRestoreTimer();
      if (this.#disposed || this.#staticReason !== null) return;
      this.#captureRendererDiagnostic(change.error.diagnostic);
      if (!this.#failed) this.#fail(change.error);
      return;
    }
    if (this.#disposed || this.#failed || this.#staticReason !== null) return;
    if (change.state === "lost") {
      if (this.#awaitingContextRestore) return;
      this.#awaitingContextRestore = true;
      this.#contextLosses += 1;
      this.#cancelFrame();
      this.#input.onFailure("context-loss", "render", false);
      this.#contextRestoreTimer = this.#input.platform.setTimeout(() => {
        this.#contextRestoreTimer = null;
        if (
          !this.#awaitingContextRestore ||
          this.#disposed ||
          this.#failed ||
          this.#staticReason !== null
        ) return;
        void this.#terminate("context-loss", "render");
      }, CONTEXT_RESTORE_MS);
      return;
    }
    if (!this.#awaitingContextRestore) return;
    this.#clearContextRestoreTimer();
    this.#awaitingContextRestore = false;
    this.#contextRecoveries += 1;
    const state = this.#graph?.snapshot().requestedState;
    if (state !== null && state !== undefined) this.#input.onRestart(state);
  }

  public resize(width: number, height: number, dpr: number, fit: string): void {
    const renderer = this.#renderer;
    if (renderer === null) return;
    try {
      renderer.resize(width, height, dpr, fit);
      this.#reportResourceBytes();
    } catch (error) {
      if (error instanceof RendererFailureError) {
        this.#captureRendererDiagnostic(error.diagnostic);
      }
      void this.#terminate(
        admissionFailure(error) ? "resource-rejection" : playbackFailureCode(error),
        rendererFailureOperation(error, "resize")
      );
    }
  }

  public snapshot(trace: boolean): Readonly<PlayerSnapshot> {
    const asset = this.#asset.snapshot();
    const decoders = this.#decoders?.snapshot() ?? {
      workerCount: 0,
      openFrames: 0,
      openFrameBytes: 0,
      playbackLifecycle: emptyPlaybackLifecycleCounters(),
      decoderDiagnostics: Object.freeze([])
    };
    this.#captureDecoderLifecycle(decoders.playbackLifecycle);
    this.#captureDecoderDiagnostics(decoders.decoderDiagnostics);
    const renderer = this.#renderer ?? this.#retiredRenderer;
    let rendererBackend: PlayerSnapshot["rendererBackend"] = null;
    let rendererContextLossCount = 0;
    let rendererContextRecoveryCount = 0;
    let presentation: PlayerSnapshot["presentation"] =
      EMPTY_RENDERER_PRESENTATION;
    if (renderer !== null) {
      const rendererSnapshot = renderer.snapshot();
      this.#captureRendererDiagnostic(rendererSnapshot.failure);
      rendererContextLossCount = rendererSnapshot.contextLossCount;
      rendererContextRecoveryCount = rendererSnapshot.contextRecoveryCount;
      const {
        backendDetails,
        failure: _rendererFailure,
        contextLossCount: _rendererContextLossCount,
        contextRecoveryCount: _rendererContextRecoveryCount,
        ...presentationValues
      } = rendererSnapshot;
      rendererBackend = backendDetails.kind;
      presentation = Object.freeze(presentationValues);
    }
    const graph = this.#graph?.snapshot();
    return Object.freeze({
      requestedState: graph?.requestedState ?? null,
      visualState: graph?.visualState ?? null,
      transitioning: graph?.isTransitioning ?? false,
      selectedRendition: this.#staticReason === null ? this.#rendition.id : null,
      selectedCodec: this.#staticReason === null ? this.#rendition.codec : null,
      rendererBackend,
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
      contextLossCount: Math.max(this.#contextLosses, rendererContextLossCount),
      contextRecoveryCount: Math.max(
        this.#contextRecoveries,
        rendererContextRecoveryCount
      ),
      cleanupFailureCount: this.#cleanupFailureCount,
      playbackLifecycle: freezePlaybackLifecycleCounters({
        ...this.#decoderLifecycle,
        drawsCompleted: this.#drawsCompleted,
        transitionStarts: this.#transitionStarts,
        transitionEnds: this.#transitionEnds,
        loopCrossings: this.#loopCrossings
      }),
      decoderDiagnostics: this.#decoderDiagnostics,
      rendererDiagnostics: this.#rendererDiagnostics,
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
      this.#clearContextRestoreTimer();
      this.#awaitingContextRestore = false;
      this.#animationGeneration += 1;
      this.#preparationDeadline.dispose();
      this.#preparationParent?.dispose();
      this.#preparationParent = null;
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
      if (this.#provisionalFailure === undefined) {
        this.#provisionalFailure = error;
      }
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
    await this.#qualifyOutput();
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

  async #qualifyOutput(): Promise<void> {
    const decoders = this.#decoders;
    const renderer = this.#renderer;
    if (decoders === null || renderer === null) {
      throw new Error("AVAL animation resources are unavailable");
    }
    const generation = this.#animationGeneration;
    await qualifyProvisionalOutput({
      manifest: this.#manifest,
      renditionId: this.#rendition.id,
      layout: renderLayout(this.#manifest, this.#rendition),
      withDecodedFrame: async (unitId, localFrame, use) => {
        const unit = this.#unit(unitId);
        await this.#preloadRun(unit, this.#preparationDeadline.signal);
        this.#assertAnimation(generation, renderer, decoders);
        const candidate = this.#createLoadedRun(unit, "candidate");
        await withProvisionalCandidateFrame({
          candidate,
          localFrame,
          signal: this.#preparationDeadline.signal,
          use: async (decoded) => {
            this.#assertAnimation(generation, renderer, decoders);
            await use(decoded);
            this.#assertAnimation(generation, renderer, decoders);
          }
        });
      },
      inspectAndPrime: (frame, inspect) =>
        renderer.inspectAndPrime(frame, inspect)
    });
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
    if (!this.#published) this.#publications.discardAnimatedPresentation();
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
    let needsDecoderRunQualification = true;
    try {
      for (let index = 0; index < run.frameCount; index += 1) {
        this.#preparationDeadline.signal.throwIfAborted();
        const frame = await run.take(index);
        this.#assertAnimation(generation, renderer, decoders);
        try {
          if (keep.has(index)) {
            if (!this.#hasResident(unit.id, index)) {
              await renderer.store(
                unit.id,
                index,
                frame,
                needsDecoderRunQualification
              );
              this.#assertAnimation(generation, renderer, decoders);
              needsDecoderRunQualification = false;
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
    this.#clearContextRestoreTimer();
    this.#awaitingContextRestore = false;
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
    if (renderer !== null) {
      this.#captureRendererDiagnostic(renderer.snapshot().failure);
    }
    const decoders = this.#decoders;
    if (decoders !== null) {
      const decoderSnapshot = decoders.snapshot();
      this.#captureDecoderDiagnostics(decoderSnapshot.decoderDiagnostics);
      this.#captureDecoderLifecycle(decoderSnapshot.playbackLifecycle);
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

  #clearContextRestoreTimer(): void {
    const timer = this.#contextRestoreTimer;
    if (timer === null) return;
    this.#contextRestoreTimer = null;
    this.#input.platform.clearTimeout(timer);
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
      !this.#activated || !this.#published || this.#disposed || this.#failed ||
      this.#paused || !this.#visible ||
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
      if (loopCrossing(before.presentation, result.presentation, this.#units)) {
        this.#loopCrossings = saturatingIncrement(this.#loopCrossings);
      }
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
    if (effect.type === "transitionstart") {
      this.#transitionStarts = saturatingIncrement(this.#transitionStarts);
    } else if (effect.type === "transitionend") {
      this.#transitionEnds = saturatingIncrement(this.#transitionEnds);
    }
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
          await renderer.draw(frame, active.needsDecoderRunQualification);
          this.#assertAnimation(generation, renderer, decoders);
          active.needsDecoderRunQualification = false;
        }
        finally { this.#release(run, frame); }
        active.drainedIndex = presentation.frameIndex;
      }
      this.#assertAnimation(generation, renderer, decoders);
      active.lastIndex = presentation.frameIndex;
      if (replacing) {
        if (replacement === null) throw new Error("Invalid AVAL stream replacement");
        if (replacement.kind === "candidate") {
          replacement.candidate.commit();
          this.#rememberDecoderUnit(
            replacement.candidate.run,
            replacement.candidate.unitId,
            "foreground"
          );
        }
        this.#active = active;
        if (replacement.kind === "foreground") this.#closeActive(previous);
      }
      if (this.#hasResident(unit.id, presentation.frameIndex)) {
        this.#drainThrough(active, presentation.frameIndex);
      }
    }
    this.#assertAnimation(generation, renderer, decoders);
    this.#lastDraw = key;
    this.#drawsCompleted = saturatingIncrement(this.#drawsCompleted);
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
      needsDecoderRunQualification: true,
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
      this.#rememberDecoderUnit(run, unit.id, role);
      this.#reportResourceBytes();
      if (run.frameCount !== unit.frameCount) {
        run.close();
        throw new Error("Invalid AVAL asset");
      }
      return run;
    }
    const candidate = decoders.createCandidate(unit.id, samples);
    this.#rememberDecoderUnit(candidate.run, unit.id, role);
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

  #rememberDecoderUnit(
    run: DecodeRun,
    unit: string,
    role: "foreground" | "candidate"
  ): void {
    const decoders = this.#decoders;
    if (decoders === null) return;
    const { lane, logicalId } = decoders.identity(run);
    this.#decoderUnitByLane[lane] = Object.freeze({
      logicalRunId: logicalId,
      unit,
      role
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
          return current !== null &&
            current.logicalRunId === diagnostic.logicalRunId
            ? current.unit
            : null;
        },
        this.#decoderGraphDiagnostic()
      )
    );
  }

  #captureDecoderLifecycle(
    lifecycle: Readonly<AvalPlaybackLifecycleCounters> | undefined
  ): void {
    if (lifecycle === undefined) return;
    this.#decoderLifecycle = retainPlaybackLifecycleCounters(
      this.#decoderLifecycle,
      lifecycle
    );
  }

  #decoderGraphDiagnostic(): Readonly<PlayerDecoderDiagnostic["graph"]> {
    const snapshot = this.#graph?.snapshot();
    const pending = this.#decoderUnitByLane.find((entry) =>
      entry?.role === "candidate"
    );
    return Object.freeze({
      requestedState: snapshot?.requestedState ?? null,
      visualState: snapshot?.visualState ?? null,
      activeUnit: this.#active?.unit.id ?? this.#initialMedia?.unit.id ?? null,
      pendingUnit: pending?.unit ?? null
    });
  }

  #captureRendererDiagnostic(
    diagnostic: Readonly<RendererFailureDiagnostic> | null
  ): void {
    if (
      diagnostic === null ||
      diagnostic === this.#capturedRendererDiagnostic ||
      this.#rendererDiagnostics.length > 0
    ) return;
    this.#capturedRendererDiagnostic = diagnostic;
    this.#rendererDiagnostics = publishRendererDiagnostics(
      this.#input,
      Object.freeze([diagnostic]),
      this.#sourceIndex,
      this.#rendition
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
      let needsDecoderRunQualification = true;
      try {
        for (let index = 0; index < unit.frameCount; index += 1) {
          this.#preparationDeadline.signal.throwIfAborted();
          const frame = await run.take(index);
          this.#assertAnimation(generation, renderer, decoders);
          try {
            if (!this.#hasResident(unit.id, index)) {
              await renderer.store(
                unit.id,
                index,
                frame,
                needsDecoderRunQualification
              );
              this.#assertAnimation(generation, renderer, decoders);
              needsDecoderRunQualification = false;
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
    if (!this.#prepared && this.#provisionalFailure === undefined) {
      this.#provisionalFailure = reason;
    }
    if (reason instanceof RendererFailureError) {
      this.#captureRendererDiagnostic(reason.diagnostic);
    }
    void this.#terminate(
      playbackFailureCode(reason),
      rendererFailureOperation(reason, "playback")
    );
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
    if (!this.#published) this.#publications.discard();
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
    this.#clearContextRestoreTimer();
    this.#awaitingContextRestore = false;
    if (this.#renderer !== null) {
      this.#captureRendererDiagnostic(this.#renderer.snapshot().failure);
    }
    if (this.#decoders !== null) {
      this.#captureDecoderDiagnostics(
        this.#decoders.snapshot().decoderDiagnostics
      );
    }
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
  return deriveRenderLayout({
    codedWidth: rendition.codedWidth,
    codedHeight: rendition.codedHeight,
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

function loopCrossing(
  before: Readonly<GraphPresentation> | null,
  after: Readonly<GraphPresentation> | null,
  units: ReadonlyMap<string, Readonly<Unit>>
): boolean {
  if (
    before?.kind !== "body" || after?.kind !== "body" ||
    before.state !== after.state || before.unitId !== after.unitId ||
    after.frameIndex !== 0
  ) return false;
  const unit = units.get(after.unitId);
  return unit?.kind === "body" && unit.playback === "loop" &&
    before.frameIndex === unit.frameCount - 1;
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
    bytes = checkedTotal([bytes, record.byteLength]);
  }
  return bytes;
}

function reduced(policy: string, host: boolean): boolean {
  return policy === "reduce" || policy === "auto" && host;
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
  reason: StaticReason | CandidateRejectionReason | RuntimeFailureCode | null
) {
  if (reason === null) {
    return Object.freeze({ rendition, rank, outcome: "selected" as const, failure: null });
  }
  if (reason === "reduced-motion" || reason === "visibility-suspended" ||
    reason === "decoder-queued") {
    return Object.freeze({ rendition, rank, outcome: "eligible" as const, failure: null });
  }
  const code: RuntimeFailureCode = reason === "codec-unsupported" ||
    reason === "no-video-rendition"
      ? "unsupported-profile"
      : reason;
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
  | "no-video-rendition";

class SelectionExhaustedError extends Error {
  public readonly failureCode: RuntimeFailureCode;

  public constructor(failureCode: RuntimeFailureCode) {
    super("No AVAL source completed startup qualification");
    this.name = "NotSupportedError";
    this.failureCode = failureCode;
  }
}

function provisionalPlaybackFailure(
  code: RuntimeFailureCode,
  operation: string
): AvalPlaybackError {
  return new AvalPlaybackError(Object.freeze({
    code,
    message: `AVAL provisional candidate failed (${code})`,
    operation
  }), 1);
}

function playbackErrorFailureCode(error: unknown): RuntimeFailureCode | null {
  if (error instanceof SelectionExhaustedError) return error.failureCode;
  if (!(error instanceof AvalPlaybackError)) return null;
  return isRuntimeFailureCode(error.failure.code) ? error.failure.code : null;
}

function candidateRejectionFailureCode(
  rejection: Readonly<RetryableCandidateRejection>
): RuntimeFailureCode {
  return rejection.stage === "probe"
    ? "unsupported-profile"
    : "worker-decode-failure";
}

function isRuntimeFailureCode(value: unknown): value is RuntimeFailureCode {
  return value === "invalid-asset" || value === "load-failure" ||
    value === "range-response-invalid" || value === "entity-changed" ||
    value === "integrity-mismatch" || value === "unsupported-profile" ||
    value === "resource-rejection" || value === "readiness-failure" ||
    value === "worker-decode-failure" || value === "renderer-failure" ||
    value === "context-loss" || value === "watchdog-timeout" ||
    value === "underflow" || value === "abort" || value === "disposed";
}

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
  readonly #platform: Pick<
    PlayerInput["platform"],
    "setTimeout" | "clearTimeout" | "now"
  >;
  readonly #parentAbort: () => void;
  readonly #expiresAt: number;
  #timer: number | undefined;
  public timedOut = false;

  public constructor(
    parent: AbortSignal,
    timeoutMs = PREPARE_MS,
    platform: Pick<
      PlayerInput["platform"],
      "setTimeout" | "clearTimeout" | "now"
    >
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PREPARE_MS) {
      throw new RangeError("AVAL preparation timeout is invalid");
    }
    this.#parent = parent;
    this.#platform = platform;
    this.#expiresAt = platform.now() + timeoutMs;
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

  public remainingMs(): number {
    return Math.max(0, Math.ceil(this.#expiresAt - this.#platform.now()));
  }

  public fork(maximumMs: number): PreparationDeadline {
    const timeoutMs = Math.min(maximumMs, this.remainingMs());
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw preparationTimeout();
    }
    return new PreparationDeadline(this.signal, timeoutMs, this.#platform);
  }

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

function unsupportedProfileError(): UnsupportedPlaybackProfileError {
  return new UnsupportedPlaybackProfileError(
    "AVAL has no supported animated rendition"
  );
}

function unsupportedProfileFailure(reason: unknown): boolean {
  return reason instanceof UnsupportedPlaybackProfileError ||
    errorString(reason, "name") === "NotSupportedError";
}

function admissionFailure(error: unknown): boolean {
  return errorString(error, "name") === "ResourceBudgetError" ||
    /resource declarations|resource budget|byte cap|byte ceiling/i.test(
      errorString(error, "message") ?? ""
    );
}

function playbackFailureCode(reason: unknown): "renderer-failure" | "worker-decode-failure" {
  if (reason instanceof RendererFailureError) return "renderer-failure";
  const message = errorString(reason, "message") ?? "";
  return /canvas|context|draw|renderer|texture|viewport|webgl/i.test(message)
    ? "renderer-failure"
    : "worker-decode-failure";
}

function preparationFailureCode(reason: unknown):
  | "readiness-failure"
  | "renderer-failure"
  | "unsupported-profile"
  | "worker-decode-failure" {
  if (unsupportedProfileFailure(reason)) return "unsupported-profile";
  if (reason instanceof RendererFailureError) return "renderer-failure";
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
  const message = errorString(reason, "message") ?? "";
  if (reason instanceof RendererFailureError) return "renderer-failure";
  if (unsupportedProfileFailure(reason)) return "unsupported-profile";
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

function rendererFailureOperation(
  reason: unknown,
  fallback: string
): string {
  if (!(reason instanceof RendererFailureError)) return fallback;
  if (reason.diagnostic.operation === "restore") return "restore";
  if (reason.diagnostic.phase === "resize") return "resize";
  return reason.diagnostic.operation === "construct" ? "prepare" : "render";
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
    () => null,
  graph: Readonly<PlayerDecoderDiagnostic["graph"]> =
    EMPTY_DECODER_GRAPH_DIAGNOSTIC
): readonly Readonly<PlayerDecoderDiagnostic>[] {
  const enriched = Object.freeze(diagnostics.map((diagnostic) =>
    Object.freeze({
      ...diagnostic,
      sourceIndex,
      rendition: rendition.id,
      codec: rendition.codec,
      unit: unitFor(diagnostic),
      graph
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
  const bySourceLane = new Map<string, Readonly<PlayerDecoderDiagnostic>>(
    current.map((diagnostic) => [
      `${String(diagnostic.sourceIndex)}:${String(diagnostic.lane)}`,
      diagnostic
    ] as const)
  );
  for (const diagnostic of incoming) {
    const key = `${String(diagnostic.sourceIndex)}:${String(diagnostic.lane)}`;
    if (!bySourceLane.has(key)) bySourceLane.set(key, diagnostic);
  }
  return Object.freeze(
    [...bySourceLane.values()]
      .sort((left, right) =>
        left.sourceIndex - right.sourceIndex || left.lane - right.lane
      )
      .slice(-MAX_RETAINED_DECODER_DIAGNOSTICS)
  );
}

function publishRendererDiagnostics(
  input: Readonly<PlayerInput>,
  diagnostics: readonly Readonly<RendererFailureDiagnostic>[],
  sourceIndex: number,
  rendition: Readonly<Rendition>
): readonly Readonly<PlayerRendererDiagnostic>[] {
  const enriched = Object.freeze(
    diagnostics.slice(-MAX_RETAINED_RENDERER_DIAGNOSTICS).map((diagnostic) =>
      Object.freeze({
        ...diagnostic,
        sourceIndex,
        rendition: rendition.id,
        codec: rendition.codec
      }) satisfies Readonly<PlayerRendererDiagnostic>
    )
  );
  if (enriched.length > 0) {
    try { input.onRendererDiagnostics?.(enriched); }
    catch { /* diagnostics cannot replace the playback outcome */ }
  }
  return enriched;
}

const EMPTY_DECODER_GRAPH_DIAGNOSTIC = Object.freeze({
  requestedState: null,
  visualState: null,
  activeUnit: null,
  pendingUnit: null
}) satisfies Readonly<PlayerDecoderDiagnostic["graph"]>;

class PublicationGate {
  public readonly input: Readonly<PlayerInput>;
  readonly #targetPlaybackFailure: PlayerInput["onPlaybackFailure"];
  readonly #pending: Array<Readonly<{
    kind: "animated-readiness" | "draw" | "other";
    operation: () => void;
  }>> = [];
  #playbackFailure: PlayerInput["onPlaybackFailure"];
  #active = false;
  #discarded = false;
  #flushing = false;

  public constructor(
    target: Readonly<PlayerInput>,
    playbackFailure: PlayerInput["onPlaybackFailure"] = target.onPlaybackFailure
  ) {
    this.#targetPlaybackFailure = target.onPlaybackFailure;
    this.#playbackFailure = playbackFailure;
    const publish = (
      operation: () => void,
      kind: "animated-readiness" | "draw" | "other" = "other"
    ): void => {
      if (this.#discarded) return;
      if (this.#active && !this.#flushing) operation();
      else this.#pending.push(Object.freeze({ kind, operation }));
    };
    this.input = Object.freeze({
      ...target,
      // Resource accounting is lifecycle authority, not a public candidate
      // publication. It must remain current while provisional players qualify.
      onResourceBytes: (bytes: number) => target.onResourceBytes(bytes),
      onMetadata: (metadata: Readonly<Metadata>) =>
        publish(() => target.onMetadata(metadata)),
      onReadiness: (value: string, reason?: string) => publish(
        () => target.onReadiness(value, reason),
        value === "visualReady" || value === "interactiveReady"
          ? "animated-readiness"
          : "other"
      ),
      onAnimationResourcesRetired: () =>
        publish(() => target.onAnimationResourcesRetired()),
      onDraw: () => publish(() => target.onDraw(), "draw"),
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
      ) => this.#playbackFailure(code, operation),
      onDecoderDiagnostics: (
        diagnostics: readonly Readonly<PlayerDecoderDiagnostic>[]
      ) =>
        target.onDecoderDiagnostics?.(diagnostics),
      onRendererDiagnostics: (
        diagnostics: readonly Readonly<PlayerRendererDiagnostic>[]
      ) =>
        target.onRendererDiagnostics?.(diagnostics)
    });
  }

  public activate(): void {
    if (this.#active || this.#discarded) return;
    this.#active = true;
    this.#flushing = true;
    try {
      while (this.#pending.length > 0) {
        this.#pending.shift()!.operation();
      }
    } finally {
      this.#flushing = false;
    }
  }

  public commit(): void {
    if (this.#discarded) return;
    this.#playbackFailure = this.#targetPlaybackFailure;
  }

  public discardAnimatedPresentation(): void {
    if (this.#active || this.#discarded) return;
    const retained = this.#pending.filter(({ kind }) =>
      kind !== "animated-readiness" && kind !== "draw"
    );
    this.#pending.length = 0;
    this.#pending.push(...retained);
  }

  public discard(): void {
    if (this.#active || this.#discarded) return;
    this.#discarded = true;
    this.#pending.length = 0;
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
