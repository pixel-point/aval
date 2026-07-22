#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  SOURCE_CODEC_PRIORITY
} from "@pixel-point/aval-element";
import { parseVideoCodecString } from "@pixel-point/aval-format";

import { analyzePngWitness, isMeaningfulPixelWitness } from "./brave/run-matrix.mjs";
import { assertCertificationPolicyIntegrity } from "./brave/resolve-builds.mjs";
import {
  DIAGNOSTIC_REPORT_SCHEMA,
  EVIDENCE_MANIFEST_SCHEMA,
  EVIDENCE_SESSION_SCHEMA,
  INTERACTION_LEDGER_SCHEMA
} from "./evidence-schema.mjs";
import { createSourceTreeAttestation } from "./source-tree-attestation.mjs";

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_PNG_BYTES = 32 * 1024 * 1024;
const VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+){1,3}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SESSION_PATTERN = /^[0-9]{8}T[0-9]{6}Z(?:-[a-z0-9][a-z0-9-]{0,47})?$/u;
const COUNTER_KEYS = Object.freeze([
  "outputsAccepted",
  "drawsCompleted",
  "logicalRunsCreated",
  "candidateCommits",
  "runsClosed",
  "transitionStarts",
  "transitionEnds",
  "loopCrossings"
]);
const LANE_COUNTER_KEYS = Object.freeze([
  "nativeDecoderCreatesByLane",
  "nativeDecoderClosesByLane"
]);
function codecFamily(value) {
  return typeof value === "string"
    ? parseVideoCodecString(value)?.family ?? null
    : null;
}

function sourceCodecFamily(value) {
  return typeof value === "string" && SOURCE_CODEC_PRIORITY.includes(value)
    ? value
    : null;
}

export async function validateEvidenceRun({
  repoRoot,
  runRoot,
  policyPath = "config/release/browser-certification-policy.json",
  createAttestation = createSourceTreeAttestation,
  servedFiles
}) {
  const absoluteRepoRoot = requireAbsoluteRoot(repoRoot, "evidence-repo-root-invalid");
  const absoluteRunRoot = requireContainedAbsoluteRoot(
    absoluteRepoRoot,
    runRoot,
    "evidence-run-root-invalid"
  );
  await Promise.all([
    requireRealDirectory(absoluteRepoRoot, "evidence-repo-root-invalid"),
    requireRealDirectory(absoluteRunRoot, "evidence-run-root-invalid")
  ]);
  const absolutePolicyPath = resolveContained(absoluteRepoRoot, policyPath);
  const [policy, policySchema, manifest] = await Promise.all([
    readJsonFile(absoluteRepoRoot, absolutePolicyPath, "evidence-policy-read-failed"),
    readJsonFile(
      absoluteRepoRoot,
      resolveContained(
        absoluteRepoRoot,
        "config/release/browser-certification-policy.schema.json"
      ),
      "evidence-policy-schema-read-failed"
    ),
    readJsonFile(
      absoluteRepoRoot,
      resolveContained(absoluteRunRoot, "manifest.json"),
      "evidence-manifest-read-failed"
    )
  ]);
  const validators = compileSchemas(policySchema);
  assertSchema(validators.policy, policy, "evidence-policy-schema-invalid");
  assertPolicyReadyForEvidence(policy);
  assertSchema(validators.manifest, manifest, "evidence-manifest-schema-invalid");
  assertImmutableRunRoot(absoluteRepoRoot, absoluteRunRoot, manifest);

  const actualAttestation = await createAttestation({
    root: absoluteRepoRoot,
    policyPath: absolutePolicyPath,
    artifactRunRoot: absoluteRunRoot,
    ...(servedFiles === undefined ? {} : { servedFiles })
  });
  assertAttestationMatches(manifest.sourceAttestation, actualAttestation);
  assertExactSlotSet(policy, manifest);

  let caseCount = 0;
  let checkpointCount = 0;
  const seenSessions = new Set();
  for (const manifestSlot of manifest.slots) {
    const policySlot = policy.slots.find(({ id }) => id === manifestSlot.slotId);
    if (policySlot === undefined) fail("evidence-policy-slot-extra", manifestSlot.slotId);
    if (manifestSlot.sessionPath !== `${manifestSlot.slotId}/session.json`) {
      fail("evidence-session-path-invalid", manifestSlot.slotId);
    }
    const session = await readJsonArtifact(
      absoluteRunRoot,
      manifestSlot.sessionPath,
      "evidence-session-read-failed"
    );
    assertSchema(validators.session, session, "evidence-session-schema-invalid");
    assertSessionMatchesPolicy(session, manifest, policySlot);
    const providerSessionKey = `${session.provider.kind}:${session.provider.sessionId}`;
    if (seenSessions.has(providerSessionKey)) {
      fail("evidence-provider-session-duplicate", providerSessionKey);
    }
    seenSessions.add(providerSessionKey);
    assertExactCaseSet(policy, policySlot, manifestSlot);
    for (const evidenceCase of manifestSlot.cases) {
      const demo = policy.requirements.demos.find(({ id }) => id === evidenceCase.demoId);
      if (demo === undefined) fail("evidence-demo-not-in-policy", evidenceCase.demoId);
      const expectedOutcome = policySlot.expectation === "playback"
        ? "playback"
        : "deterministic-error";
      if (evidenceCase.expectedOutcome !== expectedOutcome) {
        fail("evidence-case-outcome-mismatch", evidenceCase.id);
      }
      const expectedCodecs = expectedCodecsForCase(policy, evidenceCase);
      if (!sameArray(evidenceCase.expectedAuthoredCodecs, expectedCodecs)) {
        fail("evidence-authored-codecs-mismatch", evidenceCase.id);
      }
      if (expectedOutcome === "playback") {
        if (typeof evidenceCase.selectedCodec !== "string" ||
            !expectedCodecs.includes(evidenceCase.selectedCodec)) {
          fail("evidence-manifest-selected-codec-invalid", evidenceCase.id);
        }
        if (policySlot.platform === "ios" &&
            evidenceCase.mode === "full-ladder" &&
            !policy.requirements.minimumSelectedCodecsByPlatform.ios
              .includes(evidenceCase.selectedCodec)) {
          fail("evidence-ios-hevc-floor-not-met", evidenceCase.id);
        }
      } else if (evidenceCase.selectedCodec !== null) {
        fail("evidence-manifest-selected-codec-invalid", evidenceCase.id);
      }
      const ledger = await readJsonArtifact(
        absoluteRunRoot,
        evidenceCase.ledgerPath,
        "evidence-ledger-read-failed"
      );
      assertSchema(validators.ledger, ledger, "evidence-ledger-schema-invalid");
      assertLedgerIdentity(ledger, manifestSlot.slotId, evidenceCase, policySlot);
      const checkpoints = [];
      for (const checkpoint of evidenceCase.checkpoints) {
        checkpoints.push(await readAndValidateCheckpoint({
          absoluteRunRoot,
          checkpoint,
          demo,
          evidenceCase,
          expectedCodecs,
          expectedOutcome,
          ledger,
          manifestSlot,
          policySlot,
          session,
          reportValidator: validators.report
        }));
      }
      assertInteractionLedger(ledger, demo, evidenceCase, expectedOutcome, checkpoints);
      caseCount += 1;
      checkpointCount += checkpoints.length;
    }
  }
  const finalAttestation = await createAttestation({
    root: absoluteRepoRoot,
    policyPath: absolutePolicyPath,
    artifactRunRoot: absoluteRunRoot,
    ...(servedFiles === undefined ? {} : { servedFiles })
  });
  assertAttestationMatches(manifest.sourceAttestation, finalAttestation);
  return Object.freeze({
    schemaVersion: 1,
    sessionId: manifest.sessionId,
    slots: manifest.slots.length,
    cases: caseCount,
    checkpoints: checkpointCount,
    status: "verified"
  });
}

