import type {
  DecoderWorkerConfigureOptions,
  DecoderWorkerWaitOptions,
  ManagedDecoderWorkerFrame
} from "../decoder-worker/client.js";
import {
  createDecoderWorkerClient,
  createOwnedDecoderWorkerClient
} from "../decoder-worker/factory.js";
import type {
  CreateDecoderWorkerClientOptions,
  OwnedDecoderWorkerPort
} from "../decoder-worker/factory.js";
import type {
  DecoderWorkerMetrics,
  DecoderWorkerSample
} from "../decoder-worker/protocol.js";
import type { IntegratedCandidateAttemptContext } from "./integrated-player-contracts.js";
import type {
  AvcCandidateRendererFactory,
  AvcCandidateRendererReservation,
  AvcCandidateWorker,
  AvcCandidateWorkerFactory
} from "./avc-candidate-factory.js";
import {
  BrowserFrameBackend,
  type BrowserFrameBackendOptions
} from "./frame-renderer-browser.js";
import {
  FrameRenderer,
  type CopyableVideoFrame,
  type FrameRendererBackend,
  type FrameSourceLayout,
  type FrameTextureLayout,
  type FrameTextureKind,
  type LegacyOpaqueFrameRendererBackend
} from "./frame-renderer.js";
import type {
  BrowserAvcCandidateCompositionOptions,
  BrowserAvcWorkerSnapshot,
  BrowserAvcRendererSnapshot,
  BrowserAvcCandidateTestDependencies
} from "./browser-avc-candidate-contracts.js";
import {
  BrowserAvcCandidateHub,
  type BrowserTrackedRenderer,
  type BrowserTrackedWorker
} from "./browser-avc-candidate-hub.js";

