import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FORMAT_DEFAULT_BUDGETS } from "@pixel-point/aval-format";

import {
  createBoundedReadAdmission,
  createPackageModuleStore,
  findOwningPackageRoot,
  isResolvedPathWithinRoot,
  launchDevServerOpener,
  readOpenedFile,
  resolveRealPathWithinRoot,
  startDevServer
} from "../src/commands/dev-server.js";
import type {
  DevServerAsset,
  DevServerBuild
} from "../src/commands/dev-server.js";

const roots: string[] = [];
const TEST_SESSION_TOKEN = "a".repeat(43);
const BUILD_REPORT_BYTES = new TextEncoder().encode(
  '{"assets":[],"reportVersion":"1.0"}'
);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("loopback dev server", () => {
  it("rejects its closed signal when a bound server fails at runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-dev-server-runtime-error-"));
    roots.push(root);
    let physical: ReturnType<typeof createServer> | null = null;
    const server = await startDevServer({
      bundlePath: join(root, "motion"),
      port: 0,
      createHttpServer: ((handler: Parameters<typeof createServer>[0]) => {
        physical = createServer(handler);
        return physical;
      }) as typeof createServer
    });
    physical!.emit("error", new Error("injected post-bind failure"));
    await expect(server.closed).rejects.toMatchObject({ code: "IO_FAILED" });
    expect(() => server.publish(devBuild(1))).toThrow("closed");
    await server.close();
  });

  it("serves every published bundle file with exact range/entity headers", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-dev-server-"));
    roots.push(root);
    const bundlePath = join(root, "motion");
    const path = join(bundlePath, "h264.avl");
    const bytes = Uint8Array.from({ length: 64 }, (_, index) => index);
    const digest = createHash("sha256").update(bytes).digest("hex");
    await mkdir(bundlePath);
    await Promise.all([
      writeFile(path, bytes),
      writeFile(join(bundlePath, "build.json"), BUILD_REPORT_BYTES)
    ]);
    const server = await startDevServer({ bundlePath, port: 0 });
    try {
      server.publish(devBuild(1, [devAsset("h264", bytes)]));
      const response = await fetch(new URL("h264.avl#v=1", server.url), {
        headers: { Range: "bytes=8-15" }
      });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe("bytes 8-15/64");
      expect(response.headers.get("content-encoding")).toBe("identity");
      expect(response.headers.get("etag")).toBe(`"aval-${digest}"`);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.subarray(8, 16));
      const full = await fetch(new URL("h264.avl", server.url), {
        headers: {
          Range: "bytes=8-15",
          "If-Range": '"different-entity"'
        }
      });
      expect(full.status).toBe(200);
      expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);
      const head = await fetch(new URL("h264.avl", server.url), { method: "HEAD" });
      expect(head.headers.get("content-length")).toBe("64");
      expect(await head.text()).toBe("");
      const report = await fetch(new URL("build.json", server.url));
      expect(report.headers.get("content-type")).toContain("application/json");
      expect(new Uint8Array(await report.arrayBuffer())).toEqual(BUILD_REPORT_BYTES);
      expect((await fetch(new URL("h264.avl", server.url), { method: "POST" })).status).toBe(405);
      const invalidRange = await fetch(new URL("h264.avl", server.url), {
        headers: { Range: "bytes=100-200" }
      });
      expect(invalidRange.status).toBe(416);
      expect(invalidRange.headers.get("accept-ranges")).toBe("bytes");
      expect(invalidRange.headers.get("content-range")).toBe("bytes */64");
      expect(invalidRange.headers.get("etag")).toBe(`"aval-${digest}"`);
      expect(await invalidRange.json()).toEqual({ error: "invalid-range" });
      const invalidRangeHead = await fetch(new URL("h264.avl", server.url), {
        method: "HEAD",
        headers: { Range: "bytes=0-" }
      });
      expect(invalidRangeHead.status).toBe(416);
      expect(invalidRangeHead.headers.get("content-range")).toBe("bytes */64");
      expect(invalidRangeHead.headers.get("content-length")).toBe(String(
        Buffer.byteLength('{"error":"invalid-range"}')
      ));
      expect(await invalidRangeHead.text()).toBe("");
      await writeFile(path, Uint8Array.from({ length: 64 }, () => 255));
      expect((await fetch(new URL("h264.avl", server.url))).status).toBe(503);
    } finally {
      await server.close();
    }
  });

  it("rejects port collisions and closes event-stream clients", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-dev-server-port-"));
    roots.push(root);
    const first = await startDevServer({
      bundlePath: join(root, "first"),
      port: 0
    });
    const port = Number(new URL(first.url).port);
    await expect(startDevServer({
      bundlePath: join(root, "second"),
      port
    })).rejects.toMatchObject({ code: "IO_FAILED" });
    const stream = await fetch(new URL("events", first.url));
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const closing = first.close();
    await closing;
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it("reports no bundle files before the first successful publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-dev-server-empty-"));
    roots.push(root);
    const server = await startDevServer({
      bundlePath: join(root, "missing"),
      port: 0
    });
    try {
      expect((await fetch(new URL("h264.avl", server.url))).status).toBe(404);
      expect((await fetch(new URL("build.json", server.url))).status).toBe(404);
      const page = await fetch(server.url);
      expect(page.status).toBe(200);
      const csp = page.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("script-src 'self'; style-src 'self';");
      expect(csp).toContain("worker-src 'self'");
      expect(csp).not.toMatch(/sha256-|nonce-|unsafe-inline|blob:|data:/u);
      const html = await page.text();
      expect(html).toContain('<script type="module" src="./client.js"></script>');
      expect(html).toContain('id="timeline"');
      expect(html).toContain("Run stress burst");
      expect(html).toContain("Capture diagnostics trace");
      expect(html).toContain("outside the viewport");
      expect(html).not.toContain("importmap");
      const client = await (await fetch(new URL("client.js", server.url))).text();
      expect(client).toContain("getDiagnostics({trace:false})");
      expect(client).toContain("getDiagnostics({trace:true})");
      expect(client).toContain('document.createElement("source")');
      expect(client).not.toContain("motion.src=");
      expect(client).not.toContain("const render=()=>{const diagnostics=motion.getDiagnostics({trace:true})");
    } finally {
      await server.close();
    }
  });

  it("serves compiler-context package modules only below the opaque session URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-dev-server-modules-"));
    roots.push(root);
    const server = await startDevServer({ bundlePath: join(root, "motion"), port: 0 });
    try {
      const module = await fetch(new URL("modules/element/index.js", server.url));
      expect(module.status).toBe(200);
      expect(module.headers.get("content-type")).toContain("text/javascript");
      expect(await module.text()).toContain("AvalElement");
      const workerDependency = await (await fetch(new URL("modules/player-web/decoder-worker/core-validation.js", server.url))).text();
      expect(workerDependency).toContain(`${new URL(server.url).pathname}modules/format/index.js`);
      expect(workerDependency).not.toContain('"@pixel-point/aval-format"');
      const workerEntry = await fetch(new URL("modules/player-web/decoder-worker/entry.js", server.url));
      const workerCsp = workerEntry.headers.get("content-security-policy") ?? "";
      expect(workerCsp).toContain("default-src 'none'");
      expect(workerCsp).toContain("script-src 'self'");
      expect(workerCsp).toContain("worker-src 'self'");
      expect(workerCsp).not.toMatch(/blob:|data:|unsafe-inline|unsafe-eval/u);
      const elementWorker = await fetch(new URL(
        "modules/element/decoder-worker.js?no-inline",
        server.url
      ));
      expect(elementWorker.status).toBe(200);
      expect(elementWorker.headers.get("content-security-policy")).toBe(
        workerEntry.headers.get("content-security-policy")
      );
      expect((await fetch(new URL(
        "modules/element/decoder-worker.js?no-inline=1",
        server.url
      ))).status).toBe(404);
      expect((await fetch(new URL(
        "modules/player-web/decoder-worker/entry.js?no-inline",
        server.url
      ))).status).toBe(404);
      const publicOrigin = new URL(server.url).origin;
      expect((await fetch(`${publicOrigin}/modules/element/index.js`)).status).toBe(404);
      expect((await fetch(new URL("modules/element/%2e%2e/index.js", server.url))).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("requires the exact dynamic Host, opaque session path, Origin, and Fetch Metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-dev-server-authority-"));
    roots.push(root);
    const server = await startDevServer({ bundlePath: join(root, "motion"), port: 0 });
    try {
      const url = new URL(server.url);
      expect(url.pathname).toMatch(/^\/[A-Za-z0-9_-]{43}\/$/u);
      expect((await fetch(server.url)).status).toBe(200);

      const missingCapability = await fetch(`${url.origin}/`);
      expect(missingCapability.status).toBe(404);
      expect(await missingCapability.text()).not.toContain(url.pathname.slice(1, -1));
      expect((await fetch(`${url.origin}/${"b".repeat(43)}/`)).status).toBe(404);
      expect((await fetch(`${server.url}?raw=secret`)).status).toBe(404);

      expect(statusOf(await rawHttp(Number(url.port), [
        `GET ${url.pathname} HTTP/1.1`,
        `Host: localhost:${url.port}`,
        "Connection: close"
      ]))).toBe(421);
      expect(statusOf(await rawHttp(Number(url.port), [
        `GET ${url.pathname} HTTP/1.1`,
        "Connection: close"
      ]))).toBeGreaterThanOrEqual(400);
      expect(statusOf(await rawHttp(Number(url.port), [
        `GET ${url.pathname} HTTP/1.1`,
        `Host: ${url.host}`,
        `Host: localhost:${url.port}`,
        "Connection: close"
      ]))).toBeGreaterThanOrEqual(400);
      expect(statusOf(await rawHttp(Number(url.port), [
        `GET ${url.pathname} HTTP/1.1`,
        "Host: 127.0.0.1",
        "Connection: close"
      ]))).toBe(421);

      expect(statusOf(await rawHttp(Number(url.port), browserHeaders(url, url.pathname, "none", "navigate", "document")))).toBe(200);
      expect(await rawHttpStatus(Number(url.port), browserHeaders(url, `${url.pathname}events`, "same-origin", "cors", "empty"))).toBe(200);
      expect(await rawHttpStatus(Number(url.port), [
        `GET ${url.pathname}modules/player-web/decoder-worker/entry.js HTTP/1.1`,
        `Host: ${url.host}`,
        "Sec-Fetch-Site: same-origin",
        "Sec-Fetch-Mode: same-origin",
        "Sec-Fetch-Dest: worker",
        "Connection: close"
      ])).toBe(200);
      expect(await rawHttpStatus(Number(url.port), [
        `GET ${url.pathname}modules/element/decoder-worker.js?no-inline HTTP/1.1`,
        `Host: ${url.host}`,
        "Sec-Fetch-Site: same-origin",
        "Sec-Fetch-Mode: same-origin",
        "Sec-Fetch-Dest: worker",
        "Connection: close"
      ])).toBe(200);
      expect(await rawHttpStatus(Number(url.port), [
        `GET ${url.pathname}modules/player-web/decoder-worker/host.js HTTP/1.1`,
        `Host: ${url.host}`,
        `Origin: ${url.origin}`,
        "Sec-Fetch-Site: same-origin",
        "Sec-Fetch-Mode: cors",
        "Sec-Fetch-Dest: worker",
        "Connection: close"
      ])).toBe(200);
      expect(statusOf(await rawHttp(Number(url.port), browserHeaders(url, `${url.pathname}events`, "cross-site", "cors", "empty")))).toBe(403);
      expect(statusOf(await rawHttp(Number(url.port), [
        `GET ${url.pathname}events HTTP/1.1`,
        `Host: ${url.host}`,
        "Origin: http://evil.invalid",
        "Sec-Fetch-Site: same-origin",
        "Sec-Fetch-Mode: cors",
        "Sec-Fetch-Dest: empty",
        "Connection: close"
      ]))).toBe(403);
      expect(statusOf(await rawHttp(Number(url.port), [
        `GET ${url.pathname}events HTTP/1.1`,
        `Host: ${url.host}`,
        `Origin: ${url.origin}`,
        "Sec-Fetch-Site: same-origin",
        "Connection: close"
      ]))).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("bounds publication metadata and detects a changed asset before serving", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-dev-server-bounds-"));
    roots.push(root);
    const bundlePath = join(root, "motion");
    const path = join(bundlePath, "h264.avl");
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    await mkdir(bundlePath);
    await Promise.all([
      writeFile(path, bytes),
      writeFile(join(bundlePath, "build.json"), BUILD_REPORT_BYTES)
    ]);
    const valid = devBuild(1, [devAsset("h264", bytes)]);
    const server = await startDevServer({ bundlePath, port: 0 });
    try {
      expect(() => server.publish({
        ...valid,
        assets: [{
          ...valid.assets[0]!,
          bytes: FORMAT_DEFAULT_BUDGETS.maxFileBytes + 1
        }]
      })).toThrow(TypeError);
      expect(() => server.publish({
        ...valid,
        assets: [{ ...valid.assets[0]!, sha256: `${valid.assets[0]!.sha256}0` }]
      })).toThrow(TypeError);
      expect(() => server.publish({
        ...valid,
        warnings: Array.from({ length: 65 }, () => "warning")
      })).toThrow(TypeError);
      expect(() => server.publish({
        ...valid,
        warnings: ["w".repeat(513)]
      })).toThrow(TypeError);
      server.publish(valid);
      expect(() => server.publish(valid)).toThrow(TypeError);
      expect(() => server.publish({ ...valid, generation: 0 })).toThrow(TypeError);
      server.publish({ ...devBuild(2, [devAsset("h264", bytes)]), warnings: ["bounded warning"] });
      await truncate(path, bytes.byteLength + 1);
      expect((await fetch(new URL("h264.avl", server.url))).status).toBe(503);
    } finally {
      await server.close();
    }
    expect(() => server.publish(devBuild(3, [devAsset("h264", bytes)]))).toThrow(TypeError);
  });

  it("rejects non-loopback runtime hosts and malformed bundle paths", async () => {
    await expect(startDevServer({
      bundlePath: "motion",
      port: 0,
      host: "0.0.0.0" as "127.0.0.1"
    })).rejects.toMatchObject({ code: "CLI_USAGE" });
    await expect(startDevServer({ bundlePath: " ", port: 0 })).rejects.toMatchObject({
      code: "CLI_USAGE"
    });
  });

  it("publishes one bounded SSE build event and ends it on close", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-dev-server-events-"));
    roots.push(root);
    const bundlePath = join(root, "motion");
    const h264 = Uint8Array.from([1, 2, 3, 4]);
    const vp9 = Uint8Array.from([5, 6, 7]);
    const server = await startDevServer({ bundlePath, port: 0 });
    const stream = await fetch(new URL("events", server.url));
    const reader = stream.body!.getReader();
    try {
      server.publish({
        ...devBuild(1, [devAsset("vp9", vp9), devAsset("h264", h264)]),
        warnings: ["ready"]
      });
      const first = await reader.read();
      expect(first.done).toBe(false);
      const event = new TextDecoder().decode(first.value);
      expect(event).toContain(`event: build\ndata: {"generation":1,"sources":[`);
      expect(event.indexOf('"codec":"vp9"')).toBeLessThan(event.indexOf('"codec":"h264"'));
      expect(event).toContain('"src":"vp9.avl#v=1"');
      expect(event).toContain('"buildReport":{"src":"build.json#v=1"');
    } finally {
      await server.close();
    }
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it("caps event streams and releases a disconnected client slot", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-dev-server-client-cap-"));
    roots.push(root);
    const server = await startDevServer({
      bundlePath: join(root, "motion"),
      port: 0
    });
    const streams: Response[] = [];
    try {
      for (let index = 0; index < 32; index += 1) {
        const stream = await fetch(new URL("events", server.url));
        expect(stream.status).toBe(200);
        streams.push(stream);
      }
      expect((await fetch(new URL("events", server.url))).status).toBe(429);
      const head = await fetch(new URL("events", server.url), { method: "HEAD" });
      expect(head.status).toBe(405);
      expect(head.headers.get("allow")).toBe("GET");
      expect(await head.text()).toBe("");
      await streams.shift()!.body!.cancel();
      let replacement: Response | undefined;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const candidate = await fetch(new URL("events", server.url));
        if (candidate.status === 200) {
          replacement = candidate;
          break;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
      expect(replacement?.status).toBe(200);
      if (replacement !== undefined) streams.push(replacement);
    } finally {
      await server.close();
    }
    await Promise.all(streams.map((stream) => stream.body?.cancel()));
  });

  it("rejects symlinks escaping a canonical module root", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "aval-dev-realpath-"));
    roots.push(temporary);
    const root = join(temporary, "root");
    const outside = join(temporary, "outside");
    await Promise.all([mkdir(root), mkdir(outside)]);
    const insideFile = join(root, "inside.js");
    const outsideFile = join(outside, "outside.js");
    await Promise.all([
      writeFile(insideFile, "export {};\n"),
      writeFile(outsideFile, "throw new Error();\n")
    ]);
    const insideLink = join(root, "inside-link.js");
    const escapeLink = join(root, "escape-link.js");
    await Promise.all([
      symlink(insideFile, insideLink),
      symlink(outsideFile, escapeLink)
    ]);
    await expect(resolveRealPathWithinRoot(root, insideLink)).resolves.toBe(
      await realpath(insideFile)
    );
    await expect(resolveRealPathWithinRoot(root, escapeLink)).resolves.toBeNull();
    await expect(resolveRealPathWithinRoot(root, join(root, "missing.js"))).resolves.toBeNull();
    await expect(resolveRealPathWithinRoot(root, root)).resolves.toBeNull();
  });

  it("serves compiler-owned packages from isolated nested layouts without hoisting", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "aval-dev-modules-"));
    roots.push(temporary);
    const packageNames = {
      element: "@pixel-point/aval-element",
      "player-web": "@pixel-point/aval-player-web",
      format: "@pixel-point/aval-format",
      graph: "@pixel-point/aval-graph"
    } as const;
    const resolutions = new Map<string, { entryPath: string; packageRoot: string }>();
    for (const [key, packageName] of Object.entries(packageNames)) {
      const packageRoot = join(temporary, ".pnpm", `${key}@1.0.0`, "node_modules", ...packageName.split("/"));
      const distribution = join(packageRoot, "dist");
      await mkdir(distribution, { recursive: true });
      await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: packageName }));
      const entryPath = join(distribution, "index.js");
      await writeFile(entryPath, `export const packageName=${JSON.stringify(packageName)};\n`);
      resolutions.set(packageName, { entryPath, packageRoot });
      expect(await findOwningPackageRoot(entryPath, packageName)).toBe(await realpath(packageRoot));
    }
    const store = await createPackageModuleStore(async (packageName) => resolutions.get(packageName)!);
    const admission = createBoundedReadAdmission(2);
    const read = await store.read("player-web", "index.js", admission);
    expect(read.status).toBe("ok");
    if (read.status === "ok") expect(read.bytes.toString("utf8")).toContain("@pixel-point/aval-player-web");

    const outside = join(temporary, "outside.js");
    await writeFile(outside, "throw new Error('escaped');\n");
    await symlink(outside, join(store.roots().element, "escape.js"));
    await expect(store.read("element", "escape.js", admission)).resolves.toEqual({ status: "missing" });
    await expect(store.read("element", "../outside.js", admission)).resolves.toEqual({ status: "missing" });

    const compilerManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version?: string; dependencies?: Record<string, string> };
    expect(compilerManifest.dependencies?.["@pixel-point/aval-player-web"]).toBe(compilerManifest.version);
  });

  it("admits no queued reads beyond its exact concurrency bound", () => {
    const admission = createBoundedReadAdmission(2);
    const releaseFirst = admission.tryAcquire();
    const releaseSecond = admission.tryAcquire();
    expect(releaseFirst).toBeTypeOf("function");
    expect(releaseSecond).toBeTypeOf("function");
    expect(admission.tryAcquire()).toBeNull();
    releaseFirst!();
    releaseFirst!();
    const releaseThird = admission.tryAcquire();
    expect(releaseThird).toBeTypeOf("function");
    expect(admission.tryAcquire()).toBeNull();
    releaseSecond!();
    releaseThird!();
    expect(() => createBoundedReadAdmission(0)).toThrow(TypeError);
  });

  it("rejects a file that grows after its bounded open-time stat", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "aval-dev-read-race-"));
    roots.push(temporary);
    const path = join(temporary, "changing.js");
    await writeFile(path, "export {};\n");
    await expect(readOpenedFile(path, 1_024, undefined, {
      afterInitialStat: async () => writeFile(path, "export const changed = true;\n")
    })).resolves.toEqual({ status: "changing" });
    await truncate(path, 1_025);
    await expect(readOpenedFile(path, 1_024)).resolves.toEqual({ status: "too-large" });
  });

  it("contains synchronous and asynchronous platform-opener failures", () => {
    let errorListener: ((error: Error) => void) | undefined;
    let invocation: readonly [string, readonly string[]] | undefined;
    expect(() => launchDevServerOpener(
      `http://127.0.0.1:4174/${TEST_SESSION_TOKEN}/`,
      "win32",
      (command, arguments_) => {
        invocation = [command, arguments_];
        return {
          once(_event, listener): unknown {
            errorListener = listener;
            return undefined;
          },
          unref(): void {}
        };
      }
    )).not.toThrow();
    expect(invocation).toEqual([
      "cmd",
      ["/c", "start", "", `http://127.0.0.1:4174/${TEST_SESSION_TOKEN}/`]
    ]);
    expect(() => errorListener?.(new Error("opener failed"))).not.toThrow();
    expect(() => launchDevServerOpener(
      `http://[::1]:4174/${TEST_SESSION_TOKEN}/`,
      "linux",
      () => { throw new Error("spawn failed"); }
    )).not.toThrow();
    expect(() => launchDevServerOpener(
      "https://example.com",
      "linux",
      () => { throw new Error("must not run"); }
    )).toThrow(TypeError);
  });

  it("uses path semantics that contain Windows module paths", () => {
    const root = "C:\\avl\\packages\\element\\dist";
    expect(isResolvedPathWithinRoot(
      root,
      "C:\\avl\\packages\\element\\dist\\runtime\\index.js",
      win32
    )).toBe(true);
    expect(isResolvedPathWithinRoot(
      root,
      "C:\\avl\\packages\\element\\outside.js",
      win32
    )).toBe(false);
    expect(isResolvedPathWithinRoot(
      root,
      "D:\\avl\\packages\\element\\dist\\index.js",
      win32
    )).toBe(false);
  });
});

