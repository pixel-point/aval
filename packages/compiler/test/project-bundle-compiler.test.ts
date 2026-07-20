import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseFrontIndex } from "@pixel-point/aval-format";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  compileDirectInput,
  compileProjectFile
} from "../src/compile/project-compiler.js";
import { encodeCanonicalRgbaPng } from "../src/compile/png.js";

const HAS_VP9 = hasEncoder("libvpx-vp9");

describe.skipIf(!HAS_VP9)("project codec bundle compiler", () => {
  let directory = "";
  let projectPath = "";
  let outputPath = "";
  let framesPath = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "aval-project-bundle-"));
    projectPath = join(directory, "motion.json");
    outputPath = join(directory, "motion");
    framesPath = join(directory, "frames");
    await mkdir(framesPath);
    for (let frame = 0; frame < 6; frame += 1) {
      const rgba = new Uint8Array(64 * 32 * 4);
      for (let pixel = 0; pixel < 64 * 32; pixel += 1) {
        const offset = pixel * 4;
        rgba[offset] = 16 + frame * 32;
        rgba[offset + 1] = (pixel + frame * 7) & 0xff;
        rgba[offset + 2] = 224 - frame * 24;
        rgba[offset + 3] = 255;
      }
      await writeFile(
        join(framesPath, `frame-${String(frame).padStart(4, "0")}.png`),
        encodeCanonicalRgbaPng({ width: 64, height: 32, rgba })
      );
    }
    await writeFile(projectPath, JSON.stringify({
      projectVersion: "1.0",
      alpha: "opaque",
      canvas: {
        width: 64,
        height: 32,
        fit: "contain",
        pixelAspect: [1, 1],
        colorSpace: "srgb"
      },
      frameRate: { numerator: 6, denominator: 1 },
      sources: [{
        id: "render",
        type: "png-sequence",
        directory: "frames",
        prefix: "frame-",
        digits: 4,
        suffix: ".png",
        firstNumber: 0,
        frameCount: 6
      }],
      encodings: [{
        codec: "vp9",
        deadline: "good",
        cpuUsed: 8,
        threads: 2,
        renditions: [{ id: "video.main", width: 64, height: "auto", crf: 40 }]
      }],
      units: [{
        id: "idle.body",
        kind: "body",
        source: "render",
        range: [0, 6],
        playback: "finite",
        ports: []
      }],
      initialState: "idle",
      states: [{ id: "idle", bodyUnit: "idle.body" }],
      edges: [],
      bindings: []
    }, null, 2));
  });

  afterAll(async () => {
    if (directory !== "") await rm(directory, { recursive: true, force: true });
  });

  it("publishes vp9.avl plus canonical build.json as one directory", async () => {
    const result = await compileProjectFile({ projectPath, outputPath });
    const assetBytes = new Uint8Array(await readFile(join(outputPath, "vp9.avl")));
    const report = JSON.parse(await readFile(join(outputPath, "build.json"), "utf8"));
    const front = parseFrontIndex(assetBytes);

    expect(result).toMatchObject({
      outputPath,
      reportPath: join(outputPath, "build.json"),
      assets: [{ codec: "vp9", path: join(outputPath, "vp9.avl") }]
    });
    expect(front.manifest).toMatchObject({
      formatVersion: "1.1",
      codec: "vp9",
      bitstream: "frame",
      layout: "opaque",
      renditions: [{ id: "video.main", bitDepth: 8 }]
    });
    expect(report).toMatchObject({
      reportVersion: "1.0",
      assets: [{
        codec: "vp9",
        path: "vp9.avl",
        bytes: assetBytes.byteLength,
        type: expect.stringMatching(/^application\/vnd\.aval; codecs="vp09\./u),
        integrity: expect.stringMatching(/^sha256-/u)
      }]
    });
    expect(report.sourceMarkup).toContain('<source src="vp9.avl"');
    expect(JSON.stringify(report)).not.toContain(directory);
  }, 40_000);

  it("lowers direct media into the same one-source project bundle compiler", async () => {
    const directOutput = join(directory, "direct-motion");
    const result = await compileDirectInput({
      inputPath: join(framesPath, "frame-%04d.png"),
      outputPath: directOutput,
      codec: "h264",
      preset: "medium",
      crf: 30,
      fps: { numerator: 6, denominator: 1 },
      frames: { firstNumber: 0, frameCount: 6 },
      loop: [0, 6]
    });
    const bytes = new Uint8Array(await readFile(join(directOutput, "h264.avl")));
    const front = parseFrontIndex(bytes);

    expect(result.assets).toMatchObject([{
      codec: "h264",
      path: join(directOutput, "h264.avl")
    }]);
    expect(front.manifest).toMatchObject({
      formatVersion: "1.1",
      codec: "h264",
      units: [{ id: "body.default", frameCount: 6 }]
    });
    expect(await readFile(join(directOutput, "build.json"), "utf8"))
      .not.toContain(directory);
  }, 40_000);

  it("builds H.264, H.265, VP9, and 10-bit AV1 as separate ordered assets", async () => {
    const multiProjectPath = join(directory, "motion-all-codecs.json");
    const multiOutputPath = join(directory, "motion-all-codecs");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.encodings = [
      {
        codec: "av1",
        bitDepth: 10,
        cpuUsed: 8,
        tiles: { columns: 1, rows: 1 },
        rowMt: true,
        threads: 2,
        renditions: [{ id: "video.main", width: 64, height: "auto", crf: 40 }]
      },
      {
        codec: "vp9",
        deadline: "realtime",
        cpuUsed: 8,
        threads: 2,
        renditions: [{ id: "video.main", width: 64, height: "auto", crf: 40 }]
      },
      {
        codec: "h265",
        preset: "ultrafast",
        threads: 2,
        renditions: [{ id: "video.main", width: 64, height: "auto", crf: 32 }]
      },
      {
        codec: "h264",
        preset: "medium",
        renditions: [{ id: "video.main", width: 64, height: "auto", crf: 30 }]
      }
    ];
    await writeFile(multiProjectPath, JSON.stringify(project, null, 2));

    const result = await compileProjectFile({
      projectPath: multiProjectPath,
      outputPath: multiOutputPath
    });

    expect(result.assets.map(({ codec }) => codec)).toEqual([
      "av1", "vp9", "h265", "h264"
    ]);
    for (const codec of ["av1", "vp9", "h265", "h264"] as const) {
      const bytes = new Uint8Array(await readFile(join(multiOutputPath, `${codec}.avl`)));
      const front = parseFrontIndex(bytes);
      expect(front.manifest.codec).toBe(codec);
      expect(front.manifest.renditions[0]?.bitDepth).toBe(codec === "av1" ? 10 : 8);
      if (codec === "h264") {
        expect(front.manifest.renditions[0]?.codec).toMatch(/^avc1\.42E0/u);
        expect(front.records.every(
          (record, decodeIndex) => record.presentationTimestamp === decodeIndex
        )).toBe(true);
      }
    }
    const report = JSON.parse(
      await readFile(join(multiOutputPath, "build.json"), "utf8")
    );
    expect(report.assets.map(({ codec }: { codec: string }) => codec)).toEqual([
      "av1", "vp9", "h265", "h264"
    ]);
    expect(report.sourceMarkup.split("\n")).toHaveLength(4);
  }, 60_000);
});

function hasEncoder(name: string): boolean {
  try {
    const output = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], {
      encoding: "utf8",
      timeout: 10_000
    });
    return output.includes(name);
  } catch {
    return false;
  }
}