function compileSchemas(policySchema) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return Object.freeze({
    policy: ajv.compile(policySchema),
    manifest: ajv.compile(EVIDENCE_MANIFEST_SCHEMA),
    session: ajv.compile(EVIDENCE_SESSION_SCHEMA),
    ledger: ajv.compile(INTERACTION_LEDGER_SCHEMA),
    report: ajv.compile(DIAGNOSTIC_REPORT_SCHEMA)
  });
}

function assertSchema(validate, value, code) {
  if (!validate(value)) fail(code, formatSchemaErrors(validate.errors));
}

function assertPolicyReadyForEvidence(policy) {
  assertCertificationPolicyIntegrity(policy);
  if (policy.inventoryState !== "resolved" ||
      !Array.isArray(policy.unresolvedProductVersionSlotIds) ||
      policy.unresolvedProductVersionSlotIds.length !== 0) {
    fail("evidence-policy-inventory-unresolved");
  }
  for (const slot of policy.slots) {
    const version = String(slot?.browser?.version ?? "");
    if (!VERSION_PATTERN.test(version) || /(?:latest|default|current)/iu.test(version)) {
      fail("evidence-policy-browser-version-unresolved", slot?.id);
    }
  }
}

function assertImmutableRunRoot(repoRoot, runRoot, manifest) {
  const expected = resolve(
    repoRoot,
    "artifacts/browser-compatibility/runs",
    manifest.sourceAttestation.headCommit,
    manifest.sessionId
  );
  if (runRoot !== expected || basename(runRoot) !== manifest.sessionId ||
      basename(dirname(runRoot)) !== manifest.sourceAttestation.headCommit) {
    fail("evidence-run-root-not-immutable");
  }
  if (!COMMIT_PATTERN.test(manifest.sourceAttestation.headCommit) ||
      !SESSION_PATTERN.test(manifest.sessionId)) {
    fail("evidence-run-root-not-immutable");
  }
}

export function assertAttestationMatches(expected, actual) {
  for (const field of [
    "headCommit",
    "trackedDiffSha256",
    "untrackedSourceTreeSha256",
    "policySha256",
    "servedTreeSha256"
  ]) {
    if (expected?.[field] !== actual?.[field]) {
      fail(`evidence-attestation-${attestationFieldCode(field)}-mismatch`);
    }
  }
}

export function assertExactSlotSet(policy, manifest) {
  const policyIds = policy.slots.map(({ id }) => id);
  const manifestIds = manifest.slots.map(({ slotId }) => slotId);
  assertUnique(policyIds, "evidence-policy-slot-duplicate");
  assertUnique(manifestIds, "evidence-manifest-slot-duplicate");
  const manifestSet = new Set(manifestIds);
  const policySet = new Set(policyIds);
  const missing = policyIds.find((id) => !manifestSet.has(id));
  if (missing !== undefined) fail("evidence-policy-slot-missing", missing);
  const extra = manifestIds.find((id) => !policySet.has(id));
  if (extra !== undefined) fail("evidence-policy-slot-extra", extra);
}

