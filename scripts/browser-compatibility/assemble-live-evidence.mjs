#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  unlink
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  parseVideoCodecString
} from "@pixel-point/aval-format";
import {
  SOURCE_CODEC_PRIORITY
} from "@pixel-point/aval-element";

import {
  DIAGNOSTIC_REPORT_SCHEMA,
  EVIDENCE_MANIFEST_SCHEMA,
  EVIDENCE_SESSION_SCHEMA,
  INTERACTION_LEDGER_SCHEMA
} from "./evidence-schema.mjs";
import {
  createSourceTreeAttestation,
  verifySourceTreeAttestation
} from "./source-tree-attestation.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIRECTORY, "../..");
const DEFAULT_POLICY_PATH =
  "config/release/browser-certification-policy.json";
const DEFAULT_POLICY_SCHEMA_PATH =
  "config/release/browser-certification-policy.schema.json";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SESSION_PATTERN =
  /^[0-9]{8}T[0-9]{6}Z(?:-[a-z0-9][a-z0-9-]{0,47})?$/u;
const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MODES = Object.freeze(["forced-h264", "full-ladder"]);
const CODECS = SOURCE_CODEC_PRIORITY;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const BRAVE_PROVENANCE_PATTERN =
  /^brave-(?:acquisition|manifest-fragment)-(?:macos|windows)-[a-z0-9-]+\.json$/u;
const SCHEMA_VALIDATORS = compileSchemas();
const POLICY_VALIDATOR_CACHE = new Map();
export const LIVE_EVIDENCE_RUN_IDENTITY_FILENAME = "run-identity.json";

function codecFamily(value) {
  return typeof value === "string"
    ? parseVideoCodecString(value)?.family ?? null
    : null;
}

function sourceCodecFamily(value) {
  return typeof value === "string" && CODECS.includes(value) ? value : null;
}

export async function assembleLiveEvidenceManifest({
  createAttestation = createSourceTreeAttestation,
  policyPath = DEFAULT_POLICY_PATH,
  repoRoot = DEFAULT_REPO_ROOT,
  runRoot,
  servedFiles
}) {
  const absoluteRepoRoot = await canonicalRealDirectory(
    repoRoot,
    "live-assembly-repo-root-invalid"
  );
  const absoluteRunRoot = await canonicalRealDirectory(
    runRoot,
    "live-assembly-run-root-invalid"
  );
  const normalizedIdentity = await readRunIdentityStable(absoluteRunRoot);
  assertImmutableRunRoot(absoluteRepoRoot, absoluteRunRoot, normalizedIdentity);

  const absolutePolicyPath = resolveContained(
    absoluteRepoRoot,
    policyPath,
    "live-assembly-policy-path-invalid"
  );
  const absolutePolicySchemaPath = resolveContained(
    absoluteRepoRoot,
    DEFAULT_POLICY_SCHEMA_PATH,
    "live-assembly-policy-schema-path-invalid"
  );
  const [policy, policySchema] = await Promise.all([
    readJsonStable(
      absolutePolicyPath,
      MAX_JSON_BYTES,
      "live-assembly-policy-read-failed"
    ),
    readJsonStable(
      absolutePolicySchemaPath,
      MAX_JSON_BYTES,
      "live-assembly-policy-schema-read-failed"
    )
  ]);
  assertPolicyReady(policy);
  assertSchema(
    compilePolicySchema(policySchema),
    policy,
    "live-assembly-policy-schema-invalid"
  );
  const attestationArguments = {
    root: absoluteRepoRoot,
    policyPath: absolutePolicyPath,
    artifactRunRoot: absoluteRunRoot,
    ...(servedFiles === undefined ? {} : { servedFiles })
  };
  const actualAttestation = await createAttestation(attestationArguments);
  verifySourceTreeAttestation(
    normalizedIdentity.sourceAttestation,
    actualAttestation
  );

  const rootEntries = await readDirectoryEntries(
    absoluteRunRoot,
    "live-assembly-run-root-read-failed"
  );
  const policySlotIds = policy.slots.map(({ id }) => id);
  assertUnique(policySlotIds, "live-assembly-policy-slot-duplicate");
  const actualSlotIds = rootEntries
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name);
  assertExactSet(
    policySlotIds,
    actualSlotIds,
    "live-assembly-slot-missing",
    "live-assembly-slot-extra"
  );
  for (const entry of rootEntries) {
    if (entry.isDirectory()) continue;
    if (entry.name === LIVE_EVIDENCE_RUN_IDENTITY_FILENAME && entry.isFile()) {
      continue;
    }
    if (!entry.isFile() || !BRAVE_PROVENANCE_PATTERN.test(entry.name)) {
      throw new Error(`live-assembly-artifact-extra:${entry.name}`);
    }
    await readJsonStable(
      resolve(absoluteRunRoot, entry.name),
      MAX_JSON_BYTES,
      "live-assembly-brave-provenance-invalid"
    );
  }

  const providerSessionIds = new Set();
  const manifestSlots = [];
  for (const policySlot of policy.slots) {
    const assembled = await assembleSlot({
      identity: normalizedIdentity,
      policy,
      policySlot,
      runRoot: absoluteRunRoot
    });
    const providerKey =
      `${assembled.providerKind}:${assembled.providerSessionId}`;
    if (providerSessionIds.has(providerKey)) {
      throw new Error(`live-assembly-provider-session-duplicate:${providerKey}`);
    }
    providerSessionIds.add(providerKey);
    manifestSlots.push(assembled.manifestSlot);
  }

  await validateBraveFragments(
    rootEntries,
    absoluteRunRoot,
    normalizedIdentity,
    manifestSlots
  );
  const manifest = Object.freeze({
    schemaVersion: 1,
    sessionId: normalizedIdentity.sessionId,
    createdAt: normalizedIdentity.createdAt,
    sourceAttestation: normalizedIdentity.sourceAttestation,
    slots: Object.freeze(manifestSlots)
  });
  assertSchema(
    SCHEMA_VALIDATORS.manifest,
    manifest,
    "live-assembly-manifest-schema-invalid"
  );
  verifySourceTreeAttestation(
    normalizedIdentity.sourceAttestation,
    await createAttestation(attestationArguments)
  );
  assertSameRunIdentity(
    normalizedIdentity,
    await readRunIdentityStable(absoluteRunRoot)
  );
  return manifest;
}

