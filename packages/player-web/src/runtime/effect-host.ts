import type {
  GraphPresentation,
  MotionGraphEffect,
  MotionGraphResult,
  MotionGraphSnapshot
} from "@pixel-point/aval-graph";

import type { RuntimePlaybackError } from "./errors.js";
import {
  RUNTIME_TRACE_CAPACITY,
  translateGraphReadiness,
  type RuntimeReadiness
} from "./model.js";
import {
  RequestPromises,
  type RequestSettlementEffect
} from "./request-promises.js";

type GraphHostEvent = Exclude<
  MotionGraphEffect,
  | { readonly type: "readinesschange" }
  | { readonly type: "settle" }
>;

export interface EffectHostReadinessEvent {
  readonly type: "readinesschange";
  readonly from: RuntimeReadiness;
  readonly to: RuntimeReadiness;
  readonly source: "graph" | "player-web";
  readonly reason?: string;
}

export type EffectHostEvent =
  | Readonly<EffectHostReadinessEvent>
  | Readonly<GraphHostEvent>;

export interface EffectHostSnapshot {
  readonly readiness: RuntimeReadiness;
  readonly requestedState: string | null;
  readonly visualState: string | null;
  readonly isTransitioning: boolean;
}

export interface EffectHostTraceRecord {
  readonly index: number;
  readonly phase: "player-web" | "pre-draw" | "post-draw";
  readonly event: Readonly<EffectHostEvent>;
  readonly snapshot: Readonly<EffectHostSnapshot>;
}

export interface EffectHostOptions {
  readonly requestPromises: RequestPromises;
  readonly initialGraphSnapshot?: Readonly<MotionGraphSnapshot>;
  readonly eventSink?: (event: Readonly<EffectHostEvent>) => void;
}

export type EffectHostDraw = (
  presentation: Readonly<GraphPresentation>
) => void;

export class EffectHostInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EffectHostInvariantError";
  }
}

/**
 * Staged public-property mirror and sole host for ordered graph effects.
 * Graph state is never exposed directly to listeners.
 */
export class EffectHost {
  readonly #requestPromises: RequestPromises;
  readonly #eventSink: (event: Readonly<EffectHostEvent>) => void;
  readonly #trace: EffectHostTraceRecord[] = [];

