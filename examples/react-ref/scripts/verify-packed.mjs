#!/usr/bin/env node

import { cp, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const example = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesFlag = process.argv.indexOf("--packages");
if (packagesFlag < 0 || process.argv[packagesFlag + 1] === undefined) {
  throw new Error("usage: verify-packed.mjs --packages <package-archive-directory>");
}
const packageDirectory = resolve(process.cwd(), process.argv[packagesFlag + 1]);
const packageJson = JSON.parse(await readFile(join(example, "package.json"), "utf8"));
if (
  packageJson.peerDependencies?.["@pixel-point/aval-react"] !== "1.0.0" ||
  packageJson.peerDependenciesMeta?.["@pixel-point/aval-react"]?.optional !== true
) {
  throw new Error("React example must target the exact optional React 1.0.0 peer");
}

const archives = (await readdir(packageDirectory))
  .filter((name) => name.endsWith(".tgz"))
  .sort()
  .map((name) => join(packageDirectory, name));
if (!archives.some((path) => basename(path) === "pixel-point-aval-element-1.0.0.tgz")) {
  throw new Error("packed React verification requires the element archive");
}
if (!archives.some((path) => basename(path) === "pixel-point-aval-react-1.0.0.tgz")) {
  throw new Error("packed React verification requires the React archive");
}

const temporary = await mkdtemp(join(tmpdir(), "aval-react-example-"));
const target = join(temporary, "example");
try {
  await cp(example, target, {
    recursive: true,
    filter: (source) => {
      const relative = source.slice(example.length).replace(/^\//u, "");
      return relative !== "node_modules" &&
        !relative.startsWith("node_modules/") &&
        relative !== "dist" &&
        !relative.startsWith("dist/");
    }
  });
  run("npm", [
    "ci",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund"
  ], target, 120_000);
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-save",
    "--no-package-lock",
    ...archives
  ], target, 120_000);
  const installedElement = JSON.parse(await readFile(
    join(target, "node_modules", "@pixel-point", "aval-element", "package.json"),
    "utf8"
  ));
  if (installedElement.version !== "1.0.0") {
    throw new Error(`React example installed element ${String(installedElement.version)}, expected 1.0.0`);
  }
  const installedReact = JSON.parse(await readFile(
    join(target, "node_modules", "@pixel-point", "aval-react", "package.json"),
    "utf8"
  ));
  if (installedReact.version !== "1.0.0") {
    throw new Error(`React example installed adapter ${String(installedReact.version)}, expected 1.0.0`);
  }
  run("npm", ["run", "typecheck"], target, 60_000);
  run("npm", ["run", "build"], target, 60_000);
  const builtIndex = join(target, "dist/index.html");
  if (!(await stat(builtIndex)).isFile()) {
    throw new Error("React example production build did not emit index.html");
  }
  process.stdout.write(`${JSON.stringify({
    status: "passed",
    elementVersion: installedElement.version,
    reactAdapterVersion: installedReact.version,
    archives: archives.length,
    typecheck: "passed",
    build: "passed"
  })}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
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
    throw new Error([
      `${command} ${arguments_.join(" ")} failed`,
      result.stdout,
      result.stderr
    ].join("\n"));
  }
}
