import { GRAPH_LIMITS } from "@rendered-motion/graph";

import { createIntegratedOpaqueTestAsset } from "./asset-test-fixture.js";
import {
  FuzzCandidateFactory,
  FuzzStaticStore,
  IdleFuzzTimers,
  type FuzzFailurePhase
} from "./integrated-player-fuzz-fixture.js";
import {
  FuzzRecorder,
  assertFuzzCleanup,
  assertFuzzConverged,
  assertFuzzLiveBounds,
  assertFuzzRequestOrdering,
  assertIntegratedFuzzTrace,
  fuzzInvariant,
  summarizeIntegratedFuzzTrace,
  type TrackedFuzzRequest
} from "./integrated-player-fuzz-oracle.js";
import { IntegratedPlayer } from "./integrated-player.js";

const GENERATED_OPERATIONS = 640;
const DRAIN_LIMIT = 48;
const VALID_STATES = Object.freeze(["idle", "hover"] as const);
const REQUEST_TARGETS = Object.freeze(["idle", "hover", "missing"] as const);

type ValidState = (typeof VALID_STATES)[number];

export interface IntegratedFuzzSummary {
  readonly seed: number;
  readonly selectedRendition: string;
  readonly finalStaticState: string;
  readonly requestOutcomes: readonly string[];
  readonly order: readonly string[];
  readonly trace: readonly unknown[];
  readonly presentedStaticStates: readonly string[];
  readonly diagnosticCodes: readonly string[];
}

