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
      expect(harness.staticStore.calls).toEqual([
        "install:idle",
        "validate-all",
        "present:idle"
      ]);
      expect(harness.player.motionSnapshot()).toMatchObject({
        policy: motionPolicy,
        hostReducedMotion,
        desiredMode: "reduce",
        actualMode: "static",
        staticOrigin: "reduced-motion",
        stickyFailure: false
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

  it("covers the newest strict static before releasing an animated candidate", async () => {
    const harness = createHarness();
    await harness.player.prepare();

    await harness.player.setMotionPolicy("reduce");

    expect(harness.staticStore.calls).toEqual(expect.arrayContaining([
      "stage:idle",
      "cover-current"
    ]));
    expect(harness.staticStore.calls.filter((call) => call === "cover-current"))
      .toHaveLength(1);
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
      staticOrigin: "reduced-motion",
      stickyFailure: false
    });
  });

  it("falls back for page pressure without mutating the host motion policy", async () => {
    const harness = createHarness({ motionPolicy: "auto" });
    await harness.player.prepare();

    await expect(harness.player.reclaimForPagePressure()).resolves.toBe(true);

    expect(harness.staticStore.calls).toEqual(expect.arrayContaining([
      "stage:idle",
      "cover-current"
    ]));
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
      policy: "auto",
      desiredMode: "full",
      actualMode: "static",
      staticOrigin: "resource-budget",
      stickyFailure: true
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

  it("re-enters with a fresh body-zero candidate and never replays intro", async () => {
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
    )).toEqual([["intro", 0], ["body", 0]]);
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
      staticOrigin: null,
      stickyFailure: false
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
    expect(harness.staticStore.calls).toContain("cover-current");
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

  it("cancels a pre-cover reduction and reuses the same candidate", async () => {
    const gate = new Deferred<void>();
    const harness = createHarness({
      staticBehavior: { kind: "gate-first-present", gate }
    });
    await harness.player.prepare();
    const reducing = harness.player.setMotionPolicy("reduce");
    await waitForCall(harness.staticStore.calls, "stage:idle");
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
    await waitForCall(harness.staticStore.calls, "stage:idle");
    const hover = harness.player.requestState("hover");
    gate.resolve(undefined);

    await reducing;
    await hover;

    expect(harness.staticStore.calls.filter((call) =>
      call.startsWith("stage:")
    )).toEqual(["stage:idle", "stage:hover"]);
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "staticReady",
      requestedState: "hover",
      visualState: "hover",
      isTransitioning: false
    });
  });

  it("keeps failed re-entry static and sticky across later policy flips", async () => {
    const harness = createHarness({
      behaviors: [
        { kind: "success" },
        { kind: "failure", code: "readiness-failure" },
        { kind: "failure", code: "readiness-failure" }
      ]
    });
    await harness.player.prepare();
    await harness.player.setMotionPolicy("reduce");
    await harness.player.setMotionPolicy("full");
    const createsAfterFailure = harness.factory.calls.filter((call) =>
      call.startsWith("create:")
    ).length;

    await harness.player.setMotionPolicy("reduce");
    await harness.player.setMotionPolicy("full");

    expect(harness.factory.calls.filter((call) =>
      call.startsWith("create:")
    )).toHaveLength(createsAfterFailure);
    expect(harness.player.snapshot().readiness).toBe("staticReady");
    await expect(harness.player.prepare()).resolves.toMatchObject({
      mode: "static",
      reason: "readiness-failed",
      report: {
        selectedRendition: null,
        candidates: [
          { rendition: "opaque-high", outcome: "rejected" },
          { rendition: "opaque-low", outcome: "rejected" }
        ]
      }
    });
    expect(harness.player.motionSnapshot()).toMatchObject({
      actualMode: "static",
      staticOrigin: "readiness-failed",
      stickyFailure: true
    });
  });

  it("terminalizes a failed reduction surface with sticky PNG origin", async () => {
    const harness = createHarness({ staticBehavior: "fail-stage" });
    await harness.player.prepare();

    await harness.player.setMotionPolicy("reduce");

    expect(harness.player.snapshot()).toMatchObject({
      readiness: "staticReady",
      selectedRendition: null
    });
    expect(harness.player.motionSnapshot()).toMatchObject({
      actualMode: "static",
      staticOrigin: "png-failure",
      stickyFailure: true
    });
    expect(harness.factory.calls).toContain("dispose:opaque-high");
  });

  it("retains the last animated candidate when failed reduction cannot cover", async () => {
    const harness = createHarness({ staticBehavior: "fail-stage-and-cover" });
    await harness.player.prepare();

    await harness.player.setMotionPolicy("reduce");

    expect(harness.staticStore.calls.filter((call) => call === "cover-current"))
      .toHaveLength(1);
    expect(harness.factory.calls).not.toContain("dispose:opaque-high");
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "error",
      selectedRendition: null
    });
    expect(harness.player.motionSnapshot()).toMatchObject({
      actualMode: "static",
      staticOrigin: "png-failure",
      stickyFailure: true
    });

    await harness.player.dispose();
    expect(harness.factory.calls.filter((call) =>
      call === "dispose:opaque-high"
    )).toHaveLength(1);
  });
});
