import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MotionGraphEngine } from "@pixel-point/aval-graph";

import { parseSourceProject } from "../src/source-project-schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(
  HERE,
  "../../../fixtures/rings/v1-eight-way-facing/motion.json"
);

describe("eight-way facing ring fixture", () => {
  it("expands into the whole ring without authoring one edge", () => {
    const project = parseSourceProject(readFileSync(FIXTURE));

    expect(project.states.map(({ id }) => id)).toEqual([
      "walk_e",
      "walk_n",
      "walk_ne",
      "walk_nw",
      "walk_s",
      "walk_se",
      "walk_sw",
      "walk_w"
    ]);
    // AC1: eight adjacencies, both directions, all derived.
    expect(project.edges).toHaveLength(16);
    expect(project.edges.every(({ derived }) => derived === true)).toBe(true);
    expect(project.edges.map(({ id }) => id)).toContain("facing.walk.n.ne");
    expect(project.edges.map(({ id }) => id)).toContain("facing.walk.n.nw");
    expect(project.ringNotes).toEqual([]);
  });

  it("plans and walks the ring once installed in the graph", () => {
    const project = parseSourceProject(readFileSync(FIXTURE));
    const engine = new MotionGraphEngine();
    engine.install({
      initialState: project.initialState,
      states: project.states.map((state) => {
        const unit = project.units.find(({ id }) => id === state.bodyUnit)!;
        if (unit.kind !== "body") throw new Error("body unit expected");
        return {
          id: state.id,
          body: {
            unitId: unit.id,
            kind: unit.playback,
            frameCount: unit.range[1] - unit.range[0],
            ports: unit.ports
          }
        };
      }),
      edges: project.edges.map((edge) => ({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        start: edge.start,
        continuity: edge.continuity,
        ...(edge.ring === undefined
          ? {}
          : { ring: edge.ring, step: edge.step ?? 1 })
      })),
      rings: (project.rings ?? []).map((ring) => ({
        id: ring.id,
        states: [...ring.states],
        cyclic: ring.cyclic,
        tieBreak: ring.tieBreak,
        maxChainedSteps: ring.maxChainedSteps
      }))
    });
    engine.beginAnimated();

    // AC2, AC3: the shorter arc, one step at a time.
    expect(engine.planFor("walk_e")).toEqual(["walk_ne", "walk_e"]);
    expect(engine.planFor("walk_w")).toEqual(["walk_nw", "walk_w"]);
    // Half a turn is the longest arc the ring allows.
    expect(engine.planFor("walk_s")).toEqual([
      "walk_ne",
      "walk_e",
      "walk_se",
      "walk_s"
    ]);

    engine.request("walk_e");
    let landed: string[] = [];
    for (let tick = 0; tick < 32; tick += 1) {
      const result = engine.tick({ contentOrdinal: BigInt(tick) });
      for (const effect of result.effects) {
        if (effect.type === "turnstep") landed.push(effect.to);
      }
      if (result.snapshot.phase === "stable") break;
    }
    expect(landed).toEqual(["walk_ne", "walk_e"]);
  });
});
