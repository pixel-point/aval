import { afterEach, describe, expect, it } from "vitest";

import { OpaqueCandidateFactory } from "./opaque-candidate-factory.js";
import {
  LeakTracker,
  ManualTimers,
  activationPresentation,
  createContexts,
  createDependencies,
  disposeOpaqueCandidateTestCatalogs,
  operationOptions,
  waitFor
} from "./opaque-candidate-factory-test-support.js";

afterEach(() => {
  disposeOpaqueCandidateTestCatalogs();
});

describe("OpaqueCandidateFactory", () => {
  it("derives the exact inspected worker configuration and final scheduler", async () => {
    const contexts = createContexts();
    const tracker = new LeakTracker();
    const dependencies = createDependencies(tracker);
    const factory = new OpaqueCandidateFactory(dependencies.options);
    const attempt = factory.create(contexts.high);

    await attempt.prepare(operationOptions());

    expect(factory.availability).toEqual({
      workerAvailable: true,
      rendererAvailable: true
    });
    expect(tracker.configurations).toEqual([{
      config: {
        codec: "avc1.42E020",
        codedWidth: 64,
        codedHeight: 64,
        hardwareAcceleration: "no-preference",
        optimizeForLatency: true
      },
      avcProfile: {
        codedWidth: 64,
        codedHeight: 64,
        frameRate: { numerator: 30, denominator: 1 },
        averageBitrate: 1_000_000,
        peakBitrate: 2_000_000,
        cpbBufferBits: 2_000_000,
        requireBt709LimitedRange: true
      },
      expectedOutput: {
        codedWidth: 64,
        codedHeight: 64,
        displayWidth: 64,
        displayHeight: 64,
        visibleRect: { x: 0, y: 0, width: 64, height: 64 },
        colorSpace: {
          fullRange: false,
          matrix: "bt709",
          primaries: "bt709",
          transfer: "bt709"
        }
      },
      limits: {
        maxDecodeQueueSize: 12,
        maxPendingSamples: 24,
        maxOutstandingFrames: 12,
        maxDecodedBytes: 307_200
      }
    }]);
    expect(tracker.cacheInputs).toHaveLength(1);
    expect(tracker.workerActivations).toEqual([1]);
    expect(tracker.order.slice(0, 7)).toEqual([
      "worker:create:opaque-high",
      "worker:configure:opaque-high",
      "reservation:create:opaque-high",
      "renderer:create:opaque-high",
      "worker:activate:opaque-high:1",
      "cache:prepare:opaque-high",
      "readiness:create:opaque-high"
    ]);
    expect(tracker.readinessInputs[0]).toMatchObject({
      provisionalResourcePlan: { ringCapacity: 12 },
      interactionCache: { rendition: "opaque-high" }
    });
    expect(tracker.readinessWarmupCalls).toBe(1);
    expect(tracker.initialRingCalls).toBe(1);

    const expected = activationPresentation(contexts.high);
    const token = await attempt.prepareActivation({
      ...operationOptions(),
      graphSnapshot: contexts.high.graphSnapshot,
      expectedPresentation: expected
    });
    expect(token.expectedPresentation).toEqual(expected);
    expect(tracker.activationInputs[0]?.scheduler.snapshot()).toMatchObject({
      status: "idle",
      ringCapacity: 6
    });
    expect(tracker.activationInputs[0]?.finalResourcePlan.ringCapacity).toBe(6);
    expect(attempt.playback.traceState().scheduler.ringCapacity).toBe(6);

    await attempt.dispose();
    tracker.expectZeroLeaks();
  });

  it("fully retires a failed high candidate before creating the low worker", async () => {
    const contexts = createContexts();
    const tracker = new LeakTracker({
      modes: { "opaque-high": "configure-failure" }
    });
    const dependencies = createDependencies(tracker);
    const factory = new OpaqueCandidateFactory(dependencies.options);

    const high = factory.create(contexts.high);
    await expect(high.prepare(operationOptions())).rejects.toThrow(
      "injected configure failure"
    );
    expect(tracker.workerAlive).toBe(0);

    const low = factory.create(contexts.low);
    await low.prepare(operationOptions());

    expect(tracker.maximumWorkersAlive).toBe(1);
    expect(tracker.order).toEqual(expect.arrayContaining([
      "worker:create:opaque-high",
      "worker:dispose:opaque-high",
      "worker:create:opaque-low"
    ]));
    expect(tracker.order.indexOf("worker:dispose:opaque-high"))
      .toBeLessThan(tracker.order.indexOf("worker:create:opaque-low"));

    await low.dispose();
    tracker.expectZeroLeaks();
  });

  it("rejects an over-budget candidate before allocating textures", async () => {
    const contexts = createContexts(1);
    const tracker = new LeakTracker();
    const dependencies = createDependencies(tracker);
    const attempt = new OpaqueCandidateFactory(dependencies.options)
      .create(contexts.high);

    await expect(attempt.prepare(operationOptions())).rejects.toMatchObject({
      code: "resource-rejection"
    });

    expect(tracker.configurations).toHaveLength(1);
    expect(tracker.rendererAllocations).toBe(0);
    expect(tracker.cacheInputs).toHaveLength(0);
    expect(tracker.readinessInputs).toHaveLength(0);
    tracker.expectZeroLeaks();
  });

  it.each([
    ["renderer allocation", "renderer-failure"],
    ["persistent interaction cache", "cache-failure"],
    ["all-routes readiness", "readiness-failure"]
  ] as const)("cleans every owner after %s failure", async (_label, mode) => {
    const contexts = createContexts();
    const tracker = new LeakTracker({
      modes: { "opaque-high": mode }
    });
    const dependencies = createDependencies(tracker);
    const attempt = new OpaqueCandidateFactory(dependencies.options)
      .create(contexts.high);

    await expect(attempt.prepare(operationOptions())).rejects.toBeDefined();

    tracker.expectZeroLeaks();
    expect(tracker.maximumWorkersAlive).toBe(1);
    if (mode === "readiness-failure") {
      expect(tracker.readinessDisposals).toBe(1);
    }
  });

  it("rejects a fallible initial-media precommit and releases the final scheduler", async () => {
    const contexts = createContexts();
    const tracker = new LeakTracker({
      modes: { "opaque-high": "activation-failure" }
    });
    const dependencies = createDependencies(tracker);
    const attempt = new OpaqueCandidateFactory(dependencies.options)
      .create(contexts.high);
    await attempt.prepare(operationOptions());

    await expect(attempt.prepareActivation({
      ...operationOptions(),
      graphSnapshot: contexts.high.graphSnapshot,
      expectedPresentation: activationPresentation(contexts.high)
    })).rejects.toThrow("injected activation failure");

    tracker.expectZeroLeaks();
    expect(tracker.readinessDisposals).toBe(1);
    expect(tracker.workerAborts).toBe(0);
  });

  it.each([
    ["configure", "configure-pending", false],
    ["cache", "cache-pending", false],
    ["readiness", "readiness-pending", false],
    ["activation", "activation-pending", true]
  ] as const)(
    "propagates abort during %s and leaves zero live resources",
    async (marker, mode, activation) => {
      const contexts = createContexts();
      const tracker = new LeakTracker({ modes: { "opaque-high": mode } });
      const dependencies = createDependencies(tracker);
      const attempt = new OpaqueCandidateFactory(dependencies.options)
        .create(contexts.high);
      if (activation) await attempt.prepare(operationOptions());
      const controller = new AbortController();
      const operation = activation
        ? attempt.prepareActivation({
            signal: controller.signal,
            deadlineMs: 1_000,
            graphSnapshot: contexts.high.graphSnapshot,
            expectedPresentation: activationPresentation(contexts.high)
          })
        : attempt.prepare({ signal: controller.signal, deadlineMs: 1_000 });
      await waitFor(() => tracker.order.includes(`pending:${marker}`));
      controller.abort(new DOMException("test abort", "AbortError"));

      await expect(operation).rejects.toMatchObject({ name: "AbortError" });
      tracker.expectZeroLeaks();
    }
  );

  it("enforces the absolute deadline while an injected phase is pending", async () => {
    const contexts = createContexts();
    const timers = new ManualTimers();
    const tracker = new LeakTracker({
      modes: { "opaque-high": "cache-pending" }
    });
    const dependencies = createDependencies(tracker, timers);
    const attempt = new OpaqueCandidateFactory(dependencies.options)
      .create(contexts.high);
    const operation = attempt.prepare({
      signal: new AbortController().signal,
      deadlineMs: 25
    });
    await waitFor(() => tracker.order.includes("pending:cache"));
    timers.fireAll();

    await expect(operation).rejects.toMatchObject({ name: "TimeoutError" });
    expect(timers.size).toBe(0);
    tracker.expectZeroLeaks();
  });

  it("cleans a prepared candidate when activation options are invalid", async () => {
    const contexts = createContexts();
    const tracker = new LeakTracker();
    const dependencies = createDependencies(tracker);
    const attempt = new OpaqueCandidateFactory(dependencies.options)
      .create(contexts.high);
    await attempt.prepare(operationOptions());

    await expect(attempt.prepareActivation({
      signal: new AbortController().signal,
      deadlineMs: -1,
      graphSnapshot: contexts.high.graphSnapshot,
      expectedPresentation: activationPresentation(contexts.high)
    })).rejects.toThrow("deadline");

    tracker.expectZeroLeaks();
  });

  it("consumes only its exact activation token and draws once synchronously", async () => {
    const contexts = createContexts();
    const tracker = new LeakTracker();
    const dependencies = createDependencies(tracker);
    const attempt = new OpaqueCandidateFactory(dependencies.options)
      .create(contexts.high);
    await attempt.prepare(operationOptions());
    const expected = activationPresentation(contexts.high);
    const token = await attempt.prepareActivation({
      ...operationOptions(),
      graphSnapshot: contexts.high.graphSnapshot,
      expectedPresentation: expected
    });

    expect(() => attempt.drawInitial(
      Object.freeze({ expectedPresentation: expected }),
      expected
    )).toThrow("not owned");
    expect(() => attempt.drawInitial(token, Object.freeze({
      kind: "body",
      state: "idle",
      unitId: "idle-body",
      frameIndex: 0
    }))).toThrow("identity diverged");
    expect(tracker.initialDraws).toBe(0);

    attempt.drawInitial(token, Object.freeze({ ...expected }));
    expect(tracker.initialDraws).toBe(1);
    expect(() => attempt.drawInitial(token, expected)).toThrow(
      "already consumed"
    );

    await attempt.dispose();
    tracker.expectZeroLeaks();
    expect(tracker.preparedDisposals).toBe(1);
  });

  it("rejects concurrent attempts before a second worker can exist", async () => {
    const contexts = createContexts();
    const tracker = new LeakTracker({
      modes: { "opaque-high": "configure-pending" }
    });
    const dependencies = createDependencies(tracker);
    const factory = new OpaqueCandidateFactory(dependencies.options);
    const high = factory.create(contexts.high);
    const low = factory.create(contexts.low);
    const controller = new AbortController();
    const highPreparation = high.prepare({
      signal: controller.signal,
      deadlineMs: 1_000
    });
    await waitFor(() => tracker.order.includes("pending:configure"));

    await expect(low.prepare(operationOptions())).rejects.toThrow(
      "only one opaque candidate decoder worker"
    );
    expect(tracker.maximumWorkersAlive).toBe(1);
    controller.abort();
    await expect(highPreparation).rejects.toMatchObject({ name: "AbortError" });
    tracker.expectZeroLeaks();
  });
});
