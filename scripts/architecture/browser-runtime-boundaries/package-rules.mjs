import { access, readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";

import {
  ADAPTER_SOURCE_PATH,
  CANONICAL_RUNTIME,
  FRAMEWORK_WRAPPERS,
  REVIEWED_PACKAGES,
  compareText,
  isJsonObject
} from "./contracts.mjs";

const REVIEWED_PACKAGE_DIRECTORIES = new Set(
  REVIEWED_PACKAGES.map(({ directory }) => directory)
);

const REQUIRED_ELEMENT_SOURCES = Object.freeze([
  Object.freeze({
    path: "packages/element/src/aval-element.ts",
    label: "canonical element runtime source"
  }),
  Object.freeze({
    path: "packages/element/src/player.ts",
    label: "canonical element runtime source"
  }),
  Object.freeze({
    path: ADAPTER_SOURCE_PATH,
    label: "canonical element adapter source"
  }),
  Object.freeze({
    path: "packages/element/src/player-session.ts",
    label: "player session owner source"
  }),
  Object.freeze({
    path: "packages/element/src/player-media-runtime.ts",
    label: "player media owner source"
  }),
  Object.freeze({
    path: "packages/element/src/element-runtime-session.ts",
    label: "element runtime session owner source"
  })
]);

const GENERATED_DIRECTORY_NAMES = new Set([
  ".git",
  ".next",
  ".playwright",
  ".playwright-cli",
  ".svelte-kit",
  ".vercel",
  "artifacts",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "output",
  "playwright-report",
  "test-results"
]);

const HISTORICAL_DIRECTORY_PATHS = new Set([
  "docs/evidence",
  "docs/superpowers"
]);

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".cts",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".ps1",
  ".py",
  ".sh",
  ".svelte",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".webmanifest",
  ".yaml",
  ".yml"
]);

const TEXT_FILE_NAMES = new Set([
  ".gitignore",
  ".npmrc",
  "Dockerfile",
  "LICENSE",
  "Makefile"
]);

export function assertWorkspaceRoot(manifest) {
  const workspaces = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : null;
  if (
    manifest.private !== true ||
    workspaces === null ||
    !workspaces.includes("packages/*")
  ) {
    throw new Error(
      "repository root package manifest does not identify the AVAL workspace"
    );
  }
}

export async function readRequiredManifest(path, label) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) throw new Error(`${label} is missing`);
    throw error;
  }

  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!isJsonObject(value)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return value;
}

export async function readReviewedPackageManifests(repositoryRoot) {
  const manifests = new Map();
  for (const reviewedPackage of REVIEWED_PACKAGES) {
    const label = reviewedPackage.directory === "element"
      ? "canonical element package manifest"
      : `reviewed package manifest packages/${reviewedPackage.directory}`;
    const manifest = await readRequiredManifest(
      join(repositoryRoot, "packages", reviewedPackage.directory, "package.json"),
      label
    );
    manifests.set(reviewedPackage.directory, manifest);
  }
  return manifests;
}

export async function assertElementSourceSentinels(repositoryRoot) {
  for (const source of REQUIRED_ELEMENT_SOURCES) {
    if (!await isFile(join(repositoryRoot, source.path))) {
      throw new Error(`${source.label} is missing: ${source.path}`);
    }
  }
}

export async function collectPackageTopologyViolations(
  repositoryRoot,
  violations
) {
  const packageRoot = join(repositoryRoot, "packages");
  const entries = await readdir(packageRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      !REVIEWED_PACKAGE_DIRECTORIES.has(entry.name)
    ) {
      violations.push(
        `packages/${entry.name} is outside the reviewed package architecture`
      );
    }
  }
}

export function collectManifestViolations(manifests, violations) {
  for (const reviewedPackage of REVIEWED_PACKAGES) {
    const manifest = manifests.get(reviewedPackage.directory);
    if (manifest.name !== reviewedPackage.name) {
      violations.push(
        `packages/${reviewedPackage.directory} must be named ${reviewedPackage.name}`
      );
    }
  }

  for (const wrapper of FRAMEWORK_WRAPPERS) {
    if (!hasExactWrapperRuntimeDependencies(manifests.get(wrapper))) {
      violations.push(
        `packages/${wrapper} must depend exactly on ${CANONICAL_RUNTIME}`
      );
    }
  }
  const alpha = manifests.get("alpha");
  if (dependencyNames(alpha).length ||
    !isAbsentOrEmptyDependencyRecord(alpha.optionalDependencies) ||
    !isAbsentOrEmptyBundleList(alpha.bundledDependencies) ||
    !isAbsentOrEmptyBundleList(alpha.bundleDependencies)) {
    violations.push("packages/alpha must have no runtime dependencies");
  }
  for (const wrapper of ["alpha-react", "alpha-svelte"]) {
    if (!hasExactWrapperRuntimeDependencies(manifests.get(wrapper), "@pixel-point/aval-alpha")) {
      violations.push(`packages/${wrapper} must depend exactly on @pixel-point/aval-alpha`);
    }
  }
}

export async function collectTextFiles(repositoryRoot, path, output) {
  const absolute = join(repositoryRoot, path);
  const entries = await readdir(absolute, { withFileTypes: true });

  for (const entry of entries) {
    const child = join(path, entry.name);
    const normalized = relative(repositoryRoot, join(repositoryRoot, child))
      .replaceAll("\\", "/");
    if (entry.isDirectory()) {
      if (
        HISTORICAL_DIRECTORY_PATHS.has(normalized) ||
        GENERATED_DIRECTORY_NAMES.has(entry.name)
      ) continue;
      await collectTextFiles(repositoryRoot, child, output);
      continue;
    }
    if (
      !entry.isFile() ||
      !TEXT_EXTENSIONS.has(extname(entry.name)) &&
      !TEXT_FILE_NAMES.has(entry.name)
    ) continue;
    output.push(normalized);
  }
}

export async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function dependencyNames(manifest) {
  if (!isJsonObject(manifest.dependencies)) return [];
  return Object.keys(manifest.dependencies).sort(compareText);
}

function hasExactWrapperRuntimeDependencies(manifest, runtime = CANONICAL_RUNTIME) {
  const dependencies = dependencyNames(manifest);
  return dependencies.length === 1 &&
    dependencies[0] === runtime &&
    isAbsentOrEmptyDependencyRecord(manifest.optionalDependencies) &&
    isAbsentOrEmptyBundleList(manifest.bundledDependencies) &&
    isAbsentOrEmptyBundleList(manifest.bundleDependencies);
}

function isAbsentOrEmptyDependencyRecord(value) {
  return value === undefined ||
    isJsonObject(value) && Object.keys(value).length === 0;
}

function isAbsentOrEmptyBundleList(value) {
  return value === undefined || value === false ||
    Array.isArray(value) && value.length === 0;
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
