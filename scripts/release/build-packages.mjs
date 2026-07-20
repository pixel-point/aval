#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { inspectTarballBytes } from "./inspect-tarball.mjs";
import { prepareImmutableReleaseSetOutput } from "./immutable-release-output.mjs";
import { createPublishManifest } from "./publish-manifest.mjs";
import { validateApprovedPublicationMetadata } from "./publication-metadata.mjs";
import { buildFreshPublicDistributions } from "./fresh-public-build.mjs";
import { computeReleaseSetDigest, loadVerifiedReleaseSet, releasePackageDirectory, releaseSetSummary, validateReleasePackageManifests, validateReleasePolicy } from "./release-set.mjs";
import { assertTestOnlyArchiveOutput, testOnlyPublicationMetadata } from "./test-only-archive-proof.mjs";
import { COMPILER_WORKER_REGISTRY_ENTRY, RELEASE_WORKER_ENTRIES } from "./worker-entry-contract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const policy = JSON.parse(await readFile(resolve(root, "config/release/release-policy.json"), "utf8"));
validateReleasePolicy(policy);
const testProof = process.argv.includes("--test-only-packed-proof");
const outFlag = process.argv.indexOf("--out");
const requestedOutput = resolve(root, outFlag < 0 ? "artifacts/1.0.0/packages" : process.argv[outFlag + 1]);
const indexFlag = process.argv.indexOf("--index");
const requestedIndex = resolve(root, indexFlag < 0 ? "artifacts/1.0.0/package-index.json" : process.argv[indexFlag + 1]);
if (testProof) {
  await assertTestOnlyArchiveOutput(requestedOutput, root);
  await assertTestOnlyArchiveOutput(requestedIndex, root);
} else if (process.argv.some((value) => value.startsWith("--test-only"))) throw new Error("unknown test-only release packaging mode");
const publicationMetadata = testProof
  ? testOnlyPublicationMetadata()
  : validateApprovedPublicationMetadata(JSON.parse(await readFile(resolve(root, "config/release/publication-metadata.json"), "utf8")));
