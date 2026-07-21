import type {
  GraphBodyDefinition,
  GraphEdgeDefinition,
  GraphStartPolicy
} from "@pixel-point/aval-graph";
import type {
  DecoderWorkerMetrics,
  DecoderWorkerSample
} from "../decoder-worker/protocol.js";
import {
  DecoderWorkerWatchdogError,
  type DecoderWorkerWaitOptions,
  type ManagedDecoderWorkerFrame
} from "../decoder-worker/client.js";
import { describe, expect, it } from "vitest";

import { installRuntimeAssetCatalog } from "./asset-catalog.js";
import {
  createIntegratedPathTestAsset,
  createRuntimeTestAsset
} from "./asset-test-support.js";
import { DecodeTimeline } from "./decode-timeline.js";
import { inspectSelectedVideoRendition } from "./video-rendition-inspection.js";
import {
  PathScheduler,
  type PathSchedulerResidentFrame,
  type PathSchedulerTakeResult,
  type PathSchedulerWorkerAdapter
} from "./path-scheduler.js";
import { WorkerSampleFactory } from "./worker-samples.js";

const LIMITS = Object.freeze({
  maxDecodeQueueSize: 8,
  maxPendingSamples: 12,
  maxOutstandingFrames: 12,
  maxDecodedBytes: 12 * 64 * 64 * 4
});

describe("PathScheduler continuous source pumping", () => {
  it("keeps complete loop occurrences continuous under bounded credit", async () => {
    const fixture = createFixture();
    await fixture.scheduler.startBody({
      state: "idle",
      body: body("body", "loop", 2, [1]),
      outgoingStarts: [portalStart()],
      path: "idle-loop"
    });

    const presented: Array<readonly [number, number, number]> = [];
    for (let index = 0; index < 10; index += 1) {
      const report = await fixture.scheduler.pump({ targetRingFrames: 6 });
      expect(report.ringSize).toBeLessThanOrEqual(6);
      const result = fixture.scheduler.takeNext();
      const frame = requireStreaming(result);
      presented.push([
        frame.media.unitInstance,
        frame.media.frame.localFrame,
        frame.media.decodeOrdinal
      ]);
      frame.frame.close();
    }

    expect(presented.map((value) => value.slice(0, 2))).toEqual([
      [0, 0], [0, 1], [1, 0], [1, 1], [2, 0],
      [2, 1], [3, 0], [3, 1], [4, 0], [4, 1]
    ]);
    expect(presented.map((value) => value[2])).toEqual(
      Array.from({ length: 10 }, (_, index) => index)
    );
    expect(fixture.worker.maximumSubmittedBatch).toBeLessThanOrEqual(6);
    expect(fixture.scheduler.snapshot()).toMatchObject({
      generation: 1,
      activePath: "idle-loop",
      smoothSession: true,
      status: "active"
    });
    await fixture.scheduler.dispose();
    expect(fixture.worker.openFrames).toBe(0);
  });

  it("never submits past the unresolved portal horizon", async () => {
    const fixture = createFixture();
    await fixture.scheduler.startBody({
      state: "idle",
      body: body("body", "loop", 2, [0, 1]),
      outgoingStarts: [portalStart()],
      path: "bounded-source"
    });

    await fixture.scheduler.pump({ targetRingFrames: 6 });
    const snapshot = fixture.scheduler.snapshot();
    expect(snapshot.submittedSource).toEqual({ occurrence: 2n, frame: 1 });
    expect(snapshot.unresolvedMaximumSubmitted).toEqual({
      occurrence: 3n,
      frame: 0
    });
    expect(snapshot.ringSize).toBe(6);
  });

  it("maintains the same order under controllable worker output latency", async () => {
    const slow = createFixture({ outputsPerWait: 1 });
    const fast = createFixture({ outputsPerWait: 4 });
    for (const fixture of [slow, fast]) {
      await fixture.scheduler.startBody({
        state: "idle",
        body: body("body", "loop", 2, [1]),
        outgoingStarts: [portalStart()],
        path: "latency"
      });
    }

    const slowReport = await slow.scheduler.pump({ targetRingFrames: 4 });
    const fastReport = await fast.scheduler.pump({ targetRingFrames: 4 });
    expect(slowReport.waits).toBe(4);
    expect(fastReport.waits).toBe(1);
    expect([slow, fast].map((fixture) =>
      fixture.scheduler.snapshot().ringSize
    )).toEqual([4, 4]);
  });

});

