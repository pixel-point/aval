import { deriveAvcRenditionGeometry } from "@rendered-motion/format";
import { describe, expect, it, vi } from "vitest";

import type { IntegratedCandidateAttemptContext } from "./integrated-player-contracts.js";
import { BrowserAvcCandidateRendererFactory } from "./browser-avc-candidate-factories.js";
import { createBrowserAvcCandidateComposition } from "./browser-avc-candidate.js";
import { BrowserAvcCandidateHub } from "./browser-avc-candidate-hub.js";
import { BrowserAvcReadinessSession } from "./browser-avc-candidate-readiness.js";
import { BrowserAvcPlaybackSession } from "./browser-avc-playback-session.js";
import type {
  AvcCandidateActivationInput,
  AvcCandidateReadinessSessionInput
} from "./avc-candidate-factory.js";
import type {
  BrowserTrackedRenderer,
  BrowserTrackedWorker
} from "./browser-avc-candidate-hub.js";
import type {
  FrameRenderer,
  FrameRendererSnapshot,
  FrameRendererBackend,
  FrameTextureKind,
  FrameTextureLayout
} from "./frame-renderer.js";

describe("browser AVC candidate composition", () => {
  it("forwards only the planes' narrow context-event capability", () => {
    const canvas = fakeCanvas();
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const composition = createBrowserAvcCandidateComposition({
      canvas,
      presentationPlanes: {
        createFrameBackend: () => new FakeBackend(),
        ownsAnimatedCanvas: () => true,
        currentCanvasBacking: () => Object.freeze({ width: 1, height: 1 }),
        reserveCanvasResources: () => Object.freeze({ release() {} }),
        animatedContextTarget: () => ({
          addEventListener,
          removeEventListener
        })
      }
    });
    const listener = (): void => undefined;

    composition.factory.contextTarget?.addEventListener(
      "webglcontextlost",
      listener
    );
    composition.factory.contextTarget?.removeEventListener(
      "webglcontextlost",
      listener
    );

    expect(addEventListener).toHaveBeenCalledOnce();
    expect(removeEventListener).toHaveBeenCalledOnce();
  });

  it("routes renderer creation through shared presentation planes", () => {
    const canvas = fakeCanvas();
    const backend = new FakeBackend();
    const rendererOptions = Object.freeze({ checkErrors: true });
    const createFrameBackend = vi.fn(() => backend);
    const factory = new BrowserAvcCandidateRendererFactory({
      canvas,
      hub: new BrowserAvcCandidateHub(canvas),
      backend: rendererOptions,
      presentationPlanes: {
        createFrameBackend,
        ownsAnimatedCanvas: () => true,
        currentCanvasBacking: () => Object.freeze({ width: 1, height: 1 }),
        reserveCanvasResources: () => Object.freeze({ release() {} })
      }
    });

    const reservation = factory.create(candidateContext());

    expect(createFrameBackend).toHaveBeenCalledExactlyOnceWith(rendererOptions);
    reservation.dispose();
    expect(backend.disposals).toBe(1);
  });

  it("keeps absent tracked readback nonterminal", () => {
    const canvas = fakeCanvas();
    const backend = new FakeBackend();
    const factory = new BrowserAvcCandidateRendererFactory({
      canvas,
      hub: new BrowserAvcCandidateHub(canvas),
      createFrameBackend: () => backend
    });
    const reservation = factory.create(candidateContext());
    const renderer = reservation.allocate({
      geometry: deriveAvcRenditionGeometry({
        profile: "avc-annexb-opaque-v0",
        canvasWidth: 4,
        canvasHeight: 2,
        colorRect: [0, 0, 4, 2],
        codedWidth: 16,
        codedHeight: 16
      }),
      logicalWidth: 4,
      logicalHeight: 2,
      residentLayerCount: 0
    });

    expect(() => renderer.readPixels()).toThrow("pixel readback is unavailable");
    expect(renderer.snapshot().state).toBe("active");
    renderer.dispose();
    expect(backend.disposals).toBe(1);
  });

  it("retains an older retired renderer until its native source copy settles", () => {
    const hub = new BrowserAvcCandidateHub(fakeCanvas());
    let oldCopies = 1;
    hub.registerRenderer(trackedRenderer(() => oldCopies));
    hub.registerRenderer(trackedRenderer(() => 0));

    expect(hub.snapshot().cleanup).toMatchObject({
      sourceCopiesInFlight: 1,
      rendererStagingBytes: 0,
      complete: false
    });

    oldCopies = 0;
    expect(hub.snapshot().cleanup).toMatchObject({
      sourceCopiesInFlight: 0,
      rendererStagingBytes: 0,
      complete: true
    });
  });

  it("retains an older retired worker until every owned operation settles", () => {
    const hub = new BrowserAvcCandidateHub(fakeCanvas());
    let oldPending = 1;
    hub.registerWorker(trackedWorker(() => oldPending));
    hub.registerWorker(trackedWorker(() => 0));

    expect(hub.snapshot().cleanup).toMatchObject({
      pendingOperations: 1,
      complete: false
    });

    oldPending = 0;
    expect(hub.snapshot().cleanup).toMatchObject({
      pendingOperations: 0,
      complete: true
    });
  });

  it("quarantines a playback session that resolves after readiness disposal", async () => {
    const hub = new BrowserAvcCandidateHub(fakeCanvas());
    const late = deferred<BrowserAvcPlaybackSession>();
    const dispose = vi.fn(async () => undefined);
    const playback = {
      dispose,
      drawInitial() {}
    } as unknown as BrowserAvcPlaybackSession;
    const create = vi.spyOn(BrowserAvcPlaybackSession, "create")
      .mockReturnValue(late.promise);
    try {
      const readiness = new BrowserAvcReadinessSession(
        {} as AvcCandidateReadinessSessionInput,
        hub,
        () => 0
      );
      const controller = new AbortController();
      const activation = {
        signal: controller.signal
      } as AvcCandidateActivationInput;
      const preparing = readiness.prepareActivation(activation);

      expect(create).toHaveBeenCalledOnce();
      readiness.dispose();
      late.resolve(playback);

      await expect(preparing).rejects.toMatchObject({ name: "AbortError" });
      expect(dispose).toHaveBeenCalledOnce();
      expect(hub.snapshot().activeRendition).toBeNull();
    } finally {
      create.mockRestore();
    }
  });

  it("rolls back a partially constructed playback session and preserves its initial error", async () => {
    const failure = new Error("selected initial preparation failure");
    const schedulerDispose = vi.fn(async () => undefined);
    const controller = new AbortController();
    const scheduler = {
      snapshot: () => Object.freeze({ generation: null }),
      dispose: schedulerDispose
    };
    const candidate = {
      context: { candidate: { rendition: { id: "packed" } } },
      interactionCache: { reversibleClips: [] },
      timeline: { activateNextGeneration: () => 1 },
      worker: {
        activeGeneration: 1,
        snapshotMetrics: async () => ({
          pendingSamples: 0,
          submittedFrames: 0,
          leasedFrames: 0
        }),
        submit: async () => undefined,
        waitForFrames: async () => { throw failure; }
      },
      samples: {
        createBatch: () => ({ samples: [{}] })
      },
      renderer: {
        resourceGeneration: 1,
        residentHandle: () => ({ kind: "resident" }),
        draw() {},
        uploadStreaming: async () => null
      }
    } as unknown as AvcCandidateReadinessSessionInput;
    const activation = {
      graphSnapshot: {
        contentOrdinal: null,
        pendingEdgeId: null,
        activeEdgeId: null,
        followOnEdgeId: null
      },
      expectedPresentation: {
        kind: "intro",
        state: "idle",
        unitId: "intro",
        frameIndex: 0
      },
      scheduler,
      finalResourcePlan: { ringCapacity: 2 },
      signal: controller.signal,
      deadlineMs: 1_000
    } as unknown as AvcCandidateActivationInput;

    await expect(BrowserAvcPlaybackSession.create({
      candidate,
      activation,
      hub: new BrowserAvcCandidateHub(fakeCanvas())
    })).rejects.toBe(failure);
    expect(schedulerDispose).toHaveBeenCalledOnce();
  });
});

