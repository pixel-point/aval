import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseFrontIndex } from "@pixel-point/aval-format";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileProjectEncoding } from "../src/compile/project-encoding-compiler.js";
import { compileVideoEncodingRenditions } from "../src/compile/video-rendition-pipeline.js";
import type { PreparedProjectSource } from "../src/compile/project-source.js";
import type {
  NormalizedSourceProject,
  NormalizedVideoEncoding,
  VideoCodec
} from "../src/model.js";

const WIDTH = 64;
const HEIGHT = 28;
const FRAMES = 6;
const CODEC_CASES = Object.freeze([
  {
    codec: "h264",
    encoder: "libx264",
    bitstream: "annex-b",
    pattern: /^avc1\./u
  },
  {
    codec: "h265",
    encoder: "libx265",
    bitstream: "annex-b",
    pattern: /^hvc1\./u
  },
  {
    codec: "vp9",
    encoder: "libvpx-vp9",
    bitstream: "frame",
    pattern: /^vp09\./u
  },
  {
    codec: "av1",
    encoder: "libaom-av1",
    bitstream: "low-overhead",
    pattern: /^av01\./u
  }
] as const);

describe("codec-typed rendition pipeline", () => {
  let directory = "";
  let rgbaPath = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "aval-video-pipeline-"));
    rgbaPath = join(directory, "canonical.rgba");
    const bytes = new Uint8Array(WIDTH * HEIGHT * 8 * FRAMES);
    const view = new DataView(bytes.buffer);
    for (let frame = 0; frame < FRAMES; frame += 1) {
      const start = frame * WIDTH * HEIGHT * 8;
      for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel += 1) {
        const offset = start + pixel * 8;
        view.setUint16(offset, (24 + frame * 24) * 257, true);
        view.setUint16(offset + 2, 64 * 257, true);
        view.setUint16(offset + 4, (192 - frame * 16) * 257, true);
        const alpha = frame === 0
          ? pixel % WIDTH < WIDTH / 2 ? 16 : 224
          : 128;
        view.setUint16(offset + 6, alpha * 257, true);
      }
    }
    await writeFile(rgbaPath, bytes);
  });

  afterAll(async () => {
    if (directory !== "") await rm(directory, { recursive: true, force: true });
  });

  it.each(CODEC_CASES.filter(({ encoder }) => hasEncoder(encoder)))(
    "dispatches, encodes, inspects, and assembles $codec",
    async ({ codec, bitstream, pattern }) => {
      const project = projectFixture(encodingFixture(codec));
      const source = preparedSource();
      const encoding = project.encodings[0]!;
      const compiled = await compileVideoEncodingRenditions({
        project,
        encoding,
        layout: "packed-alpha",
        sources: new Map([[source.id, source]]),
        executable: "ffmpeg",
        timeoutMs: 30_000
      });

      expect(compiled.invocations.map(({ operation }) => operation)).toEqual([
        `${codec}:video.main:idle.body:scale-rgba`,
        `${codec}:video.main:idle.body:encode`,
        `${codec}:video.main:idle.body:verify-packed-alpha`
      ]);
      const verificationInvocation = compiled.invocations[2];
      expect(verificationInvocation).toMatchObject({
        tool: "ffmpeg",
        arguments: expect.arrayContaining([
          "-vf", "select=eq(n\\,0),format=rgba",
          "-f", "rawvideo",
          "-pix_fmt", "rgba"
        ])
      });
      expect(JSON.stringify(verificationInvocation?.arguments)).not.toContain(directory);
      expect(compiled.renditions[0]).toMatchObject({
        id: "video.main",
        bitDepth: codec === "av1" ? 10 : 8,
        geometry: {
          layout: "packed-alpha",
          codedWidth: WIDTH,
          visibleAlphaRect: [0, 36, WIDTH, HEIGHT]
        },
        outputQualification: {
          kind: "packed-alpha-v1",
          unit: "idle.body",
          frame: 0
        }
      });
      const range = compiled.renditions[0]?.outputQualification?.samples[0]?.expectedRange;
      expect(compiled.renditions[0]?.outputQualification?.samples[0])
        .toMatchObject({ x: 0, y: 0 });
      expect(range?.[0]).toBe(0);
      expect(range?.[1]).toBeGreaterThanOrEqual(16);
      expect(range?.[1]).toBeLessThan(100);
      expect((range?.[1] ?? 0) - (range?.[0] ?? 0)).toBeLessThanOrEqual(96);
      const samples = compiled.renditions[0]?.outputQualification?.samples ?? [];
      expect(samples.length).toBeGreaterThanOrEqual(2);
      expect(samples.some((left) => samples.some((right) =>
        left.expectedRange[1] < right.expectedRange[0]
      ))).toBe(true);
      expect(compiled.renditions[0]?.codec).toMatch(pattern);
      if (codec === "h264") {
        // This assertion is backed by a real libx264 encode when the encoder is
        // installed, and proves preparation rewrote its C0 SPS to strict E0.
        expect(compiled.renditions[0]?.codec).toBe("avc1.42E00B");
      }
      const artifact = compileProjectEncoding({
        project,
        encoding,
        layout: "packed-alpha",
        renditions: compiled.renditions
      });
      const front = parseFrontIndex(artifact.assetBytes);
      expect(front.manifest).toMatchObject({
        formatVersion: "1.1",
        codec,
        bitstream,
        layout: "packed-alpha"
      });
      expect(front.records.reduce(
        (total, chunk) => total + chunk.displayedFrameCount,
        0
      )).toBe(FRAMES);
    },
    40_000
  );

  it.skipIf(!hasEncoder("libx264"))(
    "keeps opaque rendition compilation on wire 1.1 without a witness pass",
    async () => {
      const project = projectFixture(encodingFixture("h264"), "opaque");
      const source = preparedSource();
      const encoding = project.encodings[0]!;
      const compiled = await compileVideoEncodingRenditions({
        project,
        encoding,
        layout: "opaque",
        sources: new Map([[source.id, source]]),
        executable: "ffmpeg",
        timeoutMs: 30_000
      });

      expect(compiled.invocations.map(({ operation }) => operation)).toEqual([
        "h264:video.main:idle.body:scale-rgba",
        "h264:video.main:idle.body:encode"
      ]);
      expect(compiled.renditions[0]?.outputQualification).toBeUndefined();
      const artifact = compileProjectEncoding({
        project,
        encoding,
        layout: "opaque",
        renditions: compiled.renditions
      });
      const front = parseFrontIndex(artifact.assetBytes);
      expect(front.manifest).toMatchObject({
        formatVersion: "1.1",
        layout: "opaque"
      });
      expect(front.manifest.renditions[0]?.outputQualification).toBeUndefined();
    },
    40_000
  );

  function preparedSource(): Readonly<PreparedProjectSource> {
    return {
      id: "render",
      input: {
        type: "raw-rgba64",
        path: rgbaPath,
        width: WIDTH,
        height: HEIGHT,
        frameRate: { numerator: 6, denominator: 1 }
      },
      spoolFrameCount: FRAMES,
      projectFrameToSpoolFrame: new Map(
        Array.from({ length: FRAMES }, (_, frame) => [frame, frame])
      )
    } as unknown as Readonly<PreparedProjectSource>;
  }
});

