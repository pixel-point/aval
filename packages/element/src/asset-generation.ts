import type {
  EffectHostEvent,
  MotionPolicy,
  RuntimeFailure,
  RuntimeReadinessResult,
  RuntimeVisibilityState
} from "@pixel-point/aval-player-web";

import type {
  BrowserRuntimeFactoryInput,
  BrowserRuntimeMetadata,
  BrowserRuntimePlayer
} from "./browser-runtime-factory.js";
import { DomEventBridge, type DomEventBridgeStage } from "./dom-event-bridge.js";
import { AvalNotReadyError, avalAbortError } from "./errors.js";
import { isExpectedAbort } from "./public-failure.js";
import { waitForPublicOperation } from "./public-waits.js";
import { nextElementSequence } from "./element-sequence.js";
import type { AvalCleanupReceipt } from "./public-types.js";
import { RuntimeAcquisitionCleanupError } from "./runtime-acquisition-error.js";

const RUNTIME_BOOTSTRAP_TIMEOUT_MS = 30_000;
const TERMINAL_ACQUISITION_GRACE_MS = 500;

export interface ElementAssetGenerationHost {
  readonly eventTarget: EventTarget;
  readonly eventStage: DomEventBridgeStage;
  createEvent<T>(type: string, detail: Readonly<T>): CustomEvent<T>;
  metadata(metadata: Readonly<BrowserRuntimeMetadata>): void;
  prepared(result: Readonly<RuntimeReadinessResult>): void;
  failure(error: unknown, fatal: boolean): void;
  underflow(count: number): void;
  cleanup(receipt: Readonly<AvalCleanupReceipt>): void;
}

export type ElementBrowserRuntimeFactory = (
  input: Readonly<BrowserRuntimeFactoryInput>
) => Promise<BrowserRuntimePlayer>;

export class ElementAssetGeneration {
  public readonly generation: number;
  readonly #elementGeneration: number;
  readonly #controller = new AbortController();
  readonly #host: ElementAssetGenerationHost;
  readonly #bridge: DomEventBridge;
  readonly #activationPromise: Promise<BrowserRuntimePlayer>;
  readonly #runtimePromise: Promise<BrowserRuntimePlayer>;
  #runtime: BrowserRuntimePlayer | null = null;
  #createdRuntime: BrowserRuntimePlayer | null = null;
  #runtimeDisposal: Promise<void> | null = null;
  #acquisitionDisposal: Promise<void> | null = null;
  #acquisitionCleanup: RuntimeAcquisitionCleanupError | null = null;
  #cleanupReceipt: Readonly<AvalCleanupReceipt> | null = null;
  #preparePromise: Promise<RuntimeReadinessResult> | null = null;
  #readyResult: Readonly<RuntimeReadinessResult> | null = null;
  #disposal: Promise<void> | null = null;
  #terminal = false;
  #underflows = 0;
  #motionPolicy: MotionPolicy;
  #hostReducedMotion: boolean;

