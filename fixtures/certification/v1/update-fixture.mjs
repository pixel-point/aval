#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cp,
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { replaceDirectoriesTransactionally } from
  "../../../scripts/fixtures/replace-fixture-directories.mjs";

const authority = dirname(fileURLToPath(import.meta.url));
const root = resolve(authority, "../../..");
const consumer = resolve(
  root,
  "examples/end-user-playground/public/favorite"
);
const codecs = Object.freeze(["av1", "vp9", "h265", "h264"]);
const generatedFiles = Object.freeze([
  ...codecs.map((codec) => `${codec}.avl`),
  "build.json"
]);
const rebuildCommand =
  "node fixtures/certification/v1/update-fixture.mjs";

async function descriptor(path, source = resolve(root, path)) {
  const bytes = await readFile(source);
  return {
    path,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.length === 1 && args[0] === "--check";
  if (args.length !== 0 && !check) {
    throw new TypeError("usage: update-fixture.mjs [--check]");
  }
  if (check) {
    await verifyInstalledFixture();
    return;
  }

  const temporary = await mkdtemp(join(tmpdir(), "aval-certification-update-"));
  const stagedAuthority = join(
    dirname(authority),
    `.v1.update-${randomUUID()}`
  );
  const stagedConsumer = join(
    dirname(consumer),
    `.favorite.update-${randomUUID()}`
  );
  let transactionStarted = false;
  let transactionCompleted = false;
  try {
    const generated = join(temporary, "bundle");
    compileFixture(generated);
    await requireGeneratedBundle(generated);
    await Promise.all([
      cp(authority, stagedAuthority, {
        recursive: true,
        errorOnExist: true,
        force: false
      }),
      cp(consumer, stagedConsumer, {
        recursive: true,
        errorOnExist: true,
        force: false
      })
    ]);
    for (const name of generatedFiles) {
      await copyFile(join(generated, name), join(stagedAuthority, name));
      await copyFile(join(generated, name), join(stagedConsumer, name));
    }
    await writeFile(
      join(stagedAuthority, "provenance.json"),
      await serializedProvenance(undefined, stagedAuthority)
    );
    await verifyInstalledFixture(stagedAuthority, stagedConsumer);
    transactionStarted = true;
    await replaceDirectoriesTransactionally([
      { current: authority, staged: stagedAuthority },
      { current: consumer, staged: stagedConsumer }
    ]);
    transactionCompleted = true;
    await verifyInstalledFixture();
  } finally {
    const cleanup = [rm(temporary, { recursive: true, force: true })];
    if (!transactionStarted || transactionCompleted) {
      cleanup.push(
        rm(stagedAuthority, { recursive: true, force: true }),
        rm(stagedConsumer, { recursive: true, force: true })
      );
    }
    await Promise.all(cleanup);
  }
}

function compileFixture(output) {
  const result = spawnSync(process.execPath, [
    "packages/compiler/dist/cli.js",
    "compile",
    "fixtures/compiler/v1/source/motion.json",
    "--out",
    output,
    "--force"
  ], {
    cwd: root,
    stdio: "inherit",
    timeout: 5 * 60_000
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`compiler exited with status ${String(result.status)}`);
  }
}

async function requireGeneratedBundle(directory) {
  const entries = (await readdir(directory)).sort();
  if (JSON.stringify(entries) !== JSON.stringify([...generatedFiles].sort())) {
    throw new Error("compiler produced an unexpected certification file set");
  }
  await requireCanonicalReport(join(directory, "build.json"));
}

async function requireCanonicalReport(path) {
  const report = JSON.parse(await readFile(path, "utf8"));
  const assetCodecs = report.assets?.map(({ codec }) => codec);
  const encodingCodecs = report.encodings?.map(({ codec }) => codec);
  if (
    report.reportVersion !== "1.0" ||
    JSON.stringify(assetCodecs) !== JSON.stringify(codecs) ||
    JSON.stringify(encodingCodecs) !== JSON.stringify(codecs)
  ) {
    throw new Error("build.json is not the canonical ordered four-codec report");
  }
  return report;
}

async function verifyInstalledFixture(
  authorityDirectory = authority,
  consumerDirectory = consumer
) {
  const report = await requireCanonicalReport(
    resolve(authorityDirectory, "build.json")
  );
  for (const name of generatedFiles) {
    await requireByteEqual(
      join(authorityDirectory, name),
      join(consumerDirectory, name)
    );
  }
  const current = await readFile(
    join(authorityDirectory, "provenance.json"),
    "utf8"
  );
  const expected = await serializedProvenance(report, authorityDirectory);
  if (current !== expected) {
    throw new Error(
      `${relative(root, join(authorityDirectory, "provenance.json"))} drifted`
    );
  }
}

async function serializedProvenance(knownReport, authorityDirectory = authority) {
  const report = knownReport ??
    await requireCanonicalReport(resolve(authorityDirectory, "build.json"));
  const sourceProvenanceBytes = await readFile(
    resolve(root, "fixtures/compiler/v1/provenance.json")
  );
  const document = {
    provenanceVersion: "1.0",
    formatVersion: "1.1",
    fixture: "aval-qualified-certification-four-codec-bundle",
    license: "CC0-1.0 generated fixture sources",
    rebuild: rebuildCommand,
    source: await descriptor("fixtures/compiler/v1/source/motion.json"),
    sourceProvenance: {
      provenancePath: "fixtures/compiler/v1/provenance.json",
      provenanceSha256: createHash("sha256")
        .update(sourceProvenanceBytes)
        .digest("hex")
    },
    buildReport: await descriptor(
      "fixtures/certification/v1/build.json",
      join(authorityDirectory, "build.json")
    ),
    outputs: await Promise.all(codecs.map((codec) =>
      descriptor(
        `fixtures/certification/v1/${codec}.avl`,
        join(authorityDirectory, `${codec}.avl`)
      )
    )),
    codecStrings: Object.fromEntries(report.assets.map(({ codec, codecString }) => [
      codec,
      codecString
    ]))
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

async function requireByteEqual(leftPath, rightPath) {
  const [left, right] = await Promise.all([
    readFile(leftPath),
    readFile(rightPath)
  ]);
  if (Buffer.compare(left, right) !== 0) {
    throw new Error(
      `${relative(root, rightPath)} drifted from ${relative(root, leftPath)}`
    );
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
