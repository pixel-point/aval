export interface FixtureDirectoryReplacement {
  readonly current: string;
  readonly staged: string;
}

export interface FixtureDirectoryTransactionOptions {
  readonly afterInstall?: (event: Readonly<{
    current: string;
    index: number;
  }>) => void | Promise<void>;
}

export function replaceDirectoriesTransactionally(
  replacements: readonly FixtureDirectoryReplacement[],
  options?: FixtureDirectoryTransactionOptions
): Promise<void>;
