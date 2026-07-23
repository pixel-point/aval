export function packInstalledClosure(input: Readonly<{
  root: string;
  destination: string;
  packages: readonly string[];
}>): Promise<readonly string[]>;
