import type {
  GraphPresentation,
  MotionGraphSnapshot
} from "@rendered-motion/graph";
import { describe, expect, it, vi } from "vitest";

import {
  createIntegratedOpaqueTestAsset,
  createReferenceOnlyTestAsset
} from "./asset-test-fixture.js";
import {
  RuntimePlaybackError,
  normalizeRuntimeFailure,
  type RuntimeFailureCode
} from "./errors.js";
import {
  IntegratedPlayer,
  PlaybackFallbackError,
  type IntegratedCandidateAttempt,
  type IntegratedCandidateAttemptContext,
  type IntegratedCandidateFactory,
  type IntegratedPlaybackSession,
  type IntegratedPlayerSnapshot,
  type IntegratedStaticSurfaceStore,
  type IntegratedTimerHost
} from "./integrated-player.js";

describe("IntegratedPlayer preparation lifecycle", () => {
  it("publishes metadata immediately and joins concurrent prepare calls", async () => {
    const harness = createHarness();
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "metadataReady",
      requestedState: "idle",
      visualState: "idle"
    });

    const first = harness.player.prepare();
    const second = harness.player.prepare();
    expect(second).toBe(first);
    const result = await first;

    expect(result.mode).toBe("animated");
    expect(harness.staticStore.calls).toEqual([
      "install:idle",
      "validate-all",
      "reveal-animated"
    ]);
    expect(harness.factory.maximumActiveAttempts).toBe(1);
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "interactiveReady",
      selectedRendition: "opaque-high"
    });
  });

  it("disposes a failed higher candidate before preparing the lower candidate", async () => {
    const harness = createHarness({
      behaviors: [
        { kind: "failure", code: "unsupported-profile" },
        { kind: "success" }
      ]
    });

    const result = await harness.player.prepare();

    expect(result).toMatchObject({
      mode: "animated",
      report: { selectedRendition: "opaque-low" }
    });
    expect(result.report.candidates.map(({ rendition, outcome }) =>
      [rendition, outcome]
    )).toEqual([
      ["opaque-high", "rejected"],
      ["opaque-low", "selected"]
    ]);
    expect(harness.factory.calls).toEqual([
      "create:opaque-high",
      "prepare:opaque-high",
      "dispose:opaque-high",
      "create:opaque-low",
      "prepare:opaque-low",
      "draw:opaque-low:intro"
    ]);
    expect(harness.events.some(({ type }) => type === "fallback")).toBe(false);
  });

  it.each([
    "resource-rejection",
    "readiness-failure",
    "worker-decode-failure",
    "renderer-failure"
  ] satisfies readonly RuntimeFailureCode[])(
    "tries the lower candidate after a %s failure",
    async (code) => {
      const harness = createHarness({
        behaviors: [
          { kind: "failure", code },
          { kind: "success" }
        ]
      });
      const result = await harness.player.prepare();

      expect(result).toMatchObject({
        mode: "animated",
        report: { selectedRendition: "opaque-low" }
      });
      expect(harness.factory.activeAttempts).toBe(1);
      expect(harness.events.some(({ type }) => type === "fallback")).toBe(false);
    }
  );

  it("resolves an explicit static result when there is no opaque candidate", async () => {
    const harness = createHarness({ bytes: createReferenceOnlyTestAsset() });
    const result = await harness.player.prepare();

    expect(result).toMatchObject({
      mode: "static",
      reason: "no-opaque-rendition",
      report: {
        readiness: "staticReady",
        selectedRendition: null,
        candidates: []
      }
    });
    expect(harness.factory.calls).toEqual([]);
    expect(harness.player.snapshot().readiness).toBe("staticReady");
    expect(harness.events.filter(({ type }) => type === "fallback"))
      .toHaveLength(1);
  });

  it("times out to static only after the complete static check is ready", async () => {
    const timers = new ManualTimers();
    const harness = createHarness({
      behaviors: [{ kind: "pending" }],
      timers
    });
    const preparation = harness.player.prepare({ timeoutMs: 25 });
    await waitForCall(harness.factory.calls, "prepare:opaque-high");
    timers.fireAll();

    await expect(preparation).resolves.toMatchObject({
      mode: "static",
      reason: "preparation-timeout"
    });
    expect(harness.factory.calls).toContain("dispose:opaque-high");
    expect(harness.player.snapshot().readiness).toBe("staticReady");
  });

  it("fails terminally when the deadline expires before static readiness", async () => {
    const timers = new ManualTimers();
    const harness = createHarness({
      staticBehavior: "pending-initial",
      timers
    });
    const preparation = harness.player.prepare({ timeoutMs: 25 });
    await waitForCall(harness.staticStore.calls, "install:idle");
    timers.fireAll();

    await expect(preparation).rejects.toBeInstanceOf(PlaybackFallbackError);
    expect(harness.player.snapshot().readiness).toBe("error");
    expect(harness.factory.calls).toEqual([]);
  });

  it("aborts one attempt cleanly and permits a fresh retry", async () => {
    const controller = new AbortController();
    const harness = createHarness({
      behaviors: [{ kind: "pending" }, { kind: "success" }]
    });
    const first = harness.player.prepare({ signal: controller.signal });
    await waitForCall(harness.factory.calls, "prepare:opaque-high");
    controller.abort(new DOMException("test abort", "AbortError"));

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(harness.factory.calls).toContain("dispose:opaque-high");
    expect(harness.player.snapshot().readiness).toBe("visualReady");

    const retry = await harness.player.prepare();
    expect(retry.mode).toBe("animated");
    expect(harness.factory.calls.filter((call) =>
      call === "create:opaque-high"
    )).toHaveLength(2);
  });

  it("plays the authored intro by default and skips it for a prepared request", async () => {
    const defaultHarness = createHarness();
    await defaultHarness.player.prepare();
    expect(defaultHarness.factory.draws[0]).toMatchObject({
      kind: "intro",
      state: "idle",
      frameIndex: 0
    });

    const requestedHarness = createHarness();
    const request = requestedHarness.player.requestState("hover");
    void request.catch(() => undefined);
    await requestedHarness.player.prepare();
    expect(requestedHarness.factory.draws[0]).toMatchObject({
      kind: "body",
      state: "idle",
      frameIndex: 0
    });
    expect(requestedHarness.player.snapshot()).toMatchObject({
      requestedState: "hover",
      visualState: "idle",
      isTransitioning: true
    });
    await requestedHarness.player.dispose();
  });

  it("coalesces preparation inputs to the latest surviving request", async () => {
    const harness = createHarness();
    const hover = harness.player.requestState("hover");
    const idle = harness.player.requestState("idle");
    void hover.catch(() => undefined);
    await expect(idle).resolves.toBeUndefined();
    await harness.player.prepare();

    expect(harness.player.snapshot()).toMatchObject({
      requestedState: "idle",
      visualState: "idle",
      isTransitioning: false
    });
    expect(harness.factory.draws[0]?.kind).toBe("intro");
    await expect(hover).rejects.toMatchObject({ name: "AbortError" });
  });

  it("stops candidate fallback when failed-attempt cleanup rejects", async () => {
    const harness = createHarness({
      behaviors: [
        {
          kind: "failure",
          code: "readiness-failure",
          cleanupFailure: true
        },
        { kind: "success" }
      ]
    });

    await expect(harness.player.prepare()).resolves.toMatchObject({
      mode: "static",
      reason: "readiness-failed"
    });
    expect(harness.factory.calls.filter((call) => call.startsWith("create:")))
      .toEqual(["create:opaque-high"]);
  });

  it("prepares activation from the latest graph snapshot before commit", async () => {
    const gate = new Deferred<void>();
    const harness = createHarness({ behaviors: [{ kind: "gated", gate }] });
    const preparation = harness.player.prepare();
    await waitForCall(harness.factory.calls, "prepare:opaque-high");
    const hover = harness.player.requestState("hover");
    void hover.catch(() => undefined);
    gate.resolve(undefined);

    await expect(preparation).resolves.toMatchObject({ mode: "animated" });
    expect(harness.factory.activationSnapshots).toHaveLength(1);
    expect(harness.factory.activationSnapshots[0]).toMatchObject({
      readiness: "preparing",
      requestedState: "hover",
      visualState: "idle",
      isTransitioning: true
    });
    expect(harness.factory.draws[0]).toMatchObject({
      kind: "body",
      state: "idle",
      frameIndex: 0
    });
    await harness.player.dispose();
  });

  it("restages activation when input changes while activation media is pending", async () => {
    const gate = new Deferred<void>();
    const harness = createHarness({
      behaviors: [
        { kind: "activation-gated", gate },
        { kind: "success" }
      ]
    });
    const preparation = harness.player.prepare();
    await waitForLength(harness.factory.activationSnapshots, 1);
    const hover = harness.player.requestState("hover");
    void hover.catch(() => undefined);
    gate.resolve(undefined);

    await expect(preparation).resolves.toMatchObject({ mode: "animated" });
    expect(harness.factory.activationSnapshots).toHaveLength(2);
    expect(harness.factory.activationSnapshots[0]).toMatchObject({
      requestedState: "idle",
      inputSequence: 0
    });
    expect(harness.factory.activationSnapshots[1]).toMatchObject({
      requestedState: "hover",
      inputSequence: 1
    });
    expect(harness.factory.calls.filter((call) =>
      call === "create:opaque-high"
    )).toHaveLength(2);
    expect(harness.factory.calls.filter((call) =>
      call === "dispose:opaque-high"
    )).toHaveLength(1);
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "interactiveReady",
      requestedState: "hover",
      visualState: "idle",
      isTransitioning: true
    });
    expect(harness.events.some(({ type }) => type === "fallback")).toBe(false);
    await harness.player.dispose();
  });

  it("does not restage activation for a semantically stable request", async () => {
    const gate = new Deferred<void>();
    const harness = createHarness({
      behaviors: [{ kind: "activation-gated", gate }]
    });
    const preparation = harness.player.prepare();
    await waitForLength(harness.factory.activationSnapshots, 1);
    const idle = harness.player.requestState("idle");
    gate.resolve(undefined);

    await expect(idle).resolves.toBeUndefined();
    await expect(preparation).resolves.toMatchObject({ mode: "animated" });
    expect(harness.factory.activationSnapshots).toHaveLength(1);
    expect(harness.factory.calls.filter((call) =>
      call === "create:opaque-high"
    )).toHaveLength(1);
    expect(harness.factory.calls).not.toContain("dispose:opaque-high");
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "interactiveReady",
      requestedState: "idle",
      visualState: "idle"
    });
    await harness.player.dispose();
  });

  it("retries safely when animated reveal fails before graph activation", async () => {
    const harness = createHarness({
      staticBehavior: "fail-first-reveal",
      behaviors: [{ kind: "success" }, { kind: "success" }]
    });

    await expect(harness.player.prepare()).resolves.toMatchObject({
      mode: "animated",
      report: { selectedRendition: "opaque-low" }
    });
    expect(harness.factory.calls).toContain("dispose:opaque-high");
    expect(harness.staticStore.calls.filter((call) =>
      call === "reveal-animated"
    )).toHaveLength(2);
    expect(harness.player.snapshot().readiness).toBe("interactiveReady");
  });

  it("recovers to static when the activation draw fails after graph commit", async () => {
    const harness = createHarness({
      behaviors: [{ kind: "draw-failure" }]
    });

    await expect(harness.player.prepare()).resolves.toMatchObject({
      mode: "static",
      reason: "animation-failure",
      report: {
        readiness: "staticReady",
        selectedRendition: null
      }
    });
    expect(harness.factory.calls).toEqual(expect.arrayContaining([
      "draw:opaque-high:intro",
      "dispose:opaque-high"
    ]));
    expect(harness.staticStore.calls).toEqual(expect.arrayContaining([
      "present:idle",
      "cover-current"
    ]));
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "staticReady",
      selectedRendition: null,
      visualState: "idle",
      isTransitioning: false
    });
  });

  it("presents the latest request before committing initial static fallback", async () => {
    const gate = new Deferred<void>();
    const harness = createHarness({
      staticBehavior: { kind: "gate-first-present", gate },
      behaviors: [
        { kind: "failure", code: "readiness-failure" },
        { kind: "failure", code: "readiness-failure" }
      ]
    });
    const preparation = harness.player.prepare();
    await waitForCall(harness.staticStore.calls, "present:idle");
    const hover = harness.player.requestState("hover");
    gate.resolve(undefined);

    await expect(preparation).resolves.toMatchObject({ mode: "static" });
    await expect(hover).resolves.toBeUndefined();
    expect(harness.staticStore.calls.filter((call) =>
      call.startsWith("present:")
    )).toEqual(["present:idle", "present:hover"]);
    expect(harness.staticStore.committed).toEqual(["hover"]);
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "staticReady",
      requestedState: "hover",
      visualState: "hover",
      isTransitioning: false
    });
  });

  it("stages selected readiness fields before listener-visible events", async () => {
    const harness = createHarness();
    await harness.player.prepare();
    const interactiveIndex = harness.eventSnapshots.findIndex((snapshot) =>
      snapshot.readiness === "interactiveReady"
    );

    expect(interactiveIndex).toBeGreaterThanOrEqual(0);
    expect(harness.eventSnapshots[interactiveIndex]).toMatchObject({
      readiness: "interactiveReady",
      selectedRendition: "opaque-high",
      preparing: false
    });
  });

  it("rejects a pending animated request while disposing without barrier drift", async () => {
    const harness = createHarness();
    await harness.player.prepare();
    const pending = harness.player.requestState("hover");

    await expect(harness.player.dispose()).resolves.toBeUndefined();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "disposed",
      disposed: true
    });
  });

  it.each([
    {
      availability: { workerAvailable: false, rendererAvailable: true },
      reason: "worker-unavailable"
    },
    {
      availability: { workerAvailable: true, rendererAvailable: false },
      reason: "renderer-unavailable"
    }
  ] as const)("uses exact $reason availability evidence", async ({
    availability,
    reason
  }) => {
    const harness = createHarness({
      availability,
      behaviors: [
        { kind: "failure", code: "readiness-failure" },
        { kind: "failure", code: "readiness-failure" }
      ]
    });

    await expect(harness.player.prepare()).resolves.toMatchObject({
      mode: "static",
      reason
    });
  });

  it("rejects corrupt high AVC before factory creation and selects valid low", async () => {
    const harness = createHarness({
      bytes: createIntegratedOpaqueTestAsset({
        corruptHighIntroDelta: true
      })
    });

    await expect(harness.player.prepare()).resolves.toMatchObject({
      mode: "animated",
      report: {
        selectedRendition: "opaque-low",
        candidates: [
          { rendition: "opaque-high", outcome: "rejected" },
          { rendition: "opaque-low", outcome: "selected" }
        ]
      }
    });
    expect(harness.factory.calls.filter((call) => call.startsWith("create:")))
      .toEqual(["create:opaque-low"]);
  });

  it.each(["throw", "invalid"] as const)(
    "unlinks hostile timer state when setTimeout returns %s",
    async (behavior) => {
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      const clearTimeout = vi.fn();
      const timers: IntegratedTimerHost = {
        setTimeout: () => {
          if (behavior === "throw") throw new Error("hostile timer");
          return -1;
        },
        clearTimeout
      };
      const harness = createHarness({ timers });

      await expect(harness.player.prepare({ signal: controller.signal }))
        .rejects.toThrow();
      expect(remove).toHaveBeenCalled();
      if (behavior === "invalid") expect(clearTimeout).toHaveBeenCalledWith(-1);
    }
  );

  it("does not let hostile timer cleanup replace successful readiness", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const harness = createHarness({
      timers: {
        setTimeout: () => 1,
        clearTimeout: () => {
          throw new Error("hostile timer cleanup");
        }
      }
    });

    await expect(harness.player.prepare({ signal: controller.signal }))
      .resolves.toMatchObject({ mode: "animated" });
    expect(remove).toHaveBeenCalled();
  });

  it("bounds timeout fallback and links it to player disposal", async () => {
    const timers = new ManualTimers();
    const bounded = createHarness({
      staticBehavior: "pending-present",
      behaviors: [{ kind: "pending" }],
      timers
    });
    const boundedPreparation = bounded.player.prepare({ timeoutMs: 25 });
    await waitForCall(bounded.factory.calls, "prepare:opaque-high");
    timers.fireAll();
    await waitForCall(bounded.staticStore.calls, "present:idle");
    timers.fireAll();
    await expect(boundedPreparation).rejects.toMatchObject({
      name: "TimeoutError"
    });

    const disposalTimers = new ManualTimers();
    const disposal = createHarness({
      staticBehavior: "pending-present",
      behaviors: [{ kind: "pending" }],
      timers: disposalTimers
    });
    const disposalPreparation = disposal.player.prepare({ timeoutMs: 25 });
    await waitForCall(disposal.factory.calls, "prepare:opaque-high");
    disposalTimers.fireAll();
    await waitForCall(disposal.staticStore.calls, "present:idle");
    const rejected = expect(disposalPreparation).rejects.toMatchObject({
      name: "AbortError"
    });
    await disposal.player.dispose();
    await rejected;
  });

  it("disposes the active candidate, static store, catalog, and promises once", async () => {
    const harness = createHarness();
    await harness.player.prepare();
    const first = harness.player.dispose();
    const second = harness.player.dispose();
    expect(second).toBe(first);
    await first;

    expect(harness.factory.calls.filter((call) =>
      call === "dispose:opaque-high"
    )).toHaveLength(1);
    expect(harness.staticStore.calls.at(-1)).toBe("dispose");
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "disposed",
      disposed: true
    });
  });
});