describe("PathScheduler locked and target paths", () => {
  it("prepares a complete locked bridge plus target zero before route commit", async () => {
    const fixture = createFixture();
    await startAtSourceZero(fixture);

    const decision = await fixture.scheduler.prepareRoute({
      edge: lockedEdge("to-target", 2),
      targetState: "target",
      targetBody: body("body", "loop", 2, [1])
    });
    expect(decision).toMatchObject({
      kind: "select-portal",
      boundary: { frame: 1 }
    });

    await fixture.scheduler.pump({ targetRingFrames: 6 });
    const sourceBoundary = requireStreaming(fixture.scheduler.takeNext());
    expect(sourceBoundary.purpose).toBe("source");
    expect(sourceBoundary.media.frame.localFrame).toBe(1);
    sourceBoundary.frame.close();

    expect(fixture.scheduler.routeDecision()).toMatchObject({
      kind: "commit-edge",
      lead: { requiredConsecutiveFrames: 3, ready: true }
    });
    fixture.scheduler.commitPreparedRoute();

    const bridgeZero = requireStreaming(fixture.scheduler.takeNext());
    const bridgeOne = requireStreaming(fixture.scheduler.takeNext());
    const targetZero = requireStreaming(fixture.scheduler.takeNext());
    expect([
      identity(bridgeZero),
      identity(bridgeOne),
      identity(targetZero)
    ]).toEqual([
      ["bridge", "intro", 0],
      ["bridge", "intro", 1],
      ["target", "body", 0]
    ]);
    bridgeZero.frame.close();
    bridgeOne.frame.close();
    targetZero.frame.close();
  });

  it("continues the target loop with complete new occurrences", async () => {
    const fixture = createFixture();
    await startAtSourceZero(fixture);
    await fixture.scheduler.prepareRoute({
      edge: lockedEdge("to-target", 2),
      targetState: "target",
      targetBody: body("body", "loop", 2, [1])
    });
    await fixture.scheduler.pump({ targetRingFrames: 6 });
    closeStreaming(fixture.scheduler.takeNext());
    fixture.scheduler.commitPreparedRoute();

    const values: Array<readonly [string, number, number]> = [];
    for (let index = 0; index < 6; index += 1) {
      const current = requireStreaming(fixture.scheduler.takeNext());
      values.push([
        current.purpose,
        current.media.unitInstance,
        current.media.frame.localFrame
      ]);
      current.frame.close();
      await fixture.scheduler.pump({ targetRingFrames: 6 });
    }
    expect(values).toEqual([
      ["bridge", 1, 0],
      ["bridge", 1, 1],
      ["target", 2, 0],
      ["target", 2, 1],
      ["target", 3, 0],
      ["target", 3, 1]
    ]);
  });
});

