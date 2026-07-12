import {
  MotionGraphEngine,
  type GraphPresentation,
  type GraphStartPolicy,
  type MotionGraphDefinition,
  type MotionGraphSnapshot
} from "@rendered-motion/graph";
import { describe, expect, it } from "vitest";

import {
  EffectHost,
  type EffectHostEvent,
  type EffectHostSnapshot
} from "./effect-host.js";
import { RequestPromises } from "./request-promises.js";

describe("staged graph effect host", () => {
  it("translates readiness once while player-web owns metadata and visual levels", () => {
    const engine = new MotionGraphEngine();
    const install = engine.install(graph());
    const observed: Array<{
      readonly event: EffectHostEvent;
      readonly snapshot: Readonly<EffectHostSnapshot>;
    }> = [];
    let host!: EffectHost;
    host = new EffectHost({
      initialGraphSnapshot: install.snapshot,
      requestPromises: new RequestPromises(),
      eventSink: (event) => {
        observed.push({ event, snapshot: host.snapshot() });
      }
    });

    host.publishMetadataReady();
    host.publishMetadataReady();
    host.apply(install, () => undefined);
    host.publishVisualReady();
    host.publishVisualReady();
    host.apply(engine.beginAnimated(), () => undefined);

    expect(observed.map(({ event }) => event.type)).toEqual([
      "readinesschange",
      "readinesschange",
      "readinesschange"
    ]);
    expect(observed.map(({ event }) =>
      event.type === "readinesschange" ? event.to : null
    )).toEqual(["metadataReady", "visualReady", "interactiveReady"]);
    expect(observed.map(({ snapshot }) => snapshot.readiness)).toEqual([
      "metadataReady",
      "visualReady",
      "interactiveReady"
    ]);
    expect(host.snapshot()).toMatchObject({
      readiness: "interactiveReady",
      requestedState: "idle",
      visualState: "idle",
      isTransitioning: false
    });
  });

  it.each([
    { label: "transitionless", start: portalStart() },
    { label: "cut", start: cutStart() }
  ])("orders $label target commit around one draw barrier", async ({ start }) => {
    const fixture = preparedFixture({ start });
    const request = fixture.engine.request("hover");
    const promise = fixture.requests.register(request.requestId!);
    fixture.host.apply(request);

    expect(fixture.observed.at(-1)).toMatchObject({
      type: "requestedstatechange",
      snapshot: {
        requestedState: "hover",
        visualState: "idle",
        isTransitioning: true
      }
    });
    fixture.order.length = 0;
    const commit = fixture.engine.tick({ contentOrdinal: 0n });
    fixture.host.apply(commit, (presentation) => {
      fixture.order.push(`draw:${show(presentation)}`);
    });

    expect(fixture.order).toEqual([
      "event:transitionstart",
      "draw:body:hover:0",
      "event:visualstatechange",
      "event:transitionend"
    ]);
    expect(fixture.host.snapshot()).toMatchObject({
      requestedState: commit.snapshot.requestedState,
      visualState: commit.snapshot.visualState,
      isTransitioning: commit.snapshot.isTransitioning
    });
    expect(fixture.microtasks).toHaveLength(1);
    fixture.microtasks.shift()!();
    await expect(promise).resolves.toBeUndefined();
  });

  it("draws every locked frame and commits only after target frame zero", async () => {
    const fixture = preparedFixture({
      start: portalStart(),
      lockedFrames: 2
    });
    const request = fixture.engine.request("hover");
    const promise = fixture.requests.register(request.requestId!);
    fixture.host.apply(request);
    fixture.order.length = 0;

    for (let ordinal = 0n; ordinal <= 2n; ordinal += 1n) {
      const result = fixture.engine.tick({ contentOrdinal: ordinal });
      fixture.host.apply(result, (presentation) => {
        fixture.order.push(`draw:${show(presentation)}`);
      });
    }

    expect(fixture.order).toEqual([
      "event:transitionstart",
      "draw:locked:idle-to-hover:0",
      "draw:locked:idle-to-hover:1",
      "draw:body:hover:0",
      "event:visualstatechange",
      "event:transitionend"
    ]);
    fixture.microtasks.shift()!();
    await expect(promise).resolves.toBeUndefined();
  });

  it("stages static recovery before and after the drawn fallback", async () => {
    const fixture = preparedFixture({ start: portalStart() });
    const request = fixture.engine.request("hover");
    const promise = fixture.requests.register(request.requestId!);
    fixture.host.apply(request);
    fixture.order.length = 0;

    const recovery = fixture.engine.recoverStatic("decode-failure");
    fixture.host.apply(recovery, (presentation) => {
      fixture.order.push(`draw:${show(presentation)}`);
    });

    expect(fixture.order).toEqual([
      "event:readinesschange",
      "event:fallback",
      "event:transitionstart",
      "draw:static:hover",
      "event:visualstatechange",
      "event:transitionend"
    ]);
    expect(fixture.observed.find(({ type }) => type === "readinesschange"))
      .toMatchObject({ snapshot: { readiness: "staticReady" } });
    expect(fixture.host.snapshot()).toMatchObject({
      readiness: "staticReady",
      requestedState: recovery.snapshot.requestedState,
      visualState: recovery.snapshot.visualState,
      isTransitioning: recovery.snapshot.isTransitioning
    });
    fixture.microtasks.shift()!();
    await expect(promise).resolves.toBeUndefined();
  });

  it("keeps the newest exposed state and rejects fallback failure after a microtask", async () => {
    const fixture = preparedFixture({ start: portalStart() });
    const request = fixture.engine.request("hover");
    const outcome = fixture.requests.register(request.requestId!)
      .catch((error: unknown) => error);
    fixture.host.apply(request);
    fixture.order.length = 0;

    const failure = fixture.engine.failStatic("png-invalid");
    fixture.host.apply(failure);

    expect(fixture.order).toEqual(["event:readinesschange"]);
    expect(fixture.host.snapshot()).toMatchObject({
      readiness: "error",
      requestedState: "hover",
      visualState: "idle",
      isTransitioning: false
    });
    expect(fixture.microtasks).toHaveLength(1);
    fixture.microtasks.shift()!();
    await expect(outcome).resolves.toMatchObject({
      name: "PlaybackFallbackError"
    });
  });

  it("rejects an invalid route without changing staged requested state", async () => {
    const fixture = preparedFixture({ start: portalStart() });
    const result = fixture.engine.request("missing");
    const outcome = fixture.requests.register(result.requestId!)
      .catch((error: unknown) => error);
    fixture.order.length = 0;
    fixture.host.apply(result);

    expect(fixture.order).toEqual([]);
    expect(fixture.host.snapshot()).toMatchObject({
      requestedState: "idle",
      visualState: "idle",
      isTransitioning: false
    });
    fixture.microtasks.shift()!();
    await expect(outcome).resolves.toMatchObject({ name: "RouteError" });
  });

  it("applies disposal settlement before readiness and rejects the request once", async () => {
    const fixture = preparedFixture({ start: portalStart() });
    const request = fixture.engine.request("hover");
    let rejectionCount = 0;
    const outcome = fixture.requests.register(request.requestId!)
      .catch((error: unknown) => {
        rejectionCount += 1;
        return error;
      });
    fixture.host.apply(request);
    fixture.order.length = 0;
    fixture.observed.length = 0;

    const disposal = fixture.engine.dispose();
    expect(disposal.effects.map(({ type }) => type)).toEqual([
      "settle",
      "readinesschange"
    ]);
    expect(() => fixture.host.apply(disposal)).not.toThrow();
    expect(fixture.order).toEqual(["event:readinesschange"]);
    expect(fixture.observed).toEqual([
      expect.objectContaining({
        type: "readinesschange",
        snapshot: expect.objectContaining({ readiness: "disposed" })
      })
    ]);
    expect(fixture.host.snapshot()).toMatchObject({
      readiness: disposal.snapshot.readiness,
      requestedState: disposal.snapshot.requestedState,
      visualState: disposal.snapshot.visualState,
      isTransitioning: disposal.snapshot.isTransitioning
    });

    expect(fixture.microtasks).toHaveLength(1);
    fixture.requests.dispose();
    fixture.microtasks.shift()!();
    await expect(outcome).resolves.toMatchObject({ name: "AbortError" });
    expect(rejectionCount).toBe(1);
    expect(fixture.requests.pendingCount).toBe(0);
  });

  it("bounds its immutable event trace to the runtime capacity", () => {
    const host = new EffectHost({
      requestPromises: new RequestPromises()
    });
    const snapshot = graphSnapshot();
    for (let index = 0; index < 520; index += 1) {
      host.apply({
        operation: "send",
        accepted: true,
        sequence: index + 1,
        presentation: null,
        effects: [{ type: "fallback", reason: "bounded" }],
        snapshot
      });
    }

    const trace = host.getEventTrace();
    expect(trace).toHaveLength(512);
    expect(trace[0]?.index).toBe(9);
    expect(trace.at(-1)?.index).toBe(520);
    expect(Object.isFrozen(trace)).toBe(true);
    expect(Object.isFrozen(trace[0])).toBe(true);
    expect(Object.isFrozen(trace[0]?.snapshot)).toBe(true);
  });

  it("keeps observational listener failures outside graph transactions", () => {
    const host = new EffectHost({
      requestPromises: new RequestPromises(),
      eventSink: () => {
        throw new Error("injected listener failure");
      }
    });

    expect(() => host.publishMetadataReady()).not.toThrow();
    expect(() => host.publishVisualReady()).not.toThrow();
    expect(host.snapshot().readiness).toBe("visualReady");
    expect(host.getEventTrace()).toHaveLength(2);
  });
});

