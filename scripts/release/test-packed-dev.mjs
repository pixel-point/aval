#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { build as viteBuild, preview as vitePreview } from "vite";

import { ELEMENT_RELEASE_WORKER } from "./element-release-contract.mjs";
import {
  RELEASE_PACKAGE_SPECS,
  RELEASE_VERSION,
  releaseArchiveFilename
} from "./release-set-model.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageDirectory = resolve(
  root,
  option("--packages") ?? `artifacts/${RELEASE_VERSION}/packages`
);
const expectedCodecs = Object.freeze(["av1", "vp9", "h265", "h264"]);
const expectedCodecPrefixes = Object.freeze({
  av1: "av01.",
  vp9: "vp09.",
  h265: "hvc1.",
  h264: "avc1."
});
const STRICT_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; " +
  "connect-src 'self'; worker-src 'self'; img-src 'self'; object-src 'none'; " +
  "base-uri 'none'; frame-ancestors 'none'";
const archiveNames = (await readdir(packageDirectory))
  .filter((name) => name.endsWith(".tgz"))
  .sort();
const expectedArchiveNames = RELEASE_PACKAGE_SPECS
  .map(({ name }) => releaseArchiveFilename(name))
  .sort();
assert(
  JSON.stringify(archiveNames) === JSON.stringify(expectedArchiveNames),
  `packed archive set was not exact: ${JSON.stringify(archiveNames)}`
);
const archives = expectedArchiveNames.map((name) => join(packageDirectory, name));

const temporary = await realpath(await mkdtemp(join(tmpdir(), "aval-packed-dev-")));
const project = join(temporary, "project");
const npmCache = join(temporary, "npm-cache");
let child;
let childExit;
let childExitState;
let browser;
let viteServer;