export class BrowserAvcCandidateWorkerFactory
  implements AvcCandidateWorkerFactory {
  readonly #hub: BrowserAvcCandidateHub;
  readonly #options: CreateDecoderWorkerClientOptions;
  readonly #createPort: BrowserAvcCandidateTestDependencies["createWorkerPort"];

  public readonly available: boolean;

  public constructor(options: {
    readonly hub: BrowserAvcCandidateHub;
    readonly worker?: CreateDecoderWorkerClientOptions;
    readonly createWorkerPort?: BrowserAvcCandidateTestDependencies["createWorkerPort"];
  }) {
    this.#hub = options.hub;
    this.#options = options.worker ?? {};
    this.#createPort = options.createWorkerPort;
    this.available = this.#createPort !== undefined ||
      this.#options.workerFactory !== undefined ||
      typeof Worker !== "undefined";
  }

  public create(
    context: Readonly<IntegratedCandidateAttemptContext>
  ): AvcCandidateWorker {
    this.#hub.registerCandidate(context);
    let port: InducibleWorkerPort | null = null;
    const configuredFactory = this.#createPort ?? this.#options.workerFactory;
    const ownPort = (inner: OwnedDecoderWorkerPort): InducibleWorkerPort => {
        port = new InducibleWorkerPort(inner as OwnedDecoderWorkerPort);
        return port;
    };
    const client = configuredFactory === undefined && this.#options.entryUrl === undefined
      ? createOwnedDecoderWorkerClient(this.#options, ownPort)
      : createDecoderWorkerClient({
          ...this.#options,
          workerFactory: (url, workerOptions) => ownPort(
            configuredFactory === undefined
              ? new Worker(url, workerOptions)
              : configuredFactory(url, workerOptions)
          )
        });
    if (port === null) throw new Error("decoder worker port was not created");
    const tracked = new TrackedCandidateWorker(client, port);
    this.#hub.registerWorker(tracked);
    return tracked;
  }
}

export class BrowserAvcCandidateRendererFactory
  implements AvcCandidateRendererFactory {
  readonly #canvas: HTMLCanvasElement;
  readonly #hub: BrowserAvcCandidateHub;
  readonly #createBackend: NonNullable<
    BrowserAvcCandidateTestDependencies["createFrameBackend"]
  >;

  public readonly available: boolean;

  public constructor(options: {
    readonly canvas: HTMLCanvasElement;
    readonly hub: BrowserAvcCandidateHub;
    readonly backend?: Readonly<BrowserFrameBackendOptions>;
    readonly presentationPlanes?:
      BrowserAvcCandidateCompositionOptions["presentationPlanes"];
    readonly createFrameBackend?: BrowserAvcCandidateTestDependencies["createFrameBackend"];
    readonly createBackend?: BrowserAvcCandidateTestDependencies["createBackend"];
  }) {
    this.#canvas = options.canvas;
    this.#hub = options.hub;
    this.#createBackend = options.presentationPlanes === undefined
      ? options.createFrameBackend ??
        (options.createBackend === undefined
          ? (canvas) => new BrowserFrameBackend(canvas, options.backend)
          : (canvas) => new LegacyOpaqueBackendAdapter(
              options.createBackend!(canvas)
            ))
      : () => options.presentationPlanes!.createFrameBackend(options.backend);
    this.available = options.canvas !== null &&
      typeof options.canvas === "object" &&
      typeof options.canvas.getContext === "function";
  }

  public create(
    context: Readonly<IntegratedCandidateAttemptContext>
  ): AvcCandidateRendererReservation {
    this.#hub.registerCandidate(context);
    const backend = new TrackedBrowserBackend(
      this.#createBackend(this.#canvas)
    );
    return new BrowserRendererReservation(backend, this.#hub);
  }
}

/** @deprecated Use BrowserAvcCandidateWorkerFactory. */
export {
  BrowserAvcCandidateWorkerFactory as BrowserOpaqueCandidateWorkerFactory
};
/** @deprecated Use BrowserAvcCandidateRendererFactory. */
export {
  BrowserAvcCandidateRendererFactory as BrowserOpaqueCandidateRendererFactory
};

class TrackedCandidateWorker
  implements AvcCandidateWorker, BrowserTrackedWorker {
  readonly #client: ReturnType<typeof createDecoderWorkerClient>;
  readonly #port: InducibleWorkerPort;
  readonly #requests = new Set<Promise<unknown>>();
  readonly #waits = new Set<Promise<unknown>>();
  #lastMetrics: Readonly<DecoderWorkerMetrics> | null = null;
  #alive = true;

  public constructor(
    client: ReturnType<typeof createDecoderWorkerClient>,
    port: InducibleWorkerPort
  ) {
    this.#client = client;
    this.#port = port;
  }

  public get activeGeneration(): number | null {
    return this.#client.activeGeneration;
  }

  public get queuedFrames(): number {
    return this.#client.queuedFrames;
  }

  public get openFrames(): number {
    return this.#client.openFrames;
  }

  public configure(options: DecoderWorkerConfigureOptions): Promise<void> {
    return this.#track(this.#client.configure(options), this.#requests);
  }

  public activateGeneration(generation: number): Promise<void> {
    return this.#track(
      this.#client.activateGeneration(generation),
      this.#requests
    );
  }

  public submit(
    generation: number,
    samples: readonly DecoderWorkerSample[]
  ): Promise<void> {
    return this.#track(
      this.#client.submit(generation, samples),
      this.#requests
    );
  }

  public abortGeneration(generation: number): Promise<void> {
    return this.#track(
      this.#client.abortGeneration(generation),
      this.#requests
    );
  }

  public takeFrame(): ManagedDecoderWorkerFrame | undefined {
    return this.#client.takeFrame();
  }

  public waitForFrames(
    minimum?: number,
    options?: DecoderWorkerWaitOptions
  ): Promise<void> {
    return this.#track(
      this.#client.waitForFrames(minimum, options),
      this.#waits
    );
  }

  public async snapshotMetrics(): Promise<DecoderWorkerMetrics> {
    const metrics = await this.#track(
      this.#client.snapshotMetrics(),
      this.#requests
    );
    this.#lastMetrics = metrics;
    return metrics;
  }

  public async dispose(): Promise<void> {
    if (!this.#alive) return;
    try {
      this.#lastMetrics = await this.#client.snapshotMetrics();
    } catch {
      // A deliberately failed transport retains its last successful metrics.
    }
    try {
      await this.#client.dispose();
    } finally {
      this.#alive = false;
      if (this.#lastMetrics !== null) {
        this.#lastMetrics = terminalWorkerMetrics(this.#lastMetrics);
      }
    }
  }

  public induceFailure(): void {
    if (!this.#alive) throw new Error("decoder worker is not alive");
    this.#port.induceFailure();
  }

  public async settled(): Promise<void> {
    await Promise.allSettled([...this.#requests, ...this.#waits]);
  }

  public snapshot(): Readonly<BrowserAvcWorkerSnapshot> {
    return Object.freeze({
      metrics: this.#lastMetrics,
      openFrames: this.#client.openFrames,
      pendingRequests: this.#requests.size,
      pendingWaiters: this.#waits.size,
      alive: this.#alive
    });
  }

  #track<T>(operation: Promise<T>, set: Set<Promise<unknown>>): Promise<T> {
    set.add(operation);
    void operation.finally(() => set.delete(operation)).catch(() => undefined);
    return operation;
  }
}

function terminalWorkerMetrics(
  metrics: Readonly<DecoderWorkerMetrics>
): Readonly<DecoderWorkerMetrics> {
  return Object.freeze({
    ...metrics,
    pendingSamples: 0,
    submittedFrames: 0,
    leasedFrames: 0,
    leasedDecodedBytes: 0,
    decodeQueueSize: 0,
    activeGeneration: null,
    disposed: true
  });
}

class InducibleWorkerPort implements OwnedDecoderWorkerPort {
  readonly #inner: OwnedDecoderWorkerPort;
  readonly #errorListeners = new Set<(event: ErrorEvent) => void>();
  #failed = false;

  public constructor(inner: OwnedDecoderWorkerPort) {
    this.#inner = inner;
  }

  public postMessage(message: unknown, transfer?: Transferable[]): void {
    this.#inner.postMessage(message, transfer);
  }

  public addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
  public addEventListener(
    type: "messageerror",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
  public addEventListener(
    type: "error",
    listener: (event: ErrorEvent) => void
  ): void;
  public addEventListener(
    type: "message" | "messageerror" | "error",
    listener: ((event: MessageEvent<unknown>) => void) |
      ((event: ErrorEvent) => void)
  ): void {
    if (type === "error") {
      this.#errorListeners.add(listener as (event: ErrorEvent) => void);
      this.#inner.addEventListener(type, listener as (event: ErrorEvent) => void);
    } else if (type === "message") {
      this.#inner.addEventListener(type,
        listener as (event: MessageEvent<unknown>) => void);
    } else {
      this.#inner.addEventListener(type,
        listener as (event: MessageEvent<unknown>) => void);
    }
  }

  public removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
  public removeEventListener(
    type: "messageerror",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
  public removeEventListener(
    type: "error",
    listener: (event: ErrorEvent) => void
  ): void;
  public removeEventListener(
    type: "message" | "messageerror" | "error",
    listener: ((event: MessageEvent<unknown>) => void) |
      ((event: ErrorEvent) => void)
  ): void {
    if (type === "error") {
      this.#errorListeners.delete(listener as (event: ErrorEvent) => void);
      this.#inner.removeEventListener(type,
        listener as (event: ErrorEvent) => void);
    } else if (type === "message") {
      this.#inner.removeEventListener(type,
        listener as (event: MessageEvent<unknown>) => void);
    } else {
      this.#inner.removeEventListener(type,
        listener as (event: MessageEvent<unknown>) => void);
    }
  }

  public terminate(): void {
    this.#inner.terminate();
  }

  public induceFailure(): void {
    if (this.#failed) return;
    this.#failed = true;
    const event = new ErrorEvent("error", {
      message: "decoder worker was deliberately terminated"
    });
    for (const listener of this.#errorListeners) listener(event);
    this.#inner.terminate();
  }
}

class BrowserRendererReservation
  implements AvcCandidateRendererReservation {
  readonly #backend: TrackedBrowserBackend;
  readonly #hub: BrowserAvcCandidateHub;
  #renderer: FrameRenderer | null = null;

  public readonly limits;

  public constructor(
    backend: TrackedBrowserBackend,
    hub: BrowserAvcCandidateHub
  ) {
    this.#backend = backend;
    this.#hub = hub;
    this.limits = backend.limits;
  }

  public allocate(layout: Readonly<FrameTextureLayout>): FrameRenderer {
    if (this.#renderer !== null) {
      throw new Error("browser renderer reservation was already allocated");
    }
    const renderer = new FrameRenderer(this.#backend, layout);
    this.#renderer = renderer;
    this.#hub.registerRenderer(new TrackedRenderer(renderer, this.#backend));
    return renderer;
  }

  public dispose(): void {
    this.#backend.dispose();
  }
}

class TrackedRenderer implements BrowserTrackedRenderer {
  public constructor(
    public readonly renderer: FrameRenderer,
    readonly backend: TrackedBrowserBackend
  ) {}

  public snapshot(): Readonly<BrowserAvcRendererSnapshot> {
    return Object.freeze({
      snapshot: this.renderer.snapshot(),
      backendAlive: this.backend.alive,
      glResourceCount: this.backend.glResourceCount
    });
  }
}

class TrackedBrowserBackend implements FrameRendererBackend {
  readonly #backend: FrameRendererBackend;
  #alive = true;
  #glResourceCount = 0;

  public readonly limits;
  public readonly readPixels?: () => Uint8Array;
  public readonly uploadFrame?: (
    kind: FrameTextureKind,
    index: number,
    frame: CopyableVideoFrame,
    layout: Readonly<FrameSourceLayout>
  ) => void;

  public constructor(backend: FrameRendererBackend) {
    this.#backend = backend;
    this.limits = backend.limits;
    const readPixels = backend.readPixels;
    if (readPixels !== undefined) {
      this.readPixels = () => readPixels.call(backend);
    }
    const uploadFrame = backend.uploadFrame;
    if (uploadFrame !== undefined) {
      this.uploadFrame = (kind, index, frame, layout) =>
        uploadFrame.call(backend, kind, index, frame, layout);
    }
  }

  public get alive(): boolean {
    return this.#alive;
  }

  public get glResourceCount(): number {
    return this.#glResourceCount;
  }

  public allocate(layout: FrameTextureLayout, slots: number): void {
    this.#backend.allocate(layout, slots);
    // Program + VAO + stream texture + optional resident texture.
    this.#glResourceCount = 3 + (layout.residentLayerCount > 0 ? 1 : 0);
  }

  public upload(kind: FrameTextureKind, index: number, pixels: Uint8Array): void {
    this.#backend.upload(kind, index, pixels);
  }

  public draw(kind: FrameTextureKind, index: number): void {
    this.#backend.draw(kind, index);
  }

  public dispose(): void {
    if (!this.#alive) return;
    this.#alive = false;
    this.#glResourceCount = 0;
    this.#backend.dispose();
  }
}

/** Compatibility adapter used only by the deprecated opaque test seam. */
class LegacyOpaqueBackendAdapter implements FrameRendererBackend {
  public readonly limits;
  public readonly readPixels?: () => Uint8Array;
  public readonly uploadFrame?: (
    kind: FrameTextureKind,
    index: number,
    frame: CopyableVideoFrame,
    layout: Readonly<FrameSourceLayout>
  ) => void;
  readonly #legacy: LegacyOpaqueFrameRendererBackend;

  public constructor(
    legacy: LegacyOpaqueFrameRendererBackend
  ) {
    this.#legacy = legacy;
    this.limits = this.#legacy.limits;
    const readPixels = legacy.readPixels;
    if (readPixels !== undefined) {
      this.readPixels = () => readPixels.call(legacy);
    }
    const uploadFrame = legacy.uploadFrame;
    if (uploadFrame !== undefined) {
      this.uploadFrame = (kind, index, frame, layout) =>
        uploadFrame.call(legacy, kind, index, frame, layout);
    }
  }

  public allocate(layout: FrameTextureLayout, slots: number): void {
    if (
      layout.geometry.profile !== "avc-annexb-opaque-v0" &&
      layout.geometry.profile !== "avc-annexb-opaque-v1"
    ) {
      throw new RangeError(
        "deprecated opaque backend cannot render packed alpha"
      );
    }
    this.#legacy.allocate({
      codedWidth: layout.geometry.codedWidth,
      codedHeight: layout.geometry.codedHeight,
      logicalWidth: layout.logicalWidth,
      logicalHeight: layout.logicalHeight,
      residentLayerCount: layout.residentLayerCount
    }, slots);
  }

  public upload(
    kind: FrameTextureKind,
    index: number,
    pixels: Uint8Array
  ): void {
    this.#legacy.upload(kind, index, pixels);
  }

  public draw(kind: FrameTextureKind, index: number): void {
    this.#legacy.draw(kind, index);
  }

  public dispose(): void {
    this.#legacy.dispose();
  }
}
