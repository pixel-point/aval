import type { UnitV01 } from "@rendered-motion/format";
import type {
  GraphEdgeDefinition,
  GraphStateDefinition
} from "@rendered-motion/graph";

import type { DecoderWorkerSample } from "../decoder-worker/protocol.js";
import type {
  AvcCandidateActivationInput,
  AvcCandidatePreparedMedia,
  AvcCandidateReadinessFactory,
  AvcCandidateReadinessSession,
  AvcCandidateReadinessSessionInput
} from "./avc-candidate-factory.js";
import {
  calculateReadinessMetrics,
  idealReadinessDeadlineMs,
  MIN_READINESS_MEASURED_OUTPUTS,
  ReadinessMetricsRecorder,
  type ReadinessFrameMeasurement
} from "./readiness-metrics.js";
import type {
  AllRoutesReadinessEvidence,
  CutReadinessEvidence,
  EdgeDryRunEvidence,
  EndpointRecoveryEvidence,
  InverseReadinessEvidence,
  LoopReadinessEvidence,
  RoutePhaseEvidence
} from "./readiness-evaluator.js";
import type {
  EdgeAdapterInput,
  ReadinessRunnerAdapters,
  ReadinessRunnerResult
} from "./readiness-runner.js";
import type { RuntimeFrameKey } from "./model.js";
import { BrowserAvcCandidateHub } from "./browser-avc-candidate-hub.js";
import {
  manifestBodyFrameAt
} from "./body-frame-semantics.js";
import { BrowserAvcPlaybackSession } from "./browser-avc-playback-session.js";
import {
  browserRecoveryFrames,
  measureBrowserSequenceEvidence
} from "./browser-readiness-evidence.js";
import {
  BrowserProductionReadinessRehearsal
} from "./browser-production-readiness-rehearsal.js";
import {
  productionEndpointEvidence,
  productionInverseEvidence,
  productionLoopEvidence,
  productionPhaseEvidence,
  productionRouteEvidence,
  type BrowserProductionReadinessReport
} from "./browser-production-readiness-evidence.js";

type BodyUnit = Extract<UnitV01, { readonly kind: "body" }>;

