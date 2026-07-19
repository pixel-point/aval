import type { DisplayPatternDefinition } from "./display-pattern.js";
import type { RuntimeFixtureModel } from "./runtime-scenario-ledger.js";

export interface ReportBundlePolicy {
  readonly maximumAttachmentBytes: number;
  readonly allowedMediaTypes: ReadonlySet<string>;
  readonly allowedFixtureDigests?: ReadonlySet<string>;
  /** Exact candidate artifact allowed as the fatal-boundary fault source. */
  readonly allowedFatalBoundaryFixtureDigests?: ReadonlySet<string>;
  /** Exact candidate certification harness digests allowed to produce the boundary witness. */
  readonly allowedCertificationHarnessDigests?: ReadonlySet<string>;
  /** Trusted models extracted from the exact candidate `.avl` bytes, keyed by their SHA-256. */
  readonly allowedFixtureModels?: ReadonlyMap<string, RuntimeFixtureModel>;
  /** Trusted display marker contracts extracted from exact candidate artifact bytes, keyed by SHA-256. */
  readonly allowedDisplayPatterns?: ReadonlyMap<string, DisplayPatternDefinition>;
  /** Explicit qualification authority for scanout trace providers; absent means that method cannot certify. */
  readonly allowedQualifiedScanoutProviders?: ReadonlyMap<string, string>;
  /** Qualified extractor tool/version pairs for raw capture -> observation derivation. */
  readonly allowedDisplayCaptureExtractors?: ReadonlyMap<string, string>;
  readonly allowedDisplayCaptureOperatorRoles?: ReadonlySet<string>;
  readonly allowedDisplayCaptureReviewerIds?: ReadonlySet<string>;
  /** Injectable byte source for deterministic verifier tests; production callers omit it. */
  readonly readAttachment?: (root: string, path: string) => Promise<Uint8Array>;
}
