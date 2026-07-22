import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseCliArguments, type CompileCliArguments } from "../src/cli-args.js";
import {
  runCompileCommand,
  type CompileCommandDependencies
} from "../src/commands/compile.js";
import type {
  CompileBundleArtifact,
  DirectArtifactOptions,
  ProjectArtifactOptions,
  VideoCodec
} from "../src/model.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("compile command codec bundles", () => {
  it("maps every AV1 direct compression control and publishes a fixed bundle", async () => {
    const root = await temporaryRoot();
    const arguments_ = parseCliArguments([
      "compile", "render.mov",
      "--loop", "2:12",
      "--fps", "24/1",
      "--canvas", "1920x1080",
      "--codec", "av1",
      "--crf", "15",
      "--bit-depth", "10",
      "--cpu-used", "0",
      "--tiles", "4x2",
      "--row-mt",
      "--threads", "32",
      "--media-timeout-ms", "900000",
      "--out", "motion"
    ]) as CompileCliArguments;
    let direct: DirectArtifactOptions | undefined;

    const result = await runCompileCommand(arguments_, {
      cwd: root,
      dependencies: dependencies({
        direct: async (options) => {
          direct = options;
          return bundle("av1");
        }
      })
    });

    expect(direct).toMatchObject({
      inputPath: join(root, "render.mov"),
      loop: [2, 12],
      fps: { numerator: 24, denominator: 1 },
      canvas: [1920, 1080],
      normalizeVfr: true,
      alpha: "auto",
      codec: "av1",
      crf: 15,
      bitDepth: 10,
      cpuUsed: 0,
      tiles: { columns: 4, rows: 2 },
      rowMt: true,
      threads: 32,
      mediaTimeoutMs: 900_000
    });
    expect(result).toMatchObject({
      command: "compile",
      outputPath: join(root, "motion"),
      reportPath: join(root, "motion", "build.json"),
      assets: [{ codec: "av1", path: join(root, "motion", "av1.avl") }]
    });
    expect((await readdir(join(root, "motion"))).sort()).toEqual([
      "av1.avl",
      "build.json"
    ]);
    expect(await readFile(join(root, "motion", "av1.avl"), "utf8"))
      .toBe("av1-bytes");
    expect(await readFile(join(root, "motion", "build.json"), "utf8"))
      .toBe('{"reportVersion":"1.0"}');
  });

  it.each([
    {
      codec: "h264" as const,
      flags: ["--crf", "21", "--preset", "placebo"],
      expected: { codec: "h264", crf: 21, preset: "placebo" }
    },
    {
      codec: "h265" as const,
      flags: ["--crf", "32", "--preset", "veryslow", "--threads", "16"],
      expected: { codec: "h265", crf: 32, preset: "veryslow", threads: 16 }
    },
    {
      codec: "vp9" as const,
      flags: ["--crf", "40", "--deadline", "best", "--cpu-used", "-2", "--threads", "8"],
      expected: { codec: "vp9", crf: 40, deadline: "best", cpuUsed: -2, threads: 8 }
    }
  ])("maps $codec controls without legacy bitrate fields", async ({ codec, flags, expected }) => {
    const root = await temporaryRoot();
    const arguments_ = parseCliArguments([
      "compile", "render.mp4", "--loop", "0:8", "--codec", codec,
      ...flags, "--out", `motion-${codec}`
    ]) as CompileCliArguments;
    let direct: DirectArtifactOptions | undefined;

    await runCompileCommand(arguments_, {
      cwd: root,
      dependencies: dependencies({
        direct: async (options) => {
          direct = options;
          return bundle(codec);
        }
      })
    });

    expect(direct).toMatchObject(expected);
    expect(direct).not.toHaveProperty("bitrate");
    expect(direct).not.toHaveProperty("maxBitrate");
  });

  it("dispatches projects to the multi-codec builder and force-replaces one directory", async () => {
    const root = await temporaryRoot();
    const output = join(root, "motion");
    await writeFile(join(root, "motion.json"), "{}");
    await mkdir(output);
    await writeFile(join(output, "stale.avl"), "stale");
    const arguments_ = parseCliArguments([
      "compile", "motion.json",
      "--ffmpeg", "/tool/ffmpeg",
      "--ffprobe", "/tool/ffprobe",
      "--media-timeout-ms", "1200000",
      "--out", "motion",
      "--force"
    ]) as CompileCliArguments;
    let project: ProjectArtifactOptions | undefined;

    const result = await runCompileCommand(arguments_, {
      cwd: root,
      dependencies: dependencies({
        project: async (options) => {
          project = options;
          return bundle("vp9");
        }
      })
    });

    expect(project).toEqual({
      projectPath: join(root, "motion.json"),
      ffmpegPath: "/tool/ffmpeg",
      ffprobePath: "/tool/ffprobe",
      mediaTimeoutMs: 1_200_000
    });
    expect(result.assets.map(({ codec }) => codec)).toEqual(["vp9"]);
    expect((await readdir(output)).sort()).toEqual(["build.json", "vp9.avl"]);
  });
});

function dependencies(overrides: {
  readonly direct?: (
    options: DirectArtifactOptions
  ) => Promise<Readonly<CompileBundleArtifact>>;
  readonly project?: (
    options: ProjectArtifactOptions
  ) => Promise<Readonly<CompileBundleArtifact>>;
}): CompileCommandDependencies {
  return {
    buildDirectBundleArtifact: overrides.direct ?? (async () => {
      throw new Error("unexpected direct build");
    }),
    buildProjectBundleArtifact: overrides.project ?? (async () => {
      throw new Error("unexpected project build");
    })
  };
}

function bundle(codec: VideoCodec): Readonly<CompileBundleArtifact> {
  const assetBytes = new TextEncoder().encode(`${codec}-bytes`);
  return Object.freeze({
    assets: Object.freeze([Object.freeze({
      codec,
      filename: `${codec}.avl`,
      assetBytes,
      bytes: assetBytes.byteLength,
      sha256: "ab".repeat(32),
      manifest: {} as never,
      invocations: Object.freeze([])
    })]),
    buildReport: Object.freeze({
      reportVersion: "1.0" as const,
      assets: Object.freeze([Object.freeze({
        codec,
        path: `${codec}.avl`,
        bytes: assetBytes.byteLength,
        sha256: "ab".repeat(32),
        type: `application/vnd.aval; codecs=\"test.${codec}\"`,
        integrity: "sha256-test"
      })]),
      sourceMarkup: `<source src="${codec}.avl" data-codec="${codec}">`
    }),
    buildReportBytes: new TextEncoder().encode('{"reportVersion":"1.0"}'),
    provenance: {} as never,
    warnings: Object.freeze([])
  });
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aval-compile-command-bundle-"));
  roots.push(root);
  return root;
}
