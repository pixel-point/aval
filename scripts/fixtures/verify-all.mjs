#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverProvenanceFiles, verifyProvenanceFile } from "./verify-provenance.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const codecs = Object.freeze(["av1", "vp9", "h265", "h264"]);
const generatorChecks = Object.freeze([
  "fixtures/certification/v1/update-fixture.mjs",
  "fixtures/compiler/v1/update-provenance.mjs",
  "fixtures/conformance/v1/update-provenance.mjs"
]);
const bundleChecks = Object.freeze([
  Object.freeze({
    directory: "fixtures/conformance/v1",
    expectedEntries: Object.freeze([
      "README.md",
      "av1.avl",
      "build.json",
      "h264.avl",
      "h265.avl",
      "provenance.json",
      "update-provenance.mjs",
      "vp9.avl"
    ]),
    formatVersion: "1.0",
    outputQualified: false,
    consumerDirectory: null
  }),
  Object.freeze({
    directory: "fixtures/certification/v1",
    expectedEntries: Object.freeze([
      "README.md",
      "av1.avl",
      "build.json",
      "h264.avl",
      "h265.avl",
      "provenance.json",
      "update-fixture.mjs",
      "vp9.avl"
    ]),
    formatVersion: "1.1",
    outputQualified: true,
    consumerDirectory: "examples/end-user-playground/public/favorite"
  })
]);

async function main() {
  await requireCleanV1FixtureLayout();
  const provenance = [];
  for (const path of await discoverProvenanceFiles()) {
    provenance.push(await verifyProvenanceFile(path));
  }
  for (const script of generatorChecks) runGeneratorCheck(script);
  const formatModule = await import(join(root, "packages/format/dist/index.js"));
  const [bundle, certificationBundle] = await Promise.all(
    bundleChecks.map((check) => verifyBundle(formatModule, check))
  );
  const starter = await verifyStarter();
  process.stdout.write(`${JSON.stringify({
    status: "passed",
    provenance,
    completeAssets: [...bundle.assets, ...certificationBundle.assets]
      .map(({ path }) => path),
    bundle,
    certificationBundle,
    starter,
    generatorChecks
  }, null, 2)}\n`);
}