describe("PathScheduler generation replacement and recovery", () => {
  it("restarts pending replacement from frame zero while retaining global decode time", async () => {
    const fixture = createFixture({ retainOneStaleOutput: true });
    await startAtSourceZero(fixture);
    await fixture.scheduler.prepareRoute({
      edge: lockedEdge("first-route", 2),
      targetState: "first",
      targetBody: body("body", "loop", 2, [1])
    });
    await fixture.scheduler.pump({ targetRingFrames: 4 });
    const before = fixture.scheduler.snapshot();

    const replacement = await fixture.scheduler.prepareRoute({
      edge: lockedEdge("replacement-route", 2),
      targetState: "replacement",
      targetBody: body("body", "loop", 2, [1])
    });
    expect(replacement).toMatchObject({ kind: "select-portal" });
    expect(fixture.scheduler.snapshot()).toMatchObject({
      generation: 2,
      pendingEdge: "replacement-route",
      ringSize: 0
    });

    await fixture.scheduler.pump({ targetRingFrames: 4 });
    const resumed = requireStreaming(fixture.scheduler.takeNext());
    expect(resumed.purpose).toBe("source");
    expect(resumed.media.frame.localFrame).toBe(1);
    expect(resumed.media.decodeOrdinal).toBeGreaterThan(
      before.nextDecodeOrdinal - 1
    );
    resumed.frame.close();
    expect(fixture.scheduler.trace().some((record) =>
      record.operation === "stale-output"
    )).toBe(true);
  });

  it("hands a resident runway to the exact streamed continuation", async () => {
    const fixture = createFixture();
    await startAtSourceZero(fixture);
    const runway = Array.from({ length: 6 }, (_, index) =>
      resident(index % 2)
    );

    const transaction = fixture.scheduler.stageResidentRunway({
      edgeId: "cut-to-target",
      targetState: "target",
      targetBody: body("body", "loop", 2, [1]),
      frames: runway,
      path: "cut-target"
    });
    await fixture.scheduler.commitResidentRunway(
      transaction,
      { alreadyPresented: 1 }
    )();
    await fixture.scheduler.pump({ targetRingFrames: 2 });

    const ordinals: bigint[] = [
      transaction.media[0]!.intendedPresentationOrdinal
    ];
    for (let index = 1; index < runway.length; index += 1) {
      const current = fixture.scheduler.takeNext();
      expect(current.kind).toBe("resident");
      if (current.kind !== "resident") throw new Error("expected resident");
      expect(current.media.frame.localFrame).toBe(index % 2);
      ordinals.push(current.media.intendedPresentationOrdinal);
    }
    const streamed = requireStreaming(fixture.scheduler.takeNext());
    expect(streamed.purpose).toBe("target");
    expect(streamed.media.frame.localFrame).toBe(0);
    expect(streamed.media.intendedPresentationOrdinal).toBe(
      ordinals.at(-1)! + 1n
    );
    streamed.frame.close();
    expect(fixture.scheduler.snapshot().discardedDependencyFrames).toBe(6);
  });

  it("rolls back a staged runway without disturbing a source reservation", async () => {
    const fixture = createFixture();
    await startAtSourceZero(fixture);
    await fixture.scheduler.pump({ targetRingFrames: 1 });
    const source = requireStreaming(fixture.scheduler.reserveNext());
    const before = fixture.scheduler.snapshot();
    const transaction = fixture.scheduler.stageResidentRunway({
      edgeId: "cut-to-target",
      targetState: "target",
      targetBody: body("body", "loop", 2, [1]),
      frames: Array.from({ length: 6 }, (_, index) => resident(index % 2)),
      path: "cut:staged"
    });

    expect(fixture.scheduler.snapshot()).toEqual(before);
    expect(fixture.scheduler.rollbackResidentRunway(transaction)).toBe(true);
    fixture.scheduler.commitPreparedPresentation(source.media);
    source.frame.close();
    expect(fixture.scheduler.snapshot()).toMatchObject({
      generation: 1,
      activePath: "source",
      displayedSource: { occurrence: 0n, frame: 1 }
    });
  });

  it("commits the exact staged generation and records drawn frame zero directly", async () => {
    const fixture = createFixture();
    await startAtSourceZero(fixture);
    const gate = fixture.worker.gateNextActivation();
    const transaction = fixture.scheduler.stageResidentRunway({
      edgeId: "cut-to-target",
      targetState: "target",
      targetBody: body("body", "loop", 2, [1]),
      frames: Array.from({ length: 6 }, (_, index) => resident(index % 2)),
      path: "cut:transaction",
      firstPresentationOrdinal: 9n
    });

    expect(transaction.generation).toBe(2);
    expect(transaction.media.map(({ generation }) => generation)).toEqual(
      Array.from({ length: 6 }, () => 2)
    );
    expect(transaction.media.map(({ intendedPresentationOrdinal }) =>
      intendedPresentationOrdinal
    )).toEqual([9n, 10n, 11n, 12n, 13n, 14n]);
    expect(fixture.scheduler.snapshot()).toMatchObject({
      generation: 1,
      activePath: "source",
      residentFrames: 0
    });

    const activateWorker = fixture.scheduler.commitResidentRunway(
      transaction,
      { alreadyPresented: 1 }
    );
    expect(fixture.scheduler.snapshot()).toMatchObject({
      generation: 2,
      activePath: "cut:transaction",
      residentFrames: 5,
      displayedCursor: {
        path: "cut:transaction",
        unit: "body",
        localFrame: 0
      }
    });
    expect(fixture.worker.activeGeneration).toBe(1);
    const next = fixture.scheduler.reserveNext();
    expect(next.kind).toBe("resident");
    if (next.kind !== "resident") throw new Error("expected resident frame");
    expect(next.media).toBe(transaction.media[1]);
    fixture.scheduler.commitPreparedPresentation(next.media);

    const activation = activateWorker();
    await gate.entered;
    gate.release();
    await activation;
    expect(fixture.scheduler.trace().filter(({ operation }) =>
      operation === "resident-present"
    )).toHaveLength(2);
  });

  it("locks non-token replacement until a staged runway rolls back", async () => {
    const fixture = createFixture();
    await startAtSourceZero(fixture);
    await fixture.scheduler.prepareRoute({
      edge: lockedEdge("obsolete", 2),
      targetState: "obsolete",
      targetBody: body("body", "loop", 2, [1])
    });
    const transaction = fixture.scheduler.stageResidentRunway({
      edgeId: "cut-to-target",
      targetState: "target",
      targetBody: body("body", "loop", 2, [1]),
      frames: Array.from({ length: 6 }, (_, index) => resident(index % 2)),
      path: "cut:locked"
    });

    await expect(fixture.scheduler.prepareRoute({
      edge: lockedEdge("replacement", 2),
      targetState: "replacement",
      targetBody: body("body", "loop", 2, [1])
    })).rejects.toThrow("locked by a staged resident runway");
    expect(fixture.scheduler.snapshot()).toMatchObject({
      generation: 1,
      pendingEdge: "obsolete"
    });

    expect(fixture.scheduler.rollbackResidentRunway(transaction)).toBe(true);
    await expect(fixture.scheduler.prepareRoute({
      edge: lockedEdge("replacement", 2),
      targetState: "replacement",
      targetBody: body("body", "loop", 2, [1])
    })).resolves.toMatchObject({ kind: "select-portal" });
    expect(fixture.scheduler.snapshot().generation).toBe(2);
  });

  it("reserves after a synchronously advanced in-flight replacement", async () => {
    const fixture = createFixture();
    await startAtSourceZero(fixture);
    await fixture.scheduler.prepareRoute({
      edge: lockedEdge("obsolete", 2),
      targetState: "obsolete",
      targetBody: body("body", "loop", 2, [1])
    });
    const gate = fixture.worker.gateNextActivation();
    const replacement = fixture.scheduler.prepareRoute({
      edge: lockedEdge("replacement", 2),
      targetState: "replacement",
      targetBody: body("body", "loop", 2, [1])
    });
    await gate.entered;
    expect(fixture.scheduler.snapshot().generation).toBe(2);

    const transaction = fixture.scheduler.stageResidentRunway({
      edgeId: "cut-to-target",
      targetState: "target",
      targetBody: body("body", "loop", 2, [1]),
      frames: Array.from({ length: 6 }, (_, index) => resident(index % 2)),
      path: "cut:after-in-flight"
    });
    expect(transaction.generation).toBe(3);
    gate.release();
    await replacement;
    await fixture.scheduler.commitResidentRunway(
      transaction,
      { alreadyPresented: 1 }
    )();
    expect(fixture.scheduler.snapshot()).toMatchObject({
      generation: 3,
      activePath: "cut:after-in-flight"
    });
  });

  it("keeps a preserved source coherent when replacement acknowledgement aborts", async () => {
    const fixture = createFixture();
    await startAtSourceZero(fixture);
    await fixture.scheduler.prepareRoute({
      edge: lockedEdge("obsolete", 2),
      targetState: "obsolete",
      targetBody: body("body", "loop", 2, [1])
    });
    await fixture.scheduler.pump({ targetRingFrames: 6 });
    const reserved = requireStreaming(fixture.scheduler.reserveNext());
    expect(reserved.media.frame.localFrame).toBe(1);
    const gate = fixture.worker.gateNextActivation();
    const controller = new AbortController();
    const cancellation = fixture.scheduler.cancelPreparedRoute(
      "cancel:obsolete",
      controller.signal,
      true
    );
    await gate.entered;

    expect(fixture.scheduler.snapshot()).toMatchObject({
      generation: 2,
      activePath: "cancel:obsolete",
      pendingEdge: null,
      displayedSource: { occurrence: 0n, frame: 0 }
    });
    controller.abort(new DOMException("replacement superseded", "AbortError"));
    await expect(cancellation).rejects.toMatchObject({ name: "AbortError" });
    gate.release();
    await Promise.resolve();

    fixture.scheduler.commitPreparedPresentation(reserved.media);
    reserved.frame.close();
    await fixture.scheduler.pump({ targetRingFrames: 1 });
    const adjacent = requireStreaming(fixture.scheduler.takeNext());
    expect(adjacent.media).toMatchObject({
      frame: { localFrame: 0 },
      intendedPresentationOrdinal:
        reserved.media.intendedPresentationOrdinal + 1n
    });
    adjacent.frame.close();
  });

  it("does not let a stale token rollback a newer staged runway", async () => {
    const fixture = createFixture();
    await startAtSourceZero(fixture);
    const input = {
      edgeId: "cut-to-target",
      targetState: "target",
      targetBody: body("body", "loop", 2, [1]),
      frames: Array.from({ length: 6 }, (_, index) => resident(index % 2)),
      path: "cut:first"
    } as const;
    const stale = fixture.scheduler.stageResidentRunway(input);
    expect(fixture.scheduler.rollbackResidentRunway(stale)).toBe(true);
    const current = fixture.scheduler.stageResidentRunway({
      ...input,
      path: "cut:current"
    });

    expect(fixture.scheduler.rollbackResidentRunway(stale)).toBe(false);
    await fixture.scheduler.commitResidentRunway(
      current,
      { alreadyPresented: 1 }
    )();
    expect(fixture.scheduler.snapshot()).toMatchObject({
      generation: 2,
      activePath: "cut:current",
      residentFrames: 5
    });
    expect(fixture.scheduler.rollbackResidentRunway(current)).toBe(false);
  });

  it("hands a long finite runway to its terminal frame and then holds", async () => {
    const fixture = createFixture({ integratedPathAsset: true });
    await fixture.scheduler.startBody({
      state: "source",
      body: body("idle-body", "loop", 4, [3]),
      outgoingStarts: [portalStart()],
      path: "source"
    });
    await fixture.scheduler.pump({ targetRingFrames: 1 });
    closeStreaming(fixture.scheduler.takeNext());
    const finite = body("idle-body", "finite", 4, [3]);
    const runway = [0, 1, 2, 3, 3, 3].map((frame) =>
      residentFor("opaque-path", "idle-body", frame)
    );

    const transaction = fixture.scheduler.stageResidentRunway({
      edgeId: "cut-to-finite",
      targetState: "finite",
      targetBody: finite,
      frames: runway,
      path: "cut-finite"
    });
    await fixture.scheduler.commitResidentRunway(
      transaction,
      { alreadyPresented: 1 }
    )();
    await fixture.scheduler.pump({ targetRingFrames: 2 });
    for (const expected of [1, 2, 3, 3, 3]) {
      const current = fixture.scheduler.takeNext();
      expect(current.kind).toBe("resident");
      if (current.kind === "resident") {
        expect(current.media.frame.localFrame).toBe(expected);
      }
    }
    const handoff = requireStreaming(fixture.scheduler.takeNext());
    expect(handoff.media.frame.localFrame).toBe(3);
    handoff.frame.close();
    fixture.scheduler.promoteTargetToSource({
      state: "finite",
      body: finite,
      outgoingStarts: []
    });

    await fixture.scheduler.pump({ targetRingFrames: 2 });
    expect(fixture.scheduler.takeNext()).toEqual({ kind: "held" });
    expect(fixture.scheduler.snapshot()).toMatchObject({
      discardedDependencyFrames: 3,
      displayedSource: { occurrence: 0n, frame: 3 }
    });
  });

  it("discards a reserved route without advancing and replaces it in-place", async () => {
    const fixture = createFixture();
    await startAtSourceZero(fixture);
    await fixture.scheduler.prepareRoute({
      edge: lockedEdge("obsolete", 2),
      targetState: "obsolete",
      targetBody: body("body", "loop", 2, [1])
    });
    await fixture.scheduler.pump({ targetRingFrames: 6 });
    closeStreaming(fixture.scheduler.takeNext());
    const before = fixture.scheduler.snapshot().displayedSource;
    const obsolete = fixture.scheduler.reserveNext(true);
    expect(obsolete.kind).toBe("frame");
    if (obsolete.kind === "frame") obsolete.frame.close();
    expect(fixture.scheduler.snapshot().displayedSource).toEqual(before);
    fixture.scheduler.discardPreparedPresentation();

    await fixture.scheduler.prepareRoute({
      edge: lockedEdge("latest", 2),
      targetState: "latest",
      targetBody: body("body", "loop", 2, [1]),
      replacementPath: "route:latest"
    });
    expect(fixture.scheduler.snapshot()).toMatchObject({
      generation: 2,
      activePath: "route:latest",
      pendingEdge: "latest",
      displayedSource: before
    });
    expect(fixture.scheduler.trace().some(({ operation, reason }) =>
      operation === "route-commit" && reason === "obsolete"
    )).toBe(false);
  });

  it("cancels an uncommitted route at a terminal finite source", async () => {
    const fixture = createFixture();
    const finite = body("body", "finite", 2, [1]);
    await fixture.scheduler.startBody({
      state: "finite",
      body: finite,
      outgoingStarts: [portalStart()],
      path: "finite"
    });
    await fixture.scheduler.pump({ targetRingFrames: 2 });
    closeStreaming(fixture.scheduler.takeNext());
    closeStreaming(fixture.scheduler.takeNext());
    await fixture.scheduler.prepareRoute({
      edge: lockedEdgeFrom("obsolete", "finite", "target", 2),
      targetState: "target",
      targetBody: body("body", "loop", 2, [1])
    });
    await fixture.scheduler.cancelPreparedRoute("cancel:finite");

    expect(fixture.scheduler.snapshot()).toMatchObject({
      generation: 2,
      activePath: "cancel:finite",
      pendingEdge: null,
      displayedSource: { occurrence: 0n, frame: 1 }
    });
    await fixture.scheduler.pump({ targetRingFrames: 2 });
    expect(fixture.scheduler.takeNext()).toEqual({ kind: "held" });
  });

  it("turns a worker watchdog into a failed, cleaned scheduler", async () => {
    const fixture = createFixture({ watchdog: true });
    await fixture.scheduler.startBody({
      state: "idle",
      body: body("body", "loop", 2, [1]),
      outgoingStarts: [portalStart()],
      path: "watchdog"
    });

    await expect(fixture.scheduler.pump({
      targetRingFrames: 2,
      timeoutMs: 5
    })).rejects.toBeInstanceOf(DecoderWorkerWatchdogError);
    expect(fixture.scheduler.snapshot()).toMatchObject({
      status: "error",
      smoothSession: false,
      ringSize: 0
    });
    expect(fixture.worker.openFrames).toBe(0);
  });
});