function assertExactCaseSet(policy, policySlot, manifestSlot) {
  const expected = policySlot.demoIds.flatMap((demoId) =>
    policySlot.playbackModes.map((mode) => `${demoId}-${mode}`)
  );
  const actual = manifestSlot.cases.map(({ id }) => id);
  assertUnique(actual, "evidence-case-duplicate");
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.find((id) => !actualSet.has(id));
  if (missing !== undefined) fail("evidence-case-missing", `${manifestSlot.slotId}:${missing}`);
  const extra = actual.find((id) => !expectedSet.has(id));
  if (extra !== undefined) fail("evidence-case-extra", `${manifestSlot.slotId}:${extra}`);
  if (actual.length !== expected.length) fail("evidence-case-count-mismatch", manifestSlot.slotId);
  for (const evidenceCase of manifestSlot.cases) {
    if (evidenceCase.id !== `${evidenceCase.demoId}-${evidenceCase.mode}`) {
      fail("evidence-case-id-mismatch", evidenceCase.id);
    }
  }
}

export function assertSessionMatchesPolicy(session, manifest, policySlot) {
  if (session.sessionId !== manifest.sessionId || session.slotId !== policySlot.id) {
    fail("evidence-session-identity-mismatch", policySlot.id);
  }
  if (session.sourceCommit !== manifest.sourceAttestation.headCommit) {
    fail("evidence-source-commit-stale", policySlot.id);
  }
  if (session.provider.kind !== policySlot.provider.kind) {
    fail("evidence-session-provider-mismatch", policySlot.id);
  }
  if (session.os.name !== policySlot.os.name ||
      session.os.version !== policySlot.os.version) {
    fail("evidence-session-os-mismatch", policySlot.id);
  }
  const expectedDevice = policySlot.device?.name ?? null;
  if ((session.device?.name ?? null) !== expectedDevice) {
    fail("evidence-session-device-mismatch", policySlot.id);
  }
  if (session.browser.brand !== policySlot.browser.brand) {
    fail("evidence-session-browser-brand-mismatch", policySlot.id);
  }
  if (session.browser.version !== policySlot.browser.version) {
    fail("evidence-session-browser-version-mismatch", policySlot.id);
  }
  if (session.browser.engine !== policySlot.browser.engine ||
      session.browser.engineVersion !== policySlot.browser.engineVersion) {
    fail("evidence-session-browser-engine-mismatch", policySlot.id);
  }
  const tunnel = new URL(session.tunnelUrl);
  if (tunnel.protocol !== "https:" || tunnel.username !== "" || tunnel.password !== "" ||
      tunnel.hash !== "" || tunnel.search !== "" || tunnel.pathname !== "/") {
    fail("evidence-session-tunnel-url-invalid", policySlot.id);
  }
  const tunnelCreated = Date.parse(session.tunnelCreatedAt);
  const tested = Date.parse(session.testedAt);
  if (!Number.isFinite(tunnelCreated) || !Number.isFinite(tested) || tested < tunnelCreated) {
    fail("evidence-session-time-order-invalid", policySlot.id);
  }
}

export function expectedCodecsForCase(policy, evidenceCase) {
  return Object.freeze([
    ...policy.requirements.authoredCodecsByMode[evidenceCase.mode]
  ]);
}

