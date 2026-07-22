import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type {
  CompileBundleReport,
  NormalizedVideoEncoding,
  SourceProject
} from "@pixel-point/aval-compiler";
import { SOURCE_CODEC_PRIORITY } from "@pixel-point/aval-element";
import {
  parseFrontIndex,
  parseVideoCodecString,
  validateCompleteAsset,
  type ParsedFrontIndex,
  type Unit,
  type VideoBitstream,
  type VideoCodec
} from "@pixel-point/aval-format";
import { describe, expect, it } from "vitest";

const ROOT = resolve(".");
const EXAMPLE_ROOT = join(ROOT, "examples", "grass-rabbit-codecs");
const PROJECT_PATH = join(EXAMPLE_ROOT, "motion.json");
const SOURCE_PATH = join(
  EXAMPLE_ROOT,
  "source",
  "grass-test-with-intro.mp4"
);
const BUNDLE_ROOT = join(EXAMPLE_ROOT, "public", "grass-rabbit");
const REPORT_PATH = join(BUNDLE_ROOT, "build.json");
const COMPILE_COMMAND = "npm run compile:grass-rabbit-codecs";

const SOURCE_BYTES = 7_321_326;
const SOURCE_SHA256 =
  "546acee64cc36c13f8765e215a0a20fb5742026c57364c59560fa86bb68988b1";
const TOTAL_SOURCE_FRAMES = 311;
const CODECS = SOURCE_CODEC_PRIORITY satisfies readonly VideoCodec[];
const BITSTREAMS = Object.freeze({
  av1: "low-overhead",
  vp9: "frame",
  h265: "annex-b",
  h264: "annex-b"
} satisfies Readonly<Record<VideoCodec, VideoBitstream>>);
const BIT_DEPTHS = Object.freeze({
  av1: 10,
  vp9: 8,
  h265: 8,
  h264: 8
} as const satisfies Readonly<Record<VideoCodec, 8 | 10>>);

const EXPECTED_ENCODINGS = Object.freeze([
  Object.freeze({
    codec: "av1" as const,
    bitDepth: 10 as const,
    cpuUsed: 0,
    tiles: Object.freeze({ columns: 4, rows: 2 }),
    rowMt: true,
    threads: 32,
    renditions: Object.freeze([
      Object.freeze({ id: "video.1x", width: 1280, height: 720, crf: 48 })
    ])
  }),
  Object.freeze({
    codec: "vp9" as const,
    deadline: "best" as const,
    cpuUsed: 0,
    threads: 8,
    renditions: Object.freeze([
      Object.freeze({ id: "video.1x", width: 1280, height: 720, crf: 44 })
    ])
  }),
  Object.freeze({
    codec: "h265" as const,
    preset: "veryslow" as const,
    threads: 8,
    renditions: Object.freeze([
      Object.freeze({ id: "video.1x", width: 1280, height: 720, crf: 34 })
    ])
  }),
  Object.freeze({
    codec: "h264" as const,
    preset: "veryslow" as const,
    renditions: Object.freeze([
      Object.freeze({ id: "video.1x", width: 1280, height: 720, crf: 30 })
    ])
  })
] satisfies readonly NormalizedVideoEncoding[]);

