import { describe, expect, it } from "vitest";

import {
  GRAPH_LIMITS,
  MotionGraphEngine,
  type GraphPresentation,
  type MotionGraphDefinition,
  type MotionGraphEffect,
  type MotionGraphResult,
  type MotionGraphSnapshot
} from "../src/index.js";
import { mutationSeeds } from "../../../tests/mutation/seed-profile.js";

const FUZZ_SEEDS = mutationSeeds([1, 0x5eedc0de, 0xc0ffee, 0xffffffff]);
const GENERATED_TICKS = 2_500;
const DRAIN_TICKS = 80;

type TapeOperation =
  | { readonly kind: "request"; readonly target: string }
  | { readonly kind: "send"; readonly event: string }
  | { readonly kind: "tick"; readonly routeReady: boolean };

interface Replay {
  readonly results: readonly Readonly<MotionGraphResult>[];
  readonly finalSnapshot: Readonly<MotionGraphSnapshot>;
  readonly trace: ReturnType<MotionGraphEngine["getTrace"]>;
  readonly issuedRequestIds: ReadonlySet<number>;
  readonly settledRequestIds: ReadonlySet<number>;
}

describe("MotionGraphEngine seeded properties", () => {
  for (const seed of FUZZ_SEEDS) {
    it(`replays seed 0x${seed.toString(16)} deterministically`, () => {
      const tape = createTape(seed);
      const first = replayTape(tape, seed);
      const second = replayTape(tape, seed);

      expect(second.results).toEqual(first.results);
      expect(second.finalSnapshot).toEqual(first.finalSnapshot);
      expect(second.trace).toEqual(first.trace);

      expect(first.finalSnapshot.phase).toBe("stable");
      expect(first.finalSnapshot.visualState).toBe(
        first.finalSnapshot.requestedState
      );
      expect(first.finalSnapshot.pendingRequestCount).toBe(0);
      expect(first.issuedRequestIds.size).toBeGreaterThan(0);
      expect(first.settledRequestIds).toEqual(first.issuedRequestIds);

      expect(first.trace).toHaveLength(GRAPH_LIMITS.maxTraceRecords);
      expect(first.trace[0]?.index).toBe(
        first.results.length - GRAPH_LIMITS.maxTraceRecords + 1
      );
      expect(first.trace.at(-1)?.index).toBe(first.results.length);
      expect(Object.isFrozen(first.trace)).toBe(true);
      expect(first.trace.every(Object.isFrozen)).toBe(true);
      expect(first.trace.every(({ result }) => Object.isFrozen(result))).toBe(
        true
      );
    });
  }
});

