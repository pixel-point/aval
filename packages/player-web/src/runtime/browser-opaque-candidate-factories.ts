import type {
  DecoderWorkerConfigureOptions,
  DecoderWorkerWaitOptions,
  ManagedDecoderWorkerFrame
} from "../decoder-worker/client.js";
import { createDecoderWorkerClient } from "../decoder-worker/factory.js";
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
  OpaqueCandidateRendererFactory,
  OpaqueCandidateRendererReservation,
  OpaqueCandidateWorker,
  OpaqueCandidateWorkerFactory
} from "./opaque-candidate-factory.js";
import {
  BrowserOpaqueFrameBackend,
  type BrowserOpaqueFrameBackendOptions
} from "./opaque-frame-renderer-browser.js";
import {
  OpaqueFrameRenderer,
  type OpaqueFrameRendererBackend,
  type OpaqueFrameTextureLayout,
  type OpaqueTextureKind
} from "./opaque-frame-renderer.js";
import type {
  BrowserOpaqueWorkerSnapshot,
  BrowserOpaqueRendererSnapshot,
  BrowserOpaqueCandidateTestDependencies
} from "./browser-opaque-candidate-contracts.js";
import {
  BrowserOpaqueCandidateHub,
  type BrowserTrackedRenderer,
  type BrowserTrackedWorker
} from "./browser-opaque-candidate-hub.js";

export class BrowserOpaqueCandidateWorkerFactory
  implements OpaqueCandidateWorkerFactory {
  readonly #hub: BrowserOpaqueCandidateHub;
  readonly #options: CreateDecoderWorkerClientOptions;
  readonly #createPort: BrowserOpaqueCandidateTestDependencies["createWorkerPort"];

  public readonly available: boolean;

  public constructor(options: {
    readonly hub: BrowserOpaqueCandidateHub;
    readonly worker?: CreateDecoderWorkerClientOptions;
    readonly createWorkerPort?: BrowserOpaqueCandidateTestDependencies["createWorkerPort"];
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
  ): OpaqueCandidateWorker {
    this.#hub.registerCandidate(context);
    let port: InducibleWorkerPort | null = null;
    const configuredFactory = this.#createPort ?? this.#options.workerFactory;
    const client = createDecoderWorkerClient({
      ...this.#options,
      workerFactory: (url, workerOptions) => {
        const inner = configuredFactory === undefined
          ? new Worker(url, workerOptions)
          : configuredFactory(url, workerOptions);
        port = new InducibleWorkerPort(inner as OwnedDecoderWorkerPort);
        return port;
      }
    });
    if (port === null) throw new Error("decoder worker port was not created");
    const tracked = new TrackedCandidateWorker(client, port);
    this.#hub.registerWorker(tracked);
    return tracked;
  }
}

export class BrowserOpaqueCandidateRendererFactory
  implements OpaqueCandidateRendererFactory {
  readonly #canvas: HTMLCanvasElement;
  readonly #hub: BrowserOpaqueCandidateHub;
  readonly #createBackend: NonNullable<
    BrowserOpaqueCandidateTestDependencies["createBackend"]
  >;

  public readonly available: boolean;

  public constructor(options: {
    readonly canvas: HTMLCanvasElement;
    readonly hub: BrowserOpaqueCandidateHub;
    readonly backend?: Readonly<BrowserOpaqueFrameBackendOptions>;
    readonly createBackend?: BrowserOpaqueCandidateTestDependencies["createBackend"];
  }) {
    this.#canvas = options.canvas;
    this.#hub = options.hub;
    this.#createBackend = options.createBackend ??
      ((canvas) => new BrowserOpaqueFrameBackend(canvas, options.backend));
    this.available = options.canvas !== null &&
      typeof options.canvas === "object" &&
      typeof options.canvas.getContext === "function";
  }

  public create(
    context: Readonly<IntegratedCandidateAttemptContext>
  ): OpaqueCandidateRendererReservation {
    this.#hub.registerCandidate(context);
    const backend = new TrackedBrowserBackend(
      this.#createBackend(this.#canvas)
    );
    return new BrowserRendererReservation(backend, this.#hub);
  }
}

class TrackedCandidateWorker
  implements OpaqueCandidateWorker, BrowserTrackedWorker {
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

  public snapshot(): Readonly<BrowserOpaqueWorkerSnapshot> {
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
  implements OpaqueCandidateRendererReservation {
  readonly #backend: TrackedBrowserBackend;
  readonly #hub: BrowserOpaqueCandidateHub;
  #renderer: OpaqueFrameRenderer | null = null;

  public readonly limits;

  public constructor(
    backend: TrackedBrowserBackend,
    hub: BrowserOpaqueCandidateHub
  ) {
    this.#backend = backend;
    this.#hub = hub;
    this.limits = backend.limits;
  }

  public allocate(layout: Readonly<OpaqueFrameTextureLayout>): OpaqueFrameRenderer {
    if (this.#renderer !== null) {
      throw new Error("browser renderer reservation was already allocated");
    }
    const renderer = new OpaqueFrameRenderer(this.#backend, layout);
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
    public readonly renderer: OpaqueFrameRenderer,
    readonly backend: TrackedBrowserBackend
  ) {}

  public snapshot(): Readonly<BrowserOpaqueRendererSnapshot> {
    return Object.freeze({
      snapshot: this.renderer.snapshot(),
      backendAlive: this.backend.alive,
      glResourceCount: this.backend.glResourceCount
    });
  }
}

class TrackedBrowserBackend implements OpaqueFrameRendererBackend {
  readonly #backend: OpaqueFrameRendererBackend;
  #alive = true;
  #glResourceCount = 0;

  public readonly limits;

  public constructor(backend: OpaqueFrameRendererBackend) {
    this.#backend = backend;
    this.limits = backend.limits;
  }

  public get alive(): boolean {
    return this.#alive;
  }

  public get glResourceCount(): number {
    return this.#glResourceCount;
  }

  public allocate(layout: OpaqueFrameTextureLayout, slots: number): void {
    this.#backend.allocate(layout, slots);
    // Program + VAO + stream texture + optional resident texture.
    this.#glResourceCount = 3 + (layout.residentLayerCount > 0 ? 1 : 0);
  }

  public upload(kind: OpaqueTextureKind, index: number, pixels: Uint8Array): void {
    this.#backend.upload(kind, index, pixels);
  }

  public draw(kind: OpaqueTextureKind, index: number): void {
    this.#backend.draw(kind, index);
  }

  public readPixels(): Uint8Array {
    const read = this.#backend.readPixels;
    if (read === undefined) throw new Error("browser backend has no readback");
    return read.call(this.#backend);
  }

  public dispose(): void {
    if (!this.#alive) return;
    this.#alive = false;
    this.#glResourceCount = 0;
    this.#backend.dispose();
  }
}
