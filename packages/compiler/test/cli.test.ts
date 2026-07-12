import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import {
  exitStatusForCode,
  writeJsonResult,
  type CliIo
} from "../src/cli-output.js";
import { CompilerError, type CompilerErrorCode } from "../src/diagnostics.js";
import type { CompileArtifact } from "../src/model.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("programmatic CLI", () => {
  it("writes one canonical JSON result and keeps diagnostics off stdout", async () => {
    const root = await temporaryRoot();
    const capture = capturedIo();
    const status = await runCli([
      "compile", "source.mp4",
      "--loop", "0:2",
      "--out", "asset.rma",
      "--json"
    ], {
      cwd: root,
      io: capture.io,
      compileDependencies: {
        buildDirectArtifact: async () => compileArtifact(42, "c"),
        buildProjectArtifact: async () => {
          throw new Error("wrong compiler");
        }
      }
    });
    expect(status).toBe(0);
    expect(capture.stderr()).toBe("");
    expect(capture.stdout().endsWith("\n")).toBe(true);
    expect(capture.stdout().split("\n")).toHaveLength(2);
    expect(JSON.parse(capture.stdout())).toMatchObject({
      command: "compile",
      bytes: 42,
      sha256: "c".repeat(64)
    });
  });

  it("serializes a legal high-cardinality CLI result above M4 JSON limits", () => {
    const capture = capturedIo();
    const rows = Array.from({ length: 30_000 }, (_, frame) => ({
      frame,
      key: frame === 0,
      unit: "body.default"
    }));
    writeJsonResult(capture.io, { command: "inspect", rows });
    expect(capture.stderr()).toBe("");
    expect(capture.stdout().endsWith("\n")).toBe(true);
    const parsed = JSON.parse(capture.stdout()) as { rows: unknown[] };
    expect(parsed.rows).toHaveLength(30_000);
    expect(parsed.rows[29_999]).toEqual({
      frame: 29_999,
      key: false,
      unit: "body.default"
    });
  });

  it("returns CLI_USAGE as canonical JSON Lines without terminal injection", async () => {
    const capture = capturedIo();
    const status = await runCli([
      "inspect", "asset.rma", "--bad\u001b[31m", "--json"
    ], { io: capture.io });
    expect(status).toBe(2);
    expect(capture.stdout()).toBe("");
    const diagnostic = JSON.parse(capture.stderr());
    expect(diagnostic).toMatchObject({ code: "CLI_USAGE", severity: "error" });
    expect(capture.stderr()).not.toContain("\u001b");
  });

  it("maps tool failures while preserving stable diagnostics", async () => {
    const root = await temporaryRoot();
    const capture = capturedIo();
    const status = await runCli([
      "compile", "source.mp4", "--loop", "0:2", "--out", "asset.rma"
    ], {
      cwd: root,
      io: capture.io,
      compileDependencies: {
        buildDirectArtifact: async () => {
          throw new CompilerError("FFMPEG_NOT_FOUND", "ffmpeg is missing");
        },
        buildProjectArtifact: async () => {
          throw new Error("wrong compiler");
        }
      }
    });
    expect(status).toBe(3);
    expect(capture.stderr()).toContain("FFMPEG_NOT_FOUND");
    expect(capture.stdout()).toBe("");
  });

  it("bounds multibyte diagnostic fields before canonical serialization", async () => {
    const root = await temporaryRoot();
    const capture = capturedIo();
    const status = await runCli([
      "compile", "source.mp4", "--loop", "0:2", "--out", "asset.rma", "--json"
    ], {
      cwd: root,
      io: capture.io,
      compileDependencies: {
        buildDirectArtifact: async () => {
          throw new CompilerError("FFMPEG_FAILED", "encoder failed", {
            hint: "🙂".repeat(5_000)
          });
        },
        buildProjectArtifact: async () => {
          throw new Error("wrong compiler");
        }
      }
    });
    expect(status).toBe(4);
    const diagnostic = JSON.parse(capture.stderr()) as { hint: string };
    expect(new TextEncoder().encode(diagnostic.hint).byteLength).toBeLessThanOrEqual(4_096);
    expect(diagnostic.hint.endsWith("…")).toBe(true);
  });

  it("prints bounded help with no filesystem work", async () => {
    const capture = capturedIo();
    await expect(runCli([], { io: capture.io })).resolves.toBe(0);
    expect(capture.stdout()).toContain("rma compile");
    expect(capture.stderr()).toBe("");
  });

  it.each([
    ["inspect", ["inspect", "missing.rma"]],
    ["validate", ["validate", "missing.rma"]],
    ["unpack", ["unpack", "missing.rma", "--out", "unpacked"]]
  ] as const)("threads runtime cancellation through %s", async (_, argv) => {
    const root = await temporaryRoot();
    const capture = capturedIo();
    const controller = new AbortController();
    controller.abort("caller stopped the command");
    const status = await runCli(argv, {
      cwd: root,
      io: capture.io,
      signal: controller.signal
    });
    expect(status).toBe(130);
    expect(capture.stdout()).toBe("");
    expect(capture.stderr()).toContain("CANCELLED");
    expect(capture.stderr()).not.toContain("IO_FAILED");
  });

  it("keeps the closed error-code exit mapping stable", () => {
    const cases: readonly [CompilerErrorCode, number][] = [
      ["CLI_USAGE", 2],
      ["INPUT_INVALID", 2],
      ["FFMPEG_NOT_FOUND", 3],
      ["PROCESS_TIMEOUT", 3],
      ["FFMPEG_FAILED", 4],
      ["OPAQUE_ONLY_M5", 4],
      ["ASSET_INVALID", 5],
      ["OUTPUT_LIMIT", 5],
      ["IO_FAILED", 6],
      ["CANCELLED", 130]
    ];
    for (const [code, expected] of cases) {
      expect(exitStatusForCode(code)).toBe(expected);
    }
  });
});

function compileArtifact(bytes: number, digestCharacter: string): Readonly<CompileArtifact> {
  return Object.freeze({
    assetBytes: new Uint8Array(bytes).fill(9),
    bytes,
    sha256: digestCharacter.repeat(64),
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

function fileIdentity(inode: string) {
  return Object.freeze({
    device: "1",
    inode,
    size: 1,
    mtimeNanoseconds: "1",
    ctimeNanoseconds: "1"
  });
}

function capturedIo(): {
  readonly io: CliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text)
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join("")
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rma-cli-"));
  roots.push(root);
  return root;
}