export class BrowserAvcCandidateReadinessFactory
  implements AvcCandidateReadinessFactory {
  readonly #hub: BrowserAvcCandidateHub;
  readonly #now: () => number;

  public constructor(options: {
    readonly hub: BrowserAvcCandidateHub;
    readonly now?: () => number;
  }) {
    this.#hub = options.hub;
    this.#now = options.now ?? (() => performance.now());
  }

  public create(
    input: Readonly<AvcCandidateReadinessSessionInput>
  ): AvcCandidateReadinessSession {
    return new BrowserAvcReadinessSession(input, this.#hub, this.#now);
  }
}

/** @deprecated Use BrowserAvcCandidateReadinessFactory. */
export {
  BrowserAvcCandidateReadinessFactory as BrowserOpaqueCandidateReadinessFactory
};

export class BrowserAvcReadinessSession
  implements AvcCandidateReadinessSession {
  readonly #input: Readonly<AvcCandidateReadinessSessionInput>;
  readonly #hub: BrowserAvcCandidateHub;
  readonly #probe: BrowserReadinessProbe;
  readonly #loops: LoopReadinessEvidence[] = [];
  readonly #dryRuns: EdgeDryRunEvidence[] = [];
  readonly #cuts: CutReadinessEvidence[] = [];
  readonly #endpoints: EndpointRecoveryEvidence[] = [];
  readonly #phases: RoutePhaseEvidence[] = [];
  readonly #inverses: InverseReadinessEvidence[] = [];
  #warmup: ReturnType<typeof calculateReadinessMetrics> | null = null;
  #resource: AllRoutesReadinessEvidence["resource"] | null = null;
  #initialRing: AllRoutesReadinessEvidence["initialRing"] | null = null;
  #production: Readonly<BrowserProductionReadinessReport> | null = null;
  #disposed = false;

  public readonly adapters: Readonly<ReadinessRunnerAdapters>;

  public constructor(
    input: Readonly<AvcCandidateReadinessSessionInput>,
    hub: BrowserAvcCandidateHub,
    now: () => number
  ) {
    this.#input = input;
    this.#hub = hub;
    this.#probe = new BrowserReadinessProbe(input, now);
    this.adapters = Object.freeze({
      measureWarmup: async () => this.#measureWarmup(),
      measureLoop: async (value: Parameters<ReadinessRunnerAdapters["measureLoop"]>[0]) =>
        this.#measureLoop(value.unit, value.ringCapacity),
      dryRunEdge: async (value: Parameters<ReadinessRunnerAdapters["dryRunEdge"]>[0]) =>
        this.#dryRunEdge(value),
      prepareCut: async (value: Parameters<ReadinessRunnerAdapters["prepareCut"]>[0]) =>
        this.#prepareCut(value),
      prepareEndpoint: async (value: Parameters<ReadinessRunnerAdapters["prepareEndpoint"]>[0]) => this.#prepareEndpoint(
        value.unit,
        value.endpoint,
        value.ringCapacity
      ),
      simulateRoutePhases: async (value: Parameters<ReadinessRunnerAdapters["simulateRoutePhases"]>[0]) =>
        this.#simulatePhases(value.edge),
      measureActiveInverse: async (value: Parameters<ReadinessRunnerAdapters["measureActiveInverse"]>[0]) =>
        this.#measureInverse(value.unit, value.ringCapacity),
      measureResource: async () => this.#measureResource(),
      fillInitialRing: async (value: Parameters<ReadinessRunnerAdapters["fillInitialRing"]>[0]) =>
        this.#fillInitialRing(value.ringCapacity)
    });
  }

  public observeResult(result: Readonly<ReadinessRunnerResult>): void {
    this.#hub.observeReadiness(result);
  }

  public async prepareActivation(
    input: Readonly<AvcCandidateActivationInput>
  ): Promise<AvcCandidatePreparedMedia> {
    this.#assertActive();
    const playback = await BrowserAvcPlaybackSession.create({
      candidate: this.#input,
      activation: input,
      hub: this.#hub
    });
    if (this.#disposed || input.signal.aborted) {
      await retireLatePlayback(playback);
      throw input.signal.aborted
        ? browserActivationAbortReason(input.signal)
        : new DOMException(
            "browser AVC readiness session was disposed",
            "AbortError"
          );
    }
    try {
      this.#hub.activate(
        this.#input.context.candidate.rendition.id,
        playback
      );
    } catch (error) {
      await retireLatePlayback(playback);
      throw error;
    }
    return Object.freeze({
      playback,
      drawInitial: () => playback.drawInitial(),
      dispose: () => playback.dispose()
    });
  }

  public dispose(): void {
    this.#disposed = true;
  }

  async #measureWarmup() {
    this.#assertActive();
    const loop = requireBodyUnit(
      this.#input.context.catalog.manifest.units,
      (unit) => unit.playback === "loop"
    );
    const frames = repeatBody(loop, MIN_READINESS_MEASURED_OUTPUTS);
    const measurements = await this.#probe.measure(
      `warmup:${loop.id}`,
      frames
    );
    this.#warmup = calculateReadinessMetrics({
      frameRate: this.#input.context.catalog.manifest.frameRate,
      measurements
    });
    if (this.#warmup.passed && this.#warmup.ringCapacity !== null) {
      this.#production = await new BrowserProductionReadinessRehearsal({
        input: this.#input,
        hub: this.#hub,
        ringCapacity: this.#warmup.ringCapacity
      }).run();
      this.#hub.observeProductionReadiness(this.#production);
    }
    return Object.freeze({ measurements });
  }

  async #measureLoop(unit: BodyUnit, ringCapacity: number) {
    this.#assertActive();
    const count = Math.max(
      MIN_READINESS_MEASURED_OUTPUTS,
      ringCapacity,
      unit.frameCount + 1
    );
    const measurements = await this.#probe.measure(
      `loop:${unit.id}`,
      repeatBody(unit, count)
    );
    const measured = measureBrowserSequenceEvidence(
      measurements,
      this.#input.context.catalog.manifest.frameRate
    );
    const local = measurements.map(({ media }) => media.localFrame);
    const production = productionLoopEvidence(
      this.#requireProduction(),
      unit.id
    );
    const seamReady = production.passed && local.every((frame, index) =>
      frame === index % unit.frameCount
    );
    const result = Object.freeze({
      seamReady,
      availableHeadroomFrames:
        seamReady &&
        measured.deadlineSafe &&
        measured.metrics.throughputPassed
          ? Math.min(
              ringCapacity,
              measured.consecutiveDeadlineSafeFrames
            )
          : 0
    });
    this.#loops.push(Object.freeze({ unit: unit.id, ...result }));
    return result;
  }

  async #dryRunEdge(input: Readonly<EdgeAdapterInput>) {
    this.#assertActive();
    const targetUnit = bodyUnitForState(input.manifest.units, input.target);
    const semantic = edgeSequence(input, targetUnit, input.targetProbeFrames);
    const frames = extendTargetSequence(
      semantic,
      targetUnit,
      MIN_READINESS_MEASURED_OUTPUTS,
      throughputPaddingUnit(input.manifest.units, targetUnit.id)
    );
    const measurements = await this.#probe.measure(
      `edge:${input.edge.id}`,
      frames
    );
    const measured = measureBrowserSequenceEvidence(
      measurements,
      input.manifest.frameRate
    );
    const transitionFrames = input.edge.transition?.kind === "locked"
      ? input.edge.transition.frameCount
      : 0;
    const completeSequence = semantic.every((frame, index) => {
      const observed = measurements[index]?.media;
      return observed?.unit === frame.unitId &&
        observed.localFrame === frame.unitFrame;
    });
    const production = productionRouteEvidence(
      this.#requireProduction(),
      input.edge.id
    );
    const result = Object.freeze({
      measurements,
      availableConsecutiveFrames: Math.min(
        input.ringCapacity,
        measured.consecutiveDeadlineSafeFrames
      ),
      transitionFrames,
      targetProbeFrames: input.targetProbeFrames,
      sequenceFrameCount: transitionFrames + input.targetProbeFrames,
      completeSequence: completeSequence && production.passed,
      deadlineSafe: measured.deadlineSafe && production.passed,
      withinBudget: await this.#withinBudget() && production.passed
    });
    const metrics = measured.metrics;
    this.#dryRuns.push(Object.freeze({
      edge: input.edge.id,
      metrics,
      availableConsecutiveFrames: result.availableConsecutiveFrames,
      transitionFrames: result.transitionFrames,
      targetProbeFrames: result.targetProbeFrames,
      sequenceFrameCount: result.sequenceFrameCount,
      completeSequence: result.completeSequence,
      deadlineSafe: result.deadlineSafe,
      withinBudget: result.withinBudget
    }));
    return result;
  }

  async #prepareCut(input: Readonly<EdgeAdapterInput>) {
    this.#assertActive();
    const runway = requireCutRunway(input.edge.id, this.#input.interactionCache);
    const target = bodyUnitForState(
      this.#input.context.catalog.manifest.units,
      input.target
    );
    const measurements = await this.#probe.measure(
      `cut:${input.edge.id}`,
      legalBodyProbe(
        target,
        Math.max(
          MIN_READINESS_MEASURED_OUTPUTS,
          runway.frames.length + 1
        ),
        throughputPaddingUnit(input.manifest.units, target.id)
      )
    );
    const measured = measureBrowserSequenceEvidence(
      measurements,
      input.manifest.frameRate
    );
    const production = productionRouteEvidence(
      this.#requireProduction(),
      input.edge.id
    );
    const runwayPrepared = runway.frames.every((frame, index) =>
      sameFrame(frame, target.id, manifestBodyFrameAt(target, index))
    ) && this.#validateResidentLayers(runway.layers) &&
      production.targetEntryReady && production.handoffReady;
    const continuationIndex = decodedContinuationIndex(
      target,
      runway.frames.length
    );
    const continuation = measurements[continuationIndex];
    const result = Object.freeze({
      runwayPrepared,
      responseFrames: production.responseFrames,
      runwayFrames: runway.frames.length,
      continuationFrame:
        continuation?.media.localFrame ===
          manifestBodyFrameAt(target, runway.frames.length)
          ? runway.frames.length
          : Number.MAX_SAFE_INTEGER,
      recoveryFrames: browserRecoveryFrames(
        measurements,
        continuationIndex,
        input.manifest.frameRate
      ),
      deadlineSafe: measured.deadlineSafe && production.passed,
      withinBudget: await this.#withinBudget() && production.passed
    });
    this.#cuts.push(Object.freeze({ edge: input.edge.id, ...result }));
    return result;
  }

  async #prepareEndpoint(
    unit: Extract<UnitV01, { readonly kind: "reversible" }>,
    endpoint: Extract<UnitV01, { readonly kind: "reversible" }>["residency"]["endpoints"][number],
    _ringCapacity: number
  ) {
    this.#assertActive();
    const clip = this.#input.interactionCache.reversibleClips.find(
      (candidate) => candidate.unit === unit.id
    );
    const runway = clip === undefined
      ? undefined
      : [clip.sourceEndpoint, clip.targetEndpoint].find((candidate) =>
          candidate.state === endpoint.state && candidate.port === endpoint.port
        );
    if (runway === undefined) throw new Error("resident endpoint runway is absent");
    const state = requireGraphState(
      this.#input.context.catalog.graph.definition.states,
      endpoint.state
    );
    const target = bodyUnitForState(
      this.#input.context.catalog.manifest.units,
      state
    );
    const measurements = await this.#probe.measure(
      `endpoint:${unit.id}:${endpoint.state}`,
      legalBodyProbe(
        target,
        Math.max(
          MIN_READINESS_MEASURED_OUTPUTS,
          runway.frames.length + 1
        ),
        throughputPaddingUnit(
          this.#input.context.catalog.manifest.units,
          target.id
        )
      )
    );
    const measured = measureBrowserSequenceEvidence(
      measurements,
      this.#input.context.catalog.manifest.frameRate
    );
    const production = productionEndpointEvidence(
      this.#requireProduction(),
      unit.id,
      endpoint.state,
      endpoint.port
    );
    const runwayPrepared = runway.frames.every((frame, index) =>
      sameFrame(frame, target.id, manifestBodyFrameAt(target, index))
    ) && this.#validateResidentLayers(runway.layers) && production.passed;
    const continuationIndex = decodedContinuationIndex(
      target,
      runway.frames.length
    );
    const continuation = measurements[continuationIndex];
    const result = Object.freeze({
      runwayPrepared,
      runwayFrames: runway.frames.length,
      continuationFrame:
        continuation?.media.localFrame ===
          manifestBodyFrameAt(target, runway.frames.length)
          ? runway.frames.length
          : Number.MAX_SAFE_INTEGER,
      recoveryFrames: browserRecoveryFrames(
        measurements,
        continuationIndex,
        this.#input.context.catalog.manifest.frameRate
      ),
      deadlineSafe: measured.deadlineSafe && production.passed,
      withinBudget: await this.#withinBudget() && production.passed
    });
    this.#endpoints.push(Object.freeze({
      unit: unit.id,
      state: endpoint.state,
      port: endpoint.port,
      ...result
    }));
    return result;
  }

  #simulatePhases(edge: Readonly<GraphEdgeDefinition>) {
    const production = productionPhaseEvidence(
      this.#requireProduction(),
      edge.id
    );
    const result = Object.freeze({
      pendingCancellationReady: production.pendingCancellationReady,
      pendingReplacementReady: production.pendingReplacementReady,
      prospectiveTargetReady: production.prospectiveTargetReady,
      lockedFollowOnReady: production.lockedFollowOnReady
    });
    this.#phases.push(Object.freeze({ edge: edge.id, ...result }));
    return result;
  }

  #measureInverse(
    unit: Extract<UnitV01, { readonly kind: "reversible" }>,
    _ringCapacity: number
  ) {
    const clip = this.#input.interactionCache.reversibleClips.find(
      (candidate) => candidate.unit === unit.id
    );
    const production = productionInverseEvidence(
      this.#requireProduction(),
      unit.id
    );
    const residentReady = clip !== undefined &&
      clip.clip.frames.length === unit.frameCount &&
      this.#validateResidentLayers(clip.clip.layers);
    const result = Object.freeze({
      responseFrames: production.responseFrames,
      adjacentFrame: residentReady && production.passed
    });
    this.#inverses.push(Object.freeze({ unit: unit.id, ...result }));
    return result;
  }

  async #measureResource() {
    const withinBudget = await this.#withinBudget();
    const result = Object.freeze({
      passed: withinBudget && this.#requireProduction().cleanupReady &&
        this.#requireProduction().passed &&
        this.#input.provisionalResourcePlan.totalBytes <=
        this.#input.provisionalResourcePlan.effectiveCapBytes,
      totalBytes: this.#input.provisionalResourcePlan.totalBytes,
      capBytes: this.#input.provisionalResourcePlan.effectiveCapBytes
    });
    this.#resource = result;
    return result;
  }

  async #fillInitialRing(ringCapacity: number) {
    const initial = requireGraphState(
      this.#input.context.catalog.graph.definition.states,
      this.#input.context.catalog.manifest.initialState
    );
    const body = bodyUnitForState(
      this.#input.context.catalog.manifest.units,
      initial
    );
    const measurements = await this.#probe.measure(
      `initial-ring:${initial.id}`,
      legalBodyProbe(
        body,
        ringCapacity,
        throughputPaddingUnit(
          this.#input.context.catalog.manifest.units,
          body.id
        )
      )
    );
    const measured = measureBrowserSequenceEvidence(
      measurements,
      this.#input.context.catalog.manifest.frameRate
    );
    const result = Object.freeze({
      passed:
        measurements.length === ringCapacity &&
        this.#requireProduction().initialRingReady &&
        this.#requireProduction().passed &&
        measured.deadlineSafe &&
        measurements.slice(
          0,
          body.playback === "loop" || body.frameCount === 1
            ? ringCapacity
            : Math.min(body.frameCount, ringCapacity)
        ).every(({ media }, index) =>
          media.unit === body.id &&
          media.localFrame === manifestBodyFrameAt(body, index)
        ),
      frameCount: measurements.length
    });
    this.#initialRing = result;
    this.#publishEvidence();
    return result;
  }

  #validateResidentLayers(layers: readonly number[]): boolean {
    const generation = this.#input.renderer.resourceGeneration;
    for (const layer of layers) {
      const handle = this.#input.renderer.residentHandle(layer);
      if (
        handle.kind !== "resident" ||
        handle.layer !== layer ||
        handle.resourceGeneration !== generation
      ) return false;
      this.#input.renderer.draw(handle);
    }
    return this.#input.renderer.resourceGeneration === generation;
  }

  async #withinBudget(): Promise<boolean> {
    const worker = await this.#input.worker.snapshotMetrics();
    const renderer = this.#input.renderer.snapshot();
    const outstanding = worker.submittedFrames + worker.leasedFrames;
    return this.#input.provisionalResourcePlan.totalBytes <=
        this.#input.provisionalResourcePlan.effectiveCapBytes &&
      worker.pendingSamples <= this.#input.limits.maxPendingSamples &&
      outstanding <= this.#input.limits.maxOutstandingFrames &&
      worker.leasedDecodedBytes <= this.#input.limits.maxDecodedBytes &&
      renderer.state === "active" &&
      renderer.errors === 0 &&
      renderer.allocatedLayers === this.#input.interactionCache.layerCount &&
      renderer.uploadedResidentLayers === this.#input.interactionCache.layerCount;
  }

  #publishEvidence(): void {
    throwIfAborted(this.#input.signal);
    this.#assertActive();
    if (
      this.#warmup === null ||
      this.#resource === null ||
      this.#initialRing === null
    ) throw new Error("readiness evidence is incomplete");
    const evidence: Readonly<AllRoutesReadinessEvidence> = Object.freeze({
      warmupMetrics: this.#warmup,
      loops: Object.freeze([...this.#loops]),
      edgeDryRuns: Object.freeze([...this.#dryRuns]),
      cuts: Object.freeze([...this.#cuts]),
      endpoints: Object.freeze([...this.#endpoints]),
      phases: Object.freeze([...this.#phases]),
      inverses: Object.freeze([...this.#inverses]),
      resource: this.#resource,
      initialRing: this.#initialRing
    });
    this.#hub.observeReadinessEvidence(evidence);
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("browser readiness session is disposed");
  }

  #requireProduction(): Readonly<BrowserProductionReadinessReport> {
    if (this.#production === null) {
      throw new Error("production-backed readiness rehearsal is absent");
    }
    return this.#production;
  }
}

async function retireLatePlayback(
  playback: BrowserAvcPlaybackSession
): Promise<void> {
  try {
    await playback.dispose();
  } catch {
    // Supersession/disposal is already the selected activation outcome.
  }
}

function browserActivationAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException(
    "browser AVC activation was aborted",
    "AbortError"
  );
}

class BrowserReadinessProbe {
  readonly #input: Readonly<AvcCandidateReadinessSessionInput>;
  readonly #now: () => number;
  #slot = 0;

  public constructor(
    input: Readonly<AvcCandidateReadinessSessionInput>,
    now: () => number
  ) {
    this.#input = input;
    this.#now = now;
  }

  public async measure(
    path: string,
    frames: readonly Readonly<{
      readonly unitId: string;
      readonly unitFrame: number;
    }>[]
  ): Promise<readonly Readonly<ReadinessFrameMeasurement>[]> {
    throwIfAborted(this.#input.signal);
    const generation = this.#input.timeline.activateNextGeneration();
    await this.#input.worker.activateGeneration(generation);
    const recorder = new ReadinessMetricsRecorder({
      frameRate: this.#input.context.catalog.manifest.frameRate,
      now: this.#now
    });
    const origin = this.#now();
    let sequenceIndex = 0;
    const batchLimit = Math.min(
      this.#input.limits.maxPendingSamples,
      this.#input.limits.maxOutstandingFrames
    );
    for (let offset = 0; offset < frames.length; offset += batchLimit) {
      throwIfAborted(this.#input.signal);
      const requests = frames.slice(offset, offset + batchLimit);
      const metrics = await this.#input.worker.snapshotMetrics();
      const batch = this.#input.samples.createBatch({
        frames: requests,
        pendingSamples: metrics.pendingSamples,
        outstandingFrames: metrics.submittedFrames + metrics.leasedFrames
      });
      try {
        for (const sample of batch.samples) {
          recorder.submit({
            outputOrdinal: sample.ordinal,
            media: {
              path,
              unit: sample.unitId,
              unitInstance: sample.unitInstance,
              localFrame: sample.unitFrame
            },
            idealDeadlineMs: idealReadinessDeadlineMs(
              origin,
              sequenceIndex + 1,
              this.#input.context.catalog.manifest.frameRate
            )
          });
          sequenceIndex += 1;
        }
        await this.#input.worker.submit(generation, batch.samples);
      } finally {
        batch.release?.();
      }
      await this.#input.worker.waitForFrames(batch.samples.length, {
        signal: this.#input.signal,
        timeoutMs: remainingMs(this.#input)
      });
      for (const expected of batch.samples) {
        const frame = this.#input.worker.takeFrame();
        if (frame === undefined) throw new Error("readiness worker frame is missing");
        assertOutput(frame, expected, generation);
        recorder.workerOutput(frame.ordinal);
        const handle = await this.#input.renderer.uploadStreaming(
          this.#slot,
          generation,
          frame
        );
        this.#slot = (this.#slot + 1) % 3;
        if (handle === null) throw new Error("readiness upload became stale");
        recorder.uploadReady(expected.ordinal);
      }
    }
    return recorder.report().frames;
  }
}

function edgeSequence(
  input: Readonly<EdgeAdapterInput>,
  target: Readonly<BodyUnit>,
  targetFrames: number
): readonly { readonly unitId: string; readonly unitFrame: number }[] {
  const frames: Array<{ readonly unitId: string; readonly unitFrame: number }> = [];
  if (input.edge.transition?.kind === "locked") {
    for (let index = 0; index < input.edge.transition.frameCount; index += 1) {
      frames.push({ unitId: input.edge.transition.unitId, unitFrame: index });
    }
  }
  const semanticTargetFrames = target.playback === "loop" ||
    target.frameCount === 1
    ? targetFrames
    : Math.min(targetFrames, target.frameCount);
  frames.push(...repeatBody(target, semanticTargetFrames));
  return Object.freeze(frames);
}

function extendTargetSequence(
  initial: readonly { readonly unitId: string; readonly unitFrame: number }[],
  target: Readonly<BodyUnit>,
  minimum: number,
  padding: Readonly<UnitV01>
): readonly { readonly unitId: string; readonly unitFrame: number }[] {
  const values = [...initial];
  let logicalFrame = initial.filter(
    ({ unitId }) => unitId === target.id
  ).length;
  if (target.playback === "loop" || target.frameCount === 1) {
    while (values.length < minimum) {
      values.push({
        unitId: target.id,
        unitFrame: manifestBodyFrameAt(target, logicalFrame)
      });
      logicalFrame += 1;
    }
  } else {
    while (logicalFrame < target.frameCount) {
      values.push({ unitId: target.id, unitFrame: logicalFrame });
      logicalFrame += 1;
    }
    appendCompleteOccurrences(values, padding, minimum);
  }
  return Object.freeze(values);
}

function legalBodyProbe(
  unit: Readonly<BodyUnit>,
  minimum: number,
  padding: Readonly<UnitV01>
): readonly { readonly unitId: string; readonly unitFrame: number }[] {
  if (unit.playback === "loop" || unit.frameCount === 1) {
    return repeatBody(unit, minimum);
  }
  const values = Array.from({ length: unit.frameCount }, (_, unitFrame) => ({
    unitId: unit.id,
    unitFrame
  }));
  appendCompleteOccurrences(values, padding, minimum);
  return Object.freeze(values);
}

function appendCompleteOccurrences(
  values: Array<{ readonly unitId: string; readonly unitFrame: number }>,
  unit: Readonly<UnitV01>,
  minimum: number
): void {
  while (values.length < minimum) {
    for (let unitFrame = 0; unitFrame < unit.frameCount; unitFrame += 1) {
      values.push({ unitId: unit.id, unitFrame });
    }
  }
}

function throughputPaddingUnit(
  units: readonly Readonly<UnitV01>[],
  exclude: string
): Readonly<UnitV01> {
  const loop = units.find((unit) =>
    unit.kind === "body" && unit.playback === "loop" && unit.id !== exclude
  );
  return loop ?? units.find((unit) => unit.id !== exclude) ??
    requireBodyUnit(units, () => true);
}

function decodedContinuationIndex(
  unit: Readonly<BodyUnit>,
  logicalFrame: number
): number {
  return unit.playback === "loop" || unit.frameCount === 1
    ? logicalFrame
    : Math.min(logicalFrame, unit.frameCount - 1);
}

function repeatBody(
  unit: Readonly<BodyUnit>,
  count: number
): readonly { readonly unitId: string; readonly unitFrame: number }[] {
  return Object.freeze(Array.from({ length: count }, (_, index) => ({
    unitId: unit.id,
    unitFrame: manifestBodyFrameAt(unit, index)
  })));
}

function requireBodyUnit(
  units: readonly Readonly<UnitV01>[],
  predicate: (unit: Readonly<BodyUnit>) => boolean
): Readonly<BodyUnit> {
  const unit = units.find((candidate): candidate is BodyUnit =>
    candidate.kind === "body" && predicate(candidate)
  );
  if (unit === undefined) throw new Error("readiness requires a body unit");
  return unit;
}

function bodyUnitForState(
  units: readonly Readonly<UnitV01>[],
  state: Readonly<GraphStateDefinition>
): Readonly<BodyUnit> {
  const unit = units.find((candidate): candidate is BodyUnit =>
    candidate.kind === "body" && candidate.id === state.body.unitId
  );
  if (unit === undefined) throw new Error("graph state body unit is absent");
  return unit;
}

function requireGraphState(
  states: readonly Readonly<GraphStateDefinition>[],
  id: string
): Readonly<GraphStateDefinition> {
  const state = states.find((candidate) => candidate.id === id);
  if (state === undefined) throw new Error("readiness graph state is absent");
  return state;
}

function requireCutRunway(
  edge: string,
  plan: Readonly<AvcCandidateReadinessSessionInput["interactionCache"]>
) {
  const runway = plan.cutRunways.find((candidate) => candidate.edge === edge);
  if (runway === undefined) throw new Error("cut runway is absent");
  return runway;
}

function sameFrame(
  frame: Readonly<RuntimeFrameKey>,
  unit: string,
  localFrame: number
): boolean {
  return frame.unit === unit && frame.localFrame === localFrame;
}

function assertOutput(
  frame: { readonly generation: number; readonly ordinal: number; readonly unitId: string; readonly unitInstance: number; readonly unitFrame: number },
  sample: Readonly<DecoderWorkerSample>,
  generation: number
): void {
  if (
    frame.generation !== generation ||
    frame.ordinal !== sample.ordinal ||
    frame.unitId !== sample.unitId ||
    frame.unitInstance !== sample.unitInstance ||
    frame.unitFrame !== sample.unitFrame
  ) throw new Error("readiness worker output identity diverged");
}

function remainingMs(input: Readonly<AvcCandidateReadinessSessionInput>): number {
  const remaining = input.deadlineMs - input.clock.now();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new DOMException("readiness deadline expired", "TimeoutError");
  }
  return remaining;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}
