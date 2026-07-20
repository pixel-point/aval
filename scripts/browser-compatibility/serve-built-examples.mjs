#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4179;
const MAX_REQUEST_TARGET_BYTES = 4_096;
const MAX_ASSET_COUNT = 8_192;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const NO_STORE = "no-store";
const SNAPSHOT_ASSETS = new WeakMap();

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(SCRIPT_DIRECTORY, "../..");

export const BUILT_EXAMPLE_ROUTE_MAP = Object.freeze({
  playground: "/playground/",
  rabbit: "/rabbit/",
  codecs: "/codecs/",
  orb: "/orb/",
  codecProbe: "/probe/",
  rendererIsolator: "/isolators/renderer/"
});

const DEMOS = Object.freeze([
  Object.freeze({
    mount: BUILT_EXAMPLE_ROUTE_MAP.playground,
    directory: "examples/end-user-playground/dist",
    authoredBase: "/"
  }),
  Object.freeze({
    mount: BUILT_EXAMPLE_ROUTE_MAP.rabbit,
    directory: "examples/grass-rabbit/dist",
    authoredBase: "/aval/"
  }),
  Object.freeze({
    mount: BUILT_EXAMPLE_ROUTE_MAP.codecs,
    directory: "examples/grass-rabbit-codecs/dist",
    authoredBase: "/"
  }),
  Object.freeze({
    mount: BUILT_EXAMPLE_ROUTE_MAP.orb,
    directory: "examples/kinetic-orb/dist",
    authoredBase: "/"
  })
]);

const PROBE_FILES = Object.freeze([
  Object.freeze({
    route: BUILT_EXAMPLE_ROUTE_MAP.codecProbe,
    file: "scripts/browser-compatibility/codec-probe.html"
  }),
  Object.freeze({
    route: `${BUILT_EXAMPLE_ROUTE_MAP.codecProbe}codec-probe.js`,
    file: "scripts/browser-compatibility/codec-probe.js"
  }),
  Object.freeze({
    route: BUILT_EXAMPLE_ROUTE_MAP.rendererIsolator,
    file: "scripts/browser-compatibility/renderer-isolator.html"
  }),
  Object.freeze({
    route: `${BUILT_EXAMPLE_ROUTE_MAP.rendererIsolator}renderer-isolator.js`,
    file: "scripts/browser-compatibility/renderer-isolator.js"
  })
]);

const MODULE_TREES = Object.freeze([
  Object.freeze({
    mount: `${BUILT_EXAMPLE_ROUTE_MAP.codecProbe}modules/element/`,
    directory: "packages/element/dist"
  }),
  Object.freeze({
    mount: `${BUILT_EXAMPLE_ROUTE_MAP.codecProbe}modules/graph/`,
    directory: "packages/graph/dist"
  }),
  Object.freeze({
    mount: `${BUILT_EXAMPLE_ROUTE_MAP.codecProbe}modules/format/`,
    directory: "packages/format/dist"
  }),
  Object.freeze({
    mount: `${BUILT_EXAMPLE_ROUTE_MAP.rendererIsolator}modules/element/`,
    directory: "packages/element/dist"
  })
]);

/**
 * Read every served byte before listening. A running capture therefore cannot
 * mix outputs from two builds, even if a developer rebuilds the workspace.
 */
