export function assertDistributionDerived(input: Readonly<{ source: string; sourceFiles: readonly string[]; distribution: string; packageName: string }>): Promise<Readonly<{ sourceFiles: readonly string[]; outputs: readonly string[] }>>;
export function buildFreshElementDistribution(root: string): Promise<void>;
export function buildFreshPublicDistributions(root: string): Promise<void>;
export function installVerifiedDistributions(input: Readonly<{ root: string; staged: ReadonlyMap<string, string>; backupRoot: string; renameEntry?: (source: string, target: string) => Promise<void>; removeEntry?: (path: string, options: Readonly<{ recursive: boolean; force: boolean }>) => Promise<void> }>): Promise<void>;
