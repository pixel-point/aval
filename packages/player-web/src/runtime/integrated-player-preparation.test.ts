import { describe, expect, it, vi } from "vitest";

import {
  createIntegratedTestAsset
} from "./asset-test-support.js";
import {
  RuntimePlaybackError,
  type RuntimeFailureCode
} from "./errors.js";
import type { IntegratedTimerHost } from "./integrated-player.js";
import {
  Deferred,
  ManualTimers,
  createPreparationHarness as createHarness,
  waitForCall,
  waitForLength
} from "./integrated-player-preparation-test-support.js";

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
    expect(harness.stateStore.calls).toEqual([
      "install:idle",
      "validate-all"
    ]);
    expect(harness.factory.maximumActiveAttempts).toBe(1);
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "interactiveReady",
      selectedRendition: "opaque-high"
    });
  });

  it("terminalizes and retains one error after the selected candidate fails", async () => {
    const harness = createHarness({
      behaviors: [
        { kind: "failure", code: "unsupported-profile" }
      ]
    });

    const terminal = await rejectedRuntimeError(harness.player.prepare());

    expect(terminal.code).toBe("unsupported-profile");
    await expect(harness.player.prepare()).rejects.toBe(terminal);
    await expect(harness.player.settled()).rejects.toBe(terminal);
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "error",
      selectedRendition: null
    });
    expect(harness.factory.calls).toEqual([
      "create:opaque-high",
      "prepare:opaque-high",
      "dispose:opaque-high"
    ]);
    expect(harness.events.some(({ type }) => String(type) === "fallback"))
      .toBe(false);
  });

  it("activates only the exact rendition selected before construction", async () => {
    const harness = createHarness({ selectedRenditionIndex: 1 });

    await expect(harness.player.prepare()).resolves.toMatchObject({
      mode: "animated",
      report: { selectedRendition: "opaque-low" }
    });
    expect(harness.factory.calls).toContain("create:opaque-low");
    expect(harness.factory.calls).not.toContain("create:opaque-high");
  });

  it.each([
    "resource-rejection",
    "readiness-failure",
    "worker-decode-failure",
    "renderer-failure"
  ] satisfies readonly RuntimeFailureCode[])(
    "does not try a lower candidate after a %s failure",
    async (code) => {
      const harness = createHarness({
        behaviors: [
          { kind: "failure", code },
          { kind: "success" }
        ]
      });
      const terminal = await rejectedRuntimeError(harness.player.prepare());

      expect(terminal.code).toBe(code);
      expect(harness.player.snapshot().readiness).toBe("error");
      expect(harness.factory.activeAttempts).toBe(0);
      expect(harness.factory.calls).not.toContain("create:opaque-low");
      expect(harness.events.some(({ type }) => String(type) === "fallback"))
        .toBe(false);
    }
  );

  it("terminalizes when animated preparation exceeds its deadline", async () => {
    const timers = new ManualTimers();
    const harness = createHarness({
      behaviors: [{ kind: "pending" }],
      timers
    });
    const preparation = harness.player.prepare({ timeoutMs: 25 });
    await waitForCall(harness.factory.calls, "prepare:opaque-high");
    timers.fireAll();

    await expect(preparation).rejects.toMatchObject({
      name: "RuntimePlaybackError",
      code: "readiness-failure",
      failure: {
        context: { operation: "animation-preparation-timeout" }
      }
    });
    expect(harness.factory.calls).toContain("dispose:opaque-high");
    expect(harness.player.snapshot().readiness).toBe("error");
  });

  it("fails terminally when the deadline expires before static readiness", async () => {
    const timers = new ManualTimers();
    const harness = createHarness({
      staticBehavior: "pending-initial",
      timers
    });
    const preparation = harness.player.prepare({ timeoutMs: 25 });
    await waitForCall(harness.stateStore.calls, "install:idle");
    timers.fireAll();

    await expect(preparation).rejects.toBeInstanceOf(RuntimePlaybackError);
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

  it("plays the authored intro before a prepared request", async () => {
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
      kind: "intro",
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

    await expect(harness.player.prepare()).rejects
      .toBeInstanceOf(RuntimePlaybackError);
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
      kind: "intro",
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
    expect(harness.events.some(({ type }) => String(type) === "fallback"))
      .toBe(false);
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

  it("activates without invoking consumer presentation callbacks", async () => {
    const harness = createHarness({ behaviors: [{ kind: "success" }] });

    await expect(harness.player.prepare()).resolves.toMatchObject({
      mode: "animated",
      report: { selectedRendition: "opaque-high" }
    });
    expect(harness.stateStore.calls).toEqual([
      "install:idle",
      "validate-all"
    ]);
    expect(harness.factory.calls).not.toContain("dispose:opaque-high");
    expect(harness.player.snapshot().readiness).toBe("interactiveReady");
  });

  it("rejects the same terminal error when activation draw fails", async () => {
    const harness = createHarness({
      behaviors: [{ kind: "draw-failure" }]
    });

    const terminal = await rejectedRuntimeError(harness.player.prepare());
    expect(terminal.code).toBe("readiness-failure");
    await expect(harness.player.settled()).rejects.toBe(terminal);
    await expect(harness.player.prepare()).rejects.toBe(terminal);
    expect(harness.factory.calls).toEqual(expect.arrayContaining([
      "draw:opaque-high:intro",
      "dispose:opaque-high"
    ]));
    expect(harness.stateStore.calls).not.toContain("present:idle");
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "error",
      selectedRendition: null,
      visualState: "idle",
      isTransitioning: false
    });
  });

  it("rejects a pending request without staging alternate UI", async () => {
    const harness = createHarness({
      behaviors: [
        { kind: "failure", code: "readiness-failure" }
      ]
    });
    const hover = harness.player.requestState("hover");
    const hoverOutcome = hover.catch((error: unknown) => error);
    const terminal = await rejectedRuntimeError(harness.player.prepare());

    expect(await hoverOutcome).toBe(terminal);
    expect(harness.stateStore.calls.filter((call) =>
      call.startsWith("present:")
    )).toEqual([]);
    expect(harness.stateStore.committed).toEqual([]);
    await expect(harness.player.prepare()).rejects.toBe(terminal);
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "error",
      requestedState: "hover",
      visualState: "idle",
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
  ] as const)("terminalizes for unavailable $reason capability", async ({
    availability
  }) => {
    const harness = createHarness({
      availability,
      behaviors: [
        { kind: "failure", code: "readiness-failure" },
        { kind: "failure", code: "readiness-failure" }
      ]
    });

    await expect(harness.player.prepare()).rejects
      .toBeInstanceOf(RuntimePlaybackError);
    expect(harness.player.snapshot().readiness).toBe("error");
  });

  it("rejects corrupt preferred H.264 without inspecting a lower rendition", async () => {
    const harness = createHarness({
      bytes: createIntegratedTestAsset({
        corruptHighIntroDelta: true
      })
    });

    await expect(harness.player.prepare()).rejects.toMatchObject({
      name: "RuntimePlaybackError",
      code: "readiness-failure"
    });
    expect(harness.player.snapshot().readiness).toBe("error");
    expect(harness.factory.calls.filter((call) => call.startsWith("create:")))
      .toEqual([]);
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

  it("bounds terminal timeout cleanup and links it to player disposal", async () => {
    const timers = new ManualTimers();
    const bounded = createHarness({
      behaviors: [{ kind: "pending" }],
      timers
    });
    const boundedPreparation = bounded.player.prepare({ timeoutMs: 25 });
    await waitForCall(bounded.factory.calls, "prepare:opaque-high");
    timers.fireAll();
    await expect(boundedPreparation).rejects.toMatchObject({
      name: "RuntimePlaybackError",
      code: "readiness-failure"
    });
    expect(bounded.stateStore.calls).not.toContain("present:idle");

    const disposalTimers = new ManualTimers();
    const disposal = createHarness({
      behaviors: [{ kind: "pending" }],
      timers: disposalTimers
    });
    const disposalPreparation = disposal.player.prepare({ timeoutMs: 25 });
    await waitForCall(disposal.factory.calls, "prepare:opaque-high");
    disposalTimers.fireAll();
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
    expect(harness.stateStore.calls.at(-1)).toBe("dispose");
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "disposed",
      disposed: true
    });
  });
});

async function rejectedRuntimeError(
  promise: Promise<unknown>
): Promise<RuntimePlaybackError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimePlaybackError);
    return error as RuntimePlaybackError;
  }
  throw new Error("expected RuntimePlaybackError rejection");
}
