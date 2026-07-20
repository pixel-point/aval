export interface ReleaseWorkerEntry {
  readonly packageName: string;
  readonly modulePackage: string;
  readonly output: string;
  readonly path: string;
  readonly search: string;
}

export const COMPILER_WORKER_REGISTRY_ENTRY: Readonly<{
  packageName: "@pixel-point/aval-compiler";
  output: "commands/dev-worker-entries.json";
  contents: string;
}>;
export const RELEASE_WORKER_ENTRIES: readonly Readonly<ReleaseWorkerEntry>[];
export function releaseWorkerEntry(packageName: string): Readonly<ReleaseWorkerEntry>;
