import { describe, expect, it } from "vitest";

import { CompilerError } from "../src/diagnostics.js";
import { validateSourceProject } from "../src/source-project-schema.js";

const FACINGS = Object.freeze([
  "walk_n",
  "walk_ne",
  "walk_e",
  "walk_se",
  "walk_s",
  "walk_sw",
  "walk_w",
  "walk_nw"
]);

/** An eight-way facing ring over one shared source, in cut mode. */
function ringProject(): any {
  return {
    projectVersion: "1.0",
    alpha: "auto",
    canvas: {
      width: 256,
      height: 256,
      fit: "contain",
      pixelAspect: [1, 1],
      colorSpace: "srgb"
    },
    frameRate: { numerator: 30, denominator: 1 },
    sources: [{
      id: "render",
      type: "video",
      path: "render.mov",
      timing: { mode: "exact" }
    }],
    encodings: [{
      codec: "h264",
      preset: "slow",
      renditions: [{ id: "video.1x", width: 256, height: 256, crf: 20 }]
    }],
    units: FACINGS.map((facing, index) => ({
      id: `${facing}.body`,
      kind: "body",
      source: "render",
      range: [index * 8, index * 8 + 8],
      playback: "loop",
      ports: [{ id: "default", entryFrame: 0, portalFrames: [0, 4] }]
    })),
    initialState: "walk_n",
    states: FACINGS.map((facing) => ({
      id: facing,
      bodyUnit: `${facing}.body`
    })),
    edges: [],
    bindings: [],
    rings: [{
      id: "facing.walk",
      states: [...FACINGS],
      cyclic: true,
      tieBreak: "forward",
      turn: {
        mode: "cut",
        start: {
          type: "portal",
          sourcePort: "default",
          targetPort: "default",
          maxWaitFrames: 8
        },
        continuity: "exact-authored"
      },
      maxChainedSteps: 4
    }]
  };
}

function expectInvalid(value: unknown, pattern: RegExp): CompilerError {
  try {
    validateSourceProject(value);
  } catch (error) {
    expect(error).toBeInstanceOf(CompilerError);
    expect((error as CompilerError).message).toMatch(pattern);
    return error as CompilerError;
  }
  throw new Error("expected project validation to fail");
}

