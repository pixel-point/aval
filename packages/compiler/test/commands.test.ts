import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
  mkdir
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  encodeReferenceFrame,
  parseStrictJson,
  validateCompleteAsset,
  writeCanonicalAsset,
  type CanonicalAssetInputV01
} from "@rendered-motion/format";

import { parseCliArguments, type CompileCliArguments } from "../src/cli-args.js";
import { runCompileCommand } from "../src/commands/compile.js";
import { sha256Concat, sha256Hex } from "../src/compile/hash.js";
import { encodeCanonicalRgbaPng } from "../src/compile/png.js";
import { runInitCommand } from "../src/commands/init.js";
import { inspectAssetFile, unpackAssetFile, validateAssetReport } from "../src/commands/asset.js";
import { CompilerError } from "../src/diagnostics.js";
import type { CompileArtifact } from "../src/model.js";
import { parseSourceProject } from "../src/source-project-schema.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("compiler commands", () => {
  it("dispatches direct compile options and publishes a canonical report", async () => {
    const root = await temporaryRoot();
    const arguments_ = parseCliArguments([
      "compile", "input.mp4",
      "--loop", "2:8",
      "--fps", "24/1",
      "--bitrate", "100000:200000",
      "--ffmpeg", "/tool/ffmpeg",
      "--ffprobe", "/tool/ffprobe",
      "--out", "motion.rma"
    ]) as CompileCliArguments;
    let captured: unknown;
    const result = await runCompileCommand(arguments_, {
      cwd: root,
      dependencies: {
        buildDirectArtifact: async (options) => {
          captured = options;
          return compileArtifact();
        },
        buildProjectArtifact: async () => {
          throw new Error("wrong compiler");
        }
      }
    });
    expect(captured).toMatchObject({
      inputPath: join(root, "input.mp4"),
      loop: [2, 8],
      fps: { numerator: 24, denominator: 1 },
      normalizeVfr: true,
      bitrate: { average: 100_000, peak: 200_000 },
      ffmpegPath: "/tool/ffmpeg",
      ffprobePath: "/tool/ffprobe"
    });
    expect(result.reportPath).toBe(join(root, "motion.rma.build.json"));
    const reportBytes = new Uint8Array(await readFile(result.reportPath));
    expect(parseStrictJson(reportBytes)).toMatchObject({
      reportVersion: "0.1",
      asset: { bytes: 123, sha256: "a".repeat(64) }
    });
    expect(new TextDecoder().decode(reportBytes)).not.toContain("\n");
  });

  it("dispatches JSON projects to the project compiler and refuses collisions", async () => {
    const root = await temporaryRoot();
    const arguments_ = parseCliArguments([
      "compile", "motion.json", "--out", "motion.rma"
    ]) as CompileCliArguments;
    let projectPath = "";
    await runCompileCommand(arguments_, {
      cwd: root,
      dependencies: {
        buildDirectArtifact: async () => {
          throw new Error("wrong compiler");
        },
        buildProjectArtifact: async (options) => {
          projectPath = options.projectPath;
          return compileArtifact();
        }
      }
    });
    expect(projectPath).toBe(join(root, "motion.json"));

    await writeFile(join(root, "existing.rma"), "owned");
    const collision = parseCliArguments([
      "compile", "motion.json", "--out", "existing.rma"
    ]) as CompileCliArguments;
    await expect(runCompileCommand(collision, {
      cwd: root,
      dependencies: {
        buildDirectArtifact: async () => compileArtifact(),
        buildProjectArtifact: async () => compileArtifact()
      }
    })).rejects.toMatchObject({ code: "IO_FAILED" });
  });

  it("refuses a forced target that races during compilation", async () => {
    const root = await temporaryRoot();
    const outputPath = join(root, "motion.rma");
    const reportPath = join(root, "motion.report.json");
    await writeFile(outputPath, "previous asset");
    await writeFile(reportPath, "previous report");
    const arguments_ = parseCliArguments([
      "compile", "motion.json",
      "--out", "motion.rma",
      "--report", "motion.report.json",
      "--force"
    ]) as CompileCliArguments;
    await expect(runCompileCommand(arguments_, {
      cwd: root,
      dependencies: {
        buildDirectArtifact: async () => {
          throw new Error("wrong compiler");
        },
        buildProjectArtifact: async () => {
          await writeFile(reportPath, "raced report");
          return compileArtifact();
        }
      }
    })).rejects.toMatchObject({ code: "IO_FAILED" });
    expect(await readFile(outputPath, "utf8")).toBe("previous asset");
    expect(await readFile(reportPath, "utf8")).toBe("raced report");
  });

  it("replaces an identity-scoped forced pair and cleans publication workspaces", async () => {
    const root = await temporaryRoot();
    const outputPath = join(root, "motion.rma");
    const reportPath = join(root, "motion.report.json");
    await writeFile(outputPath, "previous asset");
    await writeFile(reportPath, "previous report");
    const arguments_ = parseCliArguments([
      "compile", "motion.json",
      "--out", "motion.rma",
      "--report", "motion.report.json",
      "--force"
    ]) as CompileCliArguments;
    await runCompileCommand(arguments_, {
      cwd: root,
      dependencies: {
        buildDirectArtifact: async () => {
          throw new Error("wrong compiler");
        },
        buildProjectArtifact: async () => compileArtifact()
      }
    });
    expect(new Uint8Array(await readFile(outputPath)))
      .toEqual(compileArtifact().assetBytes);
    expect(parseStrictJson(new Uint8Array(await readFile(reportPath))))
      .toMatchObject({
        reportVersion: "0.1",
        toolchain: {
          ffmpeg: {
            versionOutputSha256: "1".repeat(64),
            encodersOutputSha256: "2".repeat(64),
            calibrationSha256: "c".repeat(64)
          },
          ffprobe: { versionOutputSha256: "3".repeat(64) }
        },
        buildDetails: {
          detailsVersion: "0.1",
          invocations: [{
            operation: "probe:test",
            tool: "ffprobe",
            arguments: ["-version"]
          }],
          continuity: [{ metrics: { boundaryRms: "0.125" } }]
        }
      });
    expect((await readdir(root)).some((name) => name.includes(".publish-")))
      .toBe(false);
  });

  it("never removes files raced into initially absent publication paths", async () => {
    const root = await temporaryRoot();
    const outputPath = join(root, "motion.rma");
    const reportPath = join(root, "motion.rma.build.json");
    const arguments_ = parseCliArguments([
      "compile", "motion.json", "--out", "motion.rma"
    ]) as CompileCliArguments;
    await expect(runCompileCommand(arguments_, {
      cwd: root,
      dependencies: {
        buildDirectArtifact: async () => {
          throw new Error("wrong compiler");
        },
        buildProjectArtifact: async () => {
          await writeFile(outputPath, "raced asset");
          await writeFile(reportPath, "raced report");
          return compileArtifact();
        }
      }
    })).rejects.toMatchObject({ code: "IO_FAILED" });
    expect(await readFile(outputPath, "utf8")).toBe("raced asset");
    expect(await readFile(reportPath, "utf8")).toBe("raced report");
  });

  it("publishes nothing when cancellation wins after artifact construction", async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    const arguments_ = parseCliArguments([
      "compile", "motion.json", "--out", "motion.rma"
    ]) as CompileCliArguments;
    await expect(runCompileCommand(arguments_, {
      cwd: root,
      signal: controller.signal,
      dependencies: {
        buildDirectArtifact: async () => {
          throw new Error("wrong compiler");
        },
        buildProjectArtifact: async () => {
          controller.abort("cancelled after build");
          return compileArtifact();
        }
      }
    })).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(readFile(join(root, "motion.rma"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(join(root, "motion.rma.build.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).some((name) => name.includes(".publish-")))
      .toBe(false);
  });

  it("publishes reports beyond the on-wire twenty-thousand-node JSON budget", async () => {
    const root = await temporaryRoot();
    const base = compileArtifact();
    const values = Object.freeze(Array.from({ length: 25_000 }, (_, index) => index));
    const large = Object.freeze({
      ...base,
      buildDetails: Object.freeze({
        ...base.buildDetails,
        highCardinalityEvidence: values
      }) as unknown as CompileArtifact["buildDetails"]
    });
    const arguments_ = parseCliArguments([
      "compile", "motion.json", "--out", "motion.rma"
    ]) as CompileCliArguments;
    await runCompileCommand(arguments_, {
      cwd: root,
      dependencies: {
        buildDirectArtifact: async () => {
          throw new Error("wrong compiler");
        },
        buildProjectArtifact: async () => large
      }
    });
    const report = JSON.parse(
      await readFile(join(root, "motion.rma.build.json"), "utf8")
    ) as { buildDetails: { highCardinalityEvidence: number[] } };
    expect(report.buildDetails.highCardinalityEvidence).toHaveLength(25_000);
  });

  it("never lets --force replace a project source or explicit tool", async () => {
    const root = await temporaryRoot();
    await runInitCommand({
      command: "init", directory: "starter", json: false
    }, root);
    const sourcePath = join(root, "starter/frames/frame-0000.png");
    const sourceBefore = await readFile(sourcePath);
    const sourceCollision = parseCliArguments([
      "compile", "starter/motion.json",
      "--out", "starter/frames/frame-0000.png",
      "--force"
    ]) as CompileCliArguments;
    await expect(runCompileCommand(sourceCollision, {
      cwd: root,
      dependencies: {
        buildDirectArtifact: async () => compileArtifact(),
        buildProjectArtifact: async () => compileArtifact()
      }
    })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(await readFile(sourcePath)).toEqual(sourceBefore);

    const toolPath = join(root, "ffmpeg");
    await writeFile(toolPath, "tool");
    const toolCollision = parseCliArguments([
      "compile", "source.mp4", "--loop", "0:2",
      "--ffmpeg", toolPath,
      "--out", toolPath,
      "--force"
    ]) as CompileCliArguments;
    await expect(runCompileCommand(toolCollision, {
      cwd: root,
      dependencies: {
        buildDirectArtifact: async () => compileArtifact(),
        buildProjectArtifact: async () => compileArtifact()
      }
    })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(await readFile(toolPath, "utf8")).toBe("tool");
  });

  it("refuses symbolic-link publication and unpack targets", async () => {
    const root = await temporaryRoot();
    const owned = join(root, "owned.rma");
    const linked = join(root, "linked.rma");
    await writeFile(owned, "owned");
    await symlink(owned, linked);
    const arguments_ = parseCliArguments([
      "compile", "source.mp4", "--loop", "0:2",
      "--out", "linked.rma", "--force"
    ]) as CompileCliArguments;
    await expect(runCompileCommand(arguments_, {
      cwd: root,
      dependencies: {
        buildDirectArtifact: async () => compileArtifact(),
        buildProjectArtifact: async () => compileArtifact()
      }
    })).rejects.toMatchObject({ code: "IO_FAILED" });
    expect(await readFile(owned, "utf8")).toBe("owned");

    const fixture = await validReferenceAsset(root);
    const realDirectory = join(root, "real-unpack");
    const linkedDirectory = join(root, "linked-unpack");
    await mkdir(realDirectory);
    await symlink(realDirectory, linkedDirectory);
    await expect(unpackAssetFile(fixture, linkedDirectory)).rejects.toMatchObject({
      code: "IO_FAILED"
    });
    expect(await readdir(realDirectory)).toEqual([]);
  });

  it("creates byte-identical procedural, schema-valid starters", async () => {
    const root = await temporaryRoot();
    const first = await runInitCommand({
      command: "init", directory: "one", json: false
    }, root);
    const second = await runInitCommand({
      command: "init", directory: "two", json: false
    }, root);
    for (const relative of first.files) {
      expect(await readFile(join(first.directory, relative))).toEqual(
        await readFile(join(second.directory, relative))
      );
    }
    const projectBytes = new Uint8Array(await readFile(first.project));
    expect(parseSourceProject(projectBytes)).toMatchObject({
      initialState: "default",
      sources: [{ type: "png-sequence", frameCount: 2 }],
      units: [{ kind: "body", range: [0, 2] }]
    });
    expect(await readFile(join(first.directory, "ASSET-LICENSE.md"), "utf8"))
      .toContain("procedurally");
    await expect(runInitCommand({
      command: "init", directory: "one", json: false
    }, root)).rejects.toMatchObject({ code: "IO_FAILED" });
  });

  it("inspects, validates, and safely reconstructs a complete asset", async () => {
    const root = await temporaryRoot();
    const fixture = await validReferenceAsset(root);
    const inspection = await inspectAssetFile(fixture);
    expect(inspection).toMatchObject({
      formatVersion: "0.1",
      digestClaim: "all-internal-and-whole-file",
      avcClaim: "not-applicable",
      staticPngClaim: "generated-profile-envelope"
    });
    expect(inspection.units[0]?.startTime).toMatch(/^\d+\/\d+$/u);
    await expect(validateAssetReport(fixture)).resolves.toMatchObject({
      command: "validate",
      digestClaim: "all-internal-and-whole-file"
    });

    const unpacked = await unpackAssetFile(fixture, join(root, "unpacked"));
    expect(unpacked.files).toContain("manifest.json");
    expect(unpacked.files).toContain("index.json");
    expect(unpacked.files).toContain("unpack-report.json");
    expect(unpacked.files.some((name) => name.endsWith(".au"))).toBe(true);
    expect(unpacked.files.some((name) => name.endsWith(".png"))).toBe(true);
    expect(unpacked.accessUnits).toBe(3);
    const unpackReport = parseStrictJson(new Uint8Array(
      await readFile(join(root, "unpacked/unpack-report.json"))
    ));
    expect(unpackReport).toMatchObject({
      accessUnits: expect.arrayContaining([
        expect.objectContaining({
          frameIndex: 0,
          key: true,
          length: expect.any(Number)
        })
      ])
    });
    expect(validateCompleteAsset({
      bytes: new Uint8Array(await readFile(fixture))
    })).toBeDefined();

    const nonempty = join(root, "nonempty");
    await mkdir(nonempty);
    await writeFile(join(nonempty, "owned.txt"), "owned");
    await expect(unpackAssetFile(fixture, nonempty)).rejects.toMatchObject({
      code: "IO_FAILED"
    });
  });

  it("cancels a mid-unpack write and removes its partial file, lock, and created directory", async () => {
    const root = await temporaryRoot();
    const fixture = await validReferenceAsset(root);
    const target = join(root, "cancelled-unpack");
    const partialPath = join(target, "manifest.json");
    let observedPartial = false;
    const signal = {
      get aborted(): boolean {
        observedPartial ||= existsSync(partialPath);
        return observedPartial;
      },
      get reason(): string {
        return "cancel after the first output path is created";
      }
    } as AbortSignal;

    await expect(unpackAssetFile(fixture, target, signal)).rejects.toMatchObject({
      code: "CANCELLED"
    });
    expect(observedPartial).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it("leaves a caller-owned empty directory empty after mid-unpack cancellation", async () => {
    const root = await temporaryRoot();
    const fixture = await validReferenceAsset(root);
    const target = join(root, "caller-owned-unpack");
    const partialPath = join(target, "manifest.json");
    await mkdir(target);
    let observedPartial = false;
    const signal = {
      get aborted(): boolean {
        observedPartial ||= existsSync(partialPath);
        return observedPartial;
      },
      get reason(): string {
        return "cancel after the first output path is created";
      }
    } as AbortSignal;

    await expect(unpackAssetFile(fixture, target, signal)).rejects.toMatchObject({
      code: "CANCELLED"
    });
    expect(observedPartial).toBe(true);
    expect(await readdir(target)).toEqual([]);
  });

  it("maps a post-layout payload corruption to ASSET_INVALID", async () => {
    const root = await temporaryRoot();
    const fixture = await validReferenceAsset(root);
    const bytes = new Uint8Array(await readFile(fixture));
    const layout = validateCompleteAsset({ bytes });
    const blob = layout.frontIndex.unitBlobs[0];
    expect(blob).toBeDefined();
    const offset = blob!.offset + blob!.length - 1;
    bytes[offset] = bytes[offset]! ^ 0x01;
    const corrupted = join(root, "corrupt.rma");
    await writeFile(corrupted, bytes);
    try {
      await validateAssetReport(corrupted);
      throw new Error("expected invalid asset");
    } catch (error) {
      expect(error).toBeInstanceOf(CompilerError);
      expect((error as CompilerError).code).toBe("ASSET_INVALID");
    }
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rma-commands-"));
  roots.push(root);
  return root;
}

function compileArtifact(): Readonly<CompileArtifact> {
  return Object.freeze({
    assetBytes: new Uint8Array(123).fill(7),
    bytes: 123,
    sha256: "a".repeat(64),
    provenance: Object.freeze({
      executable: "/tool/ffmpeg",
      executableSha256: "f".repeat(64),
      executableIdentity: fileIdentity("1"),
      versionLine: "ffmpeg version test",
      versionOutputSha256: "1".repeat(64),
      configurationLine: "configuration: --enable-libx264",
      encodersOutputSha256: "2".repeat(64),
      calibrationSha256: "c".repeat(64),
      ffprobeExecutable: "/tool/ffprobe",
      ffprobeExecutableSha256: "e".repeat(64),
      ffprobeExecutableIdentity: fileIdentity("2"),
      ffprobeVersionLine: "ffprobe version test",
      ffprobeVersionOutputSha256: "3".repeat(64),
      aggregateMemoryLimit: "derived"
    }),
    warnings: Object.freeze(["one warning"]),
    buildDetails: Object.freeze({
      detailsVersion: "0.1",
      invocations: Object.freeze([Object.freeze({
        operation: "probe:test",
        tool: "ffprobe",
        arguments: Object.freeze(["-version"])
      })]),
      continuity: Object.freeze([Object.freeze({
        metrics: Object.freeze({ boundaryRms: 0.125 })
      })])
    }) as unknown as CompileArtifact["buildDetails"]
  });
}

function fileIdentity(inode: string) {
  return Object.freeze({
    device: "1",
    inode,
    size: 1,
    mtimeNanoseconds: "1",
    ctimeNanoseconds: "1"
  });
}

async function validReferenceAsset(root: string): Promise<string> {
  const samples = Array.from({ length: 3 }, (_, frameIndex) =>
    encodeReferenceFrame({
      width: 2,
      height: 2,
      frameIndex,
      rgba: new Uint8Array(16).fill(40 + frameIndex)
    })
  );
  const rgba = new Uint8Array(16);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba.set([40, 40, 40, 255], offset);
  }
  const staticPng = encodeCanonicalRgbaPng({ width: 2, height: 2, rgba });
  const input: CanonicalAssetInputV01 = {
    manifest: {
      formatVersion: "0.1",
      generator: "rendered-motion-compiler/0.1 test-reference",
      canvas: {
        width: 2,
        height: 2,
        fit: "contain",
        pixelAspect: [1, 1],
        colorSpace: "srgb"
      },
      frameRate: { numerator: 30, denominator: 1 },
      renditions: [{
        id: "reference",
        profile: "reference-rgba-v0",
        codec: "rma.reference-rgba",
        codedWidth: 2,
        codedHeight: 2,
        alphaLayout: { type: "straight-rgba-v0" },
        capabilities: []
      }],
      units: [{
        id: "idle-body",
        kind: "body",
        playback: "loop",
        frameCount: 3,
        ports: [{ id: "default", entryFrame: 0, portalFrames: [2] }],
        samples: [{ rendition: "reference", sha256: sha256Concat(samples) }]
      }],
      staticFrames: [{
        id: "idle-static",
        width: 2,
        height: 2,
        sha256: sha256Hex(staticPng)
      }],
      initialState: "idle",
      states: [{
        id: "idle",
        bodyUnit: "idle-body",
        staticFrame: "idle-static"
      }],
      edges: [],
      bindings: [],
      readiness: {
        policy: "all-routes",
        bootstrapUnits: ["idle-body"],
        immediateEdges: []
      },
      fallback: {
        unsupported: "per-state-static",
        reducedMotion: "per-state-static"
      },
      limits: {
        maxCompiledBytes: 32 * 1024,
        maxRuntimeBytes: 64 * 1024,
        decodedPixelBytes: 16,
        persistentCacheBytes: 0,
        runtimeWorkingSetBytes: 16
      }
    },
    accessUnits: samples.map((bytes, frameIndex) => ({
      rendition: "reference",
      unit: "idle-body",
      frameIndex,
      key: true,
      bytes
    })),
    staticPayloads: [{ staticFrame: "idle-static", bytes: staticPng }]
  };
  const path = join(root, "valid-reference.rma");
  await writeFile(path, writeCanonicalAsset(input));
  return path;
}