export async function createBuiltExamplesAssetStore(
  { root = WORKSPACE_ROOT } = {}
) {
  const workspaceRoot = resolve(root);
  const workspaceRealRoot = await requireWorkspaceRoot(workspaceRoot);
  const assets = new Map();
  let totalBytes = 0;

  const add = async (route, absolutePath, transform) => {
    requireRoutePath(route);
    if (assets.has(route)) throw new Error(`duplicate built-example route: ${route}`);
    if (assets.size >= MAX_ASSET_COUNT) {
      throw new Error("built-example route count exceeds the fixed limit");
    }
    assertContained(workspaceRoot, absolutePath);
    await assertSymlinkFreePath(workspaceRoot, workspaceRealRoot, absolutePath);
    const bytes = await readStableRegularFile(absolutePath);
    const servedBytes = transform === undefined ? bytes : transform(bytes);
    if (!(servedBytes instanceof Uint8Array) || servedBytes.byteLength > MAX_FILE_BYTES) {
      throw new Error(`built-example file exceeds the fixed limit: ${absolutePath}`);
    }
    totalBytes = checkedAdd(totalBytes, servedBytes.byteLength);
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error("built-example snapshot exceeds the fixed byte limit");
    }
    const body = Buffer.from(servedBytes);
    const sha256 = createHash("sha256").update(body).digest("hex");
    assets.set(route, Object.freeze({
      body,
      etag: `"sha256-${sha256}"`,
      mediaType: mediaType(absolutePath)
    }));
  };

  for (const demo of DEMOS) {
    const directory = resolveInside(workspaceRoot, demo.directory);
    await assertSymlinkFreePath(workspaceRoot, workspaceRealRoot, directory);
    const files = await listRegularFiles(directory);
    if (!files.includes("index.html")) {
      throw new Error(`built example has no index.html: ${demo.directory}`);
    }
    const topLevelNames = Object.freeze([
      ...new Set(files.map((name) => name.split("/")[0]))
    ].sort((left, right) => right.length - left.length));
    for (const name of files) {
      const route = name === "index.html" ? demo.mount : `${demo.mount}${name}`;
      const path = resolveInside(directory, name);
      const transform = isTextAsset(name)
        ? (bytes) => rewriteBuiltBase(
            bytes,
            demo.authoredBase,
            demo.mount,
            topLevelNames,
            name
          )
        : undefined;
      await add(route, path, transform);
      if (name === "index.html") {
        await add(`${demo.mount}index.html`, path, transform);
      }
    }
  }

  for (const probe of PROBE_FILES) {
    await add(probe.route, resolveInside(workspaceRoot, probe.file));
  }

  for (const tree of MODULE_TREES) {
    const directory = resolveInside(workspaceRoot, tree.directory);
    await assertSymlinkFreePath(workspaceRoot, workspaceRealRoot, directory);
    const files = (await listRegularFiles(directory))
      .filter((name) => name.endsWith(".js"));
    if (files.length === 0) {
      throw new Error(`browser module tree is empty: ${tree.directory}`);
    }
    for (const name of files) {
      await add(`${tree.mount}${name}`, resolveInside(directory, name));
    }
  }

  const routeList = Object.freeze([...assets.keys()].sort());
  const store = Object.freeze({
    routeList,
    totalBytes,
    lookup(route) {
      const asset = assets.get(route);
      return asset === undefined ? null : copyPublicAsset(asset);
    }
  });
  SNAPSHOT_ASSETS.set(store, assets);
  return store;
}

export function createBuiltExamplesServer(assetStore) {
  const assets = assetStore !== null && typeof assetStore === "object"
    ? SNAPSHOT_ASSETS.get(assetStore)
    : undefined;
  if (assets === undefined) {
    throw new TypeError("built-example asset store is invalid");
  }
  return createServer((request, response) => {
    try {
      serveRequest(assets, request, response);
    } catch {
      sendError(response, 500, "Internal server error");
    }
  });
}

export async function startBuiltExamplesServer(
  assetStore,
  { host = DEFAULT_HOST, port = DEFAULT_PORT } = {}
) {
  requireBinding(host, port);
  const server = createBuiltExamplesServer(assetStore);
  await new Promise((resolveListening, reject) => {
    const failed = (error) => {
      server.off("listening", listening);
      reject(error);
    };
    const listening = () => {
      server.off("error", failed);
      resolveListening();
    };
    server.once("error", failed);
    server.once("listening", listening);
    server.listen(port, host);
  });
  return server;
}

function serveRequest(assets, request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendError(response, 405, "Method not allowed", request.method === "HEAD");
    return;
  }
  let pathname;
  try {
    pathname = parseRequestPath(request.url);
  } catch {
    sendError(response, 404, "Not found", request.method === "HEAD");
    return;
  }
  const asset = assets.get(pathname);
  if (asset === undefined) {
    sendError(response, 404, "Not found", request.method === "HEAD");
    return;
  }

  setAssetHeaders(response, asset);
  if (etagMatches(request.headers["if-none-match"], asset.etag)) {
    response.statusCode = 304;
    response.end();
    return;
  }

  const rangeHeader = request.headers.range;
  const ifRange = request.headers["if-range"];
  const mayUseRange = typeof rangeHeader === "string" &&
    (typeof ifRange !== "string" || ifRange === asset.etag);
  if (mayUseRange) {
    const range = parseByteRange(rangeHeader, asset.body.byteLength);
    if (range === null) {
      response.statusCode = 416;
      response.setHeader("Content-Range", `bytes */${String(asset.body.byteLength)}`);
      response.setHeader("Content-Length", "0");
      response.end();
      return;
    }
    const body = asset.body.subarray(range.start, range.end + 1);
    response.statusCode = 206;
    response.setHeader(
      "Content-Range",
      `bytes ${String(range.start)}-${String(range.end)}/${String(asset.body.byteLength)}`
    );
    response.setHeader("Content-Length", String(body.byteLength));
    response.end(request.method === "HEAD" ? undefined : body);
    return;
  }

  response.statusCode = 200;
  response.setHeader("Content-Length", String(asset.body.byteLength));
  response.end(request.method === "HEAD" ? undefined : asset.body);
}

