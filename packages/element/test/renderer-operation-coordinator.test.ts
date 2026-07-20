import { describe, expect, it } from "vitest";

import type { RendererDiagnosticOperation } from
  "../src/renderer-diagnostics.js";
import { RendererOperationCoordinator } from
  "../src/renderer-operation-coordinator.js";

class TerminalOperationError extends Error {
  public constructor(
    public readonly operation: RendererDiagnosticOperation,
    public readonly ordinal: number
  ) {
    super("terminal renderer operation");
  }
}

describe("RendererOperationCoordinator", () => {
  it("serializes reentrant work without awaiting caller code", async () => {
    const events: string[] = [];
    const coordinator = nonterminalCoordinator();
    let nested: Promise<void> | undefined;

    await coordinator.enqueue("runtime", (ordinal) => {
      events.push(`outer:${String(ordinal)}`);
      nested = coordinator.enqueue("runtime", (nestedOrdinal) => {
        events.push(`nested:${String(nestedOrdinal)}`);
      });
    });
    await nested;

    expect(events).toEqual(["outer:0", "nested:1"]);
    expect(coordinator.pendingOperations).toBe(0);
  });

  it("classifies and publishes a failure with the task ordinal", async () => {
    const published: TerminalOperationError[] = [];
    const coordinator = new RendererOperationCoordinator<TerminalOperationError>({
      accepting: () => true,
      unavailable: () => new Error("unavailable"),
      classify: (_reason, operation, ordinal) =>
        new TerminalOperationError(operation, ordinal),
      terminal: (error) => { published.push(error); }
    });

    await expect(coordinator.enqueue("restore", () => {
      throw new Error("unexpected backend failure");
    })).rejects.toMatchObject({ operation: "restore", ordinal: 0 });

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ operation: "restore", ordinal: 0 });
  });

  it("does not consume an ordinal for skipped conditional work", async () => {
    const coordinator = nonterminalCoordinator();
    let skippedRan = false;

    await coordinator.enqueueIf(
      "restore",
      () => false,
      () => { skippedRan = true; }
    );
    const ordinal = await coordinator.enqueue("runtime", (value) => value);

    expect(skippedRan).toBe(false);
    expect(ordinal).toBe(0);
  });
});

function nonterminalCoordinator(): RendererOperationCoordinator<Error> {
  return new RendererOperationCoordinator({
    accepting: () => true,
    unavailable: () => new Error("unavailable"),
    classify: () => null,
    terminal: () => { throw new Error("unexpected terminal publication"); }
  });
}
