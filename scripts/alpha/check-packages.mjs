import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { checkCoreConsumer } from "./check-core-consumer.mjs";
import { packInstalledClosure } from "../release/local-package-archives.mjs";

const root = process.cwd(), artifacts = resolve(".cache/alpha");
await mkdir(artifacts, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "aval-alpha-consumers-"));
const run = (command, args, cwd = root) => {
  try { return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }); }
  catch (error) { throw new Error(`${command} failed:\n${error.stdout}\n${error.stderr}`, { cause: error }); }
};
try {
  const packages = [];
  for (const name of ["aval-alpha", "aval-alpha-react", "aval-alpha-svelte"]) {
    const packed = JSON.parse(run("npm", ["pack", "--workspace", `@pixel-point/${name}`, "--pack-destination", artifacts,
      "--ignore-scripts", "--cache", join(temporary, "npm-cache"), "--json"]))[0];
    if (packed.files.some(({ path }) => !/^(?:dist\/.*\.(?:js|d\.ts|svelte)|README\.md|LICENSE|package\.json)$/u.test(path))) throw Error(`Unexpected payload in ${name}`);
    if (!packed.files.some(({ path }) => path === "README.md")) throw Error(`Missing README in ${name}`);
    packages.push(packed);
  }
  await writeFile(join(artifacts, "pack.json"), JSON.stringify(packages[0], null, 2) + "\n");
  await checkCoreConsumer(packages[0], artifacts, join(temporary, "core-only"), run);
  const coreManifest = JSON.parse(await readFile("packages/alpha/package.json", "utf8"));
  // Reuse the repository's offline consumer helper, including exact peer closures.
  const peers = await packInstalledClosure({ root, destination: join(temporary, "peers"), packages: ["react", "react-dom", "@types/react", "@types/react-dom", "svelte"] });
  await writeFile(join(temporary, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run("npm", ["install", "--ignore-scripts", "--no-package-lock", "--offline", "--legacy-peer-deps", "--cache", join(temporary, "npm-cache"),
    "--no-audit", "--no-fund", ...peers, ...packages.map(({ filename }) => join(artifacts, filename))], temporary);
  for (const name of ["aval-alpha-react", "aval-alpha-svelte"]) {
    const manifest = JSON.parse(await readFile(join(temporary, `node_modules/@pixel-point/${name}/package.json`), "utf8"));
    if (Object.keys(manifest.dependencies ?? {}).length !== 1 || manifest.dependencies[coreManifest.name] !== coreManifest.version) throw Error(`Unexpected runtime dependencies in ${name}`);
  }
  await writeFile(join(temporary, "consumer.ts"), `
import {createElement} from 'react';
import {useAvalAlpha, type AlphaSource} from '@pixel-point/aval-alpha-react';
import {createAvalAlpha, AvalAlphaComponent} from '@pixel-point/aval-alpha-svelte';
import {createAlphaBinding, createAlphaConfiguration} from '@pixel-point/aval-alpha/adapter';
const sources: readonly AlphaSource[] = [];
export function ReactConsumer() {
  const {alpha, AvalAlphaComponent} = useAvalAlpha({sources, onReady(source) { source.alphaRect; }});
  const status: string = alpha.status; void status;
  return createElement(AvalAlphaComponent, {width:128, height:96, 'aria-label':'Motion'});
}
export const svelteController = createAvalAlpha(() => ({sources}));
export const binding = createAlphaBinding(createAlphaConfiguration({sources}));
export {AvalAlphaComponent};
`);
  run(resolve("node_modules/.bin/tsc"), ["--noEmit", "--strict", "--skipLibCheck", "--moduleResolution", "bundler", "--module", "esnext", "--target", "es2022", "consumer.ts"], temporary);
  run("node", ["--input-type=module", "-e", "await import('@pixel-point/aval-alpha/adapter'); await import('@pixel-point/aval-alpha-react');"], temporary);
  await writeFile(join(temporary, "server.ts"), `
import {createElement} from 'react';
import {renderToString} from 'react-dom/server';
import {render} from 'svelte/server';
import {ReactConsumer, svelteController, AvalAlphaComponent} from './consumer.js';
const react = renderToString(createElement(ReactConsumer));
const svelte = render(AvalAlphaComponent, {props:{alpha:svelteController}}).body;
for (const html of [react,svelte]) if (!html.includes('<canvas') || html.includes('<video')) throw Error('Invalid SSR markup');
console.log('Packed React and Svelte SSR passed');
`);
  await build({ configFile: false, root: temporary, logLevel: "silent", plugins: [svelte({ configFile: false })],
    ssr: { noExternal: ["@pixel-point/aval-alpha-svelte"] },
    build: { ssr: join(temporary, "server.ts"), outDir: join(temporary, "server"), rollupOptions: { output: { entryFileNames: "server.mjs" } } } });
  run("node", ["server/server.mjs"], temporary);
  const client = await build({ configFile: false, root: temporary, logLevel: "silent", plugins: [svelte({ configFile: false })],
    build: { write: false, lib: { entry: join(temporary, "consumer.ts"), formats: ["es"] } } });
  for (const output of (Array.isArray(client) ? client : [client]).flatMap((result) => result.output)) {
    if (output.type !== "chunk") throw Error("Unexpected packed consumer resource");
    if (output.imports.length || output.dynamicImports.length) throw Error("Packed consumer has unresolved downloads");
    for (const module of Object.keys(output.modules)) if (module.includes("@pixel-point/") && !/\/aval-alpha(?:-react|-svelte)?\//u.test(module)) throw Error(`Unexpected AVAL module: ${module}`);
  }
  const report = { status: "passed", packages: packages.map(({ filename, size }) => ({ filename, tarballBytes: size })),
    checks: ["core install without framework peers", "offline isolated install", "exact installed peers", "public declarations", "SSR imports and rendering", "production browser bundle", "no interactive AVAL dependencies"] };
  await writeFile(join(artifacts, "framework-pack.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }
