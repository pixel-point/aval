import definitions from "./dev-worker-entries.json" with { type: "json" };

import {
  DEV_MODULE_PACKAGES,
  type DevModulePackage
} from "./dev-package-modules.js";

export interface DevWorkerEntry {
  readonly package: DevModulePackage;
  readonly packageName: (typeof DEV_MODULE_PACKAGES)[DevModulePackage];
  readonly output: string;
  readonly path: string;
  readonly search: string;
}

/** Canonical packaged worker entries exposed by the compiler dev server. */
export const DEV_WORKER_ENTRIES: readonly Readonly<DevWorkerEntry>[] =
  Object.freeze(definitions.map((definition) => {
    if (
      !isDevModulePackage(definition.package) ||
      !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.js$/u.test(definition.output) ||
      definition.search !== "" && !/^\?[A-Za-z0-9_-]+$/u.test(definition.search)
    ) {
      throw new Error("invalid dev worker entry contract");
    }
    return Object.freeze({
      package: definition.package,
      packageName: DEV_MODULE_PACKAGES[definition.package],
      output: definition.output,
      path: `modules/${definition.package}/${definition.output}`,
      search: definition.search
    });
  }));

if (new Set(DEV_WORKER_ENTRIES.map(({ path }) => path)).size !==
  DEV_WORKER_ENTRIES.length) {
  throw new Error("duplicate dev worker entry contract");
}

export function devWorkerEntry(path: string): Readonly<DevWorkerEntry> | undefined {
  return DEV_WORKER_ENTRIES.find((entry) => entry.path === path);
}

function isDevModulePackage(value: string): value is DevModulePackage {
  return Object.hasOwn(DEV_MODULE_PACKAGES, value);
}
