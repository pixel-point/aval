import {
  BrowserPresentationPlanes,
  IntegratedPlayer,
  PlayerWebPageRuntime,
  StateFallbackStore,
  createBrowserVideoCandidateComposition,
  createSourceSupportProbe,
  selectVideoSource,
  type Binding,
  type BrowserVideoCandidateComposition,
  type EffectHostEvent,
  type MotionPolicy,
  type PresentationFit,
  type RuntimeAssetSession,
  type RuntimeFailure,
  type RuntimeVisibilityState,
  type StaticReason
} from "@pixel-point/aval-player-web";

import { ShadowLayerOwner } from "./shadow-layers.js";
import type {
  BrowserRuntimeMetadata,
  BrowserRuntimePlayer
} from "./browser-runtime-contracts.js";
import { BrowserRuntimePlayerOwner } from "./browser-runtime-player.js";
import {
  captureCleanupReceipt,
  settleCleanupOperation
} from "./cleanup-receipt.js";
import type {
  AvalCleanupReceipt,
  AvalRing,
  AvalSourceCandidate
} from "./public-types.js";
import { RuntimeAcquisitionCleanupError } from "./runtime-acquisition-error.js";

export type {
  BrowserRuntimeMetadata,
  BrowserRuntimePlayer,
  BrowserRuntimePlayerSnapshot
} from "./browser-runtime-contracts.js";

export interface BrowserRuntimeFactoryInput {
  readonly window: Window;
  readonly document: Document;
  readonly layers: ShadowLayerOwner;
  readonly generation: number;
  readonly elementGeneration: number;
  readonly sourceCandidates: readonly Readonly<AvalSourceCandidate>[];
  readonly credentials: "same-origin" | "include";
  readonly motionPolicy: MotionPolicy;
  readonly hostReducedMotion: boolean;
  readonly initialVisibility: RuntimeVisibilityState;
  readonly initialPresentation?: Readonly<{
    cssWidth: number;
    cssHeight: number;
    devicePixelRatio: number;
    fit?: PresentationFit;
  }>;
  readonly signal: AbortSignal;
  readonly eventSink: (event: Readonly<EffectHostEvent>) => void;
  readonly diagnosticsSink: (failure: Readonly<RuntimeFailure>) => void;
  readonly cleanupSink: (receipt: Readonly<AvalCleanupReceipt>) => void;
  readonly underflowSink: (ordinal: bigint) => void;
  readonly onMetadata: (metadata: Readonly<BrowserRuntimeMetadata>) => void;
}

const PAGE_RUNTIMES = new WeakMap<Window, PlayerWebPageRuntime>();

