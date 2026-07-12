import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

interface M7FixtureProvenance {
  readonly asset: {
    readonly bytes: number;
    readonly sha256: string;
    readonly strongEntityTag: string;
  };
  readonly blobs: readonly {
    readonly kind: "unit" | "static";
    readonly rendition?: string;
    readonly unit?: string;
    readonly staticFrame?: string;
    readonly offset: number;
    readonly length: number;
    readonly paddingOffset: number;
    readonly paddingLength: number;
  }[];
  readonly initialStatic: { readonly staticFrame: string };
  readonly selectedRendition: { readonly id: string };
}

interface RecordedRequest {
  readonly ordinal: number;
  readonly method: string;
  readonly range: string | null;
  readonly ifRange: string | null;
  readonly scenario: string;
}

interface SessionMetrics {
  readonly requests: RecordedRequest[];
  activeResponses: number;
  peakActiveResponses: number;
  completedResponses: number;
  cancelledResponses: number;
}

const SESSION_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ASSET_PATH = "/__m7__/asset";
const METRICS_PATH = "/__m7__/metrics";
const RESET_PATH = "/__m7__/reset";
const MAX_SESSIONS = 256;
const MAX_REQUESTS_PER_SESSION = 128;
const MAX_ACTIVE_RESPONSES_PER_SESSION = 8;

