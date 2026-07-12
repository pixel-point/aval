import type {
  GraphEdgeDefinition,
  GraphStateDefinition
} from "@rendered-motion/graph";

import type { BrowserOpaqueCandidateHub } from "./browser-opaque-candidate-hub.js";
import {
  BrowserReadinessRehearsalDriver,
  assertRehearsalActive,
  type BrowserRehearsalCleanup,
  type BrowserRehearsalTick
} from "./browser-readiness-rehearsal-driver.js";
import type {
  OpaqueCandidateReadinessSessionInput
} from "./opaque-candidate-factory.js";
import { measureBrowserProductionPhase } from "./browser-production-readiness-phases.js";
import {
  createProductionEndpointEvidence,
  createProductionRouteEvidence,
  type BrowserProductionEndpointEvidence,
  type BrowserProductionInverseEvidence,
  type BrowserProductionLoopEvidence,
  type BrowserProductionPhaseEvidence,
  type BrowserProductionReadinessReport,
  type BrowserProductionRouteEvidence,
  type BrowserProductionScenarioEvidence
} from "./browser-production-readiness-evidence.js";

export type {
  BrowserProductionEndpointEvidence,
  BrowserProductionInverseEvidence,
  BrowserProductionLoopEvidence,
  BrowserProductionMediaEvidence,
  BrowserProductionPhaseEvidence,
  BrowserProductionReadinessReport,
  BrowserProductionRouteEvidence,
  BrowserProductionScenarioEvidence
} from "./browser-production-readiness-evidence.js";

/**
 * Production-backed readiness certificate. Synthetic decode timing remains a
 * throughput probe, while this rehearsal is the semantic authority for every
 * graph route and resident/streaming ownership boundary.
 */
export class BrowserProductionReadinessRehearsal {
  readonly #input: Readonly<OpaqueCandidateReadinessSessionInput>;
  readonly #hub: BrowserOpaqueCandidateHub;
  readonly #ringCapacity: number;
  readonly #cleanups: Readonly<BrowserRehearsalCleanup>[] = [];
  readonly #scenarios: Readonly<BrowserProductionScenarioEvidence>[] = [];

  public constructor(options: {
    readonly input: Readonly<OpaqueCandidateReadinessSessionInput>;
    readonly hub: BrowserOpaqueCandidateHub;
    readonly ringCapacity: number;
  }) {
    this.#input = options.input;
    this.#hub = options.hub;
    this.#ringCapacity = options.ringCapacity;
  }

