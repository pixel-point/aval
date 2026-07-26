import {
  MotionGraphEngine,
  type GraphEdgeDefinition,
  type MotionGraphDefinition
} from "@pixel-point/aval-graph";
import { describe, expect, it } from "vitest";

import { EffectHost, type EffectHostEvent } from "./effect-host.js";
import { RequestPromises } from "./request-promises.js";

const FACINGS = Object.freeze(["walk_n", "walk_ne", "walk_e", "walk_w"]);

describe("chained turn effects through the staged host", () => {
  it("publishes one landing per step, after the pixels for it", async () => {
    const engine = new MotionGraphEngine();
    const requests = new RequestPromises();
    const install = engine.install(ringGraph());
    const observed: EffectHostEvent[] = [];
    const order: string[] = [];
    const host = new EffectHost({
      initialGraphSnapshot: install.snapshot,
      requestPromises: requests,
      eventSink: (event) => {
        observed.push(event);
        order.push(`event:${event.type}`);
      }
    });
    host.publishMetadataReady();
    host.apply(install, () => undefined);
    host.publishVisualReady();
    host.apply(engine.beginAnimated(), () => undefined);

    const request = engine.request("walk_e");
    const settled = requests.register(request.requestId!);
    host.apply(request);
    order.length = 0;
    observed.length = 0;

    host.apply(engine.tick({ contentOrdinal: 0n }), () => order.push("draw"));
    host.apply(engine.tick({ contentOrdinal: 1n }), () => order.push("draw"));

    expect(observed.filter((event) => event.type === "turnstep")).toEqual([
      {
        type: "turnstep",
        ring: "facing.walk",
        from: "walk_n",
        to: "walk_ne",
        remaining: 1
      },
      {
        type: "turnstep",
        ring: "facing.walk",
        from: "walk_ne",
        to: "walk_e",
        remaining: 0
      }
    ]);
    // A landing is reported only once its pixels have been drawn.
    expect(order.indexOf("draw")).toBeLessThan(order.indexOf("event:turnstep"));
    expect(host.snapshot()).toMatchObject({
      visualState: "walk_e",
      requestedState: "walk_e",
      isTransitioning: false
    });
    await expect(settled).resolves.toBeUndefined();
  });
});

/** A four-state cyclic facing ring reachable by portal steps. */
function ringGraph(): MotionGraphDefinition {
  const edges: GraphEdgeDefinition[] = [];
  for (let index = 0; index < FACINGS.length; index += 1) {
    const from = FACINGS[index]!;
    const to = FACINGS[(index + 1) % FACINGS.length]!;
    edges.push(step(from, to, 1), step(to, from, -1));
  }
  return {
    initialState: "walk_n",
    states: FACINGS.map((id) => ({
      id,
      body: {
        unitId: `${id}.body`,
        kind: "loop",
        frameCount: 2,
        ports: [{ id: "default", entryFrame: 0, portalFrames: [0] }]
      }
    })),
    edges,
    rings: [{
      id: "facing.walk",
      states: [...FACINGS],
      cyclic: true,
      tieBreak: "forward",
      maxChainedSteps: 2
    }]
  };
}

function step(from: string, to: string, offset: 1 | -1): GraphEdgeDefinition {
  return {
    id: `facing.walk.${from}.${to}`,
    from,
    to,
    start: {
      type: "portal",
      sourcePort: "default",
      targetPort: "default",
      maxWaitFrames: 1
    },
    continuity: "exact-authored",
    ring: "facing.walk",
    step: offset
  };
}
