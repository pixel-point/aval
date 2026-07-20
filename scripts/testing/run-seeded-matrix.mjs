#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const profileIndex = process.argv.indexOf("--profile");
const profile = profileIndex < 0 ? "pull-request" : process.argv[profileIndex + 1];
const config = JSON.parse(await readFile(resolve(root, "tests/mutation/release-seeds.json"), "utf8"));
const seeds = config.profiles[profile];
if (!Array.isArray(seeds)) throw new Error(`unknown mutation profile: ${profile}`);
const expectedSeedCount = profile === "pull-request" ? 4 : profile === "release" ? 8 : null;
if (expectedSeedCount === null || seeds.length !== expectedSeedCount) {
  throw new Error(`${String(profile)} mutation profile must contain exactly ${String(expectedSeedCount)} seeds`);
}
if (new Set(seeds).size !== seeds.length || seeds.some((seed) =>
  !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff
)) throw new Error(`${String(profile)} mutation profile contains invalid or duplicate uint32 seeds`);
const files = [
  "tests/mutation/release-corpus.test.ts",
  "packages/format/test/mutation-fuzz.test.ts",
  "packages/format/test/canonical-json-fuzz.test.ts",
  "packages/graph/test/engine-fuzz.test.ts"
];
await Promise.all(files.map((file) => access(resolve(root, file))));
process.stdout.write(`${JSON.stringify({ mutationProfile: profile, seeds })}\n`);
const result = spawnSync("npx", ["vitest", "run", "--config", "vitest.m9.config.ts", ...files], {
  cwd: root,
  stdio: "inherit",
  timeout: profile === "release" ? 300_000 : 120_000,
  env: { ...process.env, AVL_MUTATION_PROFILE: profile, AVL_MUTATION_SEEDS: seeds.join(",") }
});
if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