type CandidateBehavior =
  | { readonly kind: "success" }
  | { readonly kind: "draw-failure" }
  | {
      readonly kind: "failure";
      readonly code: RuntimeFailureCode;
      readonly cleanupFailure?: boolean;
    }
  | { readonly kind: "gated"; readonly gate: Deferred<void> }
  | { readonly kind: "activation-gated"; readonly gate: Deferred<void> }
  | { readonly kind: "pending" };

interface HarnessOptions {
  readonly bytes?: Uint8Array;
  readonly behaviors?: readonly CandidateBehavior[];
  readonly staticBehavior?: StaticBehavior;
  readonly timers?: IntegratedTimerHost;
  readonly availability?: {
    readonly workerAvailable: boolean;
    readonly rendererAvailable: boolean;
  };
}

function createHarness(options: HarnessOptions = {}) {
  const staticStore = new FakeStaticStore(
    options.staticBehavior ?? "immediate"
  );
  const factory = new FakeCandidateFactory(
    options.behaviors ?? [{ kind: "success" }],
    options.availability
  );
  const events: Array<{ readonly type: string }> = [];
  const eventSnapshots: IntegratedPlayerSnapshot[] = [];
  const timers = options.timers ?? new ManualTimers();
  let player: IntegratedPlayer | null = null;
  player = new IntegratedPlayer({
    bytes: options.bytes ?? createIntegratedOpaqueTestAsset(),
    createStaticStore: () => staticStore,
    candidateFactory: factory,
    eventSink: (event) => {
      events.push(event);
      if (player !== null) eventSnapshots.push(player.snapshot());
    },
    timers
  });
  return { player, staticStore, factory, events, eventSnapshots, timers };
}

