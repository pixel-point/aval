import { describe, expect, it } from "vitest";

import {
  Deferred,
  createPreparationHarness as createHarness,
  waitForCall,
  waitForLength
} from "./integrated-player-preparation-test-support.js";

describe("IntegratedPlayer initial motion-policy supersession", () => {
  it("restarts an in-flight full preparation as reduced and settles both callers on static", async () => {
    const staticGate = new Deferred<void>();
    const harness = createHarness({
      behaviors: [{ kind: "pending" }],
      staticBehavior: { kind: "gate-first-present", gate: staticGate }
    });
    const preparing = harness.player.prepare();
    await waitForCall(harness.factory.calls, "prepare:opaque-high");

    let policySettled = false;
    const reducing = harness.player.setMotionPolicy("reduce").finally(() => {
      policySettled = true;
    });
    await waitForCall(harness.stateStore.calls, "present:idle");
    expect(policySettled).toBe(false);
    expect(harness.factory.activeAttempts).toBe(0);

    staticGate.resolve(undefined);

    await expect(preparing).resolves.toMatchObject({
      mode: "static",
      reason: "reduced-motion"
    });
    await expect(reducing).resolves.toMatchObject({
      desiredMode: "reduce",
      actualMode: "static",
      staticOrigin: "reduced-motion"
    });
    expect(harness.factory.draws).toEqual([]);
    expect(harness.factory.calls.filter((call) =>
      call === "dispose:opaque-high"
    )).toHaveLength(1);
  });

  it("uses the same restart transaction for a live auto-policy host signal", async () => {
    const staticGate = new Deferred<void>();
    const harness = createHarness({
      motionPolicy: "auto",
      behaviors: [{ kind: "pending" }],
      staticBehavior: { kind: "gate-first-present", gate: staticGate }
    });
    const preparing = harness.player.prepare();
    await waitForCall(harness.factory.calls, "prepare:opaque-high");

    const reducing = harness.player.setHostReducedMotion(true);
    await waitForCall(harness.stateStore.calls, "present:idle");
    staticGate.resolve(undefined);

    await expect(preparing).resolves.toMatchObject({
      mode: "static",
      reason: "reduced-motion"
    });
    await expect(reducing).resolves.toMatchObject({
      policy: "auto",
      hostReducedMotion: true,
      desiredMode: "reduce",
      actualMode: "static"
    });
    expect(harness.factory.draws).toEqual([]);
  });

  it("restarts an in-flight reduced preparation as full and never commits the stale static mode", async () => {
    const staticGate = new Deferred<void>();
    const candidateGate = new Deferred<void>();
    const harness = createHarness({
      motionPolicy: "reduce",
      staticBehavior: { kind: "gate-first-present", gate: staticGate },
      behaviors: [{ kind: "gated", gate: candidateGate }]
    });
    const preparing = harness.player.prepare();
    await waitForCall(harness.stateStore.calls, "present:idle");

    let policySettled = false;
    const restoring = harness.player.setMotionPolicy("full").finally(() => {
      policySettled = true;
    });
    await waitForCall(harness.factory.calls, "prepare:opaque-high");
    expect(policySettled).toBe(false);

    candidateGate.resolve(undefined);

    await expect(preparing).resolves.toMatchObject({ mode: "animated" });
    await expect(restoring).resolves.toMatchObject({
      desiredMode: "full",
      actualMode: "animated",
      staticOrigin: null
    });
    expect(harness.factory.draws).toHaveLength(1);
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "interactiveReady",
      selectedRendition: "opaque-high"
    });
    staticGate.resolve(undefined);
  });

  it("coalesces full-reduce-full during initial preparation onto one fresh full candidate", async () => {
    const finalGate = new Deferred<void>();
    const harness = createHarness({
      behaviors: [
        { kind: "pending" },
        { kind: "activation-gated", gate: finalGate }
      ]
    });
    const preparing = harness.player.prepare();
    await waitForCall(harness.factory.calls, "prepare:opaque-high");

    let reduceSettled = false;
    let fullSettled = false;
    const reducing = harness.player.setMotionPolicy("reduce").finally(() => {
      reduceSettled = true;
    });
    const restoring = harness.player.setMotionPolicy("full").finally(() => {
      fullSettled = true;
    });
    await waitForLength(harness.factory.activationSnapshots, 1);
    expect(reduceSettled).toBe(false);
    expect(fullSettled).toBe(false);

    finalGate.resolve(undefined);

    await expect(preparing).resolves.toMatchObject({ mode: "animated" });
    await expect(Promise.all([reducing, restoring])).resolves.toEqual([
      expect.objectContaining({ desiredMode: "full", actualMode: "animated" }),
      expect.objectContaining({ desiredMode: "full", actualMode: "animated" })
    ]);
    expect(harness.factory.calls.filter((call) =>
      call === "create:opaque-high"
    )).toHaveLength(2);
    expect(harness.factory.calls.filter((call) =>
      call === "dispose:opaque-high"
    )).toHaveLength(1);
    expect(harness.factory.draws).toHaveLength(1);
  });

  it("coalesces reduce-full-reduce without creating animated resources", async () => {
    const staleGate = new Deferred<void>();
    const harness = createHarness({
      motionPolicy: "reduce",
      staticBehavior: { kind: "gate-first-present", gate: staleGate }
    });
    const preparing = harness.player.prepare();
    await waitForCall(harness.stateStore.calls, "present:idle");

    const restoring = harness.player.setMotionPolicy("full");
    const reducing = harness.player.setMotionPolicy("reduce");

    await expect(preparing).resolves.toMatchObject({
      mode: "static",
      reason: "reduced-motion"
    });
    await expect(Promise.all([restoring, reducing])).resolves.toEqual([
      expect.objectContaining({ desiredMode: "reduce", actualMode: "static" }),
      expect.objectContaining({ desiredMode: "reduce", actualMode: "static" })
    ]);
    expect(harness.factory.calls).toEqual([]);
    expect(harness.stateStore.calls.filter((call) =>
      call === "present:idle"
    )).toHaveLength(2);
    staleGate.resolve(undefined);
  });
});
