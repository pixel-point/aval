#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createBuiltExamplesAssetStore } from "./serve-built-examples.mjs";

const execFile = promisify(execFileCallback);
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(SCRIPT_DIRECTORY, "../..");
const DEFAULT_POLICY_PATH = "config/release/browser-certification-policy.json";
const HASH_DOMAIN = Buffer.from("aval-source-tree-attestation-v1", "utf8");
const MAX_GIT_OUTPUT_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TREE_BYTES = 512 * 1024 * 1024;
const MAX_TREE_FILES = 16_384;
const MODE_PATTERN = /^100(?:644|755)$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const HEAD_PATTERN = /^[a-f0-9]{40,64}$/u;
const ATTESTATION_KEYS = Object.freeze([
  "headCommit",
  "policySha256",
  "servedTreeSha256",
  "trackedDiffSha256",
  "untrackedSourceTreeSha256"
]);

/**
 * Directories whose untracked files can affect code, configuration, fixtures,
 * tests, generated API surfaces, or the operator-facing certification record.
 */
export const SOURCE_ATTESTATION_ROOTS = Object.freeze([
  ".github",
  "apps",
  "config",
  "docs",
  "etc",
  "examples",
  "fixtures",
  "packages",
  "schemas",
  "scripts",
  "tests"
]);

const CACHE_SEGMENTS = new Set([
  ".cache",
  ".git",
  ".playwright",
  ".playwright-cli",
  ".vercel",
  "coverage",
  "dist",
  "node_modules",
  "output",
  "playwright-report",
  "temp",
  "test-results"
]);

const ROOT_SOURCE_FILE = /^(?:\.gitignore|LICENSE|README\.md|SECURITY\.md|THIRD_PARTY_NOTICES\.md|THREAT-MODEL\.md|[A-Za-z0-9][A-Za-z0-9._-]*\.(?:c?js|mjs|cts|mts|ts|json|jsonc|ya?ml|toml|md|html|css))$/u;

/**
 * Bind the repository state and the exact HTTP snapshot used by compatibility
 * capture. `servedFiles` is an in-memory unit-test seam. Production callers
 * omit it so the closed route list and post-rewrite bytes are derived directly
 * from `createBuiltExamplesAssetStore()`.
 */
export async function createSourceTreeAttestation({
  root = WORKSPACE_ROOT,
  policyPath = DEFAULT_POLICY_PATH,
  servedFiles,
  artifactRunRoot = null
} = {}) {
  const { repositoryRoot, requestedRoot } = await requireRepositoryRoot(root);
  const normalizedPolicyPath = normalizeContainedPath(
    repositoryRoot,
    policyPath,
    "policy",
    requestedRoot
  );
  const normalizedArtifactRunRoot = artifactRunRoot === null
    ? null
    : normalizeArtifactRunRoot(repositoryRoot, artifactRunRoot, requestedRoot);

  const [
    headCommit,
    stagedDiff,
    unstagedDiff,
    untrackedPaths,
    policy,
    servedRecords
  ] = await Promise.all([
    readHeadCommit(repositoryRoot),
    readTrackedDiff(repositoryRoot, true),
    readTrackedDiff(repositoryRoot, false),
    listUntrackedSourcePaths(repositoryRoot, normalizedArtifactRunRoot),
    readStableRepositoryFile(repositoryRoot, normalizedPolicyPath, "policy"),
    loadServedRecords(repositoryRoot, servedFiles)
  ]);

  const untrackedRecords = await readUntrackedRecords(
    repositoryRoot,
    untrackedPaths
  );
  return Object.freeze({
    headCommit,
    trackedDiffSha256: hashTrackedDiff(stagedDiff, unstagedDiff),
    untrackedSourceTreeSha256: hashFileRecords(
      "untracked-source-tree",
      untrackedRecords,
      "path"
    ),
    policySha256: sha256(policy.bytes),
    servedTreeSha256: hashFileRecords(
      "served-tree",
      servedRecords,
      "route"
    )
  });
}

/** Strictly compare two complete attestation records. */
export function verifySourceTreeAttestation(expected, actual) {
  assertAttestationRecord(expected, "expected");
  assertAttestationRecord(actual, "actual");
  for (const key of ATTESTATION_KEYS) {
    if (expected[key] !== actual[key]) {
      throw new Error(`source-tree-attestation-mismatch:${key}`);
    }
  }
  return actual;
}

