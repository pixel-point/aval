import { execFile as execFileCallback } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSourceTreeAttestation,
  normalizeAttestationPath,
  parseSourceTreeAttestationArguments,
  verifySourceTreeAttestation
} from "../source-tree-attestation.mjs";

const execFile = promisify(execFileCallback);
const temporaryRoots: string[] = [];
const POLICY_PATH = "config/release/browser-certification-policy.json";
const TRACKED_SOURCE_PATH = "packages/demo/src/tracked.ts";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })));
});

describe("source-tree attestation", () => {
  it("is deterministic across input order and normalizes portable paths", async () => {
    const root = await createRepositoryFixture();
    const forward = servedFiles();
    const reverse = [...forward].reverse();

    const first = await attest(root, forward);
    const second = await attest(root, reverse);

    expect(second).toEqual(first);
    expect(first.headCommit).toBe(await git(root, "rev-parse", "HEAD"));
    expect(Object.values(first).slice(1).every((value) =>
      SHA256_PATTERN.test(value))).toBe(true);
    expect(normalizeAttestationPath("packages\\demo\\src\\tracked.ts"))
      .toBe(TRACKED_SOURCE_PATH);
    expect(() => normalizeAttestationPath("packages/demo/../secret.ts"))
      .toThrow("source-tree-attestation-path-path-unsafe");

    const absolutePolicy = await createSourceTreeAttestation({
      root,
      policyPath: resolve(root, POLICY_PATH),
      servedFiles: reverse
    });
    expect(absolutePolicy).toEqual(first);
  });

  it("distinguishes staged and unstaged tracked changes byte-for-byte", async () => {
    const root = await createRepositoryFixture();
    const base = await attest(root);

    await put(root, TRACKED_SOURCE_PATH, "export const tracked = 2;\n");
    const unstaged = await attest(root);
    expect(unstaged.trackedDiffSha256).not.toBe(base.trackedDiffSha256);

    await git(root, "add", TRACKED_SOURCE_PATH);
    const staged = await attest(root);
    expect(staged.trackedDiffSha256).not.toBe(unstaged.trackedDiffSha256);

    await put(root, TRACKED_SOURCE_PATH, "export const tracked = 3;\n");
    const both = await attest(root);
    expect(both.trackedDiffSha256).not.toBe(staged.trackedDiffSha256);
    expect(new Set([
      base.trackedDiffSha256,
      unstaged.trackedDiffSha256,
      staged.trackedDiffSha256,
      both.trackedDiffSha256
    ]).size).toBe(4);
  });

  it("hashes ignored untracked source bytes while excluding caches and artifacts", async () => {
    const root = await createRepositoryFixture();
    const base = await attest(root);
    const hiddenSource = "packages/demo/src/ignored-by-git.ts";

    await put(root, hiddenSource, "a");
    const oneByte = await attest(root);
    expect(oneByte.untrackedSourceTreeSha256)
      .not.toBe(base.untrackedSourceTreeSha256);

    await put(root, hiddenSource, "b");
    const changedByte = await attest(root);
    expect(changedByte.untrackedSourceTreeSha256)
      .not.toBe(oneByte.untrackedSourceTreeSha256);

    await put(root, "packages/demo/node_modules/ignored.js", "dependency");
    await put(root, "packages/demo/dist/ignored.js", "built-output");
    await put(root, "artifacts/browser-compatibility/runs/run-1/report.json", "artifact");
    await put(root, "not-source.bin", "root-noise");
    const excluded = await createSourceTreeAttestation({
      root,
      policyPath: POLICY_PATH,
      servedFiles: servedFiles(),
      artifactRunRoot: "artifacts/browser-compatibility/runs/run-1"
    });
    expect(excluded.untrackedSourceTreeSha256)
      .toBe(changedByte.untrackedSourceTreeSha256);

    await put(root, "fixtures/new-case/data.bin", "fixture");
    const includedFixture = await attest(root);
    expect(includedFixture.untrackedSourceTreeSha256)
      .not.toBe(excluded.untrackedSourceTreeSha256);
  });

  it("binds policy and served bytes independently", async () => {
    const root = await createRepositoryFixture();
    const baseFiles = servedFiles();
    const base = await attest(root, baseFiles);

    const changedFiles = servedFiles();
    changedFiles[0] = {
      ...changedFiles[0],
      bytes: Buffer.from("A", "utf8")
    };
    const servedByteChanged = await attest(root, changedFiles);
    expect(servedByteChanged.servedTreeSha256).not.toBe(base.servedTreeSha256);
    expect(servedByteChanged.policySha256).toBe(base.policySha256);

    await put(root, POLICY_PATH, "{\"version\":2}\n");
    const policyByteChanged = await attest(root, changedFiles);
    expect(policyByteChanged.policySha256).not.toBe(base.policySha256);
    expect(policyByteChanged.servedTreeSha256)
      .toBe(servedByteChanged.servedTreeSha256);
  });

  it("rejects ambiguous paths, duplicate routes, and source symlinks", async () => {
    const root = await createRepositoryFixture();

    await expect(attest(root, [
      { route: "/same", mode: "100644", bytes: Buffer.from("a") },
      { route: "/same", mode: "100644", bytes: Buffer.from("b") }
    ])).rejects.toThrow("source-tree-attestation-duplicate-served-route:/same");

    await expect(attest(root, [
      { route: "/playground/../secret", mode: "100644", bytes: Buffer.from("a") }
    ])).rejects.toThrow("source-tree-attestation-served-route-unsafe");

    await expect(createSourceTreeAttestation({
      root,
      policyPath: resolve(root, "..", "outside-policy.json"),
      servedFiles: servedFiles()
    })).rejects.toThrow("source-tree-attestation-policy-path-outside-repository");

    if (process.platform !== "win32") {
      const externalRoot = await mkdtemp(resolve(tmpdir(), "aval-attestation-external-"));
      temporaryRoots.push(externalRoot);
      const externalFile = resolve(externalRoot, "secret.ts");
      await writeFile(externalFile, "secret");
      await symlink(externalFile, resolve(root, "packages/demo/src/link.ts"));
      await expect(attest(root)).rejects.toThrow(
        "source-tree-attestation-untracked-symlink:packages/demo/src/link.ts"
      );
    }
  });

  it("strictly verifies complete records and keeps the CLI manifest-free", async () => {
    const root = await createRepositoryFixture();
    const record = await attest(root);

    expect(verifySourceTreeAttestation(record, { ...record })).toEqual(record);
    expect(() => verifySourceTreeAttestation(record, {
      ...record,
      policySha256: "0".repeat(64)
    })).toThrow("source-tree-attestation-mismatch:policySha256");
    expect(() => verifySourceTreeAttestation(record, {
      ...record,
      partialManifest: true
    })).toThrow("source-tree-attestation-actual-invalid");

    expect(parseSourceTreeAttestationArguments([
      "--root", root,
      "--policy", POLICY_PATH,
      "--artifact-run-root", "artifacts/browser-compatibility/runs/run-1"
    ])).toEqual({
      root,
      policyPath: POLICY_PATH,
      artifactRunRoot: "artifacts/browser-compatibility/runs/run-1"
    });
    expect(() => parseSourceTreeAttestationArguments([
      "--served-manifest", "partial.json"
    ])).toThrow("unknown argument: --served-manifest");
  });
});