describe("PathScheduler ownership and diagnostics", () => {
  it("reports underflow without fabricating a presentation and bounds traces", async () => {
    const fixture = createFixture();
    await fixture.scheduler.startBody({
      state: "idle",
      body: body("body", "loop", 2, [1]),
      outgoingStarts: [portalStart()],
      path: "underflow"
    });

    for (let index = 0; index < 520; index += 1) {
      expect(fixture.scheduler.takeNext().kind).toBe("underflow");
    }
    const trace = fixture.scheduler.trace();
    expect(trace).toHaveLength(512);
    expect(trace[0]!.index).toBeGreaterThan(0);
    expect(trace.at(-1)?.operation).toBe("underflow");
    expect(fixture.scheduler.snapshot().smoothSession).toBe(false);
  });

  it("disposes queued, ring-owned, and worker-owned frames exactly once", async () => {
    const fixture = createFixture();
    await fixture.scheduler.startBody({
      state: "idle",
      body: body("body", "loop", 2, [1]),
      outgoingStarts: [portalStart()],
      path: "cleanup"
    });
    await fixture.scheduler.pump({ targetRingFrames: 6 });
    expect(fixture.worker.openFrames).toBe(6);

    await fixture.scheduler.dispose();
    await fixture.scheduler.dispose();
    expect(fixture.worker.openFrames).toBe(0);
    expect(fixture.worker.abortCalls).toBe(1);
    expect(fixture.scheduler.snapshot()).toMatchObject({
      status: "disposed",
      ringSize: 0,
      expectedOutputs: 0,
      residentFrames: 0
    });
  });
});

