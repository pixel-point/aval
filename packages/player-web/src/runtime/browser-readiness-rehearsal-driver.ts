import {
  MotionGraphEngine,
  type GraphEdgeDefinition,
  type GraphPresentation,
  type MotionGraphResult,
  type MotionGraphSnapshot
} from "@rendered-motion/graph";

import type { BrowserOpaqueCandidateHub } from "./browser-opaque-candidate-hub.js";
import { BrowserOpaquePlaybackSession } from "./browser-opaque-playback-session.js";
import type { BrowserFrameMedia } from "./browser-playback-types.js";
import type { IntegratedPreparedContentTick } from "./integrated-player-contracts.js";
import { createIntegratedActivationPresentation } from "./integrated-player-support.js";
import type {
  OpaqueCandidateReadinessSessionInput
} from "./opaque-candidate-factory.js";
import { PathScheduler } from "./path-scheduler.js";
import { createRuntimeResourcePlan } from "./resource-plan.js";

export interface BrowserRehearsalTick {
  readonly result: Readonly<MotionGraphResult>;
  readonly media: Readonly<BrowserFrameMedia>;
  readonly routeReady: boolean;
  readonly tag: string | null;
}

export interface BrowserRehearsalRouteRun {
  readonly ticks: readonly Readonly<BrowserRehearsalTick>[];
  readonly targetEntryIndex: number;
  readonly responseFrames: number;
  readonly targetResidentEntry: Readonly<BrowserFrameMedia> | null;
  readonly targetStreamingHandoff: Readonly<BrowserFrameMedia> | null;
}

export interface BrowserRehearsalCleanup {
  readonly passed: boolean;
  readonly pendingSamples: number;
  readonly submittedFrames: number;
  readonly leasedFrames: number;
  readonly queuedFrames: number;
  readonly openFrames: number;
  readonly pendingPromises: number;
}

/**
 * Drives the production graph/scheduler/browser composition without a second
 * media authority. Each readiness scenario owns one fresh scheduler and must
 * dispose it before another scenario can start on the sole decoder worker.
 */
export class BrowserReadinessRehearsalDriver {
  readonly #candidate: Readonly<OpaqueCandidateReadinessSessionInput>;
  readonly #hub: BrowserOpaqueCandidateHub;
  readonly #graph: MotionGraphEngine;
  readonly #session: BrowserOpaquePlaybackSession;
  readonly #tickLimit: number;
  #nextOrdinal = 1n;
  #lastTick: Readonly<BrowserRehearsalTick> | null = null;
  #disposed = false;

  private constructor(options: {
    readonly candidate: Readonly<OpaqueCandidateReadinessSessionInput>;
    readonly hub: BrowserOpaqueCandidateHub;
    readonly graph: MotionGraphEngine;
    readonly session: BrowserOpaquePlaybackSession;
    readonly tickLimit: number;
  }) {
    this.#candidate = options.candidate;
    this.#hub = options.hub;
    this.#graph = options.graph;
    this.#session = options.session;
    this.#tickLimit = options.tickLimit;
  }