export async function writeLiveEvidenceManifestExclusive(runRoot, manifest) {
  const absoluteRunRoot = await canonicalRealDirectory(
    runRoot,
    "live-assembly-run-root-invalid"
  );
  assertSchema(
    SCHEMA_VALIDATORS.manifest,
    manifest,
    "live-assembly-manifest-schema-invalid"
  );
  const identity = await readRunIdentityStable(absoluteRunRoot);
  assertRunRootIdentitySuffix(absoluteRunRoot, identity);
  assertManifestIdentity(manifest, identity);
  const path = resolve(absoluteRunRoot, "manifest.json");
  await writeExclusiveJson(path, manifest);
  return path;
}

async function assembleSlot({ identity, policy, policySlot, runRoot }) {
  const slotRoot = resolveContained(
    runRoot,
    policySlot.id,
    "live-assembly-slot-path-invalid"
  );
  await requireRealDirectory(slotRoot, "live-assembly-slot-invalid");
  const entries = await readDirectoryEntries(
    slotRoot,
    "live-assembly-slot-read-failed"
  );
  const expectedNames = new Set(["session.json", ...policySlot.demoIds]);
  assertExactDirectoryLayout(
    entries,
    expectedNames,
    new Set(policySlot.demoIds),
    `live-assembly-slot-layout:${policySlot.id}`
  );

  const sessionPath = `${policySlot.id}/session.json`;
  const session = await readJsonStable(
    resolve(slotRoot, "session.json"),
    MAX_JSON_BYTES,
    "live-assembly-session-read-failed"
  );
  assertSchema(
    SCHEMA_VALIDATORS.session,
    session,
    `live-assembly-session-schema-invalid:${policySlot.id}`
  );
  assertSessionIdentity(session, identity, policySlot);

  const cases = [];
  for (const demoId of policySlot.demoIds) {
    const demo = policy.requirements.demos.find(({ id }) => id === demoId);
    if (demo === undefined) {
      throw new Error(`live-assembly-demo-policy-missing:${demoId}`);
    }
    const demoCases = await assembleDemoCases({
      demo,
      policy,
      policySlot,
      slotRoot
    });
    cases.push(...demoCases);
  }
  const expectedCaseIds = policySlot.demoIds.flatMap((demoId) =>
    policySlot.playbackModes.map((mode) => `${demoId}-${mode}`)
  );
  const actualCaseIds = cases.map(({ id }) => id);
  assertUnique(actualCaseIds, "live-assembly-case-duplicate");
  assertExactSet(
    expectedCaseIds,
    actualCaseIds,
    "live-assembly-case-missing",
    "live-assembly-case-extra"
  );
  return Object.freeze({
    providerKind: session.provider.kind,
    providerSessionId: session.provider.sessionId,
    manifestSlot: Object.freeze({
      slotId: policySlot.id,
      sessionPath,
      cases: Object.freeze(cases)
    })
  });
}

