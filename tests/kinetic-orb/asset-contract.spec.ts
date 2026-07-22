import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import { SOURCE_CODEC_PRIORITY } from "@pixel-point/aval-element";
import { parseFrontIndex } from "@pixel-point/aval-format";

const EXAMPLE_PATH = resolve("examples/kinetic-orb");
const PROJECT_PATH = resolve(EXAMPLE_PATH, "motion.json");
const BUNDLE_PATH = resolve(EXAMPLE_PATH, "public/kinetic-orb");
const BUILD_PATH = resolve(BUNDLE_PATH, "build.json");
const HTML_PATH = resolve(EXAMPLE_PATH, "index.html");
const CODECS = SOURCE_CODEC_PRIORITY;

test("preserves the phase-locked graph across the preferred codec ladder", async () => {
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
      codec: typeof CODECS[number];
      codecString: string;
      path: string;
      bytes: number;
      integrity: string;
      sha256: string;
      type: string;
    }[];
    encodings: {
      codec: string;
      renditions: { id: string; width: number; height: number; crf: number }[];
    }[];
    sourceMarkup: string;
  };
  const html = await readFile(HTML_PATH, "utf8");
  const fronts = new Map<
    typeof CODECS[number],
    ReturnType<typeof parseFrontIndex>
  >();

  expect(project.encodings.map(({ codec }) => codec)).toEqual(CODECS);
  expect(project.encodings.map(({ codec, renditions }) => ({
    codec,
    crf: renditions[0]?.crf
  }))).toEqual([
    { codec: "av1", crf: 24 },
    { codec: "vp9", crf: 26 },
    { codec: "h265", crf: 20 },
    { codec: "h264", crf: 16 }
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

  expect(report.assets.map(({ codec, path }) => ({ codec, path }))).toEqual(
    CODECS.map((codec) => ({ codec, path: `${codec}.avl` }))
  );
  expect(report.encodings.map(({ codec }) => codec)).toEqual(CODECS);
  expect(report.sourceMarkup).toBe(report.assets.map((asset) =>
    `<source src="${asset.path}" data-codec="${asset.codec}" integrity="${asset.integrity}">`
  ).join("\n"));

  let previousSourceIndex = -1;
  for (const asset of report.assets) {
    const bytes = await readFile(resolve(BUNDLE_PATH, asset.path));
    const digest = createHash("sha256").update(bytes).digest();
    const front = parseFrontIndex(bytes);
    const sourceElement = `<source src="%BASE_URL%kinetic-orb/${asset.path}" ` +
      `data-codec="${asset.codec}" integrity="${asset.integrity}">`;
    const sourceIndex = html.indexOf(sourceElement);

    expect(bytes.subarray(0, 4)).toEqual(Buffer.from("AVLF"));
    expect(asset.bytes).toBe(bytes.byteLength);
    expect(asset.sha256).toBe(digest.toString("hex"));
    expect(asset.integrity).toBe(`sha256-${digest.toString("base64")}`);
    expect(asset.type).toBe(
      `application/vnd.aval; codecs="${asset.codecString}"`
    );
    expect(front.header.declaredFileLength).toBe(bytes.byteLength);
    expect(front.manifest.codec).toBe(asset.codec);
    expect(front.manifest.renditions[0]?.codec).toBe(asset.codecString);
    expect(sourceIndex).toBeGreaterThan(previousSourceIndex);
    previousSourceIndex = sourceIndex;
    fronts.set(asset.codec, front);
  }

  const front = fronts.get("h264");
  if (front === undefined) throw new Error("Missing compiled H.264 fallback asset");
  expect(front.manifest.canvas).toMatchObject({ width: 512, height: 512 });
  expect(front.manifest.frameRate).toEqual({ numerator: 24, denominator: 1 });
  expect(front.manifest.initialState).toBe(project.initialState);
  expect(front.manifest.edges).toContainEqual({
    id: "exiting.entering",
    from: "exiting",
    to: "entering",
    trigger: { type: "event", name: "hover.enter" },
    start: { type: "finish", targetPort: "default", maxWaitFrames: 11 },
    continuity: "exact-authored"
  });
  for (const candidate of fronts.values()) {
    expect(compiledTopology(candidate.manifest)).toEqual(sourceTopology(project));
  }
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
