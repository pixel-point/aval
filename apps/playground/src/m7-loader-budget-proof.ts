import {
  BrowserPresentationPlanes,
  BrowserStaticSurfaceDecoder,
  PageResourceManager,
  PlayerWebPageRuntime,
  PlayerResourceAccount,
  StaticSurfaceStore,
  asStaticSurfaceCatalog,
  createAvcRenditionCandidates,
  createPlayerRuntimeAssetSessionResources,
  createRuntimePageResourcePolicy,
  isRuntimePlaybackError,
  inspectAvcRenditionCandidate,
  openRuntimeAsset,
  type RuntimeAssetResidencySnapshot,
  type RuntimeAssetSession,
  type RuntimeAssetSessionSnapshot,
  type RuntimeFailureCode,
  type RuntimePageResourceSnapshot,
  type RuntimeTransportMode
} from "@rendered-motion/player-web";
export {
  runM7DecoderFifoProof,
  type M7DecoderFifoProof,
  type M7DecoderFifoProofInput
} from "./m7-decoder-fifo-proof.js";
import {
  createM7LoaderInstrumentation,
  type M7LoaderTelemetry
} from "./m7-loader-instrumentation.js";

export type M7LoaderProofPhase =
  | "metadata"
  | "initial-static"
  | "all-statics"
  | "rendition";

export interface M7LoaderProofInput {
  readonly assetUrl: string;
  readonly initialStatic: string;
  readonly rendition: string;
  readonly integrity?: string;
  readonly timeoutMs?: number;
  readonly abortAfterMs?: number;
  readonly stopAfter?: M7LoaderProofPhase;
}

export interface M7LoaderProofSuccess {
  readonly status: "loaded";
  readonly mode: RuntimeTransportMode;
  readonly phases: readonly Readonly<{
    readonly phase: M7LoaderProofPhase;
    readonly residency: RuntimeAssetSessionSnapshot;
    readonly resources: RuntimePageResourceSnapshot;
  }>[];
  readonly telemetry: Readonly<M7LoaderTelemetry>;
  readonly terminal: Readonly<M7LoaderTerminalSnapshot>;
}

export interface M7LoaderProofFailure {
  readonly status: "failed";
  readonly code: RuntimeFailureCode | "AbortError" | "unknown";
  readonly openedMode: RuntimeTransportMode | null;
  readonly lastResidency: RuntimeAssetResidencySnapshot | null;
  readonly telemetry: Readonly<M7LoaderTelemetry>;
  readonly terminal: Readonly<M7LoaderTerminalSnapshot>;
}

export interface M7LoaderTerminalSnapshot {
  readonly physicalBytes: number;
  readonly byteLeases: number;
  readonly participants: number;
  readonly decoderLeases: number;
  readonly decoderQueue: number;
}

export interface M7StaticEvictionProof {
  readonly evictedByPagePressure: true;
  readonly evictedStatic: string;
  readonly redecodedStatic: string;
  readonly retainedBefore: number;
  readonly retainedAfterEviction: number;
  readonly redecodedSurfaces: number;
  readonly staticCounters: Readonly<{
    readonly decodedSurfaces: number;
    readonly redecodedSurfaces: number;
    readonly evictions: number;
    readonly closedBeforeDispose: number;
    readonly closedAfterDispose: number;
    readonly peakRetainedSurfaces: number;
    readonly peakRetainedRgbaBytes: number;
    readonly leaseReservations: number;
    readonly leaseReleasesBeforeDispose: number;
    readonly leaseReleasesAfterDispose: number;
  }>;
  readonly visibility: readonly boolean[];
  readonly terminal: Readonly<M7LoaderTerminalSnapshot>;
}