async function assembleDemoCases({
  demo,
  policy,
  policySlot,
  slotRoot
}) {
  const demoRoot = resolve(slotRoot, demo.id);
  await requireRealDirectory(demoRoot, "live-assembly-demo-directory-invalid");
  const entries = await readDirectoryEntries(
    demoRoot,
    "live-assembly-demo-directory-read-failed"
  );
  const ledgerEntries = entries.filter(({ name }) =>
    name.endsWith("-interaction-ledger.json")
  );
  const casesByMode = new Map();
  for (const entry of ledgerEntries) {
    if (!entry.isFile()) {
      throw new Error(`live-assembly-artifact-invalid:${demo.id}/${entry.name}`);
    }
    const ledger = await readJsonStable(
      resolve(demoRoot, entry.name),
      MAX_JSON_BYTES,
      "live-assembly-ledger-read-failed"
    );
    assertSchema(
      SCHEMA_VALIDATORS.ledger,
      ledger,
      `live-assembly-ledger-schema-invalid:${policySlot.id}/${demo.id}`
    );
    if (ledger.demoId !== demo.id || ledger.slotId !== policySlot.id ||
        ledger.interactionProfile !== policySlot.interactionProfile ||
        !MODES.includes(ledger.mode)) {
      throw new Error(`live-assembly-ledger-identity-mismatch:${policySlot.id}/${demo.id}`);
    }
    if (casesByMode.has(ledger.mode)) {
      throw new Error(`live-assembly-case-duplicate:${demo.id}-${ledger.mode}`);
    }
    casesByMode.set(ledger.mode, { entry, ledger });
  }
  assertExactSet(
    policySlot.playbackModes,
    [...casesByMode.keys()],
    "live-assembly-case-missing",
    "live-assembly-case-extra"
  );

  const allowedFiles = new Set();
  const cases = [];
  for (const mode of policySlot.playbackModes) {
    const { entry, ledger } = casesByMode.get(mode);
    const canonicalLedgerName = `${mode}-interaction-ledger.json`;
    if (entry.name !== canonicalLedgerName) {
      throw new Error(`live-assembly-case-path-invalid:${demo.id}-${mode}`);
    }
    allowedFiles.add(canonicalLedgerName);
    cases.push(await assembleCase({
      allowedFiles,
      demo,
      demoRoot,
      ledger,
      mode,
      policy,
      policySlot
    }));
  }
  for (const entry of entries) {
    if (!entry.isFile() || !allowedFiles.has(entry.name)) {
      throw new Error(
        `live-assembly-artifact-extra:${policySlot.id}/${demo.id}/${entry.name}`
      );
    }
  }
  return Object.freeze(cases);
}