describe("grass-rabbit native multi-codec artifacts", () => {
  it("publishes one equivalent 1280x720 graph for every ordered codec", async () => {
    const project = JSON.parse(await readFile(PROJECT_PATH, "utf8")) as SourceProject;
    assertAuthoredProject(project);

    const sourceMetadata = await stat(SOURCE_PATH);
    const source = new Uint8Array(await readFile(SOURCE_PATH));
    expect(sourceMetadata.isFile()).toBe(true);
    expect(sourceMetadata.size).toBe(SOURCE_BYTES);
    expect(source.byteLength).toBe(SOURCE_BYTES);
    expect(sha256(source)).toBe(SOURCE_SHA256);

    const reportMetadata = await statRequiredArtifact(REPORT_PATH);
    const reportBytes = await readRequiredArtifact(REPORT_PATH);
    expect(reportMetadata.isFile()).toBe(true);
    expect(reportMetadata.size).toBe(reportBytes.byteLength);
    const report = JSON.parse(
      new TextDecoder().decode(reportBytes)
    ) as CompileBundleReport;
    expect(report.reportVersion).toBe("1.0");
    expect(report.warnings).toEqual([]);
    expect(report.encodings).toEqual(EXPECTED_ENCODINGS);
    expect(report.assets.map(({ codec, path }) => ({ codec, path }))).toEqual(
      CODECS.map((codec) => ({ codec, path: `${codec}.avl` }))
    );
    expect(report.sourceMarkup).toBe(report.assets.map(sourceElement).join("\n"));

    const fronts = new Map<VideoCodec, Readonly<ParsedFrontIndex>>();
    for (const codec of CODECS) {
      const reported = report.assets.find((asset) => asset.codec === codec);
      expect(reported, `build.json is missing its ${codec} asset`).toBeDefined();
      if (reported === undefined) throw new Error(`Missing ${codec} report asset`);

      const path = join(BUNDLE_ROOT, reported.path);
      const metadata = await statRequiredArtifact(path);
      const bytes = await readRequiredArtifact(path);
      expect(metadata.isFile()).toBe(true);
      expect(metadata.size).toBe(reported.bytes);
      expect(bytes.byteLength).toBe(reported.bytes);
      expect(sha256(bytes)).toBe(reported.sha256);
      expect(reported.integrity).toBe(sha256Integrity(bytes));

      const front = parseFrontIndex(bytes);
      validateCompleteAsset({ bytes, frontIndex: front });
      fronts.set(codec, front);
      expect(front.header.declaredFileLength).toBe(reported.bytes);
      expect(front.header).toMatchObject({ major: 1, minor: 1 });
      expect(front.manifest).toMatchObject({
        formatVersion: "1.1",
        codec,
        bitstream: BITSTREAMS[codec],
        layout: "opaque",
        canvas: EXPECTED_CANVAS,
        frameRate: EXPECTED_FRAME_RATE
      });
      expect(front.manifest.renditions).toHaveLength(1);
      const rendition = front.manifest.renditions[0]!;
      expect("outputQualification" in rendition).toBe(false);
      expect(parseVideoCodecString(rendition.codec)?.family).toBe(codec);
      expect(reported.codecString).toBe(rendition.codec);
      if (codec === "h264") {
        expect(rendition.codec).toBe("avc1.42E01F");
      }
      expect(reported.type).toBe(
        `application/vnd.aval; codecs="${rendition.codec}"`
      );
      expect(rendition).toMatchObject({
        id: "video.1x",
        bitDepth: BIT_DEPTHS[codec],
        codedWidth: 1280,
        codedHeight: 720,
        alphaLayout: {
          type: "opaque",
          colorRect: [0, 0, 1280, 720]
        }
      });
    }

    const baseline = requireFront(fronts, "av1");
    expect(semanticUnits(baseline.manifest.units)).toEqual(
      EXPECTED_COMPILED_UNITS
    );
    expect(totalCompiledFrames(baseline.manifest.units)).toBe(
      TOTAL_SOURCE_FRAMES
    );
    expect(baseline.manifest.initialState).toBe("idle");
    expect(baseline.manifest.states).toEqual(EXPECTED_STATES);
    expect(baseline.manifest.edges).toEqual(EXPECTED_EDGES);
    expect(baseline.manifest.bindings).toEqual(EXPECTED_BINDINGS);
    expect(baseline.manifest.readiness).toEqual(EXPECTED_READINESS);
    expect(baseline.graph.definition).toEqual(EXPECTED_GRAPH_DEFINITION);

    for (const codec of CODECS.slice(1)) {
      const current = requireFront(fronts, codec);
      expect(semanticUnits(current.manifest.units)).toEqual(
        semanticUnits(baseline.manifest.units)
      );
      expect(current.manifest.states).toEqual(baseline.manifest.states);
      expect(current.manifest.edges).toEqual(baseline.manifest.edges);
      expect(current.manifest.bindings).toEqual(baseline.manifest.bindings);
      expect(current.manifest.readiness).toEqual(baseline.manifest.readiness);
      expect(current.manifest.canvas).toEqual(baseline.manifest.canvas);
      expect(current.manifest.frameRate).toEqual(baseline.manifest.frameRate);
      expect(current.graph).toEqual(baseline.graph);
    }
  });
});

const EXPECTED_CANVAS = Object.freeze({
  width: 1280,
  height: 720,
  fit: "contain" as const,
  pixelAspect: Object.freeze([1, 1] as const),
  colorSpace: "srgb" as const
});
const EXPECTED_FRAME_RATE = Object.freeze({ numerator: 24, denominator: 1 });

