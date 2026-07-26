import { describe, expect, it } from "vitest";

import { DomEventBridge } from "../src/dom-event-bridge.js";
import { ElementPublicState } from "../src/element-public-state.js";

class DetailEvent<T> extends Event {
  public readonly detail: Readonly<T>;
  public constructor(type: string, detail: Readonly<T>) {
    super(type);
    this.detail = detail;
  }
}

function bridge(target: EventTarget): DomEventBridge {
  return new DomEventBridge({
    target,
    generation: 2,
    stage: {
      readiness: () => undefined,
      requestedState: () => undefined,
      visualState: () => undefined,
      transitioning: () => undefined,
      snapshot: () => ({ requestedState: "walk_n", visualState: "walk_n" })
    },
    createEvent: (type, detail) =>
      new DetailEvent(type, detail) as unknown as CustomEvent<typeof detail>
  });
}

describe("turnstep DOM event", () => {
  it("publishes one immutable landing per step boundary", () => {
    const target = new EventTarget();
    const observed: unknown[] = [];
    target.addEventListener("turnstep", (event) => {
      observed.push((event as DetailEvent<unknown>).detail);
    });
    const publisher = bridge(target);

    publisher.runtime({
      type: "turnstep",
      ring: "facing.walk",
      from: "walk_n",
      to: "walk_ne",
      remaining: 1
    });
    publisher.runtime({
      type: "turnstep",
      ring: "facing.walk",
      from: "walk_ne",
      to: "walk_e",
      remaining: 0
    });

    expect(observed).toEqual([
      {
        generation: 2,
        ring: "facing.walk",
        from: "walk_n",
        to: "walk_ne",
        remaining: 1
      },
      {
        generation: 2,
        ring: "facing.walk",
        from: "walk_ne",
        to: "walk_e",
        remaining: 0
      }
    ]);
    expect(Object.isFrozen(observed[0])).toBe(true);
  });

  it("stops publishing after the bridge closes with its generation", () => {
    const target = new EventTarget();
    const observed: unknown[] = [];
    target.addEventListener("turnstep", () => observed.push(true));
    const publisher = bridge(target);

    publisher.close();
    publisher.runtime({
      type: "turnstep",
      ring: "facing.walk",
      from: "walk_n",
      to: "walk_ne",
      remaining: 0
    });

    expect(observed).toEqual([]);
  });
});

describe("element ring metadata", () => {
  it("publishes the asset's rings and detaches their member lists", () => {
    const state = new ElementPublicState();
    const states = ["walk_n", "walk_ne", "walk_e"];

    state.metadataReady({
      initialState: "walk_n",
      stateNames: states,
      eventNames: [],
      bindings: [],
      rings: [{ id: "facing.walk", states, cyclic: true }]
    });

    expect(state.rings).toEqual([
      { id: "facing.walk", states: ["walk_n", "walk_ne", "walk_e"], cyclic: true }
    ]);
    expect(Object.isFrozen(state.rings)).toBe(true);
    expect(Object.isFrozen(state.rings[0]?.states)).toBe(true);
    expect(state.rings[0]?.states).not.toBe(states);
  });

  it("reports no rings for an asset which declares none, and clears on reset", () => {
    const state = new ElementPublicState();

    state.metadataReady({
      initialState: "idle",
      stateNames: ["idle"],
      eventNames: [],
      bindings: []
    });
    expect(state.rings).toEqual([]);

    state.metadataReady({
      initialState: "walk_n",
      stateNames: ["walk_n", "walk_ne"],
      eventNames: [],
      bindings: [],
      rings: [{ id: "facing.walk", states: ["walk_n", "walk_ne"], cyclic: false }]
    });
    state.reset();
    expect(state.rings).toEqual([]);
  });
});