function createFixture(options: FakeWorkerOptions = {}) {
  const catalog = installRuntimeAssetCatalog(
    options.integratedPathAsset === true
      ? createIntegratedPathTestAsset()
      : createRuntimeTestAsset()
  );
  const timeline = new DecodeTimeline(catalog.manifest.frameRate);
  const worker = new FakeWorker(options);
  const rendition = options.integratedPathAsset === true
    ? "opaque-path"
    : "opaque";
  const candidate = catalog.videoRenditions
    .find((value) => value.rendition.id === rendition);
  if (candidate === undefined) throw new Error("test rendition is missing");
  const inspection = inspectSelectedVideoRendition(
    catalog,
    candidate
  ).inspection;
  const samples = new WorkerSampleFactory({
    catalog,
    timeline,
    rendition,
    inspection,
    limits: LIMITS
  });
  let now = 0;
  const scheduler = new PathScheduler({
    timeline,
    samples,
    worker,
    rendition: options.integratedPathAsset === true
      ? "opaque-path"
      : "opaque",
    ringCapacity: 6,
    limits: LIMITS,
    clock: { now: () => ++now }
  });
  return { catalog, timeline, worker, samples, scheduler };
}

async function startAtSourceZero(
  fixture: ReturnType<typeof createFixture>
): Promise<void> {
  await fixture.scheduler.startBody({
    state: "idle",
    body: body("body", "loop", 2, [1]),
    outgoingStarts: [portalStart()],
    path: "source"
  });
  await fixture.scheduler.pump({ targetRingFrames: 1 });
  closeStreaming(fixture.scheduler.takeNext());
}

