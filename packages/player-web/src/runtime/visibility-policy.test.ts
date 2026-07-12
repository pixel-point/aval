import { describe, expect, it } from "vitest";

import {
  VisibilityPolicyCoordinator,
  type VisibilityPolicyTransition
} from "./visibility-policy.js";

describe("visibility policy coordinator", () => {
  it("starts visible and creates one suspension generation", () => {
    const policy = new VisibilityPolicyCoordinator();
    expect(policy.snapshot()).toEqual({
      generation: 0,
      visibility: "visible",
      suspension: "active",
      frozenPresentationOrdinal: null,
      rebuildPending: false
    });

    policy.setVisibility("hidden");
    const transition = requireTransition(policy.nextTransition());
    expect(transition).toMatchObject({ kind: "suspend", generation: 1 });
    expect(policy.nextTransition()).toBe(transition);
    expect(policy.commitSuspended(transition, 7n)).toBe(true);
    expect(policy.snapshot()).toEqual({
      generation: 1,
      visibility: "hidden",
      suspension: "suspended",
      frozenPresentationOrdinal: 7n,
      rebuildPending: false
    });
  });

  it("requires a fresh resume and commits only after rebuild", () => {
    const policy = suspendedPolicy(4n);
    policy.setVisibility("visible");
    const resume = requireTransition(policy.nextTransition());
    expect(resume.kind).toBe("resume");
    expect(policy.snapshot()).toMatchObject({ rebuildPending: true });
    expect(policy.commitActive(resume)).toBe(true);
    expect(policy.snapshot()).toMatchObject({
      visibility: "visible",
      suspension: "active",
      frozenPresentationOrdinal: null,
      rebuildPending: false
    });
  });

  it("cancels pre-cover suspension without claiming a rebuild", () => {
    const policy = new VisibilityPolicyCoordinator();
    policy.setVisibility("hidden");
    const suspension = requireTransition(policy.nextTransition());

    policy.setVisibility("visible");

    expect(suspension.signal.aborted).toBe(true);
    expect(policy.commitSuspended(suspension, 2n)).toBe(false);
    expect(policy.nextTransition()).toBeNull();
    expect(policy.snapshot()).toMatchObject({
      visibility: "visible",
      suspension: "active",
      rebuildPending: false
    });
  });

  it("invalidates rapid stale generations and accepts only latest", () => {
    const policy = new VisibilityPolicyCoordinator();
    policy.setVisibility("hidden");
    const first = requireTransition(policy.nextTransition());
    policy.setVisibility("visible");
    policy.setVisibility("hidden");
    const latest = requireTransition(policy.nextTransition());

    expect(first.signal.aborted).toBe(true);
    expect(latest.generation).toBeGreaterThan(first.generation);
    expect(policy.commitSuspended(first, 1n)).toBe(false);
    expect(policy.commitSuspended(latest, 3n)).toBe(true);
  });

  it("keeps a failed visible rebuild suspended without a retry loop", () => {
    const policy = suspendedPolicy(8n);
    policy.setVisibility("visible");
    const resume = requireTransition(policy.nextTransition());

    expect(policy.failResume(resume)).toBe(true);
    expect(policy.nextTransition()).toBeNull();
    expect(policy.snapshot()).toMatchObject({
      visibility: "visible",
      suspension: "suspended",
      frozenPresentationOrdinal: 8n,
      rebuildPending: false
    });
  });

  it("supports initially hidden static preparation", () => {
    const policy = new VisibilityPolicyCoordinator({
      initialVisibility: "hidden"
    });
    expect(policy.snapshot()).toMatchObject({
      visibility: "hidden",
      suspension: "suspended",
      frozenPresentationOrdinal: null
    });
    policy.installInitialSuspended(0n);
    expect(policy.snapshot().frozenPresentationOrdinal).toBe(0n);
  });

  it("returns an unprepared hidden player to active without a rebuild", () => {
    const policy = new VisibilityPolicyCoordinator({
      initialVisibility: "hidden"
    });

    policy.setVisibility("visible");

    expect(policy.snapshot()).toMatchObject({
      visibility: "visible",
      suspension: "active",
      frozenPresentationOrdinal: null,
      rebuildPending: false
    });
    expect(policy.nextTransition()).toBeNull();
  });

  it("aborts owned work on disposal and rejects later mutation", () => {
    const policy = suspendedPolicy(1n);
    policy.setVisibility("visible");
    const resume = requireTransition(policy.nextTransition());
    policy.dispose();
    policy.dispose();

    expect(resume.signal.aborted).toBe(true);
    expect(policy.nextTransition()).toBeNull();
    expect(() => policy.setVisibility("hidden")).toThrow("disposed");
  });

  it("rejects hostile visibility and ordinal values", () => {
    const policy = new VisibilityPolicyCoordinator();
    expect(() => policy.setVisibility("gone" as "hidden")).toThrow();
    policy.setVisibility("hidden");
    const transition = requireTransition(policy.nextTransition());
    expect(() => policy.commitSuspended(transition, -1n)).toThrow();
  });
});

function suspendedPolicy(ordinal: bigint): VisibilityPolicyCoordinator {
  const policy = new VisibilityPolicyCoordinator();
  policy.setVisibility("hidden");
  const transition = requireTransition(policy.nextTransition());
  policy.commitSuspended(transition, ordinal);
  return policy;
}

function requireTransition(
  value: Readonly<VisibilityPolicyTransition> | null
): Readonly<VisibilityPolicyTransition> {
  if (value === null) throw new Error("expected visibility transition");
  return value;
}