try {
  await cp(resolve(root, "fixtures/starter/v1-idle-hover"), project, { recursive: true });
  await removeHarnessProvidedViteDependency(project);
  run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--offline",
      "--cache",
      npmCache,
      ...archives
    ],
    project,
    120_000
  );
  await verifyInstalledGraph(project, RELEASE_VERSION);

  const cli = join(
    project,
    "node_modules",
    "@pixel-point",
    "aval-compiler",
    "dist",
    "cli.js"
  );
  child = spawn(process.execPath, [
    cli,
    "dev",
    "motion.json",
    "--out",
    "motion",
    "--port",
    "0",
    "--force",
    "--json"
  ], {
    cwd: project,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  const output = createJsonLineCollector(
    child.stdout,
    "packed avl dev stdout",
    () => stderr
  );
  const observeDiagnostic = createJsonErrorMonitor((diagnostic) => {
    output.fail(devDiagnosticError(diagnostic));
    child.kill("SIGTERM");
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    try {
      stderr = boundedAppend(stderr, chunk, 4 * 1024 * 1024, "packed avl dev stderr");
      observeDiagnostic(chunk);
    } catch (error) {
      output.fail(error);
      child.kill("SIGTERM");
    }
  });
  childExit = new Promise((resolveExit, rejectExit) => {
    child.once("error", (error) => {
      output.fail(error);
      rejectExit(error);
    });
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  }).then((result) => {
    childExitState = result;
    output.fail(new Error(
      `packed avl dev exited (${String(result.code ?? result.signal)})`
    ));
    return result;
  });

  const listening = await output.waitFor((value) =>
    value?.command === "dev" && value.event === "listening", 30_000);
  assert(typeof listening.url === "string", "dev listening event omitted its URL");
  const devUrl = listening.url;
  assert(/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]+\/[A-Za-z0-9_-]{43}\/$/u.test(devUrl), `dev server did not expose one loopback capability URL: ${devUrl}`);
  const firstBuild = await output.waitFor(isBuildEvent, 120_000);
  verifyBuildEvent(firstBuild);

  const servedSources = await verifyHttpSurface(devUrl, firstBuild, [root, project]);
  await viteBuild({
    root: project,
    configFile: false,
    logLevel: "silent",
    build: {
      outDir: "dist",
      emptyOutDir: true,
      minify: "oxc",
      sourcemap: false
    }
  });
  await cp(join(project, "motion"), join(project, "dist", "motion"), {
    recursive: true
  });
  const builtStarter = await readTextTree(join(project, "dist"));
  assert(builtStarter.includes("aval-player"), "generated starter web build omitted the element");
  assertNoFilesystemLeak(builtStarter, [root, project]);
  viteServer = await vitePreview({
    root: project,
    configFile: false,
    logLevel: "silent",
    preview: {
      host: "127.0.0.1",
      port: 0,
      strictPort: true,
      headers: { "Content-Security-Policy": STRICT_CSP }
    }
  });
  const starterUrl = viteServer.resolvedUrls?.local[0];
  assert(typeof starterUrl === "string" && /^http:\/\/127\.0\.0\.1:[0-9]+\/$/u.test(starterUrl), "generated production starter preview omitted its loopback URL");

  browser = await chromium.launch({ channel: "chromium", headless: true });
  const starterContext = await browser.newContext();
  await installWorkerEvidence(starterContext);
  const starterPage = await starterContext.newPage();
  const starterFailures = monitorBrowser(starterPage, starterUrl, [root, project]);
  const starterResponse = await starterPage.goto(starterUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30_000
  });
  assert(
    starterResponse?.headers()["content-security-policy"] === STRICT_CSP,
    "generated production starter preview omitted its strict CSP"
  );
  await assertPinnedChromiumCapabilities(starterPage);
  await waitForElementReady(starterPage, "interactiveReady");
  const starterSnapshot = await publicSnapshot(starterPage);
  assert(starterSnapshot.stateNames.includes("idle"), "generated starter omitted its idle state");
  assert(starterSnapshot.stateNames.includes("engaged"), "generated starter omitted its engaged state");
  assert(
    hasStaticBundleSources(starterSnapshot),
    "generated starter did not install the ordered codec bundle sources"
  );
  assert(starterSnapshot.videoCount === 0, "generated starter created a video element");
  await starterPage.locator("#favorite").hover();
  await starterPage.waitForFunction(() =>
    document.querySelector("aval-player")?.requestedState === "engaged",
  { timeout: 10_000 });
  await starterPage.mouse.move(0, 0);
  await starterPage.waitForFunction(() =>
    document.querySelector("aval-player")?.requestedState === "idle",
  { timeout: 10_000 });
  await starterFailures.assertWorkerExecuted();
  starterFailures.assertClean();
  await starterContext.close();

  const failureContext = await browser.newContext();
  await failureContext.addInitScript(() => {
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: undefined });
  });
  const failurePage = await failureContext.newPage();
  const failureMonitor = monitorBrowser(failurePage, starterUrl, [root, project]);
  await failurePage.goto(starterUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitForElementReady(failurePage, "error");
  const failureSnapshot = await publicSnapshot(failurePage);
  assert(failureSnapshot.staticReason === null, "terminal starter failure claimed static readiness");
  assert(failureSnapshot.alternateVisible, "consumer did not reveal its alternate image after failure");
  assert(failureSnapshot.fallbackSlotCount === 0, "element retained a managed fallback slot");
  assert(failureSnapshot.animatedCanvasHidden && failureSnapshot.canvasCount === 1, "failed starter exposed an unexpected presentation canvas");
  assert(failureSnapshot.alternateConsumerOwned && failureSnapshot.alternateImageLoaded, "starter did not retain and load its consumer-owned alternate image");
  assert(failureSnapshot.videoCount === 0, "failed starter created a video element");
  failureMonitor.assertClean();
  await failureContext.close();

  const devContext = await browser.newContext();
  await installWorkerEvidence(devContext);
  const page = await devContext.newPage();
  const browserFailures = monitorBrowser(page, devUrl, [root, project]);
  await page.goto(devUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitForReady(page, firstBuild.sequence);
  const initialSnapshot = await publicSnapshot(page);
  assert(initialSnapshot.readiness === "interactiveReady", "capable pinned Chromium did not reach interactive readiness");
  assert(initialSnapshot.stateNames.includes("idle"), "packed element omitted the author-defined idle state");
  assert(initialSnapshot.stateNames.includes("engaged"), "packed element omitted the author-defined engaged state");
  assert(
    snapshotUsesGeneration(initialSnapshot, firstBuild.sequence),
    "initial build did not install generation URLs for every codec source"
  );
  assert(initialSnapshot.videoCount === 0, "packed dev playground created a video element");

  await page.locator("#interaction").hover();
  await page.waitForFunction(() =>
    document.querySelector("aval-player")?.requestedState === "engaged",
  { timeout: 10_000 });
  await page.mouse.move(0, 0);
  await page.waitForFunction(() =>
    document.querySelector("aval-player")?.requestedState === "idle",
  { timeout: 10_000 });

  const projectPath = join(project, "motion.json");
  const originalProject = await readFile(projectPath, "utf8");
  const replacementProject = originalProject.replace('"fit":"contain"', '"fit":"cover"');
  assert(replacementProject !== originalProject, "starter project did not expose the expected replacement seam");
  await writeFile(projectPath, replacementProject);
  const secondBuild = await output.waitFor((value) =>
    isBuildEvent(value) && value.sequence > firstBuild.sequence,
  120_000);
  verifyBuildEvent(secondBuild);
  verifyReplacementDigests(firstBuild, secondBuild);
  await waitForReady(page, secondBuild.sequence);
  const replacementSnapshot = await publicSnapshot(page);
  assert(
    snapshotUsesGeneration(replacementSnapshot, secondBuild.sequence),
    "watch rebuild did not replace every public element source"
  );
  assert(
    replacementSnapshot.sourceGeneration > initialSnapshot.sourceGeneration,
    "watch rebuild did not advance the element source generation"
  );
  await verifyAssets(devUrl, secondBuild);
  const report = await checkedJson(new URL("build.json", devUrl));
  verifyBuildReport(report, secondBuild);

  await browserFailures.assertWorkerExecuted();
  await devContext.close();
  await browser.close();
  browser = undefined;
  await closePreview(viteServer);
  viteServer = undefined;
  browserFailures.assertClean();
  assertNoFilesystemLeak(JSON.stringify({ servedSources, report }), [root, project]);

  child.kill("SIGINT");
  const exit = await withTimeout(childExit, 30_000, "packed avl dev did not stop after SIGINT");
  assert(exit.code === 130 && exit.signal === null, `packed avl dev did not exit cleanly: ${JSON.stringify(exit)}`);
  child = undefined;

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    packages: RELEASE_PACKAGE_SPECS.length,
    firstGeneration: firstBuild.sequence,
    replacementGeneration: secondBuild.sequence,
    readiness: replacementSnapshot.readiness,
    exitCode: exit.code
  })}\n`);
} finally {
  if (browser !== undefined) await browser.close().catch(() => undefined);
  if (viteServer !== undefined) await closePreview(viteServer).catch(() => undefined);
  if (child !== undefined && childExitState === undefined) {
    child.kill("SIGTERM");
    const stopped = await withTimeout(childExit, 5_000, "", false).catch(() => undefined);
    if (stopped === undefined) {
      child.kill("SIGKILL");
      await childExit.catch(() => undefined);
    }
  }
  await rm(temporary, { recursive: true, force: true });
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

async function removeHarnessProvidedViteDependency(projectRoot) {
  const manifestPath = join(projectRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const viteVersion = manifest.devDependencies?.vite;
  assert(typeof viteVersion === "string", "packed-dev fixture omitted its Vite version");
  const devDependencies = { ...manifest.devDependencies };
  delete devDependencies.vite;
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, devDependencies })}\n`);
}