const immutableOutput = await prepareImmutableReleaseSetOutput({ output: requestedOutput, index: requestedIndex });
const output = immutableOutput.stagedOutput;
const packageIndex = immutableOutput.stagedIndex;
try {
  await buildFreshPublicDistributions(root);
  const work = await mkdtemp(join(tmpdir(), "aval-pack-"));
  const reports = [];
  const packed = [];
  try {
    for (const name of policy.publicPackages) {
      const short = releasePackageDirectory(name);
      const source = resolve(root, "packages", short);
      const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
      if (manifest.name !== name || manifest.version !== policy.releaseVersion || manifest.private !== false) throw new Error(`${name} is not a publishable ${policy.releaseVersion} package`);
      const staging = join(work, "staging", short);
      await mkdir(join(staging, "dist"), { recursive: true });
      await Promise.all(["README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"].map((file) => copyFile(join(source, file), join(staging, file))));
      const publishManifest = createPublishManifest(manifest, publicationMetadata);
      await writeFile(join(staging, "package.json"), `${JSON.stringify(publishManifest, null, 2)}\n`, { flag: "wx", mode: 0o444 });
      const copied = [];
      await copyDistribution(join(source, "dist"), join(staging, "dist"), copied, name);
      requireEntry(copied, "index.js", name);
      requireEntry(copied, "index.d.ts", name);
      if (name === "@pixel-point/aval-compiler") {
        requireEntry(copied, "cli.js", name);
        requireEntry(copied, COMPILER_WORKER_REGISTRY_ENTRY.output, name);
        await chmod(join(staging, "dist", "cli.js"), 0o755);
      }
      if (name === "@pixel-point/aval-element") {
        requireEntry(copied, "auto.js", name);
      }
      for (const worker of RELEASE_WORKER_ENTRIES) {
        if (worker.packageName === name) requireEntry(copied, worker.output, name);
      }
      const first = join(work, "first", short);
      const second = join(work, "second", short);
      await Promise.all([mkdir(first, { recursive: true }), mkdir(second, { recursive: true })]);
      const firstPack = pack(staging, first);
      const secondPack = pack(staging, second);
      if (firstPack.filename !== secondPack.filename) throw new Error(`${name} changed archive filename across identical packs`);
      const [firstBytes, secondBytes] = await Promise.all([
        readFile(join(first, firstPack.filename)),
        readFile(join(second, secondPack.filename))
      ]);
      const firstDigest = createHash("sha256").update(firstBytes).digest("hex");
      const secondDigest = createHash("sha256").update(secondBytes).digest("hex");
      if (firstDigest !== secondDigest || Buffer.compare(firstBytes, secondBytes) !== 0) throw new Error(`${name} tarball is not byte-deterministic across two clean packs`);
      const inspected = inspectTarballBytes(firstBytes, { label: firstPack.filename });
      if (inspected.name !== name || inspected.unpackedSize !== firstPack.unpackedSize) throw new Error(`${name} npm pack report does not match inspected archive bytes`);
      await copyFile(join(first, firstPack.filename), join(output, firstPack.filename));
      packed.push(Object.freeze({ ...inspected, filename: firstPack.filename, path: join(output, firstPack.filename), bytes: firstBytes }));
    }
    validateReleasePackageManifests(packed.map(({ manifest }) => manifest));
    reports.push(...releaseSetSummary({ packages: packed, releaseSetDigest: computeReleaseSetDigest(packed) }).packages);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  const indexDocument = { schemaVersion: "1.0", releaseVersion: "1.0.0", releaseSetDigest: computeReleaseSetDigest(packed), packages: reports };
  await writeFile(packageIndex, `${JSON.stringify(indexDocument, null, 2)}\n`, { flag: "wx" });
  const reopened = await loadVerifiedReleaseSet({ directory: output, policy, packageIndex: indexDocument });
  if (reopened.releaseSetDigest !== indexDocument.releaseSetDigest) throw new Error("reopened release-set digest changed before publication");
  await immutableOutput.publish();
  process.stdout.write(`${JSON.stringify({ status: "passed", output: immutableOutput.finalOutput, packageIndex: immutableOutput.finalIndex, packages: reports }, null, 2)}\n`);
} finally {
  await immutableOutput.dispose();
}

async function copyDistribution(source, target, copied, packageName, prefix = "") {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`distribution symlink is forbidden: ${relative}`);
    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      await copyDistribution(sourcePath, targetPath, copied, packageName, relative);
      continue;
    }
    if (!entry.isFile()) throw new Error(`distribution entry is not a regular file: ${relative}`);
    if (/\.map$|\.tsbuildinfo$|(?:^|\/)[^/]+\.(?:test|compile)\.(?:js|d\.ts)$|test-support/iu.test(relative)) continue;
    const isCanonicalCompilerRegistry =
      packageName === COMPILER_WORKER_REGISTRY_ENTRY.packageName &&
      relative === COMPILER_WORKER_REGISTRY_ENTRY.output;
    if (!/\.(?:js|d\.ts)$/u.test(relative) && !isCanonicalCompilerRegistry) {
      throw new Error(`unexpected distribution file type: ${relative}`);
    }
    if ((await stat(sourcePath)).size > 8 * 1024 * 1024) throw new Error(`distribution file is unexpectedly large: ${relative}`);
    await copyFile(sourcePath, targetPath);
    copied.push(relative);
  }
}

function pack(staging, destination) {
  const result = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination, staging], { cwd: root, encoding: "utf8", timeout: 120_000 });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  if (!Array.isArray(report) || report.length !== 1 || typeof report[0]?.filename !== "string") throw new Error(`npm pack returned an unexpected report for ${basename(staging)}`);
  return report[0];
}

function requireEntry(files, entry, name) {
  if (!files.includes(entry)) throw new Error(`${name} distribution is missing ${entry}`);
}
