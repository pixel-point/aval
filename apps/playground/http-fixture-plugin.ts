import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseCompileBundleReport,
  parseFrontIndex
} from "@pixel-point/aval-format";
import { SOURCE_CODEC_PRIORITY } from "@pixel-point/aval-element";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";

import { QUALIFIED_FIXTURE_PREFIX } from "./fixture-routes.js";

interface FixtureAsset {
  readonly bytes: Buffer;
  readonly etag: string;
  readonly metadataBytes: number;
}

interface FixtureSet {
  readonly report: Buffer;
  readonly assets: ReadonlyMap<string, FixtureAsset>;
}

interface RequestRecord {
  readonly path: string;
  readonly range: string | null;
  readonly status: number;
}

const FATAL_BOUNDARY_PATH = "/__aval_certification__/fatal-boundary-network.avl";
const SESSION = /^[A-Za-z0-9_-]{1,64}$/u;
const CODECS = SOURCE_CODEC_PRIORITY;
const QUALIFIED_FIXTURE_ROOT = fileURLToPath(new URL(
  "../../fixtures/certification/v1/",
  import.meta.url
));
const MAX_SESSIONS = 256;
const MAX_RECORDS = 512;

/**
 * Serves the qualified fixture authority with deterministic ranges.
 * Fatal-boundary certification uses the same current bytes so the injected
 * resource failure, rather than asset-profile drift, is observed.
 */
export function playgroundFixturePlugin(): Plugin {
  const sessions = new Map<string, RequestRecord[]>();
  let fixturePromise: Promise<FixtureSet> | null = null;
  const loadFixture = (): Promise<FixtureSet> => fixturePromise ??=
    loadFixtureSet().catch((error: unknown) => {
      fixturePromise = null;
      throw error;
    });

  function install(server: ViteDevServer | PreviewServer): void {
    server.middlewares.use((request, response, next) => {
      void route(request, response, next).catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined);
          return;
        }
        writeJson(response, 500, { error: "fixture-authority-failure" });
      });
    });
  }

  async function route(
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://aval.invalid");
    if (url.pathname === FATAL_BOUNDARY_PATH) {
      if (request.method !== "GET") return methodNotAllowed(response);
      const fixture = await loadFixture();
      const asset = fixture.assets.get("h264.avl");
      if (asset === undefined) throw new Error("fatal-boundary fixture is unavailable");
      const rangeHeader = header(request, "range");
      const range = rangeHeader === null ? null : parseRange(rangeHeader, asset.bytes.byteLength);
      if (range !== null && range.end < asset.metadataBytes) {
        const body = asset.bytes.subarray(range.start, range.end + 1);
        response.setHeader("Accept-Ranges", "bytes");
        response.setHeader("Content-Range", `bytes ${String(range.start)}-${String(range.end)}/${String(asset.bytes.byteLength)}`);
        sendBytes(response, 206, body, "application/vnd.aval", asset.etag);
        return;
      }
      writeJson(response, 503, { error: "injected-network-failure" });
      return;
    }
    if (!url.pathname.startsWith(QUALIFIED_FIXTURE_PREFIX)) {
      next();
      return;
    }
    if (url.pathname === `${QUALIFIED_FIXTURE_PREFIX}metrics`) {
      if (request.method !== "GET") return methodNotAllowed(response);
      const session = requireSession(url.searchParams.get("session"));
      writeJson(response, 200, {
        requests: sessions.get(session) ?? []
      });
      return;
    }
    if (url.pathname === `${QUALIFIED_FIXTURE_PREFIX}reset`) {
      if (request.method !== "POST") return methodNotAllowed(response);
      sessions.delete(requireSession(url.searchParams.get("session")));
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method !== "GET") return methodNotAllowed(response);
    const relativePath = url.pathname.slice(QUALIFIED_FIXTURE_PREFIX.length);
    if (relativePath === "build.json") {
      const fixture = await loadFixture();
      const session = optionalSession(request.headers["x-aval-session"]);
      record(sessions, session, Object.freeze({
        path: relativePath,
        range: null,
        status: 200
      }));
      sendBytes(response, 200, fixture.report, "application/json; charset=utf-8", null);
      return;
    }
    const session = requireSession(url.searchParams.get("session"));
    const fixture = await loadFixture();
    const asset = fixture.assets.get(relativePath);
    if (asset === undefined) {
      writeJson(response, 404, { error: "fixture-not-found" });
      return;
    }
    const rangeHeader = header(request, "range");
    if (url.searchParams.get("failure") === "network") {
      record(sessions, session, Object.freeze({
        path: relativePath,
        range: rangeHeader,
        status: 503
      }));
      writeJson(response, 503, { error: "injected-network-failure" });
      return;
    }
    const range = rangeHeader === null ? null : parseRange(rangeHeader, asset.bytes.byteLength);
    if (rangeHeader !== null && range === null) {
      record(sessions, session, Object.freeze({
        path: relativePath,
        range: rangeHeader,
        status: 416
      }));
      response.setHeader("Content-Range", `bytes */${String(asset.bytes.byteLength)}`);
      writeJson(response, 416, { error: "invalid-range" });
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? asset.bytes.byteLength - 1;
    const body = asset.bytes.subarray(start, end + 1);
    const status = range === null ? 200 : 206;
    record(sessions, session, Object.freeze({
      path: relativePath,
      range: rangeHeader,
      status
    }));
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("ETag", asset.etag);
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader(
      "Access-Control-Expose-Headers",
      "Accept-Ranges, Content-Length, Content-Range, ETag"
    );
    if (range !== null) {
      response.setHeader(
        "Content-Range",
        `bytes ${String(start)}-${String(end)}/${String(asset.bytes.byteLength)}`
      );
    }
    sendBytes(response, status, body, "application/vnd.aval", asset.etag);
  }

  return {
    name: "aval-http-fixture-authority",
    enforce: "pre",
    configureServer(server) {
      install(server);
    },
    configurePreviewServer(server) {
      install(server);
    }
  };
}