async function verifyInstalledGraph(projectRoot, version) {
  const scope = join(projectRoot, "node_modules", "@pixel-point");
  const canonicalScope = await realpath(scope);
  const manifests = new Map();
  for (const specification of RELEASE_PACKAGE_SPECS) {
    const directory = join(scope, specification.name.slice("@pixel-point/".length));
    assert(!(await lstat(directory)).isSymbolicLink(), `installed ${specification.name} package is a symlink`);
    const canonical = await realpath(directory);
    assert(
      canonical.startsWith(`${canonicalScope}${sep}`),
      `installed ${specification.name} package escaped the clean node_modules scope`
    );
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    assert(manifest.name === specification.name, `installed package identity drifted for ${specification.name}`);
    assert(manifest.version === version, `${specification.name} installed at ${String(manifest.version)}, expected ${version}`);
    manifests.set(specification.name, manifest);
  }
  for (const specification of RELEASE_PACKAGE_SPECS) {
    const dependencies = manifests.get(specification.name)?.dependencies ?? {};
    assert(
      JSON.stringify(Object.keys(dependencies).sort()) ===
        JSON.stringify([...specification.dependencies].sort()),
      `packed ${specification.name} dependency graph is not exact`
    );
    for (const value of Object.values(dependencies)) {
      assert(value === version, `packed ${specification.name} dependency version is not exact`);
    }
  }
}