/** Exercise the sparse loader through public package exports only. */
export async function runM7LoaderProof(
  input: Readonly<M7LoaderProofInput>
): Promise<Readonly<M7LoaderProofSuccess | M7LoaderProofFailure>> {
  const manager = new PageResourceManager();
  const account = new PlayerResourceAccount(manager, {
    generation: 1,
    visibility: "visible",
    phase: "loading"
  });
  const instrumentation = createM7LoaderInstrumentation({
    resources: createPlayerRuntimeAssetSessionResources(account),
    snapshotResources: () => manager.snapshot()
  });
  const controller = new AbortController();
  const abortHandle = input.abortAfterMs === undefined
    ? null
    : globalThis.setTimeout(() => controller.abort(), input.abortAfterMs);
  let session: RuntimeAssetSession | null = null;
  let openedMode: RuntimeTransportMode | null = null;
  let lastResidency: RuntimeAssetResidencySnapshot | null = null;
  let mediaGateCalls = 0;
  const phases: Array<M7LoaderProofSuccess["phases"][number]> = [];
  let outcome:
    | Omit<M7LoaderProofSuccess, "terminal" | "telemetry">
    | Omit<M7LoaderProofFailure, "terminal" | "telemetry">;

  try {
    session = await openRuntimeAsset({
      url: input.assetUrl,
      signal: controller.signal,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.integrity === undefined ? {} : { integrity: input.integrity })
    }, {
      resources: instrumentation.resources,
      generation: 1,
      fetcher: instrumentation.fetcher,
      digestAdapter: instrumentation.digestAdapter,
      timers: instrumentation.timers,
      format: instrumentation.format,
      validateStaticPng: instrumentation.validateStaticPng
    });
    openedMode = session.mode;
    account.updateStatus({ phase: "preparing" });
    recordPhase("metadata");

    if (input.stopAfter !== "metadata") {
      await session.ensureStatic(input.initialStatic, {
        signal: controller.signal
      });
      recordPhase("initial-static");
    }
    if (
      input.stopAfter !== "metadata" &&
      input.stopAfter !== "initial-static"
    ) {
      await session.ensureAllStatics({ signal: controller.signal });
      recordPhase("all-statics");
    }
    if (
      input.stopAfter === undefined ||
      input.stopAfter === "rendition"
    ) {
      await session.ensureRenditionUnits(input.rendition, {
        signal: controller.signal
      });
      const candidate = createAvcRenditionCandidates(
        session.catalog.renditions.values(),
        session.catalog.manifest.canvas
      ).find(({ rendition }) => rendition.id === input.rendition);
      if (candidate === undefined) {
        throw new Error("M7 selected rendition has no media candidate");
      }
      mediaGateCalls += 1;
      const inspected = inspectAvcRenditionCandidate(session.catalog, candidate);
      if (!inspected.ok) {
        throw new Error("M7 selected rendition failed its media gate");
      }
      account.updateStatus({ phase: "animated" });
      recordPhase("rendition");
    }

    outcome = Object.freeze({
      status: "loaded" as const,
      mode: session.mode,
      phases: Object.freeze(phases.slice())
    });
  } catch (error) {
    outcome = Object.freeze({
      status: "failed" as const,
      code: proofFailureCode(error),
      openedMode,
      lastResidency
    });
  } finally {
    if (abortHandle !== null) globalThis.clearTimeout(abortHandle);
    await session?.dispose();
    account.dispose();
  }

  return Object.freeze({
    ...outcome,
    telemetry: instrumentation.snapshot(mediaGateCalls),
    terminal: terminalSnapshot(manager.snapshot())
  });

  function recordPhase(phase: M7LoaderProofPhase): void {
    if (session === null) throw new Error("M7 proof session is unavailable");
    const residency = session.snapshot();
    lastResidency = residency;
    phases.push(Object.freeze({
      phase,
      residency,
      resources: manager.snapshot()
    }));
  }
}

