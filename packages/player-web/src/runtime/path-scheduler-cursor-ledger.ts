import type {
  GraphBodyDefinition,
  GraphStartPolicy
} from "@rendered-motion/graph";

import type {
  RuntimeMediaCursor,
  RuntimeMediaPresentation
} from "./model.js";
import {
  createReplacementPathSequence,
  createResidentContinuationSequence,
  createSourcePathSequence,
  nextBodyCursor,
  type PathSequenceState
} from "./path-sequence.js";
import {
  freezeSchedulerCursor,
  freezeSchedulerSourceCursor,
  schedulerMediaCursor
} from "./path-scheduler-identity.js";
import type {
  PathSchedulerExpectedOutput,
  PathSchedulerOutputDrainReport
} from "./path-scheduler-output.js";
import type { SourceBodyCursor } from "./submission-horizon.js";

type FrameMedia = Extract<
  RuntimeMediaPresentation,
  { readonly kind: "frame" }
>;

export type PathSchedulerSourceReplacement =
  | {
      readonly kind: "route-restart";
      readonly checkpoint: Readonly<SourceBodyCursor>;
      readonly firstPresentationOrdinal: bigint;
    }
  | {
      readonly kind: "resident-checkpoint";
      readonly state: string;
      readonly body: Readonly<GraphBodyDefinition>;
      readonly outgoingStarts: readonly GraphStartPolicy[];
      readonly frame: number;
      readonly unitInstance: number;
      readonly presentationOrdinal: bigint;
      readonly path: string;
    }
  | {
      readonly kind: "resident-runway";
      readonly targetState: string;
      readonly targetBody: Readonly<GraphBodyDefinition>;
      readonly runwayFrames: number;
      readonly firstPresentationOrdinal: bigint;
    };

/**
 * Canonical source identity and decode/presentation cursor ledger.
 * Every generation replacement resets this state through replaceSource().
 */
export class PathSchedulerCursorLedger {
  #sourceState: string | null = null;
  #sourceBody: GraphBodyDefinition | null = null;
  #outgoingStarts: readonly GraphStartPolicy[] = [];
  #submittedSource: SourceBodyCursor | null = null;
  #decodedSource: SourceBodyCursor | null = null;
  #displayedSource: SourceBodyCursor | null = null;
  #submittedTarget: SourceBodyCursor | null = null;
  #decodedTarget: SourceBodyCursor | null = null;
  #displayedTarget: SourceBodyCursor | null = null;
  #submittedCursor: RuntimeMediaCursor | null = null;
  #decodedCursor: RuntimeMediaCursor | null = null;
  #displayedCursor: RuntimeMediaCursor | null = null;
  #lastDisplayedOrdinal: bigint | null = null;

  public get sourceState(): string | null {
    return this.#sourceState;
  }

  public get sourceBody(): GraphBodyDefinition | null {
    return this.#sourceBody;
  }

  public get outgoingStarts(): readonly GraphStartPolicy[] {
    return this.#outgoingStarts;
  }

  public get submittedSource(): Readonly<SourceBodyCursor> | null {
    return this.#submittedSource;
  }

  public get decodedSource(): Readonly<SourceBodyCursor> | null {
    return this.#decodedSource;
  }

  public get displayedSource(): Readonly<SourceBodyCursor> | null {
    return this.#displayedSource;
  }

  public get submittedTarget(): Readonly<SourceBodyCursor> | null {
    return this.#submittedTarget;
  }

  public get decodedTarget(): Readonly<SourceBodyCursor> | null {
    return this.#decodedTarget;
  }

  public get displayedTarget(): Readonly<SourceBodyCursor> | null {
    return this.#displayedTarget;
  }

  public get lastDisplayedOrdinal(): bigint | null {
    return this.#lastDisplayedOrdinal;
  }

  public startSource(input: {
    readonly state: string;
    readonly body: GraphBodyDefinition;
    readonly outgoingStarts: readonly GraphStartPolicy[];
    readonly firstPresentationOrdinal: bigint;
  }): PathSequenceState {
    this.#sourceState = input.state;
    this.#sourceBody = input.body;
    this.#outgoingStarts = Object.freeze([...input.outgoingStarts]);
    return createSourcePathSequence(input.firstPresentationOrdinal);
  }