async function readAndValidateCheckpoint({
  absoluteRunRoot,
  checkpoint,
  demo,
  evidenceCase,
  expectedCodecs,
  expectedOutcome,
  ledger,
  manifestSlot,
  policySlot,
  session,
  reportValidator
}) {
  const prefix = `${manifestSlot.slotId}/${demo.id}/${evidenceCase.mode}-${checkpoint.id}`;
  if (checkpoint.reportPath !== `${prefix}.json` ||
      checkpoint.pngPath !== `${prefix}.png` ||
      checkpoint.contextPngPath !== `${prefix}-context.png`) {
    fail("evidence-checkpoint-path-pair-invalid", evidenceCase.id);
  }
  if (expectedOutcome === "playback") {
    if (checkpoint.frameProof?.beforePngPath !== `${prefix}-before.png`) {
      fail("evidence-frame-proof-path-invalid", evidenceCase.id);
    }
  } else if (checkpoint.frameProof !== null || checkpoint.advancingFrame) {
    fail("evidence-frame-proof-outcome-mismatch", evidenceCase.id);
  }
  const [report, png, contextPng, beforePng] = await Promise.all([
    readJsonArtifact(absoluteRunRoot, checkpoint.reportPath, "evidence-report-missing"),
    readBinaryArtifact(absoluteRunRoot, checkpoint.pngPath, MAX_PNG_BYTES, "evidence-png-missing"),
    readBinaryArtifact(
      absoluteRunRoot,
      checkpoint.contextPngPath,
      MAX_PNG_BYTES,
      "evidence-context-png-missing"
    ),
    expectedOutcome === "playback"
      ? readBinaryArtifact(
        absoluteRunRoot,
        checkpoint.frameProof.beforePngPath,
        MAX_PNG_BYTES,
        "evidence-frame-before-png-missing"
      )
      : null
  ]);
  assertSchema(reportValidator, report, "evidence-report-schema-invalid");
  const expectedReportUrl =
    `${demo.route}?avalDiagnostics=1&avalCertificationMode=${evidenceCase.mode}`;
  if (report.session.url !== expectedReportUrl) {
    fail("evidence-report-certification-mode-mismatch", evidenceCase.id);
  }
  const reportCreated = Date.parse(report.generatedAt);
  const ledgerStarted = Date.parse(ledger.startedAt);
  const ledgerFinished = Date.parse(ledger.finishedAt);
  if (!Number.isFinite(reportCreated) || reportCreated < ledgerStarted ||
      reportCreated > ledgerFinished) {
    fail("evidence-report-time-outside-ledger", evidenceCase.id);
  }
  assertReportBrowserIdentity(report, session, policySlot);
  const pngSha256 = sha256(png);
  const contextPngSha256 = sha256(contextPng);
  const contextAnalysis = analyzeMeaningfulPng(
    contextPng,
    checkpoint.contextPngPath,
    "evidence-context-png"
  );
  let normalizedFrameProof = null;
  if (expectedOutcome === "playback") {
    assertPlaybackReport(
      report,
      checkpoint,
      expectedCodecs,
      evidenceCase.id,
      demo.renditionId
    );
    if (codecFamily(
      report.latest.element.diagnostics.runtime.selectedCodec
    ) !== evidenceCase.selectedCodec) {
      fail("evidence-selected-codec-changed", evidenceCase.id);
    }
    const analysis = analyzeMeaningfulPng(png, checkpoint.pngPath, "evidence-png");
    if (contextPngSha256 === pngSha256 || contextAnalysis.width < analysis.width ||
        contextAnalysis.height < analysis.height ||
        (contextAnalysis.width === analysis.width && contextAnalysis.height === analysis.height)) {
      fail("evidence-context-png-not-distinct", checkpoint.contextPngPath);
    }
    normalizedFrameProof = validateFrameProof(
      checkpoint,
      beforePng,
      png,
      evidenceCase.id
    );
  } else {
    assertDeterministicErrorReport(report, evidenceCase.id);
  }
  return Object.freeze({
    ...checkpoint,
    contextPngSha256,
    frameProof: normalizedFrameProof,
    pngSha256,
    report
  });
}

function analyzeMeaningfulPng(png, path, codePrefix) {
  let analysis;
  try {
    analysis = analyzePngWitness(png);
  } catch {
    fail(`${codePrefix}-invalid`, path);
  }
  if (!isMeaningfulPixelWitness(analysis)) {
    fail(`${codePrefix}-not-meaningful`, path);
  }
  return analysis;
}

function validateFrameProof(checkpoint, beforePng, afterPng, caseId) {
  const proof = checkpoint.frameProof;
  if (proof === null || beforePng === null) {
    fail("evidence-frame-proof-missing", caseId);
  }
  analyzeMeaningfulPng(beforePng, proof.beforePngPath, "evidence-frame-before-png");
  const beforePngSha256 = sha256(beforePng);
  const afterPngSha256 = sha256(afterPng);
  const observedAdvancing = beforePngSha256 !== afterPngSha256 &&
    proof.afterDrawsCompleted > proof.beforeDrawsCompleted;
  if (checkpoint.advancingFrame !== observedAdvancing ||
      proof.afterDrawsCompleted < proof.beforeDrawsCompleted) {
    fail("evidence-frame-proof-mismatch", caseId);
  }
  return Object.freeze({
    beforePngSha256,
    afterPngSha256,
    sampleIntervalMilliseconds: proof.sampleIntervalMilliseconds,
    beforeDrawsCompleted: proof.beforeDrawsCompleted,
    afterDrawsCompleted: proof.afterDrawsCompleted
  });
}

function assertPlaybackReport(
  report,
  checkpoint,
  expectedCodecs,
  caseId,
  expectedRendition
) {
  const latest = report.latest;
  const element = latest.element;
  const diagnostics = element.diagnostics;
  const runtime = diagnostics.runtime;
  if (report.serializationBudgetExhausted) {
    fail("evidence-report-truncated", caseId);
  }
  if (element.readiness !== "interactiveReady" || diagnostics.lastFailure !== null) {
    fail("evidence-terminal-failure", caseId);
  }
  if (element.visualState !== checkpoint.visualState) {
    fail("evidence-report-visual-state-mismatch", caseId);
  }
  if (!(diagnostics.presentation.backingWidth > 0) ||
      !(diagnostics.presentation.backingHeight > 0)) {
    fail("evidence-ready-canvas-mismatch", caseId);
  }
  const activeSources = report.authoredSources.filter(
    ({ playerId }) => playerId === latest.playerId
  );
  const actualCodecs = activeSources.map(({ codec }) => sourceCodecFamily(codec));
  if (actualCodecs.some((codec) => codec === null) ||
      !sameArray(actualCodecs, expectedCodecs)) {
    fail("evidence-authored-codecs-mismatch", caseId);
  }
  const selected = codecFamily(runtime.selectedCodec);
  if (selected === null || !expectedCodecs.includes(selected) ||
      runtime.selectedRendition !== expectedRendition) {
    fail("evidence-selected-codec-mismatch", caseId);
  }
  const selectedOffset = actualCodecs.indexOf(selected);
  const decoderDiagnostics = Array.isArray(runtime.decoderDiagnostics)
    ? runtime.decoderDiagnostics
    : [];
  const rendererDiagnostics = Array.isArray(runtime.rendererDiagnostics)
    ? runtime.rendererDiagnostics
    : [];
  for (const source of activeSources.slice(0, selectedOffset)) {
    const scopedDecoderDiagnostics = decoderDiagnostics.filter((diagnostic) =>
      diagnosticMatchesCandidate(
        diagnostic,
        source,
        diagnostics.sourceGeneration,
        expectedRendition
      )
    );
    const scopedRendererDiagnostics = rendererDiagnostics.filter((diagnostic) =>
      diagnosticMatchesCandidate(
        diagnostic,
        source,
        diagnostics.sourceGeneration,
        expectedRendition
      )
    );
    if (
      scopedDecoderDiagnostics.length + scopedRendererDiagnostics.length === 0 ||
      !scopedDecoderDiagnostics.every(permittedStartupDecoderFailure) ||
      !scopedRendererDiagnostics.every(permittedStartupRendererFailure)
    ) {
      fail(
        "evidence-unproven-codec-skip",
        `${caseId}:${String(sourceCodecFamily(source.codec))}`
      );
    }
  }
}