function replayTape(tape: readonly TapeOperation[], seed: number): Replay {
  const engine = new MotionGraphEngine();
  const results: Readonly<MotionGraphResult>[] = [];
  const issuedRequestIds = new Set<number>();
  const settledRequestIds = new Set<number>();
  let nextRequestId = 1;
  let nextContentOrdinal = 0n;
  let inputsSinceTick = 0;

  const installed = engine.install(FUZZ_GRAPH);
  // Installation establishes the initial visual state; it is not a runtime
  // visual-state transition and therefore has no visualstatechange effect.
  assertResultProperties(installed, installed.snapshot, seed, -2);
  results.push(installed);
  let previous = installed.snapshot;

  const animated = engine.beginAnimated();
  assertResultProperties(animated, previous, seed, -1);
  results.push(animated);
  previous = animated.snapshot;

  const reduced = engine.recoverStatic("visibility-suspended");
  assertResultProperties(reduced, previous, seed, -0.75);
  results.push(reduced);
  previous = reduced.snapshot;

  const resumed = engine.resumeAnimated();
  assertResultProperties(resumed, previous, seed, -0.5);
  invariant(
    resumed.operation === "resume-animated" &&
      resumed.effects.length === 1 &&
      resumed.effects[0]?.type === "readinesschange" &&
      resumed.presentation?.kind === "intro" &&
      resumed.presentation.state === resumed.snapshot.visualState &&
      resumed.presentation.frameIndex === 0 &&
      resumed.snapshot.initialUnitPending,
    seed,
    -0.5,
    "static resume did not restart the unfinished intro exactly"
  );
  results.push(resumed);
  previous = resumed.snapshot;

  for (let index = 0; index < tape.length; index += 1) {
    const operation = tape[index]!;
    let result: Readonly<MotionGraphResult>;

    if (operation.kind === "request") {
      inputsSinceTick += 1;
      result = engine.request(operation.target);
      invariant(
        result.requestId === nextRequestId,
        seed,
        index,
        `request ID ${String(result.requestId)} is not ${String(nextRequestId)}`
      );
      issuedRequestIds.add(nextRequestId);
      nextRequestId += 1;

      if (inputsSinceTick > GRAPH_LIMITS.maxInputsPerTick) {
        invariant(
          result.accepted === false,
          seed,
          index,
          "request beyond the per-tick input cap was accepted"
        );
        invariant(
          result.effects.some(
            (effect) =>
              effect.type === "settle" &&
              effect.outcome.type === "reject" &&
              effect.outcome.error === "InputOverflowError"
          ),
          seed,
          index,
          "overflowed request did not receive InputOverflowError"
        );
      }
    } else if (operation.kind === "send") {
      inputsSinceTick += 1;
      result = engine.send(operation.event);
      if (inputsSinceTick > GRAPH_LIMITS.maxInputsPerTick) {
        invariant(
          result.accepted === false,
          seed,
          index,
          "event beyond the per-tick input cap was accepted"
        );
      }
    } else {
      try {
        result = engine.tick({
          contentOrdinal: nextContentOrdinal,
          routeReady: operation.routeReady
        });
      } catch (error) {
        throw new Error(
          `seed=0x${seed.toString(16)} operation=${String(index)} recentOperations=${JSON.stringify(tape.slice(Math.max(0, index - 8), index + 1))} recentResults=${JSON.stringify(results.slice(-10).map(summarizeResult))}`,
          { cause: error }
        );
      }
      nextContentOrdinal += 1n;
    }

    assertResultProperties(result, previous, seed, index);
    collectSettlements(
      result.effects,
      issuedRequestIds,
      settledRequestIds,
      seed,
      index
    );

    const expectedInputs =
      operation.kind === "tick"
        ? 0
        : Math.min(inputsSinceTick, GRAPH_LIMITS.maxInputsPerTick);
    invariant(
      result.snapshot.inputsSinceTick === expectedInputs,
      seed,
      index,
      `inputsSinceTick is ${String(result.snapshot.inputsSinceTick)}, expected ${String(expectedInputs)}`
    );

    if (operation.kind === "tick") {
      inputsSinceTick = 0;
      invariant(
        result.snapshot.contentOrdinal === nextContentOrdinal - 1n,
        seed,
        index,
        "tick did not consume exactly one content ordinal"
      );
    } else {
      invariant(
        result.presentation === previous.presentation,
        seed,
        index,
        "an input operation changed the presented frame"
      );
    }

    invariant(
      result.snapshot.pendingRequestCount ===
        issuedRequestIds.size - settledRequestIds.size,
      seed,
      index,
      `pending request count ${String(result.snapshot.pendingRequestCount)} diverged from unsettled IDs ${JSON.stringify([...issuedRequestIds].filter((requestId) => !settledRequestIds.has(requestId)))} after ${JSON.stringify(operation)} effects=${formatEffects(result.effects)} recent=${JSON.stringify(results.slice(-8).map(summarizeResult))}`
    );

    results.push(result);
    previous = result.snapshot;
  }

  return {
    results: Object.freeze(results),
    finalSnapshot: engine.snapshot(),
    trace: engine.getTrace(),
    issuedRequestIds,
    settledRequestIds
  };
}