function setAssetHeaders(response, asset) {
  response.setHeader("Content-Type", asset.mediaType);
  response.setHeader("Content-Encoding", "identity");
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("ETag", asset.etag);
  response.setHeader("Cache-Control", IMMUTABLE_CACHE);
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
  );
}

function sendError(response, status, message, head = false) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = Buffer.from(message);
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Content-Length", String(body.byteLength));
  response.setHeader("Cache-Control", NO_STORE);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(head ? undefined : body);
}

function parseRequestPath(value) {
  if (
    typeof value !== "string" || value.length < 1 ||
    Buffer.byteLength(value) > MAX_REQUEST_TARGET_BYTES
  ) {
    throw new TypeError("request target is invalid");
  }
  const query = value.indexOf("?");
  const rawPath = query === -1 ? value : value.slice(0, query);
  if (!rawPath.startsWith("/") || rawPath.includes("\\") || rawPath.includes("\0")) {
    throw new TypeError("request path is invalid");
  }
  let decoded;
  try { decoded = decodeURIComponent(rawPath); }
  catch { throw new TypeError("request path encoding is invalid"); }
  if (
    decoded.includes("\\") || decoded.includes("\0") ||
    decoded.includes("//") ||
    decoded.split("/").some((part, index) =>
      index > 0 && (part === "." || part === ".."))
  ) {
    throw new TypeError("request path traversal is invalid");
  }
  return decoded;
}

function parseByteRange(value, length) {
  if (!Number.isSafeInteger(length) || length < 0 || typeof value !== "string") {
    return null;
  }
  const match = /^bytes=(?:(0|[1-9][0-9]*)-(0|[1-9][0-9]*)?|-([1-9][0-9]*))$/u
    .exec(value);
  if (match === null || length === 0) return null;
  if (match[3] !== undefined) {
    const suffix = Number(match[3]);
    if (!Number.isSafeInteger(suffix)) return null;
    const start = Math.max(0, length - suffix);
    return Object.freeze({ start, end: length - 1 });
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] === undefined ? length - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) ||
    start >= length || requestedEnd < start
  ) return null;
  return Object.freeze({ start, end: Math.min(requestedEnd, length - 1) });
}

function etagMatches(value, etag) {
  if (typeof value !== "string" || value.length > 4_096) return false;
  return value.split(",").some((candidate) => {
    const token = candidate.trim();
    return token === "*" || token === etag || token === `W/${etag}`;
  });
}

async function listRegularFiles(directory) {
  const output = [];
  await visit(directory, "");
  output.sort();
  return output;

  async function visit(absoluteDirectory, prefix) {
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "" || entry.name === "." || entry.name === "..") {
        throw new Error(`invalid built-example entry: ${entry.name}`);
      }
      const absolutePath = resolveInside(absoluteDirectory, entry.name);
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new Error(`built-example route cannot contain a symlink: ${absolutePath}`);
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, name);
      } else if (entry.isFile()) {
        output.push(name);
      } else {
        throw new Error(`built-example route contains a non-file: ${absolutePath}`);
      }
    }
  }
}

async function requireWorkspaceRoot(root) {
  const stats = await lstat(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`built-example workspace root cannot be a symlink: ${root}`);
  }
  return realpath(root);
}

async function assertSymlinkFreePath(root, realRoot, path) {
  assertContained(root, path);
  const child = relative(root, path);
  let current = root;
  for (const component of child.split(sep)) {
    current = resolve(current, component);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) {
      throw new Error(`built-example route cannot contain a symlink: ${current}`);
    }
  }
  const resolvedRealPath = await realpath(path);
  const expectedRealPath = resolve(realRoot, child);
  if (resolvedRealPath !== expectedRealPath) {
    throw new Error(`built-example route cannot contain a symlink: ${path}`);
  }
  assertContained(realRoot, resolvedRealPath);
}

