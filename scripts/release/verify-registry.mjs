#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readStableRegistryState } from "./registry-client.mjs";
import { loadPublicationAuthorization } from "./publication-support.mjs";
import { RELEASE_PACKAGE_NAMES } from "./release-set-model.mjs";

export function verifyRegistryReleaseSet({ releaseSet, tag, readState }) {
  if (tag !== "next" && tag !== "latest") throw new Error("registry verification tag must be next or latest");
  if (releaseSet === null || typeof releaseSet !== "object" || !Array.isArray(releaseSet.packages) || releaseSet.packages.length !== RELEASE_PACKAGE_NAMES.length) throw new Error("registry verification requires the exact public-package release set");
  if (releaseSet.packages.some((archive, index) => archive?.name !== RELEASE_PACKAGE_NAMES[index] || !isCanonicalIntegrity(archive.registryIntegrity))) throw new Error("registry verification release-set identity/order is invalid");
  const results = [];
  for (const archive of releaseSet.packages) {
    const state = readState(archive.name, "1.0.0");
    if (state === null || typeof state !== "object" || state.name !== archive.name || state.version !== "1.0.0" || state.tags === null || typeof state.tags !== "object" || Array.isArray(state.tags) || Object.keys(state.tags).length > 64) throw new Error(`registry state is invalid for ${archive.name}@1.0.0`);
    if (state.integrity !== archive.registryIntegrity) throw new Error(`registry integrity mismatch for ${archive.name}@1.0.0`);
    if ((state.tags[tag] ?? null) !== "1.0.0") throw new Error(`registry ${tag} tag mismatch for ${archive.name}`);
    results.push(Object.freeze({ name: archive.name, version: "1.0.0", registryIntegrity: archive.registryIntegrity, tag }));
  }
  return Object.freeze(results);
}

function isCanonicalIntegrity(value) {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(value)) return false;
  const encoded = value.slice(7);
  const bytes = Buffer.from(encoded, "base64");
  return bytes.byteLength === 64 && bytes.toString("base64") === encoded;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parse(process.argv.slice(2));
  const certification = await import(resolve("packages/certification/dist/index.js"));
  const authorization = await loadPublicationAuthorization({
    releaseRoot: resolve(required(args, "release-root")),
    expectedCandidateDigest: required(args, "expected-candidate-digest"),
    expectedReleaseDigest: required(args, "expected-release-digest"),
    expectedReleaseSetDigest: required(args, "expected-release-set-digest"),
    expectedCommit: required(args, "expected-commit"),
    certification
  });
  const tag = required(args, "tag");
  const packages = verifyRegistryReleaseSet({
    releaseSet: authorization.releaseSet,
    tag,
    readState: (name, version) => readStableRegistryState(name, version, { registry: authorization.policy.registry.url })
  });
  process.stdout.write(`${JSON.stringify({ status: "passed", registry: authorization.policy.registry.url, tag, packages })}\n`);
}

function parse(values) { const result = {}; for (let index = 0; index < values.length; index += 2) { const key = values[index]; if (!key?.startsWith("--")) throw new Error(`invalid argument ${String(key)}`); result[key.slice(2)] = values[index + 1] ?? "true"; } return result; }
function required(values, key) { const value = values[key]; if (typeof value !== "string" || value.length < 1) throw new Error(`--${key} is required`); return value; }