/** Run one bounded deterministic integration tape and assert its model. */
export async function runIntegratedFuzzSeed(
  seed: number
): Promise<Readonly<IntegratedFuzzSummary>> {
  const random = mulberry32(seed);
  const recorder = new FuzzRecorder(seed);
  const failHigh = (seed & 1) === 1;
  const factory = new FuzzCandidateFactory(recorder, failHigh);
  const store = new FuzzStaticStore(recorder);
  const diagnostics: string[] = [];
  const player = new IntegratedPlayer({
    bytes: createIntegratedOpaqueTestAsset(),
    createStaticStore: () => store,
    candidateFactory: factory,
    eventSink: (event) => recorder.recordEvent(event),
    diagnosticsSink: (failure) => diagnostics.push(failure.code),
    now: () => 0,
    timers: new IdleFuzzTimers()
  });
  const requests: TrackedFuzzRequest[] = [];
  let nextRequestId = 1;
  let nextOrdinal = 1n;

  const issue = (target: string): TrackedFuzzRequest => {
    if (player.snapshot().readiness !== "staticReady") {
      factory.noteRequest(target);
    }
    const tracked: TrackedFuzzRequest = {
      id: nextRequestId,
      target,
      visualAtIssue: player.snapshot().visualState,
      issuedOrder: recorder.push(`request:${String(nextRequestId)}:${target}`),
      observed: Promise.resolve(),
      status: "pending",
      errorName: null,
      settlementOrder: null
    };
    nextRequestId += 1;
    const observed = player.requestState(target).then(
      () => {
        tracked.status = "resolved";
        tracked.settlementOrder = recorder.push(
          `settle:resolve:${String(tracked.id)}:${tracked.target}`
        );
      },
      (error: unknown) => {
        tracked.status = "rejected";
        tracked.errorName = error instanceof Error ? error.name : "unknown";
        tracked.settlementOrder = recorder.push(
          `settle:reject:${String(tracked.id)}:${tracked.target}:${tracked.errorName}`
        );
      }
    );
    Object.defineProperty(tracked, "observed", { value: observed });
    requests.push(tracked);
    return tracked;
  };

  const tick = (
    routeReady: boolean,
    underflow: boolean
  ): "advanced" | "underflow" | "stopped" => {
    factory.session.configureNext({ routeReady, underflow });
    const result = player.tryContentTick({
      presentationOrdinal: nextOrdinal,
      rationalDeadlineUs: Number(nextOrdinal) * 33_333
    });
    if (result.status === "advanced") nextOrdinal += 1n;
    return result.status;
  };

  try {
    fuzzInvariant(
      player.catalog.manifest.readiness.policy === "all-routes",
      recorder,
      "fuzz asset does not use the all-routes readiness policy"
    );
    const preprepareRequests = seed % 4;
    for (let index = 0; index < preprepareRequests; index += 1) {
      recorder.setStep(-10 + index);
      issue(REQUEST_TARGETS[randomIndex(random, REQUEST_TARGETS.length)]!);
      await settleMicrotasks();
    }

    recorder.setStep(-1);
    const readiness = await player.prepare();
    fuzzInvariant(
      readiness.mode === "animated",
      recorder,
      "preparation was not animated"
    );
    const selectedRendition = readiness.report.selectedRendition;
    fuzzInvariant(
      selectedRendition !== null,
      recorder,
      "animated readiness has no rendition"
    );
    fuzzInvariant(
      selectedRendition === (failHigh ? "opaque-low" : "opaque-high"),
      recorder,
      "candidate fallback selected the wrong rendition"
    );
    fuzzInvariant(
      factory.maximumActiveAttempts === 1,
      recorder,
      "candidate overlap exceeded one"
    );
    await settleMicrotasks();

    recorder.setStep(0);
    fuzzInvariant(
      tick(true, true) === "underflow",
      recorder,
      "forced underflow advanced"
    );
    fuzzInvariant(
      tick(true, false) === "advanced",
      recorder,
      "underflow retry did not advance"
    );
    await settleMicrotasks();

    for (let step = 1; step <= GENERATED_OPERATIONS; step += 1) {
      recorder.setStep(step);
      if (step % 211 === 0) {
        for (
          let input = 0;
          input < GRAPH_LIMITS.maxInputsPerTick + 4;
          input += 1
        ) {
          issue(VALID_STATES[input % VALID_STATES.length]!);
        }
      } else if (random() < 0.46) {
        issue(REQUEST_TARGETS[randomIndex(random, REQUEST_TARGETS.length)]!);
      } else {
        fuzzInvariant(
          tick(random() >= 0.22, random() < 0.13) !== "stopped",
          recorder,
          "healthy generated tick stopped"
        );
      }
      await settleMicrotasks();
      assertFuzzLiveBounds(player, factory.session, recorder);
    }

    recorder.setStep(GENERATED_OPERATIONS + 1);
    fuzzInvariant(
      tick(true, false) === "advanced",
      recorder,
      "reset tick did not advance"
    );
    await settleMicrotasks();
    const convergenceTarget = opposite(requireValidState(
      player.snapshot().visualState,
      recorder
    ));
    const convergence = issue(convergenceTarget);
    await drainAnimated({
      player,
      factory,
      recorder,
      target: convergenceTarget,
      request: convergence,
      getNextOrdinal: () => nextOrdinal,
      advanceOrdinal: () => { nextOrdinal += 1n; }
    });
    await Promise.all(requests.map(({ observed }) => observed));
    assertFuzzConverged(player, convergenceTarget, recorder, "animated drain");
    assertFuzzRequestOrdering(requests, recorder);

    const failurePhase: FuzzFailurePhase =
      (seed & 2) === 0 ? "prepare" : "draw";
    const committedBeforeFailure = requireValidState(
      player.snapshot().visualState,
      recorder
    );
    const firstRecoveryTarget = opposite(committedBeforeFailure);
    recorder.setStep(GENERATED_OPERATIONS + 2);
    const firstRecoveryRequest = issue(firstRecoveryTarget);
    factory.session.failNext(failurePhase);
    factory.session.configureNext({ routeReady: true, underflow: false });
    const stopped = player.tryContentTick({
      presentationOrdinal: nextOrdinal,
      rationalDeadlineUs: Number(nextOrdinal) * 33_333
    });
    fuzzInvariant(stopped.status === "stopped", recorder, "fatal tick did not stop");

    let expectedRecoveryState = firstRecoveryTarget;
    let newestRecoveryRequest = firstRecoveryRequest;
    if (failurePhase === "prepare") {
      expectedRecoveryState = committedBeforeFailure;
      newestRecoveryRequest = issue(expectedRecoveryState);
    }
    await player.settled();
    await Promise.all([
      firstRecoveryRequest.observed,
      newestRecoveryRequest.observed
    ]);
    assertFuzzConverged(player, expectedRecoveryState, recorder, "static recovery");
    fuzzInvariant(
      player.snapshot().readiness === "staticReady",
      recorder,
      "fatal animation did not recover to static readiness"
    );
    fuzzInvariant(
      store.presented.at(-1) === expectedRecoveryState,
      recorder,
      "recovery installed a stale requested state"
    );

    for (let index = 0; index < 8; index += 1) {
      recorder.setStep(GENERATED_OPERATIONS + 3 + index);
      const target = index === 3
        ? "missing"
        : VALID_STATES[randomIndex(random, VALID_STATES.length)]!;
      const request = issue(target);
      await request.observed;
      await player.settled();
      if (target !== "missing") {
        assertFuzzConverged(player, target, recorder, "serialized static request");
      } else {
        fuzzInvariant(
          request.status === "rejected" && request.errorName === "RouteError",
          recorder,
          "invalid static target did not reject with RouteError"
        );
      }
    }
    assertFuzzRequestOrdering(requests, recorder);
    const finalStaticState = requireValidState(
      player.snapshot().visualState,
      recorder
    );

    recorder.setStep(GENERATED_OPERATIONS + 20);
    await player.dispose();
    await player.settled();
    await Promise.all(requests.map(({ observed }) => observed));
    const trace = player.getTrace();
    assertIntegratedFuzzTrace(trace, recorder);
    assertFuzzCleanup(player, factory, store, requests, recorder);
    fuzzInvariant(
      recorder.entries.includes(
        "event:readinesschange:visualReady->interactiveReady"
      ),
      recorder,
      "interactive readiness was never published"
    );
    fuzzInvariant(
      diagnostics.length >= 1,
      recorder,
      "fatal path emitted no diagnostic"
    );

    return Object.freeze({
      seed,
      selectedRendition,
      finalStaticState,
      requestOutcomes: Object.freeze(requests.map((request) =>
        `${String(request.id)}:${request.target}:${request.status}:${request.errorName ?? "none"}`
      )),
      order: Object.freeze([...recorder.entries]),
      trace: Object.freeze(trace.map(summarizeIntegratedFuzzTrace)),
      presentedStaticStates: Object.freeze([...store.presented]),
      diagnosticCodes: Object.freeze([...diagnostics])
    });
  } catch (error) {
    await player.dispose().catch(() => undefined);
    throw recorder.wrap(error);
  }
}

