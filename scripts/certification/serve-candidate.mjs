#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { mediaType, readVerifiedRegularFile } from "../release/candidate-artifacts.mjs";
import { verifyCandidateRoot } from "../release/candidate-root.mjs";

const FATAL_BOUNDARY_PATH = "/__aval_certification__/fatal-boundary-network.avl";
const FATAL_BOUNDARY_SOURCE = "fixtures/conformance/v1/h264.avl";
const CANDIDATE_RUN_CONFIG_PATH = "/__aval_certification__/run-config.json";
const INJECTED_NETWORK_FAILURE = Buffer.from('{"error":"injected-network-failure"}');

export function createCandidateAssetStore({ root, manifestBytes, manifestDigest, artifacts }) {
  if (!(manifestBytes instanceof Uint8Array) || !/^[0-9a-f]{64}$/u.test(manifestDigest)) throw new TypeError("candidate manifest identity is invalid");
  if (createHash("sha256").update(manifestBytes).digest("hex") !== manifestDigest) throw new Error("candidate manifest bytes do not match their digest");
  if (!Array.isArray(artifacts) || artifacts.length < 1 || artifacts.length > 4096) throw new TypeError("candidate serving allowlist is invalid");
  const allowlist = new Map();
  for (const artifact of artifacts) {
    if (allowlist.has(artifact.path)) throw new Error(`candidate serving allowlist duplicates ${artifact.path}`);
    allowlist.set(artifact.path, Object.freeze({ ...artifact }));
  }
  const runConfigBytes = createCandidateRunConfigBytes(manifestBytes, manifestDigest, allowlist);
  return Object.freeze({ root: resolve(root), manifestBytes: Buffer.from(manifestBytes), manifestDigest, allowlist, runConfigBytes });
}

export async function readCandidateAsset(store, requestPath) {
  const name = normalizeRequestPath(requestPath);
  if (name === "candidate-manifest.json") return Object.freeze({
    path: name,
    bytes: store.manifestBytes,
    sha256: store.manifestDigest,
    mediaType: "application/json"
  });
  const reference = store.allowlist.get(name);
  if (reference === undefined) throw new CandidateAssetNotFoundError(name);
  const bytes = await readVerifiedRegularFile(name, store.root, reference.byteLength);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== reference.byteLength || digest !== reference.sha256) throw new Error(`candidate asset changed after verification: ${name}`);
  return Object.freeze({ path: name, bytes, sha256: digest, mediaType: reference.mediaType ?? mediaType(name) });
}

export class CandidateAssetNotFoundError extends Error {}

export function startCandidateServer(store, { port = 4174, host = "127.0.0.1" } = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || host !== "127.0.0.1") throw new TypeError("candidate server binding is invalid");
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") throw new CandidateAssetNotFoundError("method");
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.search !== "" || url.hash !== "") throw new CandidateAssetNotFoundError("query");
      if (url.pathname === CANDIDATE_RUN_CONFIG_PATH) {
        if (store.runConfigBytes === null) throw new CandidateAssetNotFoundError("run-config");
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Content-Length", String(store.runConfigBytes.byteLength));
        response.setHeader("X-Aval-Candidate-Run-Config", "1");
        response.setHeader("X-Aval-Candidate-Manifest-Sha256", store.manifestDigest);
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.end(request.method === "HEAD" ? undefined : store.runConfigBytes);
        return;
      }
      if (url.pathname === FATAL_BOUNDARY_PATH) {
        const source = await readCandidateAsset(store, FATAL_BOUNDARY_SOURCE);
        serveFatalBoundaryRequest(request, response, store.manifestDigest, source);
        return;
      }
      const asset = await readCandidateAsset(store, url.pathname);
      response.statusCode = 200;
      response.setHeader("Content-Type", asset.mediaType);
      response.setHeader("Content-Length", String(asset.bytes.byteLength));
      response.setHeader("ETag", `\"sha256-${asset.sha256}\"`);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.end(request.method === "HEAD" ? undefined : asset.bytes);
    } catch (error) {
      response.statusCode = error instanceof CandidateAssetNotFoundError ? 404 : 409;
      response.setHeader("Cache-Control", "no-store");
      response.end(error instanceof CandidateAssetNotFoundError ? "Not found" : "Candidate identity changed");
    }
  });
  server.listen(port, host);
  return server;
}

