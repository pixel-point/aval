import type {
  GraphPresentation,
  MotionGraphResult,
  MotionGraphSnapshot
} from "@pixel-point/aval-graph";

import { createIntegratedTestAsset } from "./asset-test-support.js";
import {
  RuntimePlaybackError,
  normalizeRuntimeFailure,
  type RuntimeFailure,
  type RuntimeFailureCode
} from "./errors.js";
import {
  IntegratedPlayer,
  type IntegratedCandidateAttempt,
  type IntegratedCandidateAttemptContext,
  type IntegratedCandidateFactory,
  type IntegratedPlaybackSession,
  type IntegratedPlayerSnapshot,
  type IntegratedRealtimeDriverOptions,
  type IntegratedTimerHost,
  type RuntimeVisibilityState
} from "./integrated-player.js";
import type { MotionPolicy } from "./motion-policy.js";
import type { BrowserContextRecoveryEventTarget } from "./browser-context-recovery.js";
import {
  INTEGRATED_STATE_STORE_FACTORY,
  type IntegratedStateStore
} from "./state-store.js";
import {
  BROWSER_PLAYBACK_TERMINAL_LISTENER,
  type BrowserPlaybackTerminalListener
} from "./browser-playback-terminal-listener.js";

export type CandidateBehavior =
  | { readonly kind: "success"; readonly cleanupFailure?: boolean }
  | { readonly kind: "draw-failure" }
  | {
      readonly kind: "failure";
      readonly code: RuntimeFailureCode;
      readonly cleanupFailure?: boolean;
    }
  | { readonly kind: "gated"; readonly gate: Deferred<void> }
  | { readonly kind: "activation-gated"; readonly gate: Deferred<void> }
  | {
      readonly kind: "browser-terminal";
      readonly error: RuntimePlaybackError;
    }
  | { readonly kind: "pending" };

export interface PreparationHarnessOptions {
  readonly bytes?: Uint8Array;
  readonly selectedRenditionIndex?: number;
  readonly behaviors?: readonly CandidateBehavior[];
  readonly staticBehavior?: StaticBehavior;
  readonly timers?: IntegratedTimerHost;
  readonly availability?: {
    readonly workerAvailable: boolean;
    readonly rendererAvailable: boolean;
  };
  readonly motionPolicy?: MotionPolicy;
  readonly hostReducedMotion?: boolean;
  readonly initialVisibility?: RuntimeVisibilityState;
  readonly contextTarget?: BrowserContextRecoveryEventTarget;
  readonly realtime?: Readonly<IntegratedRealtimeDriverOptions>;
}

export function createPreparationHarness(
  options: PreparationHarnessOptions = {}
) {
  const order: string[] = [];
  const stateStore = new FakeStateStore(
    options.staticBehavior ?? "immediate",
    order
  );
  const factory = new FakeCandidateFactory(
    options.behaviors ?? [{ kind: "success" }],
    options.availability,
    order,
    options.contextTarget
  );
  const events: Array<{ readonly type: string }> = [];
  const failures: Readonly<RuntimeFailure>[] = [];
  const eventSnapshots: IntegratedPlayerSnapshot[] = [];
  const timers = options.timers ?? new ManualTimers();
  const bytes = options.bytes ?? createIntegratedTestAsset();
  let player: IntegratedPlayer | null = null;
  const playerOptions = {
    bytes,
    selectedRenditionIndex: options.selectedRenditionIndex ?? 0,
    [INTEGRATED_STATE_STORE_FACTORY]: () => stateStore,
    candidateFactory: factory,
    eventSink: (event: { readonly type: string }) => {
      events.push(event);
      if (player !== null) eventSnapshots.push(player.snapshot());
    },
    diagnosticsSink: (failure: Readonly<RuntimeFailure>) => failures.push(failure),
    timers,
    ...(options.realtime === undefined
      ? {}
      : { realtime: options.realtime }),
    ...(options.motionPolicy === undefined
      ? {}
      : { motionPolicy: options.motionPolicy }),
    ...(options.hostReducedMotion === undefined
      ? {}
      : { hostReducedMotion: options.hostReducedMotion }),
    ...(options.initialVisibility === undefined
      ? {}
      : { initialVisibility: options.initialVisibility })
  };
  player = new IntegratedPlayer(playerOptions);
  return {
    player,
    stateStore,
    factory,
    events,
    eventSnapshots,
    failures,
    timers,
    order
  };
}