async function verifyHttpSurface(url, build, forbiddenPaths) {
  const pageResponse = await checkedFetch(new URL("./", url));
  assert(pageResponse.status === 200, `dev page returned ${pageResponse.status}`);
  const pageText = await pageResponse.text();
  const clientResponse = await checkedFetch(new URL("client.js", url));
  assert(clientResponse.status === 200, `dev client returned ${clientResponse.status}`);
  const clientText = await clientResponse.text();
  const moduleResponse = await checkedFetch(new URL("modules/element/auto.js", url));
  assert(moduleResponse.status === 200, `packed element module returned ${moduleResponse.status}`);
  const moduleText = await moduleResponse.text();
  const workerResponse = await checkedFetch(new URL(
    `modules/element/${ELEMENT_RELEASE_WORKER.output}?no-inline`,
    url
  ));
  assert(workerResponse.status === 200, `packed element decoder worker returned ${workerResponse.status}`);
  assert(workerResponse.headers.get("content-security-policy")?.includes("default-src 'none'") === true, "packed element decoder worker omitted its closed CSP");
  const workerText = await workerResponse.text();
  const originRoot = new URL("/", url);
  const unscoped = await checkedFetch(originRoot);
  assert(unscoped.status === 404, `unscoped dev origin unexpectedly returned ${unscoped.status}`);
  assertNoFilesystemLeak(`${pageText}\n${clientText}\n${moduleText}\n${workerText}`, forbiddenPaths);
  assert(clientText.includes('/modules/element/auto.js'), "dev client did not use the public auto entry");
  await verifyAssets(url, build);
  const compilerReport = await checkedJson(new URL("build.json", url));
  verifyBuildReport(compilerReport, build);
  return Object.freeze({ pageText, clientText, moduleText, workerText, compilerReport });
}

async function verifyAssets(url, build) {
  for (const asset of build.assets) await verifyAsset(url, asset);
}

async function verifyAsset(url, asset) {
  const assetUrl = new URL(`${asset.codec}.avl`, url);
  const range = await checkedFetch(assetUrl, {
    headers: { Range: "bytes=0-31" }
  });
  assert(range.status === 206, `${asset.codec} asset range returned ${range.status}`);
  assert(range.headers.get("content-type") === asset.type, `${asset.codec} asset range type did not match its publication`);
  assert(range.headers.get("content-range") === `bytes 0-31/${String(asset.bytes)}`, `${asset.codec} asset range boundary was not exact`);
  assert(range.headers.get("content-encoding") === "identity", `${asset.codec} asset range was not identity encoded`);
  assert(range.headers.get("etag") === `"aval-${asset.sha256}"`, `${asset.codec} asset ETag did not match its publication`);
  assert((await range.arrayBuffer()).byteLength === 32, `${asset.codec} asset range body length was not exact`);

  const full = await checkedFetch(assetUrl, {
    headers: { Range: "bytes=0-31", "If-Range": '"stale-entity"' }
  });
  assert(full.status === 200, `${asset.codec} mismatched If-Range returned ${full.status}`);
  assert(full.headers.get("content-type") === asset.type, `${asset.codec} full asset type did not match its publication`);
  const bytes = Buffer.from(await full.arrayBuffer());
  assert(bytes.byteLength === asset.bytes, `${asset.codec} full asset byte length did not match its publication`);
  assert(createHash("sha256").update(bytes).digest("hex") === asset.sha256, `${asset.codec} full asset digest did not match its publication`);
}