function body(
  unitId: string,
  kind: GraphBodyDefinition["kind"],
  frameCount: number,
  portals: readonly number[]
): GraphBodyDefinition {
  return {
    unitId,
    kind,
    frameCount,
    ports: [{ id: "default", entryFrame: 0, portalFrames: portals }]
  };
}

function portalStart(): Extract<GraphStartPolicy, { type: "portal" }> {
  return {
    type: "portal",
    sourcePort: "default",
    targetPort: "default",
    maxWaitFrames: 6
  };
}

function lockedEdge(id: string, frameCount: number): GraphEdgeDefinition {
  return lockedEdgeFrom(id, "idle", "target", frameCount);
}

function lockedEdgeFrom(
  id: string,
  from: string,
  to: string,
  frameCount: number
): GraphEdgeDefinition {
  return {
    id,
    from,
    to,
    start: portalStart(),
    transition: { kind: "locked", unitId: "intro", frameCount },
    continuity: "exact-authored"
  };
}

function resident(localFrame: number): PathSchedulerResidentFrame {
  return residentFor("opaque", "body", localFrame);
}

function residentFor(
  rendition: string,
  unit: string,
  localFrame: number
): PathSchedulerResidentFrame {
  return {
    frame: { rendition, unit, localFrame },
    unitInstance: 0,
    decodeOrdinal: localFrame,
    timestamp: localFrame * 33_333
  };
}