async function assembleCase({
  allowedFiles,
  demo,
  demoRoot,
  ledger,
  mode,
  policy,
  policySlot
}) {
  const caseId = `${demo.id}-${mode}`;
  const expectedOutcome = policySlot.expectation === "playback"
    ? "playback"
    : "deterministic-error";
  if (!Array.isArray(ledger.visualCheckpoints) ||
      ledger.visualCheckpoints.length < 2 ||
      ledger.visualCheckpoints.length > 64) {
    throw new Error(`live-assembly-checkpoint-set-invalid:${caseId}`);
  }
  const checkpointIds = ledger.visualCheckpoints.map(({ id }) => id);
  if (checkpointIds.some((id) =>
    typeof id !== "string" || !IDENTIFIER_PATTERN.test(id)
  )) throw new Error(`live-assembly-checkpoint-id-invalid:${caseId}`);
  assertUnique(checkpointIds, "live-assembly-checkpoint-duplicate");

  let selectedCodec;
  let expectedAuthoredCodecs;
  const checkpoints = [];
  for (const ledgerCheckpoint of ledger.visualCheckpoints) {
    const checkpoint = await assembleCheckpoint({
      allowedFiles,
      caseId,
      demo,
      demoRoot,
      expectedOutcome,
      ledgerCheckpoint,
      mode,
      policySlot
    });
    if (expectedAuthoredCodecs === undefined) {
      expectedAuthoredCodecs = checkpoint.authoredCodecs;
      selectedCodec = checkpoint.selectedCodec;
    } else if (!sameArray(expectedAuthoredCodecs, checkpoint.authoredCodecs) ||
        selectedCodec !== checkpoint.selectedCodec) {
      throw new Error(`live-assembly-case-runtime-changed:${caseId}`);
    }
    checkpoints.push(checkpoint.manifestCheckpoint);
  }
  const requiredCodecs = expectedCodecsForCase(policy, mode);
  if (!sameArray(requiredCodecs, expectedAuthoredCodecs)) {
    throw new Error(`live-assembly-authored-codecs-mismatch:${caseId}`);
  }
  if (expectedOutcome === "playback") {
    if (typeof selectedCodec !== "string" ||
        !requiredCodecs.includes(selectedCodec)) {
      throw new Error(`live-assembly-selected-codec-invalid:${caseId}`);
    }
    const platformMinimum =
      policy.requirements.minimumSelectedCodecsByPlatform?.[policySlot.platform];
    if (mode === "full-ladder" && Array.isArray(platformMinimum) &&
        !platformMinimum.includes(selectedCodec)) {
      throw new Error(`live-assembly-platform-codec-floor:${caseId}`);
    }
  } else if (selectedCodec !== null) {
    throw new Error(`live-assembly-selected-codec-invalid:${caseId}`);
  }
  return Object.freeze({
    id: caseId,
    demoId: demo.id,
    mode,
    expectedOutcome,
    expectedAuthoredCodecs: Object.freeze([...requiredCodecs]),
    selectedCodec,
    checkpoints: Object.freeze(checkpoints),
    ledgerPath: `${policySlot.id}/${demo.id}/${mode}-interaction-ledger.json`
  });
}

