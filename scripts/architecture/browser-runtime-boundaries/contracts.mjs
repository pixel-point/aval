export const REMOVED_NAME = ["player", "web"].join("-");
export const REMOVED_PACKAGE = ["@pixel-point/aval", REMOVED_NAME].join("-");
export const REMOVED_DIRECTORY = ["packages", REMOVED_NAME].join("/");
export const CANONICAL_RUNTIME = "@pixel-point/aval-element";
export const CANONICAL_ADAPTER = `${CANONICAL_RUNTIME}/adapter`;
export const ADAPTER_SOURCE_PATH = "packages/element/src/adapter.ts";

export const FRAMEWORK_WRAPPERS = Object.freeze(["react", "svelte"]);

export const ALLOWED_FRAMEWORK_AVAL_IMPORTS = new Set([
  CANONICAL_RUNTIME,
  CANONICAL_ADAPTER
]);

export const FRAMEWORK_SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".svelte",
  ".ts",
  ".tsx"
]);

export const ADAPTER_COMMAND_NAMES = Object.freeze([
  "getDiagnostics",
  "pause",
  "play",
  "prepare",
  "readyFor",
  "send",
  "setState"
]);
export const ADAPTER_COMMAND_NAME_SET = new Set(ADAPTER_COMMAND_NAMES);

export const REVIEWED_ADAPTER_EXPORTS = Object.freeze([
  reviewedExport("./adapter-binding.js", "AvalAdapterBinding", "type"),
  reviewedExport("./adapter-binding.js", "AvalAdapterCommands", "type"),
  reviewedExport("./adapter-binding.js", "AvalAdapterController", "type"),
  reviewedExport("./adapter-binding.js", "AvalAdapterStatus", "type"),
  reviewedExport("./adapter-binding.js", "createAvalAdapterBinding", "value"),
  reviewedExport("./adapter-options.js", "AvalAdapterCallbacks", "type"),
  reviewedExport("./adapter-options.js", "AvalAdapterConfiguration", "type"),
  reviewedExport("./adapter-options.js", "AvalAdapterOptions", "type"),
  reviewedExport("./adapter-options.js", "AvalAdapterRenderOptions", "type"),
  reviewedExport("./adapter-options.js", "AvalSources", "type"),
  reviewedExport(
    "./adapter-options.js",
    "createAvalAdapterConfiguration",
    "value"
  )
]);

export const REVIEWED_PACKAGES = Object.freeze([
  reviewedPackage("alpha", "@pixel-point/aval-alpha"),
  reviewedPackage("alpha-react", "@pixel-point/aval-alpha-react"),
  reviewedPackage("alpha-svelte", "@pixel-point/aval-alpha-svelte"),
  reviewedPackage("certification", "@pixel-point/aval-certification"),
  reviewedPackage("compiler", "@pixel-point/aval-compiler"),
  reviewedPackage("element", CANONICAL_RUNTIME),
  reviewedPackage("format", "@pixel-point/aval-format"),
  reviewedPackage("graph", "@pixel-point/aval-graph"),
  reviewedPackage("react", "@pixel-point/aval-react"),
  reviewedPackage("svelte", "@pixel-point/aval-svelte")
]);

export function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reviewedExport(source, name, kind) {
  return Object.freeze({ source, name, kind });
}

function reviewedPackage(directory, name) {
  return Object.freeze({ directory, name });
}
