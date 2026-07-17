export const RELEASE_VERSION = "1.0.0";
export const RELEASE_PACKAGE_SPECS = Object.freeze([
  packageSpec("@pixel-point/aval-graph", "graph", []),
  packageSpec("@pixel-point/aval-format", "format", ["@pixel-point/aval-graph"]),
  packageSpec("@pixel-point/aval-player-web", "player-web", ["@pixel-point/aval-graph", "@pixel-point/aval-format"]),
  packageSpec("@pixel-point/aval-element", "element", ["@pixel-point/aval-graph"]),
  packageSpec("@pixel-point/aval-compiler", "compiler", ["@pixel-point/aval-graph", "@pixel-point/aval-format", "@pixel-point/aval-player-web", "@pixel-point/aval-element"])
]);
export const RELEASE_PACKAGE_NAMES = Object.freeze(topologicalPackageOrder(RELEASE_PACKAGE_SPECS));

export function releasePackageDirectory(name) {
  const specification = RELEASE_PACKAGE_SPECS.find((entry) => entry.name === name);
  if (specification === undefined) throw new Error(`unknown release package: ${String(name)}`);
  return specification.directory;
}

/** Match npm pack's canonical scoped-package filename (`@scope/name` -> `scope-name-version.tgz`). */
export function releaseArchiveFilename(name) {
  const specification = RELEASE_PACKAGE_SPECS.find((entry) => entry.name === name);
  if (specification === undefined) throw new Error(`unknown release package: ${String(name)}`);
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

function packageSpec(name, directory, dependencies) { return Object.freeze({ name, directory, dependencies: Object.freeze([...dependencies]) }); }
function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