  #readiness: RuntimeReadiness = "unready";
  #requestedState: string | null = null;
  #visualState: string | null = null;
  #isTransitioning = false;
  #traceIndex = 0;
  #interruptedBarrier: {
    readonly result: Readonly<MotionGraphResult>;
    readonly remainingEffects: readonly Readonly<MotionGraphEffect>[];
    readonly superseded: boolean;
  } | null = null;

  public constructor(options: EffectHostOptions) {
    if (!(options.requestPromises instanceof RequestPromises)) {
      throw new EffectHostInvariantError(
        "effect host requires a request promise host"
      );
    }
    if (
      options.eventSink !== undefined &&
      typeof options.eventSink !== "function"
    ) {
      throw new EffectHostInvariantError(
        "effect host event sink must be a function"
      );
    }
    this.#requestPromises = options.requestPromises;
    this.#eventSink = options.eventSink ?? (() => undefined);
    if (options.initialGraphSnapshot !== undefined) {
      this.#seedSnapshot(options.initialGraphSnapshot);
    }
  }

  public get readiness(): RuntimeReadiness {
    return this.#readiness;
  }

  public get requestedState(): string | null {
    return this.#requestedState;
  }

  public get visualState(): string | null {
    return this.#visualState;
  }

  public get isTransitioning(): boolean {
    return this.#isTransitioning;
  }

  public get hasInterruptedBarrier(): boolean {
    return this.#interruptedBarrier !== null;
  }

  public get interruptedBarrierSuperseded(): boolean {
    return this.#interruptedBarrier?.superseded ?? false;
  }

  public snapshot(): Readonly<EffectHostSnapshot> {
    return Object.freeze({
      readiness: this.#readiness,
      requestedState: this.#requestedState,
      visualState: this.#visualState,
      isTransitioning: this.#isTransitioning
    });
  }

  public getEventTrace(): readonly Readonly<EffectHostTraceRecord>[] {
    return Object.freeze([...this.#trace]);
  }

  public publishMetadataReady(): void {
    if (this.#readiness === "metadataReady") return;
    if (this.#readiness !== "unready") {
      throw new EffectHostInvariantError(
        "metadataReady must follow unready"
      );
    }
    this.#publishPlayerReadiness("metadataReady");
  }

  public publishVisualReady(): void {
    if (this.#readiness === "visualReady") return;
    if (this.#readiness !== "metadataReady") {
      throw new EffectHostInvariantError(
        "visualReady must follow metadataReady"
      );
    }
    this.#publishPlayerReadiness("visualReady");
  }

  /**
   * Apply one completed graph operation. A supplied draw callback is invoked
   * once after all pre-draw effects and before any barrier-dependent
   * visual/end/settle effect.
   */
  public apply(
    result: Readonly<MotionGraphResult>,
    draw: EffectHostDraw | null = null
  ): Readonly<EffectHostSnapshot> {
    if (this.#interruptedBarrier !== null) {
      throw new EffectHostInvariantError(
        "an interrupted draw barrier must recover before another operation"
      );
    }
    if (result.operation === "install" && this.#requestedState === null) {
      this.#requestedState = result.snapshot.requestedState;
      this.#visualState = result.snapshot.visualState;
      this.#isTransitioning = result.snapshot.isTransitioning;
    }
    const hasPresentationBarrier = validateBarrier(result, draw);

    let drawn = false;
    for (let index = 0; index < result.effects.length; index += 1) {
      const effect = result.effects[index]!;
      const postDraw = isPostDrawEffect(effect, hasPresentationBarrier);
      if (postDraw && draw !== null && !drawn) {
        try {
          this.#draw(result, draw);
        } catch (error) {
          this.#recordInterruptedBarrier(result, index);
          throw error;
        }
        drawn = true;
      }
      this.#applyEffect(
        effect,
        result.snapshot,
        postDraw ? "post-draw" : "pre-draw"
      );
    }
    if (draw !== null && !drawn) {
      try {
        this.#draw(result, draw);
      } catch (error) {
        this.#recordInterruptedBarrier(result, result.effects.length);
        throw error;
      }
    }

    this.#assertMirror(result.snapshot);
    return this.snapshot();
  }

  /**
   * Admit graph intent while a failed draw is awaiting static replacement.
   * Physical visual/end effects remain behind that replacement barrier.
   */
  public applyRecoveryIntent(
    result: Readonly<MotionGraphResult>
  ): Readonly<EffectHostSnapshot> {
    const interrupted = this.#interruptedBarrier;
    if (interrupted === null) return this.apply(result);
    if (result.operation !== "request") {
      throw new EffectHostInvariantError(
        "only state requests may cross an interrupted draw barrier"
      );
    }
    if (result.effects.some((effect) =>
      effect.type !== "requestedstatechange" && effect.type !== "settle"
    )) {
      throw new EffectHostInvariantError(
        "recovery intent emitted a non-intent effect"
      );
    }

    const changesRequestedState = result.effects.some((effect) =>
      effect.type === "requestedstatechange"
    );
    if (result.accepted === true && !changesRequestedState) {
      // A stable/joined request cannot settle before the failed presentation
      // has been replaced by actual pixels.
      this.#interruptedBarrier = Object.freeze({
        result: interrupted.result,
        superseded: interrupted.superseded,
        remainingEffects: Object.freeze([
          ...interrupted.remainingEffects,
          ...result.effects
        ])
      });
      return this.snapshot();
    }

    for (const effect of result.effects) {
      this.#applyEffect(effect, result.snapshot, "pre-draw");
    }
    if (changesRequestedState) {
      const alreadySettled = new Set(result.effects.flatMap((effect) =>
        effect.type === "settle" ? effect.requestIds : []
      ));
      const staleRequestIds = [...new Set(
        interrupted.remainingEffects.flatMap((effect) =>
          effect.type === "settle" ? effect.requestIds : []
        )
      )].filter((requestId) => !alreadySettled.has(requestId))
        .sort((left, right) => left - right);
      this.#interruptedBarrier = Object.freeze({
        result: interrupted.result,
        superseded: true,
        remainingEffects: staleRequestIds.length === 0
          ? Object.freeze([])
          : Object.freeze([abortSettlement(staleRequestIds)])
      });
    }
    return this.snapshot();
  }

  /**
   * Complete post-draw effects from a failed animated presentation using the
   * successfully installed recovery surface as their replacement barrier.
   */
  public applyRecovery(
    result: Readonly<MotionGraphResult>,
    draw: EffectHostDraw
  ): Readonly<MotionGraphResult> {
    const interrupted = this.#interruptedBarrier;
    if (interrupted === null) {
      this.apply(result, draw);
      return result;
    }
    if (result.operation !== "recover-static") {
      throw new EffectHostInvariantError(
        "an interrupted draw barrier can only complete through static recovery"
      );
    }
    for (const effect of interrupted.remainingEffects) {
      if (!isPostDrawEffect(effect, true)) {
        throw new EffectHostInvariantError(
          "interrupted barrier retained a pre-draw effect"
        );
      }
    }
    const firstPostDraw = result.effects.findIndex((effect) =>
      isPostDrawEffect(effect, true)
    );
    const split = firstPostDraw < 0 ? result.effects.length : firstPostDraw;
    const combined = Object.freeze({
      ...result,
      effects: Object.freeze([
        ...result.effects.slice(0, split),
        ...interrupted.remainingEffects,
        ...result.effects.slice(split)
      ])
    });
    this.#interruptedBarrier = null;
    try {
      this.apply(combined, draw);
      return combined;
    } catch (error) {
      if (this.#interruptedBarrier === null) {
        this.#interruptedBarrier = interrupted;
      }
      throw error;
    }
  }

  /** Terminalize a draw transaction whose replacement state failed. */
  public applyFailure(
    result: Readonly<MotionGraphResult>,
    error: RuntimePlaybackError
  ): Readonly<MotionGraphResult> {
    this.#requestPromises.bindTerminalPlaybackError(error);
    return this.#applyInterruptedTermination(
      result,
      "fail-playback",
      "PlaybackError"
    );
  }

  /** Abort any interrupted draw transaction during final disposal. */
  public applyDisposal(
    result: Readonly<MotionGraphResult>
  ): Readonly<MotionGraphResult> {
    return this.#applyInterruptedTermination(result, "dispose", "AbortError");
  }

  #applyInterruptedTermination(
    result: Readonly<MotionGraphResult>,
    operation: "fail-playback" | "dispose",
    error: "PlaybackError" | "AbortError"
  ): Readonly<MotionGraphResult> {
    const interrupted = this.#interruptedBarrier;
    if (interrupted === null) {
      this.apply(result);
      return result;
    }
    if (result.operation !== operation) {
      throw new EffectHostInvariantError(
        `an interrupted draw barrier cannot terminate through ${result.operation}`
      );
    }
    const alreadySettled = new Set(result.effects.flatMap((effect) =>
      effect.type === "settle" ? effect.requestIds : []
    ));
    const interruptedRequestIds = [...new Set(
      interrupted.remainingEffects.flatMap((effect) =>
        effect.type === "settle" ? effect.requestIds : []
      )
    )].filter((requestId) => !alreadySettled.has(requestId))
      .sort((left, right) => left - right);
    const effects: Readonly<MotionGraphEffect>[] = [...result.effects];
    if (interruptedRequestIds.length > 0) {
      const settlement = Object.freeze({
        type: "settle" as const,
        requestIds: Object.freeze(interruptedRequestIds),
        outcome: Object.freeze({
          type: "reject" as const,
          timing: "microtask" as const,
          error
        })
      });
      if (operation === "dispose") {
        const readinessIndex = effects.findIndex((effect) =>
          effect.type === "readinesschange"
        );
        effects.splice(readinessIndex < 0 ? effects.length : readinessIndex, 0,
          settlement);
      } else {
        effects.push(settlement);
      }
    }
    const combined = Object.freeze({
      ...result,
      effects: Object.freeze(effects)
    });
    this.#interruptedBarrier = null;
    this.apply(combined);
    return combined;
  }

  #applyEffect(
    effect: Readonly<MotionGraphEffect>,
    resultSnapshot: Readonly<MotionGraphSnapshot>,
    phase: "pre-draw" | "post-draw"
  ): void {
    switch (effect.type) {
      case "readinesschange": {
        const translation = translateGraphReadiness(effect.to);
        if (translation.owner === "player-web") return;
        this.#isTransitioning = resultSnapshot.isTransitioning;
        this.#changeReadiness(
          translation.readiness,
          "graph",
          phase,
          effect.reason
        );
        return;
      }
      case "requestedstatechange":
        this.#requestedState = effect.to;
        this.#isTransitioning = resultSnapshot.isTransitioning;
        this.#dispatch(cloneGraphEvent(effect), phase);
        return;
      case "transitionstart":
        this.#isTransitioning = true;
        this.#dispatch(cloneGraphEvent(effect), phase);
        return;
      case "visualstatechange":
        this.#visualState = effect.to;
        this.#isTransitioning = resultSnapshot.isTransitioning;
        this.#dispatch(cloneGraphEvent(effect), phase);
        return;
      case "transitionend":
        this.#isTransitioning = resultSnapshot.isTransitioning;
        this.#dispatch(cloneGraphEvent(effect), phase);
        return;
      case "settle":
        this.#requestPromises.queueSettlement(
          effect as RequestSettlementEffect
        );
        return;
    }
  }

  #publishPlayerReadiness(
    next: "metadataReady" | "visualReady"
  ): void {
    this.#changeReadiness(next, "player-web", "player-web");
  }

  #changeReadiness(
    next: RuntimeReadiness,
    source: "graph" | "player-web",
    phase: EffectHostTraceRecord["phase"],
    reason?: string
  ): void {
    if (next === this.#readiness) return;
    const previous = this.#readiness;
    this.#readiness = next;
    this.#dispatch(Object.freeze({
      type: "readinesschange",
      from: previous,
      to: next,
      source,
      ...(reason === undefined ? {} : { reason })
    }), phase);
  }

  #dispatch(
    event: Readonly<EffectHostEvent>,
    phase: EffectHostTraceRecord["phase"]
  ): void {
    const snapshot = this.snapshot();
    const record = Object.freeze({
      index: ++this.#traceIndex,
      phase,
      event,
      snapshot
    });
    this.#trace.push(record);
    if (this.#trace.length > RUNTIME_TRACE_CAPACITY) {
      this.#trace.splice(0, this.#trace.length - RUNTIME_TRACE_CAPACITY);
    }
    try {
      this.#eventSink(event);
    } catch {
      // Host notifications are observational, like DOM event listeners. A
      // listener cannot interrupt the already-staged graph transaction.
    }
  }

  #draw(result: Readonly<MotionGraphResult>, draw: EffectHostDraw): void {
    if (result.presentation === null) {
      throw new EffectHostInvariantError(
        "draw barrier requires a graph presentation"
      );
    }
    draw(result.presentation);
  }

  #recordInterruptedBarrier(
    result: Readonly<MotionGraphResult>,
    firstUnappliedEffect: number
  ): void {
    if (this.#interruptedBarrier !== null) {
      throw new EffectHostInvariantError(
        "effect host already owns an interrupted draw barrier"
      );
    }
    this.#interruptedBarrier = Object.freeze({
      result,
      superseded: false,
      remainingEffects: Object.freeze(
        result.effects.slice(firstUnappliedEffect)
      )
    });
  }

  #seedSnapshot(snapshot: Readonly<MotionGraphSnapshot>): void {
    this.#requestedState = snapshot.requestedState;
    this.#visualState = snapshot.visualState;
    this.#isTransitioning = snapshot.isTransitioning;
    const translation = translateGraphReadiness(snapshot.readiness);
    if (translation.owner === "graph") {
      this.#readiness = translation.readiness;
    }
  }

  #assertMirror(snapshot: Readonly<MotionGraphSnapshot>): void {
    if (
      this.#requestedState !== snapshot.requestedState ||
      this.#visualState !== snapshot.visualState ||
      this.#isTransitioning !== snapshot.isTransitioning ||
      !readinessMatches(this.#readiness, snapshot)
    ) {
      throw new EffectHostInvariantError(
        "staged effect mirror diverged from the graph result"
      );
    }
  }
}

