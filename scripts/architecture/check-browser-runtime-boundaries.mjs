#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CANONICAL_RUNTIME,
  REMOVED_DIRECTORY,
  REMOVED_NAME,
  REMOVED_PACKAGE,
  compareText
} from "./browser-runtime-boundaries/contracts.mjs";
import {
  collectAdapterBarrelViolations,
  collectFrameworkProvenanceViolations
} from "./browser-runtime-boundaries/framework-adapter-rules.mjs";
import { collectRuntimeOwnershipViolations } from
  "./browser-runtime-boundaries/owner-rules.mjs";
import { collectAlphaProvenanceViolations } from
  "./browser-runtime-boundaries/alpha-rules.mjs";
import {
  assertElementSourceSentinels,
  assertWorkspaceRoot,
  collectManifestViolations,
  collectPackageTopologyViolations,
  collectTextFiles,
  exists,
  readRequiredManifest,
  readReviewedPackageManifests
} from "./browser-runtime-boundaries/package-rules.mjs";

export async function checkBrowserRuntimeBoundaries(
  root = process.cwd()
) {
  const repositoryRoot = resolve(root);
  const rootManifest = await readRequiredManifest(
    join(repositoryRoot, "package.json"),
    "repository root package manifest"
  );
  assertWorkspaceRoot(rootManifest);

  const manifests = await readReviewedPackageManifests(repositoryRoot);
  await assertElementSourceSentinels(repositoryRoot);

  const violations = [];
  await collectPackageTopologyViolations(repositoryRoot, violations);
  collectManifestViolations(manifests, violations);

  if (await exists(join(repositoryRoot, REMOVED_DIRECTORY))) {
    violations.push(`${REMOVED_DIRECTORY}: removed parallel runtime directory exists`);
  }
  const removedReport = join("etc", "api", `${REMOVED_NAME}.api.md`);
  if (await exists(join(repositoryRoot, removedReport))) {
    violations.push(`${removedReport}: removed parallel runtime API report exists`);
  }

  const files = [];
  await collectTextFiles(repositoryRoot, ".", files);
  const scannedFiles = [...new Set(files)].sort(compareText);
  await collectAlphaProvenanceViolations(repositoryRoot, scannedFiles, violations);
  await collectFrameworkProvenanceViolations(
    repositoryRoot,
    scannedFiles,
    violations
  );
  await collectAdapterBarrelViolations(repositoryRoot, violations);
  const reviewedRuntimeFiles = await collectRuntimeOwnershipViolations(
    repositoryRoot,
    violations
  );
  for (const path of scannedFiles) {
    const text = await readFile(join(repositoryRoot, path), "utf8");
    if (
      text.includes(REMOVED_PACKAGE) ||
      text.includes(REMOVED_DIRECTORY) ||
      text.includes(REMOVED_NAME)
    ) {
      violations.push(`${path}: references the removed parallel runtime`);
    }
  }

  if (violations.length > 0) {
    throw new Error([
      "canonical browser runtime boundary failed:",
      ...violations.sort(compareText).map((violation) => `- ${violation}`)
    ].join("\n"));
  }

  return Object.freeze({
    status: "passed",
    canonicalRuntime: CANONICAL_RUNTIME,
    scannedFiles: scannedFiles.length,
    reviewedRuntimeFiles
  });
}

const executedPath = process.argv[1] === undefined
  ? null
  : pathToFileURL(resolve(process.argv[1])).href;
if (executedPath === import.meta.url) {
  const result = await checkBrowserRuntimeBoundaries();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
