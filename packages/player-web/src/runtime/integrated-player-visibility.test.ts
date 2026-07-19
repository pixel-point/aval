import { describe, expect, it } from "vitest";

import { createIntegratedPathTestAsset } from "./asset-test-support.js";
import {
  Deferred,
  ManualTimers,
  createPreparationHarness as createHarness,
  waitForCall,
  waitForLength
} from "./integrated-player-preparation-test-support.js";

describe("IntegratedPlayer visibility lifecycle", () => {
  it("prepares initially hidden with host fallback and no decoder", async () => {
    const harness = createHarness({ initialVisibility: "hidden" });

    await expect(harness.player.prepare()).resolves.toMatchObject({
      mode: "static",
      reason: "visibility-suspended",
      report: { readiness: "staticReady", selectedRendition: null }
    });

    expect(harness.factory.calls).toEqual([]);
    expect(harness.player.visibilitySnapshot()).toMatchObject({
      visibility: "hidden",
      suspension: "suspended",
      frozenPresentationOrdinal: 0n,
      rebuildPending: false
    });
    expect(harness.player.motionSnapshot()).toMatchObject({
      actualMode: "static",
      staticOrigin: "visibility-suspended"
    });

    await harness.player.setVisibility("visible");
    expect(harness.factory.draws).toEqual([
      expect.objectContaining({ kind: "intro", frameIndex: 0 })
    ]);
    expect(harness.factory.activationSnapshots.at(-1)).toMatchObject({
      initialUnitPending: true,
      visualState: "idle"
    });
  });

  it("reuses the initial preparation timeout for a visible rebuild", async () => {
    const timers = new ManualTimers();
    const harness = createHarness({
      initialVisibility: "hidden",
      timers,
      behaviors: [{ kind: "success" }]
    });

    await harness.player.prepare({ timeoutMs: 12_345 });
    timers.delays.length = 0;
    await harness.player.setVisibility("visible");

    expect(timers.delays).toContain(12_345);
    expect(harness.player.snapshot().readiness).toBe("interactiveReady");
  });

  it("restarts an unfinished intro from logical state on show", async () => {
    const harness = createHarness({
      behaviors: [{ kind: "success" }, { kind: "success" }]
    });
    await harness.player.prepare();

    await harness.player.setVisibility("hidden");

    expect(harness.stateStore.calls).toContain("present:idle");
    expect(harness.factory.activeAttempts).toBe(0);
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "staticReady",
      selectedRendition: null,
      visualState: "idle"
    });

    await harness.player.setVisibility("visible");

    expect(harness.factory.draws.map((presentation) => [
      presentation.kind,
      presentation.kind === "static" ? null : presentation.frameIndex
    ])).toEqual([["intro", 0], ["intro", 0]]);
    expect(harness.factory.calls.filter((call) =>
      call === "create:opaque-high"
    )).toHaveLength(2);
    expect(harness.player.visibilitySnapshot()).toMatchObject({
      visibility: "visible",
      suspension: "active",
      frozenPresentationOrdinal: null
    });
  });

  it("switches an in-flight initial decoder attempt to hidden static", async () => {
    const harness = createHarness({ behaviors: [{ kind: "pending" }] });
    const preparing = harness.player.prepare();
    await waitForCall(harness.factory.calls, "prepare:opaque-high");

    await harness.player.setVisibility("hidden");

    await expect(preparing).resolves.toMatchObject({
      mode: "static",
      reason: "visibility-suspended"
    });
    expect(harness.factory.calls.filter((call) =>
      call === "dispose:opaque-high"
    )).toHaveLength(1);
    expect(harness.factory.draws).toEqual([]);
    expect(harness.player.visibilitySnapshot().suspension).toBe("suspended");
  });

  it("restarts an in-flight hidden preparation when visibility becomes active", async () => {
    const gate = new Deferred<void>();
    const harness = createHarness({
      initialVisibility: "hidden",
      staticBehavior: { kind: "gate-initial-install", gate },
      behaviors: [{ kind: "success" }]
    });
    const preparing = harness.player.prepare();
    await waitForCall(harness.stateStore.calls, "install:idle");

    const showing = harness.player.setVisibility("visible");
    gate.resolve(undefined);

    await expect(preparing).resolves.toMatchObject({ mode: "animated" });
    await showing;
    expect(harness.player.visibilitySnapshot()).toMatchObject({
      visibility: "visible",
      suspension: "active"
    });
  });

  it.each([
    ["static install", "gate-initial-install"],
    ["host fallback validation", "gate-first-validation"]
  ] as const)("switches in-flight %s to the hidden generation", async (
    _label,
    kind
  ) => {
    const gate = new Deferred<void>();
    const harness = createHarness({
      staticBehavior: { kind, gate }
    });
    const preparing = harness.player.prepare();
    await waitForCall(
      harness.stateStore.calls,
      kind === "gate-initial-install" ? "install:idle" : "validate-all"
    );

    const hiding = harness.player.setVisibility("hidden");
    gate.resolve(undefined);

    await expect(preparing).resolves.toMatchObject({
      mode: "static",
      reason: "visibility-suspended"
    });
    await hiding;
    expect(harness.factory.calls).toEqual([]);
    expect(harness.player.visibilitySnapshot().suspension).toBe("suspended");
  });

  it("invalidates an activation-gated candidate before its first draw", async () => {
    const gate = new Deferred<void>();
    const harness = createHarness({
      behaviors: [{ kind: "activation-gated", gate }]
    });
    const preparing = harness.player.prepare();
    await waitForLength(harness.factory.activationSnapshots, 1);

    const hiding = harness.player.setVisibility("hidden");
    gate.resolve(undefined);

    await expect(preparing).resolves.toMatchObject({
      mode: "static",
      reason: "visibility-suspended"
    });
    await hiding;
    expect(harness.factory.draws).toEqual([]);
    expect(harness.factory.activeAttempts).toBe(0);
  });

  it("uses the newest hidden state when rebuilding and never replays intro", async () => {
    const harness = createHarness({
      behaviors: [{ kind: "success" }, { kind: "success" }]
    });
    await harness.player.prepare();
    await harness.player.setVisibility("hidden");
    const presentCallsBeforeRequests = harness.stateStore.calls.length;

    await Promise.all([
      harness.player.requestState("hover"),
      harness.player.requestState("idle"),
      harness.player.requestState("hover")
    ]);
    await harness.player.setVisibility("visible");

    expect(harness.stateStore.calls.slice(presentCallsBeforeRequests).filter(
      (call) => call.startsWith("present:")
    )).toEqual(["present:hover"]);
    const draw = harness.factory.draws.at(-1);
    expect(draw).toMatchObject({ kind: "body", state: "hover", frameIndex: 0 });
    expect(harness.factory.activationSnapshots.at(-1)).toMatchObject({
      initialUnitPending: false,
      visualState: "hover"
    });
    expect(harness.player.snapshot()).toMatchObject({
      requestedState: "hover",
      visualState: "hover",
      readiness: "interactiveReady"
    });
  });

  it("serializes show behind an active hidden static request", async () => {
    const gate = new Deferred<void>();
    const harness = createHarness({
      behaviors: [{ kind: "success" }, { kind: "success" }]
    });
    await harness.player.prepare();
    await harness.player.setVisibility("hidden");
    harness.stateStore.gateNextPresent(gate);

    const request = harness.player.requestState("hover");
    await waitForCall(harness.stateStore.calls, "present:hover");
    const showing = harness.player.setVisibility("visible");
    await Promise.resolve();
    expect(harness.factory.activeAttempts).toBe(0);

    gate.resolve(undefined);
    await Promise.all([request, showing]);
    expect(harness.factory.draws.at(-1)).toMatchObject({
      kind: "body",
      state: "hover",
      frameIndex: 0
    });
  });

  it("coalesces a pre-cover hide/show without replacing the candidate", async () => {
    const harness = createHarness();
    await harness.player.prepare();

    const hiding = harness.player.setVisibility("hidden");
    const showing = harness.player.setVisibility("visible");
    await Promise.all([hiding, showing]);

    expect(harness.factory.calls.filter((call) =>
      call === "create:opaque-high"
    )).toHaveLength(1);
    expect(harness.factory.activeAttempts).toBe(1);
    expect(harness.player.visibilitySnapshot()).toMatchObject({
      visibility: "visible",
      suspension: "active",
      rebuildPending: false
    });
  });

  it("accepts only the newest resume generation during rapid toggles", async () => {
    const staleGate = new Deferred<void>();
    const harness = createHarness({
      behaviors: [
        { kind: "success" },
        { kind: "gated", gate: staleGate },
        { kind: "success" }
      ]
    });
    await harness.player.prepare();
    await harness.player.setVisibility("hidden");

    const staleShow = harness.player.setVisibility("visible");
    await waitForCall(harness.factory.calls, "prepare:opaque-high");
    const hiding = harness.player.setVisibility("hidden");
    const latestShow = harness.player.setVisibility("visible");
    staleGate.resolve(undefined);
    await Promise.all([staleShow, hiding, latestShow]);

    expect(harness.factory.maximumActiveAttempts).toBe(1);
    expect(harness.factory.activeAttempts).toBe(1);
    expect(harness.factory.draws.map((presentation) => presentation.kind))
      .toEqual(["intro", "intro"]);
    expect(harness.player.visibilitySnapshot()).toMatchObject({
      visibility: "visible",
      suspension: "active"
    });
  });

  it("keeps reduced mode decoder-free across hide/show, then re-enters full", async () => {
    const harness = createHarness({
      motionPolicy: "reduce",
      behaviors: [{ kind: "success" }]
    });
    await harness.player.prepare();

    await harness.player.setVisibility("hidden");
    await harness.player.setVisibility("visible");

    expect(harness.factory.calls).toEqual([]);
    expect(harness.player.motionSnapshot()).toMatchObject({
      desiredMode: "reduce",
      actualMode: "static"
    });

    await harness.player.setMotionPolicy("full");
    expect(harness.factory.draws.at(-1)).toMatchObject({
      kind: "intro",
      frameIndex: 0
    });
  });

  it.each([
    ["loop", "hover"],
    ["finite", "loading"],
    ["locked-transition", "archive"]
  ] as const)("resumes %s state from canonical body zero", async (
    _kind,
    target
  ) => {
    const harness = createHarness({
      bytes: createIntegratedPathTestAsset(),
      behaviors: [{ kind: "success" }, { kind: "success" }]
    });
    await harness.player.prepare();
    const request = harness.player.requestState(target);

    await harness.player.setVisibility("hidden");
    await request;
    await harness.player.setVisibility("visible");

    expect(harness.factory.draws.at(-1)).toMatchObject({
      kind: "body",
      state: target,
      frameIndex: 0
    });
  });

  it("drops hidden wall time while retaining the next rational ordinal", async () => {
    const frames = new ManualFrames();
    let now = 0;
    const harness = createHarness({
      behaviors: [{ kind: "success" }, { kind: "success" }],
      realtime: {
        requestFrame: frames.request,
        cancelFrame: frames.cancel,
        now: () => now
      }
    });
    await harness.player.prepare();
    harness.player.startRealtime();
    const frozen = harness.player.realtimeSnapshot()?.nextPresentationOrdinal;

    await harness.player.setVisibility("hidden");
    now = 60_000;
    await harness.player.setVisibility("visible");

    expect(harness.player.realtimeSnapshot()).toMatchObject({
      running: true,
      nextPresentationOrdinal: frozen,
      nextDeadlineMs: 60_033.333
    });
  });

  it("terminalizes a failed visible rebuild without retrying", async () => {
    const harness = createHarness({
      behaviors: [
        { kind: "success" },
        { kind: "failure", code: "readiness-failure" },
        { kind: "failure", code: "readiness-failure" }
      ]
    });
    await harness.player.prepare();
    await harness.player.setVisibility("hidden");

    const terminal = await harness.player.setVisibility("visible").catch(
      (error: unknown) => error
    );
    await expect(harness.player.settled()).rejects.toBe(terminal);

    expect(harness.player.visibilitySnapshot()).toMatchObject({
      visibility: "visible",
      suspension: "suspended",
      rebuildPending: false
    });
    expect(harness.player.snapshot().readiness).toBe("error");
    const creates = harness.factory.calls.filter((call) =>
      call === "create:opaque-high"
    ).length;
    await expect(harness.player.setVisibility("visible")).rejects
      .toBe(terminal);
    expect(harness.factory.calls.filter((call) =>
      call === "create:opaque-high"
    )).toHaveLength(creates);
  });

  it("invalidates a gated rebuild during disposal without leaking its attempt", async () => {
    const gate = new Deferred<void>();
    const harness = createHarness({
      behaviors: [
        { kind: "success" },
        { kind: "gated", gate }
      ]
    });
    await harness.player.prepare();
    await harness.player.setVisibility("hidden");
    const showing = harness.player.setVisibility("visible");
    await waitForCall(harness.factory.calls, "prepare:opaque-high");

    const disposal = harness.player.dispose();
    gate.resolve(undefined);
    await Promise.all([showing, disposal]);

    expect(harness.factory.activeAttempts).toBe(0);
    expect(harness.player.snapshot().disposed).toBe(true);
  });
});

class ManualFrames {
  #next = 1;
  #pending: { readonly id: number; readonly callback: FrameRequestCallback } | null = null;

  public readonly request = (callback: FrameRequestCallback): number => {
    if (this.#pending !== null) throw new Error("frame already pending");
    const id = this.#next;
    this.#next += 1;
    this.#pending = { id, callback };
    return id;
  };

  public readonly cancel = (id: number): void => {
    if (this.#pending?.id === id) this.#pending = null;
  };
}