function browserHeaders(url: URL, path: string, site: string, mode: string, destination: string): readonly string[] {
  return [
    `GET ${path} HTTP/1.1`,
    `Host: ${url.host}`,
    `Origin: ${url.origin}`,
    `Sec-Fetch-Site: ${site}`,
    `Sec-Fetch-Mode: ${mode}`,
    `Sec-Fetch-Dest: ${destination}`,
    "Connection: close"
  ];
}

async function rawHttp(port: number, lines: readonly string[]): Promise<string> {
  return new Promise<string>((resolveResponse, reject) => {
    const chunks: Buffer[] = [];
    const socket = createConnection({ host: "127.0.0.1", port }, () => socket.end(`${lines.join("\r\n")}\r\n\r\n`));
    socket.setTimeout(2_000, () => socket.destroy(new Error("raw HTTP response timed out")));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => resolveResponse(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}

async function rawHttpStatus(port: number, lines: readonly string[]): Promise<number> {
  return new Promise<number>((resolveStatus, reject) => {
    let response = "";
    let settled = false;
    const socket = createConnection({ host: "127.0.0.1", port }, () => socket.write(`${lines.join("\r\n")}\r\n\r\n`));
    socket.setTimeout(2_000, () => socket.destroy(new Error("raw HTTP headers timed out")));
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
      if (!settled && response.includes("\r\n\r\n")) {
        settled = true;
        const status = statusOf(response);
        socket.destroy();
        resolveStatus(status);
      }
    });
    socket.on("error", (error) => { if (!settled) reject(error); });
    socket.on("close", () => { if (!settled) reject(new Error("raw HTTP connection closed before headers")); });
  });
}

function statusOf(response: string): number {
  const match = /^HTTP\/1\.1 ([0-9]{3})/u.exec(response);
  if (match === null) throw new Error(`raw response lacks an HTTP status: ${response.slice(0, 80)}`);
  return Number(match[1]);
}

function devAsset(
  codec: DevServerAsset["codec"],
  bytes: Uint8Array
): Readonly<DevServerAsset> {
  const codecString = {
    h264: "avc1.42E01E",
    h265: "hvc1.1.6.L93.90",
    vp9: "vp09.00.10.08.01.01.01.01.00",
    av1: "av01.0.04M.08.0.110.01.01.01.0"
  }[codec];
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return Object.freeze({
    codec,
    path: `${codec}.avl`,
    bytes: bytes.byteLength,
    sha256,
    type: `application/vnd.aval; codecs="${codecString}"`,
    integrity: `sha256-${Buffer.from(sha256, "hex").toString("base64")}`
  });
}

function devBuild(
  generation: number,
  assets: readonly Readonly<DevServerAsset>[] = [
    devAsset("h264", Uint8Array.of(1))
  ]
): Readonly<DevServerBuild> {
  return Object.freeze({
    generation,
    assets: Object.freeze([...assets]),
    buildReport: Object.freeze({
      path: "build.json",
      bytes: BUILD_REPORT_BYTES.byteLength,
      sha256: createHash("sha256").update(BUILD_REPORT_BYTES).digest("hex")
    }),
    warnings: Object.freeze([])
  });
}