function createCandidateRunConfigBytes(manifestBytes, manifestDigest, allowlist) {
  let candidate;
  try {
    candidate = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch {
    return null;
  }
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(candidate.commit) || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(candidate.tree)) return null;
  const fixture = allowlist.get(FATAL_BOUNDARY_SOURCE);
  const harness = allowlist.get("certification.html");
  if (!exactManifestArtifact(candidate.artifacts, fixture, FATAL_BOUNDARY_SOURCE) ||
    !exactManifestArtifact(candidate.artifacts, harness, "certification.html")) return null;
  return Buffer.from(`${JSON.stringify({
    schemaVersion: "1.0",
    runId: "candidate-functional-engine",
    mode: "functional",
    profile: "pull-request",
    candidateManifestDigest: manifestDigest,
    fixtureDigest: fixture.sha256,
    harnessDigest: harness.sha256,
    commit: candidate.commit,
    tree: candidate.tree,
    operatorRole: "automated-candidate-boundary-check",
    sourceUrl: `/${FATAL_BOUNDARY_SOURCE}`,
    profileClean: false,
    expectedRepetitions: 1,
    environment: {
      evidenceClass: "candidate-bound-functional-engine",
      brandedBrowserCertification: false,
      observedDisplayEvidence: false
    }
  })}\n`);
}

function exactManifestArtifact(artifacts, reference, path) {
  if (!Array.isArray(artifacts) || reference === undefined) return false;
  const artifact = artifacts.find((entry) => entry?.path === path);
  return artifact !== undefined && artifact.sha256 === reference.sha256 &&
    artifact.byteLength === reference.byteLength && artifact.mediaType === reference.mediaType;
}

function serveFatalBoundaryRequest(request, response, manifestDigest, source) {
  const range = parseRangeHeader(request.headers.range, source.bytes.byteLength);
  if (range !== null && (range.start === 0 || range.start === 64)) {
    const body = source.bytes.subarray(range.start, range.end + 1);
    response.statusCode = 206;
    response.setHeader("Content-Type", source.mediaType);
    response.setHeader("Content-Length", String(body.byteLength));
    response.setHeader("Content-Range", `bytes ${String(range.start)}-${String(range.end)}/${String(source.bytes.byteLength)}`);
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Content-Encoding", "identity");
    response.setHeader("ETag", `\"sha256-${source.sha256}\"`);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Aval-Candidate-Manifest-Sha256", manifestDigest);
    response.setHeader("X-Aval-Fault-Source-Sha256", source.sha256);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.end(request.method === "HEAD" ? undefined : body);
    return;
  }
  response.statusCode = 503;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", String(INJECTED_NETWORK_FAILURE.byteLength));
  response.setHeader("X-Aval-Candidate-Manifest-Sha256", manifestDigest);
  response.setHeader("X-Aval-Fault-Source-Sha256", source.sha256);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(request.method === "HEAD" ? undefined : INJECTED_NETWORK_FAILURE);
}

function parseRangeHeader(value, length) {
  if (typeof value !== "string") return null;
  const match = /^bytes=(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/u.exec(value);
  if (match === null) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
    start >= 0 && end >= start && end < length
    ? Object.freeze({ start, end })
    : null;
}

function normalizeRequestPath(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) throw new CandidateAssetNotFoundError("path");
  let pathname;
  try {
    pathname = decodeURIComponent(value);
  } catch {
    throw new CandidateAssetNotFoundError("encoding");
  }
  const name = pathname === "/" ? "certification.html" : pathname.startsWith("/") ? pathname.slice(1) : pathname;
  if (name === "" || name.includes("\\") || name.includes("\0") || name.includes("//") || name.split("/").some((part) => part === "" || part === "." || part === "..")) throw new CandidateAssetNotFoundError(name);
  return name;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parse(process.argv.slice(2));
  const candidatePath = required(args, "candidate");
  const expectedDigest = required(args, "expected-digest");
  const certification = await import(resolve("packages/certification/dist/index.js"));
  const verified = await verifyCandidateRoot({ manifestPath: candidatePath, expectedDigest, certification });
  const store = createCandidateAssetStore({
    root: verified.root,
    manifestBytes: verified.bytes,
    manifestDigest: verified.digest,
    artifacts: verified.candidate.artifacts
  });
  const port = Number(process.env.PORT ?? "4174");
  const server = startCandidateServer(store, { port });
  server.on("listening", () => process.stdout.write(`Certification candidate ${verified.digest}: http://127.0.0.1:${String(port)}/\n`));
}

function parse(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    if (!name?.startsWith("--")) throw new TypeError(`invalid argument: ${String(name)}`);
    result[name.slice(2)] = values[index + 1];
  }
  return result;
}
function required(values, name) { const value = values[name]; if (typeof value !== "string" || value.length < 1) throw new Error(`--${name} is required`); return value; }