async function readStableRegularFile(path) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_FILE_BYTES)) {
    throw new Error(`built-example source is not a bounded regular file: ${path}`);
  }
  const bytes = await readFile(path);
  const after = await lstat(path, { bigint: true });
  if (
    !after.isFile() || after.isSymbolicLink() || before.dev !== after.dev ||
    before.ino !== after.ino || before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs || BigInt(bytes.byteLength) !== after.size
  ) {
    throw new Error(`built-example source changed while snapshotting: ${path}`);
  }
  return bytes;
}

function copyPublicAsset(asset) {
  return Object.freeze({
    body: Buffer.from(asset.body),
    etag: asset.etag,
    mediaType: asset.mediaType
  });
}

function rewriteBuiltBase(bytes, authoredBase, mount, topLevelNames, name) {
  let text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (topLevelNames.length > 0) {
    const authoredRoute = new RegExp(
      `${escapeRegExp(authoredBase)}(${topLevelNames.map(escapeRegExp).join("|")})`,
      "gu"
    );
    text = text.replace(authoredRoute, `${mount}$1`);
  }
  if (name.endsWith(".html")) {
    for (const attribute of ["href", "action"]) {
      text = text.replaceAll(`${attribute}="${authoredBase}"`, `${attribute}="${mount}"`);
      text = text.replaceAll(`${attribute}='${authoredBase}'`, `${attribute}='${mount}'`);
    }
  }
  if (name.endsWith(".js")) {
    for (const quote of ["\"", "'", "`"]) {
      text = text.replaceAll(
        `new URL(${quote}${authoredBase}${quote},location.href)`,
        `new URL(${quote}${mount}${quote},location.href)`
      );
    }
  }
  return Buffer.from(text);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isTextAsset(name) {
  return name.endsWith(".html") || name.endsWith(".js") || name.endsWith(".css");
}

function mediaType(path) {
  switch (extname(path).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js":
    case ".mjs": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".avl": return "application/vnd.aval";
    case ".png": return "image/png";
    case ".svg": return "image/svg+xml";
    case ".woff2": return "font/woff2";
    case ".map": return "application/json; charset=utf-8";
    default: return "application/octet-stream";
  }
}

function requireBinding(host, port) {
  if (host !== DEFAULT_HOST || port !== DEFAULT_PORT) {
    throw new TypeError("built-example server must bind to 127.0.0.1:4179");
  }
}

function requireRoutePath(route) {
  if (
    typeof route !== "string" || !route.startsWith("/") ||
    route.includes("\\") || route.includes("\0") || route.includes("//") ||
    route.split("/").some((part, index) =>
      index > 0 && part !== "" && (part === "." || part === ".."))
  ) {
    throw new TypeError(`invalid built-example route: ${String(route)}`);
  }
}

function resolveInside(root, name) {
  const path = resolve(root, name);
  assertContained(root, path);
  return path;
}

function assertContained(root, path) {
  const child = relative(root, path);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || resolve(path) !== path) {
    throw new Error(`path escapes the built-example root: ${path}`);
  }
}

function checkedAdd(left, right) {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new RangeError("built-example bytes overflow");
  return value;
}

export function parseBuiltExamplesServerArguments(values) {
  const result = { host: DEFAULT_HOST, port: DEFAULT_PORT };
  const seen = new Set();
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (
      (flag !== "--host" && flag !== "--port") || value === undefined ||
      seen.has(flag)
    ) throw new TypeError(`invalid server argument: ${String(flag)}`);
    seen.add(flag);
    if (flag === "--host") result.host = value;
    else if (/^(?:0|[1-9][0-9]{0,4})$/u.test(value)) result.port = Number(value);
    else throw new TypeError("--port is invalid");
  }
  requireBinding(result.host, result.port);
  return Object.freeze(result);
}

async function closeServer(server) {
  await new Promise((resolveClose) => server.close(() => resolveClose()));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseBuiltExamplesServerArguments(process.argv.slice(2));
  const store = await createBuiltExamplesAssetStore();
  const server = await startBuiltExamplesServer(store, options);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("built-example server did not publish a TCP address");
  }
  process.stdout.write(
    `AVAL browser compatibility endpoint: http://${DEFAULT_HOST}:${String(address.port)}\n` +
    `${Object.values(BUILT_EXAMPLE_ROUTE_MAP).join("\n")}\n`
  );
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    void closeServer(server).then(() => { process.exitCode = 0; });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