export function assertReportBrowserIdentity(report, session, policySlot) {
  const environment = report?.environment;
  const userAgent = environment?.userAgent;
  if (typeof userAgent !== "string" || userAgent.length === 0) {
    fail("evidence-report-browser-identity-mismatch", policySlot.id);
  }
  if (!userAgentMatchesPlatform(userAgent, policySlot) ||
      (typeof environment?.userAgentData?.mobile === "boolean" &&
       environment.userAgentData.mobile !==
         (policySlot.platform === "android" || policySlot.platform === "ios"))) {
    fail("evidence-report-platform-identity-mismatch", policySlot.id);
  }
  const expectedBrand = policySlot.browser.brand;
  const expectedVersion = policySlot.browser.version;
  let observedVersion = null;
  if (expectedBrand === "Chrome") {
    observedVersion = userAgentBrowserVersion(userAgent, /\b(?:Chrome|CriOS)\/([0-9]+(?:\.[0-9]+){0,3})\b/u);
    const brands = userAgentDataBrands(environment.userAgentData);
    if (brands.length > 0 && !brands.some((brand) =>
      /^(?:Google Chrome|Chrome)$/iu.test(brand)
    )) {
      fail("evidence-report-browser-identity-mismatch", policySlot.id);
    }
  } else if (expectedBrand === "Firefox") {
    observedVersion = userAgentBrowserVersion(userAgent, /\b(?:Firefox|FxiOS)\/([0-9]+(?:\.[0-9]+){0,3})\b/u);
  } else if (expectedBrand === "Safari") {
    if (!/\bSafari\//u.test(userAgent) ||
        /\b(?:Chrome|CriOS|Chromium|Edg|OPR|Firefox|FxiOS)\//u.test(userAgent)) {
      fail("evidence-report-browser-identity-mismatch", policySlot.id);
    }
    observedVersion = userAgentBrowserVersion(userAgent, /\bVersion\/([0-9]+(?:\.[0-9]+){0,3})\b/u);
  } else if (expectedBrand === "Brave") {
    observedVersion = userAgentBrowserVersion(userAgent, /\bChrome\/([0-9]+(?:\.[0-9]+){0,3})\b/u);
    if (environment?.capabilities?.braveBrandApi !== true ||
        !majorVersionMatches(observedVersion, policySlot.browser.engineVersion)) {
      fail("evidence-report-browser-identity-mismatch", policySlot.id);
    }
    return;
  } else {
    fail("evidence-report-browser-identity-mismatch", policySlot.id);
  }
  const productVersionMatches = expectedBrand === "Safari" &&
      policySlot.platform === "ios"
    ? majorVersionMatches(observedVersion, expectedVersion)
    : versionPrefixMatches(observedVersion, expectedVersion);
  if (!productVersionMatches ||
      session.browser.brand !== expectedBrand ||
      session.browser.version !== expectedVersion) {
    fail("evidence-report-browser-identity-mismatch", policySlot.id);
  }
}

function userAgentBrowserVersion(userAgent, pattern) {
  return pattern.exec(userAgent)?.[1] ?? null;
}

function userAgentDataBrands(value) {
  if (!Array.isArray(value?.brands)) return [];
  return value.brands.flatMap((entry) =>
    typeof entry?.brand === "string" ? [entry.brand] : []
  );
}

function versionPrefixMatches(observed, expected) {
  if (typeof observed !== "string" || typeof expected !== "string") return false;
  const observedParts = observed.split(".");
  const expectedParts = expected.split(".");
  const comparableLength = Math.min(observedParts.length, expectedParts.length);
  if (comparableLength === 0) return false;
  for (let index = 0; index < comparableLength; index += 1) {
    if (observedParts[index] !== expectedParts[index]) return false;
  }
  return true;
}

function majorVersionMatches(observed, expected) {
  return typeof observed === "string" && typeof expected === "string" &&
    observed.split(".")[0] === expected.split(".")[0];
}