export function m7HttpFixturePlugin(): Plugin {
  const fixturePath = fileURLToPath(new URL(
    "../../fixtures/conformance/m7/reference-packed.rma",
    import.meta.url
  ));
  const provenancePath = fileURLToPath(new URL(
    "../../fixtures/conformance/m7/reference-packed.provenance.json",
    import.meta.url
  ));
  const scenariosPath = fileURLToPath(new URL(
    "../../fixtures/conformance/m7/network-scenarios.json",
    import.meta.url
  ));
  let fixture: Buffer;
  let provenance: M7FixtureProvenance;
  let scenarioIds: ReadonlySet<string>;
  const sessions = new Map<string, SessionMetrics>();

  return {
    name: "rendered-motion-m7-http-fixture",
    enforce: "pre",
    async buildStart() {
      const [asset, provenanceText, scenariosText] = await Promise.all([
        readFile(fixturePath),
        readFile(provenancePath, "utf8"),
        readFile(scenariosPath, "utf8")
      ]);
      fixture = asset;
      provenance = JSON.parse(provenanceText) as M7FixtureProvenance;
      const scenarios = JSON.parse(scenariosText) as {
        readonly scenarios: readonly { readonly id: string }[];
      };
      scenarioIds = new Set(scenarios.scenarios.map(({ id }) => id));
      if (fixture.byteLength !== provenance.asset.bytes) {
        throw new Error("M7 HTTP fixture bytes do not match provenance");
      }
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        void routeRequest(request, response).catch((error: unknown) => {
          if (response.headersSent) {
            response.destroy(error instanceof Error ? error : undefined);
            return;
          }
          response.statusCode = 500;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ error: "m7-fixture-failure" }));
        });

        async function routeRequest(
          incoming: IncomingMessage,
          outgoing: ServerResponse
        ): Promise<void> {
          const url = new URL(incoming.url ?? "/", "http://m7.invalid");
          if (
            url.pathname !== ASSET_PATH &&
            url.pathname !== METRICS_PATH &&
            url.pathname !== RESET_PATH
          ) {
            next();
            return;
          }
          const session = requireParameter(url, "session", SESSION_PATTERN);
          if (url.pathname === METRICS_PATH) {
            if (incoming.method !== "GET") return methodNotAllowed(outgoing);
            writeJson(outgoing, snapshotMetrics(sessions.get(session)));
            return;
          }
          if (url.pathname === RESET_PATH) {
            if (incoming.method !== "POST") return methodNotAllowed(outgoing);
            sessions.delete(session);
            outgoing.statusCode = 204;
            outgoing.end();
            return;
          }
          if (incoming.method !== "GET") return methodNotAllowed(outgoing);
          const scenario = requireParameter(url, "scenario", null);
          if (!scenarioIds.has(scenario)) {
            throw new RangeError("unknown M7 network scenario");
          }
          let metrics = sessions.get(session);
          if (metrics === undefined) {
            if (sessions.size >= MAX_SESSIONS) {
              return tooManyRequests(outgoing);
            }
            metrics = createMetrics();
            sessions.set(session, metrics);
          }
          if (
            metrics.requests.length >= MAX_REQUESTS_PER_SESSION ||
            metrics.activeResponses >= MAX_ACTIVE_RESPONSES_PER_SESSION
          ) {
            return tooManyRequests(outgoing);
          }
          const requestRecord: RecordedRequest = Object.freeze({
            ordinal: metrics.requests.length + 1,
            method: incoming.method,
            range: headerValue(incoming, "range"),
            ifRange: headerValue(incoming, "if-range"),
            scenario
          });
          metrics.requests.push(requestRecord);
          serveAsset(incoming, outgoing, scenario, requestRecord, metrics);
        }
      });
    }
  };

  function serveAsset(
    request: IncomingMessage,
    response: ServerResponse,
    scenario: string,
    record: RecordedRequest,
    metrics: SessionMetrics
  ): void {
    const parsedRange = record.range === null
      ? null
      : parseRange(record.range, fixture.byteLength);
    const ignoreRange = scenario === "ignored-initial-range" &&
      record.ordinal === 1;
    const fullOnly = scenario === "valid-external-integrity" ||
      scenario === "invalid-external-integrity";
    const noValidatorRestart = (
      scenario === "no-validator" || scenario === "weak-etag"
    ) && record.ordinal > 1;
    const sendFull = parsedRange === null || ignoreRange || fullOnly ||
      noValidatorRestart;
    const start = sendFull ? 0 : parsedRange.start;
    const end = sendFull ? fixture.byteLength - 1 : parsedRange.end;
    let body = Buffer.from(fixture.subarray(start, end + 1));
    body = mutateScenarioBody(body, start, scenario, provenance);

    response.statusCode = sendFull ? 200 : 206;
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/vnd.rendered-motion");
    response.setHeader(
      "Content-Encoding",
      scenario === "compressed-body" ? "gzip" : "identity"
    );
    if (!sendFull) {
      const total = scenario === "wrong-total"
        ? fixture.byteLength + 1
        : fixture.byteLength;
      response.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
    }
    if (scenario === "weak-etag" && record.ordinal === 1) {
      response.setHeader("ETag", `W/${provenance.asset.strongEntityTag}`);
    } else if (scenario !== "no-validator" || record.ordinal > 1) {
      response.setHeader(
        "ETag",
        scenario === "changed-etag" && record.ordinal > 1
          ? `"m7-changed-${provenance.asset.sha256}"`
          : provenance.asset.strongEntityTag
      );
    }

    if (scenario === "truncated-body") {
      response.setHeader("Content-Length", body.byteLength);
      body = body.subarray(0, Math.max(0, body.byteLength - 1));
    } else if (scenario === "oversized-body") {
      body = Buffer.concat([body, Buffer.from([0])]);
      // Keep Content-Range exact but omit Content-Length so the bounded reader,
      // rather than response metadata validation, detects the extra byte.
    } else {
      response.setHeader("Content-Length", body.byteLength);
    }

    metrics.activeResponses += 1;
    metrics.peakActiveResponses = Math.max(
      metrics.peakActiveResponses,
      metrics.activeResponses
    );
    let terminal = false;
    const finish = (cancelled: boolean): void => {
      if (terminal) return;
      terminal = true;
      metrics.activeResponses -= 1;
      if (cancelled) metrics.cancelledResponses += 1;
      else metrics.completedResponses += 1;
    };
    response.once("finish", () => finish(false));
    response.once("close", () => finish(!response.writableEnded));
    request.once("aborted", () => finish(true));

    if (scenario !== "stalled-body") {
      if (scenario === "oversized-body") {
        // A separate write flushes chunked headers before end(); passing the
        // entire body to end() makes Node synthesize Content-Length.
        response.write(body);
        response.end();
      } else {
        response.end(body);
      }
      return;
    }
    response.removeHeader("Content-Length");
    response.write(body.subarray(0, Math.min(32, body.byteLength)));
    const boundedRetirement = setTimeout(() => {
      if (!response.destroyed) response.end();
    }, 10_000);
    boundedRetirement.unref();
    response.once("close", () => clearTimeout(boundedRetirement));
    response.once("finish", () => clearTimeout(boundedRetirement));
  }
}