function formatEffects(effects: readonly Readonly<MotionGraphEffect>[]): string {
  return JSON.stringify(effects);
}

function summarizeResult(result: Readonly<MotionGraphResult>): unknown {
  return {
    operation: result.operation,
    accepted: result.accepted,
    joined: result.joined,
    requestId: result.requestId,
    effects: result.effects,
    phase: result.snapshot.phase,
    requested: result.snapshot.requestedState,
    visual: result.snapshot.visualState,
    prospective: result.snapshot.prospectiveState,
    pending: result.snapshot.pendingRequestCount,
    pendingEdge: result.snapshot.pendingEdgeId,
    activeEdge: result.snapshot.activeEdgeId,
    followOn: result.snapshot.followOnEdgeId
  };
}

function assertResultProperties(
  result: Readonly<MotionGraphResult>,
  previous: Readonly<MotionGraphSnapshot>,
  seed: number,
  operationIndex: number
): void {
  invariant(Object.isFrozen(result), seed, operationIndex, "result is mutable");
  invariant(
    Object.isFrozen(result.snapshot),
    seed,
    operationIndex,
    "snapshot is mutable"
  );
  invariant(
    Object.isFrozen(result.effects),
    seed,
    operationIndex,
    "effect list is mutable"
  );
  invariant(
    result.effects.every(Object.isFrozen),
    seed,
    operationIndex,
    "an effect is mutable"
  );
  invariant(
    result.presentation === result.snapshot.presentation,
    seed,
    operationIndex,
    "result and snapshot expose different presentations"
  );

  if (result.presentation !== null) {
    invariant(
      Object.isFrozen(result.presentation),
      seed,
      operationIndex,
      "presentation is mutable"
    );
    assertPresentationBounds(result.presentation, seed, operationIndex);
  }

  for (const effect of result.effects) {
    if (effect.type === "settle") {
      invariant(
        Object.isFrozen(effect.requestIds) && Object.isFrozen(effect.outcome),
        seed,
        operationIndex,
        "settlement is not deeply frozen"
      );
    }
  }

  const visualEffects = result.effects.filter(
    (effect) => effect.type === "visualstatechange"
  );
  const visualChanged = previous.visualState !== result.snapshot.visualState;
  invariant(
    visualEffects.length === (visualChanged ? 1 : 0),
    seed,
    operationIndex,
    "visual state change does not match its effect count"
  );

  if (visualChanged) {
    const effect = visualEffects[0];
    invariant(
      effect?.type === "visualstatechange" &&
        effect.from === previous.visualState &&
        effect.to === result.snapshot.visualState,
      seed,
      operationIndex,
      "visualstatechange effect has inconsistent endpoints"
    );
    invariant(
      isCommittedPresentation(result.presentation, result.snapshot.visualState),
      seed,
      operationIndex,
      "visual state changed without presenting the target entry"
    );
  }

  if (
    result.presentation?.kind === "body" ||
    result.presentation?.kind === "intro" ||
    result.presentation?.kind === "static"
  ) {
    invariant(
      result.presentation.state === result.snapshot.visualState,
      seed,
      operationIndex,
      "stable presentation does not represent visualState"
    );
  }

  for (const effect of result.effects) {
    if (effect.type !== "transitionend") continue;
    invariant(
      effect.to === result.snapshot.visualState &&
        isCommittedPresentation(result.presentation, effect.to),
      seed,
      operationIndex,
      "transition ended without its target entry presentation"
    );
  }
}

