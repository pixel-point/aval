import type {
  IntegratedCandidateAttempt,
  IntegratedCandidateAttemptContext,
  IntegratedCandidateFactory
} from "./integrated-player-contracts.js";
import { OpaqueCandidateAttempt } from "./opaque-candidate-factory-attempt.js";
import type { OpaqueCandidateFactoryOptions } from "./opaque-candidate-factory-model.js";
import { validateOpaqueCandidateFactoryOptions } from "./opaque-candidate-factory-support.js";
import { validateOpaqueCandidateAttemptContext } from "./opaque-candidate-factory-validation.js";

export type {
  OpaqueCandidateActivationInput,
  OpaqueCandidateCachePreparer,
  OpaqueCandidateFactoryOptions,
  OpaqueCandidatePreparedMedia,
  OpaqueCandidateReadinessFactory,
  OpaqueCandidateReadinessSession,
  OpaqueCandidateReadinessSessionInput,
  OpaqueCandidateRendererFactory,
  OpaqueCandidateRendererReservation,
  OpaqueCandidateTimerHost,
  OpaqueCandidateWorker,
  OpaqueCandidateWorkerFactory,
  OpaqueCandidateWorkerSetup
} from "./opaque-candidate-factory-model.js";
export { createOpaqueCandidateWorkerSetup } from "./opaque-candidate-factory-config.js";

/**
 * Concrete M5.5 composition root. Effects stay injected, while ordering,
 * budgets, generations, the sole readiness run, and ownership stay here.
 */
export class OpaqueCandidateFactory implements IntegratedCandidateFactory {
  readonly #options: Readonly<OpaqueCandidateFactoryOptions>;
  #workerOwner: symbol | null = null;

  public readonly availability: IntegratedCandidateFactory["availability"];

  public constructor(options: Readonly<OpaqueCandidateFactoryOptions>) {
    validateOpaqueCandidateFactoryOptions(options);
    this.#options = options;
    this.availability = Object.freeze({
      workerAvailable: options.workerFactory.available,
      rendererAvailable: options.rendererFactory.available
    });
  }

  public create(
    context: Readonly<IntegratedCandidateAttemptContext>
  ): IntegratedCandidateAttempt {
    validateOpaqueCandidateAttemptContext(context);
    const owner = Symbol("opaque-candidate-attempt");
    return new OpaqueCandidateAttempt({
      context,
      factoryOptions: this.#options,
      owner,
      acquireWorker: () => {
        if (this.#workerOwner !== null) {
          throw new RangeError(
            "only one opaque candidate decoder worker may be alive"
          );
        }
        this.#workerOwner = owner;
      },
      releaseWorker: () => {
        if (this.#workerOwner === owner) this.#workerOwner = null;
      }
    });
  }
}