function mutateScenarioBody(
  source: Buffer,
  responseOffset: number,
  scenario: string,
  provenance: M7FixtureProvenance
): Buffer {
  let absoluteOffset: number | null = null;
  if (scenario === "corrupt-unit") {
    const blob = provenance.blobs.find(({ kind, rendition }) =>
      kind === "unit" && rendition === provenance.selectedRendition.id
    );
    absoluteOffset = blob === undefined ? null : blob.offset + (blob.length >> 1);
  } else if (scenario === "corrupt-static") {
    const blob = provenance.blobs.find(({ kind, staticFrame }) =>
      kind === "static" && staticFrame === provenance.initialStatic.staticFrame
    );
    absoluteOffset = blob === undefined ? null : blob.offset + (blob.length >> 1);
  } else if (scenario === "nonzero-padding") {
    const blob = provenance.blobs.find(({ kind, rendition, paddingLength }) =>
      paddingLength > 0 && (
        kind === "static" || rendition === provenance.selectedRendition.id
      )
    );
    absoluteOffset = blob?.paddingOffset ?? null;
  }
  if (
    absoluteOffset === null ||
    absoluteOffset < responseOffset ||
    absoluteOffset >= responseOffset + source.byteLength
  ) {
    return source;
  }
  const mutated = Buffer.from(source);
  const index = absoluteOffset - responseOffset;
  mutated[index] = scenario === "nonzero-padding"
    ? 1
    : mutated[index]! ^ 0x01;
  return mutated;
}

function parseRange(value: string, totalBytes: number): {
  readonly start: number;
  readonly end: number;
} {
  const match = /^bytes=(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/.exec(value);
  if (match === null) throw new RangeError("invalid M7 fixture range");
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start > end ||
    end >= totalBytes
  ) {
    throw new RangeError("out-of-bounds M7 fixture range");
  }
  return Object.freeze({ start, end });
}

function headerValue(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" ? value : null;
}

function requireParameter(
  url: URL,
  name: string,
  pattern: RegExp | null
): string {
  const value = url.searchParams.get(name);
  if (value === null || value.length === 0 || (pattern !== null && !pattern.test(value))) {
    throw new RangeError(`invalid M7 fixture ${name}`);
  }
  return value;
}

function createMetrics(): SessionMetrics {
  return {
    requests: [],
    activeResponses: 0,
    peakActiveResponses: 0,
    completedResponses: 0,
    cancelledResponses: 0
  };
}

function snapshotMetrics(metrics: SessionMetrics | undefined): Readonly<SessionMetrics> {
  const source = metrics ?? createMetrics();
  return Object.freeze({
    requests: Object.freeze([...source.requests]),
    activeResponses: source.activeResponses,
    peakActiveResponses: source.peakActiveResponses,
    completedResponses: source.completedResponses,
    cancelledResponses: source.cancelledResponses
  });
}

function writeJson(response: ServerResponse, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function methodNotAllowed(response: ServerResponse): void {
  response.statusCode = 405;
  response.setHeader("Allow", "GET");
  response.end();
}

function tooManyRequests(response: ServerResponse): void {
  response.statusCode = 429;
  response.setHeader("Retry-After", "1");
  response.end();
}