async function requireCleanV1FixtureLayout() {
  for (const kind of ["certification", "compiler", "conformance", "starter"]) {
    const entries = (await readdir(join(root, "fixtures", kind), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const expected = kind === "starter" ? ["v1-idle-hover"] : ["v1"];
    if (JSON.stringify(entries) !== JSON.stringify(expected)) {
      throw new Error(`fixtures/${kind} must contain only ${expected.join(", ")}`);
    }
  }
}

function runGeneratorCheck(script) {
  const result = spawnSync(process.execPath, [script, "--check"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${script} --check failed:\n${result.stderr || result.stdout}`);
  }
}

async function verifyBundle(formatModule, contract) {
  const directory = join(root, contract.directory);
  const entries = (await readdir(directory)).sort();
  const expectedEntries = [...contract.expectedEntries].sort();
  if (JSON.stringify(entries) !== JSON.stringify(expectedEntries)) {
    throw new Error(`${contract.directory} contains an unexpected file set`);
  }
  const buildReportPath = `${contract.directory}/build.json`;
  const buildReportBytes = await readFile(join(root, buildReportPath));
  const report = JSON.parse(buildReportBytes.toString("utf8"));
  if (report.reportVersion !== "1.0") throw new Error("build report is not version 1.0");
  if (JSON.stringify(report.assets?.map(({ codec }) => codec)) !== JSON.stringify(codecs)) {
    throw new Error("build report codec order must be AV1, VP9, H.265, H.264");
  }
  if (JSON.stringify(report.encodings?.map(({ codec }) => codec)) !== JSON.stringify(codecs)) {
    throw new Error("build report encoding order drifted");
  }
  const assets = [];
  for (const [index, codec] of codecs.entries()) {
    const fact = report.assets[index];
    const path = `${contract.directory}/${codec}.avl`;
    if (fact?.path !== `${codec}.avl`) throw new Error(`${codec} report path drifted`);
    const bytes = new Uint8Array(await readFile(resolve(root, path)));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const integrity = `sha256-${Buffer.from(digest, "hex").toString("base64")}`;
    if (fact.bytes !== bytes.byteLength || fact.sha256 !== digest || fact.integrity !== integrity) {
      throw new Error(`${codec} build report digest or size drifted`);
    }
    if (fact.type !== `application/vnd.aval; codecs="${fact.codecString}"`) {
      throw new Error(`${codec} build report MIME type is not exact`);
    }
    const validated = formatModule.validateCompleteAsset({ bytes });
    const manifest = validated.frontIndex.manifest;
    if (manifest.formatVersion !== contract.formatVersion || manifest.codec !== codec) {
      throw new Error(
        `${codec} asset is not a codec-matched wire-${contract.formatVersion} asset`
      );
    }
    if (manifest.units.length !== 3 || manifest.states.length !== 2) {
      throw new Error(`${codec} asset graph drifted`);
    }
    if (contract.outputQualified && (
      manifest.layout !== "packed-alpha" ||
      manifest.renditions.length < 1 ||
      manifest.renditions.some(({ outputQualification }) =>
        outputQualification === undefined
      )
    )) {
      throw new Error(`${codec} certification asset is not output-qualified`);
    }
    if (contract.consumerDirectory !== null) {
      await requireByteEqual(path, `${contract.consumerDirectory}/${codec}.avl`);
    }
    assets.push({
      codec,
      path,
      bytes: bytes.byteLength,
      sha256: digest,
      codecString: fact.codecString,
      bitDepth: manifest.renditions[0]?.bitDepth
    });
  }
  const markup = report.assets.map((asset) =>
    `<source src="${asset.path}" type='${asset.type}' integrity="${asset.integrity}">`
  ).join("\n");
  if (report.sourceMarkup !== markup) throw new Error("ordered source markup drifted");
  if (contract.consumerDirectory !== null) {
    await requireByteEqual(
      buildReportPath,
      `${contract.consumerDirectory}/build.json`
    );
  }
  return {
    report: buildReportPath,
    formatVersion: contract.formatVersion,
    assets,
    ...(contract.consumerDirectory === null
      ? {}
      : { byteIdenticalConsumer: contract.consumerDirectory })
  };
}

async function requireByteEqual(authorityPath, consumerPath) {
  const [authority, consumer] = await Promise.all([
    readFile(join(root, authorityPath)),
    readFile(join(root, consumerPath))
  ]);
  if (Buffer.compare(authority, consumer) !== 0) {
    throw new Error(`${consumerPath} drifted from ${authorityPath}`);
  }
}

async function verifyStarter() {
  const temporary = await mkdtemp(join(tmpdir(), "aval-starter-drift-"));
  try {
    const { runInitCommand } = await import(
      join(root, "packages/compiler/dist/commands/init.js")
    );
    const generated = await runInitCommand({
      command: "init",
      directory: "starter",
      json: false
    }, temporary);
    const committed = join(root, "fixtures/starter/v1-idle-hover");
    const [actualEntries, expectedEntries] = await Promise.all([
      collectTree(generated.directory),
      collectTree(committed)
    ]);
    if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
      throw new Error("generated v1 starter tree drifted from the committed fixture");
    }
    for (const entry of expectedEntries) {
      if (entry.endsWith("/")) continue;
      const [actual, expected] = await Promise.all([
        readFile(join(generated.directory, entry)),
        readFile(join(committed, entry))
      ]);
      if (Buffer.compare(actual, expected) !== 0) {
        throw new Error(`generated v1 starter byte drift: ${entry}`);
      }
    }
    return { path: "fixtures/starter/v1-idle-hover", files: generated.files.length };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function collectTree(directory, prefix = "") {
  const result = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const declared = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      result.push(`${declared}/`);
      result.push(...await collectTree(join(directory, entry.name), declared));
    } else if (entry.isFile()) {
      result.push(declared);
    } else {
      throw new Error(`fixture tree contains unsupported entry: ${declared}`);
    }
  }
  return result;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