  public constructor(input: Readonly<
    Omit<BrowserRuntimeFactoryInput,
      | "signal"
      | "eventSink"
      | "diagnosticsSink"
      | "cleanupSink"
      | "underflowSink"
      | "onMetadata"
    > & {
      host: ElementAssetGenerationHost;
      factory?: ElementBrowserRuntimeFactory;
    }
  >) {
    this.generation = input.generation;
    this.#elementGeneration = input.elementGeneration;
    this.#host = input.host;
    this.#motionPolicy = input.motionPolicy;
    this.#hostReducedMotion = input.hostReducedMotion;
    this.#bridge = new DomEventBridge({
      target: input.host.eventTarget,
      generation: input.generation,
      stage: input.host.eventStage,
      createEvent: input.host.createEvent
    });
    const factory = input.factory ?? createLazyBrowserRuntimePlayer;
    const acquisition = Promise.resolve().then(() => factory({
      window: input.window,
      document: input.document,
      layers: input.layers,
      generation: input.generation,
      elementGeneration: input.elementGeneration,
      sourceCandidates: input.sourceCandidates,
      credentials: input.credentials,
      motionPolicy: input.motionPolicy,
      hostReducedMotion: input.hostReducedMotion,
      initialVisibility: input.initialVisibility,
      ...(input.initialPresentation === undefined
        ? {}
        : { initialPresentation: input.initialPresentation }),
      signal: this.#controller.signal,
      eventSink: (event) => this.#publishRuntime(event),
      diagnosticsSink: (failure) => this.#diagnostic(failure),
      cleanupSink: (receipt) => this.#publishCleanup(receipt),
      underflowSink: (ordinal) => this.#underflow(ordinal),
      onMetadata: (metadata) => {
        if (!this.#terminal) this.#host.metadata(metadata);
      }
    }));
    const activated = acquisition.then(async (runtime) => {
      this.#createdRuntime = runtime;
      if (this.#terminal) {
        await this.#disposeRuntime(runtime);
        throw avalAbortError("asset generation was superseded");
      }
      this.#runtime = runtime;
      try {
        runtime.activate();
      } catch (error) {
        this.#runtime = null;
        this.#failTerminal(error);
        try { await this.#disposeRuntime(runtime); } catch { /* dispose reports via receipt */ }
        throw error;
      }
      return runtime;
    });
    void activated.catch((error: unknown) => {
      if (error instanceof RuntimeAcquisitionCleanupError) {
        this.#acquisitionCleanup = error;
      }
      if (
        error instanceof RuntimeModuleImportError &&
        this.#createdRuntime === null &&
        this.#cleanupReceipt === null
      ) {
        this.#publishCleanup(ownerlessAcquisitionReceipt(
          this.#elementGeneration,
          this.generation
        ));
      }
    });
    this.#activationPromise = activated;
    void activated.catch(() => undefined);
    this.#runtimePromise = raceRuntimeBootstrap(
      activated,
      this.#controller,
      (error) => this.#failTerminal(error)
    );
    void this.#runtimePromise.catch((error: unknown) => {
      if (!isExpectedAbort(error)) this.#failTerminal(error);
    });
  }

  public prepare(
    options: Readonly<{ signal?: AbortSignal; timeoutMs?: number }> = {}
  ): Promise<RuntimeReadinessResult> {
    if (this.#terminal) return Promise.reject(avalAbortError());
    if (this.#readyResult !== null) {
      return waitForPublicOperation(Promise.resolve(this.#readyResult), options);
    }
    if (this.#preparePromise === null) {
      const operation = this.#runtimePromise.then((runtime) => runtime.prepare({
        signal: this.#controller.signal,
        timeoutMs: 30_000
      })).then((result) => {
        if (this.#terminal) throw avalAbortError();
        this.#readyResult = result;
        this.#host.prepared(result);
        return result;
      });
      this.#preparePromise = operation;
      void operation.catch(() => undefined);
    }
    return waitForPublicOperation(this.#preparePromise, options);
  }

  public async setState(state: string): Promise<void> {
    const runtime = this.#runtime;
    if (runtime === null || this.#terminal) throw new AvalNotReadyError();
    await runtime.requestState(state);
  }

  public send(event: string): boolean {
    return !this.#terminal && this.#runtime?.send(event) === true;
  }

  public canSend(event: string): boolean {
    return !this.#terminal && this.#runtime?.canSend(event) === true;
  }

  public readyFor(state: string): boolean {
    return !this.#terminal && this.#runtime?.readyFor(state) === true;
  }

  public planFor(state: string): readonly string[] | null {
    if (this.#terminal) return null;
    return this.#runtime?.planFor(state) ?? null;
  }

  public pause(): void {
    this.#runtime?.pause();
  }

  public async resume(): Promise<void> {
    if (this.#terminal) throw avalAbortError();
    const runtime = await this.#runtimePromise;
    if (this.#terminal) throw avalAbortError();
    await runtime.resume();
  }

  public async setMotionPolicy(
    policy: MotionPolicy,
    hostReducedMotion: boolean | null
  ): Promise<void> {
    if (this.#terminal) return;
    if (
      policy === this.#motionPolicy &&
      (hostReducedMotion === null || hostReducedMotion === this.#hostReducedMotion)
    ) return;
    const runtime = await this.#runtimePromise;
    if (this.#terminal) return;
    if (policy !== this.#motionPolicy) {
      await runtime.setMotionPolicy(policy);
      this.#motionPolicy = policy;
    }
    if (
      hostReducedMotion !== null &&
      hostReducedMotion !== this.#hostReducedMotion
    ) {
      await runtime.setHostReducedMotion(hostReducedMotion);
      this.#hostReducedMotion = hostReducedMotion;
    }
  }

  public async setVisibility(value: RuntimeVisibilityState): Promise<void> {
    if (this.#terminal) return;
    const runtime = await this.#runtimePromise;
    if (!this.#terminal) await runtime.setVisibility(value);
  }

  public resize(input: Readonly<{
    cssWidth: number;
    cssHeight: number;
    devicePixelRatio: number;
    fit?: "contain" | "cover" | "fill" | "none";
  }>): void {
    if (!this.#terminal) this.#runtime?.resize(input);
  }

  public runtime(): BrowserRuntimePlayer | null {
    return this.#runtime;
  }

  public cleanupReceipt(): Readonly<AvalCleanupReceipt> | null {
    return this.#cleanupReceipt;
  }

  public dispose(): Promise<void> {
    if (this.#disposal !== null) return this.#disposal;
    this.#terminal = true;
    this.#bridge.close();
    this.#controller.abort(avalAbortError("asset generation disposed"));
    const operation = (async () => {
      const terminal = (async () => {
        let cleanupError: unknown = null;
        if (this.#createdRuntime !== null) {
          try { await this.#disposeRuntime(this.#createdRuntime); }
          catch (error) { cleanupError = error; }
        }
        await this.#activationPromise.catch(() => undefined);
        if (this.#acquisitionCleanup !== null) {
          try { await this.#disposeAcquisition(); }
          catch (error) { cleanupError ??= error; }
        }
        if (this.#createdRuntime !== null) {
          try { await this.#disposeRuntime(this.#createdRuntime); }
          catch (error) { cleanupError ??= error; }
        }
        if (cleanupError !== null) throw cleanupError;
      })();
      const settled = await settleWithin(
        terminal,
        TERMINAL_ACQUISITION_GRACE_MS
      );
      if (!settled) {
        this.#publishCleanup(incompleteAcquisitionReceipt(
          this.#elementGeneration,
          this.generation
        ));
        throw new Error(
          "aval-player runtime acquisition did not settle during cleanup"
        );
      }
      await terminal;
      if (this.#cleanupReceipt?.completed !== true) {
        throw new Error("aval-player runtime cleanup receipt is incomplete");
      }
    })();
    this.#disposal = operation;
    void operation.catch(() => {
      if (this.#cleanupReceipt?.completed !== true && this.#disposal === operation) {
        this.#disposal = null;
      }
    });
    return operation;
  }

  #publishRuntime(event: Readonly<EffectHostEvent>): void {
    if (!this.#terminal) this.#bridge.runtime(event);
  }

  #diagnostic(failure: Readonly<RuntimeFailure>): void {
    if (!this.#terminal) this.#host.failure(failure, false);
  }

  #underflow(ordinal: bigint): void {
    if (this.#terminal) return;
    this.#underflows = nextElementSequence(this.#underflows, "source underflow");
    this.#host.underflow(this.#underflows);
    this.#bridge.underflow(ordinal);
  }

  #disposeRuntime(runtime: BrowserRuntimePlayer): Promise<void> {
    if (this.#runtimeDisposal !== null) return this.#runtimeDisposal;
    this.#runtime = null;
    const operation = Promise.resolve().then(() => runtime.dispose());
    this.#runtimeDisposal = operation;
    void operation.catch(() => {
      if (this.#runtimeDisposal === operation) this.#runtimeDisposal = null;
    });
    return operation;
  }

  #disposeAcquisition(): Promise<void> {
    if (this.#acquisitionCleanup === null) return Promise.resolve();
    if (this.#acquisitionDisposal !== null) return this.#acquisitionDisposal;
    const owner = this.#acquisitionCleanup;
    const operation = owner.retryCleanup().then(() => {
      if (this.#acquisitionCleanup === owner) this.#acquisitionCleanup = null;
    });
    this.#acquisitionDisposal = operation;
    void operation.finally(() => {
      if (this.#acquisitionDisposal === operation) this.#acquisitionDisposal = null;
    }).catch(() => undefined);
    return operation;
  }

  #publishCleanup(receipt: Readonly<AvalCleanupReceipt>): void {
    if (
      this.#cleanupReceipt?.completed === true &&
      receipt.completed === false
    ) return;
    this.#cleanupReceipt = receipt;
    this.#host.cleanup(receipt);
  }

  #failTerminal(error: unknown): void {
    if (this.#terminal) return;
    this.#terminal = true;
    this.#bridge.close();
    this.#controller.abort(error);
    try { this.#host.failure(error, true); } catch { /* failure reporting is terminal-safe */ }
    if (this.#createdRuntime !== null) {
      void this.#disposeRuntime(this.#createdRuntime).catch(() => undefined);
    }
  }
}

async function createLazyBrowserRuntimePlayer(
  input: Readonly<BrowserRuntimeFactoryInput>
): Promise<BrowserRuntimePlayer> {
  let runtime: typeof import("./browser-runtime-factory.js");
  try { runtime = await import("./browser-runtime-factory.js"); }
  catch { throw new RuntimeModuleImportError(); }
  return runtime.createBrowserRuntimePlayer(input);
}

export class RuntimeModuleImportError extends Error {
  public constructor() {
    super("aval-player runtime module could not be loaded");
    this.name = "RuntimeModuleImportError";
  }
}

function raceRuntimeBootstrap<Value>(
  operation: Promise<Value>,
  controller: AbortController,
  onTimeout: (error: RuntimeBootstrapTimeoutError) => void
): Promise<Value> {
  let handle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => {
      const error = new RuntimeBootstrapTimeoutError();
      onTimeout(error);
      controller.abort(error);
      reject(error);
    }, RUNTIME_BOOTSTRAP_TIMEOUT_MS);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (handle !== null) clearTimeout(handle);
  });
}

class RuntimeBootstrapTimeoutError extends Error {
  public readonly code = "watchdog-timeout" as const;
  public readonly failure: Readonly<RuntimeFailure>;

  public constructor() {
    super("aval-player runtime bootstrap timed out");
    this.name = "RuntimeBootstrapTimeoutError";
    this.failure = Object.freeze({
      code: "watchdog-timeout",
      message: "aval-player runtime bootstrap timed out",
      context: Object.freeze({ operation: "bootstrap" })
    });
  }
}

async function settleWithin(
  operation: Promise<unknown>,
  timeoutMs: number
): Promise<boolean> {
  let handle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<false>((resolve) => {
    handle = setTimeout(() => { resolve(false); }, timeoutMs);
  });
  const settled = operation.then(
    () => true,
    () => true
  );
  const result = await Promise.race([settled, timeout]);
  if (handle !== null) clearTimeout(handle);
  return result;
}

function incompleteAcquisitionReceipt(
  elementGeneration: number,
  sourceGeneration: number
): Readonly<AvalCleanupReceipt> {
  return Object.freeze({
    elementGeneration,
    sourceGeneration,
    completed: false,
    failureCount: 1,
    playerDisposed: false,
    participantDisposed: false,
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

function ownerlessAcquisitionReceipt(
  elementGeneration: number,
  sourceGeneration: number
): Readonly<AvalCleanupReceipt> {
  return Object.freeze({
    ...incompleteAcquisitionReceipt(elementGeneration, sourceGeneration),
    completed: true,
    failureCount: 0,
    playerDisposed: true,
    participantDisposed: true
  });
}