function monitorBrowser(page, baseUrl, forbiddenPaths = []) {
  const allowedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const allowedOrigin = new URL(baseUrl).origin;
  const pageErrors = [];
  const consoleErrors = [];
  const failedResponses = [];
  const unexpectedUrls = [];
  const workerResponses = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location().url;
    if (location.endsWith("/favicon.ico") && message.text().includes("404")) return;
    consoleErrors.push(`${message.text()}${location === "" ? "" : ` (${location})`}`);
  });
  page.on("response", (response) => {
    if (response.request().resourceType() === "worker" || response.url().includes(`/${ELEMENT_RELEASE_WORKER.output}`)) workerResponses.push({ status: response.status(), url: response.url() });
    if (response.status() >= 400 && !response.url().endsWith("/favicon.ico")) {
      failedResponses.push(`${String(response.status())} ${response.url()}`);
    }
  });
  page.on("request", (request) => {
    const url = request.url();
    const decoded = decodeURIComponent(url);
    if (
      !url.startsWith(allowedBase) ||
      forbiddenPaths.some((path) => decoded.includes(path))
    ) unexpectedUrls.push(url);
  });
  return Object.freeze({
    async assertWorkerExecuted() {
      await page.waitForFunction(() => {
        const evidence = globalThis.__avalWorkerEvidence;
        return evidence?.created.length > 0 && evidence.messages > 0;
      }, undefined, { timeout: 30_000 });
      const evidence = await page.evaluate(() => globalThis.__avalWorkerEvidence);
      assert(evidence.created.every((url) => url.startsWith(`${allowedOrigin}/`)), `decoder worker escaped the browser origin: ${evidence.created.join(", ")}`);
      assert(evidence.errors === 0 && evidence.messageErrors === 0, "decoder worker emitted a transport error");
      assert(workerResponses.every(({ status }) => status === 200), "observed decoder worker response was not successful");
    },
    assertClean() {
      assert(pageErrors.length === 0, `browser page errors: ${pageErrors.join(" | ")}`);
      assert(consoleErrors.length === 0, `browser console errors: ${consoleErrors.join(" | ")}`);
      assert(failedResponses.length === 0, `browser HTTP failures: ${failedResponses.join(" | ")}`);
      assert(unexpectedUrls.length === 0, `browser escaped the packed dev origin: ${unexpectedUrls.join(" | ")}`);
    }
  });
}

async function installWorkerEvidence(context) {
  await context.addInitScript(() => {
    const NativeWorker = globalThis.Worker;
    const evidence = { created: [], messages: 0, errors: 0, messageErrors: 0 };
    Object.defineProperty(globalThis, "__avalWorkerEvidence", { configurable: false, value: evidence });
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: new Proxy(NativeWorker, {
        construct(Target, argumentsList) {
          const worker = Reflect.construct(Target, argumentsList, Target);
          evidence.created.push(String(argumentsList[0]));
          worker.addEventListener("message", () => { evidence.messages += 1; });
          worker.addEventListener("error", () => { evidence.errors += 1; });
          worker.addEventListener("messageerror", () => { evidence.messageErrors += 1; });
          return worker;
        }
      })
    });
  });
}

async function assertPinnedChromiumCapabilities(page) {
  const capability = await page.evaluate(async () => {
    const videoDecoder = globalThis.VideoDecoder;
    let avcSupported = false;
    if (typeof videoDecoder === "function") {
      try {
        avcSupported = (await videoDecoder.isConfigSupported({ codec: "avc1.42001E", codedWidth: 48, codedHeight: 48 })).supported === true;
      } catch {
        avcSupported = false;
      }
    }
    return { worker: typeof Worker === "function", videoDecoder: typeof videoDecoder === "function", avcSupported, webgl2: typeof WebGL2RenderingContext === "function" };
  });
  assert(capability.worker && capability.videoDecoder && capability.avcSupported && capability.webgl2, `pinned Chromium lacks required interactive capabilities: ${JSON.stringify(capability)}`);
}

async function waitForReady(page, sequence) {
  await page.waitForFunction(({ sequence: expected, sourceCount }) => {
    const motion = document.querySelector("aval-player");
    const status = document.querySelector("#status")?.textContent ?? "";
    const sources = motion === null
      ? []
      : [...motion.querySelectorAll(":scope > source")];
    return motion !== null &&
      motion.readiness === "interactiveReady" &&
      sources.length === sourceCount &&
      sources.every((source) =>
        (source.getAttribute("src") ?? "").includes(`#v=${String(expected)}`)
      ) &&
      status.includes(`Build ${String(expected)}`);
  }, { sequence, sourceCount: expectedCodecs.length }, { timeout: 30_000 });
}

