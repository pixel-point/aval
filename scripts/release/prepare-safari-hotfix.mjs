#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const destination = join(root, "artifacts/safari-hotfix/1.0.3");
const packages = [
  {
    name: "@pixel-point/aval-element",
    baseline: "1.0.2",
    integrity: "sha512-qJd/3W8MsYRiPeCOTScRRjWH2OBMmRolKARbL9qglxSdSSrj23jHdhV37EfurabPaowubAlnV1zGH7fJ3Id4vg==",
    changes: ["package.json", "dist/adapter-binding.js"],
    patch: patchElement
  },
  {
    name: "@pixel-point/aval-svelte",
    baseline: "1.0.2",
    integrity: "sha512-MwG/bDY4VCIhBSh72bELs8xJWrvR86gcLT0EXTHIxgHzjVXgYqy2KEilMxVJAAyrf32Y1rBVNgDAeHs5Lrqqzg==",
    changes: ["package.json", "dist/controller.js", "dist/controller.d.ts", "dist/index.js", "dist/lazy.js"],
    patch: patchSvelte
  }
];

if (await exists(destination)) throw new Error(`Immutable release output already exists: ${destination}`);
const work = await mkdtemp(join(tmpdir(), "aval-safari-hotfix-"));
try {
  const reports = [];
  for (const specification of packages) {
    const download = join(work, "download", shortName(specification.name));
    const staging = join(work, "staging", shortName(specification.name));
    const first = join(work, "first", shortName(specification.name));
    const second = join(work, "second", shortName(specification.name));
    await Promise.all([download, staging, first, second].map((path) => mkdir(path, { recursive: true })));

    const baselinePack = pack(`${specification.name}@${specification.baseline}`, download);
    const baselineArchive = join(download, baselinePack.filename);
    const baselineBytes = await readFile(baselineArchive);
    const integrity = `sha512-${createHash("sha512").update(baselineBytes).digest("base64")}`;
    if (integrity !== specification.integrity) throw new Error(`${specification.name} baseline integrity changed`);
    run("tar", ["-xzf", baselineArchive, "-C", staging]);
    const packageRoot = join(staging, "package");
    const before = await fileHashes(packageRoot);
    const manifestPath = join(packageRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.name !== specification.name || manifest.version !== specification.baseline) {
      throw new Error(`${specification.name} baseline identity changed`);
    }
    manifest.version = "1.0.3";
    if (specification.name === "@pixel-point/aval-svelte") {
      if (manifest.dependencies?.["@pixel-point/aval-element"] !== "1.0.2") throw new Error("Svelte baseline dependency changed");
      manifest.dependencies["@pixel-point/aval-element"] = "1.0.3";
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await specification.patch(packageRoot);
    const after = await fileHashes(packageRoot);
    const changed = [...after.keys()].filter((path) => after.get(path) !== before.get(path)).sort();
    if (JSON.stringify(changed) !== JSON.stringify([...specification.changes].sort())) {
      throw new Error(`${specification.name} changed unexpected files: ${changed.join(", ")}`);
    }

    const firstPack = pack(packageRoot, first);
    const secondPack = pack(packageRoot, second);
    if (firstPack.filename !== secondPack.filename) throw new Error(`${specification.name} archive names differ`);
    const firstBytes = await readFile(join(first, firstPack.filename));
    const secondBytes = await readFile(join(second, secondPack.filename));
    if (!firstBytes.equals(secondBytes)) throw new Error(`${specification.name} archive is not reproducible`);
    if (JSON.stringify(archiveFiles(baselineArchive)) !== JSON.stringify(archiveFiles(join(first, firstPack.filename)))) {
      throw new Error(`${specification.name} archive file set changed`);
    }
    reports.push({
      name: specification.name,
      version: "1.0.3",
      baseline: `${specification.name}@${specification.baseline}`,
      baselineIntegrity: integrity,
      filename: firstPack.filename,
      integrity: `sha512-${createHash("sha512").update(firstBytes).digest("base64")}`,
      sha256: createHash("sha256").update(firstBytes).digest("hex"),
      changedFiles: changed
    });
    await mkdir(destination, { recursive: true });
    await copyFile(join(first, firstPack.filename), join(destination, firstPack.filename));
  }
  await writeFile(join(destination, "package-index.json"), `${JSON.stringify({ version: "1.0.3", packages: reports }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output: destination, packages: reports }, null, 2)}\n`);
} catch (error) {
  await rm(destination, { recursive: true, force: true });
  throw error;
} finally {
  await rm(work, { recursive: true, force: true });
}

async function patchElement(packageRoot) {
  const path = join(packageRoot, "dist/adapter-binding.js");
  await replaceOnce(path, `            if (typeof element.getSnapshot !== "function" ||
                typeof element.subscribe !== "function") {
                throw new TypeError("Registered aval-player does not implement the required snapshot API");
            }`, `            if (!hasSnapshotApi(element)) {
                customElements.upgrade(node);
                if (!hasSnapshotApi(element)) {
                    throw new TypeError("Registered aval-player does not implement the required snapshot API");
                }
            }`);
  await replaceOnce(path, `function unmountedStatus() {`, `function hasSnapshotApi(element) {
    return typeof element.getSnapshot === "function" &&
        typeof element.subscribe === "function";
}
function unmountedStatus() {`);
}

async function patchSvelte(packageRoot) {
  const controller = join(packageRoot, "dist/controller.js");
  await replaceOnce(controller, `createAvalFactory(createConfiguration, createBinding)`, `createAvalFactory(createConfiguration, createBinding, defineAvalElement)`);
  await replaceOnce(controller, `            throw new TypeError("createAval requires an option getter");
        }
        const readConfiguration`, `            throw new TypeError("createAval requires an option getter");
        }
        if (typeof globalThis.customElements !== "undefined")
            defineAvalElement();
        const readConfiguration`);
  const declaration = join(packageRoot, "dist/controller.d.ts");
  await replaceOnce(declaration, `createAvalFactory(createConfiguration: CreateConfiguration, createBinding: CreateBinding): CreateAval`, `createAvalFactory(createConfiguration: CreateConfiguration, createBinding: CreateBinding, defineAvalElement: () => unknown): CreateAval`);
  for (const [entry, elementImport] of [
    ["index.js", "@pixel-point/aval-element"],
    ["lazy.js", "@pixel-point/aval-element/lazy"]
  ]) {
    const path = join(packageRoot, "dist", entry);
    await replaceOnce(path, `import { createAvalFactory } from "./controller.js";`, `import { createAvalFactory } from "./controller.js";
import { defineAvalElement } from "${elementImport}";`);
    await replaceOnce(path, `createAvalFactory(createAvalAdapterConfiguration, createAvalAdapterBinding)`, `createAvalFactory(createAvalAdapterConfiguration, createAvalAdapterBinding, defineAvalElement)`);
  }
}

async function replaceOnce(path, original, replacement) {
  const content = await readFile(path, "utf8");
  if (content.split(original).length !== 2) throw new Error(`Patch anchor missing or repeated: ${path}`);
  await writeFile(path, content.replace(original, replacement));
}

async function fileHashes(directory, prefix = "") {
  const result = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, hash] of await fileHashes(path, relative)) result.set(name, hash);
    } else if (entry.isFile()) {
      result.set(relative, createHash("sha256").update(await readFile(path)).digest("hex"));
    } else throw new Error(`Unexpected archive entry: ${relative}`);
  }
  return result;
}

function pack(specification, directory) {
  const report = JSON.parse(run("npm", ["pack", specification, "--json", "--ignore-scripts", "--pack-destination", directory]));
  if (!Array.isArray(report) || report.length !== 1 || typeof report[0]?.filename !== "string") throw new Error("Unexpected npm pack report");
  return report[0];
}

function archiveFiles(path) {
  return run("tar", ["-tzf", path]).trim().split("\n").sort();
}

function shortName(name) { return name.slice("@pixel-point/aval-".length); }

async function exists(path) { try { await stat(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 120_000 });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}