function projectFixture(
  encoding: Readonly<NormalizedVideoEncoding>,
  alpha: "opaque" | "packed" = "packed"
): NormalizedSourceProject {
  return {
    projectVersion: "1.0",
    alpha,
    canvas: {
      width: WIDTH,
      height: HEIGHT,
      fit: "contain",
      pixelAspect: [1, 1],
      colorSpace: "srgb"
    },
    frameRate: { numerator: 6, denominator: 1 },
    sources: [{
      id: "render",
      type: "video",
      path: "render.mov",
      timing: { mode: "exact" }
    }],
    encodings: [encoding],
    units: [{
      id: "idle.body",
      kind: "body",
      source: "render",
      range: [0, FRAMES],
      playback: "loop",
      ports: []
    }],
    initialState: "idle",
    states: [{ id: "idle", bodyUnit: "idle.body" }],
    edges: [],
    bindings: []
  };
}

function encodingFixture(codec: VideoCodec): NormalizedVideoEncoding {
  const renditions = Object.freeze([
    Object.freeze({ id: "video.main", width: WIDTH, height: HEIGHT, crf: 40 })
  ]);
  switch (codec) {
    case "h264":
      return Object.freeze({ codec, preset: "ultrafast", renditions });
    case "h265":
      return Object.freeze({ codec, preset: "ultrafast", threads: 2, renditions });
    case "vp9":
      return Object.freeze({
        codec,
        deadline: "realtime",
        cpuUsed: 8,
        threads: 2,
        renditions
      });
    case "av1":
      return Object.freeze({
        codec,
        bitDepth: 10,
        cpuUsed: 8,
        tiles: Object.freeze({ columns: 1, rows: 1 }),
        rowMt: true,
        threads: 2,
        renditions
      });
  }
}

function hasEncoder(name: string): boolean {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], {
    encoding: "utf8",
    timeout: 10_000
  });
  return result.status === 0 && result.stdout.includes(name);
}