function validateBarrier(
  result: Readonly<MotionGraphResult>,
  draw: EffectHostDraw | null
): boolean {
  const requiresDraw = resultRequiresDraw(result);
  const hasPresentationBarrier = requiresDraw || draw !== null;
  if (requiresDraw && draw === null) {
    throw new EffectHostInvariantError(
      "visual and transition-end effects require a draw barrier"
    );
  }
  if (draw !== null && result.presentation === null) {
    throw new EffectHostInvariantError(
      "draw barrier cannot present a null graph presentation"
    );
  }
  if (!hasPresentationBarrier) return false;

  let reachedPostDraw = false;
  for (const effect of result.effects) {
    if (isPostDrawEffect(effect, true)) {
      reachedPostDraw = true;
    } else if (reachedPostDraw) {
      throw new EffectHostInvariantError(
        "graph emitted a pre-draw effect after its presentation barrier"
      );
    }
  }
  return true;
}

function resultRequiresDraw(result: Readonly<MotionGraphResult>): boolean {
  return result.effects.some(
    (effect) =>
      effect.type === "transitionstart" ||
      effect.type === "visualstatechange" ||
      effect.type === "transitionend"
  ) || operationRequiresDraw(result.operation);
}

function operationRequiresDraw(
  operation: MotionGraphResult["operation"]
): boolean {
  return operation === "install" ||
    operation === "begin-animated" ||
    operation === "begin-static" ||
    operation === "recover-static" ||
    operation === "tick";
}

