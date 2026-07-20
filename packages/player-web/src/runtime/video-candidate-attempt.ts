import {
  sameGraphPresentation,
  type GraphPresentation
} from "@pixel-point/aval-graph";

import {
  IntegratedPlaybackInvariantError,
  type IntegratedCandidateActivationOptions,
  type IntegratedCandidateAttempt,
  type IntegratedCandidateAttemptContext,
  type IntegratedPreparedActivation
} from "./integrated-player-contracts.js";
import {
  createIntegratedActivationPresentation,
  createIntegratedResumePresentation
} from "./integrated-player-support.js";
import { prepareInteractionCache } from "./interaction-cache-preparation.js";
import type {
  VideoCandidateFactoryOptions,
  VideoCandidateTimerHost
} from "./video-candidate-model.js";
import { VideoCandidateResources } from "./video-candidate-resources.js";
import {
  DEFAULT_VIDEO_CANDIDATE_CLOCK,
  DEFAULT_VIDEO_CANDIDATE_TIMERS,
  DeferredVideoPlaybackSession,
  VideoCandidateOperationControl
} from "./video-candidate-support.js";
import {
  cloneVideoPresentation
} from "./video-candidate-validation.js";
import type { PathSchedulerClock } from "./path-scheduler.js";

type AttemptState =
  | "new"
  | "preparing"
  | "prepared"
  | "activating"
  | "active"
  | "failed"
  | "disposed";

interface OwnedActivation extends IntegratedPreparedActivation {
  readonly owner: symbol;
}

/** Public attempt state machine around the partial-resource owner. */
export class VideoCandidateAttempt implements IntegratedCandidateAttempt {
  readonly #context: Readonly<IntegratedCandidateAttemptContext>;
  readonly #owner: symbol;
  readonly #clock: PathSchedulerClock;
  readonly #timers: VideoCandidateTimerHost;
  readonly #lifecycle = new AbortController();
  readonly #playback = new DeferredVideoPlaybackSession();
  readonly #resources: VideoCandidateResources;

  #state: AttemptState = "new";
  #activation: Readonly<OwnedActivation> | null = null;
  #initialDrawn = false;
  #cleanupPromise: Promise<void> | null = null;
  #ownerDisposerDepth = 0;

