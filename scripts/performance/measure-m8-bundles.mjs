#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync
} from "node:zlib";

import { build } from "vite";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CAPS = Object.freeze({
  totalWorkingPlayerBrotliBytes: 60_000
});
const alias = Object.freeze({
  "@pixel-point/aval-graph": fileURLToPath(
    new URL("../../packages/graph/src/index.ts", import.meta.url)
  )
});

const element = await bundle({
  entry: fileURLToPath(new URL("../../packages/element/src/auto.ts", import.meta.url)),
  entryFileName: "auto.js"
});
const worker = await bundle({
  entry: fileURLToPath(
    new URL("../../packages/element/src/decoder-worker.ts", import.meta.url)
  ),
  entryFileName: "decoder-worker.js"
});
buildElementRelease();
const consumer = await bundleConsumer();

const bootstrap = requireSingleEntry(element, "element bootstrap");
const bootstrapChunks = collectStaticClosure(element, bootstrap.file);
const bootstrapFiles = new Set(bootstrapChunks.map(({ file }) => file));
const dynamicBoundaries = [...new Set(bootstrapChunks.flatMap(({ dynamicImports }) =>
  dynamicImports
))];
assert.equal(
  dynamicBoundaries.length,
  1,
  "the element bootstrap must expose exactly one lazy runtime boundary"
);
assert.ok(
  !bootstrapFiles.has(dynamicBoundaries[0]),
  "the lazy runtime boundary must not already be in the static bootstrap closure"
);
const runtimeClosure = collectStaticClosure(element, dynamicBoundaries[0]);
const reachableFiles = new Set([
  ...bootstrapFiles,
  ...runtimeClosure.map(({ file }) => file)
]);
assert.deepEqual(
  [...reachableFiles].sort(),
  element.map(({ file }) => file).sort(),
  "the bootstrap and sole lazy boundary must cover the complete loaded graph"
);
const runtimeChunks = element.filter(({ file }) => !bootstrapFiles.has(file));
assertNoDuplicatedModules(element);

const bootstrapGzipBytes = sum(bootstrapChunks.map(({ gzipBytes }) => gzipBytes));
const loadedRuntimeGraphGzipBytes = sum(element.map(({ gzipBytes }) => gzipBytes));

const workerEntry = requireSingleEntry(worker, "decoder worker");
assert.equal(worker.length, 1, "decoder worker must remain one self-contained chunk");
assert.deepEqual(workerEntry.imports, [], "decoder worker must not have external static chunks");
assert.deepEqual(workerEntry.dynamicImports, [], "decoder worker must not add lazy subgraphs");
// Diagnostic source-graph attribution only. The release-consumer outputs
// below are the executable artifacts and the sole aggregate Brotli authority.
const minifiedSourceGraphAndWorkerBrotliBytes = sum([
  ...element.map(({ brotliBytes }) => brotliBytes),
  workerEntry.brotliBytes
]);
const totalWorkingPlayerBrotliBytes = sum(
  consumer.map(({ brotliBytes }) => brotliBytes)
);
assert.ok(
  totalWorkingPlayerBrotliBytes <= CAPS.totalWorkingPlayerBrotliBytes,
  `complete working player is ${String(totalWorkingPlayerBrotliBytes)} Brotli bytes; cap is ${String(CAPS.totalWorkingPlayerBrotliBytes)}`
);

process.stdout.write(`${JSON.stringify({
  status: "passed",
  tool: "vite",
  viteVersion: (await import("vite/package.json", { with: { type: "json" } })).default.version,
  caps: CAPS,
  element: {
    chunks: reportChunks(element, bootstrapFiles),
    bootstrapGzipBytes,
    lazyRuntimeGzipBytes: sum(runtimeChunks.map(({ gzipBytes }) => gzipBytes)),
    loadedRuntimeGraphGzipBytes,
    minifiedSourceGraphAndWorkerBrotliBytes
  },
  decoderWorker: {
    chunks: reportChunks(worker),
    gzipBytes: workerEntry.gzipBytes,
    brotliBytes: workerEntry.brotliBytes
  },
  consumer: {
    outputs: consumer
  },
  totalWorkingPlayerBrotliBytes
}, null, 2)}\n`);

async function bundle({ entry, entryFileName }) {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    root: ROOT,
    resolve: { alias },
    build: {
      write: false,
      target: "es2022",
      minify: "oxc",
      lib: { entry, formats: ["es"] },
      rollupOptions: {
        output: {
          entryFileNames: entryFileName,
          chunkFileNames: "[name].js",
          minify: true,
          comments: false
        }
      }
    }
  });
  const outputs = Array.isArray(result)
    ? result.flatMap(({ output }) => output)
    : result.output;
  return outputs
    .filter((output) => output.type === "chunk")
    .map((chunk) => Object.freeze({
      file: chunk.fileName,
      entry: chunk.isEntry,
      imports: Object.freeze([...chunk.imports]),
      dynamicImports: Object.freeze([...chunk.dynamicImports]),
      rawBytes: Buffer.byteLength(chunk.code),
      gzipBytes: gzipSync(chunk.code, { level: 9 }).byteLength,
      brotliBytes: brotliCompressSync(chunk.code, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 11
        }
      }).byteLength,
      modules: Object.freeze(Object.keys(chunk.modules).sort())
    }))
    .sort((left, right) => left.file.localeCompare(right.file));
}