function isPostDrawEffect(
  effect: Readonly<MotionGraphEffect>,
  hasPresentationBarrier: boolean
): boolean {
  // Settlement follows a draw only when this result actually draws. Disposal
  // legitimately emits settlement before its readiness change with no pixels.
  return effect.type === "visualstatechange" ||
    effect.type === "transitionend" ||
    effect.type === "settle" && hasPresentationBarrier;
}

function cloneGraphEvent(effect: GraphHostEvent): Readonly<GraphHostEvent> {
  return Object.freeze({ ...effect }) as Readonly<GraphHostEvent>;
}

function abortSettlement(
  requestIds: readonly number[]
): Readonly<RequestSettlementEffect> {
  return Object.freeze({
    type: "settle",
    requestIds: Object.freeze([...requestIds]),
    outcome: Object.freeze({
      type: "reject",
      timing: "microtask",
      error: "AbortError"
    })
  });
}

function readinessMatches(
  readiness: RuntimeReadiness,
  snapshot: Readonly<MotionGraphSnapshot>
): boolean {
  const translation = translateGraphReadiness(snapshot.readiness);
  if (translation.owner === "graph") {
    return readiness === translation.readiness;
  }
  return readiness === "unready" ||
    readiness === "metadataReady" ||
    readiness === "visualReady";
}
