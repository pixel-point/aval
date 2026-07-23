import { describe, expect, it, vi } from "vitest";

import {
  ElementSnapshotStore,
  type ElementSnapshotState
} from "../src/element-snapshot-store.js";

describe("ElementSnapshotStore", () => {
  it("retains one deeply frozen snapshot until a semantic field changes", () => {
    const store = new ElementSnapshotStore(initialState());
    const initial = store.getSnapshot();

    expect(store.getSnapshot()).toBe(initial);
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial.stateNames)).toBe(true);
    expect(Object.isFrozen(initial.inputBindings)).toBe(true);
    expect(Object.isFrozen(initial.inputBindings[0])).toBe(true);

    expect(store.transition(() => initialState())).toBe(false);
    expect(store.getSnapshot()).toBe(initial);

    expect(store.transition(() => initialState({ paused: true }))).toBe(true);
    const paused = store.getSnapshot();
    expect(paused).not.toBe(initial);
    expect(paused).toMatchObject({ revision: 1, paused: true });
    expect(store.getSnapshot()).toBe(paused);
  });

  it("uses semantic equality for arrays, bindings, and errors", () => {
    const error = Object.freeze({
      generation: 3,
      fatal: true,
      failure: Object.freeze({
        code: "invalid-configuration" as const,
        message: "invalid source",
        operation: "configure"
      })
    });
    const store = new ElementSnapshotStore(initialState({ lastError: error }));
    const initial = store.getSnapshot();

    expect(store.transition(() => initialState({
      stateNames: ["idle", "hover"],
      eventNames: ["engage"],
      inputBindings: [{ source: "pointer.enter", event: "engage" }],
      lastError: {
        generation: 3,
        fatal: true,
        failure: {
          code: "invalid-configuration",
          message: "invalid source",
          operation: "configure"
        }
      }
    }))).toBe(false);
    expect(store.getSnapshot()).toBe(initial);

    expect(store.transition(() => initialState({
      lastError: {
        ...error,
        fatal: false
      }
    }))).toBe(true);
    expect(store.getSnapshot()).toMatchObject({
      revision: 1,
      lastError: { fatal: false }
    });
    expect(Object.isFrozen(store.getSnapshot().lastError)).toBe(true);
    expect(Object.isFrozen(store.getSnapshot().lastError?.failure)).toBe(true);
  });

  it("returns an idempotent unsubscribe for every subscription", () => {
    const store = new ElementSnapshotStore(initialState());
    const listener = vi.fn();
    const unsubscribeFirst = store.subscribe(listener);
    const unsubscribeSecond = store.subscribe(listener);

    unsubscribeFirst();
    unsubscribeFirst();
    store.transition(() => initialState({ connected: true }));
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribeSecond();
    unsubscribeSecond();
    store.transition(() => initialState({ connected: false }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("isolates subscriber failures and continues notifying peers", () => {
    const store = new ElementSnapshotStore(initialState());
    const healthy = vi.fn();
    store.subscribe(() => { throw new Error("subscriber failed"); });
    store.subscribe(healthy);

    expect(() => store.transition(() => initialState({
      connected: true
    }))).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({ revision: 1, connected: true });
  });
});

function initialState(
  overrides: Partial<ElementSnapshotState> = {}
): Readonly<ElementSnapshotState> {
  return {
    generation: 0,
    connected: false,
    readiness: "unready",
    mode: null,
    assurance: null,
    staticReason: null,
    requestedState: null,
    visualState: null,
    isTransitioning: false,
    paused: false,
    effectivelyVisible: false,
    stateNames: ["idle", "hover"],
    eventNames: ["engage"],
    inputBindings: [{ source: "pointer.enter", event: "engage" }],
    lastError: null,
    ...overrides
  };
}