async function assembleCheckpoint({
  allowedFiles,
  caseId,
  demo,
  demoRoot,
  expectedOutcome,
  ledgerCheckpoint,
  mode,
  policySlot
}) {
  if (typeof ledgerCheckpoint.advancingFrame !== "boolean" ||
      !SHA256_PATTERN.test(String(ledgerCheckpoint.pngSha256)) ||
      !SHA256_PATTERN.test(String(ledgerCheckpoint.contextPngSha256))) {
    throw new Error(`live-assembly-checkpoint-ledger-invalid:${caseId}`);
  }
  const stem = `${mode}-${ledgerCheckpoint.id}`;
  const reportName = `${stem}.json`;
  const pngName = `${stem}.png`;
  const contextName = `${stem}-context.png`;
  const relativeStem = `${policySlot.id}/${demo.id}/${stem}`;
  for (const name of [reportName, pngName, contextName]) allowedFiles.add(name);
  const [report, png, contextPng] = await Promise.all([
    readJsonStable(
      resolve(demoRoot, reportName),
      MAX_JSON_BYTES,
      "live-assembly-report-missing"
    ),
    readStableFile(
      resolve(demoRoot, pngName),
      MAX_ARTIFACT_BYTES,
      "live-assembly-png-missing"
    ),
    readStableFile(
      resolve(demoRoot, contextName),
      MAX_ARTIFACT_BYTES,
      "live-assembly-context-png-missing"
    )
  ]);
  assertSchema(
    SCHEMA_VALIDATORS.report,
    report,
    `live-assembly-report-schema-invalid:${caseId}`
  );
  if (sha256(png) !== ledgerCheckpoint.pngSha256 ||
      sha256(contextPng) !== ledgerCheckpoint.contextPngSha256) {
    throw new Error(`live-assembly-checkpoint-digest-mismatch:${caseId}`);
  }
  if (report?.latest?.element?.visualState !== ledgerCheckpoint.visualState) {
    throw new Error(`live-assembly-checkpoint-state-mismatch:${caseId}`);
  }
  const playerId = report?.latest?.playerId;
  if (typeof playerId !== "string" || playerId.length === 0 ||
      !Array.isArray(report.authoredSources)) {
    throw new Error(`live-assembly-report-active-player-invalid:${caseId}`);
  }
  const sources = report.authoredSources
    .filter((source) => source?.playerId === playerId)
    .sort((left, right) => left.index - right.index);
  if (sources.length === 0 || sources.some((source, index) =>
    source.index !== index || sourceCodecFamily(source.codec) === null
  )) throw new Error(`live-assembly-report-active-sources-invalid:${caseId}`);
  const authoredCodecs = Object.freeze(
    sources.map(({ codec }) => sourceCodecFamily(codec))
  );
  const rawSelected = report?.latest?.element?.diagnostics?.runtime?.selectedCodec;
  const selectedCodec = rawSelected === null ? null : codecFamily(rawSelected);
  if (rawSelected !== null && selectedCodec === null) {
    throw new Error(`live-assembly-selected-codec-invalid:${caseId}`);
  }

  let frameProof = null;
  if (expectedOutcome === "playback") {
    const proof = ledgerCheckpoint.frameProof;
    if (proof === null || typeof proof !== "object" ||
        !SHA256_PATTERN.test(String(proof.beforePngSha256)) ||
        proof.afterPngSha256 !== ledgerCheckpoint.pngSha256 ||
        !Number.isFinite(proof.sampleIntervalMilliseconds) ||
        proof.sampleIntervalMilliseconds < 1 ||
        proof.sampleIntervalMilliseconds > 5_000 ||
        !Number.isSafeInteger(proof.beforeDrawsCompleted) ||
        !Number.isSafeInteger(proof.afterDrawsCompleted) ||
        proof.beforeDrawsCompleted < 0 ||
        proof.afterDrawsCompleted < proof.beforeDrawsCompleted) {
      throw new Error(`live-assembly-frame-proof-invalid:${caseId}`);
    }
    const beforeName = `${stem}-before.png`;
    allowedFiles.add(beforeName);
    const beforePng = await readStableFile(
      resolve(demoRoot, beforeName),
      MAX_ARTIFACT_BYTES,
      "live-assembly-frame-before-png-missing"
    );
    if (sha256(beforePng) !== proof.beforePngSha256) {
      throw new Error(`live-assembly-frame-before-digest-mismatch:${caseId}`);
    }
    frameProof = Object.freeze({
      beforePngPath: `${relativeStem}-before.png`,
      sampleIntervalMilliseconds: proof.sampleIntervalMilliseconds,
      beforeDrawsCompleted: proof.beforeDrawsCompleted,
      afterDrawsCompleted: proof.afterDrawsCompleted
    });
  } else if (ledgerCheckpoint.frameProof !== null ||
      ledgerCheckpoint.advancingFrame) {
    throw new Error(`live-assembly-frame-proof-outcome-mismatch:${caseId}`);
  }
  return Object.freeze({
    authoredCodecs,
    selectedCodec,
    manifestCheckpoint: Object.freeze({
      id: ledgerCheckpoint.id,
      visualState: ledgerCheckpoint.visualState,
      advancingFrame: ledgerCheckpoint.advancingFrame,
      reportPath: `${relativeStem}.json`,
      pngPath: `${relativeStem}.png`,
      contextPngPath: `${relativeStem}-context.png`,
      frameProof
    })
  });
}

function expectedCodecsForCase(policy, mode) {
  return Object.freeze([
    ...policy.requirements.authoredCodecsByMode[mode]
  ]);
}