async function waitForElementReady(page, expectedReadiness) {
  try {
    await page.waitForFunction((expected) => {
      const motion = document.querySelector("aval-player");
      return motion !== null && motion.readiness === expected;
    }, expectedReadiness, { timeout: 30_000 });
  } catch (error) {
    const evidence = await page.evaluate(() => {
      const motion = document.querySelector("aval-player");
      return motion === null
        ? { elementPresent: false }
        : {
            elementPresent: true,
            readiness: motion.readiness,
            staticReason: motion.staticReason,
            diagnostics: motion.getDiagnostics()
          };
    }).catch((evaluationError) => ({ evaluationError: String(evaluationError) }));
    const network = await page.evaluate(async () => {
      const motion = document.querySelector("aval-player");
      if (motion === null) return [];
      const sources = [...motion.querySelectorAll(":scope > source[src]")];
      const probe = async (source, headers) => {
        const response = await fetch(source.src, { cache: "no-store", headers });
        const bytes = (await response.arrayBuffer()).byteLength;
        return {
          source: source.src,
          sourceCodec: source.getAttribute("data-codec"),
          requestHeaders: headers,
          status: response.status,
          type: response.type,
          url: response.url,
          contentEncoding: response.headers.get("Content-Encoding"),
          contentLength: response.headers.get("Content-Length"),
          contentRange: response.headers.get("Content-Range"),
          entityTag: response.headers.get("ETag"),
          bytes
        };
      };
      return Promise.all(sources.flatMap((source) => [
        probe(source, { Range: "bytes=0-63" }),
        probe(source, {})
      ]));
    }).catch((networkError) => ({ networkError: String(networkError) }));
    throw new Error(
      `packed element did not reach ${expectedReadiness}: ${JSON.stringify({ evidence, network })}`,
      { cause: error }
    );
  }
}

async function publicSnapshot(page) {
  return page.locator("aval-player").first().evaluate((motion) => {
    const alternate = document.querySelector("#motion-unavailable");
    const alternateStyle = alternate === null ? null : getComputedStyle(alternate);
    const alternateImage = alternate instanceof HTMLImageElement ? alternate : null;
    const animatedCanvas = motion.shadowRoot?.querySelector('canvas[data-aval-layer="animated"]');
    return ({
      readiness: motion.readiness,
      staticReason: motion.staticReason,
      requestedState: motion.requestedState,
      visualState: motion.visualState,
      stateNames: [...motion.stateNames],
      sources: [...motion.querySelectorAll(":scope > source")].map((source) => ({
        src: source.getAttribute("src") ?? "",
        codec: source.getAttribute("data-codec") ?? "",
        integrity: source.getAttribute("integrity") ?? ""
      })),
      sourceGeneration: motion.getDiagnostics().sourceGeneration,
      videoCount: document.querySelectorAll("video").length,
      alternateVisible: alternate !== null && alternateStyle?.display !== "none" && alternateStyle?.visibility !== "hidden" && alternate.getBoundingClientRect().width > 0 && alternate.getBoundingClientRect().height > 0,
      alternateImageLoaded: alternateImage !== null && alternateImage.complete && alternateImage.naturalWidth > 0,
      alternateConsumerOwned: alternate !== null && alternate.parentElement !== motion,
      canvasCount: motion.shadowRoot?.querySelectorAll("canvas").length ?? 0,
      animatedCanvasHidden: animatedCanvas instanceof HTMLCanvasElement && animatedCanvas.hidden,
      fallbackSlotCount: motion.shadowRoot?.querySelectorAll('slot[name="fallback"]').length ?? 0
    });
  });
}

function isBuildEvent(value) {
  return value?.command === "dev" && value.event === "build" && Number.isSafeInteger(value.sequence);
}

function verifyBuildEvent(value) {
  assert(value.sequence >= 1, "dev build sequence was invalid");
  assert(typeof value.outputPath === "string" && value.outputPath.length > 0, "dev build output path was invalid");
  assert(value.reportPath === join(value.outputPath, "build.json"), "dev build report path was invalid");
  assert(Array.isArray(value.assets) && value.assets.length === expectedCodecs.length, "dev build did not publish exactly four codec assets");
  assert(
    Array.isArray(value.warnings) && value.warnings.every((warning) => typeof warning === "string"),
    "dev build warnings were invalid"
  );
  const codecs = new Set();
  for (let index = 0; index < expectedCodecs.length; index += 1) {
    const expectedCodec = expectedCodecs[index];
    const asset = value.assets[index];
    assert(asset !== null && typeof asset === "object", `dev build ${expectedCodec} asset was invalid`);
    assert(asset.codec === expectedCodec, `dev build codec order drifted at ${String(index)}`);
    assert(!codecs.has(asset.codec), `dev build repeated the ${expectedCodec} codec`);
    codecs.add(asset.codec);
    assert(asset.path === join(value.outputPath, `${expectedCodec}.avl`), `dev build ${expectedCodec} path was invalid`);
    assert(Number.isSafeInteger(asset.bytes) && asset.bytes > 32, `dev build ${expectedCodec} byte count was invalid`);
    assert(/^[0-9a-f]{64}$/u.test(asset.sha256), `dev build ${expectedCodec} digest was invalid`);
    assert(hasBuildAssetMetadata(asset, expectedCodec), `dev build ${expectedCodec} source metadata was invalid`);
    assert(asset.integrity === integrityForSha256(asset.sha256), `dev build ${expectedCodec} integrity did not match its digest`);
  }
}

