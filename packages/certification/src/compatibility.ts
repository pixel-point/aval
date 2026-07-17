export const PUBLIC_RELEASE_PACKAGES = Object.freeze([
  "@pixel-point/aval-graph",
  "@pixel-point/aval-format",
  "@pixel-point/aval-element",
  "@pixel-point/aval-player-web",
  "@pixel-point/aval-compiler"
] as const);

export const PUBLIC_RELEASE_DEPENDENCIES = Object.freeze({
  "@pixel-point/aval-graph": Object.freeze([]),
  "@pixel-point/aval-format": Object.freeze(["@pixel-point/aval-graph"]),
  "@pixel-point/aval-player-web": Object.freeze(["@pixel-point/aval-graph", "@pixel-point/aval-format"]),
  "@pixel-point/aval-element": Object.freeze([
    "@pixel-point/aval-graph",
    "@pixel-point/aval-format"
  ]),
  "@pixel-point/aval-compiler": Object.freeze(["@pixel-point/aval-graph", "@pixel-point/aval-format", "@pixel-point/aval-player-web", "@pixel-point/aval-element"])
} as const satisfies Readonly<Record<(typeof PUBLIC_RELEASE_PACKAGES)[number], readonly (typeof PUBLIC_RELEASE_PACKAGES)[number][]>>);

export type ApiClassification = "stable" | "experimental" | "deprecated" | "internal";

export interface ReleasePackageManifest {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly type?: string;
  readonly exports?: unknown;
  readonly files?: readonly string[];
  readonly license?: string;
  readonly sideEffects?: boolean | readonly string[];
  readonly types?: string;
  readonly engines?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
}

export function validateSynchronizedReleaseSet(manifests: readonly ReleasePackageManifest[]): readonly string[] {
  const failures: string[] = [];
  if (manifests.length !== PUBLIC_RELEASE_PACKAGES.length) failures.push(`release set must contain exactly ${String(PUBLIC_RELEASE_PACKAGES.length)} manifests`);
  const byName = new Map<string, ReleasePackageManifest>();
  for (const manifest of manifests) {
    if (byName.has(manifest.name)) failures.push(`${manifest.name}: duplicate manifest`);
    else byName.set(manifest.name, manifest);
  }
  for (const name of PUBLIC_RELEASE_PACKAGES) {
    const manifest = byName.get(name);
    if (manifest === undefined) {
      failures.push(`${name}: missing`);
      continue;
    }
    if (manifest.version !== "1.0.0") failures.push(`${name}: version must be 1.0.0`);
    if (manifest.private !== false) failures.push(`${name}: private must be explicitly false`);
    if (manifest.type !== "module") failures.push(`${name}: package must be ESM`);
    if (manifest.exports === undefined || manifest.exports === null || typeof manifest.exports !== "object") failures.push(`${name}: explicit exports are required`);
    else if (JSON.stringify(manifest.exports).includes('"source"') || JSON.stringify(manifest.exports).includes("/src/")) failures.push(`${name}: source-private exports are forbidden`);
    if (!Array.isArray(manifest.files) || !manifest.files.includes("dist") || !manifest.files.includes("README.md") || !manifest.files.includes("LICENSE") || !manifest.files.includes("THIRD_PARTY_NOTICES.md")) failures.push(`${name}: files must include dist, README.md, LICENSE, and THIRD_PARTY_NOTICES.md`);
    if (manifest.license !== "MIT") failures.push(`${name}: license must be MIT`);
    if (manifest.sideEffects === undefined) failures.push(`${name}: sideEffects must be explicit`);
    if (manifest.engines?.node !== ">=22.12.0") failures.push(`${name}: minimum Node must be exact policy text >=22.12.0`);
    const internal = Object.entries(manifest.dependencies ?? {});
    const expected = [...PUBLIC_RELEASE_DEPENDENCIES[name]].sort();
    const actual = internal.map(([dependency]) => dependency).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${name}: internal dependencies must be exactly ${expected.join(", ") || "none"}`);
    for (const [dependency, version] of internal) if (version !== "1.0.0") failures.push(`${name}: internal dependency ${dependency} must be exactly 1.0.0`);
  }
  for (const manifest of manifests) if (!PUBLIC_RELEASE_PACKAGES.includes(manifest.name as (typeof PUBLIC_RELEASE_PACKAGES)[number])) failures.push(`${manifest.name}: not in public release policy`);
  return failures;
}

export function validateApiClassifications(
  exports: readonly string[],
  classifications: Readonly<Record<string, ApiClassification>>,
  defaultClassification?: ApiClassification
): readonly string[] {
  const failures: string[] = [];
  const exported = new Set(exports);
  for (const name of exports) if (classifications[name] === undefined && defaultClassification === undefined) failures.push(`${name}: missing API classification`);
  for (const name of Object.keys(classifications)) if (!exported.has(name)) failures.push(`${name}: classification has no exported item`);
  return failures;
}
