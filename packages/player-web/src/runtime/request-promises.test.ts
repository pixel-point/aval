import type { MotionGraphEffect } from "@pixel-point/aval-graph";
import { describe, expect, it } from "vitest";
import { RuntimePlaybackError, normalizeRuntimeFailure } from "./errors.js";

import {
  GraphRequestSettlementError,
  RequestPromiseInvariantError,
  RequestPromises
} from "./request-promises.js";

describe("graph request promise host", () => {
  it("invokes the host scheduler without leaking the promise host as receiver", async () => {
    let receiver: unknown = "not-called";
    const requests = new RequestPromises({
      scheduleMicrotask: function (this: unknown, callback) {
        receiver = this;
        callback();
      }
    });
    const result = requests.register(1);

    requests.queueSettlement(settle([1], {
      type: "resolve",
      timing: "microtask",
      reason: "stable-noop"
    }));

    expect(receiver).toBeUndefined();
    await expect(result).resolves.toBeUndefined();
  });

  it("resolves a stable no-op only in the following microtask", async () => {
    const microtasks = controlledMicrotasks();
    const requests = new RequestPromises({
      scheduleMicrotask: microtasks.schedule
    });
    let state = "pending";
    const promise = requests.register(1).then(() => {
      state = "resolved";
    });

    requests.queueSettlement(settle([1], {
      type: "resolve",
      timing: "microtask",
      reason: "stable-noop"
    }));

    expect(state).toBe("pending");
    expect(requests.pendingCount).toBe(1);
    expect(microtasks.callbacks).toHaveLength(1);
    microtasks.runNext();
    expect(state).toBe("pending");
    await promise;
    expect(state).toBe("resolved");
    expect(requests.pendingCount).toBe(0);
  });

  it("settles every joined request ID while retaining distinct promises", async () => {
    const microtasks = controlledMicrotasks();
    const requests = new RequestPromises({
      scheduleMicrotask: microtasks.schedule
    });
    const first = requests.register(1);
    const joined = requests.register(2);

    expect(first).not.toBe(joined);
    requests.queueSettlement(settle([1, 2], {
      type: "resolve",
      timing: "microtask",
      reason: "target-committed"
    }));
    microtasks.runNext();

    await expect(first).resolves.toBeUndefined();
    await expect(joined).resolves.toBeUndefined();
    expect(requests.pendingRequestIds()).toEqual([]);
  });

  it("rejects superseded groups with AbortError and preserves the survivor", async () => {
    const microtasks = controlledMicrotasks();
    const requests = new RequestPromises({
      scheduleMicrotask: microtasks.schedule
    });
    const first = requests.register(1);
    const joined = requests.register(2);
    const survivor = requests.register(3);
    const firstOutcome = first.catch((error: unknown) => error);
    const joinedOutcome = joined.catch((error: unknown) => error);

    requests.queueSettlement(settle([1, 2], {
      type: "reject",
      timing: "microtask",
      error: "AbortError"
    }));
    requests.queueSettlement(settle([3], {
      type: "resolve",
      timing: "microtask",
      reason: "target-committed"
    }));
    microtasks.runAll();

    await expect(firstOutcome).resolves.toMatchObject({ name: "AbortError" });
    await expect(joinedOutcome).resolves.toMatchObject({ name: "AbortError" });
    await expect(survivor).resolves.toBeUndefined();
  });

  it("uses the bound canonical error for terminal graph settlements", async () => {
    const microtasks = controlledMicrotasks();
    const requests = new RequestPromises({
      scheduleMicrotask: microtasks.schedule
    });
    const request = requests.register(1);
    const outcome = request.catch((error: unknown) => error);
    const terminal = new RuntimePlaybackError(normalizeRuntimeFailure(
      "worker-decode-failure",
      "decoder failed",
      { operation: "content-tick" }
    ));
    requests.bindTerminalPlaybackError(terminal);

    requests.queueSettlement(settle([1], {
      type: "reject",
      timing: "microtask",
      error: "PlaybackError"
    }));
    microtasks.runNext();

    await expect(outcome).resolves.toBe(terminal);
  });

  it("rejects an unbound or rebound terminal graph settlement", () => {
    const microtasks = controlledMicrotasks();
    const requests = new RequestPromises({
      scheduleMicrotask: microtasks.schedule
    });
    void requests.register(1);

    expect(() => requests.queueSettlement(settle([1], {
      type: "reject",
      timing: "microtask",
      error: "PlaybackError"
    }))).toThrow(/requires a bound terminal playback error/);
    expect(microtasks.callbacks).toHaveLength(0);

    const terminal = new RuntimePlaybackError(normalizeRuntimeFailure(
      "renderer-failure"
    ));
    requests.bindTerminalPlaybackError(terminal);
    requests.bindTerminalPlaybackError(terminal);
    expect(() => requests.bindTerminalPlaybackError(
      new RuntimePlaybackError(normalizeRuntimeFailure("renderer-failure"))
    )).toThrow(/cannot be rebound/);
  });

  it("rejects duplicate, unknown, and partially invalid settlements atomically", () => {
    const microtasks = controlledMicrotasks();
    const requests = new RequestPromises({
      scheduleMicrotask: microtasks.schedule
    });
    void requests.register(1);
    void requests.register(2);

    expect(() => requests.queueSettlement(settle([1, 1], {
      type: "resolve",
      timing: "microtask",
      reason: "stable-noop"
    }))).toThrow(RequestPromiseInvariantError);
    expect(requests.pendingRequestIds()).toEqual([1, 2]);
    expect(microtasks.callbacks).toHaveLength(0);

    expect(() => requests.queueSettlement(settle([1, 99], {
      type: "resolve",
      timing: "microtask",
      reason: "stable-noop"
    }))).toThrow(RequestPromiseInvariantError);
    expect(requests.pendingRequestIds()).toEqual([1, 2]);

    requests.queueSettlement(settle([1], {
      type: "resolve",
      timing: "microtask",
      reason: "stable-noop"
    }));
    expect(() => requests.queueSettlement(settle([1], {
      type: "resolve",
      timing: "microtask",
      reason: "stable-noop"
    }))).toThrow(RequestPromiseInvariantError);
  });

  it("aborts all pending or scheduled requests exactly once on disposal", async () => {
    const microtasks = controlledMicrotasks();
    const requests = new RequestPromises({
      scheduleMicrotask: microtasks.schedule
    });
    let firstRejections = 0;
    let secondRejections = 0;
    const firstOutcome = requests.register(1).catch((error: unknown) => {
      firstRejections += 1;
      return error;
    });
    const secondOutcome = requests.register(2).catch((error: unknown) => {
      secondRejections += 1;
      return error;
    });
    requests.queueSettlement(settle([1], {
      type: "resolve",
      timing: "microtask",
      reason: "target-committed"
    }));

    requests.dispose();
    requests.dispose();
    microtasks.runAll();

    await expect(firstOutcome).resolves.toMatchObject({ name: "AbortError" });
    await expect(secondOutcome).resolves.toMatchObject({ name: "AbortError" });
    expect(firstRejections).toBe(1);
    expect(secondRejections).toBe(1);
    expect(requests.disposed).toBe(true);
    expect(requests.pendingCount).toBe(0);
    expect(() => requests.register(3)).toThrow(RequestPromiseInvariantError);
  });

  it("settles once when the scheduled callback wins before later disposal", async () => {
    const microtasks = controlledMicrotasks();
    const requests = new RequestPromises({
      scheduleMicrotask: microtasks.schedule
    });
    let resolutions = 0;
    let rejections = 0;
    const outcome = requests.register(1).then(
      () => {
        resolutions += 1;
        return "resolved" as const;
      },
      () => {
        rejections += 1;
        return "rejected" as const;
      }
    );
    requests.queueSettlement(settle([1], {
      type: "resolve",
      timing: "microtask",
      reason: "stable-noop"
    }));

    microtasks.runNext();
    requests.dispose();
    requests.dispose();

    await expect(outcome).resolves.toBe("resolved");
    expect(resolutions).toBe(1);
    expect(rejections).toBe(0);
    expect(requests.pendingCount).toBe(0);
  });

  it("settles once when disposal happens inside scheduling", async () => {
    let scheduled: (() => void) | null = null;
    let requests!: RequestPromises;
    requests = new RequestPromises({
      scheduleMicrotask: (callback) => {
        scheduled = callback;
        requests.dispose();
      }
    });
    let rejections = 0;
    const outcome = requests.register(1).catch((error: unknown) => {
      rejections += 1;
      return error;
    });

    requests.queueSettlement(settle([1], {
      type: "resolve",
      timing: "microtask",
      reason: "stable-noop"
    }));
    expect(scheduled).not.toBeNull();
    scheduled!();

    await expect(outcome).resolves.toMatchObject({ name: "AbortError" });
    expect(rejections).toBe(1);
    expect(requests.pendingCount).toBe(0);
  });
});

function settle(
  requestIds: readonly number[],
  outcome: Extract<MotionGraphEffect, { readonly type: "settle" }>["outcome"]
): Extract<MotionGraphEffect, { readonly type: "settle" }> {
  return {
    type: "settle",
    requestIds,
    outcome
  };
}

function controlledMicrotasks(): {
  readonly callbacks: Array<() => void>;
  readonly schedule: (callback: () => void) => void;
  readonly runNext: () => void;
  readonly runAll: () => void;
} {
  const callbacks: Array<() => void> = [];
  return {
    callbacks,
    schedule: (callback) => {
      callbacks.push(callback);
    },
    runNext: () => {
      const callback = callbacks.shift();
      if (callback === undefined) throw new Error("microtask queue is empty");
      callback();
    },
    runAll: () => {
      while (callbacks.length > 0) callbacks.shift()!();
    }
  };
}
