import { describe, expect, it } from "vitest";

import { CompilerError } from "../src/diagnostics.js";
import {
  parseSourceProject,
  validateSourceProject
} from "../src/source-project-schema.js";

function project(): any {
  return {
    projectVersion: "0.1",
    profile: "avc-annexb-opaque-v0",
    canvas: {
      width: 32,
      height: 32,
      fit: "contain",
      pixelAspect: [1, 1],
      colorSpace: "srgb"
    },
    frameRate: { numerator: 30, denominator: 1 },
    sources: [{
      id: "source",
      type: "video",
      path: "render.mp4",
      timing: { mode: "exact" }
    }],
    renditions: [{
      id: "opaque",
      codedWidth: 32,
      codedHeight: 32,
      bitrate: { average: 300000, peak: 600000 }
    }],
    units: [{
      id: "idle-loop",
      kind: "body",
      source: "source",
      range: [0, 12],
      playback: "loop",
      ports: []
    }],
    initialState: "idle",
    states: [{ id: "idle", bodyUnit: "idle-loop" }],
    edges: [],
    bindings: []
  };
}

describe("source project schema", () => {
  it("parses strict noncanonical JSON into a sorted frozen project", () => {
    const value = project();
    value.sources.unshift({
      id: "later",
      type: "video",
      path: "later.mov",
      timing: { mode: "exact" }
    });
    value.units.unshift({
      id: "later-shot",
      kind: "one-shot",
      source: "later",
      range: [0, 1]
    });
    value.states[0].initialUnit = "later-shot";
    const parsed = parseSourceProject(
      new TextEncoder().encode(JSON.stringify(value, null, 2))
    );
    expect(parsed.sources.map(({ id }) => id)).toEqual(["later", "source"]);
    expect(parsed.units.map(({ id }) => id)).toEqual(["idle-loop", "later-shot"]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.units)).toBe(true);
  });

  it("accepts an explicit poster selector", () => {
    const value = project();
    value.states[0].poster = { source: "source", frame: 3 };
    expect(validateSourceProject(value).states[0]?.poster).toEqual({
      source: "source",
      frame: 3
    });
  });

  it("rejects duplicate JSON keys, unknown fields, paths, IDs, and bad geometry", () => {
    expect(() => parseSourceProject(new TextEncoder().encode(
      '{"projectVersion":"0.1","projectVersion":"0.1"}'
    ))).toThrow(CompilerError);

    const cases: ((value: any) => void)[] = [
      (value) => { value.unknown = true; },
      (value) => { value.sources[0].path = "../escape.mp4"; },
      (value) => { value.units[0].id = "INVALID"; },
      (value) => { value.canvas.width = 30; },
      (value) => { value.renditions[0].codedWidth = 48; },
      (value) => { value.units[0].range = [10, 10]; },
      (value) => { value.initialState = "missing"; }
    ];
    for (const mutate of cases) {
      const value = project();
      mutate(value);
      expect(() => validateSourceProject(value)).toThrow(CompilerError);
    }
  });

  it("rejects oversized top-level collections before traversing them", () => {
    const value = project();
    let probes = 0;
    value.states = new Proxy(Array(1_000_000), {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/u.test(property)) probes += 1;
        return Reflect.get(target, property, receiver);
      }
    });
    expect(() => validateSourceProject(value)).toThrow(CompilerError);
    expect(probes).toBe(0);
  });
});
