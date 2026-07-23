import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const MAXIMUM_CLOSURE_PACKAGES = 256;
const MAXIMUM_MANIFEST_BYTES = 1024 * 1024;

/** Pack named installed packages and the complete closure of their declared dependencies. */
export async function packInstalledClosure({ root, destination, packages }) {
  if (!Array.isArray(packages) || packages.length === 0 || packages.length > MAXIMUM_CLOSURE_PACKAGES) throw new TypeError("installed package closure roots are invalid");
  const repository = resolve(root);
  const installedRoot = await realpath(join(repository, "node_modules"));
  const archiveRoot = resolve(destination);
  await mkdir(archiveRoot, { recursive: true });
  const archiveRootInfo = await lstat(archiveRoot);
  if (!archiveRootInfo.isDirectory() || archiveRootInfo.isSymbolicLink()) throw new Error("local package archive destination must be a regular directory");

  const pending = packages.map(validatePackageName);
  const packed = new Map();
  while (pending.length > 0) {
    const name = pending.shift();
    if (packed.has(name)) continue;
    if (packed.size >= MAXIMUM_CLOSURE_PACKAGES) throw new Error("installed package dependency closure exceeds its bound");
    const manifest = await readInstalledManifest(installedRoot, name);
    const archive = packLocalDependency({ repository, source: manifest.directory, destination: archiveRoot, manifest });
    packed.set(name, archive);
    for (const dependency of Object.keys(manifest.dependencies)) pending.push(validatePackageName(dependency));
  }
  return Object.freeze([...packed.values()]);
}

async function readInstalledManifest(installedRoot, name) {
  const packagePath = join(installedRoot, ...packageNameSegments(name));
  const packageInfo = await lstat(packagePath);
  if (!packageInfo.isDirectory() || packageInfo.isSymbolicLink()) throw new Error(`installed package must be a regular directory: ${name}`);
  const directory = await realpath(packagePath);
  assertContained(installedRoot, directory, `installed package escapes node_modules: ${name}`);
  const manifestPath = join(directory, "package.json");
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size < 2 || manifestInfo.size > MAXIMUM_MANIFEST_BYTES) throw new Error(`installed package manifest is not a bounded regular file: ${name}`);
  const parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || parsed.name !== name || typeof parsed.version !== "string" || parsed.version.length < 1) throw new Error(`installed package manifest identity is invalid: ${name}`);
  const dependencies = parsed.dependencies ?? {};
  if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) throw new Error(`installed package dependencies are invalid: ${name}`);
  for (const [dependency, version] of Object.entries(dependencies)) {
    validatePackageName(dependency);
    if (typeof version !== "string" || version.length < 1 || version.length > 512) throw new Error(`installed dependency range is invalid: ${name} -> ${dependency}`);
  }
  return Object.freeze({ name, version: parsed.version, directory, dependencies: Object.freeze({ ...dependencies }) });
}

function packLocalDependency({ repository, source, destination, manifest }) {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", [
    "pack",
    "--json",
    "--ignore-scripts",
    "--cache",
    join(destination, ".npm-cache"),
    "--pack-destination",
    destination,
    source
  ], {
    cwd: repository,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  if (
    !Array.isArray(report) || report.length !== 1 ||
    report[0]?.name !== manifest.name || report[0]?.version !== manifest.version ||
    typeof report[0]?.filename !== "string" || basename(report[0].filename) !== report[0].filename
  ) throw new Error(`npm pack returned an unexpected report for ${manifest.name}`);
  return join(destination, report[0].filename);
}

function validatePackageName(value) {
  packageNameSegments(value);
  return value;
}

function packageNameSegments(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 214 || value.includes("\\")) throw new TypeError(`installed package name is invalid: ${String(value)}`);
  const segments = value.split("/");
  const scoped = value.startsWith("@");
  if (segments.length !== (scoped ? 2 : 1)) throw new TypeError(`installed package name is invalid: ${value}`);
  const names = scoped ? [segments[0].slice(1), segments[1]] : segments;
  if (names.some((segment) => !/^[a-z0-9][a-z0-9._-]*$/u.test(segment))) throw new TypeError(`installed package name is invalid: ${value}`);
  return scoped ? [`@${names[0]}`, names[1]] : names;
}

function assertContained(root, path, message) {
  const within = relative(root, path);
  if (within === "" || within === ".." || within.startsWith(`..${sep}`)) throw new Error(message);
}
