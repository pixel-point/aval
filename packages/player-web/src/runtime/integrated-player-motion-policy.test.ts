import { describe, expect, it } from "vitest";

import {
  Deferred,
  createPreparationHarness as createHarness,
  waitForCall
} from "./integrated-player-preparation-test-support.js";

describe("IntegratedPlayer motion-policy preparation", () => {
  it.each([
    { motionPolicy: "reduce", hostReducedMotion: false },
    { motionPolicy: "auto", hostReducedMotion: true }
  ] as const)(
    "prepares reduced statics without creating animated resources for $motionPolicy",
    async ({ motionPolicy, hostReducedMotion }) => {
      const harness = createHarness({ motionPolicy, hostReducedMotion });

      await expect(harness.player.prepare()).resolves.toMatchObject({
        mode: "static",
        reason: "reduced-motion",
        report: {
          readiness: "staticReady",
          selectedRendition: null,
          candidates: []
        }
      });
      expect(harness.factory.calls).toEqual([]);
      expect(harness.stateStore.calls).toEqual([
        "install:idle",
        "validate-all",
        "present:idle"
      ]);
      expect(harness.player.motionSnapshot()).toMatchObject({
        policy: motionPolicy,
        hostReducedMotion,
        desiredMode: "reduce",
        actualMode: "static",
        staticOrigin: "reduced-motion"
      });
    }
  );

  it("lets explicit full override an injected reduced host signal", async () => {
    const harness = createHarness({
      motionPolicy: "full",
      hostReducedMotion: true
    });

    await expect(harness.player.prepare()).resolves.toMatchObject({
      mode: "animated"
    });
    expect(harness.factory.calls).toContain("create:opaque-high");
    expect(harness.player.motionSnapshot()).toMatchObject({
      policy: "full",
      hostReducedMotion: true,
      desiredMode: "full",
      actualMode: "animated",
      staticOrigin: null
    });
  });

  it("commits the newest logical state before releasing animation", async () => {
    const harness = createHarness();
    await harness.player.prepare();

    await harness.player.setMotionPolicy("reduce");

    expect(harness.stateStore.calls).toContain("present:idle");
    expect(harness.factory.calls.filter((call) =>
      call === "dispose:opaque-high"
    )).toHaveLength(1);
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "staticReady",
      selectedRendition: null,
      requestedState: "idle",
      visualState: "idle"
    });
    expect(harness.player.motionSnapshot()).toMatchObject({
      desiredMode: "reduce",
      actualMode: "static",
      staticOrigin: "reduced-motion"
    });
  });

  it("raises a terminal page-pressure error without mutating host policy", async () => {
    const harness = createHarness({ motionPolicy: "auto" });
    await harness.player.prepare();

    const pressure = harness.player.reclaimForPagePressure();
    await expect(pressure).rejects.toMatchObject({
      name: "RuntimePlaybackError",
      code: "renderer-failure"
    });

    expect(harness.stateStore.calls).not.toContain("present:idle");
    expect(harness.factory.calls.filter((call) =>
      call === "dispose:opaque-high"
    )).toHaveLength(1);
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "error",
      selectedRendition: null,
      requestedState: "idle",
      visualState: "idle"
    });
    expect(harness.player.motionSnapshot()).toMatchObject({
      policy: "auto",
      desiredMode: "full",
      actualMode: "animated",
      staticOrigin: null
    });
  });

  it("still disposes the reduced candidate when trace capture fails", async () => {
    const harness = createHarness();
    await harness.player.prepare();
    harness.factory.failTrace = true;

    await harness.player.setMotionPolicy("reduce");

    expect(harness.factory.calls.filter((call) =>
      call === "dispose:opaque-high"
    )).toHaveLength(1);
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "staticReady",
      selectedRendition: null
    });
    expect(harness.failures).toContainEqual(expect.objectContaining({
      code: "readiness-failure",
      context: { operation: "reduced-motion-trace" }
    }));
  });

  it("restarts an unfinished intro with a fresh full-motion candidate", async () => {
    const harness = createHarness({
      behaviors: [{ kind: "success" }, { kind: "success" }]
    });
    await harness.player.prepare();
    await harness.player.setMotionPolicy("reduce");

    await harness.player.setMotionPolicy("full");

    expect(harness.factory.draws.map((presentation) =>
      [
        presentation.kind,
        presentation.kind === "static" ? null : presentation.frameIndex
      ]
    )).toEqual([["intro", 0], ["intro", 0]]);
    expect(harness.factory.calls.filter((call) =>
      call === "create:opaque-high"
    )).toHaveLength(2);
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "interactiveReady",
      selectedRendition: "opaque-high",
      requestedState: "idle",
      visualState: "idle"
    });
    expect(harness.player.motionSnapshot()).toMatchObject({
      desiredMode: "full",
      actualMode: "animated",
      staticOrigin: null
    });
  });

  it("continues reduced cover and full resume when frame cancellation throws", async () => {
    let requests = 0;
    let cancellationAttempts = 0;
    const harness = createHarness({
      behaviors: [{ kind: "success" }, { kind: "success" }],
      realtime: {
        requestFrame: () => {
          requests += 1;
          return requests;
        },
        cancelFrame: () => {
          cancellationAttempts += 1;
          throw new Error("injected cancellation host failure");
        },
        now: () => 0
      }
    });
    await harness.player.prepare();
    harness.player.startRealtime();

    await harness.player.setMotionPolicy("reduce");

    expect(cancellationAttempts).toBe(1);
    expect(harness.stateStore.currentState()).toBe("idle");
    expect(harness.player.realtimeSnapshot()).toMatchObject({ running: false });
    expect(harness.player.motionSnapshot()).toMatchObject({
      desiredMode: "reduce",
      actualMode: "static",
      staticOrigin: "reduced-motion"
    });
    expect(harness.failures).toContainEqual(expect.objectContaining({
      code: "readiness-failure",
      context: { operation: "motion-policy-realtime-pause" }
    }));

    await harness.player.setMotionPolicy("full");

    expect(requests).toBe(2);
    expect(harness.player.realtimeSnapshot()).toMatchObject({ running: true });
    expect(harness.player.motionSnapshot()).toMatchObject({
      desiredMode: "full",
      actualMode: "animated",
      staticOrigin: null
    });
    await harness.player.dispose();
  });

  it("cancels a pre-commit reduction and reuses the same candidate", async () => {
    const gate = new Deferred<void>();
    const harness = createHarness({
      staticBehavior: { kind: "gate-first-present", gate }
    });
    await harness.player.prepare();
    const reducing = harness.player.setMotionPolicy("reduce");
    await waitForCall(harness.stateStore.calls, "present:idle");
    const restoring = harness.player.setMotionPolicy("full");
    gate.resolve(undefined);

    await reducing;
    await restoring;

    expect(harness.factory.calls.filter((call) =>
      call === "create:opaque-high"
    )).toHaveLength(1);
    expect(harness.factory.calls).not.toContain("dispose:opaque-high");
    expect(harness.player.motionSnapshot()).toMatchObject({
      actualMode: "animated",
      desiredMode: "full"
    });
  });

  it("restages a newer request during hidden reduction before static commit", async () => {
    const gate = new Deferred<void>();
    const harness = createHarness({
      staticBehavior: { kind: "gate-first-present", gate }
    });
    await harness.player.prepare();
    const reducing = harness.player.setMotionPolicy("reduce");
    await waitForCall(harness.stateStore.calls, "present:idle");
    const hover = harness.player.requestState("hover");
    gate.resolve(undefined);

    await reducing;
    await hover;

    expect(harness.stateStore.calls.filter((call) =>
      call.startsWith("present:")
    )).toEqual(["present:idle", "present:hover"]);
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "staticReady",
      requestedState: "hover",
      visualState: "hover",
      isTransitioning: false
    });
  });

  it("terminalizes failed full-motion re-entry and retains its error", async () => {
    const harness = createHarness({
      behaviors: [
        { kind: "success" },
        { kind: "failure", code: "readiness-failure" },
        { kind: "failure", code: "readiness-failure" }
      ]
    });
    await harness.player.prepare();
    await harness.player.setMotionPolicy("reduce");
    const terminal = await harness.player.setMotionPolicy("full").catch(
      (error: unknown) => error
    );
    const createsAfterFailure = harness.factory.calls.filter((call) =>
      call.startsWith("create:")
    ).length;

    await expect(harness.player.setMotionPolicy("reduce")).rejects
      .toBe(terminal);
    await expect(harness.player.setMotionPolicy("full")).rejects
      .toBe(terminal);

    expect(harness.factory.calls.filter((call) =>
      call.startsWith("create:")
    )).toHaveLength(createsAfterFailure);
    expect(harness.player.snapshot().readiness).toBe("error");
    await expect(harness.player.prepare()).rejects.toBe(terminal);
    expect(harness.player.motionSnapshot()).toMatchObject({
      actualMode: "static",
      staticOrigin: "reduced-motion"
    });
  });

  it("terminalizes a failed logical-state reduction", async () => {
    const harness = createHarness({ staticBehavior: "fail-stage" });
    await harness.player.prepare();

    const terminal = harness.player.setMotionPolicy("reduce");
    await expect(terminal).rejects.toMatchObject({
      name: "RuntimePlaybackError",
      code: "renderer-failure"
    });

    expect(harness.player.snapshot()).toMatchObject({
      readiness: "error",
      selectedRendition: null
    });
    expect(harness.player.motionSnapshot()).toMatchObject({
      actualMode: "animated",
      staticOrigin: null
    });
    expect(harness.factory.calls).toContain("dispose:opaque-high");
  });

  it("retires animation without invoking consumer presentation callbacks", async () => {
    const harness = createHarness();
    await harness.player.prepare();

    await harness.player.setMotionPolicy("reduce");

    expect(harness.stateStore.calls).toContain("present:idle");
    expect(harness.factory.calls).toContain("dispose:opaque-high");
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "staticReady",
      selectedRendition: null
    });
    expect(harness.player.motionSnapshot()).toMatchObject({
      actualMode: "static",
      staticOrigin: "reduced-motion"
    });

    await harness.player.dispose();
    expect(harness.factory.calls.filter((call) =>
      call === "dispose:opaque-high"
    )).toHaveLength(1);
  });
});
