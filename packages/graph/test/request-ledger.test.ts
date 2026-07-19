import { describe, expect, it } from "vitest";

import { RequestLedger } from "../src/request-ledger.js";

describe("RequestLedger", () => {
  it("allocates monotonically increasing request IDs", () => {
    const ledger = new RequestLedger();

    expect(ledger.request("hovered").requestId).toBe(1);
    expect(ledger.request("hovered").requestId).toBe(2);
    expect(
      ledger.settleNew({
        type: "reject",
        timing: "microtask",
        error: "RouteError"
      }).requestId
    ).toBe(3);
    expect(ledger.request("idle").requestId).toBe(4);
  });

  it("joins duplicate requests into the surviving destination group", () => {
    const ledger = new RequestLedger();

    const first = ledger.request("hovered");
    const second = ledger.request("hovered");

    expect(first).toMatchObject({
      requestId: 1,
      target: "hovered",
      joined: false,
      superseded: null
    });
    expect(second).toMatchObject({
      requestId: 2,
      target: "hovered",
      joined: true,
      superseded: null
    });
    expect(ledger.pendingRequestCount).toBe(2);
    expect(ledger.pendingTarget).toBe("hovered");

    expect(
      ledger.settlePending({
        type: "resolve",
        timing: "microtask",
        reason: "target-committed"
      })
    ).toEqual({
      type: "settle",
      requestIds: [1, 2],
      outcome: {
        type: "resolve",
        timing: "microtask",
        reason: "target-committed"
      }
    });
    expect(ledger.pendingRequestCount).toBe(0);
    expect(ledger.pendingTarget).toBeNull();
  });

  it("supersedes a whole group once and rejects it in request order", () => {
    const ledger = new RequestLedger();
    ledger.request("success");
    ledger.request("success");

    const replacement = ledger.request("error");

    expect(replacement).toMatchObject({
      requestId: 3,
      target: "error",
      joined: false
    });
    expect(replacement.superseded).toEqual({
      type: "settle",
      requestIds: [1, 2],
      outcome: {
        type: "reject",
        timing: "microtask",
        error: "AbortError"
      }
    });
    expect(ledger.pendingRequestCount).toBe(1);
    expect(ledger.pendingTarget).toBe("error");

    const duplicate = ledger.request("error");
    expect(duplicate.joined).toBe(true);
    expect(duplicate.superseded).toBeNull();
    expect(ledger.pendingRequestCount).toBe(2);

    expect(
      ledger.settlePending({
        type: "reject",
        timing: "microtask",
        error: "PlaybackError"
      })
    ).toMatchObject({ requestIds: [3, 4] });
    expect(
      ledger.settlePending({
        type: "reject",
        timing: "microtask",
        error: "AbortError"
      })
    ).toBeNull();
  });

  it("settles standalone requests without disturbing a pending group", () => {
    const ledger = new RequestLedger();
    ledger.request("hovered");

    const invalid = ledger.settleNew({
      type: "reject",
      timing: "microtask",
      error: "RouteError"
    });

    expect(invalid).toEqual({
      requestId: 2,
      effect: {
        type: "settle",
        requestIds: [2],
        outcome: {
          type: "reject",
          timing: "microtask",
          error: "RouteError"
        }
      }
    });
    expect(ledger.pendingRequestCount).toBe(1);
    expect(ledger.pendingTarget).toBe("hovered");
  });

  it("returns deeply frozen admissions and settle effects", () => {
    const ledger = new RequestLedger();
    ledger.request("hovered");
    const superseding = ledger.request("idle");
    const resolved = ledger.settlePending({
      type: "resolve",
      timing: "microtask",
      reason: "stable-noop"
    });
    const standalone = ledger.settleNew({
      type: "reject",
      timing: "microtask",
      error: "NotReadyError"
    });

    expect(Object.isFrozen(superseding)).toBe(true);
    expect(Object.isFrozen(superseding.superseded)).toBe(true);
    expect(Object.isFrozen(superseding.superseded?.requestIds)).toBe(true);
    expect(Object.isFrozen(superseding.superseded?.outcome)).toBe(true);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved?.requestIds)).toBe(true);
    expect(Object.isFrozen(resolved?.outcome)).toBe(true);
    expect(Object.isFrozen(standalone)).toBe(true);
    expect(Object.isFrozen(standalone.effect)).toBe(true);
    expect(Object.isFrozen(standalone.effect.requestIds)).toBe(true);
    expect(Object.isFrozen(standalone.effect.outcome)).toBe(true);

    expect(
      Reflect.set(resolved?.requestIds ?? [], "0", Number.MAX_SAFE_INTEGER)
    ).toBe(false);
    expect(resolved?.requestIds).toEqual([2]);
  });

  it("copies settlement values before freezing them", () => {
    const ledger = new RequestLedger();
    ledger.request("hovered");
    const outcome = {
      type: "resolve" as const,
      timing: "microtask" as const,
      reason: "target-committed" as const
    };

    const effect = ledger.settlePending(outcome);

    expect(Object.isFrozen(outcome)).toBe(false);
    expect(effect?.outcome).not.toBe(outcome);
    expect(effect?.outcome).toEqual(outcome);
  });
});
