import { describe, expect, it, vi } from "vitest";

import {
  ElementAssetGeneration,
  RuntimeModuleImportError,
  type ElementBrowserRuntimeFactory
} from "../src/asset-generation.js";
import type {
  BrowserRuntimeMetadata,
  BrowserRuntimePlayer
} from "../src/browser-runtime-factory.js";
import type { ShadowLayerOwner } from "../src/shadow-layers.js";
import type { AvalCleanupReceipt } from "../src/public-types.js";
import { RuntimeAcquisitionCleanupError } from "../src/runtime-acquisition-error.js";

const SOURCE_CANDIDATES = Object.freeze([
  Object.freeze({
    src: "asset.av1.avl",
    type: 'application/vnd.aval; codecs="av01.0.08M.10"' as const,
    codec: "av01.0.08M.10",
    integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
  }),
  Object.freeze({
    src: "asset.h264.avl",
    type: 'application/vnd.aval; codecs="avc1.640028"' as const,
    codec: "avc1.640028",
    integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
  })
]);

describe("ElementAssetGeneration", () => {
  it("does not reapply the motion policy captured by runtime construction", async () => {
    let policyCalls = 0;
    let hostReducedCalls = 0;
    let publishCleanup: () => void = () => undefined;
    const runtime = runtimeFixture(async () => { publishCleanup(); });
    runtime.setMotionPolicy = async () => { policyCalls += 1; };
    runtime.setHostReducedMotion = async () => { hostReducedCalls += 1; };
    const generation = testGeneration(async (input) => {
      publishCleanup = () => input.cleanupSink(completeReceipt(1));
      return runtime;
    }, () => undefined);

    await generation.setMotionPolicy("auto", false);

    expect(policyCalls).toBe(0);
    expect(hostReducedCalls).toBe(0);
    await generation.dispose();
  });

  it("shares preparation, exposes arbitrary states, and retires all ownership", async () => {
    let prepares = 0;
    let disposals = 0;
    let publishCleanup: () => void = () => undefined;
    let capturedInitialPresentation: unknown;
    let capturedSourceCandidates: unknown;
    let capturedCredentials: unknown;
    const metadata: BrowserRuntimeMetadata = Object.freeze({
      initialState: "idle",
      stateNames: Object.freeze(["idle", "success"]),
      eventNames: Object.freeze(["request.success"]),
      bindings: Object.freeze([]),
      renditions: Object.freeze([]),
      canvas: Object.freeze({
        width: 10,
        height: 10,
        fit: "contain",
        pixelAspect: Object.freeze([1, 1] as const)
      })
    });
    const runtime = {
      metadata,
      activate: () => undefined,
      prepare: async () => {
        prepares += 1;
        return Object.freeze({
          mode: "static" as const,
          reason: "worker-unavailable" as const,
          report: Object.freeze({
            readiness: "staticReady" as const,
            selectedRendition: null,
            candidates: Object.freeze([])
          })
        });
      },
      requestState: async () => undefined,
      canSend: (event: string) => event === "request.success",
      send: (event: string) => event === "request.success",
      readyFor: () => false,
      pause: () => undefined,
      resume: async () => undefined,
      setMotionPolicy: async () => undefined,
      setHostReducedMotion: async () => undefined,
      setVisibility: async () => undefined,
      resize: () => undefined,
      snapshot: () => ({}),
      settled: async () => undefined,
      dispose: async () => {
        disposals += 1;
        publishCleanup();
      }
    } as unknown as BrowserRuntimePlayer;
    const stages: {
      readiness: string;
      requestedState: string | null;
      visualState: string | null;
      transitioning: boolean;
    } = { readiness: "unready", requestedState: null, visualState: null, transitioning: false };
    const generation = new ElementAssetGeneration({
      window: {} as Window,
      document: {} as Document,
      layers: {} as ShadowLayerOwner,
      elementGeneration: 1,
      generation: 1,
      sourceCandidates: SOURCE_CANDIDATES,
      credentials: "same-origin",
      motionPolicy: "auto",
      hostReducedMotion: false,
      initialVisibility: "hidden",
      initialPresentation: {
        cssWidth: 320,
        cssHeight: 180,
        devicePixelRatio: 2,
        fit: "cover"
      },
      factory: async (input) => {
        capturedInitialPresentation = input.initialPresentation;
        capturedSourceCandidates = input.sourceCandidates;
        capturedCredentials = input.credentials;
        publishCleanup = () => input.cleanupSink(completeReceipt(1));
        input.onMetadata(metadata);
        return runtime;
      },
      host: {
        eventTarget: new EventTarget(),
        eventStage: {
          readiness: (value) => { stages.readiness = value; },
          requestedState: (value) => { stages.requestedState = value; },
          visualState: (value) => { stages.visualState = value; },
          transitioning: (value) => { stages.transitioning = value; },
          snapshot: () => ({
            requestedState: stages.requestedState,
            visualState: stages.visualState
          })
        },
        createEvent: () => new Event("unused") as CustomEvent<never>,
        metadata: () => undefined,
        prepared: () => undefined,
        failure: () => undefined,
        underflow: () => undefined
        ,cleanup: () => undefined
      }
    });
    const first = generation.prepare();
    const second = generation.prepare();
    expect(await first).toBe(await second);
    expect(prepares).toBe(1);
    expect(capturedInitialPresentation).toEqual({
      cssWidth: 320,
      cssHeight: 180,
      devicePixelRatio: 2,
      fit: "cover"
    });
    expect(capturedSourceCandidates).toBe(SOURCE_CANDIDATES);
    expect(capturedCredentials).toBe("same-origin");
    expect(generation.canSend("request.success")).toBe(true);
    expect(generation.send("request.success")).toBe(true);
    await generation.setState("success");
    await generation.dispose();
    expect(disposals).toBe(1);
    await expect(generation.prepare()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("installs the runtime before metadata sampling routes automatic events", async () => {
    let generation!: ElementAssetGeneration;
    let accepted = false;
    let publishCleanup: () => void = () => undefined;
    const metadata: BrowserRuntimeMetadata = Object.freeze({
      initialState: "idle",
      stateNames: Object.freeze(["idle", "hover"]),
      eventNames: Object.freeze(["hover-on"]),
      bindings: Object.freeze([
        Object.freeze({ source: "pointer.enter" as const, event: "hover-on" })
      ]),
      renditions: Object.freeze([]),
      canvas: Object.freeze({
        width: 10,
        height: 10,
        fit: "contain",
        pixelAspect: Object.freeze([1, 1] as const)
      })
    });
    const runtime = {
      metadata,
      activate: () => onMetadata(metadata),
      prepare: async () => Object.freeze({
        mode: "static" as const,
        reason: "worker-unavailable" as const,
        report: Object.freeze({
          readiness: "staticReady" as const,
          selectedRendition: null,
          candidates: Object.freeze([])
        })
      }),
      requestState: async () => undefined,
      send: (event: string) => {
        accepted = event === "hover-on";
        return accepted;
      },
      readyFor: () => false,
      pause: () => undefined,
      resume: async () => undefined,
      setMotionPolicy: async () => undefined,
      setHostReducedMotion: async () => undefined,
      setVisibility: async () => undefined,
      resize: () => undefined,
      snapshot: () => ({}),
      settled: async () => undefined,
      dispose: async () => { publishCleanup(); }
    } as unknown as BrowserRuntimePlayer;
    let onMetadata: (value: Readonly<BrowserRuntimeMetadata>) => void = () => undefined;
    generation = new ElementAssetGeneration({
      window: {} as Window,
      document: {} as Document,
      layers: {} as ShadowLayerOwner,
      elementGeneration: 1,
      generation: 1,
      sourceCandidates: SOURCE_CANDIDATES,
      credentials: "same-origin",
      motionPolicy: "auto",
      hostReducedMotion: false,
      initialVisibility: "hidden",
      factory: async (input) => {
        publishCleanup = () => input.cleanupSink(completeReceipt(1));
        onMetadata = input.onMetadata;
        return runtime;
      },
      host: {
        eventTarget: new EventTarget(),
        eventStage: {
          readiness: () => undefined,
          requestedState: () => undefined,
          visualState: () => undefined,
          transitioning: () => undefined,
          snapshot: () => ({ requestedState: "idle", visualState: "idle" })
        },
        createEvent: () => new Event("unused") as CustomEvent<never>,
        metadata: () => { generation.send("hover-on"); },
        prepared: () => undefined,
        failure: () => undefined,
        underflow: () => undefined
        ,cleanup: () => undefined
      }
    });
    await generation.prepare();
    expect(accepted).toBe(true);
    await generation.dispose();
  });

  it("awaits a promptly late factory owner and its cleanup receipt", async () => {
    let resolveFactory!: (runtime: BrowserRuntimePlayer) => void;
    let releaseCleanup!: () => void;
    let cleanupStarted = false;
    let publishCleanup: () => void = () => undefined;
    const receipts: Readonly<AvalCleanupReceipt>[] = [];
    const runtime = runtimeFixture(async () => {
      cleanupStarted = true;
      await new Promise<void>((resolve) => { releaseCleanup = resolve; });
      publishCleanup();
    });
    const generation = testGeneration((input) => {
      publishCleanup = () => input.cleanupSink(completeReceipt(1));
      return new Promise((resolve) => { resolveFactory = resolve; });
    }, (receipt) => receipts.push(receipt));
    await Promise.resolve();
    const disposal = generation.dispose();
    resolveFactory(runtime);
    for (let index = 0; index < 10 && !cleanupStarted; index += 1) {
      await Promise.resolve();
    }
    expect(cleanupStarted).toBe(true);
    let settled = false;
    void disposal.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseCleanup();
    await disposal;
    expect(receipts.at(-1)).toMatchObject({ completed: true, sourceGeneration: 1 });
  });

  it("bounds a stalled factory and retains an explicit incomplete receipt", async () => {
    vi.useFakeTimers();
    try {
      const receipts: Readonly<AvalCleanupReceipt>[] = [];
      const generation = testGeneration(
        () => new Promise<BrowserRuntimePlayer>(() => undefined),
        (receipt) => receipts.push(receipt)
      );
      const disposal = generation.dispose();
      const rejection = expect(disposal).rejects.toThrow("did not settle");
      await vi.advanceTimersByTimeAsync(501);
      await rejection;
      expect(receipts.at(-1)).toMatchObject({
        completed: false,
        failureCount: 1,
        playerDisposed: false,
        sourceGeneration: 1
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("proves ownerless runtime-module rejection and permits final disposal", async () => {
    const receipts: Readonly<AvalCleanupReceipt>[] = [];
    const generation = testGeneration(
      async () => { throw new RuntimeModuleImportError(); },
      (receipt) => receipts.push(receipt)
    );
    await expect(generation.prepare()).rejects.toBeInstanceOf(RuntimeModuleImportError);
    expect(receipts.at(-1)).toMatchObject({
      completed: true,
      failureCount: 0,
      playerDisposed: true,
      participantDisposed: true,
      sourceGeneration: 1
    });
    await expect(generation.dispose()).resolves.toBeUndefined();
  });

  it("retains and retries cleanup ownership from a rejected runtime construction", async () => {
    let cleanupAttempts = 0;
    const receipts: Readonly<AvalCleanupReceipt>[] = [];
    const generation = testGeneration(async (input) => {
      throw new RuntimeAcquisitionCleanupError(
        new Error("injected construction failure"),
        async () => {
          cleanupAttempts += 1;
          if (cleanupAttempts === 1) throw new Error("injected cleanup retry failure");
          input.cleanupSink(completeReceipt(1));
        }
      );
    }, (receipt) => receipts.push(receipt));
    await expect(generation.prepare()).rejects.toBeInstanceOf(
      RuntimeAcquisitionCleanupError
    );
    await expect(generation.dispose()).rejects.toBeInstanceOf(
      RuntimeAcquisitionCleanupError
    );
    expect(generation.cleanupReceipt()).toBeNull();
    await expect(generation.dispose()).resolves.toBeUndefined();
    expect(cleanupAttempts).toBe(2);
    expect(receipts.at(-1)).toMatchObject({
      completed: true,
      sourceGeneration: 1
    });
  });

  it("retries a rejected runtime disposal until cleanup is proven", async () => {
    let attempts = 0;
    let activated = false;
    let publishCleanup: () => void = () => undefined;
    const receipts: Readonly<AvalCleanupReceipt>[] = [];
    const runtime = runtimeFixture(async () => {
      attempts += 1;
      if (attempts <= 2) throw new Error("injected cleanup failure");
      publishCleanup();
    });
    runtime.activate = () => { activated = true; };
    const generation = testGeneration(async (input) => {
      publishCleanup = () => input.cleanupSink(completeReceipt(1));
      return runtime;
    }, (receipt) => receipts.push(receipt));
    for (let index = 0; index < 10 && !activated; index += 1) await Promise.resolve();
    expect(activated).toBe(true);
    await expect(generation.dispose()).rejects.toThrow("cleanup failure");
    await expect(generation.dispose()).resolves.toBeUndefined();
    expect(attempts).toBe(3);
    expect(receipts.at(-1)?.completed).toBe(true);
  });

  it("publishes one canonical fatal watchdog before bounded stalled cleanup", async () => {
    vi.useFakeTimers();
    try {
      const failures: unknown[] = [];
      const receipts: Readonly<AvalCleanupReceipt>[] = [];
      const generation = testGeneration(
        () => new Promise<BrowserRuntimePlayer>(() => undefined),
        (receipt) => receipts.push(receipt),
        (error) => failures.push(error)
      );
      const preparation = generation.prepare().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30_001);
      const error = await preparation as { failure?: { code?: string; context?: { operation?: string } } };
      expect(error.failure).toMatchObject({
        code: "watchdog-timeout",
        context: { operation: "bootstrap" }
      });
      expect(failures).toHaveLength(1);
      expect((failures[0] as typeof error).failure?.code).toBe("watchdog-timeout");
      const disposal = generation.dispose();
      const rejection = expect(disposal).rejects.toThrow("did not settle");
      await vi.advanceTimersByTimeAsync(501);
      await rejection;
      expect(receipts.at(-1)?.completed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

function testGeneration(
  factory: ElementBrowserRuntimeFactory,
  cleanup: (receipt: Readonly<AvalCleanupReceipt>) => void,
  failure: (error: unknown, fatal: boolean) => void = () => undefined
): ElementAssetGeneration {
  return new ElementAssetGeneration({
    window: {} as Window,
    document: {} as Document,
    layers: {} as ShadowLayerOwner,
    elementGeneration: 1,
    generation: 1,
    sourceCandidates: SOURCE_CANDIDATES,
    credentials: "same-origin",
    motionPolicy: "auto",
    hostReducedMotion: false,
    initialVisibility: "hidden",
    factory,
    host: {
      eventTarget: new EventTarget(),
      eventStage: {
        readiness: () => undefined,
        requestedState: () => undefined,
        visualState: () => undefined,
        transitioning: () => undefined,
        snapshot: () => ({ requestedState: null, visualState: null })
      },
      createEvent: () => new Event("unused") as CustomEvent<never>,
      metadata: () => undefined,
      prepared: () => undefined,
      failure,
      underflow: () => undefined,
      cleanup
    }
  });
}

function runtimeFixture(dispose: () => Promise<void>): BrowserRuntimePlayer {
  return {
    metadata: {} as BrowserRuntimeMetadata,
    activate: () => undefined,
    prepare: async () => { throw new Error("unused"); },
    requestState: async () => undefined,
    canSend: () => false,
    send: () => false,
    readyFor: () => false,
    planFor: () => null,
    pause: () => undefined,
    resume: async () => undefined,
    setMotionPolicy: async () => undefined,
    setHostReducedMotion: async () => undefined,
    setVisibility: async () => undefined,
    resize: () => undefined,
    snapshot: () => ({} as never),
    settled: async () => undefined,
    dispose
  };
}

function completeReceipt(sourceGeneration: number) {
  return Object.freeze({
    elementGeneration: 1,
    sourceGeneration,
    completed: true,
    failureCount: 0,
    playerDisposed: true,
    participantDisposed: true,
    participantRegistered: false,
    participantLogicalBytes: 0,
    participantActiveLeaseCount: 0,
    participantRegisteredCleanupCount: 0,
    participantTrackedWorkCount: 0,
    participantPendingWaitCount: 0,
    participantDecoderTicketCount: 0,
    participantDecoderState: null,
    workerCount: 0,
    openFrames: 0,
    pendingRuntimeOperations: 0,
    sourceCopiesInFlight: 0,
    rendererStagingBytes: 0,
    pendingLoads: 0,
    activeTransportBodies: 0,
    interestedWaiters: 0,
    rendererResourceCount: 0,
    contextListenerCount: 0,
    stalePublicationCount: 0,
    pagePhysicalBytes: 0,
    pageParticipantCount: 0,
    pageActiveDecoderLeaseCount: 0,
    pageQueuedDecoderTicketCount: 0,
    pageParkedDecoderTicketCount: 0
  });
}
