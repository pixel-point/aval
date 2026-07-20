#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const toolBacked = process.argv.includes("--tool-backed");
const args = [
  "vitest",
  "run",
  "packages/compiler/test/project-bundle-compiler.test.ts",
  "packages/compiler/test/video-rendition-pipeline.test.ts",
  "packages/compiler/test/ivf-codec-integration.test.ts"
];
if (!toolBacked) {
  process.stdout.write(`${JSON.stringify({ status: "not-run", reason: "pass --tool-backed to run the recorded semantic native-tool matrix" })}\n`);
  process.exit(0);
}
const result = spawnSync("npx", args, { cwd: root, stdio: "inherit", timeout: 300_000 });
if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
