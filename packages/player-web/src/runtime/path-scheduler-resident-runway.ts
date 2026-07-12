import type { GraphBodyDefinition } from "@rendered-motion/graph";

import type { ResidentPathTarget, PathSequenceState } from "./path-sequence.js";
import type { PathSchedulerCursorLedger } from "./path-scheduler-cursor-ledger.js";
import type {
  PathSchedulerGeneration,
  PathSchedulerGenerationPlan
} from "./path-scheduler-generation.js";
import type {
  CommitResidentRunwayOptions,
  PathSchedulerResidentRunwayTransaction,
  PathSchedulerWorkerActivation,
  StartResidentRunwayInput
} from "./path-scheduler-model.js";
import type { PathSchedulerOutput } from "./path-scheduler-output.js";
import type { PathSchedulerReservationOwner } from "./path-scheduler-reservation.js";
import type { PathSchedulerRoute } from "./path-scheduler-route.js";
import { validateResidentRunway } from "./path-scheduler-validation.js";

interface StagedResidentRunway {
  readonly token: Readonly<PathSchedulerResidentRunwayTransaction>;
  readonly generation: Readonly<PathSchedulerGenerationPlan>;
  readonly targetBody: Readonly<GraphBodyDefinition>;
  readonly firstPresentationOrdinal: bigint;
}

export interface PathSchedulerResidentRunwayCommit {
  readonly activateWorker: PathSchedulerWorkerActivation;
  readonly build: PathSequenceState;
  readonly residentTarget: Readonly<ResidentPathTarget>;
  readonly retiredGeneration: number;
  readonly firstPresented: Readonly<
    PathSchedulerResidentRunwayTransaction["media"][number]
  > | null;
}

export interface PathSchedulerResidentRunwayOwnerOptions {
  readonly rendition: string;
  readonly generation: PathSchedulerGeneration;
  readonly output: PathSchedulerOutput;
  readonly route: PathSchedulerRoute;
  readonly cursors: PathSchedulerCursorLedger;
  readonly reservation: PathSchedulerReservationOwner;
}

/** Owns the exclusive staged-runway token and its atomic scheduler install. */
export class PathSchedulerResidentRunwayOwner {
  readonly #rendition: string;
  readonly #generation: PathSchedulerGeneration;
  readonly #output: PathSchedulerOutput;
  readonly #route: PathSchedulerRoute;
  readonly #cursors: PathSchedulerCursorLedger;
  readonly #reservation: PathSchedulerReservationOwner;
  #current: Readonly<StagedResidentRunway> | null = null;

  public constructor(options: PathSchedulerResidentRunwayOwnerOptions) {
    this.#rendition = options.rendition;
    this.#generation = options.generation;
    this.#output = options.output;
    this.#route = options.route;
    this.#cursors = options.cursors;
    this.#reservation = options.reservation;
  }

  public get locked(): boolean {
    return this.#current !== null;
  }

  public stage(
    input: Readonly<StartResidentRunwayInput>
  ): Readonly<PathSchedulerResidentRunwayTransaction> {
    if (this.#current !== null) {
      throw new RangeError("path scheduler already has a staged resident runway");
    }
    validateResidentRunway(input, this.#rendition);
    const firstPresentationOrdinal = input.firstPresentationOrdinal ??
      (this.#cursors.lastDisplayedOrdinal ?? -1n) + 1n;
    if (firstPresentationOrdinal < 0n) {
      throw new RangeError("resident runway ordinal must be non-negative");
    }
    const generation = this.#generation.planReplacement(input.path);
    const media = Object.freeze(input.frames.map((resident, index) =>
      Object.freeze({
        kind: "frame" as const,
        graphKind: "body" as const,
        state: input.targetState,
        edge: input.edgeId,
        path: input.path,
        frame: Object.freeze({ ...resident.frame }),
        drawSource: "resident" as const,
        generation: generation.generation,
        unitInstance: resident.unitInstance,
        decodeOrdinal: resident.decodeOrdinal,
        timestamp: resident.timestamp,
        intendedPresentationOrdinal:
          firstPresentationOrdinal + BigInt(index)
      })
    ));
    const token = Object.freeze({
      generation: generation.generation,
      path: input.path,
      edgeId: input.edgeId,
      targetState: input.targetState,
      media
    });
    this.#current = Object.freeze({
      token,
      generation,
      targetBody: input.targetBody,
      firstPresentationOrdinal
    });
    return token;
  }

  public commit(
    transaction: Readonly<PathSchedulerResidentRunwayTransaction>,
    options: Readonly<CommitResidentRunwayOptions> = {}
  ): Readonly<PathSchedulerResidentRunwayCommit> {
    const staged = this.#current;
    if (staged === null || staged.token !== transaction) {
      throw new RangeError("resident runway transaction is stale");
    }
    const alreadyPresented = options.alreadyPresented ?? 0;
    if (alreadyPresented !== 0 && alreadyPresented !== 1) {
      throw new RangeError("resident runway presented count must be zero or one");
    }
    const committed = this.#generation.commitReplacement(staged.generation);
    this.#reservation.discard();
    this.#output.replaceResident(transaction.media.slice(alreadyPresented));
    this.#route.activateResident();
    const build = this.#cursors.replaceSource({
      kind: "resident-runway",
      targetState: transaction.targetState,
      targetBody: staged.targetBody,
      runwayFrames: transaction.media.length,
      firstPresentationOrdinal: staged.firstPresentationOrdinal
    });
    const residentTarget = Object.freeze({
      edgeId: transaction.edgeId,
      targetState: transaction.targetState,
      targetBody: staged.targetBody
    });
    const firstPresented = alreadyPresented === 0
      ? null
      : transaction.media[0] ?? null;
    if (alreadyPresented === 1) {
      if (firstPresented === null) {
        throw new RangeError("resident runway has no presented frame zero");
      }
      this.#cursors.recordResidentDisplayed(firstPresented);
    }
    this.#current = null;
    return Object.freeze({
      activateWorker: committed.activateWorker,
      build,
      residentTarget,
      retiredGeneration: committed.retiredGeneration,
      firstPresented
    });
  }

  public rollback(
    transaction: Readonly<PathSchedulerResidentRunwayTransaction>
  ): boolean {
    if (this.#current?.token !== transaction) return false;
    this.#current = null;
    return true;
  }

  public clear(): void {
    this.#current = null;
  }
}