export type StaticBehavior =
  | "immediate"
  | "pending-initial"
  | "fail-stage"
  | "pending-present"
  | {
      readonly kind: "gate-first-present";
      readonly gate: Deferred<void>;
    }
  | {
      readonly kind: "gate-initial-install";
      readonly gate: Deferred<void>;
    }
  | {
      readonly kind: "gate-first-validation";
      readonly gate: Deferred<void>;
    };

export class FakeStateStore implements IntegratedStateStore {
  public readonly calls: string[] = [];
  public readonly committed: string[] = [];
  readonly #behavior: StaticBehavior;
  readonly #order: string[];
  #presentations = 0;
  #validations = 0;
  #nextPresentGate: Deferred<void> | null = null;

  public constructor(behavior: StaticBehavior, order: string[] = []) {
    this.#behavior = behavior;
    this.#order = order;
  }

  public async installInitial(options: {
    readonly state: string;
    readonly signal: AbortSignal;
  }): Promise<void> {
    this.calls.push(`install:${options.state}`);
    if (
      typeof this.#behavior === "object" &&
      this.#behavior.kind === "gate-initial-install"
    ) {
      await this.#behavior.gate.promise;
      throwIfAborted(options.signal);
    }
    if (this.#behavior === "pending-initial") {
      await abortablePending(options.signal);
    }
  }

  public async validateAll(options: {
    readonly signal: AbortSignal;
  }): Promise<void> {
    this.calls.push("validate-all");
    this.#validations += 1;
    if (
      typeof this.#behavior === "object" &&
      this.#behavior.kind === "gate-first-validation" &&
      this.#validations === 1
    ) {
      await this.#behavior.gate.promise;
    }
    throwIfAborted(options.signal);
  }

  public async presentState(
    state: string,
    options: { readonly signal: AbortSignal }
  ): Promise<void> {
    this.calls.push(`present:${state}`);
    this.#presentations += 1;
    const nextPresentGate = this.#nextPresentGate;
    this.#nextPresentGate = null;
    if (nextPresentGate !== null) await nextPresentGate.promise;
    if (
      this.#behavior === "fail-stage"
    ) {
      throw new Error("injected strict PNG surface failure");
    }
    if (this.#behavior === "pending-present") {
      await abortablePending(options.signal);
    }
    if (
      typeof this.#behavior === "object" &&
      this.#behavior.kind === "gate-first-present" &&
      this.#presentations === 1
    ) {
      await this.#behavior.gate.promise;
    }
    throwIfAborted(options.signal);
    this.committed.push(state);
    this.#order.push(`state:presented:${state}`);
  }

  public gateNextPresent(gate: Deferred<void>): void {
    this.#nextPresentGate = gate;
  }

  public currentState(): string | null {
    return this.committed.at(-1) ?? "idle";
  }

  public async settled(): Promise<void> {}

  public dispose(): void {
    this.calls.push("dispose");
  }
}

export class FakeCandidateFactory implements IntegratedCandidateFactory {
  public readonly calls: string[] = [];
  public readonly draws: Readonly<GraphPresentation>[] = [];
  public readonly activationSnapshots: Readonly<MotionGraphSnapshot>[] = [];
  public activeAttempts = 0;
  public maximumActiveAttempts = 0;
  public failTrace = false;
  public readonly availability: Readonly<{
    workerAvailable: boolean;
    rendererAvailable: boolean;
  }>;
  public readonly contextTarget?: BrowserContextRecoveryEventTarget;
  readonly #behaviors: CandidateBehavior[];
  readonly #order: string[];

  public constructor(
    behaviors: readonly CandidateBehavior[],
    availability: PreparationHarnessOptions["availability"] = undefined,
    order: string[] = [],
    contextTarget?: BrowserContextRecoveryEventTarget
  ) {
    this.#behaviors = [...behaviors];
    this.#order = order;
    if (contextTarget !== undefined) this.contextTarget = contextTarget;
    this.availability = Object.freeze(availability ?? {
      workerAvailable: true,
      rendererAvailable: true
    });
  }

