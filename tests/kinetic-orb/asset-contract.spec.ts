import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import { parseFrontIndex } from "@pixel-point/aval-format";

const EXAMPLE_PATH = resolve("examples/kinetic-orb");
const PROJECT_PATH = resolve(EXAMPLE_PATH, "motion.json");
const BUILD_PATH = resolve(EXAMPLE_PATH, "public/kinetic-orb/build.json");
const ASSET_PATH = resolve(EXAMPLE_PATH, "public/kinetic-orb/h264.avl");
const HTML_PATH = resolve(EXAMPLE_PATH, "index.html");

test("preserves the phase-locked H.264 graph", async () => {
  const project = JSON.parse(await readFile(PROJECT_PATH, "utf8")) as {
    encodings: {
      codec: string;
      renditions: { id: string; width: number; height: number; crf: number }[];
    }[];
    units: {
      id: string;
      kind: "one-shot" | "body";
      range: [number, number];
      playback?: "finite" | "loop";
      ports?: {
        id: string;
        entryFrame: number;
        portalFrames: number[];
      }[];
    }[];
    initialState: string;
    states: {
      id: string;
      bodyUnit: string;
      initialUnit?: string;
    }[];
    edges: {
      id: string;
      from: string;
      to: string;
      trigger: { type: "completion" } | { type: "event"; name: string };
      start: {
        maxWaitFrames: number;
        type: "finish" | "portal";
        sourcePort?: string;
        targetPort: string;
      };
      continuity: string;
    }[];
    bindings: { source: string; event: string }[];
  };
  const report = JSON.parse(await readFile(BUILD_PATH, "utf8")) as {
    assets: {
      codec: string;
      path: string;
      bytes: number;
      integrity: string;
      sha256: string;
    }[];
    encodings: {
      codec: string;
      renditions: { id: string; width: number; height: number; crf: number }[];
    }[];
  };
  const bytes = await readFile(ASSET_PATH);
  const html = await readFile(HTML_PATH, "utf8");
  const front = parseFrontIndex(bytes);

  expect(project.encodings.map(({ codec }) => codec)).toEqual(["h264"]);
  expect(project.encodings[0]?.renditions).toEqual([
    { id: "video.1x", width: 512, height: 512, crf: 16 }
  ]);
  expect(project.units.map(({ id, range }) => ({ id, range }))).toEqual([
    { id: "intro", range: [0, 24] },
    { id: "idle-loop", range: [24, 48] },
    { id: "hover-in", range: [48, 60] },
    { id: "hover-loop", range: [60, 84] },
    { id: "hover-out", range: [84, 96] }
  ]);

  const densePortals = [2, 5, 8, 11, 14, 17, 20, 23];
  expect(project.units.find(({ id }) => id === "idle-loop")?.ports?.[0]?.portalFrames)
    .toEqual(densePortals);
  expect(project.units.find(({ id }) => id === "hover-loop")?.ports?.[0]?.portalFrames)
    .toEqual(densePortals);
  expect(project.edges
    .filter(({ start }) => start.type === "portal")
    .map(({ id, start }) => ({ id, wait: start.maxWaitFrames })))
    .toEqual([
      { id: "idle.entering", wait: 2 },
      { id: "hover.exiting", wait: 2 }
    ]);

  expect(report.assets).toHaveLength(1);
  expect(report.assets[0]).toMatchObject({ codec: "h264", path: "h264.avl" });
  expect(report.encodings[0]?.renditions).toEqual([
    { id: "video.1x", width: 512, height: 512, crf: 16 }
  ]);
  expect(report.assets[0]?.bytes).toBe(bytes.byteLength);
  const digest = createHash("sha256").update(bytes).digest();
  expect(report.assets[0]?.sha256).toBe(digest.toString("hex"));
  expect(report.assets[0]?.integrity).toBe(`sha256-${digest.toString("base64")}`);
  expect(html).toContain(`integrity="${report.assets[0]?.integrity}"`);
  expect(front.manifest.canvas).toMatchObject({ width: 512, height: 512 });
  expect(front.manifest.frameRate).toEqual({ numerator: 24, denominator: 1 });
  expect(front.manifest.initialState).toBe(project.initialState);
  expect(compiledTopology(front.manifest)).toEqual(sourceTopology(project));
});

function sourceTopology(project: Readonly<{
  units: readonly Readonly<{
    id: string;
    kind: "one-shot" | "body";
    range: readonly [number, number];
    playback?: "finite" | "loop";
    ports?: readonly Readonly<{
      id: string;
      entryFrame: number;
      portalFrames: readonly number[];
    }>[];
  }>[];
  states: readonly Readonly<{
    id: string;
    bodyUnit: string;
    initialUnit?: string;
  }>[];
  edges: readonly Readonly<{
    id: string;
    from: string;
    to: string;
    trigger: Readonly<{ type: "completion" }> |
      Readonly<{ type: "event"; name: string }>;
    start: Readonly<{
      maxWaitFrames: number;
      type: "finish" | "portal";
      sourcePort?: string;
      targetPort: string;
    }>;
    continuity: string;
  }>[];
  bindings: readonly Readonly<{ source: string; event: string }>[];
}>): unknown {
  return {
    units: project.units.map((unit) => ({
      id: unit.id,
      kind: unit.kind,
      ...(unit.playback === undefined ? {} : { playback: unit.playback }),
      frameCount: unit.range[1] - unit.range[0],
      ...(unit.ports === undefined ? {} : { ports: unit.ports })
    })).sort(byId),
    states: [...project.states].sort(byId),
    edges: [...project.edges].sort(byId),
    bindings: [...project.bindings].sort(bindingOrder)
  };
}

function compiledTopology(
  manifest: ReturnType<typeof parseFrontIndex>["manifest"]
): unknown {
  return {
    units: manifest.units.map((unit) => ({
      id: unit.id,
      kind: unit.kind,
      ...(unit.kind === "body" ? { playback: unit.playback } : {}),
      frameCount: unit.frameCount,
      ...("ports" in unit ? { ports: unit.ports } : {})
    })).sort(byId),
    states: [...manifest.states].map((state) => ({
      id: state.id,
      bodyUnit: state.bodyUnit,
      ...(state.initialUnit === undefined ? {} : { initialUnit: state.initialUnit })
    })).sort(byId),
    edges: [...manifest.edges].map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      trigger: edge.trigger,
      start: edge.start,
      continuity: edge.continuity
    })).sort(byId),
    bindings: [...manifest.bindings].sort(bindingOrder)
  };
}

function byId(left: Readonly<{ id: string }>, right: Readonly<{ id: string }>): number {
  return left.id.localeCompare(right.id);
}

function bindingOrder(
  left: Readonly<{ source: string; event: string }>,
  right: Readonly<{ source: string; event: string }>
): number {
  return left.source.localeCompare(right.source) || left.event.localeCompare(right.event);
}