  public static async create(options: {
    readonly candidate: Readonly<OpaqueCandidateReadinessSessionInput>;
    readonly hub: BrowserOpaqueCandidateHub;
    readonly ringCapacity: number;
  }): Promise<BrowserReadinessRehearsalDriver> {
    assertRehearsalActive(options.candidate);
    const graph = new MotionGraphEngine();
    const installed = graph.install(options.candidate.context.catalog.graph);
    const scheduler = new PathScheduler({
      timeline: options.candidate.timeline,
      samples: options.candidate.samples,
      worker: options.candidate.worker,
      rendition: options.candidate.context.candidate.rendition.id,
      ringCapacity: options.ringCapacity,
      limits: options.candidate.limits,
      clock: options.candidate.clock
    });
    const resourcePlan = createRuntimeResourcePlan({
      catalog: options.candidate.context.catalog,
      rendition: options.candidate.context.candidate.rendition.id,
      interactionCache: options.candidate.interactionCache,
      ringCapacity: options.ringCapacity,
      ...(options.candidate.context.hostMaxRuntimeBytes === null
        ? {}
        : {
            hostMaxRuntimeBytes:
              options.candidate.context.hostMaxRuntimeBytes
          })
    });
    let session: BrowserOpaquePlaybackSession | null = null;
    try {
      session = await BrowserOpaquePlaybackSession.create({
        candidate: options.candidate,
        activation: Object.freeze({
          graphSnapshot: installed.snapshot,
          expectedPresentation: createIntegratedActivationPresentation(
            options.candidate.context.catalog.graph,
            installed.snapshot
          ),
          scheduler,
          finalResourcePlan: resourcePlan,
          signal: options.candidate.signal,
          deadlineMs: options.candidate.deadlineMs
        }),
        hub: options.hub
      });
      const driver = new BrowserReadinessRehearsalDriver({
        candidate: options.candidate,
        hub: options.hub,
        graph,
        session,
        tickLimit: rehearsalTickLimit(options.candidate)
      });
      session.synchronizeGraph(driver.#graph.beginAnimated());
      session.drawInitial();
      await session.settled();
      assertRehearsalActive(options.candidate);
      return driver;
    } catch (error) {
      if (session !== null) await session.dispose();
      else await scheduler.dispose();
      throw error;
    }
  }

  public get snapshot(): Readonly<MotionGraphSnapshot> {
    return this.#graph.snapshot();
  }

  public get lastTick(): Readonly<BrowserRehearsalTick> | null {
    return this.#lastTick;
  }

  public get maxTicks(): number {
    return this.#tickLimit;
  }

  public playbackSnapshot(): ReturnType<BrowserOpaquePlaybackSession["snapshot"]> {
    return this.#session.snapshot();
  }

  public async tick(options: {
    readonly settleBefore?: boolean;
    readonly settleAfter?: boolean;
  } = {}): Promise<Readonly<BrowserRehearsalTick>> {
    this.#assertUsable();
    assertRehearsalActive(this.#candidate);
    if (options.settleBefore !== false) await this.#session.settled();
    const prepared = this.#session.prepareContentTick({
      presentationOrdinal: this.#nextOrdinal,
      rationalDeadlineUs: rationalDeadlineUs(
        this.#nextOrdinal,
        this.#candidate.context.catalog.manifest.frameRate
      ),
      graphSnapshot: this.#graph.snapshot(),
      previewTick: (input) => this.#graph.previewTick(input)
    });
    if (prepared === null) {
      throw new Error("production readiness content tick underflowed");
    }
    const media = requireFrameMedia(prepared);
    const result = this.#graph.tick({
      contentOrdinal: this.#nextOrdinal - 1n,
      routeReady: prepared.routeReady
    });
    const presentation = result.presentation;
    if (presentation === null) {
      throw new Error("production readiness graph tick has no presentation");
    }
    const tag = this.#session.drawContentTick(prepared, presentation);
    this.#session.synchronizeGraph(result);
    const tick = Object.freeze({
      result,
      media,
      routeReady: prepared.routeReady,
      tag
    });
    this.#lastTick = tick;
    this.#nextOrdinal += 1n;
    if (options.settleAfter !== false) await this.#session.settled();
    assertRehearsalActive(this.#candidate);
    return tick;
  }

  public async request(
    state: string,
    settle = true
  ): Promise<Readonly<MotionGraphResult>> {
    this.#assertUsable();
    const result = this.#graph.request(state);
    this.#session.synchronizeGraph(result);
    if (settle) await this.#session.settled();
    assertRehearsalActive(this.#candidate);
    return result;
  }

  public async send(event: string): Promise<Readonly<MotionGraphResult>> {
    this.#assertUsable();
    const result = this.#graph.send(event);
    this.#session.synchronizeGraph(result);
    await this.#session.settled();
    assertRehearsalActive(this.#candidate);
    return result;
  }

  public async reachState(
    state: string,
    options: { readonly leaveTargetUnsettled?: boolean } = {}
  ): Promise<void> {
    this.#assertUsable();
    await this.#reachInitialBody();
    const visual = this.#graph.snapshot().visualState;
    if (visual === null) {
      throw new Error("production readiness graph has no visual state");
    }
    const path = findEdgePath(
      this.#candidate.context.catalog.graph.definition.edges,
      visual,
      state
    );
    for (let index = 0; index < path.length; index += 1) {
      const edge = path[index]!;
      await this.driveEdge(edge, true, {
        leaveTargetUnsettled:
          options.leaveTargetUnsettled === true && index === path.length - 1
      });
    }
    if (this.#graph.snapshot().visualState !== state) {
      throw new Error(`production readiness did not reach state ${state}`);
    }
  }

  public async driveEdge(
    edge: Readonly<GraphEdgeDefinition>,
    requireStreamingHandoff: boolean,
    options: { readonly leaveTargetUnsettled?: boolean } = {}
  ): Promise<Readonly<BrowserRehearsalRouteRun>> {
    this.#assertUsable();
    if (this.#graph.snapshot().visualState !== edge.from) {
      throw new Error(`production readiness edge ${edge.id} has wrong source`);
    }
    await this.#admit(edge);
    const ticks: Readonly<BrowserRehearsalTick>[] = [];
    let targetEntryIndex = -1;
    let resident: Readonly<BrowserFrameMedia> | null = null;
    let streaming: Readonly<BrowserFrameMedia> | null = null;
    for (let index = 0; index < this.#tickLimit; index += 1) {
      const tick = await this.tick({
        settleAfter: options.leaveTargetUnsettled !== true
      });
      ticks.push(tick);
      if (isTargetBody(tick.media, edge.to)) {
        if (targetEntryIndex < 0 && tick.media.frame.localFrame === 0) {
          targetEntryIndex = index;
        }
        if (tick.media.drawSource === "resident" && resident === null) {
          resident = tick.media;
        }
        if (
          tick.media.drawSource === "streaming" &&
          targetEntryIndex >= 0
        ) {
          streaming = tick.media;
        }
      }
      if (targetEntryIndex < 0) continue;
      if (!requireStreamingHandoff || streaming !== null) break;
    }
    if (targetEntryIndex < 0) {
      throw new Error(`production readiness edge ${edge.id} never entered target`);
    }
    if (requireStreamingHandoff && streaming === null) {
      throw new Error(
        `production readiness edge ${edge.id} never handed off to streaming`
      );
    }
    return Object.freeze({
      ticks: Object.freeze(ticks),
      targetEntryIndex,
      responseFrames: targetEntryIndex + 1,
      targetResidentEntry: resident,
      targetStreamingHandoff: streaming
    });
  }

  public async dispose(): Promise<Readonly<BrowserRehearsalCleanup>> {
    if (!this.#disposed) {
      this.#disposed = true;
      await this.#session.dispose();
      await this.#hub.settled();
    }
    const metrics = await this.#candidate.worker.snapshotMetrics();
    const playback = this.#session.snapshot();
    const cleanup = Object.freeze({
      passed:
        metrics.pendingSamples === 0 &&
        metrics.submittedFrames === 0 &&
        metrics.leasedFrames === 0 &&
        this.#candidate.worker.queuedFrames === 0 &&
        this.#candidate.worker.openFrames === 0 &&
        playback.pendingPromises === 0 &&
        playback.pendingCallbacks === 0,
      pendingSamples: metrics.pendingSamples,
      submittedFrames: metrics.submittedFrames,
      leasedFrames: metrics.leasedFrames,
      queuedFrames: this.#candidate.worker.queuedFrames,
      openFrames: this.#candidate.worker.openFrames,
      pendingPromises: playback.pendingPromises
    });
    assertRehearsalActive(this.#candidate);
    return cleanup;
  }

  async #reachInitialBody(): Promise<void> {
    for (let count = 0; count < this.#tickLimit; count += 1) {
      const presentation = this.#graph.snapshot().presentation;
      if (presentation?.kind === "body") return;
      await this.tick();
    }
    throw new Error("production readiness initial body did not become visible");
  }

  async #admit(edge: Readonly<GraphEdgeDefinition>): Promise<void> {
    if (edge.trigger?.type === "completion") return;
    const result = edge.trigger?.type === "event"
      ? await this.send(edge.trigger.name)
      : await this.request(edge.to);
    if (result.accepted !== true) {
      throw new Error(`production readiness could not admit edge ${edge.id}`);
    }
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new Error("production readiness driver is disposed");
    }
  }
}