/** Decode, evict, and re-decode real PNG surfaces without another asset read. */
export async function runM7StaticEvictionProof(
  assetUrl: string
): Promise<Readonly<M7StaticEvictionProof>> {
  const policy = createRuntimePageResourcePolicy({
    maximumDecoderLeases: 1,
    maximumPagePhysicalBytes: 4 * 1024 * 1024,
    maximumPlayerLogicalBytes: 4 * 1024 * 1024
  });
  const pageRuntime = new PlayerWebPageRuntime({ policy });
  const participant = pageRuntime.createParticipant({
    visibility: "visible",
    phase: "preparing"
  });
  const resources = participant.resources;
  const session = await participant.openAsset({ url: assetUrl });
  const animatedCanvas = document.createElement("canvas");
  const staticCanvas = document.createElement("canvas");
  const layer = document.createElement("div");
  layer.hidden = true;
  layer.append(animatedCanvas, staticCanvas);
  document.body.append(layer);
  const visibility: boolean[] = [];
  const planes = await BrowserPresentationPlanes.create({
    animatedCanvas,
    staticCanvas,
    canvas: session.catalog.manifest.canvas,
    maxBackingBytes: 4 * 1024 * 1024,
    setStaticVisible(visible) {
      visibility.push(visible);
    },
    backingResources: resources.canvasBacking
  });
  await planes.resizeWithAdmission({
    cssWidth: session.catalog.manifest.canvas.width,
    cssHeight: session.catalog.manifest.canvas.height,
    devicePixelRatio: 1,
    fit: "fill"
  });
  const decoder = new BrowserStaticSurfaceDecoder({
    resourceHost: resources.staticDecoder
  });
  let store: StaticSurfaceStore | null = null;
  let activeStatic: ReturnType<StaticSurfaceStore["snapshot"]> | null = null;
  let terminalStatic: ReturnType<StaticSurfaceStore["snapshot"]> | null = null;
  let result: Omit<
    M7StaticEvictionProof,
    "staticCounters" | "terminal"
  > | null = null;
  try {
    await session.ensureAllStatics();
    store = new StaticSurfaceStore(
      asStaticSurfaceCatalog(session.catalog),
      decoder,
      planes.staticPlane,
      {
        resourceHost: resources.staticSurfaces,
        retainOptionalSurfaces: true
      }
    );
    await store.installInitial();
    await store.validateAll();
    const before = store.snapshot();
    const eviction: {
      value: ReturnType<StaticSurfaceStore["reclaimOldest"]>;
    } = { value: null };
    participant.registerStaticSurfaceReclaimer({
      reclaimOldest() {
        eviction.value = store!.reclaimOldest();
        return eviction.value;
      }
    });
    const requester = pageRuntime.createParticipant({ phase: "loading" });
    const pageBeforePressure = pageRuntime.snapshot().resources;
    const pressure = await requester.resources.staticDecoder.reserve(
      "png-copy",
      policy.maximumPagePhysicalBytes - pageBeforePressure.physicalBytes + 1
    );
    pressure.release();
    const victim = eviction.value;
    if (victim === null) throw new Error("M7 proof found no optional static");
    const afterEviction = store.snapshot();
    const state = session.catalog.manifest.states.find(
      ({ staticFrame }) => staticFrame === victim.staticFrame
    );
    if (state === undefined) throw new Error("M7 evicted static has no state");
    const presentation = await store.presentState(state.id);
    if (!presentation.redecoded) {
      throw new Error("M7 evicted static was not re-decoded");
    }
    activeStatic = store.snapshot();
    result = Object.freeze({
      evictedByPagePressure: true as const,
      evictedStatic: victim.staticFrame,
      redecodedStatic: presentation.staticFrame,
      retainedBefore: before.retainedSurfaces,
      retainedAfterEviction: afterEviction.retainedSurfaces,
      redecodedSurfaces: activeStatic.redecodedSurfaces,
      visibility: Object.freeze(visibility.slice())
    });
  } finally {
    store?.dispose();
    terminalStatic = store?.snapshot() ?? null;
    planes.dispose();
    await session.dispose();
    await pageRuntime.dispose();
    layer.remove();
  }
  if (result === null || activeStatic === null || terminalStatic === null) {
    throw new Error("M7 static eviction proof did not run");
  }
  return Object.freeze({
    ...result,
    staticCounters: Object.freeze({
      decodedSurfaces: activeStatic.decodedSurfaces,
      redecodedSurfaces: activeStatic.redecodedSurfaces,
      evictions: activeStatic.cache.evictions,
      closedBeforeDispose: activeStatic.closedSurfaces,
      closedAfterDispose: terminalStatic.closedSurfaces,
      peakRetainedSurfaces: activeStatic.peakRetainedSurfaces,
      peakRetainedRgbaBytes: activeStatic.peakRetainedRgbaBytes,
      leaseReservations: activeStatic.leaseReservations,
      leaseReleasesBeforeDispose: activeStatic.leaseReleases,
      leaseReleasesAfterDispose: terminalStatic.leaseReleases
    }),
    terminal: terminalSnapshot(pageRuntime.snapshot().resources)
  });
}

function proofFailureCode(
  error: unknown
): RuntimeFailureCode | "AbortError" | "unknown" {
  if (isRuntimePlaybackError(error)) return error.failure.code;
  if (
    error instanceof DOMException &&
    error.name === "AbortError"
  ) return "AbortError";
  return "unknown";
}

function terminalSnapshot(
  snapshot: Readonly<RuntimePageResourceSnapshot>
): Readonly<M7LoaderTerminalSnapshot> {
  return Object.freeze({
    physicalBytes: snapshot.physicalBytes,
    byteLeases: snapshot.byteLeaseCount,
    participants: snapshot.participants.length,
    decoderLeases: snapshot.decoderLeaseCount,
    decoderQueue: snapshot.decoderQueueLength
  });
}
