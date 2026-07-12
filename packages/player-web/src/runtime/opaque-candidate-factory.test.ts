import { maximumAvcDecodedRgbaBytes } from "@rendered-motion/format";
import { MotionGraphEngine } from "@rendered-motion/graph";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AvcCandidateFactory,
  OpaqueCandidateFactory,
  type AvcCandidateFactoryOptions,
  type AvcCandidateReadinessSession,
  type AvcCandidateRendererReservation
} from "./avc-candidate-factory.js";
import {
  createBrowserAvcCandidateComposition,
  createBrowserOpaqueCandidateComposition
} from "./browser-avc-candidate.js";
import { createIntegratedResumePresentation } from "./integrated-player-support.js";
import { PageResourceManager } from "./page-resource-manager.js";
import { PageDecoderLeases } from "./page-decoder-leases.js";
import { createRuntimePageResourcePolicy } from "./page-resource-policy.js";
import { PlayerResourceAccount } from "./player-resource-account.js";
import { createPlayerCandidateResourceAuthority } from "./player-resource-hosts.js";
import type {
  RuntimeDecoderLease,
  RuntimeDecoderTicket
} from "./model.js";
import type {
  RuntimeCanvasResourceHost,
  RuntimeCanvasResourceLease
} from "./static-resource-plan.js";
import {
  LeakTracker,
  ManualTimers,
  activationPresentation,
  createContexts,
  createDependencies,
  disposeAvcCandidateTestCatalogs,
  operationOptions,
  waitFor
} from "./avc-candidate-factory-test-support.js";

afterEach(() => {
  disposeAvcCandidateTestCatalogs();
});

