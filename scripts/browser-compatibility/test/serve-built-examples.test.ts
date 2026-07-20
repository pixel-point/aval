import { request as httpRequest, type Server } from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type Page } from "@playwright/test";
import { afterEach, describe, expect, it } from "vitest";

import {
  createBuiltExamplesAssetStore,
  createBuiltExamplesServer,
  parseBuiltExamplesServerArguments,
  startBuiltExamplesServer
} from "../serve-built-examples.mjs";

const WORKSPACE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../.."
);
const servers: Server[] = [];
const temporaryRoots: string[] = [];
const browsers: Browser[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  await Promise.all(browsers.splice(0).map((browser) => browser.close()));
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })));
});

describe("built browser-compatibility endpoint", () => {
  it("snapshots closed routes and serves strict immutable HTTP responses", async () => {
    const root = await createFixtureRoot();
    const store = await createBuiltExamplesAssetStore({ root });
    expect(parseBuiltExamplesServerArguments([])).toEqual({
      host: "127.0.0.1",
      port: 4179
    });
    expect(() => parseBuiltExamplesServerArguments([
      "--host", "127.0.0.1", "--port", "4180"
    ])).toThrow("must bind to 127.0.0.1:4179");
    await expect(startBuiltExamplesServer(store, {
      host: "0.0.0.0",
      port: 4179
    })).rejects.toThrow("must bind to 127.0.0.1:4179");
    await expect(startBuiltExamplesServer(store, {
      host: "127.0.0.1",
      port: 4180
    })).rejects.toThrow("must bind to 127.0.0.1:4179");

    const exposedAsset = store.lookup("/playground/assets/app.js");
    expect(exposedAsset).not.toBeNull();
    const originalBody = Buffer.from(exposedAsset?.body ?? []);
    const originalEtag = exposedAsset?.etag;
    exposedAsset?.body.fill(0);
    const freshAsset = store.lookup("/playground/assets/app.js");
    expect(freshAsset?.body).toEqual(originalBody);
    expect(freshAsset?.body).not.toBe(exposedAsset?.body);
    expect(freshAsset?.etag).toBe(originalEtag);

    const { server, baseUrl } = await listen(store);
    servers.push(server);

    await writeFile(
      resolve(root, "examples/end-user-playground/dist/assets/app.js"),
      "changed-after-snapshot"
    );

    const page = await fetch(`${baseUrl}/playground/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(await page.text()).toContain('src="/playground/assets/app.js"');
    expect(await (await fetch(`${baseUrl}/playground/`)).text())
      .toContain('src="/playground/favorite.png"');

    const rabbit = await fetch(`${baseUrl}/rabbit/`);
    expect(await rabbit.text()).toContain('src="/rabbit/assets/app.js"');
    const script = await fetch(`${baseUrl}/playground/assets/app.js`);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await script.text()).toBe("original-playground-script");
    expect((await fetch(`${baseUrl}/assets/app.js`)).status).toBe(404);

    const partial = await fetch(`${baseUrl}/playground/favorite/h264.avl`, {
      headers: { Range: "bytes=1-3" }
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-type")).toBe("application/vnd.aval");
    expect(partial.headers.get("accept-ranges")).toBe("bytes");
    expect(partial.headers.get("content-range")).toBe("bytes 1-3/8");
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));

    const suffix = await fetch(`${baseUrl}/playground/favorite/h264.avl`, {
      headers: { Range: "bytes=-2" }
    });
    expect(suffix.status).toBe(206);
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(Buffer.from([6, 7]));

    const etag = partial.headers.get("etag");
    expect(etag).toMatch(/^"sha256-[0-9a-f]{64}"$/u);
    const ifRangeMiss = await fetch(`${baseUrl}/playground/favorite/h264.avl`, {
      headers: { Range: "bytes=0-1", "If-Range": '"different"' }
    });
    expect(ifRangeMiss.status).toBe(200);
    expect((await ifRangeMiss.arrayBuffer()).byteLength).toBe(8);

    const notModified = await fetch(`${baseUrl}/playground/favorite/h264.avl`, {
      headers: { "If-None-Match": etag! }
    });
    expect(notModified.status).toBe(304);
    const unsatisfied = await fetch(`${baseUrl}/playground/favorite/h264.avl`, {
      headers: { Range: "bytes=99-100" }
    });
    expect(unsatisfied.status).toBe(416);
    expect(unsatisfied.headers.get("content-range")).toBe("bytes */8");

    const head = await fetch(`${baseUrl}/probe/codec-probe.js`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).not.toBe("0");
    expect(await head.text()).toBe("");
    expect((await fetch(`${baseUrl}/probe/`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/isolators/renderer/`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/probe/modules/element/index.js`)).status).toBe(200);

    const traversal = await rawRequest(
      server,
      "/playground/%2e%2e/codec-probe.html"
    );
    expect(traversal.status).toBe(404);
    const encodedSlashTraversal = await rawRequest(
      server,
      "/playground/%2e%2e%2fcodec-probe.html"
    );
    expect(encodedSlashTraversal.status).toBe(404);
    const post = await rawRequest(server, "/playground/", "POST");
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe("GET, HEAD");
  });

  it("rejects a symlinked configured route root", async () => {
    const root = await createFixtureRoot();
    const externalRoot = await mkdtemp(resolve(tmpdir(), "aval-built-external-"));
    temporaryRoots.push(externalRoot);
    const routeRoot = resolve(root, "examples/end-user-playground/dist");
    await rm(routeRoot, { recursive: true });
    await put(externalRoot, "index.html", "outside-workspace-secret");
    await symlink(
      externalRoot,
      routeRoot,
      process.platform === "win32" ? "junction" : "dir"
    );

    await expect(createBuiltExamplesAssetStore({ root }))
      .rejects.toThrow(/symlink/u);
  });

  it("runs all production renderer modes and keeps codec queries closed", async () => {
    const store = await createBuiltExamplesAssetStore({ root: WORKSPACE_ROOT });
    const { server, baseUrl } = await listen(store);
    servers.push(server);
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);

    const rendererCases = [
      {
        id: "packed-alpha-48x104",
        layout: {
          codedWidth: 48,
          codedHeight: 104,
          storageWidth: 48,
          storageHeight: 104,
          logicalWidth: 48,
          logicalHeight: 48,
          pixelAspect: [1, 1],
          colorRect: [0, 0, 48, 48],
          alphaRect: [0, 56, 48, 48]
        },
        backing: [48, 48]
      },
      {
        id: "opaque-1280x720",
        layout: {
          codedWidth: 1280,
          codedHeight: 720,
          storageWidth: 1280,
          storageHeight: 720,
          logicalWidth: 1280,
          logicalHeight: 720,
          pixelAspect: [1, 1],
          colorRect: [0, 0, 1280, 720]
        },
        backing: [1280, 720]
      }
    ] as const;
    for (const expectedCase of rendererCases) {
      const rendererPage = await browser.newPage();
      await rendererPage.goto(
        `${baseUrl}/isolators/renderer/?case=${expectedCase.id}`,
        { waitUntil: "load" }
      );
      const rendererReport = await readRendererReport(rendererPage);
      assertRendererReport(rendererReport, expectedCase);
      expect(await rendererPage.locator("article[data-mode]").count()).toBe(3);
    }

    const invalidPage = await browser.newPage();
    const invalidRequests: string[] = [];
    invalidPage.on("request", (request) => invalidRequests.push(request.url()));
    await invalidPage.goto(`${baseUrl}/probe/?demo=playground&codec=H264`);
    const invalidReport = await invalidPage.evaluate(async () => {
      const api = (window as typeof window & {
        avalCodecProbe?: { ready: Promise<unknown>; report(): unknown };
      }).avalCodecProbe;
      if (api === undefined) throw new Error("codec probe API is missing");
      await api.ready;
      return api.report();
    }) as { status: string };
    expect(invalidReport.status).toBe("error");
    expect(await invalidPage.locator("#probe-status").getAttribute("data-state"))
      .toBe("error");
    expect(await invalidPage.locator("aval-player").count()).toBe(0);
    expect(invalidRequests.filter(isAvalRequest)).toEqual([]);

    const validPage = await browser.newPage();
    const validRequests: string[] = [];
    validPage.on("request", (request) => {
      if (isAvalRequest(request.url())) validRequests.push(request.url());
    });
    await validPage.goto(`${baseUrl}/probe/?demo=playground&codec=h264`);
    await validPage.locator("aval-player source").waitFor({ state: "attached" });
    const selected = await validPage.locator("aval-player").evaluate((player) => ({
      playerCount: document.querySelectorAll("aval-player").length,
      sourceCount: player.querySelectorAll("source").length,
      source: player.querySelector("source")?.getAttribute("src"),
      type: player.querySelector("source")?.getAttribute("type"),
      integrity: player.querySelector("source")?.getAttribute("integrity")
    }));
    expect(selected).toMatchObject({
      playerCount: 1,
      sourceCount: 1,
      source: `${baseUrl}/playground/favorite/h264.avl`
    });
    expect(selected.type).toMatch(/^application\/vnd\.aval; codecs="avc1\./u);
    expect(selected.integrity).toMatch(/^sha256-/u);
    const visibleReport = await validPage.locator("#probe-result").textContent();
    expect(visibleReport).not.toContain(baseUrl);
    const publicReport = await validPage.evaluate(() => {
      const api = (window as typeof window & {
        avalCodecProbe?: { report(): unknown };
      }).avalCodecProbe;
      if (api === undefined) throw new Error("codec probe API is missing");
      return api.report();
    }) as { source?: Record<string, unknown> | null };
    expect(publicReport.source).not.toHaveProperty("url");
    await expect.poll(() => validRequests.length, { timeout: 5_000 })
      .toBeGreaterThan(0);
    expect(validRequests.every((url) =>
      url === `${baseUrl}/playground/favorite/h264.avl`)).toBe(true);
  }, 60_000);
});

interface RendererModeResult {
  mode: string;
  status: string;
  case: string;
  layout: Record<string, unknown>;
  context: {
    rendererRequestedAttributes: Record<string, unknown>;
    forwardedAttributes: Record<string, unknown> | null;
    returnedAttributes: Record<string, unknown>;
  };
  capabilities: {
    maxTextureSize: number;
    maxArrayTextureLayers: number;
    maxViewportDimensions: [number, number];
    vendor: string | null;
    renderer: string | null;
    unmaskedVendor: string | null;
    unmaskedRenderer: string | null;
    glError: number | null;
    contextLost: boolean;
  };
  rendererSnapshot: {
    backend: "webgl2" | "canvas2d";
    backingWidth: number;
    backingHeight: number;
    stagingBytes: number;
    textureBytes: number;
    runtimeBytes: number;
    uploadMode: string;
    nativeProbeAttempts: number;
    probeReadbackBytes: number;
    resourceCount: number;
    contextListenerCount: number;
    failure: unknown;
  };
  diagnostic: unknown;
  release: { extensionAvailable: boolean; requested: boolean };
}

interface RendererReport {
  schemaVersion: string;
  kind: string;
  status: string;
  case: string;
  environment: {
    userAgent: string;
    platform: string;
    devicePixelRatio: number;
  };
  modes: RendererModeResult[];
  failure: unknown;
}

interface RendererCaseExpectation {
  readonly id: string;
  readonly layout: Readonly<Record<string, unknown>>;
  readonly backing: readonly [number, number];
}

const REPORT_KEYS = [
  "case",
  "environment",
  "failure",
  "kind",
  "modes",
  "schemaVersion",
  "status"
] as const;
const MODE_KEYS = [
  "capabilities",
  "case",
  "context",
  "diagnostic",
  "layout",
  "mode",
  "release",
  "rendererSnapshot",
  "status"
] as const;
const CONTEXT_ATTRIBUTE_KEYS = [
  "alpha",
  "antialias",
  "depth",
  "desynchronized",
  "failIfMajorPerformanceCaveat",
  "powerPreference",
  "premultipliedAlpha",
  "preserveDrawingBuffer",
  "stencil",
  "xrCompatible"
] as const;
const PRODUCTION_FORWARDED_KEYS = [
  "alpha",
  "antialias",
  "depth",
  "premultipliedAlpha",
  "preserveDrawingBuffer",
  "stencil"
] as const;
const CAPABILITY_KEYS = [
  "contextLost",
  "glError",
  "maxArrayTextureLayers",
  "maxTextureSize",
  "maxViewportDimensions",
  "renderer",
  "unmaskedRenderer",
  "unmaskedVendor",
  "vendor"
] as const;
const SNAPSHOT_KEYS = [
  "backend",
  "backingHeight",
  "backingWidth",
  "contextListenerCount",
  "failure",
  "nativeProbeAttempts",
  "probeReadbackBytes",
  "resourceCount",
  "runtimeBytes",
  "stagingBytes",
  "textureBytes",
  "uploadMode"
] as const;

async function readRendererReport(page: Page): Promise<RendererReport> {
  return page.evaluate(async () => {
    const api = (window as typeof window & {
      avalRendererIsolator?: {
        ready: Promise<unknown>;
        report(): unknown;
      };
    }).avalRendererIsolator;
    if (api === undefined) throw new Error("renderer isolator API is missing");
    await api.ready;
    return api.report();
  }) as Promise<RendererReport>;
}

function assertRendererReport(
  report: RendererReport,
  expectedCase: RendererCaseExpectation
): void {
  expectExactKeys(report, REPORT_KEYS);
  expect(report).toMatchObject({
    schemaVersion: "1.0",
    kind: "aval-renderer-isolator",
    status: "complete",
    case: expectedCase.id,
    failure: null
  });
  expectExactKeys(report.environment, [
    "devicePixelRatio",
    "platform",
    "userAgent"
  ]);
  expect(report.environment.userAgent).toEqual(expect.any(String));
  expect(report.environment.platform).toEqual(expect.any(String));
  expect(report.environment.devicePixelRatio).toEqual(expect.any(Number));
  expect(report.modes.map((entry) => entry.mode)).toEqual([
    "production",
    "legacy-desynchronized",
    "browser-defaults"
  ]);

  for (const [index, result] of report.modes.entries()) {
    expectExactKeys(result, MODE_KEYS);
    expect(result).toMatchObject({
      status: "success",
      case: expectedCase.id,
      layout: expectedCase.layout,
      diagnostic: null
    });
    expectExactKeys(result.context, [
      "forwardedAttributes",
      "rendererRequestedAttributes",
      "returnedAttributes"
    ]);
    expectExactKeys(
      result.context.rendererRequestedAttributes,
      CONTEXT_ATTRIBUTE_KEYS
    );
    expect(result.context.rendererRequestedAttributes).toMatchObject({
      alpha: true,
      antialias: false,
      depth: false,
      desynchronized: null,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      stencil: false
    });
    expectExactKeys(result.context.returnedAttributes, CONTEXT_ATTRIBUTE_KEYS);
    if (index === 0) {
      expectExactKeys(
        result.context.forwardedAttributes ?? {},
        PRODUCTION_FORWARDED_KEYS
      );
    } else if (index === 1) {
      expectExactKeys(
        result.context.forwardedAttributes ?? {},
        [...PRODUCTION_FORWARDED_KEYS, "desynchronized"]
      );
      expect(result.context.forwardedAttributes)
        .toHaveProperty("desynchronized", true);
    } else {
      expect(result.context.forwardedAttributes).toBeNull();
    }

    expectExactKeys(result.capabilities, CAPABILITY_KEYS);
    expect(result.capabilities.maxTextureSize).toBeGreaterThan(0);
    expect(result.capabilities.maxArrayTextureLayers).toBeGreaterThan(0);
    expect(result.capabilities.maxViewportDimensions).toEqual([
      expect.any(Number),
      expect.any(Number)
    ]);
    expect(result.capabilities.glError).toBeNull();
    expect(result.capabilities.contextLost).toBe(false);

    expectExactKeys(result.rendererSnapshot, SNAPSHOT_KEYS);
    expect(result.rendererSnapshot).toMatchObject({
      backend: "webgl2",
      backingWidth: expectedCase.backing[0],
      backingHeight: expectedCase.backing[1],
      resourceCount: 4,
      failure: null
    });
    for (const field of [
      "stagingBytes",
      "textureBytes",
      "runtimeBytes",
      "nativeProbeAttempts",
      "probeReadbackBytes",
      "contextListenerCount"
    ] as const) {
      expect(result.rendererSnapshot[field]).toBeGreaterThanOrEqual(0);
    }
    expectExactKeys(result.release, ["extensionAvailable", "requested"]);
    expect(result.release.requested).toBe(result.release.extensionAvailable);
  }
  expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(32 * 1024);
}

function expectExactKeys(
  value: object,
  expected: readonly string[]
): void {
  expect(Object.keys(value).sort()).toEqual([...expected].sort());
}

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "aval-built-endpoint-"));
  temporaryRoots.push(root);
  const demos = [
    ["examples/end-user-playground/dist", "/assets/app.js", "favorite"],
    ["examples/grass-rabbit/dist", "/aval/assets/app.js", "grass-rabbit"],
    ["examples/grass-rabbit-codecs/dist", "/assets/app.js", "grass-rabbit"],
    ["examples/kinetic-orb/dist", "/assets/app.js", "kinetic-orb"]
  ] as const;
  for (const [directory, script, assetDirectory] of demos) {
    const image = directory.includes("end-user")
      ? '<img src="/favorite.png">'
      : "";
    await put(
      root,
      `${directory}/index.html`,
      `<script src="${script}"></script>${image}`
    );
    await put(
      root,
      `${directory}/assets/app.js`,
      directory.includes("end-user") ? "original-playground-script" : directory
    );
    await put(root, `${directory}/${assetDirectory}/h264.avl`,
      Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
    if (directory.includes("end-user")) {
      await put(root, `${directory}/favorite.png`, Buffer.from([137, 80, 78, 71]));
    }
  }
  for (const name of [
    "codec-probe.html",
    "codec-probe.js",
    "renderer-isolator.html",
    "renderer-isolator.js"
  ]) {
    await put(
      root,
      `scripts/browser-compatibility/${name}`,
      await readFile(resolve(WORKSPACE_ROOT, `scripts/browser-compatibility/${name}`))
    );
  }
  await put(root, "packages/element/dist/index.js", "export function defineAvalElement() {}\n");
  await put(root, "packages/element/dist/renderer.js", "export class Renderer {}\n");
  await put(root, "packages/graph/dist/index.js", "export {};\n");
  await put(root, "packages/format/dist/index.js", "export {};\n");
  return root;
}

async function put(root: string, name: string, contents: string | Uint8Array) {
  const path = resolve(root, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function listen(store: Awaited<ReturnType<typeof createBuiltExamplesAssetStore>>) {
  const server = createBuiltExamplesServer(store);
  await new Promise<void>((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListening();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server has no TCP address");
  }
  return { server, baseUrl: `http://127.0.0.1:${String(address.port)}` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => error === undefined ? resolveClose() : reject(error));
  });
}

function rawRequest(server: Server, path: string, method = "GET") {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server has no TCP address");
  }
  return new Promise<{
    status: number | undefined;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  }>((resolveRequest, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      path,
      method
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => resolveRequest({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

function isAvalRequest(url: string) {
  return new URL(url).pathname.endsWith(".avl");
}
