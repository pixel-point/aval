#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseline = process.argv.includes("--baseline");
const releaseRoot = join(root, "artifacts/safari-hotfix/1.0.3");
const index = baseline ? null : JSON.parse(await readFile(join(releaseRoot, "package-index.json"), "utf8"));
if (!baseline && (index.version !== "1.0.3" || index.packages?.length !== 2)) throw new Error("Safari hotfix package index is invalid");
const work = await mkdtemp(join(tmpdir(), "aval-safari-consumer-"));
let preview;
try {
  await writeFile(join(work, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock",
    "svelte@5.56.8", "vite@8.1.4", "@sveltejs/vite-plugin-svelte@7.2.0", "typescript@6.0.3", "svelte-check@4.7.4",
    ...(baseline
      ? ["@pixel-point/aval-element@1.0.2", "@pixel-point/aval-svelte@1.0.2"]
      : index.packages.map((entry) => join(releaseRoot, entry.filename)))], work);

  await writeFile(join(work, "vite.config.js"), `import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
export default defineConfig({
  plugins: [svelte()],
  build: { rollupOptions: { input: ["eager.html", "lazy.html", "template-eager.html", "template-lazy.html", "disconnected.html"] } }
});
`);
  for (const kind of ["eager", "lazy"]) {
    const importPath = kind === "eager" ? "@pixel-point/aval-svelte" : "@pixel-point/aval-svelte/lazy";
    await writeFile(join(work, `${kind}.html`), `<!doctype html><html><body><div id="app"></div><script type="module" src="/${kind}.js"></script></body></html>`);
    await writeFile(join(work, `${kind}.svelte`), `<script>
  import { AvalComponent, createAval } from "${importPath}";
  const aval = createAval(() => ({ sources: { h264: "/missing-motion.avl" }, autoplay: false, autoBind: false }));
</script>
<AvalComponent {aval} data-testid="player" />
<output data-testid="readiness">{$aval.readiness}</output>
`);
    await writeFile(join(work, `${kind}.js`), `import { mount } from "svelte";
import App from "./${kind}.svelte";
mount(App, { target: document.querySelector("#app") });
`);
  }
  for (const kind of ["eager", "lazy"]) {
    const importPath = kind === "eager" ? "@pixel-point/aval-svelte" : "@pixel-point/aval-svelte/lazy";
    await writeFile(join(work, `template-${kind}.html`), `<!doctype html><html><body><script type="module" src="/template-${kind}.js"></script></body></html>`);
    await writeFile(join(work, `template-${kind}.js`), `import { createAval } from "${importPath}";
import { createAvalAdapterBinding, createAvalAdapterConfiguration } from "@pixel-point/aval-element/adapter";
createAval(() => ({ sources: { h264: "/missing-motion.avl" }, autoplay: false, autoBind: false }));
const template = document.createElement("template");
template.innerHTML = "<aval-player></aval-player>";
const node = document.importNode(template.content, true).firstElementChild;
document.body.append(node);
const binding = createAvalAdapterBinding(createAvalAdapterConfiguration({ sources: { h264: "/missing-motion.avl" }, autoplay: false, autoBind: false }));
const output = document.createElement("output");
output.dataset.testid = "result";
try {
  binding.attach(node);
  output.textContent = typeof node.getSnapshot === "function" ? "attached" : "missing snapshot API";
} catch (error) { output.textContent = error.message; }
document.body.append(output);
`);
  }
  await writeFile(join(work, "disconnected.html"), `<!doctype html><html><body><script type="module" src="/disconnected.js"></script></body></html>`);
  await writeFile(join(work, "tsconfig.json"), `${JSON.stringify({ compilerOptions: {
    target: "ES2022", module: "ESNext", moduleResolution: "Bundler", allowJs: true,
    checkJs: false, strict: true, skipLibCheck: true
  }, include: ["*.svelte", "*.js"] }, null, 2)}\n`);
  await writeFile(join(work, "disconnected.js"), `import { createAvalAdapterBinding, createAvalAdapterConfiguration } from "@pixel-point/aval-element/adapter";
customElements.get("aval-player");
const template = document.createElement("template");
template.innerHTML = "<aval-player></aval-player>";
const node = document.importNode(template.content, true).firstElementChild;
const binding = createAvalAdapterBinding(createAvalAdapterConfiguration({ sources: { h264: "/missing-motion.avl" }, autoplay: false, autoBind: false }));
const output = document.createElement("output");
output.dataset.testid = "result";
try {
  binding.attach(node);
  output.textContent = typeof node.getSnapshot === "function" ? "attached" : "missing snapshot API";
} catch (error) { output.textContent = error.message; }
document.body.append(output);
`);

  run(join(work, "node_modules/.bin/svelte-check"), ["--tsconfig", "tsconfig.json"], work);
  run(join(work, "node_modules/.bin/vite"), ["build", "--logLevel", "error"], work);
  const port = await unusedPort();
  preview = spawn(join(work, "node_modules/.bin/vite"), ["preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: work, stdio: "ignore" });
  const origin = `http://127.0.0.1:${port}`;
  await waitForServer(origin);
  const results = [];
  for (const [name, browserType] of baseline ? [["webkit", webkit]] : [["chromium", chromium], ["webkit", webkit]]) {
    const browser = await browserType.launch();
    try {
      for (const pageName of baseline ? ["template-eager"] : ["eager", "lazy", "template-eager", "template-lazy", "disconnected"]) {
        const page = await browser.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${origin}/${pageName}.html`);
        if (pageName === "disconnected" || pageName.startsWith("template-")) {
          await page.locator('[data-testid="result"]').waitFor();
          const result = await page.locator('[data-testid="result"]').textContent();
          if (result !== "attached") throw new Error(`${name} ${pageName} attach failed: ${result}`);
        } else {
          const player = page.locator('[data-testid="player"]');
          await player.waitFor({ state: "attached" });
          const api = await player.evaluate((node) => ({
            getSnapshot: typeof node.getSnapshot,
            subscribe: typeof node.subscribe,
            autoplay: node.getAttribute("autoplay")
          }));
          if (api.getSnapshot !== "function" || api.subscribe !== "function" || api.autoplay !== "manual") {
            throw new Error(`${name} ${pageName} player did not upgrade: ${JSON.stringify(api)}`);
          }
          const readiness = await page.locator('[data-testid="readiness"]').textContent();
          if (!readiness) throw new Error(`${name} ${pageName} controller has no readiness`);
        }
        if (errors.length > 0) throw new Error(`${name} ${pageName} page error: ${errors.join("; ")}`);
        results.push(`${name}:${pageName}`);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
  process.stdout.write(`${JSON.stringify({ status: "passed", version: baseline ? "1.0.2" : "1.0.3", checks: results }, null, 2)}\n`);
} finally {
  if (preview !== undefined) preview.kill("SIGTERM");
  await rm(work, { recursive: true, force: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 120_000 });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not reserve preview port");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForServer(origin) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(`${origin}/eager.html`)).ok) return; } catch { /* Starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Vite preview did not start");
}