function verifyBuildReport(report, build) {
  assert(report !== null && typeof report === "object", "served build report was invalid");
  assert(report.reportVersion === "1.0", "served build report version was invalid");
  assert(Array.isArray(report.assets) && report.assets.length === build.assets.length, "served build report asset count was invalid");
  assert(Array.isArray(report.encodings) && report.encodings.length === build.assets.length, "served build report encoding count was invalid");
  assert(
    Array.isArray(report.warnings) && JSON.stringify(report.warnings) === JSON.stringify(build.warnings),
    "served build report warnings did not match the build event"
  );
  for (let index = 0; index < build.assets.length; index += 1) {
    const published = build.assets[index];
    const reported = report.assets[index];
    assert(reported?.codec === published.codec, `served build report codec order drifted at ${String(index)}`);
    assert(reported.path === `${published.codec}.avl`, `served build report ${published.codec} path was invalid`);
    assert(reported.bytes === published.bytes, `served build report ${published.codec} byte count drifted`);
    assert(reported.sha256 === published.sha256, `served build report ${published.codec} digest drifted`);
    assert(reported.type === published.type, `served build report ${published.codec} type drifted`);
    assert(reported.integrity === published.integrity, `served build report ${published.codec} integrity drifted`);
    assert(report.encodings[index]?.codec === published.codec, `served build report ${published.codec} encoding order drifted`);
  }
  const sourceMarkup = report.assets.map((asset) =>
    `<source src="${asset.path}" data-codec="${asset.codec}" integrity="${asset.integrity}">`
  ).join("\n");
  assert(report.sourceMarkup === sourceMarkup, "served build report source markup was not canonical");
}

function verifyReplacementDigests(firstBuild, secondBuild) {
  assert(firstBuild.assets.length === secondBuild.assets.length, "watch rebuild changed the codec asset count");
  for (let index = 0; index < firstBuild.assets.length; index += 1) {
    const first = firstBuild.assets[index];
    const second = secondBuild.assets[index];
    assert(second.codec === first.codec, `watch rebuild codec order drifted at ${String(index)}`);
    assert(second.sha256 !== first.sha256, `watch rebuild retained the old ${first.codec} asset digest`);
  }
}

function snapshotUsesGeneration(snapshot, sequence) {
  return Array.isArray(snapshot.sources) &&
    snapshot.sources.length === expectedCodecs.length &&
    snapshot.sources.every((source, index) => {
      const codec = expectedCodecs[index];
      return source.src.endsWith(`${codec}.avl#v=${String(sequence)}`) &&
        hasAuthoredSourceMetadata(source, codec);
    });
}

function hasStaticBundleSources(snapshot) {
  return Array.isArray(snapshot.sources) &&
    snapshot.sources.length === expectedCodecs.length &&
    snapshot.sources.every((source, index) => {
      const codec = expectedCodecs[index];
      return source.src === `./motion/${codec}.avl` &&
        hasAuthoredSourceMetadata(source, codec);
    });
}

function hasBuildAssetMetadata(source, codec) {
  if (typeof source?.type !== "string" || typeof source.integrity !== "string") return false;
  const codecString = /^application\/vnd\.aval; codecs="([^"]+)"$/u.exec(source.type)?.[1];
  return codecString?.startsWith(expectedCodecPrefixes[codec]) === true &&
    /^sha256-[A-Za-z0-9+/]{43}=$/u.test(source.integrity);
}

