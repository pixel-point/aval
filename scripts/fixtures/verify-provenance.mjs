#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const digestPattern = /^[0-9a-f]{64}$/u;

export async function verifyProvenanceFile(path) {
  const absolute = resolve(repositoryRoot, path);
  const raw = await readFile(absolute, "utf8");
  const document = JSON.parse(raw);
  const errors = [];
  const verifiedPaths = new Set();
  scanMetadata(document, "$", errors);
  await scanReferences(document, "$", absolute, errors, verifiedPaths);
  if (errors.length > 0) throw new Error(`${relative(repositoryRoot, absolute)}:\n${errors.join("\n")}`);
  return { path: relative(repositoryRoot, absolute), references: verifiedPaths.size };
}

export async function discoverProvenanceFiles() {
  const files = [];
  await walk(join(repositoryRoot, "fixtures"), files);
  return files
    .filter((path) => /(?:^|\/)(?:provenance\.json|[^/]+\.provenance\.json)$/u.test(path))
    .map((path) => relative(repositoryRoot, path))
    .sort();
}

async function walk(directory, output) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, output);
    else if (entry.isFile()) output.push(path);
  }
}

function scanMetadata(value, path, errors) {
  if (typeof value === "string") {
    if (/\/(?:Users|home)\//u.test(value) || /[A-Za-z]:\\(?:Users|Documents)\\/u.test(value)) errors.push(`${path}: personal absolute path`);
    if (/https?:\/\/[^\s?]+\?[^\s]+/iu.test(value)) errors.push(`${path}: URL query`);
    if (/BEGIN [A-Z ]*PRIVATE KEY|(?:authorization|access[_-]?token|password)\s*[:=]/iu.test(value)) errors.push(`${path}: credential-like content`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanMetadata(item, `${path}[${index}]`, errors));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) scanMetadata(item, `${path}.${key}`, errors);
  }
}

async function scanReferences(value, path, provenancePath, errors, verifiedPaths) {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) await scanReferences(item, `${path}[${index}]`, provenancePath, errors, verifiedPaths);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const object = value;
  if (typeof object.path === "string" && typeof object.sha256 === "string" && (typeof object.bytes === "number" || typeof object.byteLength === "number")) {
    const expectedBytes = object.bytes ?? object.byteLength;
    if (!digestPattern.test(object.sha256)) errors.push(`${path}.sha256: invalid digest`);
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) errors.push(`${path}.bytes: invalid byte length`);
    const target = await resolveReference(object.path, provenancePath);
    if (target === null) {
      errors.push(`${path}.path: unresolved ${object.path}`);
    } else {
      const actual = await readFile(target);
      const actualDigest = createHash("sha256").update(actual).digest("hex");
      if (actual.byteLength !== expectedBytes) errors.push(`${path}.bytes: expected ${expectedBytes}, got ${actual.byteLength}`);
      if (actualDigest !== object.sha256) errors.push(`${path}.sha256: digest mismatch`);
      verifiedPaths.add(relative(repositoryRoot, target));
    }
  }
  if (typeof object.provenancePath === "string" && typeof object.provenanceSha256 === "string") {
    const target = await resolveReference(object.provenancePath, provenancePath);
    if (target === null) errors.push(`${path}.provenancePath: unresolved ${object.provenancePath}`);
    else {
      const bytes = await readFile(target);
      const actualDigest = createHash("sha256").update(bytes).digest("hex");
      if (!digestPattern.test(object.provenanceSha256) || actualDigest !== object.provenanceSha256) errors.push(`${path}.provenanceSha256: digest mismatch`);
      verifiedPaths.add(relative(repositoryRoot, target));
    }
  }
  for (const [key, item] of Object.entries(object)) await scanReferences(item, `${path}.${key}`, provenancePath, errors, verifiedPaths);
}

async function resolveReference(declaredPath, provenancePath) {
  if (declaredPath.includes("\\") || declaredPath.startsWith("/") || declaredPath.split("/").includes("..")) return null;
  const candidates = [
    resolve(repositoryRoot, declaredPath),
    resolve(dirname(provenancePath), declaredPath)
  ];
  for (const candidate of candidates) {
    const within = relative(repositoryRoot, candidate);
    if (within === ".." || within.startsWith(`..${sep}`)) continue;
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next deterministic location.
    }
  }
  return null;
}

async function main() {
  const requested = process.argv.slice(2);
  const paths = requested.length === 0 ? await discoverProvenanceFiles() : requested;
  const results = [];
  for (const path of paths) results.push(await verifyProvenanceFile(path));
  process.stdout.write(`${JSON.stringify({ status: "passed", files: results }, null, 2)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