const EXPECTED_SOURCE_UNITS = Object.freeze([
  Object.freeze({ id: "intro", kind: "one-shot", source: "rabbit", range: [0, 30] }),
  Object.freeze({
    id: "idle-loop",
    kind: "body",
    source: "rabbit",
    range: [30, 100],
    playback: "loop",
    ports: [{ id: "default", entryFrame: 0, portalFrames: [69] }]
  }),
  Object.freeze({
    id: "hover-in",
    kind: "body",
    source: "rabbit",
    range: [100, 167],
    playback: "finite",
    ports: [{ id: "default", entryFrame: 0, portalFrames: [66] }]
  }),
  Object.freeze({
    id: "hover-loop",
    kind: "body",
    source: "rabbit",
    range: [167, 263],
    playback: "loop",
    ports: [{ id: "default", entryFrame: 0, portalFrames: [95] }]
  }),
  Object.freeze({
    id: "hover-out",
    kind: "body",
    source: "rabbit",
    range: [263, 311],
    playback: "finite",
    ports: [{ id: "default", entryFrame: 0, portalFrames: [47] }]
  })
]);

const EXPECTED_COMPILED_UNITS = Object.freeze([
  Object.freeze({
    id: "hover-in",
    kind: "body",
    frameCount: 67,
    playback: "finite",
    ports: [{ id: "default", entryFrame: 0, portalFrames: [66] }]
  }),
  Object.freeze({
    id: "hover-loop",
    kind: "body",
    frameCount: 96,
    playback: "loop",
    ports: [{ id: "default", entryFrame: 0, portalFrames: [95] }]
  }),
  Object.freeze({
    id: "hover-out",
    kind: "body",
    frameCount: 48,
    playback: "finite",
    ports: [{ id: "default", entryFrame: 0, portalFrames: [47] }]
  }),
  Object.freeze({
    id: "idle-loop",
    kind: "body",
    frameCount: 70,
    playback: "loop",
    ports: [{ id: "default", entryFrame: 0, portalFrames: [69] }]
  }),
  Object.freeze({ id: "intro", kind: "one-shot", frameCount: 30 })
]);

const EXPECTED_STATES = Object.freeze([
  Object.freeze({ id: "entering", bodyUnit: "hover-in" }),
  Object.freeze({ id: "exiting", bodyUnit: "hover-out" }),
  Object.freeze({ id: "hover", bodyUnit: "hover-loop" }),
  Object.freeze({ id: "idle", bodyUnit: "idle-loop", initialUnit: "intro" })
]);

const EXPECTED_EDGES = Object.freeze([
  Object.freeze({
    id: "entering.exiting",
    from: "entering",
    to: "exiting",
    trigger: { type: "event", name: "hover.leave" },
    start: { type: "finish", targetPort: "default", maxWaitFrames: 66 },
    continuity: "exact-authored"
  }),
  Object.freeze({
    id: "entering.hover",
    from: "entering",
    to: "hover",
    trigger: { type: "completion" },
    start: { type: "finish", targetPort: "default", maxWaitFrames: 66 },
    continuity: "exact-authored"
  }),
  Object.freeze({
    id: "exiting.entering",
    from: "exiting",
    to: "entering",
    trigger: { type: "event", name: "hover.enter" },
    start: { type: "finish", targetPort: "default", maxWaitFrames: 47 },
    continuity: "exact-authored"
  }),
  Object.freeze({
    id: "exiting.idle",
    from: "exiting",
    to: "idle",
    trigger: { type: "completion" },
    start: { type: "finish", targetPort: "default", maxWaitFrames: 47 },
    continuity: "exact-authored"
  }),
  Object.freeze({
    id: "hover.exiting",
    from: "hover",
    to: "exiting",
    trigger: { type: "event", name: "hover.leave" },
    start: {
      type: "portal",
      sourcePort: "default",
      targetPort: "default",
      maxWaitFrames: 191
    },
    continuity: "exact-authored"
  }),
  Object.freeze({
    id: "idle.entering",
    from: "idle",
    to: "entering",
    trigger: { type: "event", name: "hover.enter" },
    start: {
      type: "portal",
      sourcePort: "default",
      targetPort: "default",
      maxWaitFrames: 139
    },
    continuity: "exact-authored"
  })
]);