function assertPolicyReady(policy) {
  if (policy?.inventoryState !== "resolved" ||
      !Array.isArray(policy.unresolvedProductVersionSlotIds) ||
      policy.unresolvedProductVersionSlotIds.length !== 0) {
    throw new Error("certification-policy-inventory-unresolved");
  }
  for (const slot of policy.slots) {
    if (!/^[0-9]+(?:\.[0-9]+){1,3}$/u.test(String(slot?.browser?.version ?? ""))) {
      throw new Error(
        `certification-policy-browser-version-unresolved:${String(slot?.id)}`
      );
    }
    const engineVersion = slot?.browser?.engineVersion;
    if (engineVersion === null ? slot?.browser?.engine !== "WebKit" :
      !/^[0-9]+(?:\.[0-9]+){1,3}$/u.test(String(engineVersion))) {
      throw new Error(
        `certification-policy-engine-version-unresolved:${String(slot?.id)}`
      );
    }
  }
}

function compilePolicySchema(schema) {
  const cacheKey = sha256(Buffer.from(JSON.stringify(schema), "utf8"));
  const cached = POLICY_VALIDATOR_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  POLICY_VALIDATOR_CACHE.set(cacheKey, validate);
  return validate;
}

function compileSchemas() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return Object.freeze({
    ledger: ajv.compile(INTERACTION_LEDGER_SCHEMA),
    manifest: ajv.compile(EVIDENCE_MANIFEST_SCHEMA),
    report: ajv.compile(DIAGNOSTIC_REPORT_SCHEMA),
    session: ajv.compile(EVIDENCE_SESSION_SCHEMA)
  });
}