function userAgentMatchesPlatform(userAgent, policySlot) {
  const platform = policySlot.platform;
  if (platform === "windows") return /\bWindows NT\b/u.test(userAgent);
  if (platform === "macos") {
    return /\bMacintosh\b/u.test(userAgent) && !/\b(?:iPhone|iPad|iPod)\b/u.test(userAgent);
  }
  if (platform === "ios") {
    const osToken = String(policySlot.os.version).replaceAll(".", "_");
    return /\b(?:iPhone|iPad|iPod)\b/u.test(userAgent) &&
      new RegExp(`\\bOS ${escapeRegExp(osToken)}(?:_|\\b)`, "u").test(userAgent);
  }
  if (platform === "android") {
    return /\bAndroid\b/u.test(userAgent) && /\bMobile\b/u.test(userAgent);
  }
  return false;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function diagnosticMatchesCandidate(
  diagnostic,
  source,
  sourceGeneration,
  expectedRendition
) {
  if (diagnostic?.sourceGeneration !== sourceGeneration ||
      diagnostic?.sourceIndex !== source.index ||
      codecFamily(diagnostic?.codec) !== sourceCodecFamily(source.codec) ||
      diagnostic?.rendition !== expectedRendition) return false;
  return true;
}

function permittedStartupDecoderFailure(diagnostic) {
  if (diagnostic.code === "unsupported-config") {
    return [
      "probe",
      "configure",
      "decode",
      "flush",
      "output-validation"
    ].includes(diagnostic.phase);
  }
  if (diagnostic.code === "invalid-output") {
    return diagnostic.phase === "output-validation" &&
      diagnostic.outputFailure !== null &&
      typeof diagnostic.outputFailure === "object";
  }
  return diagnostic.code === "decoder-operation" &&
    ["probe", "configure", "decode", "flush", "output-validation"]
      .includes(diagnostic.phase) &&
    ["EncodingError", "NotSupportedError"].includes(diagnostic.exception?.name);
}

function permittedStartupRendererFailure(diagnostic) {
  return diagnostic?.phase === "rgba-copy" &&
    diagnostic?.operation === "runtime" &&
    diagnostic?.exception?.name === "NotSupportedError" &&
    diagnostic?.glError === null &&
    diagnostic?.contextLost === false &&
    diagnostic?.uploadPath === "rgba-copy";
}

function assertDeterministicErrorReport(report, caseId) {
  const element = report.latest.element;
  const failure = element.diagnostics.lastFailure;
  if (report.serializationBudgetExhausted) fail("evidence-report-truncated", caseId);
  if (element.readiness !== "error" || failure?.code !== "unsupported-browser" ||
      element.visualState !== null ||
      element.diagnostics.runtime.selectedCodec !== null ||
      element.diagnostics.runtime.selectedRendition !== null) {
    fail("evidence-unsupported-error-mismatch", caseId);
  }
  assertRetiredUnsupportedRuntime(element.diagnostics, caseId);
}

function assertRetiredUnsupportedRuntime(diagnostics, caseId) {
  const runtime = diagnostics.runtime;
  const activeCounters = [
    "activeTransportBodies",
    "pendingLoads",
    "interestedWaiters",
    "activeLeaseCount",
    "pageActiveDecoderSlotCount",
    "pageQueuedDecoderTicketCount",
    "pageParkedDecoderTicketCount",
    "pageParticipantCount"
  ];
  if (activeCounters.some((key) => runtime?.[key] !== 0) ||
      runtime?.cleanupFailureCount !== 0 ||
      diagnostics.terminalCleanup === null ||
      diagnostics.terminalCleanup?.completed !== true ||
      diagnostics.terminalCleanup?.sourceCleanupCompleted !== true ||
      diagnostics.presentation?.backingWidth !== 0 ||
      diagnostics.presentation?.backingHeight !== 0) {
    fail("evidence-unsupported-resources-not-retired", caseId);
  }
  const outstanding = diagnostics.outstanding;
  if (outstanding === null || typeof outstanding !== "object" ||
      Array.isArray(outstanding) ||
      Object.values(outstanding).some((value) => value !== 0)) {
    fail("evidence-unsupported-resources-not-retired", caseId);
  }
  const lifecycle = runtime?.playbackLifecycle;
  if (lifecycle === null || typeof lifecycle !== "object" ||
      lifecycle.runsClosed !== lifecycle.logicalRunsCreated ||
      !sameArray(lifecycle.nativeDecoderCreatesByLane, lifecycle.nativeDecoderClosesByLane)) {
    fail("evidence-unsupported-resources-not-retired", caseId);
  }
}

function assertLedgerIdentity(ledger, slotId, evidenceCase, policySlot) {
  if (ledger.slotId !== slotId || ledger.demoId !== evidenceCase.demoId ||
      ledger.mode !== evidenceCase.mode ||
      ledger.interactionProfile !== policySlot.interactionProfile) {
    fail("evidence-ledger-identity-mismatch", evidenceCase.id);
  }
  const started = Date.parse(ledger.startedAt);
  const finished = Date.parse(ledger.finishedAt);
  const wallClockMilliseconds = finished - started;
  if (!Number.isFinite(started) || !Number.isFinite(finished) ||
      wallClockMilliseconds < 60_000 ||
      wallClockMilliseconds < ledger.soak.requiredMilliseconds ||
      wallClockMilliseconds < ledger.soak.elapsedMilliseconds) {
    fail("evidence-ledger-time-order-invalid", evidenceCase.id);
  }
  let previousEventTime = -1;
  for (const event of ledger.events) {
    if (event.atMilliseconds < previousEventTime ||
        event.atMilliseconds > wallClockMilliseconds) {
      fail("evidence-ledger-event-time-invalid", evidenceCase.id);
    }
    previousEventTime = event.atMilliseconds;
  }
  if (ledger.soak.samples.some(({ elapsedMilliseconds }) =>
    elapsedMilliseconds > wallClockMilliseconds
  )) {
    fail("evidence-soak-time-outside-ledger", evidenceCase.id);
  }
}

export function assertInteractionLedger(
  ledger,
  demo,
  evidenceCase,
  expectedOutcome,
  checkpoints
) {
  if (ledger.terminalFailures !== 0 ||
      ledger.soak.samples.some(({ terminalFailures }) => terminalFailures !== 0)) {
    fail("evidence-terminal-failure", evidenceCase.id);
  }
  assertUnique(
    checkpoints.map(({ id }) => id),
    "evidence-checkpoint-duplicate"
  );
  assertUnique(
    ledger.visualCheckpoints.map(({ id }) => id),
    "evidence-ledger-checkpoint-duplicate"
  );
  const checkpointById = new Map(checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
  const ledgerById = new Map(ledger.visualCheckpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
  if (checkpointById.size !== ledgerById.size) {
    fail("evidence-ledger-checkpoint-set-mismatch", evidenceCase.id);
  }
  for (const [id, checkpoint] of checkpointById) {
    const recorded = ledgerById.get(id);
    if (recorded === undefined || recorded.visualState !== checkpoint.visualState ||
        recorded.advancingFrame !== checkpoint.advancingFrame ||
        recorded.pngSha256 !== checkpoint.pngSha256 ||
        recorded.contextPngSha256 !== checkpoint.contextPngSha256 ||
        !sameFrameProof(recorded.frameProof, checkpoint.frameProof)) {
      fail("evidence-ledger-checkpoint-mismatch", `${evidenceCase.id}:${id}`);
    }
  }
  const records = [...checkpointById.values()];
  for (let left = 0; left < records.length; left += 1) {
    for (let right = left + 1; right < records.length; right += 1) {
      if (records[left].pngSha256 !== records[right].pngSha256) continue;
      if (records[left].visualState !== records[right].visualState ||
          records[left].advancingFrame || records[right].advancingFrame) {
        fail("evidence-png-state-hash-reused", evidenceCase.id);
      }
    }
  }
  assertSoak(ledger.soak, expectedOutcome, evidenceCase.id);
  if (expectedOutcome !== "playback") return;
  const required = interactionRequirements(demo);
  const checkpointStates = new Set(records.map(({ visualState }) => visualState));
  for (const state of required.states) {
    if (!checkpointStates.has(state)) {
      fail("evidence-visual-state-screenshot-missing", `${evidenceCase.id}:${state}`);
    }
  }
  if (!records.some(({ advancingFrame }) => advancingFrame)) {
    fail("evidence-advancing-frame-missing", evidenceCase.id);
  }
  const states = new Set(ledger.events.flatMap(({ type, to }) =>
    type === "visualstatechange" && typeof to === "string" ? [to] : []
  ));
  for (const state of required.states) {
    if (!states.has(state)) fail("evidence-visual-state-missing", `${evidenceCase.id}:${state}`);
  }
  for (const edge of required.edges) {
    const starts = ledger.events.filter((event) =>
      event.type === "transitionstart" && event.edge === edge
    );
    const ends = ledger.events.filter((event) =>
      event.type === "transitionend" && event.edge === edge
    );
    if (starts.length === 0) fail("evidence-transitionstart-missing", `${evidenceCase.id}:${edge}`);
    if (ends.length === 0) fail("evidence-transitionend-missing", `${evidenceCase.id}:${edge}`);
    if (!starts.some((start) => ends.some((end) => end.atMilliseconds >= start.atMilliseconds))) {
      fail("evidence-transition-order-invalid", `${evidenceCase.id}:${edge}`);
    }
  }
}

function sameFrameProof(left, right) {
  if (left === null || right === null) return left === right;
  return left.beforePngSha256 === right.beforePngSha256 &&
    left.afterPngSha256 === right.afterPngSha256 &&
    left.sampleIntervalMilliseconds === right.sampleIntervalMilliseconds &&
    left.beforeDrawsCompleted === right.beforeDrawsCompleted &&
    left.afterDrawsCompleted === right.afterDrawsCompleted;
}

function assertSoak(soak, expectedOutcome, caseId) {
  if (soak.requiredMilliseconds !== 60_000 || soak.elapsedMilliseconds < 60_000) {
    fail("evidence-soak-too-short", caseId);
  }
  let previous = null;
  for (const sample of soak.samples) {
    if (previous !== null) {
      if (sample.elapsedMilliseconds < previous.elapsedMilliseconds) {
        fail("evidence-soak-clock-nonmonotonic", caseId);
      }
      assertCountersMonotonic(previous.counters, sample.counters, caseId);
    }
    previous = sample;
  }
  const first = soak.samples[0];
  const last = soak.samples.at(-1);
  if (last.elapsedMilliseconds - first.elapsedMilliseconds < 60_000) {
    fail("evidence-soak-counter-window-too-short", caseId);
  }
  if (expectedOutcome === "playback" &&
      (last.counters.drawsCompleted <= first.counters.drawsCompleted ||
       last.counters.outputsAccepted <= first.counters.outputsAccepted)) {
    fail("evidence-soak-counters-not-advancing", caseId);
  }
}

function assertCountersMonotonic(previous, current, caseId) {
  for (const key of COUNTER_KEYS) {
    if (current[key] < previous[key]) fail("evidence-soak-counter-regressed", `${caseId}:${key}`);
  }
  for (const key of LANE_COUNTER_KEYS) {
    for (let lane = 0; lane < 2; lane += 1) {
      if (current[key][lane] < previous[key][lane]) {
        fail("evidence-soak-counter-regressed", `${caseId}:${key}:${String(lane)}`);
      }
    }
  }
}

function interactionRequirements(demo) {
  if (sameArray(demo.states, ["idle", "engaged"])) {
    return Object.freeze({
      states: demo.states,
      edges: Object.freeze(["idle.engaged", "engaged.idle"])
    });
  }
  if (sameArray(demo.states, ["idle", "entering", "hover", "exiting"])) {
    return Object.freeze({
      states: demo.states,
      edges: Object.freeze([
        "idle.entering",
        "entering.hover",
        "hover.exiting",
        "exiting.idle",
        "entering.exiting",
        "exiting.entering"
      ])
    });
  }
  fail("evidence-demo-state-contract-invalid", demo.id);
}

async function readJsonArtifact(runRoot, path, code) {
  return readJsonFile(runRoot, resolveContained(runRoot, path), code);
}

async function readJsonFile(root, path, code) {
  const bytes = await readBinaryFile(root, path, MAX_JSON_BYTES, code);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${code}-json-invalid`, path);
  }
}

async function readBinaryArtifact(runRoot, path, limit, code) {
  return readBinaryFile(runRoot, resolveContained(runRoot, path), limit, code);
}

async function readBinaryFile(root, path, limit, code) {
  try {
    await assertSymlinkFreePath(root, path, code);
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1n ||
        before.size > BigInt(limit) || before.nlink !== 1n) {
      fail(code, path);
    }
    const [rootReal, fileReal] = await Promise.all([realpath(root), realpath(path)]);
    assertContained(rootReal, fileReal, code);
    const bytes = await readFile(path);
    const after = await lstat(path, { bigint: true });
    if (!sameFileSnapshot(before, after) || BigInt(bytes.byteLength) !== after.size) {
      fail(`${code}-changed-during-read`, path);
    }
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${code}:`)) throw error;
    fail(code, path);
  }
}

