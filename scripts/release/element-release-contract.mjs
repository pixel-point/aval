import { releaseWorkerEntry } from "./worker-entry-contract.mjs";
import { releasePackageSpecification } from "./release-set-model.mjs";

const ELEMENT_RELEASE_SPECIFICATION = releasePackageSpecification("@pixel-point/aval-element");
const ELEMENT_RELEASE_SOURCE = ELEMENT_RELEASE_SPECIFICATION.buildConfig.source;
if (ELEMENT_RELEASE_SOURCE.kind !== "files") throw new Error("element release must use an explicit TypeScript file-source selection");
export const ELEMENT_RELEASE_TYPESCRIPT_ROOTS = ELEMENT_RELEASE_SOURCE.paths;
if (ELEMENT_RELEASE_TYPESCRIPT_ROOTS.length === 0 || ELEMENT_RELEASE_TYPESCRIPT_ROOTS.some((path) => !/^[A-Za-z0-9_-]+\.ts$/u.test(path))) {
  throw new Error("element release TypeScript roots are invalid");
}

// `new URL(..., import.meta.url)` is deliberately invisible to TypeScript's
// module graph. Keep the worker in the release contract explicitly.
export const ELEMENT_RELEASE_WORKER = Object.freeze({
  source: "decoder-worker.ts",
  output: releaseWorkerEntry("@pixel-point/aval-element").output
});