function requireFrameMedia(
  prepared: Readonly<IntegratedPreparedContentTick>
): Readonly<BrowserFrameMedia> {
  if (prepared.media.kind !== "frame") {
    throw new Error("production readiness content tick underflowed");
  }
  return prepared.media;
}

function isTargetBody(
  media: Readonly<BrowserFrameMedia>,
  state: string
): boolean {
  return media.graphKind === "body" && media.state === state;
}

function findEdgePath(
  edges: readonly Readonly<GraphEdgeDefinition>[],
  from: string,
  to: string
): readonly Readonly<GraphEdgeDefinition>[] {
  if (from === to) return Object.freeze([]);
  const queue: Array<{
    readonly state: string;
    readonly path: readonly Readonly<GraphEdgeDefinition>[];
  }> = [{ state: from, path: Object.freeze([]) }];
  const seen = new Set([from]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of edges) {
      if (edge.from !== current.state || seen.has(edge.to)) continue;
      const path = Object.freeze([...current.path, edge]);
      if (edge.to === to) return path;
      seen.add(edge.to);
      queue.push({ state: edge.to, path });
    }
  }
  throw new Error(`production readiness state ${to} is unreachable`);
}

function rationalDeadlineUs(
  ordinal: bigint,
  frameRate: { readonly numerator: number; readonly denominator: number }
): number {
  const value = Number(ordinal) * 1_000_000 * frameRate.denominator /
    frameRate.numerator;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("production readiness deadline is out of range");
  }
  return value;
}