function assertPresentationBounds(
  presentation: Readonly<GraphPresentation>,
  seed: number,
  operationIndex: number
): void {
  if (presentation.kind === "static") {
    const state = STATE_BY_ID.get(presentation.state);
    invariant(
      state !== undefined,
      seed,
      operationIndex,
      "static presentation references an unknown state"
    );
    return;
  }

  if (presentation.kind === "intro") {
    const initial = STATE_BY_ID.get(presentation.state)?.initialUnit;
    invariant(
      initial?.unitId === presentation.unitId &&
        presentation.frameIndex >= 0 &&
        presentation.frameIndex < initial.frameCount,
      seed,
      operationIndex,
      "intro presentation is outside its unit"
    );
    return;
  }

  if (presentation.kind === "body") {
    const body = STATE_BY_ID.get(presentation.state)?.body;
    invariant(
      body?.unitId === presentation.unitId &&
        presentation.frameIndex >= 0 &&
        presentation.frameIndex < body.frameCount,
      seed,
      operationIndex,
      "body presentation is outside its unit"
    );
    return;
  }

  const edge = EDGE_BY_ID.get(presentation.edgeId);
  const transition = edge?.transition;
  invariant(
    transition !== undefined &&
      transition.kind === presentation.kind &&
      transition.unitId === presentation.unitId &&
      presentation.frameIndex >= 0 &&
      presentation.frameIndex < transition.frameCount,
    seed,
    operationIndex,
    "transition presentation is outside its unit"
  );
  if (presentation.kind === "reversible") {
    invariant(
      transition?.kind === "reversible" &&
        transition.direction === presentation.direction,
      seed,
      operationIndex,
      "reversible presentation has the wrong direction"
    );
  }
}

function collectSettlements(
  effects: readonly Readonly<MotionGraphEffect>[],
  issued: ReadonlySet<number>,
  settled: Set<number>,
  seed: number,
  operationIndex: number
): void {
  for (const effect of effects) {
    if (effect.type !== "settle") continue;
    const unique = new Set(effect.requestIds);
    invariant(
      unique.size === effect.requestIds.length,
      seed,
      operationIndex,
      "one settlement contains a duplicate request ID"
    );
    for (let index = 1; index < effect.requestIds.length; index += 1) {
      invariant(
        effect.requestIds[index - 1]! < effect.requestIds[index]!,
        seed,
        operationIndex,
        "settlement request IDs are not in request order"
      );
    }
    for (const requestId of effect.requestIds) {
      invariant(
        issued.has(requestId),
        seed,
        operationIndex,
        `settled unknown request ${String(requestId)}`
      );
      invariant(
        !settled.has(requestId),
        seed,
        operationIndex,
        `request ${String(requestId)} settled more than once`
      );
      settled.add(requestId);
    }
  }
}

function isCommittedPresentation(
  presentation: Readonly<GraphPresentation> | null,
  target: string | null
): boolean {
  if (presentation?.kind === "static") return presentation.state === target;
  return (
    presentation?.kind === "body" &&
    presentation.state === target &&
    presentation.frameIndex === 0
  );
}

