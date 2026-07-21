import { DecodeTimeline } from "./decode-timeline.js";
import type {
  IntegratedCandidateActivationOptions,
  IntegratedCandidateAttemptContext
} from "./integrated-player-contracts.js";
import { createInteractionCachePlan } from "./interaction-cache-plan.js";
import { createVideoCandidateWorkerSetup } from "./video-candidate-config.js";
import type {
  VideoCandidateCachePreparer,
  VideoCandidateFactoryOptions,
  VideoCandidatePreparedMedia,
  VideoCandidateReadinessSession,
  VideoCandidateResourceAuthority,
  VideoCandidateResourcePlanLease
} from "./video-candidate-model.js";
import {
  VideoCandidateOperationControl,
  raceVideoCandidateOperation
} from "./video-candidate-support.js";
import {
  videoPhaseFailure,
  captureVideoOwnerMethod,
  requireVideoOwner,
  runVideoResourcePhase,
  stoppedOrVideoPhaseFailure,
  validateVideoCandidateRenderer,
  validateVideoCandidateWorker,
  validateVideoPreparedMedia,
  validateVideoReadinessSession,
  validateVideoRendererReservation
} from "./video-candidate-validation.js";
import { FrameRenderer } from "./frame-renderer.js";
import { PathScheduler, type PathSchedulerClock } from "./path-scheduler.js";
import {
  MAX_RESOURCE_RING_CAPACITY,
  MIN_RESOURCE_RING_CAPACITY,
  createRuntimeResourcePlan,
  withRuntimeResourceRingCapacity,
  type RuntimeResourcePlan
} from "./resource-plan.js";
import type { RuntimeCanvasResourceLease } from "./canvas-resource-plan.js";
import {
  WorkerSampleFactory,
  type WorkerSampleResourceHost
} from "./worker-samples.js";

/** Partial-resource owner used by exactly one candidate attempt. */
export class VideoCandidateResources {
  readonly #context: Readonly<IntegratedCandidateAttemptContext>;
  readonly #options: Readonly<VideoCandidateFactoryOptions>;
  readonly #clock: PathSchedulerClock;
  readonly #prepareCache: VideoCandidateCachePreparer;
  readonly #acquireWorker: () => void;
  readonly #releaseWorker: () => void;
  readonly #invokeOwnerDisposer: (operation: () => unknown) => unknown;