async function assertSymlinkFreePath(root, path, code) {
  const relation = relative(root, path);
  assertContained(root, path, code);
  let current = root;
  for (const segment of relation.split(sep)) {
    current = resolve(current, segment);
    const status = await lstat(current);
    if (status.isSymbolicLink()) fail(code, current);
  }
}

async function requireRealDirectory(path, code) {
  try {
    const status = await lstat(path);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      fail(code);
    }
  } catch (error) {
    if (error instanceof Error && error.message === code) throw error;
    fail(code);
  }
}

function sameFileSnapshot(left, right) {
  return left.isFile() && right.isFile() &&
    left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.size === right.size && left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function requireAbsoluteRoot(value, code) {
  if (typeof value !== "string" || !isAbsolute(value)) fail(code);
  const root = resolve(value);
  if (root === resolve(sep)) fail(code);
  return root;
}

function requireContainedAbsoluteRoot(repoRoot, value, code) {
  const root = requireAbsoluteRoot(value, code);
  assertContained(repoRoot, root, code);
  return root;
}

function resolveContained(root, value) {
  if (typeof value !== "string" || value.includes("\\") || value.includes("\0")) {
    fail("evidence-path-invalid", String(value));
  }
  const path = resolve(root, value);
  assertContained(root, path, "evidence-path-outside-root");
  return path;
}

function assertContained(root, path, code) {
  const relation = relative(root, path);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    fail(code, path);
  }
}