interface PreparedFixture {
  readonly engine: MotionGraphEngine;
  readonly host: EffectHost;
  readonly requests: RequestPromises;
  readonly microtasks: Array<() => void>;
  readonly order: string[];
  readonly observed: Array<{
    readonly type: EffectHostEvent["type"];
    readonly snapshot: Readonly<EffectHostSnapshot>;
  }>;
}

function preparedFixture(options: {
  readonly start: GraphStartPolicy;
  readonly lockedFrames?: number;
}): PreparedFixture {
  const engine = new MotionGraphEngine();
  const install = engine.install(graph(options));
  const microtasks: Array<() => void> = [];
  const requests = new RequestPromises({
    scheduleMicrotask: (callback) => microtasks.push(callback)
  });
  const order: string[] = [];
  const observed: PreparedFixture["observed"][number][] = [];
  let host!: EffectHost;
  host = new EffectHost({
    initialGraphSnapshot: install.snapshot,
    requestPromises: requests,
    eventSink: (event) => {
      order.push(`event:${event.type}`);
      observed.push({ type: event.type, snapshot: host.snapshot() });
    }
  });
  host.publishMetadataReady();
  host.apply(install, () => undefined);
  host.publishVisualReady();
  host.apply(engine.beginAnimated(), () => undefined);
  order.length = 0;
  observed.length = 0;
  return { engine, host, requests, microtasks, order, observed };
}

