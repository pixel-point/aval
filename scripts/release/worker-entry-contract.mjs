import definitions from "../../packages/compiler/src/commands/dev-worker-entries.json" with { type: "json" };
import { RELEASE_PACKAGE_SPECS } from "./release-set-model.mjs";

const RELEASE_PACKAGES = new Set(RELEASE_PACKAGE_SPECS.map(({ name }) => name));
const COMPILER_WORKER_REGISTRY_OUTPUT = "commands/dev-worker-entries.json";
const COMPILER_REGISTRY_OWNERS = RELEASE_PACKAGE_SPECS.filter(({ buildConfig }) =>
  buildConfig.additionalSources.includes(COMPILER_WORKER_REGISTRY_OUTPUT)
);
if (COMPILER_REGISTRY_OWNERS.length !== 1) throw new Error("release package contract must declare exactly one compiler worker registry owner");

const CANONICAL_DEFINITIONS = Object.freeze(definitions.map((definition) => {
  if (
    typeof definition?.package !== "string" ||
    !/^[a-z][a-z0-9-]*$/u.test(definition.package) ||
    typeof definition.output !== "string" ||
    !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.js$/u.test(definition.output) ||
    typeof definition.search !== "string" ||
    definition.search !== "" && !/^\?[A-Za-z0-9_-]+$/u.test(definition.search)
  ) {
    throw new Error("invalid release worker entry contract");
  }
  return Object.freeze({
    package: definition.package,
    output: definition.output,
    search: definition.search
  });
}));

export const COMPILER_WORKER_REGISTRY_ENTRY = Object.freeze({
  packageName: COMPILER_REGISTRY_OWNERS[0].name,
  output: COMPILER_WORKER_REGISTRY_OUTPUT,
  // TypeScript's resolveJsonModule emission is canonical four-space JSON.
  contents: `${JSON.stringify(CANONICAL_DEFINITIONS, null, 4)}\n`
});

export const RELEASE_WORKER_ENTRIES = Object.freeze(CANONICAL_DEFINITIONS.map((definition) => {
  const packageName = `@pixel-point/aval-${definition.package}`;
  if (!RELEASE_PACKAGES.has(packageName)) {
    throw new Error(`worker entry names an unknown release package: ${packageName}`);
  }
  return Object.freeze({
    packageName,
    modulePackage: definition.package,
    output: definition.output,
    path: `modules/${definition.package}/${definition.output}`,
    search: definition.search
  });
}));

if (new Set(RELEASE_WORKER_ENTRIES.map(({ path }) => path)).size !==
  RELEASE_WORKER_ENTRIES.length) {
  throw new Error("duplicate release worker entry contract");
}

export function releaseWorkerEntry(packageName) {
  const entries = RELEASE_WORKER_ENTRIES.filter((entry) =>
    entry.packageName === packageName
  );
  if (entries.length !== 1) {
    throw new Error(`release package does not declare exactly one worker: ${String(packageName)}`);
  }
  return entries[0];
}