function assertUnique(values, code) {
  if (new Set(values).size !== values.length) fail(code);
}

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) &&
    left.length === right.length && left.every((value, index) => value === right[index]);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function attestationFieldCode(field) {
  return field.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)
    .replace(/-sha256$/u, "");
}

function formatSchemaErrors(errors) {
  return JSON.stringify((errors ?? []).slice(0, 8)).slice(0, 2_048);
}

function fail(code, detail = "") {
  throw new Error(detail === "" ? code : `${code}:${String(detail).slice(0, 2_048)}`);
}

function parseArguments(values) {
  const parsed = { policyPath: undefined, repoRoot: process.cwd(), runRoot: null };
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (index === 0 && !key.startsWith("-")) {
      parsed.runRoot = resolve(key);
      continue;
    }
    const value = values[++index] ?? null;
    if (key === "--policy") parsed.policyPath = value;
    else if (key === "--repo-root") parsed.repoRoot = value;
    else if (key === "--run-root") parsed.runRoot = value;
    else fail("evidence-validator-argument-invalid", key);
  }
  if (parsed.runRoot === null) {
    fail(
      "evidence-validator-usage",
      "RUN_ROOT [--repo-root ABSOLUTE] [--policy PATH]"
    );
  }
  parsed.repoRoot = resolve(parsed.repoRoot);
  parsed.runRoot = resolve(parsed.runRoot);
  return parsed;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const result = await validateEvidenceRun(args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