const EXPECTED_BINDINGS = Object.freeze([
  Object.freeze({ source: "engagement.off", event: "hover.leave" }),
  Object.freeze({ source: "engagement.on", event: "hover.enter" })
]);
const EXPECTED_READINESS = Object.freeze({
  policy: "all-routes",
  bootstrapUnits: Object.freeze(["hover-in", "idle-loop", "intro"]),
  immediateEdges: Object.freeze(["idle.entering"])
});
const EXPECTED_GRAPH_DEFINITION = Object.freeze({
  initialState: "idle",
  states: Object.freeze([
    Object.freeze({
      id: "entering",
      body: Object.freeze({
        unitId: "hover-in",
        kind: "finite",
        frameCount: 67,
        ports: Object.freeze([
          Object.freeze({ id: "default", entryFrame: 0, portalFrames: [66] })
        ])
      })
    }),
    Object.freeze({
      id: "exiting",
      body: Object.freeze({
        unitId: "hover-out",
        kind: "finite",
        frameCount: 48,
        ports: Object.freeze([
          Object.freeze({ id: "default", entryFrame: 0, portalFrames: [47] })
        ])
      })
    }),
    Object.freeze({
      id: "hover",
      body: Object.freeze({
        unitId: "hover-loop",
        kind: "loop",
        frameCount: 96,
        ports: Object.freeze([
          Object.freeze({ id: "default", entryFrame: 0, portalFrames: [95] })
        ])
      })
    }),
    Object.freeze({
      id: "idle",
      body: Object.freeze({
        unitId: "idle-loop",
        kind: "loop",
        frameCount: 70,
        ports: Object.freeze([
          Object.freeze({ id: "default", entryFrame: 0, portalFrames: [69] })
        ])
      }),
      initialUnit: Object.freeze({ unitId: "intro", frameCount: 30 })
    })
  ]),
  edges: EXPECTED_EDGES
});

function assertAuthoredProject(project: Readonly<SourceProject>): void {
  expect(project.projectVersion).toBe("1.0");
  expect(project.alpha).toBe("opaque");
  expect(project.canvas).toEqual(EXPECTED_CANVAS);
  expect(project.frameRate).toEqual(EXPECTED_FRAME_RATE);
  expect(project.sources).toEqual([{
    id: "rabbit",
    type: "video",
    path: "source/grass-test-with-intro.mp4",
    timing: { mode: "exact" }
  }]);
  expect(project.units).toEqual(EXPECTED_SOURCE_UNITS);
  expect(project.units[0]?.range[0]).toBe(0);
  expect(project.units.at(-1)?.range[1]).toBe(TOTAL_SOURCE_FRAMES);
  expect(project.units.reduce(
    (total, unit) => total + unit.range[1] - unit.range[0],
    0
  )).toBe(TOTAL_SOURCE_FRAMES);
  for (let index = 1; index < project.units.length; index += 1) {
    expect(project.units[index]?.range[0]).toBe(
      project.units[index - 1]?.range[1]
    );
  }
  expect(project.initialState).toBe("idle");
  expect([...project.states].sort(byId)).toEqual(EXPECTED_STATES);
  expect([...project.edges].sort(byId)).toEqual(EXPECTED_EDGES);
  expect([...project.bindings].sort((left, right) =>
    left.source.localeCompare(right.source)
  )).toEqual(EXPECTED_BINDINGS);
  expect(project.encodings.map(normalizeAuthoredEncoding)).toEqual(
    EXPECTED_ENCODINGS
  );
}

function normalizeAuthoredEncoding(
  encoding: SourceProject["encodings"][number]
): NormalizedVideoEncoding {
  return {
    ...encoding,
    renditions: encoding.renditions.map((rendition) => ({
      ...rendition,
      width: rendition.width === "auto" ? 1280 : rendition.width,
      height: rendition.height === "auto" ? 720 : rendition.height
    }))
  } as NormalizedVideoEncoding;
}

function semanticUnits(units: readonly Unit[]): readonly unknown[] {
  return units.map(({ chunks: _chunks, ...unit }) => unit);
}

function totalCompiledFrames(units: readonly Unit[]): number {
  return units.reduce((total, unit) => total + unit.frameCount, 0);
}

function requireFront(
  fronts: ReadonlyMap<VideoCodec, Readonly<ParsedFrontIndex>>,
  codec: VideoCodec
): Readonly<ParsedFrontIndex> {
  const front = fronts.get(codec);
  if (front === undefined) throw new Error(`Missing parsed ${codec} front index`);
  return front;
}

async function readRequiredArtifact(path: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    throw missingArtifactError(path, error);
  }
}

async function statRequiredArtifact(path: string): Promise<Awaited<ReturnType<typeof stat>>> {
  try {
    return await stat(path);
  } catch (error) {
    throw missingArtifactError(path, error);
  }
}

function missingArtifactError(path: string, cause: unknown): Error {
  if (isErrno(cause) && cause.code === "ENOENT") {
    return new Error(
      `Missing compiled grass-rabbit codec artifact ${relative(ROOT, path)}. ` +
      `Run \`${COMPILE_COMMAND}\` first.`,
      { cause }
    );
  }
  return cause instanceof Error ? cause : new Error(String(cause));
}

function isErrno(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Integrity(bytes: Uint8Array): string {
  return `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
}

function sourceElement(
  asset: Readonly<CompileBundleReport["assets"][number]>
): string {
  return `<source src="${asset.path}" data-codec="${asset.codec}" integrity="${asset.integrity}">`;
}

function byId(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id.localeCompare(right.id);
}