describe("ring expansion", () => {
  it("derives two turn edges per adjacency of a cyclic ring", () => {
    const project = validateSourceProject(ringProject());

    // AC1: eight members, eight adjacencies, both directions.
    expect(project.edges).toHaveLength(16);
    expect(project.edges.every((edge) => edge.derived === true)).toBe(true);
    expect(project.edges.every((edge) => edge.kind === "turn")).toBe(true);
    expect(project.edges.every((edge) => edge.ring === "facing.walk")).toBe(true);
    expect(project.edges.filter((edge) => edge.step === 1)).toHaveLength(8);
    expect(project.edges.filter((edge) => edge.step === -1)).toHaveLength(8);
    expect(project.ringNotes).toEqual([]);
  });

  it("names a derived step by its ring and the members' distinct suffixes", () => {
    const project = validateSourceProject(ringProject());

    expect(project.edges.map(({ id }) => id)).toContain("facing.walk.n.ne");
    expect(project.edges.map(({ id }) => id)).toContain("facing.walk.nw.n");
    expect(project.edges.find(({ id }) => id === "facing.walk.n.ne")).toEqual({
      id: "facing.walk.n.ne",
      from: "walk_n",
      to: "walk_ne",
      kind: "turn",
      ring: "facing.walk",
      step: 1,
      derived: true,
      start: {
        type: "portal",
        sourcePort: "default",
        targetPort: "default",
        maxWaitFrames: 8
      },
      continuity: "exact-authored"
    });
    expect(project.edges.map(({ id }) => id))
      .toEqual([...project.edges.map(({ id }) => id)].sort());
  });

  it("derives one edge per adjacency direction on a non-cyclic ring", () => {
    const value = ringProject();
    value.rings[0].cyclic = false;
    const project = validateSourceProject(value);

    expect(project.edges).toHaveLength(14);
    expect(project.edges.map(({ id }) => id)).not.toContain("facing.walk.nw.n");
  });

  it("lets an authored edge shadow the step it replaces and notes it", () => {
    const value = ringProject();
    value.units.push({
      id: "pivot.nw.n",
      kind: "bridge",
      source: "render",
      range: [64, 68]
    });
    value.edges.push({
      id: "pivot.nw.n.edge",
      from: "walk_nw",
      to: "walk_n",
      start: {
        type: "portal",
        sourcePort: "default",
        targetPort: "default",
        maxWaitFrames: 8
      },
      transition: { kind: "locked", unit: "pivot.nw.n" },
      continuity: "exact-authored"
    });
    const project = validateSourceProject(value);

    // AC6: the authored edge wins and the shadowed step is reported.
    expect(project.edges).toHaveLength(16);
    expect(project.edges.map(({ id }) => id)).toContain("pivot.nw.n.edge");
    expect(project.edges.map(({ id }) => id)).not.toContain("facing.walk.nw.n");
    expect(project.ringNotes).toEqual([
      "ring facing.walk step walk_nw to walk_n is shadowed by authored edge pivot.nw.n.edge"
    ]);
  });

  it("gives a step its own bridge unit through an override", () => {
    const value = ringProject();
    value.units.push({
      id: "pivot.n.ne",
      kind: "bridge",
      source: "render",
      range: [64, 68]
    });
    value.rings[0].overrides = [
      { from: "walk_n", to: "walk_ne", mode: "unit", unit: "pivot.n.ne" }
    ];
    const project = validateSourceProject(value);

    expect(project.edges.find(({ id }) => id === "facing.walk.n.ne"))
      .toMatchObject({ transition: { kind: "locked", unit: "pivot.n.ne" } });
    expect(project.edges.find(({ id }) => id === "facing.walk.ne.e"))
      .not.toHaveProperty("transition");
  });

  it("accepts an authored turn edge which names its ring adjacency", () => {
    const value = ringProject();
    value.rings[0].states = ["walk_n", "walk_ne", "walk_e"];
    value.rings[0].cyclic = false;
    value.rings[0].maxChainedSteps = 2;
    value.states = value.states.slice(0, 3);
    value.units = value.units.slice(0, 3);
    value.edges.push({
      id: "explicit.e.se",
      kind: "turn",
      ring: "facing.walk",
      step: 1,
      from: "walk_ne",
      to: "walk_e",
      start: {
        type: "portal",
        sourcePort: "default",
        targetPort: "default",
        maxWaitFrames: 8
      },
      continuity: "exact-authored"
    });
    const project = validateSourceProject(value);

    expect(project.edges).toHaveLength(4);
    expect(project.rings?.[0]?.states).toEqual(["walk_n", "walk_ne", "walk_e"]);
  });

  it("rejects every unusable ring at compile time", () => {
    // V1: a member which is not a state.
    const unknownState = ringProject();
    unknownState.rings[0].states = [...FACINGS, "sprint"];
    expectInvalid(
      unknownState,
      /rings\.facing\.walk references unknown state sprint/u
    );

    // V2: a member repeated inside one ring.
    const duplicated = ringProject();
    duplicated.rings[0].states = [...FACINGS, "walk_n"];
    expectInvalid(duplicated, /rings\.facing\.walk duplicates state walk_n/u);

    // V3: too few members to be an axis at all, or to close a cycle.
    const single = ringProject();
    single.rings[0].states = ["walk_n"];
    expectInvalid(
      single,
      /rings\.facing\.walk must contain at least 2 states, not 1/u
    );
    const openPair = ringProject();
    openPair.rings[0].states = ["walk_n", "walk_ne"];
    openPair.rings[0].maxChainedSteps = 1;
    expectInvalid(
      openPair,
      /rings\.facing\.walk is cyclic and must contain at least 3 states, not 2/u
    );

    // V4: ring-level unit mode with no per-step units.
    const unitMode = ringProject();
    unitMode.rings[0].turn.mode = "unit";
    expectInvalid(
      unitMode,
      /rings\.facing\.walk turn mode unit needs a per-step unit override; 16 step\(s\) have none, starting at walk_n to walk_ne/u
    );

    // V5: an override on a pair which is not adjacent.
    const strayOverride = ringProject();
    strayOverride.rings[0].overrides = [
      { from: "walk_n", to: "walk_s", mode: "cut" }
    ];
    expectInvalid(
      strayOverride,
      /rings\.facing\.walk override walk_n to walk_s is not an adjacent step/u
    );

    // V6: an authored turn edge whose ring or adjacency does not exist.
    const unknownRing = ringProject();
    unknownRing.edges.push({
      id: "explicit.turn",
      kind: "turn",
      ring: "facing.absent",
      step: 1,
      from: "walk_n",
      to: "walk_ne",
      start: {
        type: "portal",
        sourcePort: "default",
        targetPort: "default",
        maxWaitFrames: 8
      },
      continuity: "exact-authored"
    });
    expectInvalid(
      unknownRing,
      /edges\.explicit\.turn references unknown ring facing\.absent/u
    );
    const nonAdjacent = ringProject();
    nonAdjacent.edges.push({
      id: "explicit.turn",
      kind: "turn",
      ring: "facing.walk",
      step: 1,
      from: "walk_n",
      to: "walk_s",
      start: {
        type: "portal",
        sourcePort: "default",
        targetPort: "default",
        maxWaitFrames: 8
      },
      continuity: "exact-authored"
    });
    expectInvalid(
      nonAdjacent,
      /edges\.explicit\.turn is not an adjacent step of ring facing\.walk from walk_n to walk_s/u
    );

    // V7: two rings deriving a step between the same pair.
    const overlapping = ringProject();
    overlapping.rings.push({
      ...structuredClone(overlapping.rings[0]),
      id: "facing.other",
      states: ["walk_n", "walk_ne", "walk_e"],
      cyclic: false,
      maxChainedSteps: 2
    });
    expectInvalid(
      overlapping,
      /rings\.facing\.walk steps from walk_n to walk_ne, which ring facing\.other already derives/u
    );

    // V8: a cut-mode step whose bodies share no compatible port.
    const missingPort = ringProject();
    missingPort.units[2].ports = [
      { id: "handoff", entryFrame: 0, portalFrames: [0, 4] }
    ];
    expectInvalid(
      missingPort,
      /rings\.facing\.walk step walk_ne to walk_e needs port default on walk_e/u
    );
  });

  it("leaves a project which authors no ring untouched", () => {
    const value = ringProject();
    delete value.rings;
    value.states = value.states.slice(0, 1);
    value.units = value.units.slice(0, 1);

    const project = validateSourceProject(value);

    // AC10: no rings authored, nothing added, nothing to report.
    expect(project.edges).toEqual([]);
    expect(project.rings).toBeUndefined();
    expect(project.ringNotes).toBeUndefined();
  });
});
