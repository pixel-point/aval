#!/usr/bin/env node
import { spawnSync } from "node:child_process";

import { RELEASE_PACKAGE_SPECS } from "./release-set-model.mjs";

const local = process.argv.slice(2);
if (local.some((argument) => argument !== "--local")) {
  throw new Error("usage: run-api-extractor.mjs [--local]");
}

const packages = RELEASE_PACKAGE_SPECS.map(({ directory }) => directory);
for (const packageName of packages) {
  const args = [
    "node_modules/@microsoft/api-extractor/bin/api-extractor",
    "run",
    "--config",
    `packages/${packageName}/api-extractor.json`,
    ...local
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    timeout: 120_000
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

process.stdout.write(`${JSON.stringify({ status: "passed", mode: local.length === 0 ? "verify" : "local", packages: packages.length })}\n`);