async function bundleConsumer() {
  const consumerEntry = "virtual:aval-consumer-entry";
  const resolvedConsumerEntry = `\0${consumerEntry}`;
  const result = await build({
    configFile: false,
    logLevel: "silent",
    root: ROOT,
    plugins: [{
      name: "aval-consumer-entry",
      resolveId(id) {
        return id === consumerEntry ? resolvedConsumerEntry : null;
      },
      load(id) {
        return id === resolvedConsumerEntry
          ? 'import "@pixel-point/aval-element/auto";'
          : null;
      }
    }],
    build: {
      write: false,
      target: "es2022",
      minify: "oxc",
      rollupOptions: {
        input: consumerEntry,
        output: {
          minify: true,
          comments: false
        }
      }
    }
  });
  const outputs = Array.isArray(result)
    ? result.flatMap(({ output }) => output)
    : result.output;
  const measured = outputs.map((output) => {
    const value = output.type === "chunk" ? output.code : output.source;
    const bytes = Buffer.from(value);
    return Object.freeze({
      file: output.fileName,
      type: output.type,
      ...(output.type === "chunk"
        ? {
            entry: output.isEntry,
            imports: Object.freeze([...output.imports]),
            dynamicImports: Object.freeze([...output.dynamicImports])
          }
        : {}),
      rawBytes: bytes.byteLength,
      gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
      brotliBytes: brotliCompressSync(bytes, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 }
      }).byteLength
    });
  }).sort((left, right) => left.file.localeCompare(right.file));
  assert.ok(measured.length >= 2, "consumer build must emit bootstrap and runtime outputs");
  const assets = measured.filter(({ type }) => type === "asset");
  assert.equal(
    assets.length,
    1,
    `consumer build must emit exactly one decoder worker asset; emitted ${assets
      .map(({ file }) => file).join(", ")}`
  );
  assert.match(
    assets[0].file,
    /(?:^|\/)decoder-worker-[A-Za-z0-9_-]+\.js$/u,
    "consumer asset must be the hashed decoder worker"
  );
  const files = new Set(measured.map(({ file }) => file));
  const chunks = measured.filter(({ type }) => type === "chunk");
  assert.equal(
    chunks.filter(({ entry }) => entry).length,
    1,
    "consumer build must emit exactly one entry chunk"
  );
  for (const chunk of chunks) {
    for (const imported of [...chunk.imports, ...chunk.dynamicImports]) {
      assert.ok(
        files.has(imported),
        `consumer chunk ${chunk.file} references unmeasured output ${imported}`
      );
    }
  }
  return measured;
}

function buildElementRelease() {
  execFileSync(process.execPath, [
    fileURLToPath(new URL("../release/build-element-package.mjs", import.meta.url))
  ], {
    cwd: ROOT,
    stdio: "inherit"
  });
}

function requireSingleEntry(chunks, label) {
  const entries = chunks.filter(({ entry }) => entry);
  assert.equal(entries.length, 1, `${label} must have exactly one entry chunk`);
  return entries[0];
}

function assertNoDuplicatedModules(chunks) {
  const owners = new Map();
  for (const chunk of chunks) {
    for (const module of chunk.modules) {
      const previous = owners.get(module);
      assert.equal(
        previous,
        undefined,
        `${module} is duplicated by ${previous ?? "an unknown chunk"} and ${chunk.file}`
      );
      owners.set(module, chunk.file);
    }
  }
}

function collectStaticClosure(chunks, entry) {
  const byFile = new Map(chunks.map((chunk) => [chunk.file, chunk]));
  const pending = [entry];
  const found = new Map();
  while (pending.length > 0) {
    const file = pending.pop();
    if (found.has(file)) continue;
    const chunk = byFile.get(file);
    assert.notEqual(chunk, undefined, `bundle references missing static chunk ${String(file)}`);
    found.set(file, chunk);
    pending.push(...chunk.imports);
  }
  return [...found.values()].sort((left, right) => left.file.localeCompare(right.file));
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function reportChunks(chunks, bootstrapFiles = new Set()) {
  return chunks.map(({ modules: _modules, ...chunk }) => ({
    ...chunk,
    phase: bootstrapFiles.has(chunk.file) ? "bootstrap" : "runtime"
  }));
}
