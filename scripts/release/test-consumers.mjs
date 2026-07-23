#!/usr/bin/env node
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { RELEASE_PACKAGE_NAMES, releaseArchiveFilename } from "./release-set-model.mjs";
import { packInstalledClosure } from "./local-package-archives.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const directoryIndex = process.argv.indexOf("--packages");
const packageDirectory = resolve(root, directoryIndex < 0 ? "artifacts/1.0.0/packages" : process.argv[directoryIndex + 1]);
const archiveNames = (await readdir(packageDirectory)).filter((name) => name.endsWith(".tgz")).sort();
const expectedArchiveNames = RELEASE_PACKAGE_NAMES.map((name) => releaseArchiveFilename(name)).sort();
if (JSON.stringify(archiveNames) !== JSON.stringify(expectedArchiveNames)) throw new Error(`expected the exact public package archives, found ${JSON.stringify(archiveNames)}`);
const archives = archiveNames.map((name) => join(packageDirectory, name));
const temporary = await mkdtemp(join(tmpdir(), "aval-consumers-"));
try {
  const peerDirectory = join(temporary, "peers");
  const reactPeerArchives = await packInstalledClosure({
    root,
    destination: peerDirectory,
    packages: ["react", "@types/react"]
  });
  const expectedReact = JSON.parse(await readFile(resolve(root, "node_modules/react/package.json"), "utf8"));
  for (const fixture of ["node-esm", "typescript-nodenext", "typescript-bundler", "browser-vite"]) {
    const target = join(temporary, fixture);
    await cp(resolve(root, "tests/consumers", fixture), target, { recursive: true });
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--offline", "--cache", join(temporary, "npm-cache"), ...reactPeerArchives, ...archives], target, 120_000);
    const installedReact = JSON.parse(await readFile(join(target, "node_modules/react/package.json"), "utf8"));
    if (installedReact.version !== expectedReact.version) throw new Error(`packed consumer React peer version drifted: ${String(installedReact.version)}`);
    if (fixture === "node-esm") run(process.execPath, ["index.mjs"], target, 30_000);
    else if (fixture === "browser-vite") run(process.execPath, [resolve(root, "node_modules/vite/bin/vite.js"), "build"], target, 60_000);
    else run(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], target, 60_000);
  }
  const compilerArchive = archives.find((path) => basename(path).includes("compiler"));
  if (compilerArchive === undefined) throw new Error("compiler archive is missing");
  const cliRoot = join(temporary, "cli");
  await cp(resolve(root, "tests/consumers/node-esm"), cliRoot, { recursive: true });
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--offline", "--cache", join(temporary, "npm-cache"), ...reactPeerArchives, ...archives], cliRoot, 120_000);
  const cli = resolve(cliRoot, "node_modules/@pixel-point/aval-compiler/dist/cli.js");
  run(process.execPath, [cli, "--help"], cliRoot, 30_000);
  const invalid = spawnSync(process.execPath, [cli, "validate", "missing.avl"], { cwd: cliRoot, encoding: "utf8", timeout: 30_000 });
  if (invalid.error !== undefined) throw invalid.error;
  if (invalid.status === 0) {
    throw new Error(`compiler CLI accepted a missing input:\n${invalid.stdout}\n${invalid.stderr}`);
  }
  process.stdout.write(`${JSON.stringify({ status: "passed", consumers: 5 })}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function run(command, args, cwd, timeout) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed in ${cwd}:\n${result.stdout}\n${result.stderr}`);
}
