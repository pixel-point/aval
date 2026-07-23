export interface ReleasePolicy {
  readonly releaseVersion: "1.0.0";
  readonly publicPackages: readonly string[];
}

export {
  RELEASE_PACKAGE_NAMES,
  RELEASE_PACKAGE_SPECS,
  RELEASE_VERSION,
  PRODUCTION_PUBLIC_ENTRIES,
  releaseArchiveFilename,
  releasePackageDirectory,
  releasePackageSpecification,
  topologicalPackageOrder
} from "./release-set-model.mjs";
export type { ProductionPublicEntryDefinition, ReleaseBuildConfig, ReleaseBuildSource, ReleasePackageName, ReleasePackageSpecification, ReleaseProductionEntrySelection } from "./release-set-model.mjs";

export interface InspectedReleasePackage {
  readonly name: string;
  readonly version: "1.0.0";
  readonly filename: string;
  readonly path: string;
  readonly bytes: Buffer;
  readonly byteLength: number;
  readonly unpackedSize: number;
  readonly tarballSha256: string;
  readonly registryIntegrity: string;
  readonly fileListSha256: string;
  readonly files: readonly string[];
  readonly manifest: Readonly<Record<string, unknown>>;
}

export function validateReleasePolicy<T extends ReleasePolicy>(policy: T): T;
export function validateReleasePackageManifests<T extends object>(manifests: readonly T[]): readonly T[];
export function computeReleaseSetDigest(packages: readonly InspectedReleasePackage[]): string;
export function loadVerifiedReleaseSet(input: { directory: string; policy: ReleasePolicy; packageIndex?: unknown }): Promise<Readonly<{
  schemaVersion: "1.0";
  releaseVersion: "1.0.0";
  order: readonly string[];
  packages: readonly InspectedReleasePackage[];
  manifests: readonly Readonly<Record<string, unknown>>[];
  releaseSetDigest: string;
}>>;
export function reconcilePackageIndex(input: unknown, packages: readonly InspectedReleasePackage[]): void;
export function reconcilePackageInspection(input: unknown, releaseSet: Awaited<ReturnType<typeof loadVerifiedReleaseSet>>): void;
export function releaseSetSummary(releaseSet: Awaited<ReturnType<typeof loadVerifiedReleaseSet>>): Readonly<Record<string, unknown>>;