  public replaceSource(
    input: Readonly<PathSchedulerSourceReplacement>
  ): PathSequenceState {
    switch (input.kind) {
      case "route-restart":
        return this.#replaceRouteSource(input);
      case "resident-checkpoint":
        return this.#replaceResidentCheckpoint(input);
      case "resident-runway":
        return this.#replaceResidentRunway(input);
    }
  }

  public recordSubmitted(
    outputs: readonly Readonly<PathSchedulerExpectedOutput>[],
    path: string
  ): void {
    for (const output of outputs) {
      this.#submittedCursor = {
        path,
        unit: output.sample.unitId,
        unitInstance: output.sample.unitInstance,
        localFrame: output.sample.unitFrame
      };
      if (output.plan.sourceCursor !== null && !output.plan.discard) {
        this.#submittedSource = { ...output.plan.sourceCursor };
      }
      if (output.plan.targetCursor !== null && !output.plan.discard) {
        this.#submittedTarget = { ...output.plan.targetCursor };
      }
    }
  }

  public recordDrain(report: Readonly<PathSchedulerOutputDrainReport>): void {
    if (report.decodedCursor !== null) {
      this.#decodedCursor = { ...report.decodedCursor };
    }
    if (report.decodedSource !== null) {
      this.#decodedSource = { ...report.decodedSource };
    }
    if (report.decodedTarget !== null) {
      this.#decodedTarget = { ...report.decodedTarget };
    }
  }

  /** Returns true when route wait accounting must advance. */
  public recordDisplayed(
    output: Readonly<PathSchedulerExpectedOutput>,
    media: Readonly<FrameMedia>
  ): boolean {
    this.#displayedCursor = schedulerMediaCursor(media);
    this.#lastDisplayedOrdinal = media.intendedPresentationOrdinal;
    let displayedSource = false;
    if (output.plan.sourceCursor !== null) {
      this.#displayedSource = { ...output.plan.sourceCursor };
      displayedSource = true;
    }
    if (output.plan.targetCursor !== null) {
      this.#displayedTarget = { ...output.plan.targetCursor };
    }
    return displayedSource;
  }

  public recordResidentDisplayed(media: Readonly<FrameMedia>): void {
    this.#lastDisplayedOrdinal = media.intendedPresentationOrdinal;
    this.#displayedCursor = schedulerMediaCursor(media);
  }

  public recordHeld(ordinal: bigint): void {
    if (ordinal < 0n || this.#displayedSource === null) {
      throw new RangeError("scheduler held presentation is invalid");
    }
    this.#lastDisplayedOrdinal = ordinal;
  }

  public promoteTargetToSource(input: {
    readonly state: string;
    readonly body: GraphBodyDefinition;
    readonly outgoingStarts: readonly GraphStartPolicy[];
  }): void {
    const displayed = this.#displayedTarget;
    if (displayed === null) {
      throw new RangeError("scheduler has no displayed target to promote");
    }
    this.#sourceState = input.state;
    this.#sourceBody = input.body;
    this.#outgoingStarts = Object.freeze([...input.outgoingStarts]);
    this.#submittedSource = promotedSourceCursor(
      this.#submittedTarget ?? displayed,
      input.body
    );
    this.#decodedSource = promotedSourceCursor(
      this.#decodedTarget ?? displayed,
      input.body
    );
    this.#displayedSource = promotedSourceCursor(displayed, input.body);
    this.#submittedTarget = null;
    this.#decodedTarget = null;
    this.#displayedTarget = null;
  }

  public snapshot(): Readonly<{
    readonly sourceCursor: Readonly<RuntimeMediaCursor> | null;
    readonly submittedCursor: Readonly<RuntimeMediaCursor> | null;
    readonly decodedCursor: Readonly<RuntimeMediaCursor> | null;
    readonly displayedCursor: Readonly<RuntimeMediaCursor> | null;
    readonly submittedSource: Readonly<SourceBodyCursor> | null;
    readonly displayedSource: Readonly<SourceBodyCursor> | null;
  }> {
    return Object.freeze({
      sourceCursor: this.#displayedSource === null || this.#sourceBody === null
        ? null
        : Object.freeze({
            path: this.#displayedCursor?.path ?? "",
            unit: this.#sourceBody.unitId,
            unitInstance: this.#displayedCursor?.unitInstance ?? 0,
            localFrame: this.#displayedSource.frame
          }),
      submittedCursor: freezeSchedulerCursor(this.#submittedCursor),
      decodedCursor: freezeSchedulerCursor(this.#decodedCursor),
      displayedCursor: freezeSchedulerCursor(this.#displayedCursor),
      submittedSource: freezeSchedulerSourceCursor(this.#submittedSource),
      displayedSource: freezeSchedulerSourceCursor(this.#displayedSource)
    });
  }

  #replaceRouteSource(
    input: Extract<PathSchedulerSourceReplacement, { kind: "route-restart" }>
  ): PathSequenceState {
    const body = this.#sourceBody;
    if (body === null) {
      throw new RangeError("route replacement has no source body");
    }
    const checkpoint = input.checkpoint;
    const next = nextBodyCursor(body, checkpoint);
    this.#submittedSource = { ...checkpoint };
    this.#decodedSource = { ...checkpoint };
    this.#submittedTarget = null;
    this.#decodedTarget = null;
    this.#displayedTarget = null;
    this.#submittedCursor = null;
    this.#decodedCursor = null;
    if (next === null) {
      const terminal = createSourcePathSequence(input.firstPresentationOrdinal);
      terminal.sourceNext = null;
      return terminal;
    }
    return createReplacementPathSequence({
      nextSource: next,
      firstPresentationOrdinal: input.firstPresentationOrdinal
    });
  }

  #replaceResidentCheckpoint(
    input: Extract<
      PathSchedulerSourceReplacement,
      { kind: "resident-checkpoint" }
    >
  ): PathSequenceState {
    const displayed = { occurrence: 0n, frame: input.frame };
    const next = nextBodyCursor(input.body, displayed);
    this.#sourceState = input.state;
    this.#sourceBody = input.body;
    this.#outgoingStarts = Object.freeze([...input.outgoingStarts]);
    this.#submittedSource = { ...displayed };
    this.#decodedSource = { ...displayed };
    this.#displayedSource = { ...displayed };
    this.#submittedTarget = null;
    this.#decodedTarget = null;
    this.#displayedTarget = null;
    this.#submittedCursor = null;
    this.#decodedCursor = null;
    this.#displayedCursor = Object.freeze({
      path: input.path,
      unit: input.body.unitId,
      unitInstance: input.unitInstance,
      localFrame: input.frame
    });
    this.#lastDisplayedOrdinal = input.presentationOrdinal;
    if (next === null) {
      const terminal = createSourcePathSequence(input.presentationOrdinal + 1n);
      terminal.sourceNext = null;
      return terminal;
    }
    return createReplacementPathSequence({
      nextSource: next,
      firstPresentationOrdinal: input.presentationOrdinal + 1n
    });
  }

  #replaceResidentRunway(
    input: Extract<
      PathSchedulerSourceReplacement,
      { kind: "resident-runway" }
    >
  ): PathSequenceState {
    this.#sourceState = input.targetState;
    this.#sourceBody = input.targetBody;
    this.#outgoingStarts = [];
    this.#submittedSource = null;
    this.#decodedSource = null;
    this.#displayedSource = null;
    this.#submittedTarget = null;
    this.#decodedTarget = null;
    this.#displayedTarget = null;
    this.#submittedCursor = null;
    this.#decodedCursor = null;
    return createResidentContinuationSequence({
      runwayFrames: input.runwayFrames,
      targetBody: input.targetBody,
      firstStreamingPresentationOrdinal:
        input.firstPresentationOrdinal + BigInt(input.runwayFrames)
    });
  }
}

function promotedSourceCursor(
  cursor: Readonly<SourceBodyCursor>,
  body: Readonly<GraphBodyDefinition>
): SourceBodyCursor {
  return {
    occurrence: body.kind === "loop" ? cursor.occurrence : 0n,
    frame: cursor.frame
  };
}