async function loadFixtureSet(): Promise<FixtureSet> {
  const report = await readFile(join(QUALIFIED_FIXTURE_ROOT, "build.json"));
  const parsed = parseCompileBundleReport(JSON.parse(report.toString("utf8")));
  const reportAssets = new Map(parsed.assets.map((asset) => [asset.codec, asset]));
  const assets = new Map<string, FixtureAsset>();
  for (const codec of CODECS) {
    const record = reportAssets.get(codec);
    if (record === undefined || record.path !== `${codec}.avl`) {
      throw new TypeError(`fixture authority report is missing ${codec}`);
    }
    const bytes = await readFile(join(QUALIFIED_FIXTURE_ROOT, record.path));
    const digest = createHash("sha256").update(bytes).digest("base64");
    if (record.integrity !== `sha256-${digest}`) {
      throw new Error(`fixture authority integrity mismatch for ${codec}`);
    }
    assets.set(record.path, Object.freeze({
      bytes,
      etag: `"${codec}-${digest}"`,
      metadataBytes: parseFrontIndex(bytes).frontIndexRange.length
    }));
  }
  return Object.freeze({ report, assets });
}

function requireSession(value: string | null): string {
  if (value === null || !SESSION.test(value)) throw new TypeError("invalid fixture session");
  return value;
}

function optionalSession(value: string | string[] | undefined): string {
  return typeof value === "string" && SESSION.test(value) ? value : "playground";
}

function record(
  sessions: Map<string, RequestRecord[]>,
  session: string,
  value: RequestRecord
): void {
  let records = sessions.get(session);
  if (records === undefined) {
    if (sessions.size >= MAX_SESSIONS) throw new RangeError("fixture session limit exceeded");
    records = [];
    sessions.set(session, records);
  }
  if (records.length >= MAX_RECORDS) throw new RangeError("fixture record limit exceeded");
  records.push(value);
}

function parseRange(value: string, length: number): Readonly<{
  start: number;
  end: number;
}> | null {
  const match = /^bytes=(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/u.exec(value);
  if (match === null) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
    start >= 0 && end >= start && end < length
    ? Object.freeze({ start, end })
    : null;
}

function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" ? value : null;
}

function sendBytes(
  response: ServerResponse,
  status: number,
  body: Uint8Array,
  contentType: string,
  etag: string | null
): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Encoding", "identity");
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", body.byteLength);
  if (etag !== null) response.setHeader("ETag", etag);
  response.end(body);
}

function methodNotAllowed(response: ServerResponse): void {
  writeJson(response, 405, { error: "method-not-allowed" });
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  sendBytes(response, status, body, "application/json; charset=utf-8", null);
}