type StaticBehavior =
  | "immediate"
  | "pending-initial"
  | "fail-first-reveal"
  | "pending-present"
  | {
      readonly kind: "gate-first-present";
      readonly gate: Deferred<void>;
    };

class FakeStaticStore implements IntegratedStaticSurfaceStore {
  public readonly calls: string[] = [];
  public readonly committed: string[] = [];
  readonly #behavior: StaticBehavior;
  #revealFailed = false;
  #presentations = 0;

  public constructor(behavior: StaticBehavior) {
    this.#behavior = behavior;
  }

  public async installInitial(options: {
    readonly state: string;
    readonly signal: AbortSignal;
  }): Promise<void> {
    this.calls.push(`install:${options.state}`);
    if (this.#behavior === "pending-initial") {
      await abortablePending(options.signal);
    }
  }

  public async validateAll(options: {
    readonly signal: AbortSignal;
  }): Promise<void> {
    this.calls.push("validate-all");
    throwIfAborted(options.signal);
  }

  public async presentState(
    state: string,
    options: { readonly signal: AbortSignal }
  ): Promise<void> {
    this.calls.push(`present:${state}`);
    this.#presentations += 1;
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
  }

  public revealAnimated(): void {
    this.calls.push("reveal-animated");
    if (this.#behavior === "fail-first-reveal" && !this.#revealFailed) {
      this.#revealFailed = true;
      throw new Error("injected reveal failure");
    }
  }

