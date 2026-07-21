import type { NamedProfileMatrixPolicy } from
  "../../packages/certification/src/report-index-criteria.js";

export const BROWSER_CERTIFICATION_POLICY_PATH:
  "config/release/browser-certification-policy.json";

/** Validates both policy documents and derives the canonical release matrix. */
export function deriveNamedProfileMatrixPolicy(
  namedProfiles: unknown,
  browserPolicy: unknown
): NamedProfileMatrixPolicy;

/** Resolves the browser-policy authority inside a candidate or repository root. */
export function resolveBrowserCertificationPolicyPath(
  namedProfiles: unknown,
  options?: Readonly<{
    candidateManifestPath?: string;
    repositoryRoot?: string;
  }>
): string;
