import { describe, expect, it } from "vitest";

import { CompilerError } from "../src/diagnostics.js";
import {
  parseSourceProject,
  validateSourceProject
} from "../src/source-project-schema.js";

function project(): any {
  return {
    projectVersion: "1.0",
    alpha: "auto",
    canvas: {
      width: 1_920,
      height: 1_080,
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
    encodings: [
      {
        codec: "av1",
        bitDepth: 10,
        cpuUsed: 0,
        tiles: { columns: 4, rows: 2 },
        rowMt: true,
        threads: 32,
        renditions: [{ id: "video.1x", width: 1_920, height: "auto", crf: 15 }]
      },
      {
        codec: "vp9",
        deadline: "best",
        cpuUsed: 0,
        threads: 8,
        renditions: [{ id: "video.1x", width: 1_280, height: "auto", crf: 40 }]
      },
      {
        codec: "h265",
        preset: "veryslow",
        threads: 8,
        renditions: [{ id: "video.1x", width: "auto", height: 540, crf: 32 }]
      },
      {
        codec: "h264",
        preset: "placebo",
        renditions: [{ id: "video.1x", width: 960, height: 540, crf: 20 }]
      }
    ],
    units: [{
      id: "idle.body",
      kind: "body",
      source: "render",
      range: [0, 12],
      playback: "loop",
      ports: []
    }],
    initialState: "idle",
    states: [{ id: "idle", bodyUnit: "idle.body" }],
    edges: [],
    bindings: []
  };
}

describe("source project 1.0 schema", () => {
  it("parses the codec-major contract and preserves authored encoding order", () => {
    const parsed = parseSourceProject(
      new TextEncoder().encode(JSON.stringify(project(), null, 2))
    );

    expect(parsed).toMatchObject({
      projectVersion: "1.0",
      alpha: "auto",
      encodings: [
        { codec: "av1", renditions: [{ id: "video.1x", width: 1_920, height: 1_080 }] },
        { codec: "vp9", renditions: [{ id: "video.1x", width: 1_280, height: 720 }] },
        { codec: "h265", renditions: [{ id: "video.1x", width: 960, height: 540 }] },
        { codec: "h264", renditions: [{ id: "video.1x", width: 960, height: 540 }] }
      ]
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.encodings)).toBe(true);
    expect(Object.isFrozen(parsed.encodings[0]?.renditions)).toBe(true);
  });

  it.each(["auto", "opaque", "packed"] as const)(
    "accepts alpha policy %s",
    (alpha) => {
      const value = project();
      value.alpha = alpha;
      expect(validateSourceProject(value).alpha).toBe(alpha);
    }
  );

  it("preserves rendition order while requiring IDs unique per codec", () => {
    const value = project();
    value.encodings[0].renditions = [
      { id: "video.large", width: 1_920, height: "auto", crf: 15 },
      { id: "video.small", width: 640, height: "auto", crf: 28 }
    ];
    expect(validateSourceProject(value).encodings[0]?.renditions.map(({ id }) => id))
      .toEqual(["video.large", "video.small"]);

    value.encodings[0].renditions[1].id = "video.large";
    expect(() => validateSourceProject(value)).toThrow(CompilerError);
  });

  it("requires one unique entry per codec", () => {
    const value = project();
    value.encodings.push(structuredClone(value.encodings[0]));
    expect(() => validateSourceProject(value)).toThrow(CompilerError);
  });

  it("rejects both dimensions as auto and invalid explicit aspect ratios", () => {
    const bothAuto = project();
    bothAuto.encodings[0].renditions[0].width = "auto";
    expect(() => validateSourceProject(bothAuto)).toThrow(CompilerError);

    const wrongAspect = project();
    wrongAspect.encodings[0].renditions[0] = {
      id: "video.1x",
      width: 1_000,
      height: 1_000,
      crf: 15
    };
    expect(() => validateSourceProject(wrongAspect)).toThrow(CompilerError);
  });

  it.each(["0.1", "0.2", "0.3"])(
    "rejects removed project version %s",
    (projectVersion) => {
      const value = project();
      value.projectVersion = projectVersion;
      expect(() => validateSourceProject(value)).toThrow(CompilerError);
    }
  );

  it("rejects arbitrary FFmpeg controls", () => {
    for (const mutate of [
      (value: any) => { value.renditions = []; },
      (value: any) => { value.encodings[0].tag = "av01"; },
      (value: any) => { value.encodings[0].movflags = "faststart"; },
      (value: any) => { value.encodings[0].strict = "experimental"; },
      (value: any) => { value.encodings[0].vf = "scale=1920:-2"; },
      (value: any) => { value.encodings[0].scale = "1920:-2"; },
      (value: any) => { value.encodings[0].audio = false; },
      (value: any) => { value.encodings[0].arguments = ["-an"]; }
    ]) {
      const value = project();
      mutate(value);
      expect(() => validateSourceProject(value)).toThrow(CompilerError);
    }
  });

  it("rejects duplicate JSON keys, unknown fields, unsafe paths, and bad graph references", () => {
    expect(() => parseSourceProject(new TextEncoder().encode(
      '{"projectVersion":"1.0","projectVersion":"1.0"}'
    ))).toThrow(CompilerError);

    for (const mutate of [
      (value: any) => { value.unknown = true; },
      (value: any) => { value.sources[0].path = "../escape.mp4"; },
      (value: any) => { value.units[0].id = "INVALID"; },
      (value: any) => { value.units[0].range = [10, 10]; },
      (value: any) => { value.initialState = "missing"; }
    ]) {
      const value = project();
      mutate(value);
      expect(() => validateSourceProject(value)).toThrow(CompilerError);
    }
  });

  it("rejects oversized collections before traversing them", () => {
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