  #workerLease = false;
  #workerDispose: (() => unknown) | null = null;
  #reservationDispose: (() => unknown) | null = null;
  #rendererDispose: (() => unknown) | null = null;
  #rendererSettled: (() => unknown) | null = null;
  #readiness: VideoCandidateReadinessSession | null = null;
  #readinessDispose: (() => unknown) | null = null;
  #scheduler: PathScheduler | null = null;
  #finalResourcePlan: Readonly<RuntimeResourcePlan> | null = null;
  #preparedMedia: VideoCandidatePreparedMedia | null = null;
  #preparedMediaDispose: (() => unknown) | null = null;
  #resourceLease: RuntimeCanvasResourceLease | null = null;
  #resourcePlanAssert: ((
    allocation: Readonly<RuntimeResourcePlan["allocationSnapshot"]>
  ) => void) | null = null;
  #resourcePlanRelease: (() => unknown) | null = null;
  #workerSampleResourceHost: Readonly<WorkerSampleResourceHost> | null = null;
  #decoderTicketCancel: (() => unknown) | null = null;
  #decoderLeaseRelease: (() => unknown) | null = null;
  #disposePromise: Promise<void> | null = null;

  public constructor(options: {
    readonly context: Readonly<IntegratedCandidateAttemptContext>;
    readonly factoryOptions: Readonly<VideoCandidateFactoryOptions>;
    readonly clock: PathSchedulerClock;
    readonly prepareCache: VideoCandidateCachePreparer;
    readonly acquireWorker: () => void;
    readonly releaseWorker: () => void;
    readonly invokeOwnerDisposer: (operation: () => unknown) => unknown;
  }) {
    this.#context = options.context;
    this.#options = options.factoryOptions;
    this.#clock = options.clock;
    this.#prepareCache = options.prepareCache;
    this.#acquireWorker = options.acquireWorker;
    this.#releaseWorker = options.releaseWorker;
    this.#invokeOwnerDisposer = options.invokeOwnerDisposer;
  }

  public async prepare(control: VideoCandidateOperationControl): Promise<void> {
    const setup = runVideoResourcePhase(
      () => createVideoCandidateWorkerSetup(this.#context),
      this.#context
    );
    control.throwIfStopped();

    const reservation = this.#options.rendererFactory.create(this.#context);
    this.#reservationDispose = captureVideoOwnerMethod(
      reservation,
      "dispose",
      "renderer reservation"
    );
    validateVideoRendererReservation(reservation);
    control.throwIfStopped();

    const interactionCache = runVideoResourcePhase(
      () => createInteractionCachePlan({
        manifest: this.#context.catalog.manifest,
        rendition: this.#context.candidate.rendition.id,
        deviceLimits: reservation.limits
      }),
      this.#context
    );
    const provisionalResourcePlan = runVideoResourcePhase(
      () => this.#createResourcePlan(
        interactionCache,
        MAX_RESOURCE_RING_CAPACITY
      ),
      this.#context
    );
    const resourceAuthority = this.#options.resourceAuthority;
    if (resourceAuthority !== undefined) {
      const pendingPlanLease = Promise.resolve().then(() =>
        resourceAuthority.reservePlan(
          provisionalResourcePlan.allocationSnapshot
        )
      );
      let rawPlanLease: VideoCandidateResourcePlanLease;
      try {
        rawPlanLease = await raceVideoCandidateOperation(
          pendingPlanLease,
          control.signal
        );
        control.throwIfStopped();
      } catch (error) {
        void pendingPlanLease.then(bestEffortReleasePlan, () => undefined);
        throw stoppedOrVideoPhaseFailure(
          control,
          "resource-rejection",
          error,
          this.#context
        );
      }
      const planLease = runVideoResourcePhase(
        () => captureResourcePlanLease(rawPlanLease),
        this.#context
      );
      this.#resourcePlanAssert = planLease.assertAllocation;
      this.#resourcePlanRelease = planLease.release;
      this.#workerSampleResourceHost = Object.freeze({
        claim: planLease.claimWorkerTransfer
      });
      this.#assertResourceAllocation(provisionalResourcePlan);
    }
    const resourceHost = this.#options.resourceHost;
    if (resourceHost !== undefined) {
      this.#resourceLease = runVideoResourcePhase(
        () => resourceHost.reserveCanvasResources(provisionalResourcePlan),
        this.#context
      );
    }
    control.throwIfStopped();

    if (resourceAuthority !== undefined) {
      await this.#acquireDecoder(resourceAuthority, control);
    }
    control.throwIfStopped();

    this.#acquireWorker();
    this.#workerLease = true;
    const worker = this.#options.workerFactory.create(this.#context);
    this.#workerDispose = captureVideoOwnerMethod(
      worker,
      "dispose",
      "worker"
    );
    validateVideoCandidateWorker(worker);
    await this.#runWorkerOperation(
      () => worker.configure(setup.configure),
      control
    );

    let renderer: FrameRenderer;
    try {
      renderer = reservation.allocate(Object.freeze({
        geometry: this.#context.candidate.geometry,
        logicalWidth: this.#context.catalog.manifest.canvas.width,
        logicalHeight: this.#context.catalog.manifest.canvas.height,
        residentLayerCount: interactionCache.layerCount
      }));
    } catch (error) {
      throw videoPhaseFailure("renderer-failure", error, this.#context);
    }
    this.#rendererDispose = captureVideoOwnerMethod(
      renderer,
      "dispose",
      "renderer"
    );
    this.#rendererSettled = captureVideoOwnerMethod(
      renderer,
      "settled",
      "renderer"
    );
    validateVideoCandidateRenderer(renderer);

    const timeline = new DecodeTimeline(this.#context.catalog.manifest.frameRate);
    const samples = new WorkerSampleFactory({
      catalog: this.#context.catalog,
      timeline,
      rendition: this.#context.candidate.rendition.id,
      inspection: this.#context.inspection,
      limits: setup.limits,
      ...(this.#workerSampleResourceHost === null
        ? {}
        : { resourceHost: this.#workerSampleResourceHost })
    });
    const generation = timeline.activateNextGeneration();
    await this.#runWorkerOperation(
      () => worker.activateGeneration(generation),
      control
    );

    try {
      await raceVideoCandidateOperation(
        this.#prepareCache(
          {
            plan: interactionCache,
            catalog: this.#context.catalog,
            samples,
            worker,
            renderer,
            limits: setup.limits
          },
          {
            signal: control.signal,
            timeoutMs: control.remainingMs()
          }
        ),
        control.signal
      );
    } catch (error) {
      throw stoppedOrVideoPhaseFailure(
        control,
        "worker-decode-failure",
        error,
        this.#context
      );
    }
    control.throwIfStopped();

    let readiness: VideoCandidateReadinessSession;
    try {
      readiness = this.#options.readinessFactory.create(Object.freeze({
        context: this.#context,
        worker,
        renderer,
        interactionCache,
        provisionalResourcePlan,
        timeline,
        samples,
        limits: setup.limits,
        clock: this.#clock,
        signal: control.signal,
        deadlineMs: control.deadlineMs
      }));
    } catch (error) {
      throw videoPhaseFailure("readiness-failure", error, this.#context);
    }
    this.#readiness = readiness;
    this.#readinessDispose = captureVideoOwnerMethod(
      readiness,
      "dispose",
      "readiness session"
    );
    validateVideoReadinessSession(readiness);
    // Exhaustive all-routes readiness is an explicit certification operation,
    // not a page-startup prerequisite. Activation below already performs the
    // fallible real-decoder work needed to fill and draw the initial ring.
    // Use the minimum supported ring so startup decodes only the six frames
    // that will actually become live playback, while the provisional plan
    // continues to admit the full bounded decoder surface allocation.
    const ringCapacity = MIN_RESOURCE_RING_CAPACITY;
    const finalResourcePlan = runVideoResourcePhase(
      () => withRuntimeResourceRingCapacity(
        provisionalResourcePlan,
        ringCapacity
      ),
      this.#context
    );
    this.#assertResourceAllocation(finalResourcePlan);
    const scheduler = new PathScheduler({
      timeline,
      samples,
      worker,
      rendition: this.#context.candidate.rendition.id,
      ringCapacity,
      limits: setup.limits,
      clock: this.#clock
    });
    this.#finalResourcePlan = finalResourcePlan;
    this.#scheduler = scheduler;
    control.throwIfStopped();
  }

  public async prepareActivation(
    options: Readonly<IntegratedCandidateActivationOptions>,
    control: VideoCandidateOperationControl
  ): Promise<VideoCandidatePreparedMedia> {
    const readiness = requireVideoOwner(this.#readiness, "readiness session");
    const scheduler = requireVideoOwner(this.#scheduler, "path scheduler");
    const finalResourcePlan = requireVideoOwner(
      this.#finalResourcePlan,
      "final resource plan"
    );
    this.#assertResourceAllocation(finalResourcePlan);
    let prepared: VideoCandidatePreparedMedia;
    try {
      prepared = await raceVideoCandidateOperation(
        readiness.prepareActivation(Object.freeze({
          graphSnapshot: options.graphSnapshot,
          expectedPresentation: options.expectedPresentation,
          scheduler,
          finalResourcePlan,
          signal: control.signal,
          deadlineMs: control.deadlineMs
        })),
        control.signal
      );
    } catch (error) {
      throw stoppedOrVideoPhaseFailure(
        control,
        "readiness-failure",
        error,
        this.#context
      );
    }
    this.#preparedMedia = prepared;
    this.#preparedMediaDispose = captureVideoOwnerMethod(
      prepared,
      "dispose",
      "prepared media"
    );
    validateVideoPreparedMedia(prepared);
    control.throwIfStopped();
    return prepared;
  }

  public drawInitial(): void {
    requireVideoOwner(
      this.#preparedMedia,
      "prepared initial media"
    ).drawInitial();
  }

  public dispose(): Promise<void> {
    if (this.#disposePromise === null) {
      // Assign before injected disposers can run and re-enter this owner.
      this.#disposePromise = Promise.resolve().then(
        async () => this.#disposeResources()
      );
    }
    return this.#disposePromise;
  }

  async #runWorkerOperation(
    operation: () => Promise<void>,
    control: VideoCandidateOperationControl
  ): Promise<void> {
    try {
      await raceVideoCandidateOperation(
        Promise.resolve().then(operation),
        control.signal
      );
      control.throwIfStopped();
    } catch (error) {
      throw stoppedOrVideoPhaseFailure(
        control,
        "worker-decode-failure",
        error,
        this.#context
      );
    }
  }

  async #acquireDecoder(
    authority: Readonly<VideoCandidateResourceAuthority>,
    control: VideoCandidateOperationControl
  ): Promise<void> {
    const rawTicket = runVideoResourcePhase(
      () => authority.requestDecoder(),
      this.#context
    );
    const ticket = runVideoResourcePhase(
      () => captureDecoderTicket(rawTicket),
      this.#context
    );
    this.#decoderTicketCancel = ticket.cancel;
    let rawLease: Awaited<ReturnType<typeof rawTicket.wait>>;
    try {
      rawLease = await raceVideoCandidateOperation(
        Promise.resolve().then(ticket.wait),
        control.signal
      );
      control.throwIfStopped();
    } catch (error) {
      safelyInvoke(ticket.cancel);
      throw stoppedOrVideoPhaseFailure(
        control,
        "resource-rejection",
        error,
        this.#context
      );
    }
    this.#decoderLeaseRelease = runVideoResourcePhase(
      () => captureVideoOwnerMethod(
        rawLease,
        "release",
        "decoder lease"
      ),
      this.#context
    );
  }

  #assertResourceAllocation(plan: Readonly<RuntimeResourcePlan>): void {
    const assertAllocation = this.#resourcePlanAssert;
    if (assertAllocation === null) return;
    runVideoResourcePhase(
      () => assertAllocation(plan.allocationSnapshot),
      this.#context
    );
  }

  #createResourcePlan(
    interactionCache: Parameters<typeof createRuntimeResourcePlan>[0]["interactionCache"],
    ringCapacity: number
  ): Readonly<RuntimeResourcePlan> {
    return createRuntimeResourcePlan({
      catalog: this.#context.catalog,
      rendition: this.#context.candidate.rendition.id,
      interactionCache,
      ringCapacity,
      ...(this.#options.resourceHost === undefined
        ? {}
        : { canvasBacking: this.#options.resourceHost.currentCanvasBacking() }),
      ...(this.#context.hostMaxRuntimeBytes === null
        ? {}
        : { hostMaxRuntimeBytes: this.#context.hostMaxRuntimeBytes })
    });
  }

  async #disposeResources(): Promise<void> {
    let firstError: unknown = null;
    const clean = async (operation: () => unknown): Promise<void> => {
      try {
        await this.#invokeOwnerDisposer(operation);
      } catch (error) {
        if (firstError === null) firstError = error;
      }
    };

    this.#preparedMedia = null;
    const preparedMediaDispose = this.#preparedMediaDispose;
    this.#preparedMediaDispose = null;
    if (preparedMediaDispose !== null) await clean(preparedMediaDispose);

    this.#readiness = null;
    const readinessDispose = this.#readinessDispose;
    this.#readinessDispose = null;
    if (readinessDispose !== null) await clean(readinessDispose);

    const scheduler = this.#scheduler;
    this.#scheduler = null;
    if (scheduler !== null) await clean(() => scheduler.dispose());

    const rendererDispose = this.#rendererDispose;
    this.#rendererDispose = null;
    if (rendererDispose !== null) await clean(rendererDispose);
    const rendererSettled = this.#rendererSettled;
    this.#rendererSettled = null;
    if (rendererSettled !== null) await clean(rendererSettled);

    const reservationDispose = this.#reservationDispose;
    this.#reservationDispose = null;
    if (reservationDispose !== null) await clean(reservationDispose);

    const workerDispose = this.#workerDispose;
    this.#workerDispose = null;
    if (workerDispose !== null) await clean(workerDispose);
    if (this.#workerLease) {
      this.#workerLease = false;
      await clean(this.#releaseWorker);
    }
    const decoderTicketCancel = this.#decoderTicketCancel;
    this.#decoderTicketCancel = null;
    if (decoderTicketCancel !== null) await clean(decoderTicketCancel);
    const decoderLeaseRelease = this.#decoderLeaseRelease;
    this.#decoderLeaseRelease = null;
    if (decoderLeaseRelease !== null) await clean(decoderLeaseRelease);
    const resourceLease = this.#resourceLease;
    this.#resourceLease = null;
    if (resourceLease !== null) await clean(() => resourceLease.release());
    const resourcePlanRelease = this.#resourcePlanRelease;
    this.#resourcePlanRelease = null;
    this.#resourcePlanAssert = null;
    this.#workerSampleResourceHost = null;
    if (resourcePlanRelease !== null) await clean(resourcePlanRelease);
    this.#finalResourcePlan = null;

    if (firstError !== null) throw firstError;
  }
}

function captureResourcePlanLease(
  value: VideoCandidateResourcePlanLease
): Readonly<{
  assertAllocation: VideoCandidateResourcePlanLease["assertAllocation"];
  claimWorkerTransfer: VideoCandidateResourcePlanLease["claimWorkerTransfer"];
  release: () => void;
}> {
  if (value === null || typeof value !== "object") {
    throw new TypeError("video candidate resource plan lease is malformed");
  }
  let release: unknown;
  let assertAllocation: unknown;
  let claimWorkerTransfer: unknown;
  try {
    release = Reflect.get(value, "release");
    assertAllocation = Reflect.get(value, "assertAllocation");
    claimWorkerTransfer = Reflect.get(value, "claimWorkerTransfer");
  } catch {
    bestEffortMethod(value, release);
    throw new TypeError("video candidate resource plan lease is inaccessible");
  }
  if (
    typeof release !== "function" ||
    typeof assertAllocation !== "function" ||
    typeof claimWorkerTransfer !== "function"
  ) {
    bestEffortMethod(value, release);
    throw new TypeError("video candidate resource plan lease is malformed");
  }
  let released = false;
  return Object.freeze({
    assertAllocation: (allocation) => {
      if (released) {
        throw new Error("video candidate resource plan lease is released");
      }
      Reflect.apply(assertAllocation, value, [allocation]);
    },
    claimWorkerTransfer: (byteLength) => {
      if (released) {
        throw new Error("video candidate resource plan lease is released");
      }
      return Reflect.apply(
        claimWorkerTransfer,
        value,
        [byteLength]
      ) as ReturnType<VideoCandidateResourcePlanLease["claimWorkerTransfer"]>;
    },
    release: () => {
      if (released) return;
      released = true;
      Reflect.apply(release, value, []);
    }
  });
}

function captureDecoderTicket(
  value: ReturnType<VideoCandidateResourceAuthority["requestDecoder"]>
): Readonly<{ wait: () => ReturnType<typeof value.wait>; cancel: () => void }> {
  if (value === null || typeof value !== "object") {
    throw new TypeError("video candidate decoder ticket is malformed");
  }
  let wait: unknown;
  let cancel: unknown;
  try {
    cancel = Reflect.get(value, "cancel");
    wait = Reflect.get(value, "wait");
  } catch {
    bestEffortMethod(value, cancel);
    throw new TypeError("video candidate decoder ticket is inaccessible");
  }
  if (typeof wait !== "function" || typeof cancel !== "function") {
    bestEffortMethod(value, cancel);
    throw new TypeError("video candidate decoder ticket is malformed");
  }
  let cancelled = false;
  return Object.freeze({
    wait: () => Reflect.apply(wait, value, []) as ReturnType<typeof value.wait>,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      Reflect.apply(cancel, value, []);
    }
  });
}

function bestEffortMethod(owner: object, method: unknown): void {
  if (typeof method !== "function") return;
  try {
    Reflect.apply(method, owner, []);
  } catch {
    // Preserve the malformed capability failure.
  }
}

function bestEffortReleasePlan(value: VideoCandidateResourcePlanLease): void {
  if (value === null || typeof value !== "object") return;
  let release: unknown;
  try { release = Reflect.get(value, "release"); } catch { return; }
  bestEffortMethod(value, release);
}

function safelyInvoke(operation: () => unknown): void {
  try {
    operation();
  } catch {
    // Preserve the candidate operation result while cleanup continues.
  }
}
