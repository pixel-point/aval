import { describe, expect, it } from "vitest";

import { ElementEngagementBinding } from "../src/element-engagement-binding.js";

describe("ElementEngagementBinding", () => {
  it("retries a rejected current level after the active transition", () => {
    const calls: string[] = [];
    const results = [true, false, true];
    const binding = new ElementEngagementBinding((source) => {
      calls.push(source);
      return results.shift() ?? null;
    }, () => true);

    binding.update(true);
    binding.update(false);
    binding.retry(false);
    binding.retry(false);

    expect(calls).toEqual([
      "engagement.on",
      "engagement.off",
      "engagement.off"
    ]);
  });

  it("does not replay a stale desired level", () => {
    const calls: string[] = [];
    const binding = new ElementEngagementBinding((source) => {
      calls.push(source);
      return false;
    }, () => true);

    binding.update(false, true);
    binding.retry(true);

    expect(calls).toEqual(["engagement.off"]);
  });

  it("clears rejected work when bindings are reset", () => {
    const calls: string[] = [];
    const binding = new ElementEngagementBinding((source) => {
      calls.push(source);
      return false;
    }, () => true);

    binding.update(false, true);
    binding.reset();
    binding.retry(false);

    expect(calls).toEqual(["engagement.off"]);
  });

  it("does not retain a rejected snapshot when no transition is active", () => {
    const calls: string[] = [];
    let busy = false;
    const binding = new ElementEngagementBinding((source) => {
      calls.push(source);
      return false;
    }, () => busy);

    binding.update(false, true);
    busy = true;
    binding.retry(false);

    expect(calls).toEqual(["engagement.off"]);
  });
});