  public create(
    context: Readonly<IntegratedCandidateAttemptContext>
  ): IntegratedCandidateAttempt {
    const rendition = context.candidate.rendition.id;
    const behavior = this.#behaviors.shift() ?? { kind: "success" };
    this.calls.push(`create:${rendition}`);
    this.activeAttempts += 1;
    this.maximumActiveAttempts = Math.max(
      this.maximumActiveAttempts,
      this.activeAttempts
    );
    let disposed = false;
    let terminalListener: BrowserPlaybackTerminalListener | null = null;
    let terminalScheduled = false;
    return {
      playback: Object.freeze({
        ...PREPARATION_PLAYBACK,
        [BROWSER_PLAYBACK_TERMINAL_LISTENER]: (
          listener: BrowserPlaybackTerminalListener
        ) => {
          terminalListener = listener;
          return () => {
            if (terminalListener === listener) terminalListener = null;
          };
        },
        synchronizeGraph: (result: Readonly<MotionGraphResult>) => {
          if (
            behavior.kind !== "browser-terminal" ||
            terminalScheduled ||
            (result.operation !== "begin-animated" &&
              result.operation !== "resume-animated")
          ) return;
          terminalScheduled = true;
          void Promise.resolve().then(() => {
            terminalListener?.(behavior.error);
          });
        },
        traceState: () => {
          if (this.failTrace) throw new Error("injected trace failure");
          return PREPARATION_PLAYBACK.traceState();
        }
      }),
      prepare: async ({ signal }) => {
        this.calls.push(`prepare:${rendition}`);
        if (behavior.kind === "pending") await abortablePending(signal);
        if (behavior.kind === "gated") await behavior.gate.promise;
        if (behavior.kind === "failure") {
          throw new RuntimePlaybackError(normalizeRuntimeFailure(
            behavior.code,
            `injected ${behavior.code}`,
            { rendition }
          ));
        }
        throwIfAborted(signal);
      },
      prepareActivation: async ({ expectedPresentation, graphSnapshot }) => {
        this.activationSnapshots.push(graphSnapshot);
        if (behavior.kind === "activation-gated") {
          await behavior.gate.promise;
        }
        return Object.freeze({ expectedPresentation });
      },
      drawInitial: (_activation, presentation) => {
        this.calls.push(`draw:${rendition}:${presentation.kind}`);
        this.draws.push(presentation);
        if (behavior.kind === "draw-failure") {
          throw new Error("injected activation draw failure");
        }
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        terminalListener = null;
        this.calls.push(`dispose:${rendition}`);
        this.#order.push(`candidate:dispose:${rendition}`);
        this.activeAttempts -= 1;
        if (
          "cleanupFailure" in behavior &&
          behavior.cleanupFailure === true
        ) {
          throw new Error("injected cleanup failure");
        }
      }
    };
  }
}

const PREPARATION_PLAYBACK: IntegratedPlaybackSession = Object.freeze({
  prepareContentTick: () => null,
  drawContentTick: () => null,
  synchronizeGraph: () => undefined,
  traceState: () => Object.freeze({
    scheduler: Object.freeze({
      generation: null,
      activePath: null,
      sourceCursor: null,
      submittedCursor: null,
      decodedCursor: null,
      displayedCursor: null,
      ringSize: 0,
      ringCapacity: 6,
      smoothSession: true
    }),
    submitted: Object.freeze([]),
    selectedBoundary: null,
    decodeLeadFrames: null
  })
});

export class ManualTimers {
  #next = 1;
  readonly #callbacks = new Map<number, () => void>();
  public readonly delays: number[] = [];

  public readonly setTimeout = (callback: () => void, ms: number): number => {
    const id = this.#next++;
    this.delays.push(ms);
    this.#callbacks.set(id, callback);
    return id;
  };

  public readonly clearTimeout = (id: number): void => {
    this.#callbacks.delete(id);
  };

  public fireAll(): void {
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    for (const callback of callbacks) callback();
  }
}

export class Deferred<T> {
  public readonly promise: Promise<T>;
  readonly #resolve: (value: T) => void;

  public constructor() {
    let resolve!: (value: T) => void;
    this.promise = new Promise<T>((done) => {
      resolve = done;
    });
    this.#resolve = resolve;
  }

  public resolve(value: T): void {
    this.#resolve(value);
  }
}

async function abortablePending(signal: AbortSignal): Promise<never> {
  throwIfAborted(signal);
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(abortReason(signal)), {
      once: true
    });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): DOMException {
  return signal.reason instanceof DOMException &&
    signal.reason.name === "AbortError"
    ? signal.reason
    : new DOMException("integrated test operation aborted", "AbortError");
}

export async function waitForCall(
  calls: readonly string[],
  expected: string
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (calls.includes(expected)) return;
    await Promise.resolve();
  }
  throw new Error(`timed out waiting for ${expected}`);
}

export async function waitForLength(
  values: readonly unknown[],
  length: number
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (values.length >= length) return;
    await Promise.resolve();
  }
  throw new Error(`timed out waiting for ${String(length)} values`);
}