  public coverCurrent(): void {
    this.calls.push("cover-current");
  }

  public async settled(): Promise<void> {}

  public dispose(): void {
    this.calls.push("dispose");
  }
}

class FakeCandidateFactory implements IntegratedCandidateFactory {
  public readonly calls: string[] = [];
  public readonly draws: Readonly<GraphPresentation>[] = [];
  public readonly activationSnapshots: Readonly<MotionGraphSnapshot>[] = [];
  public activeAttempts = 0;
  public maximumActiveAttempts = 0;
  public readonly availability: Readonly<{
    workerAvailable: boolean;
    rendererAvailable: boolean;
  }>;
  readonly #behaviors: CandidateBehavior[];

  public constructor(
    behaviors: readonly CandidateBehavior[],
    availability: HarnessOptions["availability"] = undefined
  ) {
    this.#behaviors = [...behaviors];
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
    return {
      playback: PREPARATION_PLAYBACK,
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
        this.calls.push(`dispose:${rendition}`);
        this.activeAttempts -= 1;
        if (behavior.kind === "failure" && behavior.cleanupFailure === true) {
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

class ManualTimers {
  #next = 1;
  readonly #callbacks = new Map<number, () => void>();

  public readonly setTimeout = (callback: () => void, _ms: number): number => {
    const id = this.#next++;
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

class Deferred<T> {
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

async function waitForCall(calls: readonly string[], expected: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (calls.includes(expected)) return;
    await Promise.resolve();
  }
  throw new Error(`timed out waiting for ${expected}`);
}

async function waitForLength(values: readonly unknown[], length: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (values.length >= length) return;
    await Promise.resolve();
  }
  throw new Error(`timed out waiting for ${String(length)} values`);
}
