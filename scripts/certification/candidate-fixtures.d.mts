import type * as Certification from "../../packages/certification/src/index.js";
import type { CandidateArtifact } from "../../packages/certification/src/model.js";
import type { DigestReference } from "../../packages/certification/src/model.js";
import type { DisplayPatternDefinition } from "../../packages/certification/src/display-pattern.js";
import type { RuntimeFixtureModel } from "../../packages/certification/src/runtime-scenario-ledger.js";

export function loadCandidateFixtureAuthority(
  candidate: Readonly<{ readonly artifacts: readonly CandidateArtifact[] }>,
  candidateManifestPath: string,
  certification: typeof Certification,
  options?: Readonly<{
    readonly maximumArtifactBytes?: number;
    readonly verificationHook?: (phase: "after-open" | "after-read", reference: DigestReference) => Promise<void>;
  }>
): Promise<Readonly<{
  digests: ReadonlySet<string>;
  models: ReadonlyMap<string, RuntimeFixtureModel>;
  displayPatterns: ReadonlyMap<string, DisplayPatternDefinition>;
  fatalBoundaryFixtureDigests: ReadonlySet<string>;
  harnessDigests: ReadonlySet<string>;
}>>;