/** Normalize a caller-supplied repository-relative path on every platform. */
export function normalizeAttestationPath(value) {
  return normalizeRepositoryPath(value, "path");
}

async function requireRepositoryRoot(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("source-tree-attestation-root-invalid");
  }
  const requestedRoot = resolve(value);
  const metadata = await lstat(requestedRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("source-tree-attestation-root-invalid");
  }
  const repositoryRoot = await realpath(requestedRoot);
  const topLevel = decodeSingleLine(await gitBytes(repositoryRoot, [
    "rev-parse",
    "--show-toplevel"
  ]), "git-root");
  if (await realpath(topLevel) !== repositoryRoot) {
    throw new Error("source-tree-attestation-root-not-toplevel");
  }
  return Object.freeze({ repositoryRoot, requestedRoot });
}

async function readHeadCommit(root) {
  const value = decodeSingleLine(await gitBytes(root, [
    "rev-parse",
    "--verify",
    "HEAD^{commit}"
  ]), "head");
  if (!HEAD_PATTERN.test(value)) {
    throw new Error("source-tree-attestation-head-invalid");
  }
  return value;
}

async function readTrackedDiff(root, staged) {
  const argumentsForGit = [
    "diff",
    "--binary",
    "--full-index",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--ignore-submodules=none",
    "--src-prefix=a/",
    "--dst-prefix=b/"
  ];
  if (staged) argumentsForGit.push("--cached", "HEAD");
  argumentsForGit.push("--");
  return gitBytes(root, argumentsForGit);
}

async function listUntrackedSourcePaths(root, artifactRunRoot) {
  const output = await gitBytes(root, [
    "ls-files",
    "--others",
    "-z",
    "--"
  ]);
  const seen = new Set();
  const paths = [];
  for (const rawPath of splitNullTerminated(output, "untracked-path")) {
    const path = normalizeGitPath(rawPath);
    if (isExcludedPath(path, artifactRunRoot) || !isSourcePath(path)) continue;
    if (seen.has(path)) {
      throw new Error(`source-tree-attestation-duplicate-untracked-path:${path}`);
    }
    seen.add(path);
    paths.push(path);
  }
  paths.sort(compareUtf8);
  if (paths.length > MAX_TREE_FILES) {
    throw new Error("source-tree-attestation-untracked-file-limit");
  }
  return Object.freeze(paths);
}

async function readUntrackedRecords(root, paths) {
  const records = [];
  let totalBytes = 0;
  for (const path of paths) {
    const file = await readStableRepositoryFile(root, path, "untracked");
    totalBytes = checkedTreeBytes(totalBytes, file.bytes.byteLength, "untracked");
    records.push(Object.freeze({
      path,
      mode: file.mode,
      bytes: file.bytes
    }));
  }
  return Object.freeze(records);
}

async function loadServedRecords(root, servedFiles) {
  if (servedFiles !== undefined) return normalizeServedRecords(servedFiles);
  const store = await createBuiltExamplesAssetStore({ root });
  const records = store.routeList.map((route) => {
    const asset = store.lookup(route);
    if (asset === null) {
      throw new Error(`source-tree-attestation-served-route-missing:${route}`);
    }
    return Object.freeze({ route, mode: "100644", bytes: asset.body });
  });
  return normalizeServedRecords(records);
}

function normalizeServedRecords(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TREE_FILES) {
    throw new Error("source-tree-attestation-served-files-invalid");
  }
  const records = [];
  const routes = new Set();
  let totalBytes = 0;
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) ||
        Object.keys(entry).sort().join(",") !== "bytes,mode,route") {
      throw new Error("source-tree-attestation-served-record-invalid");
    }
    const route = normalizeServedRoute(entry.route);
    if (routes.has(route)) {
      throw new Error(`source-tree-attestation-duplicate-served-route:${route}`);
    }
    routes.add(route);
    if (!MODE_PATTERN.test(String(entry.mode))) {
      throw new Error(`source-tree-attestation-served-mode-invalid:${route}`);
    }
    if (!(entry.bytes instanceof Uint8Array)) {
      throw new Error(`source-tree-attestation-served-bytes-invalid:${route}`);
    }
    const bytes = Buffer.from(entry.bytes);
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw new Error(`source-tree-attestation-served-file-too-large:${route}`);
    }
    totalBytes = checkedTreeBytes(totalBytes, bytes.byteLength, "served");
    records.push(Object.freeze({
      route,
      mode: String(entry.mode),
      bytes
    }));
  }
  records.sort((left, right) => compareUtf8(left.route, right.route));
  return Object.freeze(records);
}