function graph(options: {
  readonly start?: GraphStartPolicy;
  readonly lockedFrames?: number;
} = {}): MotionGraphDefinition {
  const start = options.start ?? portalStart();
  return {
    initialState: "idle",
    states: [state("idle"), state("hover")],
    edges: [{
      id: "idle-to-hover",
      from: "idle",
      to: "hover",
      start,
      ...(options.lockedFrames === undefined
        ? {}
        : {
            transition: {
              kind: "locked" as const,
              unitId: "idle-to-hover-bridge",
              frameCount: options.lockedFrames
            }
          }),
      continuity: start.type === "cut" ? "cut" : "exact-authored"
    }]
  };
}

function state(id: string) {
  return {
    id,
    staticFrameId: `${id}-static`,
    body: {
      unitId: `${id}-body`,
      kind: "loop" as const,
      frameCount: 2,
      ports: [{ id: "default", entryFrame: 0 as const, portalFrames: [0] }]
    }
  };
}

function portalStart(): GraphStartPolicy {
  return {
    type: "portal",
    sourcePort: "default",
    targetPort: "default",
    maxWaitFrames: 1
  };
}

function cutStart(): GraphStartPolicy {
  return {
    type: "cut",
    targetPort: "default",
    maxWaitFrames: 1
  };
}

function show(presentation: Readonly<GraphPresentation>): string {
  switch (presentation.kind) {
    case "static":
      return `static:${presentation.state}`;
    case "body":
      return `body:${presentation.state}:${String(presentation.frameIndex)}`;
    case "locked":
      return `locked:${presentation.edgeId}:${String(presentation.frameIndex)}`;
    case "intro":
      return `intro:${presentation.state}:${String(presentation.frameIndex)}`;
    case "reversible":
      return `reversible:${presentation.edgeId}:${String(presentation.frameIndex)}`;
  }
}

function graphSnapshot(): Readonly<MotionGraphSnapshot> {
  return Object.freeze({
    readiness: "unready",
    phase: "unready",
    requestedState: null,
    visualState: null,
    prospectiveState: null,
    isTransitioning: false,
    presentation: null,
    pendingEdgeId: null,
    activeEdgeId: null,
    followOnEdgeId: null,
    direction: null,
    contentOrdinal: null,
    inputSequence: 0,
    pendingRequestCount: 0,
    inputsSinceTick: 0,
    routeOperationsLastTick: 0
  });
}