function trackedWorker(pending: () => number): BrowserTrackedWorker {
  return {
    settled: async () => undefined,
    induceFailure() {},
    snapshot() {
      return Object.freeze({
        metrics: null,
        openFrames: 0,
        pendingRequests: pending(),
        pendingWaiters: 0,
        alive: false
      });
    }
  };
}

function trackedRenderer(
  copies: () => number
): BrowserTrackedRenderer {
  return {
    renderer: null as unknown as FrameRenderer,
    snapshot() {
      return Object.freeze({
        snapshot: retiredRendererSnapshot(copies()),
        backendAlive: false,
        glResourceCount: 0
      });
    }
  };
}

function retiredRendererSnapshot(
  sourceCopiesInFlight: number
): Readonly<FrameRendererSnapshot> {
  return Object.freeze({
    state: "disposed",
    resourceGeneration: 2,
    stagingBytes: 0,
    sourceCopiesInFlight,
    codedTextureBytesPerLayer: 0,
    allocatedTextureBytes: 0,
    allocatedTextureLayers: 0,
    allocatedLayers: 0,
    uploadedResidentLayers: 0,
    uploadedStreamingSlots: 0,
    residentUploads: 0,
    streamingUploads: 0,
    draws: 0,
    closedSourceFrames: 0,
    staleUploads: 0,
    errors: 0
  });
}

class FakeBackend implements FrameRendererBackend {
  public readonly limits = Object.freeze({
    maxTextureSize: 2_048,
    maxArrayTextureLayers: 128
  });
  public disposals = 0;

  public allocate(_layout: FrameTextureLayout, _slots: number): void {}
  public setPresentationGeometry(): boolean {
    return true;
  }
  public upload(
    _kind: FrameTextureKind,
    _index: number,
    _pixels: Uint8Array
  ): void {}
  public draw(_kind: FrameTextureKind, _index: number): void {}
  public dispose(): void {
    this.disposals += 1;
  }
}

function fakeCanvas(): HTMLCanvasElement {
  return {
    width: 1,
    height: 1,
    getContext: () => null
  } as unknown as HTMLCanvasElement;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function candidateContext(): Readonly<IntegratedCandidateAttemptContext> {
  return {
    candidate: {
      visibleColorArea: 4_096,
      rendition: {
        id: "packed",
        bitrate: { peak: 2_000 }
      }
    }
  } as unknown as Readonly<IntegratedCandidateAttemptContext>;
}
