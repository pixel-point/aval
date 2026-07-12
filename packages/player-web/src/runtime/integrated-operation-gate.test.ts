import { describe, expect, it } from "vitest";

import { IntegratedOperationGate } from "./integrated-operation-gate.js";

describe("IntegratedOperationGate", () => {
  it("defers listener inputs in FIFO order until the outer transaction returns", async () => {
    const gate = new IntegratedOperationGate();
    const order: string[] = [];
    let first!: Promise<string>;
    let second!: Promise<string>;

    gate.run(() => {
      order.push("transaction");
      first = gate.enqueue(async () => {
        order.push("first");
        return "one";
      });
      second = gate.enqueue(async () => {
        order.push("second");
        return "two";
      });
      expect(order).toEqual(["transaction"]);
    });

    await expect(first).resolves.toBe("one");
    await expect(second).resolves.toBe("two");
    expect(order).toEqual(["transaction", "first", "second"]);
  });

  it("keeps operations enqueued by a drained operation behind earlier work", async () => {
    const gate = new IntegratedOperationGate();
    const order: string[] = [];
    let nested: Promise<void> | null = null;
    let first!: Promise<void>;
    let second!: Promise<void>;

    gate.run(() => {
      first = gate.enqueue(async () => {
        order.push("first");
        gate.run(() => {
          nested = gate.enqueue(async () => {
            order.push("nested");
          });
        });
      });
      second = gate.enqueue(async () => {
        order.push("second");
      });
    });

    await Promise.all([first, second]);
    await expect(nested).resolves.toBeUndefined();
    expect(order).toEqual(["first", "second", "nested"]);
  });

  it("rejects a deferred operation that throws before returning a promise", async () => {
    const gate = new IntegratedOperationGate();
    let outcome!: Promise<void>;
    gate.run(() => {
      outcome = gate.enqueue(() => {
        throw new Error("injected deferred failure");
      });
    });

    await expect(outcome).rejects.toThrow("injected deferred failure");
    expect(gate.active).toBe(false);
  });
});
