export const RELEASE_VERSION = "1.0.0";

const ROOT_EXPORT = Object.freeze({
  ".": Object.freeze({ types: "./dist/index.d.ts", import: "./dist/index.js" })
});
const DEFAULT_INCLUDE = Object.freeze(["**/*.ts", "**/*.tsx"]);
const DEFAULT_EXCLUDE = Object.freeze([
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.compile.ts",
  "**/*.compile.tsx",
  "**/*test-support.ts",
  "**/*test-support.tsx"
]);

export const RELEASE_PACKAGE_SPECS = Object.freeze([
  packageSpec({
    name: "@pixel-point/aval-graph",
    directory: "graph",
    dependencies: [],
    productionEntries: [{ export: ".", requiredInGraph: true }],
    buildConfig: typescriptBuild({ config: "tsconfig.json", sourceMaps: true }),
    buildInfo: "graph.tsbuildinfo"
  }),
  packageSpec({
    name: "@pixel-point/aval-format",
    directory: "format",
    dependencies: ["@pixel-point/aval-graph"],
    productionEntries: [{ export: ".", requiredInGraph: true }],
    buildConfig: typescriptBuild({ config: "tsconfig.json", sourceMaps: true }),
    buildInfo: "format.tsbuildinfo"
  }),
  packageSpec({
    name: "@pixel-point/aval-player-web",
    directory: "player-web",
    dependencies: ["@pixel-point/aval-graph", "@pixel-point/aval-format"],
    productionEntries: [{ export: ".", requiredInGraph: true }],
    buildConfig: typescriptBuild({ config: "tsconfig.release.json" }),
    buildInfo: "player-web.release.tsbuildinfo"
  }),
  packageSpec({
    name: "@pixel-point/aval-element",
    directory: "element",
    dependencies: ["@pixel-point/aval-graph", "@pixel-point/aval-format"],
    exports: {
      ...ROOT_EXPORT,
      "./auto": { types: "./dist/auto.d.ts", import: "./dist/auto.js" }
    },
    sideEffects: ["./dist/auto.js"],
    productionEntries: [
      { export: ".", requiredInGraph: true },
      { export: "./auto", requiredInGraph: true }
    ],
    buildConfig: typescriptBuild({
      config: "tsconfig.release.json",
      compilerOptions: { composite: false, incremental: true },
      source: fileSources(["index.ts", "auto.ts"]),
      buildSteps: ["element-worker"]
    }),
    buildInfo: "element.release.tsbuildinfo"
  }),
  packageSpec({
    name: "@pixel-point/aval-compiler",
    directory: "compiler",
    dependencies: ["@pixel-point/aval-graph", "@pixel-point/aval-format", "@pixel-point/aval-player-web", "@pixel-point/aval-element"],
    bin: { avl: "./dist/cli.js" },
    productionEntries: [],
    buildConfig: typescriptBuild({
      config: "tsconfig.json",
      sourceMaps: true,
      additionalSources: ["commands/dev-worker-entries.json"]
    }),
    buildInfo: "compiler.tsbuildinfo"
  }),
  packageSpec({
    name: "@pixel-point/aval-react",
    directory: "react",
    dependencies: ["@pixel-point/aval-element"],
    peerDependencies: { react: "^18.3.0 || ^19.0.0" },
    productionEntries: [{ export: ".", requiredInGraph: false }],
    buildConfig: typescriptBuild({
      config: "tsconfig.release.json",
      compilerOptions: { composite: false, incremental: true },
      source: fileSources(["index.ts"])
    }),
    buildInfo: "react.release.tsbuildinfo"
  })
]);
export const RELEASE_PACKAGE_NAMES = Object.freeze(topologicalPackageOrder(RELEASE_PACKAGE_SPECS));
export const PRODUCTION_PUBLIC_ENTRIES = Object.freeze(RELEASE_PACKAGE_SPECS.flatMap((specification) =>
  specification.productionEntries.map((entry) => productionPublicEntry(specification, entry))
));
if (new Set(PRODUCTION_PUBLIC_ENTRIES.map(({ specifier }) => specifier)).size !== PRODUCTION_PUBLIC_ENTRIES.length) throw new Error("production public-entry contract contains duplicate specifiers");

export function releasePackageSpecification(name) {
  const specification = RELEASE_PACKAGE_SPECS.find((entry) => entry.name === name);
  if (specification === undefined) throw new Error(`unknown release package: ${String(name)}`);
  return specification;
}

