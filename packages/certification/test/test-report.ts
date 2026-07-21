import type { RuntimeCertificationReport } from "../src/model.js";
import { FATAL_ERROR_BOUNDARY_ATTACHMENT_ID, REQUIRED_RUNTIME_CRITERION_IDS, REQUIRED_RUNTIME_SCENARIOS, scenarioAttachmentId } from "../src/scenario-contract.js";

const digest = "a".repeat(64);

export function validRuntimeReport(): RuntimeCertificationReport {
  const scenarios = Array.from({ length: 3 }, (_, repetitionIndex) => {
    const repetition = repetitionIndex + 1;
    return [
      scenario(REQUIRED_RUNTIME_SCENARIOS.loop.id, repetition, { boundaryCount: 1_000, frameCount: 8_000 }),
      scenario(REQUIRED_RUNTIME_SCENARIOS.routes.id, repetition, { boundaryCount: 1_000, frameCount: 8_000 }),
      scenario(REQUIRED_RUNTIME_SCENARIOS.inverse.id, repetition, { boundaryCount: 1_000, frameCount: 4_000 }),
      scenario(REQUIRED_RUNTIME_SCENARIOS.portal.id, repetition, { boundaryCount: 1_000, frameCount: 8_000 }),
      scenario(REQUIRED_RUNTIME_SCENARIOS.rapidInput.id, repetition, { operationCount: 10_000, headedOperationCount: 1_000, frameCount: 1_000 }),
      scenario(REQUIRED_RUNTIME_SCENARIOS.throughput.id, repetition, { frameCount: 300 }),
      scenario(REQUIRED_RUNTIME_SCENARIOS.settlement.id, repetition, { frameCount: 0 })
    ];
  }).flat();
  const scenarioAttachments = scenarios.map((scenario) => ({
    id: scenarioAttachmentId(scenario.id, scenario.repetition),
    path: `raw/${scenario.id}-${String(scenario.repetition)}.json`,
    sha256: digest,
    byteLength: 1024,
    mediaType: "application/json"
  }));
  const attachments = [
    ...scenarioAttachments,
    {
      id: FATAL_ERROR_BOUNDARY_ATTACHMENT_ID,
      path: "raw/runtime-fatal-error-boundary.json",
      sha256: digest,
      byteLength: 1024,
      mediaType: "application/json"
    }
  ];
  return {
    schemaVersion: "1.0",
    reportKind: "runtime-scheduling",
    reportId: "runtime-macos-safari-1",
    status: "passed",
    candidateManifestDigest: digest,
    commit: "0123456789abcdef",
    tree: "fedcba9876543210",
    startedAt: "2026-07-12T10:00:00.000Z",
    endedAt: "2026-07-12T10:30:00.000Z",
    operatorRole: "certification-operator",
    reviewerIds: ["reviewer-a", "reviewer-b"],
    environment: {
      platformClass: "macos-26-apple-silicon",
      browser: {
        product: "Safari",
        version: "26.0.1",
        build: "20600.1.2",
        channel: "shipping",
        engineVersion: "WebKit 620.1.2",
        flags: [],
        profileClean: true
      },
      os: {
        product: "macOS",
        version: "26.0.1",
        build: "25A123",
        architecture: "arm64",
        patchState: "current"
      },
      hardware: {
        deviceClass: "Apple-Silicon-M1-or-later",
        cpu: "Apple M1",
        gpu: "Apple M1",
        driver: "Metal 4",
        physicalMemoryMiB: 16384,
        virtualization: "none",
        decoderMode: "unknown"
      },
      display: {
        displayClass: "built-in-liquid-retina",
        connection: "internal",
        nativeWidth: 3024,
        nativeHeight: 1964,
        width: 3024,
        height: 1964,
        refreshMilliHz: 120000,
        devicePixelRatioMilli: 2000,
        colorMode: "srgb",
        hdr: false,
        multiDisplay: false
      },
      power: {
        source: "ac",
        mode: "automatic",
        chargeRange: "80-100-percent",
        browserEnergyMode: "default",
        thermal: "nominal",
        backgroundLoad: "idle"
      },
      capabilities: {
        webCodecs: true,
        webgl2: true,
        maxTextureSize: 16384,
        codec: "avc1.42E00A"
      }
    },
    scenarios,
    criteria: REQUIRED_RUNTIME_CRITERION_IDS.map((id) => ({
      id,
      status: "passed" as const,
      evidence: id === "runtime-fatal-error-boundary"
        ? [FATAL_ERROR_BOUNDARY_ATTACHMENT_ID]
        : scenarioAttachments.map(({ id }) => id)
    })),
    attachments
  };
}

function scenario(
  id: string,
  repetition: number,
  counts: Readonly<{
    boundaryCount?: number;
    frameCount: number;
    operationCount?: number;
    headedOperationCount?: number;
  }>
): RuntimeCertificationReport["scenarios"][number] {
  return {
    id,
    repetition,
    seed: repetition,
    status: "passed",
    boundaryCount: counts.boundaryCount ?? 0,
    frameCount: counts.frameCount,
    ...(counts.operationCount === undefined ? {} : { operationCount: counts.operationCount }),
    ...(counts.headedOperationCount === undefined ? {} : { headedOperationCount: counts.headedOperationCount }),
    formatUnderflows: 0,
    ledgerDigest: digest
  };
}