function rehearsalTickLimit(
  input: Readonly<OpaqueCandidateReadinessSessionInput>
): number {
  const unitFrames = input.context.catalog.manifest.units.reduce(
    (sum, unit) => sum + unit.frameCount,
    0
  );
  const routeWait = input.context.catalog.graph.definition.edges.reduce(
    (sum, edge) => sum + edge.start.maxWaitFrames,
    0
  );
  return Math.max(64, unitFrames * 4 + routeWait * 2 + 16);
}

export function assertRehearsalActive(
  input: Readonly<Pick<
    OpaqueCandidateReadinessSessionInput,
    "signal" | "clock" | "deadlineMs"
  >>
): void {
  if (input.signal.aborted) throw input.signal.reason;
  if (input.clock.now() >= input.deadlineMs) {
    throw new DOMException("production readiness deadline expired", "TimeoutError");
  }
}

export function presentationFrameIdentity(
  presentation: Readonly<GraphPresentation>
): string {
  switch (presentation.kind) {
    case "static":
      return `static:${presentation.state}:${presentation.staticFrameId}`;
    case "intro":
    case "body":
      return `${presentation.kind}:${presentation.state}:${presentation.unitId}:${String(presentation.frameIndex)}`;
    case "locked":
    case "reversible":
      return `${presentation.kind}:${presentation.edgeId}:${presentation.unitId}:${String(presentation.frameIndex)}`;
  }
}