function hasAuthoredSourceMetadata(source, codec) {
  return source?.codec === codec &&
    typeof source.integrity === "string" &&
    /^sha256-[A-Za-z0-9+/]{43}=$/u.test(source.integrity);
}

function integrityForSha256(value) {
  return `sha256-${Buffer.from(value, "hex").toString("base64")}`;
}

function createJsonLineCollector(stream, label, stderr) {
  const records = [];
  const waiters = new Set();
  let buffer = "";
  let transcript = "";
  let totalBytes = 0;
  let failure;
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    totalBytes += Buffer.byteLength(chunk);
    if (totalBytes > 4 * 1024 * 1024) {
      fail(new Error(`${label} exceeded 4 MiB`));
      return;
    }
    transcript += chunk;
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim() === "") continue;
      try {
        emit(JSON.parse(line));
      } catch (error) {
        fail(new Error(`${label} emitted invalid JSON: ${line}`, { cause: error }));
      }
    }
  });

  function emit(value) {
    if (value?.severity === "error") {
      fail(devDiagnosticError(value));
      return;
    }
    records.push(value);
    if (records.length > 128) records.shift();
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(value)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    }
  }

  function fail(error) {
    if (failure !== undefined) return;
    failure = withCollectedOutput(error, transcript, stderr());
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(failure);
    }
    waiters.clear();
  }

  return Object.freeze({
    fail,
    waitFor(predicate, timeoutMs) {
      const existing = records.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      if (failure !== undefined) return Promise.reject(failure);
      return new Promise((resolveWait, rejectWait) => {
        const waiter = {
          predicate,
          resolve: resolveWait,
          reject: rejectWait,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            rejectWait(withCollectedOutput(
              new Error(`${label} did not emit the expected record in ${String(timeoutMs)} ms`),
              transcript,
              stderr()
            ));
          }, timeoutMs)
        };
        waiters.add(waiter);
      });
    }
  });
}

function createJsonErrorMonitor(onError) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === "") continue;
      try {
        const value = JSON.parse(line);
        if (value?.severity === "error") onError(value);
      } catch {
        // The child can emit platform diagnostics that are not CLI JSON.
      }
    }
  };
}

function devDiagnosticError(diagnostic) {
  return new Error(
    `packed avl dev reported ${String(diagnostic.code ?? "an error")}: ` +
    `${String(diagnostic.message ?? "no diagnostic message")}`
  );
}

function withCollectedOutput(error, stdout, stderr) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `${message}\n\nCollected stdout:\n${diagnosticExcerpt(stdout)}` +
    `\n\nCollected stderr:\n${diagnosticExcerpt(stderr)}`,
    { cause: error }
  );
}

function diagnosticExcerpt(value) {
  const maximum = 32 * 1024;
  if (value.length <= maximum) return value === "" ? "<empty>" : value;
  return `<truncated ${String(value.length - maximum)} leading characters>\n` +
    value.slice(-maximum);
}

async function checkedFetch(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
}

async function checkedJson(url) {
  const response = await checkedFetch(url);
  assert(response.status === 200, `${url} returned ${response.status}`);
  return response.json();
}

async function closePreview(server) {
  await new Promise((resolveClose, rejectClose) => {
    server.httpServer.close((error) => error === undefined ? resolveClose() : rejectClose(error));
  });
}

async function readTextTree(directory) {
  let text = "";
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) text += await readTextTree(path);
    else if (entry.isFile() && /\.(?:css|html|js)$/u.test(entry.name)) {
      text = boundedAppend(text, await readFile(path, "utf8"), 8 * 1024 * 1024, "starter build text");
    }
  }
  return text;
}

function assertNoFilesystemLeak(text, forbiddenPaths) {
  assert(!text.includes("file://"), "browser-visible dev content exposed a file URL");
  for (const path of forbiddenPaths) {
    assert(!text.includes(path), `browser-visible dev content exposed ${path}`);
  }
}

function run(command, arguments_, cwd, timeout) {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${arguments_.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
}

function boundedAppend(current, chunk, limit, label) {
  const result = current + chunk;
  if (Buffer.byteLength(result) > limit) throw new Error(`${label} exceeded its bound`);
  return result;
}

async function withTimeout(promise, milliseconds, message, reject = true) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolveTimeout, rejectTimeout) => {
        timer = setTimeout(
          () => reject ? rejectTimeout(new Error(message)) : resolveTimeout(undefined),
          milliseconds
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
