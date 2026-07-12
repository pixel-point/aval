import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startDevCommand, type WatchHandle } from "../src/commands/dev.js";
import { CompilerError } from "../src/diagnostics.js";
import type { CompileArtifact, ProjectArtifactOptions } from "../src/model.js";

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map(async (root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("dev single-flight watcher", () => {
  it("aborts an old build, debounces bursts, and never compiles concurrently", async () => {
    vi.useFakeTimers();
    const root = await createProject();
    const listeners = new Map<string, () => void>();
    const pending: DeferredCompile[] = [];
    let concurrent = 0;
    let maximumConcurrent = 0;
    const builds: number[] = [];
    const failures: unknown[] = [];

    const session = await startDevCommand({
      command: "dev",
      project: "motion.json",
      output: "motion.rma",
      force: false,
      json: false
    }, {
      cwd: root,
      debounceMs: 100,
      dependencies: {
        buildProjectArtifact: (options) => {
          concurrent += 1;
          maximumConcurrent = Math.max(maximumConcurrent, concurrent);
          return new Promise<Readonly<CompileArtifact>>((resolve) => {
            const finish = <T>(operation: () => T): T => {
              concurrent -= 1;
              return operation();
            };
            pending.push({
              options,
              resolve: (result) => resolve(finish(() => result))
            });
          });
        },
        watchPath: (path, onChange): WatchHandle => {
          listeners.set(path, onChange);
          return {
            close: () => {
              if (listeners.get(path) === onChange) listeners.delete(path);
            }
          };
        }
      },
      onBuild: ({ sequence }) => builds.push(sequence),
      onFailure: ({ error }) => failures.push(error)
    });

    expect(pending).toHaveLength(1);
    const media = [...listeners.keys()].find((path) => path.endsWith("render.mp4"));
    if (media === undefined) throw new Error("media watcher was not installed");
    listeners.get(media)!();
    listeners.get(media)!();
    expect(pending[0]!.options.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(99);
    expect(pending).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending).toHaveLength(1);
    pending[0]!.resolve(artifact(1));
    await Promise.resolve();
    await Promise.resolve();
    expect(pending).toHaveLength(2);

    listeners.get(media)!();
    listeners.get(media)!();
    await vi.advanceTimersByTimeAsync(100);
    expect(pending).toHaveLength(2);
    pending[1]!.resolve(artifact(2));
    await vi.runAllTimersAsync();
    await Promise.resolve();
    expect(pending).toHaveLength(3);
    pending[2]!.resolve(artifact(3));
    await session.firstBuild;

    expect(maximumConcurrent).toBe(1);
    expect(builds).toEqual([5]);
    expect(failures).toEqual([]);
    expect((await readFile(join(root, "motion.rma")))[0]).toBe(3);
    expect(session.watchPaths().map((path) => path.split("/").at(-1)).sort()).toEqual([
      "motion.json",
      "render.mp4"
    ]);
    await session.close();
    expect(listeners.size).toBe(0);
  });

  it("closes a pending build on caller cancellation", async () => {
    const root = await createProject();
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const session = await startDevCommand({
      command: "dev",
      project: "motion.json",
      output: "motion.rma",
      force: false,
      json: false
    }, {
      cwd: root,
      signal: controller.signal,
      dependencies: {
        buildProjectArtifact: (options) => {
          observedSignal = options.signal;
          return new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => {
              reject(new CompilerError("CANCELLED", "closed"));
            }, { once: true });
          });
        },
        watchPath: () => ({ close: () => undefined })
      }
    });
    controller.abort();
    await session.closed;
    expect(observedSignal?.aborted).toBe(true);
  });

  it("does not let an abort-ignoring stale builder reach publication", async () => {
    vi.useFakeTimers();
    const root = await createProject();
    const listeners = new Map<string, () => void>();
    const pending: Array<(artifact: Readonly<CompileArtifact>) => void> = [];
    const published: number[] = [];
    const session = await startDevCommand({
      command: "dev",
      project: "motion.json",
      output: "motion.rma",
      force: false,
      json: false
    }, {
      cwd: root,
      debounceMs: 0,
      dependencies: {
        buildProjectArtifact: () => new Promise((resolve) => pending.push(resolve)),
        publishArtifact: async (built, { outputPath }) => {
          published.push(built.assetBytes[0]!);
          return resultFromArtifact(outputPath, built);
        },
        watchPath: (path, onChange) => {
          listeners.set(path, onChange);
          return { close: () => listeners.delete(path) };
        }
      }
    });
    expect(pending).toHaveLength(1);
    const media = [...listeners.keys()].find((path) => path.endsWith("render.mp4"));
    if (media === undefined) throw new Error("media watcher was not installed");
    listeners.get(media)!();
    await vi.runAllTimersAsync();
    pending[0]!(artifact(1));
    await Promise.resolve();
    await Promise.resolve();
    expect(published).toEqual([]);
    expect(pending).toHaveLength(2);
    pending[1]!(artifact(2));
    await session.firstBuild;
    expect(published).toEqual([2]);
    await session.close();
  });

  it("never replaces the project or a declared source even with force", async () => {
    const root = await createProject();
    const project = join(root, "motion.json");
    const source = join(root, "render.mp4");
    const projectBefore = await readFile(project);
    const sourceBefore = await readFile(source);
    let compileCalls = 0;
    const dependencies = {
      buildProjectArtifact: async () => {
        compileCalls += 1;
        return artifact();
      },
      watchPath: () => ({ close: () => undefined })
    };

    for (const output of ["motion.json", "render.mp4"]) {
      await expect(startDevCommand({
        command: "dev",
        project: "motion.json",
        output,
        force: true,
        json: false
      }, { cwd: root, dependencies })).rejects.toMatchObject({
        code: "INPUT_INVALID"
      });
    }
    expect(compileCalls).toBe(0);
    expect(await readFile(project)).toEqual(projectBefore);
    expect(await readFile(source)).toEqual(sourceBefore);
  });
});