export function releasePackageDirectory(name) {
  return releasePackageSpecification(name).directory;
}

/** Match npm pack's canonical scoped-package filename (`@scope/name` -> `scope-name-version.tgz`). */
export function releaseArchiveFilename(name) {
  const specification = releasePackageSpecification(name);
  return `${specification.name.slice(1).replace("/", "-")}-${RELEASE_VERSION}.tgz`;
}

export function topologicalPackageOrder(specifications) {
  if (!Array.isArray(specifications) || specifications.length === 0 || specifications.length > 64) throw new TypeError("release package specifications are invalid");
  const byName = new Map();
  for (const specification of specifications) {
    if (specification === null || typeof specification !== "object" || typeof specification.name !== "string" || !Array.isArray(specification.dependencies)) throw new TypeError("release package specification is invalid");
    if (byName.has(specification.name)) throw new Error(`duplicate release package specification: ${specification.name}`);
    byName.set(specification.name, specification);
  }
  for (const specification of specifications) for (const dependency of specification.dependencies) {
    if (dependency === specification.name) throw new Error(`release package graph has a self-cycle: ${specification.name}`);
    if (!byName.has(dependency)) throw new Error(`release package graph has an unknown internal dependency: ${specification.name} -> ${dependency}`);
  }
  const remaining = new Map([...byName].map(([name, value]) => [name, new Set(value.dependencies)]));
  const ordered = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, dependencies]) => dependencies.size === 0).map(([name]) => name).sort(compareText);
    if (ready.length === 0) throw new Error(`release package graph contains a cycle: ${[...remaining.keys()].sort(compareText).join(", ")}`);
    for (const name of ready) { ordered.push(name); remaining.delete(name); for (const dependencies of remaining.values()) dependencies.delete(name); }
  }
  return ordered;
}

function packageSpec({
  name,
  directory,
  dependencies,
  peerDependencies = {},
  exports = ROOT_EXPORT,
  sideEffects = false,
  bin = {},
  productionEntries,
  buildConfig,
  buildInfo
}) {
  if (!Array.isArray(productionEntries)) throw new Error(`${name} must explicitly declare its production entries`);
  return deepFreeze({
    name,
    directory,
    dependencies: [...dependencies],
    peerDependencies: { ...peerDependencies },
    exports,
    sideEffects,
    bin: { ...bin },
    productionEntries: productionEntries.map((entry) => ({ ...entry })),
    buildConfig,
    buildInfo
  });
}

function typescriptBuild({
  config,
  compilerOptions = {},
  source = globSources(),
  additionalSources = [],
  buildSteps = [],
  sourceMaps = false
}) {
  return deepFreeze({
    config,
    compilerOptions: { ...compilerOptions },
    source,
    additionalSources: [...additionalSources],
    buildSteps: [...buildSteps],
    sourceMaps
  });
}

function fileSources(paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error("release file-source selection must not be empty");
  return deepFreeze({ kind: "files", paths: [...paths] });
}

function globSources(include = DEFAULT_INCLUDE, exclude = DEFAULT_EXCLUDE) {
  if (!Array.isArray(include) || include.length === 0 || !Array.isArray(exclude)) throw new Error("release glob-source selection is invalid");
  return deepFreeze({ kind: "globs", include: [...include], exclude: [...exclude] });
}

function productionPublicEntry(specification, entry) {
  if (entry === null || typeof entry !== "object" || typeof entry.export !== "string" || typeof entry.requiredInGraph !== "boolean") {
    throw new Error(`${specification.name} production entry selection is invalid`);
  }
  const target = specification.exports[entry.export]?.import;
  if (typeof target !== "string" || !target.startsWith("./dist/") || target.includes("..") || target.includes("\\")) throw new Error(`${specification.name} production export ${entry.export} has no safe import target`);
  if (entry.export !== "." && !/^\.\/[A-Za-z0-9_-]+$/u.test(entry.export)) throw new Error(`${specification.name} production export name is invalid: ${String(entry.export)}`);
  return deepFreeze({
    package: specification.name,
    export: entry.export,
    path: target.slice(2),
    specifier: entry.export === "." ? specification.name : `${specification.name}${entry.export.slice(1)}`,
    directory: specification.directory,
    requiredInGraph: entry.requiredInGraph
  });
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
