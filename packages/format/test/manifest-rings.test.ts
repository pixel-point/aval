import { describe, expect, it } from "vitest";

import { FormatError } from "../src/errors.js";
import { adaptManifestToMotionGraph } from "../src/graph-adapter.js";
import { validateCompiledManifest } from "../src/manifest-schema.js";
import { validManifest } from "./manifest-fixture.js";

/** The fixture graph plus the one edge a fully cyclic three-state ring needs. */
function ringManifest(): Record<string, any> {
  const manifest = structuredClone(validManifest()) as Record<string, any>;
  // Edges stay sorted by id, so the new step belongs before "edge-cb".
  manifest.edges.splice(4, 0, {
    id: "edge-ca",
    from: "a-c",
    to: "a-a",
    start: {
      type: "portal",
      sourcePort: "default",
      targetPort: "default",
      maxWaitFrames: 0
    },
    continuity: "exact-authored",
    ring: "facing",
    step: 1,
    derived: true
  });
  manifest.edges[0].ring = "facing";
  manifest.edges[0].step = 1;
  manifest.rings = [
    {
      id: "facing",
      states: ["a-a", "a-b", "a-c"],
      cyclic: true,
      tieBreak: "forward",
      maxChainedSteps: 2
    }
  ];
  return manifest;
}

function expectInvalid(value: unknown, pattern: RegExp): FormatError {
  try {
    validateCompiledManifest(value);
  } catch (error) {
    expect(error).toBeInstanceOf(FormatError);
    expect((error as FormatError).code).toBe("MANIFEST_INVALID");
    expect((error as FormatError).message).toMatch(pattern);
    return error as FormatError;
  }
  throw new Error("expected manifest validation to fail");
}

describe("compiled manifest rings", () => {
  it("accepts a cyclic ring and preserves its authored member order", () => {
    const manifest = validateCompiledManifest(ringManifest());

    expect(manifest.rings).toEqual([
      {
        id: "facing",
        states: ["a-a", "a-b", "a-c"],
        cyclic: true,
        tieBreak: "forward",
        maxChainedSteps: 2
      }
    ]);
    expect(Object.isFrozen(manifest.rings)).toBe(true);
    expect(Object.isFrozen(manifest.rings?.[0]?.states)).toBe(true);
    expect(manifest.edges.find(({ id }) => id === "edge-ca")).toMatchObject({
      ring: "facing",
      step: 1,
      derived: true
    });
  });

  it("omits the key entirely for a manifest which authors no ring", () => {
    const manifest = validateCompiledManifest(validManifest());

    // AC10: an asset without rings is byte-identical to one compiled before
    // rings existed, so the key must be absent rather than empty.
    expect("rings" in manifest).toBe(false);
    expect(manifest.rings).toBeUndefined();
  });

  it("carries the ring and its steps into the motion graph", () => {
    const graph = adaptManifestToMotionGraph(
      validateCompiledManifest(ringManifest())
    );

    expect(graph.definition.rings).toEqual([
      {
        id: "facing",
        states: ["a-a", "a-b", "a-c"],
        cyclic: true,
        tieBreak: "forward",
        maxChainedSteps: 2
      }
    ]);
    expect(graph.definition.edges.find(({ id }) => id === "edge-ca"))
      .toMatchObject({ ring: "facing", step: 1 });
    // Provenance stays in the asset; the runtime only needs the axis.
    expect(graph.definition.edges.find(({ id }) => id === "edge-ca"))
      .not.toHaveProperty("derived");
  });

  it("rejects a ring whose members or adjacencies are unusable", () => {
    const unknownState = ringManifest();
    unknownState.rings[0].states = ["a-a", "a-b", "missing"];
    expectInvalid(unknownState, /ring "facing" references unknown state "missing"/u);

    const duplicated = ringManifest();
    duplicated.rings[0].states = ["a-a", "a-b", "a-a"];
    expectInvalid(duplicated, /rings\[0\]\.states must be unique/u);

    const tooShort = ringManifest();
    tooShort.rings[0].states = ["a-a", "a-b"];
    expectInvalid(tooShort, /must contain 3 states when cyclic/u);

    const missingStep = ringManifest();
    missingStep.edges = missingStep.edges.filter(
      (edge: Record<string, unknown>) => edge.id !== "edge-ca"
    );
    expectInvalid(
      missingStep,
      /ring "facing" has no edge from "a-c" to "a-a"/u
    );

    const emptyRings = ringManifest();
    emptyRings.rings = [];
    expectInvalid(emptyRings, /rings/u);
  });

  it("rejects turn membership which contradicts the ring", () => {
    const conflictingRing = ringManifest();
    conflictingRing.edges[1].ring = "other";
    conflictingRing.edges[1].step = -1;
    expectInvalid(
      conflictingRing,
      /edge "edge-ac" declares ring "other" inside ring "facing"/u
    );

    const strayRing = ringManifest();
    delete strayRing.rings;
    expectInvalid(strayRing, /does not reference a ring/u);

    const wrongStep = ringManifest();
    wrongStep.edges[2].ring = "facing";
    wrongStep.edges[2].step = 1;
    expectInvalid(wrongStep, /must declare step -1 in ring "facing"/u);

    const stepWithoutRing = ringManifest();
    delete stepWithoutRing.edges[0].ring;
    expectInvalid(stepWithoutRing, /is required by step/u);

    const derivedWithoutRing = ringManifest();
    delete derivedWithoutRing.edges[0].ring;
    delete derivedWithoutRing.edges[0].step;
    derivedWithoutRing.edges[0].derived = true;
    expectInvalid(derivedWithoutRing, /requires ring membership/u);

    const badStep = ringManifest();
    badStep.edges[0].step = 2;
    expectInvalid(badStep, /must be 1 or -1/u);
  });
});