async function drainAnimated(options: {
  readonly player: IntegratedPlayer;
  readonly factory: FuzzCandidateFactory;
  readonly recorder: FuzzRecorder;
  readonly target: ValidState;
  readonly request: TrackedFuzzRequest;
  readonly getNextOrdinal: () => bigint;
  readonly advanceOrdinal: () => void;
}): Promise<void> {
  for (let index = 0; index < DRAIN_LIMIT; index += 1) {
    await settleMicrotasks();
    const snapshot = options.player.snapshot();
    if (
      options.request.status !== "pending" &&
      snapshot.requestedState === options.target &&
      snapshot.visualState === options.target &&
      !snapshot.isTransitioning
    ) return;
    options.factory.session.configureNext({ routeReady: true, underflow: false });
    const ordinal = options.getNextOrdinal();
    const result = options.player.tryContentTick({
      presentationOrdinal: ordinal,
      rationalDeadlineUs: Number(ordinal) * 33_333
    });
    fuzzInvariant(
      result.status === "advanced",
      options.recorder,
      "drain tick did not advance"
    );
    options.advanceOrdinal();
  }
  throw options.recorder.failure("animated latest request did not converge");
}

function requireValidState(
  state: string | null,
  recorder: FuzzRecorder
): ValidState {
  fuzzInvariant(
    state === "idle" || state === "hover",
    recorder,
    "player exposed an unknown visual state"
  );
  return state;
}

function opposite(state: ValidState): ValidState {
  return state === "idle" ? "hover" : "idle";
}

function randomIndex(random: () => number, length: number): number {
  return Math.min(length - 1, Math.floor(random() * length));
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
