import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { servePublishedBundleFile } from "./dev-asset-responder.js";
import type { DevEventStreamHub } from "./dev-event-stream.js";
import type { BoundedReadAdmission } from "./dev-file-reader.js";
import { writeError, writeText } from "./dev-http-response.js";
import { rewriteDevModuleImports, type PackageModuleStore } from "./dev-package-modules.js";
import { devWorkerEntry } from "./dev-worker-entries.js";
import { authorizeBrowserRequest, authorizeHost, rawHeaderValues, type DevBrowserEndpoint, type DevRequestAuthority } from "./dev-request-security.js";
import {
  MAX_ASSET_BYTES,
  MAX_BUILD_REPORT_BYTES,
  type DevServerBuild
} from "./dev-server-model.js";
import { DEV_CLIENT, DEV_CONTENT_SECURITY_POLICY, DEV_CSS, DEV_HTML, DEV_WORKER_CONTENT_SECURITY_POLICY } from "./dev-ui-assets.js";

const MAX_URL_LENGTH = 2_048;
export interface DevServerRouterOptions {
  readonly sessionPath: string;
  readonly bundlePath: string;
  readonly authority: () => DevRequestAuthority | null;
  readonly current: () => Readonly<DevServerBuild> | null;
  readonly eventStreams: DevEventStreamHub;
  readonly modules: PackageModuleStore;
  readonly assetReads: BoundedReadAdmission;
  readonly moduleReads: BoundedReadAdmission;
}

export function createDevServerRequestHandler(options: DevServerRouterOptions): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response): void => {
    void route(request, response).catch(() => {
      if (!response.headersSent) writeError(response, request.method ?? "GET", 500, "dev-server-failure");
      else response.destroy();
    });
  };

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    applyCommonHeaders(response);
    const method = request.method ?? "GET";
    const authority = options.authority();
    if (authority === null) return writeError(response, method, 503, "server-starting");
    const host = authorizeHost(request, authority);
    if (!host.allowed) return writeError(response, method, host.status, host.code);
    const rawUrl = request.url ?? "/";
    if (rawUrl.length > MAX_URL_LENGTH) return writeError(response, method, 414, "request-too-long");
    if (method !== "GET" && method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      return writeError(response, method, 405, "method-not-allowed");
    }
    if (!rawUrl.startsWith("/") || rawUrl.startsWith("//") || rawUrl.includes("\\")) return writeError(response, method, 400, "request-target-invalid");
    let url: URL;
    try {
      url = new URL(rawUrl, authority.origin);
    } catch {
      return writeError(response, method, 400, "request-target-invalid");
    }
    if (!url.pathname.startsWith(options.sessionPath)) return writeError(response, method, 404, "not-found");
    const relativePath = url.pathname.slice(options.sessionPath.length);
    if (!acceptedModuleSearch(relativePath, url.search)) {
      return writeError(response, method, 404, "not-found");
    }
    const endpoint = endpointClass(relativePath, request);
    const browser = authorizeBrowserRequest(request, authority, endpoint);
    if (!browser.allowed) return writeError(response, method, browser.status, browser.code);
    if (relativePath === "") {
      response.setHeader("Content-Security-Policy", DEV_CONTENT_SECURITY_POLICY);
      return writeText(response, method, "text/html; charset=utf-8", DEV_HTML);
    }
    if (relativePath === "style.css") return writeText(response, method, "text/css; charset=utf-8", DEV_CSS);
    if (relativePath === "client.js") return writeText(response, method, "text/javascript; charset=utf-8", DEV_CLIENT);
    const module = /^modules\/(element|player-web|format|graph)\/(.+)$/u.exec(relativePath);
    if (module !== null) return serveModule(response, method, module[1] as "element" | "player-web" | "format" | "graph", module[2]!, isWorkerEntry(relativePath));
    if (relativePath === "events") return options.eventStreams.connect(request, response, method, options.current());
    const published = options.current();
    if (relativePath === "build.json") {
      if (published === null) {
        return writeError(response, method, 404, "no-valid-build");
      }
      await servePublishedBundleFile({
        response,
        method,
        rangeHeader: request.headers.range,
        ifRangeHeader: request.headers["if-range"],
        filePath: join(options.bundlePath, published.buildReport.path),
        file: published.buildReport,
        maximumBytes: MAX_BUILD_REPORT_BYTES,
        contentType: "application/json; charset=utf-8",
        published,
        current: options.current,
        admission: options.assetReads
      });
      return;
    }
    if (!/^(?:h264|h265|vp9|av1)\.avl$/u.test(relativePath)) {
      return writeError(response, method, 404, "not-found");
    }
    if (published === null) {
      return writeError(response, method, 404, "no-valid-build");
    }
    const asset = published.assets.find(({ path }) => path === relativePath);
    if (asset === undefined) {
      return writeError(response, method, 404, "codec-not-built");
    }
    await servePublishedBundleFile({
      response,
      method,
      rangeHeader: request.headers.range,
      ifRangeHeader: request.headers["if-range"],
      filePath: join(options.bundlePath, asset.path),
      file: asset,
      maximumBytes: MAX_ASSET_BYTES,
      contentType: asset.type,
      published,
      current: options.current,
      admission: options.assetReads
    });
  }

  async function serveModule(response: ServerResponse, method: string, packageName: "element" | "player-web" | "format" | "graph", relativePath: string, workerEntry: boolean): Promise<void> {
    const read = await options.modules.read(packageName, relativePath, options.moduleReads);
    if (read.status === "busy") return writeError(response, method, 503, "server-busy");
    if (read.status === "too-large") return writeError(response, method, 413, "module-too-large");
    if (read.status === "missing") return writeError(response, method, 404, "module-not-built");
    const bytes = rewriteDevModuleImports(read.bytes, options.sessionPath);
    if (workerEntry) response.setHeader("Content-Security-Policy", DEV_WORKER_CONTENT_SECURITY_POLICY);
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/javascript; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Length", bytes.byteLength);
    if (method === "HEAD") response.end();
    else response.end(bytes);
  }
}

function endpointClass(path: string, request: IncomingMessage): DevBrowserEndpoint {
  if (path === "") return "document";
  if (path === "style.css") return "style";
  if (isWorkerEntry(path)) return "worker-entry";
  if (path.startsWith("modules/") && rawHeaderValues(request, "sec-fetch-dest")[0] === "worker") return "worker-module";
  if (path === "client.js" || path.startsWith("modules/")) return "script";
  return "browser-fetch";
}

function acceptedModuleSearch(path: string, search: string): boolean {
  return search === "" || devWorkerEntry(path)?.search === search;
}

function isWorkerEntry(path: string): boolean {
  return devWorkerEntry(path) !== undefined;
}

function applyCommonHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("X-Frame-Options", "DENY");
}