type ServedRecord = {
  route: string;
  mode: "100644" | "100755";
  bytes: Buffer;
};

function servedFiles(): ServedRecord[] {
  return [
    { route: "/playground/", mode: "100644", bytes: Buffer.from("a", "utf8") },
    { route: "/rabbit/app.js", mode: "100644", bytes: Buffer.from("b", "utf8") }
  ];
}

async function attest(root: string, files = servedFiles()) {
  return createSourceTreeAttestation({
    root,
    policyPath: POLICY_PATH,
    servedFiles: files
  });
}

async function createRepositoryFixture(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "aval-source-attestation-"));
  temporaryRoots.push(root);
  await put(root, POLICY_PATH, "{\"version\":1}\n");
  await put(root, TRACKED_SOURCE_PATH, "export const tracked = 1;\n");
  await put(root, ".gitignore", `${hiddenFixturePath()}\n`);
  await git(root, "init", "--quiet");
  await git(root, "config", "user.email", "attestation@example.test");
  await git(root, "config", "user.name", "Attestation Test");
  await git(root, "add", ".gitignore", POLICY_PATH, TRACKED_SOURCE_PATH);
  await git(root, "commit", "--quiet", "-m", "fixture");
  return root;
}

function hiddenFixturePath(): string {
  return "packages/demo/src/ignored-by-git.ts";
}

async function put(root: string, path: string, contents: string | Uint8Array) {
  const absolutePath = resolve(root, ...path.split("/"));
  await mkdir(resolve(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, contents);
}

async function git(root: string, ...argumentsForGit: string[]): Promise<string> {
  const result = await execFile("git", ["-C", root, ...argumentsForGit], {
    encoding: "utf8",
    windowsHide: true
  });
  return String(result.stdout).trim();
}
