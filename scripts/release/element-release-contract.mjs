export const ELEMENT_RELEASE_TYPESCRIPT_ROOTS = Object.freeze([
  "index.ts",
  "auto.ts"
]);

// `new URL(..., import.meta.url)` is deliberately invisible to TypeScript's
// module graph. Keep the worker in the release contract explicitly.
export const ELEMENT_RELEASE_WORKER = Object.freeze({
  source: "decoder-worker.ts",
  output: "decoder-worker.js"
});
