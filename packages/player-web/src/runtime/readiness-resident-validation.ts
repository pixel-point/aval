import type {
  CompiledManifestV01,
  ResidencyEndpointV01,
  UnitV01
} from "@rendered-motion/format";

import { endpointEvidenceKey } from "./readiness-evidence-index.js";
import type {
  EndpointRecoveryEvidence,
  InitialRingReadinessEvidence,
  InverseReadinessEvidence,
  ReadinessFailureCollector,
  ResourceReadinessEvidence
} from "./readiness-evaluator-types.js";

export function verifyReversibleUnits(
  manifest: Readonly<CompiledManifestV01>,
  endpoints: ReadonlyMap<string, Readonly<EndpointRecoveryEvidence>>,
  inverses: ReadonlyMap<string, Readonly<InverseReadinessEvidence>>,
  collector: ReadinessFailureCollector
): void {
  for (const unit of manifest.units) {
    if (unit.kind !== "reversible") {
      continue;
    }
    for (const endpoint of unit.residency.endpoints) {
      verifyEndpoint(
        unit,
        endpoint,
        endpoints.get(endpointEvidenceKey({
          unit: unit.id,
          state: endpoint.state,
          port: endpoint.port
        })),
        collector
      );
    }
    verifyInverse(unit.id, inverses.get(unit.id), collector);
  }
}

export function verifyResource(
  resource: Readonly<ResourceReadinessEvidence> | undefined,
  collector: ReadinessFailureCollector
): void {
  if (
    resource === undefined ||
    !resource.passed ||
    !isNonNegativeSafeInteger(resource.totalBytes) ||
    !isNonNegativeSafeInteger(resource.capBytes) ||
    resource.totalBytes > resource.capBytes
  ) {
    collector.add(
      "resource-plan",
      "candidate resource accounting did not pass"
    );
  }
}

export function verifyInitialRing(
  initialRing: Readonly<InitialRingReadinessEvidence> | undefined,
  ringCapacity: number,
  collector: ReadinessFailureCollector
): void {
  if (
    initialRing === undefined ||
    !initialRing.passed ||
    !isNonNegativeSafeInteger(initialRing.frameCount) ||
    initialRing.frameCount < ringCapacity
  ) {
    collector.add("initial-ring", "initial presentation ring was not filled");
  }
}

function verifyEndpoint(
  unit: Extract<UnitV01, { readonly kind: "reversible" }>,
  endpoint: Readonly<ResidencyEndpointV01>,
  evidence: Readonly<EndpointRecoveryEvidence> | undefined,
  collector: ReadinessFailureCollector
): void {
  const context = { unit: unit.id, state: endpoint.state };
  if (evidence === undefined) {
    collector.add(
      "missing-endpoint",
      "reversible endpoint recovery evidence is missing",
      context
    );
    return;
  }
  if (
    !evidence.runwayPrepared ||
    evidence.runwayFrames !== endpoint.frames ||
    evidence.continuationFrame !== evidence.runwayFrames
  ) {
    collector.add(
      "endpoint-runway",
      "reversible endpoint runway is incomplete",
      context
    );
  }
  if (
    !isNonNegativeSafeInteger(evidence.recoveryFrames) ||
    evidence.recoveryFrames >= evidence.runwayFrames
  ) {
    collector.add(
      "endpoint-recovery",
      "endpoint recovery did not complete within its resident runway",
      context
    );
  }
  if (!evidence.deadlineSafe) {
    collector.add(
      "endpoint-deadline",
      "endpoint recovery missed a deadline",
      context
    );
  }
  if (!evidence.withinBudget) {
    collector.add(
      "endpoint-budget",
      "endpoint recovery exceeded its budget",
      context
    );
  }
}

function verifyInverse(
  unit: string,
  inverse: Readonly<InverseReadinessEvidence> | undefined,
  collector: ReadinessFailureCollector
): void {
  if (inverse === undefined) {
    collector.add("missing-inverse", "active inverse evidence is missing", {
      unit
    });
  } else if (inverse.responseFrames !== 1 || !inverse.adjacentFrame) {
    collector.add(
      "active-inverse",
      "active inverse did not select an adjacent frame in one tick",
      { unit }
    );
  }
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
