import { describe, expect, it } from "vitest";

import {
  MotionPolicyCoordinator,
  type MotionPolicyTransition
} from "./motion-policy.js";

describe("MotionPolicyCoordinator", () => {
  it("derives auto, reduce, and full from one policy truth table", () => {
    const coordinator = new MotionPolicyCoordinator();

    expect(coordinator.snapshot()).toMatchObject({
      policy: "auto",
      hostReducedMotion: false,
      desiredMode: "full",
      actualMode: "unprepared",
      generation: 0,
      transition: null,
      staticOrigin: null,
      stickyFailure: false,
      disposed: false
    });

    coordinator.setHostReducedMotion(true);
    expect(coordinator.snapshot()).toMatchObject({
      desiredMode: "reduce",
      generation: 1
    });
    coordinator.setPolicy("full");
    expect(coordinator.snapshot()).toMatchObject({
      desiredMode: "full",
      generation: 2
    });
    coordinator.setPolicy("reduce");
    expect(coordinator.snapshot()).toMatchObject({
      desiredMode: "reduce",
      generation: 3
    });
    coordinator.setHostReducedMotion(false);
    expect(coordinator.snapshot()).toMatchObject({
      desiredMode: "reduce",
      generation: 4
    });

    coordinator.setHostReducedMotion(false);
    coordinator.setPolicy("reduce");
    expect(coordinator.snapshot().generation).toBe(4);
  });

  it("prepares reduced without an animated transition and re-enters full", () => {
    const coordinator = new MotionPolicyCoordinator({ policy: "reduce" });
    expect(coordinator.nextTransition()).toBeNull();

    coordinator.installStatic("reduced-motion");
    expect(coordinator.snapshot()).toMatchObject({
      actualMode: "static",
      staticOrigin: "reduced-motion",
      stickyFailure: false
    });

    coordinator.setPolicy("full");
    const transition = requireTransition(coordinator.nextTransition());
    expect(transition).toMatchObject({
      kind: "enter-full",
      generation: coordinator.snapshot().generation
    });
    expect(coordinator.nextTransition()).toBe(transition);
    expect(coordinator.commitAnimated(transition)).toBe(true);
    expect(coordinator.snapshot()).toMatchObject({
      actualMode: "animated",
      staticOrigin: null,
      transition: null,
      stickyFailure: false
    });
  });

  it("cancels reduced entry before commit and keeps the animated owner", () => {
    const coordinator = new MotionPolicyCoordinator();
    coordinator.installAnimated();
    coordinator.setPolicy("reduce");
    const transition = requireTransition(coordinator.nextTransition());
    expect(transition.kind).toBe("enter-reduced");
    expect(transition.signal.aborted).toBe(false);

    coordinator.setPolicy("full");
    expect(transition.signal.aborted).toBe(true);
    expect(coordinator.commitStatic(transition)).toBe(false);
    expect(coordinator.nextTransition()).toBeNull();
    expect(coordinator.snapshot()).toMatchObject({
      actualMode: "animated",
      staticOrigin: null,
      transition: null
    });
  });

  it("commits reduced coverage before retiring animation and then resumes", () => {
    const coordinator = new MotionPolicyCoordinator();
    coordinator.installAnimated();
    coordinator.setHostReducedMotion(true);
    const reduce = requireTransition(coordinator.nextTransition());
    expect(reduce.kind).toBe("enter-reduced");
    expect(coordinator.commitStatic(reduce)).toBe(true);
    expect(coordinator.snapshot()).toMatchObject({
      desiredMode: "reduce",
      actualMode: "static",
      staticOrigin: "reduced-motion"
    });

    coordinator.setHostReducedMotion(false);
    const full = requireTransition(coordinator.nextTransition());
    expect(full.kind).toBe("enter-full");
    expect(coordinator.commitAnimated(full)).toBe(true);
    expect(coordinator.snapshot().actualMode).toBe("animated");
  });

  it("keeps codec, resource, readiness, animation, and PNG failures sticky", () => {
    for (const origin of [
      "no-avc-rendition",
      "codec-unsupported",
      "resource-budget",
      "readiness-failed",
      "animation-failure",
      "png-failure"
    ] as const) {
      const coordinator = new MotionPolicyCoordinator({ policy: "full" });
      coordinator.installStatic(origin);
      expect(coordinator.snapshot()).toMatchObject({
        actualMode: "static",
        staticOrigin: origin,
        stickyFailure: true
      });
      expect(coordinator.nextTransition()).toBeNull();
      coordinator.setPolicy("reduce");
      coordinator.setPolicy("full");
      expect(coordinator.nextTransition()).toBeNull();
    }
  });

  it.each(["visibility-suspended", "decoder-queued"] as const)(
    "re-enters full motion from transient %s static mode",
    (origin) => {
      const coordinator = new MotionPolicyCoordinator({ policy: "full" });
      coordinator.installStatic(origin);
      expect(coordinator.snapshot().stickyFailure).toBe(false);
      const transition = requireTransition(coordinator.nextTransition());
      expect(transition.kind).toBe("enter-full");
      expect(coordinator.commitAnimated(transition)).toBe(true);
      expect(coordinator.snapshot()).toMatchObject({
        actualMode: "animated",
        staticOrigin: null,
        stickyFailure: false
      });
    }
  );

  it("treats a context-loss interruption as reenterable until recovery fails", () => {
    const coordinator = new MotionPolicyCoordinator({ policy: "full" });
    coordinator.installAnimated();
    coordinator.failToStatic("context-loss");
    const transition = requireTransition(coordinator.nextTransition());
    expect(coordinator.snapshot()).toMatchObject({
      staticOrigin: "context-loss",
      stickyFailure: false
    });
    expect(coordinator.commitAnimated(transition)).toBe(true);
  });

  it("can invalidate a policy transition for external visibility ownership", () => {
    const coordinator = new MotionPolicyCoordinator();
    coordinator.installAnimated();
    coordinator.setPolicy("reduce");
    const transition = requireTransition(coordinator.nextTransition());

    coordinator.cancelTransition();

    expect(transition.signal.aborted).toBe(true);
    expect(coordinator.snapshot().transition).toBeNull();
  });

  it("invalidates stale rapid-flip generations and accepts only the latest", () => {
    const coordinator = new MotionPolicyCoordinator();
    coordinator.installAnimated();

    coordinator.setPolicy("reduce");
    const first = requireTransition(coordinator.nextTransition());
    coordinator.setPolicy("full");
    coordinator.setPolicy("reduce");
    const latest = requireTransition(coordinator.nextTransition());

    expect(first.signal.aborted).toBe(true);
    expect(latest.signal.aborted).toBe(false);
    expect(latest.generation).toBeGreaterThan(first.generation);
    expect(coordinator.commitStatic(first)).toBe(false);
    expect(coordinator.commitStatic(latest)).toBe(true);
    expect(coordinator.snapshot().staticOrigin).toBe("reduced-motion");
  });

  it("turns a runtime failure static and aborts any policy transition", () => {
    const coordinator = new MotionPolicyCoordinator();
    coordinator.installAnimated();
    coordinator.setPolicy("reduce");
    const transition = requireTransition(coordinator.nextTransition());

    coordinator.failToStatic("animation-failure");
    expect(transition.signal.aborted).toBe(true);
    expect(coordinator.commitStatic(transition)).toBe(false);
    expect(coordinator.snapshot()).toMatchObject({
      actualMode: "static",
      staticOrigin: "animation-failure",
      stickyFailure: true,
      transition: null
    });
  });

  it("aborts owned work on disposal and rejects later mutation", () => {
    const coordinator = new MotionPolicyCoordinator();
    coordinator.installAnimated();
    coordinator.setPolicy("reduce");
    const transition = requireTransition(coordinator.nextTransition());

    coordinator.dispose();
    coordinator.dispose();
    expect(transition.signal.aborted).toBe(true);
    expect(coordinator.snapshot()).toMatchObject({
      actualMode: "disposed",
      transition: null,
      staticOrigin: null,
      disposed: true
    });
    expect(coordinator.commitStatic(transition)).toBe(false);
    expect(() => coordinator.setPolicy("full")).toThrow("disposed");
    expect(() => coordinator.installAnimated()).toThrow("disposed");
    expect(() => coordinator.nextTransition()).toThrow("disposed");
  });

  it("rejects invalid lifecycle and hostile policy inputs", () => {
    const coordinator = new MotionPolicyCoordinator();
    expect(() => coordinator.setPolicy(
      "sometimes" as unknown as "auto"
    )).toThrow("policy");
    expect(() => coordinator.setHostReducedMotion(
      1 as unknown as boolean
    )).toThrow("boolean");
    expect(() => coordinator.installStatic(
      "legacy" as unknown as "reduced-motion"
    )).toThrow("static origin");

    coordinator.installAnimated();
    expect(() => coordinator.installAnimated()).toThrow("unprepared");
    expect(() => coordinator.installStatic("reduced-motion"))
      .toThrow("unprepared");
    expect(() => coordinator.failToStatic(
      "reduced-motion" as unknown as "animation-failure"
    )).toThrow("failure origin");
  });
});

function requireTransition(
  transition: Readonly<MotionPolicyTransition> | null
): Readonly<MotionPolicyTransition> {
  if (transition === null) throw new Error("expected a motion transition");
  return transition;
}