async function readStableRepositoryFile(root, path, purpose) {
  await assertSymlinkFreePath(root, path, purpose);
  const absolutePath = resolveRepositoryPath(root, path);
  const before = await lstat(absolutePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`source-tree-attestation-${purpose}-not-regular:${path}`);
  }
  if (before.size > BigInt(MAX_FILE_BYTES)) {
    throw new Error(`source-tree-attestation-${purpose}-file-too-large:${path}`);
  }
  const bytes = await readFile(absolutePath);
  const after = await lstat(absolutePath, { bigint: true });
  if (!sameFileSnapshot(before, after) || BigInt(bytes.byteLength) !== after.size) {
    throw new Error(`source-tree-attestation-${purpose}-file-changed:${path}`);
  }
  return Object.freeze({
    bytes,
    mode: (after.mode & 0o111n) === 0n ? "100644" : "100755"
  });
}

async function assertSymlinkFreePath(root, path, purpose) {
  let current = root;
  const segments = path.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new Error(`source-tree-attestation-${purpose}-symlink:${path}`);
    }
    if (index < segments.length - 1 && !metadata.isDirectory()) {
      throw new Error(`source-tree-attestation-${purpose}-parent-invalid:${path}`);
    }
  }
}

function resolveRepositoryPath(root, path) {
  const absolutePath = resolve(root, ...path.split("/"));
  const relation = relative(root, absolutePath);
  if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`) ||
      isAbsolute(relation)) {
    throw new Error(`source-tree-attestation-path-outside-root:${path}`);
  }
  return absolutePath;
}

function normalizeRepositoryPath(value, purpose) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 ||
      value.includes("\0")) {
    throw new Error(`source-tree-attestation-${purpose}-path-invalid`);
  }
  const normalized = value.replaceAll("\\", "/").normalize("NFC");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) {
    throw new Error(`source-tree-attestation-${purpose}-path-absolute`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`source-tree-attestation-${purpose}-path-unsafe`);
  }
  return segments.join("/");
}

function normalizeGitPath(value) {
  if (value.includes("\\")) {
    throw new Error("source-tree-attestation-untracked-path-nonportable");
  }
  return normalizeRepositoryPath(value, "untracked");
}

function normalizeArtifactRunRoot(root, value, requestedRoot) {
  const path = normalizeContainedPath(
    root,
    value,
    "artifact-run-root",
    requestedRoot
  );
  if (!path.startsWith("artifacts/browser-compatibility/runs/")) {
    throw new Error("source-tree-attestation-artifact-run-root-invalid");
  }
  return path;
}

function normalizeContainedPath(root, value, purpose, requestedRoot = root) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`source-tree-attestation-${purpose}-path-invalid`);
  }
  if (!isAbsolute(value)) return normalizeRepositoryPath(value, purpose);
  for (const candidateRoot of new Set([root, requestedRoot])) {
    const relation = relative(candidateRoot, resolve(value));
    if (relation !== "" && relation !== ".." &&
        !relation.startsWith(`..${sep}`) && !isAbsolute(relation)) {
      return normalizeRepositoryPath(relation.split(sep).join("/"), purpose);
    }
  }
  throw new Error(`source-tree-attestation-${purpose}-path-outside-repository`);
}

function normalizeServedRoute(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 ||
      value.includes("\0") || value.includes("\\") || value.includes("?") ||
      value.includes("#") || !value.startsWith("/")) {
    throw new Error("source-tree-attestation-served-route-invalid");
  }
  const normalized = value.normalize("NFC");
  if (!/^\/(?:[A-Za-z0-9._~!$&'()+,;=:@-]+\/)*(?:[A-Za-z0-9._~!$&'()+,;=:@-]+)?$/u.test(normalized)) {
    throw new Error(`source-tree-attestation-served-route-invalid:${value}`);
  }
  const segments = normalized.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`source-tree-attestation-served-route-unsafe:${value}`);
  }
  return normalized;
}

function normalizeArtifactPrefix(path) {
  return path.endsWith("/") ? path : `${path}/`;
}

function isExcludedPath(path, artifactRunRoot) {
  const segments = path.split("/");
  if (segments.some((segment) => CACHE_SEGMENTS.has(segment))) return true;
  if (artifactRunRoot === null) return false;
  return path === artifactRunRoot ||
    path.startsWith(normalizeArtifactPrefix(artifactRunRoot));
}

function isSourcePath(path) {
  const segments = path.split("/");
  if (segments.length === 1) return ROOT_SOURCE_FILE.test(path);
  return SOURCE_ATTESTATION_ROOTS.includes(segments[0]);
}

function hashTrackedDiff(staged, unstaged) {
  return hashFrames("tracked-diff", [
    Buffer.from("staged", "utf8"),
    staged,
    Buffer.from("unstaged", "utf8"),
    unstaged
  ]);
}

function hashFileRecords(domain, records, identityKey) {
  const frames = [Buffer.from(String(records.length), "ascii")];
  for (const record of records) {
    frames.push(
      Buffer.from(record[identityKey], "utf8"),
      Buffer.from(record.mode, "ascii"),
      record.bytes
    );
  }
  return hashFrames(domain, frames);
}

function hashFrames(domain, frames) {
  const hash = createHash("sha256");
  updateFrame(hash, HASH_DOMAIN);
  updateFrame(hash, Buffer.from(domain, "utf8"));
  for (const frame of frames) updateFrame(hash, frame);
  return hash.digest("hex");
}

function updateFrame(hash, value) {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkedTreeBytes(total, addition, purpose) {
  const next = total + addition;
  if (!Number.isSafeInteger(next) || next > MAX_TREE_BYTES) {
    throw new Error(`source-tree-attestation-${purpose}-tree-too-large`);
  }
  return next;
}

function sameFileSnapshot(left, right) {
  return left.isFile() && right.isFile() &&
    left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.size === right.size && left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function splitNullTerminated(bytes, purpose) {
  if (bytes.byteLength === 0) return [];
  if (bytes.at(-1) !== 0) {
    throw new Error(`source-tree-attestation-${purpose}-unterminated`);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const values = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index === start) {
      throw new Error(`source-tree-attestation-${purpose}-empty`);
    }
    try {
      values.push(decoder.decode(bytes.subarray(start, index)));
    } catch {
      throw new Error(`source-tree-attestation-${purpose}-utf8-invalid`);
    }
    start = index + 1;
  }
  return values;
}

function decodeSingleLine(bytes, purpose) {
  let value;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`source-tree-attestation-${purpose}-utf8-invalid`);
  }
  if (!value.endsWith("\n") || value.slice(0, -1).includes("\n") || value.includes("\r")) {
    throw new Error(`source-tree-attestation-${purpose}-line-invalid`);
  }
  return value.slice(0, -1);
}

async function gitBytes(root, argumentsForGit) {
  try {
    const result = await execFile("git", [
      "-c",
      "color.ui=false",
      "-c",
      "diff.algorithm=myers",
      "-C",
      root,
      "--no-pager",
      ...argumentsForGit
    ], {
      encoding: null,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true
    });
    return Buffer.from(result.stdout);
  } catch (error) {
    const message = error instanceof Error
      ? error.message.replace(/[\r\n\t]+/gu, " ").slice(0, 512)
      : String(error).slice(0, 512);
    throw new Error(`source-tree-attestation-git-failed:${message}`);
  }
}

function assertAttestationRecord(value, purpose) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== ATTESTATION_KEYS.join(",")) {
    throw new Error(`source-tree-attestation-${purpose}-invalid`);
  }
  if (!HEAD_PATTERN.test(String(value.headCommit))) {
    throw new Error(`source-tree-attestation-${purpose}-head-invalid`);
  }
  for (const key of ATTESTATION_KEYS) {
    if (key === "headCommit") continue;
    if (!SHA256_PATTERN.test(String(value[key]))) {
      throw new Error(`source-tree-attestation-${purpose}-${key}-invalid`);
    }
  }
}

export function parseSourceTreeAttestationArguments(values) {
  const parsed = {
    root: WORKSPACE_ROOT,
    policyPath: DEFAULT_POLICY_PATH,
    artifactRunRoot: null
  };
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    const next = values[++index] ?? null;
    if (next === null) throw new Error(`missing value for ${String(key)}`);
    if (key === "--root") parsed.root = next;
    else if (key === "--policy") parsed.policyPath = next;
    else if (key === "--artifact-run-root") parsed.artifactRunRoot = next;
    else throw new Error(`unknown argument: ${String(key)}`);
  }
  return Object.freeze(parsed);
}

async function main() {
  const options = parseSourceTreeAttestationArguments(process.argv.slice(2));
  const attestation = await createSourceTreeAttestation(options);
  process.stdout.write(`${JSON.stringify(attestation)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