function assertSchema(validate, value, code) {
  if (validate(value)) return;
  const details = (validate.errors ?? [])
    .slice(0, 8)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`)
    .join("; ");
  throw new Error(`${code}:${details}`);
}

function assertSessionIdentity(session, identity, policySlot) {
  if (session?.schemaVersion !== 1 ||
      session.sessionId !== identity.sessionId ||
      session.slotId !== policySlot.id ||
      session.sourceCommit !== identity.sourceAttestation.headCommit) {
    throw new Error(`live-assembly-session-identity-mismatch:${policySlot.id}`);
  }
  if (session.provider?.kind !== policySlot.provider.kind ||
      typeof session.provider?.sessionId !== "string" ||
      session.provider.sessionId.length < 1) {
    throw new Error(`live-assembly-provider-session-invalid:${policySlot.id}`);
  }
  if (session.os?.name !== policySlot.os.name ||
      session.os?.version !== policySlot.os.version ||
      (session.device?.name ?? null) !== (policySlot.device?.name ?? null) ||
      session.browser?.brand !== policySlot.browser.brand ||
      session.browser?.version !== policySlot.browser.version ||
      session.browser?.engine !== policySlot.browser.engine ||
      session.browser?.engineVersion !== policySlot.browser.engineVersion) {
    throw new Error(`live-assembly-session-product-identity-mismatch:${policySlot.id}`);
  }
  if (policySlot.platform === "android" &&
      (typeof policySlot.browser.version !== "string" ||
       typeof policySlot.browser.engineVersion !== "string")) {
    throw new Error(`live-assembly-android-identity-unresolved:${policySlot.id}`);
  }
}

async function validateBraveFragments(entries, runRoot, identity, manifestSlots) {
  const expectedById = new Map(manifestSlots.map((slot) => [slot.slotId, slot]));
  const seen = new Set();
  for (const entry of entries) {
    if (!entry.name.startsWith("brave-manifest-fragment-")) continue;
    const fragment = await readJsonStable(
      resolve(runRoot, entry.name),
      MAX_JSON_BYTES,
      "live-assembly-brave-fragment-invalid"
    );
    if (fragment?.schemaVersion !== 1 ||
        fragment.sessionId !== identity.sessionId ||
        fragment.sourceCommit !== identity.sourceAttestation.headCommit ||
        !Array.isArray(fragment.slots)) {
      throw new Error(`live-assembly-brave-fragment-identity:${entry.name}`);
    }
    for (const slot of fragment.slots) {
      if (seen.has(slot?.slotId)) {
        throw new Error(`live-assembly-slot-duplicate:${String(slot?.slotId)}`);
      }
      seen.add(slot?.slotId);
      const assembled = expectedById.get(slot?.slotId);
      if (assembled === undefined ||
          !/brave/iu.test(String(slot?.slotId)) ||
          JSON.stringify(slot) !== JSON.stringify(assembled)) {
        throw new Error(`live-assembly-brave-fragment-mismatch:${String(slot?.slotId)}`);
      }
    }
  }
}

async function readRunIdentityStable(runRoot) {
  return normalizeAssemblyIdentity(await readJsonStable(
    resolve(runRoot, LIVE_EVIDENCE_RUN_IDENTITY_FILENAME),
    MAX_JSON_BYTES,
    "live-assembly-run-identity-read-failed"
  ));
}

function normalizeAssemblyIdentity(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !==
        "createdAt,schemaVersion,sessionId,sourceAttestation" ||
      value.schemaVersion !== 1 ||
      typeof value.sessionId !== "string" ||
      !SESSION_PATTERN.test(value.sessionId) ||
      typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error("live-assembly-identity-invalid");
  }
  const attestation = value.sourceAttestation;
  if (attestation === null || typeof attestation !== "object" ||
      Array.isArray(attestation) ||
      Object.keys(attestation).sort().join(",") !==
        "headCommit,policySha256,servedTreeSha256,trackedDiffSha256,untrackedSourceTreeSha256" ||
      !COMMIT_PATTERN.test(String(attestation.headCommit)) ||
      [
        "trackedDiffSha256",
        "untrackedSourceTreeSha256",
        "policySha256",
        "servedTreeSha256"
      ].some((key) => !SHA256_PATTERN.test(String(attestation[key])))) {
    throw new Error("live-assembly-source-attestation-invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    sessionId: value.sessionId,
    createdAt: new Date(value.createdAt).toISOString(),
    sourceAttestation: Object.freeze({
      headCommit: attestation.headCommit,
      trackedDiffSha256: attestation.trackedDiffSha256,
      untrackedSourceTreeSha256: attestation.untrackedSourceTreeSha256,
      policySha256: attestation.policySha256,
      servedTreeSha256: attestation.servedTreeSha256
    })
  });
}

function assertSameRunIdentity(expected, actual) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error("live-assembly-run-identity-changed");
  }
}

function assertManifestIdentity(manifest, identity) {
  if (manifest.sessionId !== identity.sessionId ||
      manifest.createdAt !== identity.createdAt ||
      JSON.stringify(manifest.sourceAttestation) !==
        JSON.stringify(identity.sourceAttestation)) {
    throw new Error("live-assembly-manifest-identity-mismatch");
  }
}

function assertImmutableRunRoot(repoRoot, runRoot, identity) {
  const expected = resolve(
    repoRoot,
    "artifacts/browser-compatibility/runs",
    identity.sourceAttestation.headCommit,
    identity.sessionId
  );
  if (runRoot !== expected) {
    throw new Error("live-assembly-run-root-not-immutable");
  }
  assertRunRootIdentitySuffix(runRoot, identity);
}

function assertRunRootIdentitySuffix(runRoot, identity) {
  if (basename(runRoot) !== identity.sessionId ||
      basename(dirname(runRoot)) !== identity.sourceAttestation.headCommit) {
    throw new Error("live-assembly-run-root-not-immutable");
  }
}

function requireAbsolutePath(value, code) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(code);
  return resolve(value);
}

async function canonicalRealDirectory(value, code) {
  const path = requireAbsolutePath(value, code);
  let status;
  let canonical;
  try {
    [status, canonical] = await Promise.all([lstat(path), realpath(path)]);
  } catch {
    throw new Error(code);
  }
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error(code);
  return resolve(canonical);
}

async function requireRealDirectory(path, code) {
  const [status, canonical] = await Promise.all([lstat(path), realpath(path)]);
  const comparablePath = process.platform === "win32" ? path.toLowerCase() : path;
  const comparableCanonical = process.platform === "win32"
    ? resolve(canonical).toLowerCase()
    : resolve(canonical);
  if (!status.isDirectory() || status.isSymbolicLink() ||
      comparablePath !== comparableCanonical) throw new Error(code);
}

async function readDirectoryEntries(path, code) {
  await requireRealDirectory(path, code);
  return readdir(path, { withFileTypes: true });
}

function assertExactDirectoryLayout(entries, expectedNames, directoryNames, code) {
  const actualNames = entries.map(({ name }) => name);
  assertExactSet(
    [...expectedNames],
    actualNames,
    `${code}:missing`,
    `${code}:extra`
  );
  for (const entry of entries) {
    if (directoryNames.has(entry.name) ? !entry.isDirectory() : !entry.isFile()) {
      throw new Error(`${code}:type:${entry.name}`);
    }
  }
}

function assertExactSet(expected, actual, missingCode, extraCode) {
  assertUnique(expected, `${missingCode}:expected-duplicate`);
  assertUnique(actual, `${extraCode}:duplicate`);
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.find((value) => !actualSet.has(value));
  if (missing !== undefined) throw new Error(`${missingCode}:${missing}`);
  const extra = actual.find((value) => !expectedSet.has(value));
  if (extra !== undefined) throw new Error(`${extraCode}:${extra}`);
  if (expected.length !== actual.length) throw new Error(`${extraCode}:count`);
}

function assertUnique(values, code) {
  if (new Set(values).size !== values.length) throw new Error(code);
}

async function readJsonStable(path, limit, code) {
  const bytes = await readStableFile(path, limit, code);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${code}:json-invalid`);
  }
}