  public async run(): Promise<Readonly<BrowserProductionReadinessReport>> {
    assertRehearsalActive(this.#input);
    const primary = await this.#withDriver("primary", async (driver) => {
      const initialRingReady = await this.#measureInitialRing(driver);
      const loops: Readonly<BrowserProductionLoopEvidence>[] = [];
      for (const unit of this.#input.context.catalog.manifest.units) {
        if (unit.kind !== "body" || unit.playback !== "loop") continue;
        loops.push(await this.#measureLoop(driver, unit.id, unit.frameCount));
      }
      const routes: Readonly<BrowserProductionRouteEvidence>[] = [];
      const remaining = [
        ...this.#input.context.catalog.graph.definition.edges
      ];
      while (remaining.length > 0) {
        const visual = driver.snapshot.visualState;
        const adjacent = remaining.findIndex(({ from }) => from === visual);
        const [edge] = remaining.splice(adjacent < 0 ? 0 : adjacent, 1);
        if (edge === undefined) {
          throw new Error("production readiness route ordering diverged");
        }
        routes.push(await this.#measureRoute(driver, edge));
      }
      return Object.freeze({
        initialRingReady,
        loops: Object.freeze(loops),
        routes: Object.freeze(routes)
      });
    });
    const phases: Readonly<BrowserProductionPhaseEvidence>[] = [];
    for (const edge of this.#input.context.catalog.graph.definition.edges) {
      phases.push(await this.#measurePhases(edge));
    }

    const endpoints: Readonly<BrowserProductionEndpointEvidence>[] = [];
    const inverses: Readonly<BrowserProductionInverseEvidence>[] = [];
    for (const unit of this.#input.context.catalog.manifest.units) {
      if (unit.kind !== "reversible") continue;
      const inverse = await this.#measureInverse(unit.id, unit.frameCount);
      inverses.push(inverse);
      for (const endpoint of unit.residency.endpoints) {
        endpoints.push(createProductionEndpointEvidence({
          unit: unit.id,
          state: endpoint.state,
          port: endpoint.port,
          routes: primary.routes,
          edges: this.#input.context.catalog.graph.definition.edges
        }));
      }
    }

    // A late abort can arrive after the final draw but before certification.
    assertRehearsalActive(this.#input);
    const cleanupReady = this.#cleanups.every(({ passed }) => passed);
    const passed =
      primary.initialRingReady &&
      cleanupReady &&
      primary.loops.every((value) => value.passed) &&
      primary.routes.every((value) => value.passed) &&
      phases.every((value) =>
        value.pendingCancellationReady &&
        value.pendingReplacementReady &&
        value.prospectiveTargetReady &&
        value.lockedFollowOnReady &&
        value.visibleRunwayFollowOnReady
      ) &&
      endpoints.every((value) => value.passed) &&
      inverses.every((value) => value.passed);
    return Object.freeze({
      passed,
      ringCapacity: this.#ringCapacity,
      initialRingReady: primary.initialRingReady,
      loops: primary.loops,
      routes: primary.routes,
      phases: Object.freeze(phases),
      endpoints: Object.freeze(endpoints),
      inverses: Object.freeze(inverses),
      cleanup: Object.freeze([...this.#cleanups]),
      scenarios: Object.freeze([...this.#scenarios]),
      cleanupReady
    });
  }

  async #measureInitialRing(
    driver: BrowserReadinessRehearsalDriver
  ): Promise<boolean> {
    const initial = this.#input.context.catalog.graph.definition.initialState;
    await driver.reachState(initial);
    const scheduler = driver.playbackSnapshot().scheduler;
    return scheduler !== null &&
      scheduler.smoothSession &&
      scheduler.ringCapacity === this.#ringCapacity &&
      // One frame may already be reserved/uploaded by the playback owner.
      scheduler.ringSize + 1 >= this.#ringCapacity;
  }

  async #measureLoop(
    driver: BrowserReadinessRehearsalDriver,
    unit: string,
    frameCount: number
  ): Promise<Readonly<BrowserProductionLoopEvidence>> {
    const state = requireStateForUnit(this.#input, unit);
    await driver.reachState(state.id);
    const frames: number[] = [];
    const current = driver.lastTick?.media;
    if (current?.graphKind === "body" && current.frame.unit === unit) {
      frames.push(current.frame.localFrame);
    }
    for (let count = 0; frames.length < frameCount + 1; count += 1) {
      if (count >= driver.maxTicks) {
        throw new Error(`production readiness loop ${unit} exceeded its bound`);
      }
      const tick = await driver.tick();
      if (tick.media.graphKind === "body" && tick.media.frame.unit === unit) {
        frames.push(tick.media.frame.localFrame);
      }
    }
    const passed = frames.every((frame, index) =>
      index === 0 || frame === (frames[index - 1]! + 1) % frameCount
    );
    return Object.freeze({
      unit,
      passed,
      frames: Object.freeze(frames)
    });
  }

  async #measureRoute(
    driver: BrowserReadinessRehearsalDriver,
    edge: Readonly<GraphEdgeDefinition>
  ): Promise<Readonly<BrowserProductionRouteEvidence>> {
    await driver.reachState(edge.from);
    const needsHandoff = edge.start.type === "cut" ||
      edge.transition?.kind === "reversible";
    const run = await driver.driveEdge(edge, needsHandoff);
    return createProductionRouteEvidence({
      candidate: this.#input,
      edge,
      run
    });
  }

  async #measurePhases(
    edge: Readonly<GraphEdgeDefinition>
  ): Promise<Readonly<BrowserProductionPhaseEvidence>> {
    return this.#withDriver(`phase:${edge.id}`, async (driver) => {
      return measureBrowserProductionPhase({
        candidate: this.#input,
        driver,
        edge
      });
    });
  }

  async #measureInverse(
    unit: string,
    frameCount: number
  ): Promise<Readonly<BrowserProductionInverseEvidence>> {
    const forward = this.#input.context.catalog.graph.definition.edges.find(
      (edge) => edge.transition?.kind === "reversible" &&
        edge.transition.unitId === unit &&
        edge.transition.direction === "forward"
    );
    if (forward === undefined) {
      return Object.freeze({
        unit,
        passed: false,
        responseFrames: Number.MAX_SAFE_INTEGER,
        beforeFrame: null,
        afterFrame: null,
        stagedEndpointPassed: false
      });
    }
    return this.#withDriver(`inverse:${unit}`, async (driver) => {
      await driver.reachState(forward.from);
      const admitted = forward.trigger?.type === "event"
        ? await driver.send(forward.trigger.name)
        : await driver.request(forward.to);
      if (admitted.accepted !== true) {
        throw new Error(`production readiness inverse ${unit} was not admitted`);
      }
      let before: BrowserRehearsalTick | null = null;
      for (let count = 0; count < driver.maxTicks; count += 1) {
        const tick = await driver.tick();
        if (
          tick.media.graphKind === "reversible" &&
          tick.media.frame.localFrame > 0
        ) {
          before = tick;
          break;
        }
      }
      if (before === null) {
        throw new Error(`production readiness inverse ${unit} has no midpoint`);
      }
      if ((await driver.request(forward.from)).accepted !== true) {
        throw new Error(`production readiness inverse ${unit} was rejected`);
      }
      const after = await driver.tick();
      const beforeFrame = before.media.frame.localFrame;
      const afterFrame = after.media.frame.localFrame;
      const midpointPassed = after.media.graphKind === "reversible" &&
        after.result.presentation?.kind === "reversible" &&
        after.result.presentation.direction === "reverse" &&
        afterFrame === beforeFrame - 1;
      if ((await driver.request(forward.to)).accepted !== true) {
        throw new Error(
          `production readiness endpoint inverse ${unit} could not resume`
        );
      }
      let endpointFrame: BrowserRehearsalTick | null = null;
      for (let count = 0; count < driver.maxTicks; count += 1) {
        const tick = await driver.tick();
        if (
          tick.media.graphKind === "reversible" &&
          tick.media.frame.localFrame === frameCount - 1
        ) {
          endpointFrame = tick;
          break;
        }
      }
      if (endpointFrame === null) {
        throw new Error(
          `production readiness endpoint inverse ${unit} exceeded its bound`
        );
      }
      if ((await driver.request(forward.from)).accepted !== true) {
        throw new Error(
          `production readiness staged endpoint inverse ${unit} was rejected`
        );
      }
      const endpointInverse = await driver.tick();
      const endpointPassed =
        endpointInverse.media.graphKind === "reversible" &&
        endpointInverse.result.presentation?.kind === "reversible" &&
        endpointInverse.result.presentation.direction === "reverse" &&
        endpointInverse.media.frame.localFrame === frameCount - 2;
      return Object.freeze({
        unit,
        passed: midpointPassed && endpointPassed,
        responseFrames: 1,
        beforeFrame,
        afterFrame,
        stagedEndpointPassed: endpointPassed
      });
    });
  }

  async #withDriver<T>(
    label: string,
    operation: (driver: BrowserReadinessRehearsalDriver) => Promise<T>
  ): Promise<T> {
    const startedMs = this.#input.clock.now();
    assertRehearsalActive(this.#input);
    const driver = await BrowserReadinessRehearsalDriver.create({
      candidate: this.#input,
      hub: this.#hub,
      ringCapacity: this.#ringCapacity
    });
    let value: T;
    let operationError: unknown = null;
    try {
      value = await operation(driver);
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      const cleanup = await driver.dispose();
      this.#cleanups.push(cleanup);
      const elapsedMs = Math.max(0, this.#input.clock.now() - startedMs);
      this.#scenarios.push(Object.freeze({ label, elapsedMs, cleanup }));
      if (!cleanup.passed && operationError === null) {
        throw new Error("production readiness scenario leaked media resources");
      }
    }
    return value!;
  }
}

function requireStateForUnit(
  input: Readonly<OpaqueCandidateReadinessSessionInput>,
  unit: string
): Readonly<GraphStateDefinition> {
  const state = input.context.catalog.graph.definition.states.find(
    (candidate) => candidate.body.unitId === unit
  );
  if (state === undefined) {
    throw new Error(`production readiness body unit ${unit} has no state`);
  }
  return state;
}