function requireStreaming(result: PathSchedulerTakeResult) {
  if (result.kind !== "frame") {
    throw new Error(`expected streaming frame, received ${result.kind}`);
  }
  return result;
}

function closeStreaming(result: PathSchedulerTakeResult): void {
  requireStreaming(result).frame.close();
}

function identity(result: ReturnType<typeof requireStreaming>): readonly [
  string,
  string,
  number
] {
  return [result.purpose, result.media.frame.unit, result.media.frame.localFrame];
}

interface FakeWorkerOptions {
  readonly watchdog?: boolean;
  readonly retainOneStaleOutput?: boolean;
  readonly outputsPerWait?: number;
  readonly integratedPathAsset?: boolean;
}

interface PendingFakeSample {
  readonly generation: number;
  readonly sample: Omit<DecoderWorkerSample, "data">;
}

class FakeWorker implements PathSchedulerWorkerAdapter {
  public activeGeneration: number | null = null;
  public maximumSubmittedBatch = 0;
  public abortCalls = 0;
  readonly #watchdog: boolean;
  readonly #retainOneStaleOutput: boolean;
  readonly #outputsPerWait: number;
  readonly #pending: PendingFakeSample[] = [];
  readonly #ready: FakeManagedFrame[] = [];
  readonly #open = new Set<FakeManagedFrame>();
  #acceptedSamples = 0;
  #releasedFrames = 0;
  #staleRetained = false;
  #lastSubmitted: PendingFakeSample | null = null;
  #activationGate: {
    readonly entered: () => void;
    readonly released: Promise<void>;
  } | null = null;

  public constructor(options: FakeWorkerOptions) {
    this.#watchdog = options.watchdog === true;
    this.#retainOneStaleOutput = options.retainOneStaleOutput === true;
    this.#outputsPerWait = options.outputsPerWait ?? 1;
  }

  public get queuedFrames(): number {
    return this.#ready.length;
  }

  public get openFrames(): number {
    return this.#open.size;
  }

  public gateNextActivation(): {
    readonly entered: Promise<void>;
    readonly release: () => void;
  } {
    if (this.#activationGate !== null) {
      throw new Error("fake activation is already gated");
    }
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    this.#activationGate = { entered: enter, released };
    return Object.freeze({ entered, release });
  }

  public async activateGeneration(generation: number): Promise<void> {
    const gate = this.#activationGate;
    if (gate !== null) {
      this.#activationGate = null;
      gate.entered();
      await gate.released;
    }
    const previous = this.activeGeneration;
    this.activeGeneration = generation;
    for (const frame of [...this.#ready]) {
      if (frame.generation !== generation) frame.close();
    }
    this.#ready.splice(0, this.#ready.length,
      ...this.#ready.filter((frame) => !frame.closed));
    if (
      previous !== null &&
      this.#retainOneStaleOutput &&
      !this.#staleRetained
    ) {
      const retained = this.#pending.find((item) =>
        item.generation === previous
      ) ?? (this.#lastSubmitted?.generation === previous
        ? this.#lastSubmitted
        : undefined);
      this.#pending.splice(0, this.#pending.length,
        ...(retained === undefined ? [] : [retained]));
      this.#staleRetained = retained !== undefined;
    } else {
      this.#pending.length = 0;
    }
  }

  public async submit(
    generation: number,
    samples: readonly DecoderWorkerSample[]
  ): Promise<void> {
    if (generation !== this.activeGeneration) {
      throw new Error("fake generation mismatch");
    }
    this.maximumSubmittedBatch = Math.max(
      this.maximumSubmittedBatch,
      samples.length
    );
    for (const sample of samples) {
      const { data, ...metadata } = sample;
      structuredClone(data, { transfer: [data] });
      this.#pending.push({ generation, sample: metadata });
      this.#lastSubmitted = { generation, sample: metadata };
      this.#acceptedSamples += 1;
    }
  }

  public async abortGeneration(generation: number): Promise<void> {
    this.abortCalls += 1;
    this.#pending.splice(0, this.#pending.length,
      ...this.#pending.filter((item) => item.generation !== generation));
    for (const frame of [...this.#open]) {
      if (frame.generation === generation) frame.close();
    }
    this.#ready.splice(0, this.#ready.length,
      ...this.#ready.filter((frame) => !frame.closed));
    if (this.activeGeneration === generation) this.activeGeneration = null;
  }

  public takeFrame(): ManagedDecoderWorkerFrame | undefined {
    return this.#ready.shift();
  }

  public async waitForFrames(
    minimum = 1,
    _options: DecoderWorkerWaitOptions = {}
  ): Promise<void> {
    if (this.#watchdog) {
      throw new DecoderWorkerWatchdogError("injected path scheduler watchdog");
    }
    let released = 0;
    while (
      this.#pending.length > 0 &&
      (this.#ready.length < minimum || released < this.#outputsPerWait) &&
      released < this.#outputsPerWait
    ) {
      const pending = this.#pending.shift()!;
      const frame = new FakeManagedFrame(pending, () => {
        this.#open.delete(frame);
        this.#releasedFrames += 1;
      });
      this.#open.add(frame);
      this.#ready.push(frame);
      released += 1;
    }
  }

  public async snapshotMetrics(): Promise<DecoderWorkerMetrics> {
    const activeGeneration = this.activeGeneration;
    const submittedFrames = this.#pending.filter((item) =>
      item.generation === activeGeneration
    ).length;
    const leasedFrames = [...this.#open].filter((frame) =>
      frame.generation === activeGeneration
    ).length;
    return {
      configureCalls: 1,
      resetCalls: 0,
      flushCalls: 0,
      boundaryFlushCalls: 0,
      acceptedSamples: this.#acceptedSamples,
      submittedChunks: this.#acceptedSamples,
      outputFrames: this.#acceptedSamples - this.#pending.length,
      deliveredFrames: this.#acceptedSamples - this.#pending.length,
      releasedFrames: this.#releasedFrames,
      staleFrames: 0,
      closedFrames: this.#releasedFrames,
      pendingSamples: 0,
      submittedFrames,
      leasedFrames,
      leasedDecodedBytes: leasedFrames * 128,
      decodeQueueSize: submittedFrames,
      activeGeneration,
      nextSubmissionOrdinal: this.#acceptedSamples,
      nextOutputOrdinal: this.#acceptedSamples - this.#pending.length,
      errors: 0,
      disposed: false
    };
  }
}