export async function createBrowserRuntimePlayer(
  input: Readonly<BrowserRuntimeFactoryInput>
): Promise<BrowserRuntimePlayer> {
  const pageRuntime = pageRuntimeFor(input.window);
  const participant = pageRuntime.createParticipant({
    visibility: input.initialVisibility,
    phase: "loading"
  });
  const participantId = participant.snapshot().account.participantId;
  let session: RuntimeAssetSession | null = null;
  let planes: BrowserPresentationPlanes | null = null;
  let composition: Readonly<BrowserVideoCandidateComposition> | null = null;
  let player: IntegratedPlayer | null = null;
  let releaseOwnedPlayer: (() => void) | null = null;
  let fallbackStore: StateFallbackStore | null = null;
  const disposeConstruction = async (): Promise<void> => {
    const failures: unknown[] = [];
    const participantDisposal = settleCleanupOperation(
      () => participant.dispose(),
      failures
    );
    await participantDisposal;
    await Promise.all([
      settleCleanupOperation(() => player?.dispose(), failures),
      settleCleanupOperation(() => composition?.controls.settled(), failures)
    ]);
    await settleCleanupOperation(() => session?.dispose(), failures);
    await Promise.all([
      settleCleanupOperation(() => releaseOwnedPlayer?.(), failures),
      settleCleanupOperation(() => fallbackStore?.dispose(), failures),
      settleCleanupOperation(() => planes?.dispose(), failures)
    ]);
    const receipt = captureCleanupReceipt({
      elementGeneration: input.elementGeneration,
      sourceGeneration: input.generation,
      participantId,
      pageRuntime,
      participant,
      session,
      planes,
      composition,
      player,
      operationFailureCount: failures.length
    });
    try { input.cleanupSink(receipt); } catch (error) { failures.push(error); }
    if (failures.length > 0 || !receipt.completed) {
      throw failures[0] ?? new Error("runtime construction cleanup is incomplete");
    }
  };
  try {
    if (input.sourceCandidates.length === 0) {
      throw new TypeError("AVAL runtime requires at least one source candidate");
    }
    const sourceSelection = await selectVideoSource({
      candidates: Object.freeze(input.sourceCandidates.map((candidate, authoredIndex) =>
        Object.freeze({
          ...candidate,
          authoredIndex,
          url: new URL(candidate.src, input.document.baseURI)
        })
      )),
      signal: input.signal,
      open: (candidate, signal) => participant.openAsset({
        url: candidate.url,
        credentials: input.credentials,
        signal,
        ...(candidate.integrity === ""
          ? {}
          : { integrity: candidate.integrity })
      }),
      createProbe: () => createSourceSupportProbe(),
      isResourceEligible: (rendition, _candidate, openedSession) =>
        rendition.geometry.decodedRgbaBytes <=
          openedSession.catalog.manifest.limits.maxRuntimeBytes
    });
    session = sourceSelection.session;
    const catalog = session.catalog;
    const manifest = catalog.manifest;
    const metadata = captureMetadata(manifest);
    const generation = input.generation;
    planes = await BrowserPresentationPlanes.create({
      animatedCanvas: input.layers.animatedCanvas,
      canvas: manifest.canvas,
      maxBackingBytes: manifest.limits.maxRuntimeBytes,
      initialPresentation: input.initialPresentation ?? Object.freeze({
        cssWidth: 1,
        cssHeight: 1,
        devicePixelRatio: 1
      }),
      backingResources: participant.resources.canvasBacking
    });
    composition = createBrowserVideoCandidateComposition({
      canvas: input.layers.animatedCanvas,
      presentationPlanes: planes,
      resourceAuthority: participant.resources.candidate,
      diagnosticsSink: input.diagnosticsSink
    });
    const bufferedEvents: Readonly<EffectHostEvent>[] = [];
    let publishEvents = false;
    player = new IntegratedPlayer({
      assetSession: session,
      assetSessionOwnership: "external",
      selectedRendition: sourceSelection.rendition,
      candidateFactory: composition.factory,
      participantBinding: participant.resources.participant,
      createFallbackStore(runtimeCatalog) {
        const created = new StateFallbackStore(runtimeCatalog, {
          coverFallback: () => input.layers.coverFallback(generation),
          revealAnimated: () => {
            input.layers.markAnimatedDrawn(generation);
            input.layers.revealAnimated(generation);
          }
        });
        fallbackStore = created;
        return created;
      },
      motionPolicy: input.motionPolicy,
      hostReducedMotion: input.hostReducedMotion,
      initialVisibility: input.initialVisibility,
      realtime: {
        requestFrame: (callback) => input.window.requestAnimationFrame(callback),
        cancelFrame: (handle) => input.window.cancelAnimationFrame(handle),
        now: () => input.window.performance.now(),
        onUnderflow: (event) => input.underflowSink(event.presentationOrdinal)
      },
      eventSink: (event) => {
        if (publishEvents) input.eventSink(event);
        else bufferedEvents.push(event);
      },
      diagnosticsSink: input.diagnosticsSink
    });
    if (fallbackStore === null) {
      throw new Error("integrated player did not create its fallback store");
    }
    releaseOwnedPlayer = participant.ownPlayer(player);
    return new BrowserRuntimePlayerOwner({
      pageRuntime,
      participant,
      session,
      planes,
      composition,
      player,
      metadata,
      releaseOwnedPlayer,
      fallbackStore,
      elementGeneration: input.elementGeneration,
      sourceGeneration: input.generation,
      cleanupSink: input.cleanupSink,
      diagnosticsSink: input.diagnosticsSink,
      activate: () => {
        input.onMetadata(metadata);
        publishEvents = true;
        for (const event of bufferedEvents) input.eventSink(event);
        bufferedEvents.length = 0;
      }
    });
  } catch (error) {
    try {
      await disposeConstruction();
    } catch (cleanupError) {
      throw new RuntimeAcquisitionCleanupError(
        new AggregateError([error, cleanupError]),
        disposeConstruction
      );
    }
    throw error;
  }
}

function captureMetadata(manifest: Readonly<{
  initialState: string;
  states: readonly Readonly<{ id: string }>[];
  edges: readonly Readonly<{
    trigger?: Readonly<{ type: string; name?: string }>;
  }>[];
  bindings: readonly Readonly<Binding>[];
  rings?: readonly Readonly<AvalRing>[];
  renditions: readonly Readonly<{
    id: string;
    codec: string;
    bitDepth: 8 | 10;
  }>[];
  canvas: Readonly<{
    width: number;
    height: number;
    fit: PresentationFit;
    pixelAspect: readonly [number, number];
  }>;
}>): Readonly<BrowserRuntimeMetadata> {
  const eventNames: string[] = [];
  const seen = new Set<string>();
  for (const edge of manifest.edges) {
    if (
      edge.trigger?.type === "event" &&
      typeof edge.trigger.name === "string" &&
      !seen.has(edge.trigger.name)
    ) {
      seen.add(edge.trigger.name);
      eventNames.push(edge.trigger.name);
    }
  }
  return Object.freeze({
    initialState: manifest.initialState,
    stateNames: Object.freeze(manifest.states.map(({ id }) => id)),
    eventNames: Object.freeze(eventNames),
    bindings: Object.freeze(manifest.bindings.map((binding) =>
      Object.freeze({ source: binding.source, event: binding.event })
    )),
    rings: Object.freeze((manifest.rings ?? []).map((ring) =>
      Object.freeze({
        id: ring.id,
        states: Object.freeze([...ring.states]),
        cyclic: ring.cyclic
      })
    )),
    renditions: Object.freeze(manifest.renditions.map((rendition) =>
      Object.freeze({
        id: rendition.id,
        codec: rendition.codec,
        bitDepth: rendition.bitDepth
      })
    )),
    canvas: Object.freeze({
      width: manifest.canvas.width,
      height: manifest.canvas.height,
      fit: manifest.canvas.fit,
      pixelAspect: Object.freeze([
        manifest.canvas.pixelAspect[0],
        manifest.canvas.pixelAspect[1]
      ] as const)
    })
  });
}

function pageRuntimeFor(window: Window): PlayerWebPageRuntime {
  let runtime = PAGE_RUNTIMES.get(window);
  if (runtime === undefined) {
    runtime = new PlayerWebPageRuntime();
    PAGE_RUNTIMES.set(window, runtime);
  }
  return runtime;
}

export type { StaticReason };