  public constructor(options: {
    readonly context: Readonly<IntegratedCandidateAttemptContext>;
    readonly factoryOptions: Readonly<VideoCandidateFactoryOptions>;
    readonly owner: symbol;
    readonly acquireWorker: () => void;
    readonly releaseWorker: () => void;
  }) {
    this.#context = options.context;
    this.#owner = options.owner;
    this.#clock = options.factoryOptions.clock ?? DEFAULT_VIDEO_CANDIDATE_CLOCK;
    this.#timers = options.factoryOptions.timers ?? DEFAULT_VIDEO_CANDIDATE_TIMERS;
    this.#resources = new VideoCandidateResources({
      context: options.context,
      factoryOptions: options.factoryOptions,
      clock: this.#clock,
      prepareCache: options.factoryOptions.prepareCache ?? prepareInteractionCache,
      acquireWorker: options.acquireWorker,
      releaseWorker: options.releaseWorker,
      invokeOwnerDisposer: (operation) => {
        this.#ownerDisposerDepth += 1;
        try {
          return operation();
        } finally {
          this.#ownerDisposerDepth -= 1;
        }
      }
    });
  }

  public get playback(): DeferredVideoPlaybackSession {
    return this.#playback;
  }

  public async prepare(options: {
    readonly signal: AbortSignal;
    readonly deadlineMs: number;
  }): Promise<void> {
    if (this.#state !== "new") {
      throw new IntegratedPlaybackInvariantError(
        "video candidate prepare may run exactly once"
      );
    }
    this.#state = "preparing";
    let control: VideoCandidateOperationControl | null = null;
    try {
      control = this.#createControl(options);
      await this.#resources.prepare(control);
      this.#state = "prepared";
    } catch (error) {
      this.#state = "failed";
      this.#stopLifecycle();
      await this.#cleanup(true);
      throw error;
    } finally {
      control?.dispose();
    }
  }

  public async prepareActivation(
    options: Readonly<IntegratedCandidateActivationOptions>
  ): Promise<Readonly<IntegratedPreparedActivation>> {
    if (this.#state !== "prepared") {
      throw new IntegratedPlaybackInvariantError(
        "video candidate activation requires completed preparation"
      );
    }
    this.#state = "activating";
    let control: VideoCandidateOperationControl | null = null;
    try {
      control = this.#createControl(options);
      const expected = options.graphSnapshot.readiness === "static"
        ? createIntegratedResumePresentation(
            this.#context.catalog.graph,
            options.graphSnapshot
          )
        : createIntegratedActivationPresentation(
            this.#context.catalog.graph,
            options.graphSnapshot
          );
      if (!sameGraphPresentation(expected, options.expectedPresentation)) {
        throw new IntegratedPlaybackInvariantError(
          "video candidate activation presentation is stale"
        );
      }
      const expectedPresentation = cloneVideoPresentation(
        options.expectedPresentation
      );
      const prepared = await this.#resources.prepareActivation(Object.freeze({
        signal: options.signal,
        deadlineMs: options.deadlineMs,
        graphSnapshot: options.graphSnapshot,
        expectedPresentation
      }), control);
      this.#playback.bind(prepared.playback);
      const activation = Object.freeze({
        expectedPresentation,
        owner: this.#owner
      });
      this.#activation = activation;
      this.#state = "active";
      return activation;
    } catch (error) {
      this.#state = "failed";
      this.#stopLifecycle();
      await this.#cleanup(true);
      throw error;
    } finally {
      control?.dispose();
    }
  }

  public drawInitial(
    activation: Readonly<IntegratedPreparedActivation>,
    presentation: Readonly<GraphPresentation>
  ): void {
    if (
      this.#state !== "active" ||
      activation !== this.#activation ||
      (activation as Partial<OwnedActivation>).owner !== this.#owner
    ) {
      throw new IntegratedPlaybackInvariantError(
        "video candidate activation token is not owned by this attempt"
      );
    }
    if (!sameGraphPresentation(activation.expectedPresentation, presentation)) {
      throw new IntegratedPlaybackInvariantError(
        "video candidate initial draw identity diverged"
      );
    }
    if (this.#initialDrawn) {
      throw new IntegratedPlaybackInvariantError(
        "video candidate initial presentation was already consumed"
      );
    }
    this.#initialDrawn = true;
    this.#resources.drawInitial();
  }

  public dispose(): Promise<void> {
    if (this.#ownerDisposerDepth > 0) {
      // A captured disposer may synchronously call/return this method. Joining
      // the active transaction from inside that transaction would self-await;
      // this reentrant acknowledgement is already settled while ordinary
      // external callers continue to join #cleanupPromise.
      return Promise.resolve();
    }
    if (this.#state !== "failed") this.#state = "disposed";
    this.#stopLifecycle();
    return this.#cleanup(false);
  }

  #createControl(options: {
    readonly signal: AbortSignal;
    readonly deadlineMs: number;
  }): VideoCandidateOperationControl {
    if (
      options.signal === null ||
      typeof options.signal !== "object" ||
      typeof options.signal.addEventListener !== "function" ||
      typeof options.signal.removeEventListener !== "function" ||
      typeof options.signal.aborted !== "boolean"
    ) {
      throw new TypeError("video candidate operation requires an AbortSignal");
    }
    return new VideoCandidateOperationControl({
      signal: options.signal,
      lifecycleSignal: this.#lifecycle.signal,
      deadlineMs: options.deadlineMs,
      clock: this.#clock,
      timers: this.#timers
    });
  }

  #stopLifecycle(): void {
    if (!this.#lifecycle.signal.aborted) {
      this.#lifecycle.abort(new DOMException(
        "video candidate attempt stopped",
        "AbortError"
      ));
    }
  }

  #cleanup(suppressErrors: boolean): Promise<void> {
    if (this.#cleanupPromise === null) {
      this.#playback.dispose();
      this.#cleanupPromise = this.#resources.dispose();
    }
    return suppressErrors
      ? this.#cleanupPromise.catch(() => undefined)
      : this.#cleanupPromise;
  }
}