describe("AvcCandidateFactory", () => {
  it("keeps the deprecated factory name on the same implementation", () => {
    expect(OpaqueCandidateFactory).toBe(AvcCandidateFactory);
    expect(createBrowserOpaqueCandidateComposition).toBe(
      createBrowserAvcCandidateComposition
    );
  });

  it("derives the exact inspected worker configuration and final scheduler", async () => {
    const contexts = createContexts();
    const tracker = new LeakTracker();
    const dependencies = createDependencies(tracker);
    const factory = new AvcCandidateFactory(dependencies.options);
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
        maxDecodedBytes: maximumAvcDecodedRgbaBytes(64, 64) * 12
      }
    }]);
    expect(tracker.cacheInputs).toHaveLength(1);
    expect(tracker.workerActivations).toEqual([1]);
    expect(tracker.order.slice(0, 7)).toEqual([
      "reservation:create:opaque-high",
      "worker:create:opaque-high",
      "worker:configure:opaque-high",
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

  it("accepts a settled static graph snapshot for body-zero re-entry", async () => {
    const contexts = createContexts();
    const graph = new MotionGraphEngine();
    graph.install(contexts.high.catalog.graph);
    graph.beginStatic("reduced-motion");
    const graphSnapshot = graph.snapshot();
    const context = Object.freeze({ ...contexts.high, graphSnapshot });
    const tracker = new LeakTracker();
    const factory = new AvcCandidateFactory(createDependencies(tracker).options);
    const attempt = factory.create(context);
    await attempt.prepare(operationOptions());
    const expectedPresentation = createIntegratedResumePresentation(
      context.catalog.graph,
      graphSnapshot
    );

    await expect(attempt.prepareActivation({
      ...operationOptions(),
      graphSnapshot,
      expectedPresentation
    })).resolves.toMatchObject({ expectedPresentation });

    await attempt.dispose();
  });

  it("fully retires a failed high candidate before creating the low worker", async () => {
    const contexts = createContexts();
    const tracker = new LeakTracker({
      modes: { "opaque-high": "configure-failure" }
    });
    const dependencies = createDependencies(tracker);
    const factory = new AvcCandidateFactory(dependencies.options);

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

  it("admits the plan and decoder before worker construction and releases permission last", async () => {
    const contexts = createContexts();
    const tracker = new LeakTracker();
    const base = createDependencies(tracker).options;
    const manager = new PageResourceManager();
    const decoders = new PageDecoderLeases(manager);
    const account = new PlayerResourceAccount(manager);
    const real = createPlayerCandidateResourceAuthority(account, decoders);
    const events: string[] = [];
    const resourceAuthority = {
      reservePlan(allocation: Parameters<typeof real.reservePlan>[0]) {
        events.push("plan:reserve");
        return real.reservePlan(allocation);
      },
      requestDecoder(): RuntimeDecoderTicket {
        events.push("decoder:request");
        const ticket = real.requestDecoder();
        return Object.freeze({
          snapshot: ticket.snapshot.bind(ticket),
          async wait(): Promise<RuntimeDecoderLease> {
            const lease = await ticket.wait();
            events.push("decoder:granted");
            return Object.freeze({
              snapshot: lease.snapshot.bind(lease),
              release() {
                events.push("decoder:release");
                lease.release();
              }
            }) as unknown as RuntimeDecoderLease;
          },
          cancel: ticket.cancel.bind(ticket)
        }) as unknown as RuntimeDecoderTicket;
      }
    };
    const factory = new AvcCandidateFactory({
      ...base,
      resourceAuthority,
      workerFactory: {
        ...base.workerFactory,
        create(context) {
          events.push("worker:create");
          const worker = base.workerFactory.create(context);
          return new Proxy(worker, {
            get(target, property, receiver) {
              if (property === "dispose") {
                return async () => {
                  events.push("worker:dispose:start");
                  await target.dispose();
                  events.push("worker:dispose:end");
                };
              }
              const value = Reflect.get(target, property, receiver) as unknown;
              return typeof value === "function" ? value.bind(target) : value;
            }
          });
        }
      }
    });
    const attempt = factory.create(contexts.high);

    await attempt.prepare(operationOptions());

    expect(events.slice(0, 4)).toEqual([
      "plan:reserve",
      "decoder:request",
      "decoder:granted",
      "worker:create"
    ]);
    expect(manager.snapshot()).toMatchObject({
      decoderLeaseCount: 1,
      decoderQueueLength: 0
    });
    expect(manager.snapshot().physicalBytes).toBeGreaterThan(0);

    await attempt.dispose();
    expect(events.indexOf("worker:dispose:end"))
      .toBeLessThan(events.indexOf("decoder:release"));
    expect(manager.snapshot()).toMatchObject({
      physicalBytes: 0,
      byteLeaseCount: 0,
      decoderLeaseCount: 0,
      decoderQueueLength: 0
    });
    tracker.expectZeroLeaks();
    account.dispose();
    decoders.dispose();
  });

  it("cancels a queued decoder ticket on abort without constructing a worker", async () => {
    const contexts = createContexts();
    const tracker = new LeakTracker();
    const manager = new PageResourceManager(createRuntimePageResourcePolicy({
      maximumDecoderLeases: 1
    }));
    const decoders = new PageDecoderLeases(manager);
    const blocker = new PlayerResourceAccount(manager);
    const account = new PlayerResourceAccount(manager);
    const blockingLease = await decoders.request(
      blocker.participantId,
      blocker.snapshot().participant!.generation
    ).wait();
    const attempt = new AvcCandidateFactory({
      ...createDependencies(tracker).options,
      resourceAuthority: createPlayerCandidateResourceAuthority(account, decoders)
    }).create(contexts.high);
    const controller = new AbortController();
    const preparation = attempt.prepare({
      signal: controller.signal,
      deadlineMs: 1_000
    });
    await waitFor(() => manager.snapshot().decoderQueueLength === 1);

    expect(tracker.workerAlive).toBe(0);
    expect(tracker.order).not.toContain("worker:create:opaque-high");
    controller.abort(new DOMException("test abort", "AbortError"));
    await expect(preparation).rejects.toMatchObject({ name: "AbortError" });
    expect(manager.snapshot()).toMatchObject({
      decoderLeaseCount: 1,
      decoderQueueLength: 0,
      physicalBytes: 0,
      byteLeaseCount: 0
    });
    tracker.expectZeroLeaks();

    blockingLease.release();
    blocker.dispose();
    account.dispose();
    decoders.dispose();
  });

  it("rolls back a rejected page plan before decoder or worker allocation", async () => {
    const contexts = createContexts();
    const tracker = new LeakTracker();
    const manager = new PageResourceManager(createRuntimePageResourcePolicy({
      maximumPagePhysicalBytes: 1,
      maximumPlayerLogicalBytes: 1
    }));
    const decoders = new PageDecoderLeases(manager);
    const account = new PlayerResourceAccount(manager);
    const attempt = new AvcCandidateFactory({
      ...createDependencies(tracker).options,
      resourceAuthority: createPlayerCandidateResourceAuthority(account, decoders)
    }).create(contexts.high);

    await expect(attempt.prepare(operationOptions())).rejects.toMatchObject({
      code: "resource-rejection"
    });
    expect(tracker.workerAlive).toBe(0);
    expect(manager.snapshot()).toMatchObject({
      physicalBytes: 0,
      byteLeaseCount: 0,
      decoderLeaseCount: 0,
      decoderQueueLength: 0
    });
    tracker.expectZeroLeaks();
    account.dispose();
    decoders.dispose();
  });

  it("rejects an over-budget candidate before allocating textures", async () => {
    const contexts = createContexts(1);
    const tracker = new LeakTracker();
    const dependencies = createDependencies(tracker);
    const attempt = new AvcCandidateFactory(dependencies.options)
      .create(contexts.high);

    await expect(attempt.prepare(operationOptions())).rejects.toMatchObject({
      code: "resource-rejection"
    });

    expect(tracker.configurations).toHaveLength(0);
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
    const attempt = new AvcCandidateFactory(dependencies.options)
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
    const attempt = new AvcCandidateFactory(dependencies.options)
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
      const attempt = new AvcCandidateFactory(dependencies.options)
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
    const attempt = new AvcCandidateFactory(dependencies.options)
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
    const attempt = new AvcCandidateFactory(dependencies.options)
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
    const attempt = new AvcCandidateFactory(dependencies.options)
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
    const factory = new AvcCandidateFactory(dependencies.options);
    const high = factory.create(contexts.high);
    const low = factory.create(contexts.low);
    const controller = new AbortController();
    const highPreparation = high.prepare({
      signal: controller.signal,
      deadlineMs: 1_000
    });
    await waitFor(() => tracker.order.includes("pending:configure"));

    await expect(low.prepare(operationOptions())).rejects.toThrow(
      "only one AVC candidate decoder worker"
    );
    expect(tracker.maximumWorkersAlive).toBe(1);
    controller.abort();
    await expect(highPreparation).rejects.toMatchObject({ name: "AbortError" });
    tracker.expectZeroLeaks();
  });

  it("captures the candidate resource host and a reentrant lease exactly once", async () => {
    const contexts = createContexts();
    const tracker = new LeakTracker();
    const dependencies = createDependencies(tracker);
    let hostReads = 0;
    let backingMethodReads = 0;
    let reserveMethodReads = 0;
    let releaseMethodReads = 0;
    let reserveCalls = 0;
    let releaseCalls = 0;
    let reenterDispose: (() => void) | null = null;
    const rawHost = Object.defineProperties({}, {
      currentCanvasBacking: {
        get() {
          backingMethodReads += 1;
          if (backingMethodReads > 1) {
            throw new Error("injected changing backing getter");
          }
          return () => Object.freeze({ width: 64, height: 64 });
        }
      },
      reserveCanvasResources: {
        get() {
          reserveMethodReads += 1;
          if (reserveMethodReads > 1) {
            throw new Error("injected changing reserve getter");
          }
          return () => {
            reserveCalls += 1;
            return Object.defineProperty({}, "release", {
              get() {
                releaseMethodReads += 1;
                if (releaseMethodReads > 1) {
                  throw new Error("injected changing release getter");
                }
                return () => {
                  releaseCalls += 1;
                  void reenterDispose?.();
                };
              }
            });
          };
        }
      }
    });
    const options = Object.defineProperty(
      { ...dependencies.options },
      "resourceHost",
      {
        enumerable: true,
        get() {
          hostReads += 1;
          if (hostReads > 1) {
            throw new Error("injected changing resource host getter");
          }
          return rawHost;
        }
      }
    ) as Readonly<AvcCandidateFactoryOptions>;

    const factory = new AvcCandidateFactory(options);
    const attempt = factory.create(contexts.high);
    reenterDispose = () => {
      void attempt.dispose();
    };
    await attempt.prepare(operationOptions());
    await attempt.dispose();

    expect({
      hostReads,
      backingMethodReads,
      reserveMethodReads,
      releaseMethodReads,
      reserveCalls,
      releaseCalls
    }).toEqual({
      hostReads: 1,
      backingMethodReads: 1,
      reserveMethodReads: 1,
      releaseMethodReads: 1,
      reserveCalls: 1,
      releaseCalls: 1
    });
    tracker.expectZeroLeaks();
  });

  it.each([
    ["null", (): unknown => null],
    ["missing release", (): unknown => Object.freeze({})],
    ["throwing release getter", (): unknown => Object.defineProperty({}, "release", {
      get() {
        throw new Error("private candidate lease capability failure");
      }
    })]
  ] as const)("rolls back a candidate after a %s canvas lease", async (
    _label,
    createLease
  ) => {
    const contexts = createContexts();
    const tracker = new LeakTracker();
    const reserveCanvasResources = vi.fn(() => createLease());
    const resourceHost = Object.freeze({
      currentCanvasBacking: () => Object.freeze({ width: 64, height: 64 }),
      reserveCanvasResources
    }) as unknown as RuntimeCanvasResourceHost;
    const attempt = new AvcCandidateFactory({
      ...createDependencies(tracker).options,
      resourceHost
    }).create(contexts.high);
    let error: unknown;

    try {
      await attempt.prepare(operationOptions());
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: "resource-rejection" });
    expect(error).not.toHaveProperty(
      "message",
      expect.stringContaining("private candidate lease capability failure")
    );
    expect(reserveCanvasResources).toHaveBeenCalledOnce();
    tracker.expectZeroLeaks();
  });

  it("captures every candidate owner cleanup capability exactly once", async () => {
    const contexts = createContexts();
    const tracker = new LeakTracker();
    const base = createDependencies(tracker).options;
    const reads: Record<string, number> = {};
    const rendererFactory = {
      available: base.rendererFactory.available,
      create(context: Parameters<typeof base.rendererFactory.create>[0]) {
        const reservation = base.rendererFactory.create(context);
        const allocate = reservation.allocate.bind(reservation);
        const guardedReservation = guardMethodReads(
          reservation,
          ["dispose"],
          reads,
          "reservation"
        );
        return {
          limits: reservation.limits,
          allocate(layout: Parameters<AvcCandidateRendererReservation["allocate"]>[0]) {
            return guardMethodReads(
              allocate(layout),
              ["dispose", "settled"],
              reads,
              "renderer"
            );
          },
          get dispose() {
            return guardedReservation.dispose;
          }
        };
      }
    };
    const readinessFactory = {
      create(input: Parameters<typeof base.readinessFactory.create>[0]): AvcCandidateReadinessSession {
        const readiness = base.readinessFactory.create(input);
        const guardedReadiness = guardMethodReads(
          readiness,
          ["dispose"],
          reads,
          "readiness"
        );
        return {
          adapters: readiness.adapters,
          prepareActivation: async (activationInput) => guardMethodReads(
            await readiness.prepareActivation(activationInput),
            ["dispose"],
            reads,
            "prepared"
          ),
          get dispose() {
            return guardedReadiness.dispose;
          }
        };
      }
    };
    const factory = new AvcCandidateFactory({
      ...base,
      workerFactory: {
        available: base.workerFactory.available,
        create: (context) => guardMethodReads(
          base.workerFactory.create(context),
          ["dispose"],
          reads,
          "worker"
        )
      },
      rendererFactory,
      readinessFactory
    });
    const attempt = factory.create(contexts.high);
    await attempt.prepare(operationOptions());
    await attempt.prepareActivation({
      ...operationOptions(),
      graphSnapshot: contexts.high.graphSnapshot,
      expectedPresentation: activationPresentation(contexts.high)
    });

    await attempt.dispose();

    expect(reads).toEqual({
      reservation: 1,
      worker: 1,
      "renderer:dispose": 1,
      "renderer:settled": 1,
      readiness: 1,
      prepared: 1
    });
    tracker.expectZeroLeaks();
  });

  it("continues cleanup after an early disposer throws", async () => {
    const contexts = createContexts();
    const tracker = new LeakTracker();
    const base = createDependencies(tracker).options;
    const release = vi.fn();
    const readinessFactory = {
      create(input: Parameters<typeof base.readinessFactory.create>[0]): AvcCandidateReadinessSession {
        const readiness = base.readinessFactory.create(input);
        return {
          adapters: readiness.adapters,
          async prepareActivation(activationInput) {
            const prepared = await readiness.prepareActivation(activationInput);
            const dispose = prepared.dispose.bind(prepared);
            return {
              playback: prepared.playback,
              drawInitial: prepared.drawInitial.bind(prepared),
              dispose() {
                dispose();
                throw new Error("injected prepared cleanup failure");
              }
            };
          },
          dispose: readiness.dispose.bind(readiness)
        };
      }
    };
    const factory = new AvcCandidateFactory({
      ...base,
      readinessFactory,
      resourceHost: Object.freeze({
        currentCanvasBacking: () => Object.freeze({ width: 64, height: 64 }),
        reserveCanvasResources: () => Object.freeze({ release })
      })
    });
    const high = factory.create(contexts.high);
    await high.prepare(operationOptions());
    await high.prepareActivation({
      ...operationOptions(),
      graphSnapshot: contexts.high.graphSnapshot,
      expectedPresentation: activationPresentation(contexts.high)
    });

    await expect(high.dispose()).rejects.toThrow(
      "injected prepared cleanup failure"
    );
    await expect(high.dispose()).rejects.toThrow(
      "injected prepared cleanup failure"
    );
    expect(release).toHaveBeenCalledOnce();
    tracker.expectZeroLeaks();

    const low = factory.create(contexts.low);
    await low.prepare(operationOptions());
    await low.dispose();
    expect(release).toHaveBeenCalledTimes(2);
    tracker.expectZeroLeaks();
  });

  it.each(["direct", "async-immediate"] as const)(
    "does not self-await a %s reentrant candidate disposer",
    async (mode) => {
      const contexts = createContexts();
      const tracker = new LeakTracker();
      const base = createDependencies(tracker).options;
      let releaseReadiness!: () => void;
      const readinessGate = new Promise<void>((resolve) => {
        releaseReadiness = resolve;
      });
      let attempt!: ReturnType<AvcCandidateFactory["create"]>;
      const readinessFactory = {
        create(input: Parameters<typeof base.readinessFactory.create>[0]): AvcCandidateReadinessSession {
          const readiness = base.readinessFactory.create(input);
          return {
            adapters: readiness.adapters,
            async prepareActivation(activationInput) {
              const prepared = await readiness.prepareActivation(activationInput);
              const disposePrepared = prepared.dispose.bind(prepared);
              return {
                playback: prepared.playback,
                drawInitial: prepared.drawInitial.bind(prepared),
                dispose: mode === "direct"
                  ? () => {
                      disposePrepared();
                      return attempt.dispose();
                    }
                  : async () => {
                      disposePrepared();
                      return attempt.dispose();
                    }
              };
            },
            dispose() {
              readiness.dispose();
              return readinessGate;
            }
          };
        }
      };
      attempt = new AvcCandidateFactory({
        ...base,
        readinessFactory
      }).create(contexts.high);
      await attempt.prepare(operationOptions());
      await attempt.prepareActivation({
        ...operationOptions(),
        graphSnapshot: contexts.high.graphSnapshot,
        expectedPresentation: activationPresentation(contexts.high)
      });
      let settled = false;

      const disposal = Promise.resolve(attempt.dispose()).then(() => {
        settled = true;
      });
      await waitFor(() => tracker.readinessDisposals === 1);

      expect(settled).toBe(false);
      releaseReadiness();
      await disposal;
      expect(settled).toBe(true);
      tracker.expectZeroLeaks();
    }
  );
});

function guardMethodReads<T extends object>(
  target: T,
  methods: readonly string[],
  reads: Record<string, number>,
  label: string
): T {
  return new Proxy(target, {
    get(owner, property) {
      const value = Reflect.get(owner, property, owner) as unknown;
      if (typeof property === "string" && methods.includes(property)) {
        const key = methods.length === 1 ? label : `${label}:${property}`;
        reads[key] = (reads[key] ?? 0) + 1;
        if (reads[key] > 1) {
          throw new Error(`injected changing ${key} getter`);
        }
      }
      return typeof value === "function" ? value.bind(owner) : value;
    }
  });
}
