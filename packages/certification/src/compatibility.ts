export const PUBLIC_RELEASE_PACKAGES = Object.freeze([
  "@pixel-point/aval-graph",
  "@pixel-point/aval-format",
  "@pixel-point/aval-element",
  "@pixel-point/aval-player-web",
  "@pixel-point/aval-compiler",
  "@pixel-point/aval-react"
] as const);

type PublicReleasePackage = (typeof PUBLIC_RELEASE_PACKAGES)[number];

interface PublicReleasePackageContract {
  readonly dependencies: readonly PublicReleasePackage[];
  readonly peerDependencies: Readonly<Record<string, string>> | undefined;
  readonly exports: Readonly<Record<string, unknown>>;
  readonly sideEffects: boolean | readonly string[];
  readonly bin: Readonly<Record<string, string>> | undefined;
}

const ROOT_EXPORT = Object.freeze({
  ".": Object.freeze({ types: "./dist/index.d.ts", import: "./dist/index.js" })
});

export const PUBLIC_RELEASE_PACKAGE_CONTRACTS = Object.freeze({
  "@pixel-point/aval-graph": releaseContract({ dependencies: [] }),
  "@pixel-point/aval-format": releaseContract({ dependencies: ["@pixel-point/aval-graph"] }),
  "@pixel-point/aval-element": releaseContract({
    dependencies: ["@pixel-point/aval-graph", "@pixel-point/aval-format"],
    exports: {
      ...ROOT_EXPORT,
      "./auto": { types: "./dist/auto.d.ts", import: "./dist/auto.js" }
    },
    sideEffects: ["./dist/auto.js"]
  }),
  "@pixel-point/aval-player-web": releaseContract({ dependencies: ["@pixel-point/aval-graph", "@pixel-point/aval-format"] }),
  "@pixel-point/aval-compiler": releaseContract({
    dependencies: ["@pixel-point/aval-graph", "@pixel-point/aval-format", "@pixel-point/aval-player-web", "@pixel-point/aval-element"],
    bin: { avl: "./dist/cli.js" }
  }),
  "@pixel-point/aval-react": releaseContract({
    dependencies: ["@pixel-point/aval-element"],
    peerDependencies: { react: "^18.3.0 || ^19.0.0" }
  })
} satisfies Readonly<Record<PublicReleasePackage, PublicReleasePackageContract>>);

export const PUBLIC_RELEASE_DEPENDENCIES = mapPackageContracts(
  (contract) => contract.dependencies
);

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
  readonly bin?: Readonly<Record<string, string>>;
  readonly types?: string;
  readonly engines?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
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
    const contract = PUBLIC_RELEASE_PACKAGE_CONTRACTS[name];
    if (manifest.version !== "1.0.0") failures.push(`${name}: version must be 1.0.0`);
    if (manifest.private !== false) failures.push(`${name}: private must be explicitly false`);
    if (manifest.type !== "module") failures.push(`${name}: package must be ESM`);
    if (JSON.stringify(manifest.exports) !== JSON.stringify(contract.exports)) failures.push(`${name}: exports must match the reviewed public contract`);
    if (JSON.stringify(manifest.files) !== JSON.stringify(["dist", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"])) failures.push(`${name}: files must match the exact public allowlist`);
    if (manifest.license !== "MIT") failures.push(`${name}: license must be MIT`);
    if (JSON.stringify(manifest.sideEffects) !== JSON.stringify(contract.sideEffects)) failures.push(`${name}: sideEffects must match the reviewed public contract`);
    if (JSON.stringify(manifest.bin) !== JSON.stringify(contract.bin)) failures.push(`${name}: bin must match the reviewed public contract`);
    if (manifest.engines?.node !== ">=22.12.0") failures.push(`${name}: minimum Node must be exact policy text >=22.12.0`);
    const internal = Object.entries(manifest.dependencies ?? {});
    const expected = [...contract.dependencies].sort();
    const actual = internal.map(([dependency]) => dependency).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${name}: internal dependencies must be exactly ${expected.join(", ") || "none"}`);
    for (const [dependency, version] of internal) if (version !== "1.0.0") failures.push(`${name}: internal dependency ${dependency} must be exactly 1.0.0`);
    if (JSON.stringify(manifest.peerDependencies) !== JSON.stringify(contract.peerDependencies)) failures.push(`${name}: peer dependencies must match the reviewed public contract`);
  }
  for (const manifest of manifests) if (!isPublicReleasePackage(manifest.name)) failures.push(`${manifest.name}: not in public release policy`);
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

function releaseContract({
  dependencies,
  peerDependencies,
  exports = ROOT_EXPORT,
  sideEffects = false,
  bin
}: Readonly<{
  dependencies: readonly PublicReleasePackage[];
  peerDependencies?: Readonly<Record<string, string>>;
  exports?: Readonly<Record<string, unknown>>;
  sideEffects?: boolean | readonly string[];
  bin?: Readonly<Record<string, string>>;
}>): PublicReleasePackageContract {
  return deepFreeze({ dependencies: [...dependencies], peerDependencies, exports, sideEffects, bin });
}

function mapPackageContracts<Value>(
  select: (contract: PublicReleasePackageContract) => Value
): Readonly<Record<PublicReleasePackage, Value>> {
  const entries = PUBLIC_RELEASE_PACKAGES.map((name) => [name, select(PUBLIC_RELEASE_PACKAGE_CONTRACTS[name])] as const);
  return Object.freeze(Object.fromEntries(entries)) as Readonly<Record<PublicReleasePackage, Value>>;
}

function isPublicReleasePackage(name: string): name is PublicReleasePackage {
  return Object.hasOwn(PUBLIC_RELEASE_PACKAGE_CONTRACTS, name);
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
