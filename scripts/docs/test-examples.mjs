#!/usr/bin/env node
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { RELEASE_PACKAGE_NAMES, releaseArchiveFilename } from "../release/release-set-model.mjs";
import { packInstalledClosure } from "../release/local-package-archives.mjs";

const directoryIndex = process.argv.indexOf("--packages");
const packageDirectory = resolve(directoryIndex < 0 ? "artifacts/1.0.0/packages" : process.argv[directoryIndex + 1]);
const archiveNames = (await readdir(packageDirectory)).filter((name) => name.endsWith(".tgz")).sort();
const expectedArchiveNames = RELEASE_PACKAGE_NAMES.map((name) => releaseArchiveFilename(name)).sort();
if (JSON.stringify(archiveNames) !== JSON.stringify(expectedArchiveNames)) throw new Error("example test requires the exact public-package candidate set");
const archives = archiveNames.map((name) => join(packageDirectory, name));
const examples = ["zero-config-loop", "idle-hover-states", "network-integrity", "plain-html"];
const temporary = await mkdtemp(join(tmpdir(), "aval-examples-"));
try {
  const peerDirectory = join(temporary, "peers");
  const reactPeerArchives = await packInstalledClosure({
    root: resolve("."),
    destination: peerDirectory,
    packages: ["react", "@types/react"]
  });
  for (const name of examples) {
    const target = join(temporary, name);
    await cp(resolve("examples", name), target, { recursive: true });
    const manifestPath = join(target, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.devDependencies?.vite !== "8.1.4") {
      throw new Error(`${name} does not pin the reviewed Vite toolchain`);
    }
    delete manifest.devDependencies;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--offline", "--cache", join(temporary, "npm-cache"), ...reactPeerArchives, ...archives], target, 120_000);
    run(process.execPath, [resolve("node_modules/vite/bin/vite.js"), "build"], target, 60_000);
  }
  run(process.execPath, [
    resolve("examples/react-ref/scripts/verify-packed.mjs"),
    "--packages",
    packageDirectory
  ], resolve("."), 300_000);
  process.stdout.write(`${JSON.stringify({
    status: "passed",
    examples: [...examples, "react-ref"]
  })}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
function run(command, args, cwd, timeout) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
}