interface DeferredCompile {
  readonly options: ProjectArtifactOptions;
  readonly resolve: (result: Readonly<CompileArtifact>) => void;
}

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rma-dev-"));
  roots.push(root);
  await writeFile(join(root, "render.mp4"), "placeholder");
  await writeFile(join(root, "motion.json"), JSON.stringify({
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
      bitrate: { average: 300_000, peak: 600_000 }
    }],
    units: [{
      id: "body",
      kind: "body",
      source: "source",
      range: [0, 2],
      playback: "loop",
      ports: []
    }],
    initialState: "idle",
    states: [{ id: "idle", bodyUnit: "body" }],
    edges: [],
    bindings: []
  }));
  return root;
}

function artifact(marker = 4): Readonly<CompileArtifact> {
  return Object.freeze({
    assetBytes: new Uint8Array(10).fill(marker),
    bytes: 10,
    sha256: "b".repeat(64),
    provenance: Object.freeze({
      executable: "/ffmpeg",
      executableSha256: "f".repeat(64),
      executableIdentity: fileIdentity("1"),
      versionLine: "ffmpeg version test",
      versionOutputSha256: "1".repeat(64),
      configurationLine: "configuration: --enable-libx264",
      encodersOutputSha256: "2".repeat(64),
      calibrationSha256: "c".repeat(64),
      ffprobeExecutable: "/ffprobe",
      ffprobeExecutableSha256: "e".repeat(64),
      ffprobeExecutableIdentity: fileIdentity("2"),
      ffprobeVersionLine: "ffprobe version test",
      ffprobeVersionOutputSha256: "3".repeat(64),
      aggregateMemoryLimit: "derived"
    }),
    warnings: Object.freeze([]),
    buildDetails: Object.freeze({
      detailsVersion: "0.1"
    }) as unknown as CompileArtifact["buildDetails"]
  });
}

function resultFromArtifact(
  outputPath: string,
  built: Readonly<CompileArtifact>
) {
  return Object.freeze({
    outputPath,
    bytes: built.bytes,
    sha256: built.sha256,
    provenance: built.provenance,
    warnings: built.warnings,
    buildDetails: built.buildDetails
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