function createTape(seed: number): readonly TapeOperation[] {
  const random = mulberry32(seed);
  const tape: TapeOperation[] = [];
  const targets = ["idle", "hovered", "success", "missing"] as const;
  const events = [
    "hover.on",
    "hover.off",
    "complete",
    "reset",
    "unknown"
  ] as const;

  for (let tick = 0; tick < GENERATED_TICKS; tick += 1) {
    const inputCount = tick % 211 === 0 ? 40 : Math.floor(random() * 5);
    for (let input = 0; input < inputCount; input += 1) {
      if (random() < 0.72) {
        tape.push({
          kind: "request",
          target: targets[Math.floor(random() * targets.length)]!
        });
      } else {
        tape.push({
          kind: "send",
          event: events[Math.floor(random() * events.length)]!
        });
      }
    }
    tape.push({
      kind: "tick",
      routeReady: tick % 7 === 0 || random() >= 0.2
    });
  }

  for (let tick = 0; tick < DRAIN_TICKS; tick += 1) {
    tape.push({ kind: "tick", routeReady: true });
  }
  return Object.freeze(tape);
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

function invariant(
  condition: unknown,
  seed: number,
  operationIndex: number,
  message: string
): asserts condition {
  if (!condition) {
    throw new Error(
      `seed=0x${seed.toString(16)} operation=${String(operationIndex)}: ${message}`
    );
  }
}

const FUZZ_GRAPH = {
  initialState: "idle",
  states: [
    {
      id: "idle",
      initialUnit: { unitId: "intro-unit", frameCount: 2 },
      body: {
        unitId: "idle-body",
        kind: "loop",
        frameCount: 5,
        ports: [{ id: "main", entryFrame: 0, portalFrames: [1, 4] }]
      }
    },
    {
      id: "hovered",
      body: {
        unitId: "hovered-body",
        kind: "loop",
        frameCount: 4,
        ports: [{ id: "main", entryFrame: 0, portalFrames: [0, 2] }]
      }
    },
    {
      id: "success",
      body: {
        unitId: "success-body",
        kind: "finite",
        frameCount: 3,
        ports: [{ id: "main", entryFrame: 0, portalFrames: [2] }]
      }
    }
  ],
  edges: [
    {
      id: "idle-hovered",
      from: "idle",
      to: "hovered",
      trigger: { type: "event", name: "hover.on" },
      start: {
        type: "portal",
        sourcePort: "main",
        targetPort: "main",
        maxWaitFrames: 5
      },
      transition: {
        kind: "reversible",
        unitId: "hover-shift",
        frameCount: 4,
        direction: "forward"
      },
      continuity: "exact-authored"
    },
    {
      id: "hovered-idle",
      from: "hovered",
      to: "idle",
      trigger: { type: "event", name: "hover.off" },
      start: {
        type: "portal",
        sourcePort: "main",
        targetPort: "main",
        maxWaitFrames: 4
      },
      transition: {
        kind: "reversible",
        unitId: "hover-shift",
        frameCount: 4,
        direction: "reverse",
        reverseOf: "idle-hovered"
      },
      continuity: "exact-reverse"
    },
    {
      id: "idle-success",
      from: "idle",
      to: "success",
      trigger: { type: "event", name: "complete" },
      start: {
        type: "portal",
        sourcePort: "main",
        targetPort: "main",
        maxWaitFrames: 5
      },
      transition: {
        kind: "locked",
        unitId: "idle-success-bridge",
        frameCount: 2
      },
      continuity: "exact-authored"
    },
    {
      id: "hovered-success",
      from: "hovered",
      to: "success",
      trigger: { type: "event", name: "complete" },
      start: {
        type: "portal",
        sourcePort: "main",
        targetPort: "main",
        maxWaitFrames: 4
      },
      transition: {
        kind: "locked",
        unitId: "hovered-success-bridge",
        frameCount: 3
      },
      continuity: "exact-authored"
    },
    {
      id: "success-idle",
      from: "success",
      to: "idle",
      trigger: { type: "event", name: "reset" },
      start: { type: "finish", targetPort: "main", maxWaitFrames: 2 },
      transition: {
        kind: "locked",
        unitId: "success-idle-bridge",
        frameCount: 2
      },
      continuity: "exact-authored"
    },
    {
      id: "success-hovered",
      from: "success",
      to: "hovered",
      trigger: { type: "event", name: "hover.on" },
      start: { type: "finish", targetPort: "main", maxWaitFrames: 2 },
      transition: {
        kind: "locked",
        unitId: "success-hovered-bridge",
        frameCount: 1
      },
      continuity: "exact-authored"
    }
  ]
} as const satisfies MotionGraphDefinition;

const STATE_BY_ID = new Map<
  string,
  MotionGraphDefinition["states"][number]
>(
  FUZZ_GRAPH.states.map((state) => [state.id, state])
);
const EDGE_BY_ID = new Map<
  string,
  MotionGraphDefinition["edges"][number]
>(FUZZ_GRAPH.edges.map((edge) => [edge.id, edge]));
