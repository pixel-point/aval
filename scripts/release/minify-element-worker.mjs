#!/usr/bin/env node

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

import { ELEMENT_RELEASE_WORKER } from "./element-release-contract.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--out")) {
  throw new TypeError("usage: minify-element-worker.mjs [--out directory]");
}
const outputDirectory = args.length === 0
  ? fileURLToPath(new URL("../../packages/element/dist", import.meta.url))
  : resolve(args[1]);
const result = await build({
  configFile: false,
  logLevel: "silent",
  root: ROOT,
  publicDir: false,
  build: {
    write: true,
    emptyOutDir: false,
    outDir: outputDirectory,
    target: "es2022",
    minify: "oxc",
    lib: {
      entry: fileURLToPath(new URL(
        `../../packages/element/src/${ELEMENT_RELEASE_WORKER.source}`,
        import.meta.url
      )),
      formats: ["es"]
    },
    rollupOptions: {
      output: {
        entryFileNames: ELEMENT_RELEASE_WORKER.output,
        minify: true,
        comments: false
      }
    }
  }
});
const outputs = Array.isArray(result)
  ? result.flatMap(({ output }) => output)
  : result.output;
assert.equal(outputs.length, 1, "element decoder worker must emit only one output");
const chunks = outputs.filter((output) => output.type === "chunk");
assert.equal(chunks.length, 1, "element decoder worker must emit one chunk");
assert.equal(chunks[0].fileName, ELEMENT_RELEASE_WORKER.output);
assert.deepEqual(chunks[0].imports, []);
assert.deepEqual(chunks[0].dynamicImports, []);