async function writeExclusiveJson(path, value) {
  let handle = null;
  let failure = null;
  try {
    handle = await open(path, "wx", 0o444);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    failure = error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  if (failure === null) return;
  if (handle !== null) await unlink(path).catch(() => undefined);
  throw failure;
}

async function readStableFile(path, limit, code) {
  let before;
  try {
    before = await lstat(path, { bigint: true });
  } catch {
    throw new Error(code);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      before.size < 1n || before.size > BigInt(limit)) throw new Error(code);
  const canonical = resolve(await realpath(path));
  const comparablePath = process.platform === "win32" ? path.toLowerCase() : path;
  const comparableCanonical = process.platform === "win32"
    ? canonical.toLowerCase()
    : canonical;
  if (comparableCanonical !== comparablePath) throw new Error(code);
  const bytes = await readFile(path);
  const after = await lstat(path, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs || BigInt(bytes.byteLength) !== after.size) {
    throw new Error(`${code}:changed-during-read`);
  }
  return bytes;
}

function resolveContained(root, path, code) {
  const resolved = resolve(root, path);
  const relation = relative(root, resolved);
  if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`) ||
      isAbsolute(relation)) throw new Error(code);
  return resolved;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameArray(left, right) {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function parseArguments(values) {
  const parsed = {
    policy: DEFAULT_POLICY_PATH,
    repoRoot: DEFAULT_REPO_ROOT,
    runRoot: null
  };
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    const next = values[index + 1];
    if (key === "--policy") parsed.policy = next;
    else if (key === "--repo-root") parsed.repoRoot = next;
    else if (key === "--run-root") parsed.runRoot = next;
    else throw new Error(`live-assembly-argument-invalid:${String(key)}`);
    index += 1;
  }
  if ([parsed.policy, parsed.repoRoot, parsed.runRoot].some((value) =>
    typeof value !== "string" || value.length === 0
  )) {
    throw new Error(
      "usage: assemble-live-evidence.mjs --repo-root DIR --run-root DIR [--policy FILE]"
    );
  }
  return parsed;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const manifest = await assembleLiveEvidenceManifest({
    policyPath: args.policy,
    repoRoot: resolve(args.repoRoot),
    runRoot: resolve(args.runRoot)
  });
  const path = await writeLiveEvidenceManifestExclusive(args.runRoot, manifest);
  process.stdout.write(`${JSON.stringify({
    cases: manifest.slots.reduce((sum, slot) => sum + slot.cases.length, 0),
    manifestPath: path,
    sessionId: manifest.sessionId,
    slots: manifest.slots.length,
    status: "assembled"
  })}\n`);
}

if (process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