class FakeManagedFrame implements ManagedDecoderWorkerFrame {
  public readonly frame: VideoFrame;
  public readonly frameId: number;
  public readonly generation: number;
  public readonly ordinal: number;
  public readonly unitId: string;
  public readonly unitInstance: number;
  public readonly unitFrame: number;
  public readonly decodeIndex: number;
  public readonly timestamp: number;
  public readonly duration: number;
  public readonly decodedBytes = 128;
  readonly #release: () => void;
  #closed = false;

  public constructor(pending: PendingFakeSample, release: () => void) {
    const unitFrame = pending.sample.presentationIndices[0];
    if (unitFrame === undefined) {
      throw new Error("fake path worker cannot emit a hidden chunk");
    }
    this.frame = { close() {} } as unknown as VideoFrame;
    this.frameId = pending.sample.presentationOrdinalBase + unitFrame + 1;
    this.generation = pending.generation;
    this.ordinal = pending.sample.presentationOrdinalBase + unitFrame;
    this.unitId = pending.sample.unitId;
    this.unitInstance = pending.sample.unitInstance;
    this.unitFrame = unitFrame;
    this.decodeIndex = pending.sample.decodeIndex;
    this.timestamp = pending.sample.presentationTimestamp;
    this.duration = pending.sample.duration;
    this.#release = release;
  }

  public get closed(): boolean {
    return this.#closed;
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.frame.close();
    this.#release();
  }
}
