export type ReleasePackageName =
  | "@pixel-point/aval-graph"
  | "@pixel-point/aval-format"
  | "@pixel-point/aval-player-web"
  | "@pixel-point/aval-element"
  | "@pixel-point/aval-compiler"
  | "@pixel-point/aval-react";

export type ReleaseBuildSource =
  | Readonly<{ kind: "files"; paths: readonly string[] }>
  | Readonly<{ kind: "globs"; include: readonly string[]; exclude: readonly string[] }>;

export interface ReleaseBuildConfig {
  readonly config: string;
  readonly compilerOptions: Readonly<Record<string, boolean>>;
  readonly source: ReleaseBuildSource;
  readonly additionalSources: readonly string[];
  readonly buildSteps: readonly string[];
  readonly sourceMaps: boolean;
}

export interface ReleaseProductionEntrySelection {
  readonly export: string;
  readonly requiredInGraph: boolean;
}

export interface ProductionPublicEntryDefinition {
  readonly package: ReleasePackageName;
  readonly export: string;
  readonly path: string;
  readonly specifier: string;
  readonly directory: string;
  readonly requiredInGraph: boolean;
}

export interface ReleasePackageSpecification {
  readonly name: ReleasePackageName;
  readonly directory: string;
  readonly dependencies: readonly ReleasePackageName[];
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly exports: Readonly<Record<string, unknown>>;
  readonly sideEffects: boolean | readonly string[];
  readonly bin: Readonly<Record<string, string>>;
  readonly productionEntries: readonly ReleaseProductionEntrySelection[];
  readonly buildConfig: ReleaseBuildConfig;
  readonly buildInfo: string;
}

export const RELEASE_VERSION: "1.0.0";
export const RELEASE_PACKAGE_NAMES: readonly ReleasePackageName[];
export const RELEASE_PACKAGE_SPECS: readonly ReleasePackageSpecification[];
export const PRODUCTION_PUBLIC_ENTRIES: readonly ProductionPublicEntryDefinition[];
export function releasePackageSpecification(name: string): ReleasePackageSpecification;
export function releasePackageDirectory(name: string): string;
export function releaseArchiveFilename(name: string): string;
export function topologicalPackageOrder(specifications: readonly Readonly<{ name: string; dependencies: readonly string[] }>[]): string[];
