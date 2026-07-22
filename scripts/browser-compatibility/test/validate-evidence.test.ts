import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { deflateSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertAttestationMatches,
  assertExactSlotSet,
  validateEvidenceRun
} from "../validate-evidence.mjs";

const SOURCE_ROOT = resolve(import.meta.dirname, "../../..");
const SESSION_ID = "20260719T120000Z-evidence";
const HEAD_COMMIT = "a".repeat(40);
const HASHES = Object.freeze({
  headCommit: HEAD_COMMIT,
  trackedDiffSha256: "1".repeat(64),
  untrackedSourceTreeSha256: "2".repeat(64),
  policySha256: "3".repeat(64),
  servedTreeSha256: "4".repeat(64)
});

let fixture: Awaited<ReturnType<typeof createValidFixture>>;

beforeAll(async () => {
  fixture = await createValidFixture();
}, 30_000);

afterAll(async () => {
  await rm(fixture.repoRoot, { force: true, recursive: true });
});

describe("immutable browser evidence validation", () => {
  it("rejects an omitted or extra policy slot with an exact code", () => {
    const policy = { slots: [{ id: "slot-a" }, { id: "slot-b" }] };
    expect(() => assertExactSlotSet(policy, {
      slots: [{ slotId: "slot-a" }]
    })).toThrowError("evidence-policy-slot-missing:slot-b");
    expect(() => assertExactSlotSet(policy, {
      slots: [{ slotId: "slot-a" }, { slotId: "slot-b" }, { slotId: "slot-c" }]
    })).toThrowError("evidence-policy-slot-extra:slot-c");
  });

  it("distinguishes every attested source-tree component", () => {
    for (const [field, code] of [
      ["headCommit", "evidence-attestation-head-commit-mismatch"],
      ["trackedDiffSha256", "evidence-attestation-tracked-diff-mismatch"],
      ["untrackedSourceTreeSha256", "evidence-attestation-untracked-source-tree-mismatch"],
      ["policySha256", "evidence-attestation-policy-mismatch"],
      ["servedTreeSha256", "evidence-attestation-served-tree-mismatch"]
    ] as const) {
      const changed = { ...HASHES, [field]: field === "headCommit" ? "b".repeat(40) : "f".repeat(64) };
      expect(() => assertAttestationMatches(HASHES, changed)).toThrowError(code);
    }
  });

  it("accepts a complete run and rejects every adversarial artifact mutation", async () => {
    await expect(runValidation()).resolves.toMatchObject({
      status: "verified",
      slots: 45,
      cases: 360,
      checkpoints: 1188
    });

    const originalManifest = structuredClone(fixture.manifest);
    fixture.manifest.slots.pop();
    await saveManifest();
    await expectFailure("evidence-policy-slot-missing");
    fixture.manifest = structuredClone(originalManifest);
    fixture.manifest.slots.push({
      ...structuredClone(fixture.manifest.slots[0]),
      slotId: "extra-slot"
    });
    await saveManifest();
    await expectFailure("evidence-policy-slot-extra:extra-slot");
    fixture.manifest = structuredClone(originalManifest);
    await saveManifest();

    const target = firstPlaybackCase();
    const targetCheckpoint = target.evidenceCase.checkpoints[1];
    const pngPath = resolve(fixture.runRoot, targetCheckpoint.pngPath);
    const heldPngPath = `${pngPath}.held`;
    await rename(pngPath, heldPngPath);
    await expectFailure("evidence-png-missing");
    await rename(heldPngPath, pngPath);

    const contextPngPath = resolve(fixture.runRoot, targetCheckpoint.contextPngPath);
    const heldContextPngPath = `${contextPngPath}.held`;
    await rename(contextPngPath, heldContextPngPath);
    await expectFailure("evidence-context-png-missing");
    await rename(heldContextPngPath, contextPngPath);

    const beforePngPath = resolve(
      fixture.runRoot,
      targetCheckpoint.frameProof.beforePngPath
    );
    const heldBeforePngPath = `${beforePngPath}.held`;
    await rename(beforePngPath, heldBeforePngPath);
    await expectFailure("evidence-frame-before-png-missing");
    await rename(heldBeforePngPath, beforePngPath);

    const reportPath = resolve(fixture.runRoot, targetCheckpoint.reportPath);
    const heldReportPath = `${reportPath}.held`;
    await rename(reportPath, heldReportPath);
    await expectFailure("evidence-report-missing");
    await rename(heldReportPath, reportPath);

    const report = await readJson(reportPath);
    const ledgerPath = resolve(fixture.runRoot, target.evidenceCase.ledgerPath);
    const ledger = await readJson(ledgerPath);
    const originalTargetPng = await readFile(pngPath);
    const firstCheckpointPng = await readFile(resolve(
      fixture.runRoot,
      target.evidenceCase.checkpoints[0].pngPath
    ));
    const originalVisualCheckpoint = structuredClone(ledger.visualCheckpoints[1]);
    const reusedSha256 = createHash("sha256").update(firstCheckpointPng).digest("hex");
    ledger.visualCheckpoints[1].pngSha256 = reusedSha256;
    ledger.visualCheckpoints[1].frameProof.afterPngSha256 = reusedSha256;
    await Promise.all([
      writeFile(pngPath, firstCheckpointPng),
      writeJson(ledgerPath, ledger)
    ]);
    await expectFailure("evidence-png-state-hash-reused");
    ledger.visualCheckpoints[1] = originalVisualCheckpoint;
    await Promise.all([
      writeFile(pngPath, originalTargetPng),
      writeJson(ledgerPath, ledger)
    ]);
    await expect(runValidation()).resolves.toMatchObject({ status: "verified" });

    const originalContextPng = await readFile(contextPngPath);
    await writeFile(contextPngPath, await readFile(pngPath));
    await expectFailure("evidence-context-png-not-distinct");
    await writeFile(contextPngPath, originalContextPng);

    const originalFrameProof = structuredClone(targetCheckpoint.frameProof);
    targetCheckpoint.frameProof.afterDrawsCompleted =
      targetCheckpoint.frameProof.beforeDrawsCompleted;
    await saveManifest();
    await expectFailure("evidence-frame-proof-mismatch");
    targetCheckpoint.frameProof = originalFrameProof;
    await saveManifest();

    const sessionPath = resolve(
      fixture.runRoot,
      fixture.manifest.slots[0].sessionPath
    );
    const session = await readJson(sessionPath);
    const originalVersion = session.browser.version;
    session.browser.version = "999.0";
    await writeJson(sessionPath, session);
    await expectFailure("evidence-session-browser-version-mismatch");
    session.browser.version = originalVersion;
    session.sourceCommit = "b".repeat(40);
    await writeJson(sessionPath, session);
    await expectFailure("evidence-source-commit-stale");
    session.sourceCommit = HEAD_COMMIT;
    await writeJson(sessionPath, session);

    const androidManifestSlot = fixture.manifest.slots.find(
      ({ slotId }: { slotId: string }) => fixture.policy.slots.some(
        ({ id, platform }: any) => id === slotId && platform === "android"
      )
    );
    const androidSessionPath = resolve(
      fixture.runRoot,
      androidManifestSlot.sessionPath
    );
    const androidSession = await readJson(androidSessionPath);
    const exactAndroidOsVersion = androidSession.os.version;
    androidSession.os.version = "10";
    await writeJson(androidSessionPath, androidSession);
    await expectFailure("evidence-session-os-mismatch");
    androidSession.os.version = exactAndroidOsVersion;
    await writeJson(androidSessionPath, androidSession);

    const identityManifestSlot = fixture.manifest.slots.find(
      ({ slotId }: { slotId: string }) => fixture.policy.slots.some(
        ({ id, browser }: any) => id === slotId && browser.brand === "Safari"
      )
    );
    const identityPolicySlot = fixture.policy.slots.find(
      ({ id }: { id: string }) => id === identityManifestSlot.slotId
    );
    const identityReportPath = resolve(
      fixture.runRoot,
      identityManifestSlot.cases[0].checkpoints[0].reportPath
    );
    const identityReport = await readJson(identityReportPath);
    const originalUserAgent = identityReport.environment.userAgent;
    identityReport.environment.userAgent =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36";
    identityReport.environment.userAgentData = {
      brands: [{ brand: "Google Chrome", version: "150" }],
      mobile: false,
      platform: "macOS"
    };
    await writeJson(identityReportPath, identityReport);
    await expectFailure("evidence-report-browser-identity-mismatch");
    identityReport.environment.userAgent = originalUserAgent;
    identityReport.environment.userAgentData =
      browserEnvironment(identityPolicySlot).userAgentData;
    await writeJson(identityReportPath, identityReport);

    await expectFailure("evidence-attestation-tracked-diff-mismatch", {
      ...HASHES,
      trackedDiffSha256: "f".repeat(64)
    });
    await expectFailure("evidence-attestation-untracked-source-tree-mismatch", {
      ...HASHES,
      untrackedSourceTreeSha256: "f".repeat(64)
    });
    await expectFailure("evidence-attestation-served-tree-mismatch", {
      ...HASHES,
      servedTreeSha256: "f".repeat(64)
    });

    const ladder = fixture.manifest.slots[0].cases.find(({ id }: { id: string }) =>
      id === "end-user-playground-full-ladder"
    );
    const originalCodecs = ladder.expectedAuthoredCodecs;
    ladder.expectedAuthoredCodecs = ["h264"];
    await saveManifest();
    await expectFailure("evidence-authored-codecs-mismatch");
    ladder.expectedAuthoredCodecs = originalCodecs;
    await saveManifest();

    const originalManifestSelectedCodec = ladder.selectedCodec;
    ladder.selectedCodec = "h264";
    await saveManifest();
    await expectFailure("evidence-selected-codec-changed");
    ladder.selectedCodec = originalManifestSelectedCodec;
    await saveManifest();

    const ladderReports = await Promise.all(ladder.checkpoints.map(async (checkpoint: any) => {
      const path = resolve(fixture.runRoot, checkpoint.reportPath);
      return { path, report: await readJson(path) };
    }));
    const originalLadderReports = ladderReports.map(({ report }: any) =>
      structuredClone(report)
    );
    const ladderDemo = fixture.policy.requirements.demos.find(
      ({ id }: { id: string }) => id === ladder.demoId
    );
    ladder.selectedCodec = "h264";
    for (const { path, report: ladderReport } of ladderReports) {
      const sources = ladderReport.authoredSources;
      ladderReport.latest.element.diagnostics.runtime.selectedCodec = "avc1.42E020";
      ladderReport.latest.element.diagnostics.runtime.decoderDiagnostics = [
        startupCodecDiagnostic(sources[0], ladderDemo.renditionId, {
          code: "unsupported-config",
          phase: "probe"
        }),
        startupCodecDiagnostic(sources[1], ladderDemo.renditionId, {
          code: "decoder-operation",
          exception: { name: "NotSupportedError", message: "unsupported" },
          phase: "decode"
        }),
        startupCodecDiagnostic(sources[2], ladderDemo.renditionId, {
          code: "invalid-output",
          outputFailure: { kind: "display-aspect" },
          phase: "output-validation"
        })
      ];
      await writeJson(path, ladderReport);
    }
    await saveManifest();
    await expect(runValidation()).resolves.toMatchObject({ status: "verified" });
    ladderReports[0].report.latest.element.diagnostics.runtime
      .decoderDiagnostics[0].rendition = "wrong.1x";
    await writeJson(ladderReports[0].path, ladderReports[0].report);
    await expectFailure("evidence-unproven-codec-skip");
    ladderReports[0].report.latest.element.diagnostics.runtime
      .decoderDiagnostics[0].rendition = ladderDemo.renditionId;
    const firstSource = ladderReports[0].report.authoredSources[0];
    ladderReports[0].report.latest.element.diagnostics.runtime
      .decoderDiagnostics.shift();
    ladderReports[0].report.latest.element.diagnostics.runtime
      .rendererDiagnostics = [startupRendererDiagnostic(
        firstSource,
        ladderDemo.renditionId
      )];
    await writeJson(ladderReports[0].path, ladderReports[0].report);
    await expect(runValidation()).resolves.toMatchObject({ status: "verified" });
    ladderReports[0].report.latest.element.diagnostics.runtime
      .rendererDiagnostics.push({
        ...startupRendererDiagnostic(firstSource, ladderDemo.renditionId),
        phase: "native-upload"
      });
    await writeJson(ladderReports[0].path, ladderReports[0].report);
    await expectFailure("evidence-unproven-codec-skip");
    ladderReports[0].report.latest.element.diagnostics.runtime
      .rendererDiagnostics = [];
    ladderReports[0].report.latest.element.diagnostics.runtime
      .decoderDiagnostics.unshift(startupCodecDiagnostic(
        firstSource,
        ladderDemo.renditionId,
        { code: "unsupported-config", phase: "probe" }
      ));
    ladderReports[0].report.latest.element.diagnostics.runtime
      .decoderDiagnostics[2].sourceGeneration = 99;
    await writeJson(ladderReports[0].path, ladderReports[0].report);
    await expectFailure("evidence-unproven-codec-skip");
    for (const [index, { path }] of ladderReports.entries()) {
      await writeJson(path, originalLadderReports[index]);
    }
    ladder.selectedCodec = originalManifestSelectedCodec;
    await saveManifest();

    const codecLab = fixture.manifest.slots[0].cases.find(({ id }: { id: string }) =>
      id === "grass-rabbit-codecs-full-ladder"
    );
    const originalCodecLabCodecs = codecLab.expectedAuthoredCodecs;
    codecLab.expectedAuthoredCodecs = ["h264"];
    await saveManifest();
    await expectFailure("evidence-authored-codecs-mismatch");
    codecLab.expectedAuthoredCodecs = originalCodecLabCodecs;
    await saveManifest();

    const iosSlot = fixture.manifest.slots.find(({ slotId }: { slotId: string }) =>
      fixture.policy.slots.some(({ id, platform }: any) =>
        id === slotId && platform === "ios"
      )
    );
    const iosLadder = iosSlot.cases.find(({ id }: { id: string }) =>
      id === "end-user-playground-full-ladder"
    );
    const originalIosCodec = iosLadder.selectedCodec;
    iosLadder.selectedCodec = "h264";
    await saveManifest();
    await expectFailure("evidence-ios-hevc-floor-not-met");
    iosLadder.selectedCodec = originalIosCodec;
    await saveManifest();

    const stateCase = fixture.manifest.slots[0].cases.find(({ id }: { id: string }) =>
      id === "grass-rabbit-full-ladder"
    );
    const stateLedgerPath = resolve(fixture.runRoot, stateCase.ledgerPath);
    const stateLedger = await readJson(stateLedgerPath);
    const removedCheckpoint = stateCase.checkpoints.splice(1, 1)[0];
    const removedLedgerCheckpoint = stateLedger.visualCheckpoints.splice(1, 1)[0];
    await Promise.all([saveManifest(), writeJson(stateLedgerPath, stateLedger)]);
    await expectFailure("evidence-visual-state-screenshot-missing");
    stateCase.checkpoints.splice(1, 0, removedCheckpoint);
    stateLedger.visualCheckpoints.splice(1, 0, removedLedgerCheckpoint);
    await Promise.all([saveManifest(), writeJson(stateLedgerPath, stateLedger)]);

    const originalPng = await readFile(pngPath);
    await writeFile(pngPath, rgbaPng(16, 16, () => [0, 0, 0, 255]));
    await expectFailure("evidence-png-not-meaningful");
    await writeFile(pngPath, originalPng);

    const originalEvents = structuredClone(ledger.events);
    const originalInteractionProfile = ledger.interactionProfile;
    ledger.interactionProfile = originalInteractionProfile === "touch"
      ? "desktop"
      : "touch";
    await writeJson(ledgerPath, ledger);
    await expectFailure("evidence-ledger-identity-mismatch");
    ledger.interactionProfile = originalInteractionProfile;
    await writeJson(ledgerPath, ledger);
    ledger.events = ledger.events.filter(({ type, edge }: { type: string, edge: string | null }) =>
      !(type === "transitionend" && edge === requiredEdges(target.demo)[0])
    );
    await writeJson(ledgerPath, ledger);
    await expectFailure("evidence-transitionend-missing");
    ledger.events = originalEvents;
    await writeJson(ledgerPath, ledger);

    const healthyReport = structuredClone(report);
    report.latest.element.readiness = "error";
    report.latest.element.diagnostics.lastFailure = { code: "unsupported-browser" };
    report.latest.element.diagnostics.runtime.selectedCodec = null;
    await writeJson(reportPath, report);
    await expectFailure("evidence-terminal-failure");
    await writeJson(reportPath, healthyReport);

    const originalSoak = structuredClone(ledger.soak);
    ledger.soak.elapsedMilliseconds = 59_999;
    ledger.soak.samples[1].elapsedMilliseconds = 59_999;
    await writeJson(ledgerPath, ledger);
    await expectFailure("evidence-soak-too-short");
    ledger.soak = originalSoak;
    await writeJson(ledgerPath, ledger);

    const originalFinishedAt = ledger.finishedAt;
    ledger.finishedAt = "2026-07-19T12:00:59.000Z";
    await writeJson(ledgerPath, ledger);
    await expectFailure("evidence-ledger-time-order-invalid");
    ledger.finishedAt = originalFinishedAt;
    await writeJson(ledgerPath, ledger);

    const unsupportedSlot = fixture.manifest.slots.find(({ slotId }: { slotId: string }) =>
      fixture.policy.slots.some(({ id, expectation }: any) =>
        id === slotId && expectation === "unsupported-sentinel"
      )
    );
    const unsupportedReportPath = resolve(
      fixture.runRoot,
      unsupportedSlot.cases[0].checkpoints[0].reportPath
    );
    const unsupportedReport = await readJson(unsupportedReportPath);
    unsupportedReport.latest.element.diagnostics.runtime.activeTransportBodies = 1;
    await writeJson(unsupportedReportPath, unsupportedReport);
    await expectFailure("evidence-unsupported-resources-not-retired");
    unsupportedReport.latest.element.diagnostics.runtime.activeTransportBodies = 0;
    await writeJson(unsupportedReportPath, unsupportedReport);
    const terminalCleanup = unsupportedReport.latest.element.diagnostics.terminalCleanup;
    unsupportedReport.latest.element.diagnostics.terminalCleanup = null;
    await writeJson(unsupportedReportPath, unsupportedReport);
    await expectFailure("evidence-unsupported-resources-not-retired");
    unsupportedReport.latest.element.diagnostics.terminalCleanup = terminalCleanup;
    unsupportedReport.latest.element.diagnostics.presentation.backingWidth = 1;
    await writeJson(unsupportedReportPath, unsupportedReport);
    await expectFailure("evidence-unsupported-resources-not-retired");
    unsupportedReport.latest.element.diagnostics.presentation.backingWidth = 0;
    await writeJson(unsupportedReportPath, unsupportedReport);
  }, 60_000);
});

async function runValidation(actualAttestation = HASHES) {
  return validateEvidenceRun({
    repoRoot: fixture.repoRoot,
    runRoot: fixture.runRoot,
    createAttestation: async () => actualAttestation,
    servedFiles: []
  });
}

async function expectFailure(code: string, actualAttestation = HASHES) {
  await expect(runValidation(actualAttestation)).rejects.toThrowError(code);
}

function firstPlaybackCase() {
  const manifestSlot = fixture.manifest.slots.find(({ slotId }: { slotId: string }) =>
    fixture.policy.slots.find(({ id, expectation }: { id: string, expectation: string }) =>
      id === slotId && expectation === "playback"
    ) !== undefined
  );
  const evidenceCase = manifestSlot.cases[0];
  const demo = fixture.policy.requirements.demos.find(
    ({ id }: { id: string }) => id === evidenceCase.demoId
  );
  return { demo, evidenceCase, manifestSlot };
}

async function saveManifest() {
  await writeJson(resolve(fixture.runRoot, "manifest.json"), fixture.manifest);
}

async function createValidFixture() {
  const repoRoot = await mkdtemp(resolve(tmpdir(), "aval-evidence-validator-"));
  const policy = JSON.parse(await readFile(
    resolve(SOURCE_ROOT, "config/release/browser-certification-policy.json"),
    "utf8"
  ));
  policy.inventoryState = "resolved";
  policy.unresolvedProductVersionSlotIds = [];
  for (const slot of policy.slots) {
    if (slot.browser.version !== null) continue;
    slot.browser.version = "150.0";
    slot.browser.engineVersion = "150.0";
    slot.provider.browserVersionLabel = "150.0";
  }
  const policyDirectory = resolve(repoRoot, "config/release");
  await mkdir(policyDirectory, { recursive: true });
  await Promise.all([
    writeJson(
      resolve(policyDirectory, "browser-certification-policy.json"),
      policy
    ),
    writeFile(
      resolve(policyDirectory, "browser-certification-policy.schema.json"),
      await readFile(
        resolve(SOURCE_ROOT, "config/release/browser-certification-policy.schema.json")
      )
    )
  ]);
  const runRoot = resolve(
    repoRoot,
    "artifacts/browser-compatibility/runs",
    HEAD_COMMIT,
    SESSION_ID
  );
  await mkdir(runRoot, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    createdAt: "2026-07-19T12:00:00.000Z",
    sourceAttestation: { ...HASHES },
    slots: [] as any[]
  };
  const writes: Promise<unknown>[] = [];
  for (const [slotIndex, slot] of policy.slots.entries()) {
    const slotRoot = resolve(runRoot, slot.id);
    await mkdir(slotRoot, { recursive: true });
    const sessionPath = `${slot.id}/session.json`;
    writes.push(writeJson(resolve(runRoot, sessionPath), {
      schemaVersion: 1,
      sessionId: SESSION_ID,
      slotId: slot.id,
      provider: {
        kind: slot.provider.kind,
        sessionId: `provider_session_${String(slotIndex).padStart(3, "0")}`
      },
      sourceCommit: HEAD_COMMIT,
      tunnelUrl: "https://evidence-fixture.trycloudflare.com/",
      tunnelCreatedAt: "2026-07-19T11:55:00.000Z",
      testedAt: "2026-07-19T12:00:00.000Z",
      os: { name: slot.os.name, version: slot.os.version },
      device: slot.device === null ? null : { name: slot.device.name },
      browser: {
        brand: slot.browser.brand,
        version: slot.browser.version,
        engine: slot.browser.engine,
        engineVersion: slot.browser.engineVersion
      }
    }));
    const manifestSlot = { slotId: slot.id, sessionPath, cases: [] as any[] };
    for (const demo of policy.requirements.demos) {
      const demoRoot = resolve(slotRoot, demo.id);
      await mkdir(demoRoot, { recursive: true });
      for (const mode of slot.playbackModes) {
        const id = `${demo.id}-${mode}`;
        const expectedOutcome = slot.expectation === "playback"
          ? "playback"
          : "deterministic-error";
        const expectedAuthoredCodecs = expectedCodecs(policy, mode);
        const checkpointStates = expectedOutcome === "playback"
          ? demo.states
          : [null, null];
        const checkpointIds = expectedOutcome === "playback"
          ? demo.states
          : ["error", "retired"];
        const checkpointArtifacts = checkpointIds.map((checkpointId, checkpointIndex) => {
          const stem = `${slot.id}/${demo.id}/${mode}-${checkpointId}`;
          const visualState = checkpointStates[checkpointIndex];
          const beforePng = rgbaPng(16, 16, (x, y) => [
            (x * 13 + checkpointIndex * 17) % 256,
            (y * 11 + checkpointIndex * 23) % 256,
            (x + y + checkpointIndex * 9) * 7 % 256,
            255
          ]);
          const png = rgbaPng(16, 16, (x, y) => [
            (x * 16 + checkpointIndex * 29 + 1) % 256,
            (y * 16 + checkpointIndex * 31 + 2) % 256,
            ((x + y) * 8 + checkpointIndex * 37 + 3) % 256,
            255
          ]);
          const contextPng = rgbaPng(24, 24, (x, y) => [
            (x * 9 + checkpointIndex * 7 + 11) % 256,
            (y * 9 + checkpointIndex * 13 + 19) % 256,
            ((x + y) * 6 + checkpointIndex * 17 + 23) % 256,
            255
          ]);
          const playback = expectedOutcome === "playback";
          const beforeDrawsCompleted = checkpointIndex * 10;
          const afterDrawsCompleted = playback
            ? beforeDrawsCompleted + 1
            : beforeDrawsCompleted;
          return {
            manifest: {
              id: checkpointId,
              visualState,
              advancingFrame: playback,
              reportPath: `${stem}.json`,
              pngPath: `${stem}.png`,
              contextPngPath: `${stem}-context.png`,
              frameProof: playback ? {
                beforePngPath: `${stem}-before.png`,
                sampleIntervalMilliseconds: 100,
                beforeDrawsCompleted,
                afterDrawsCompleted
              } : null
            },
            beforePng,
            contextPng,
            contextPngSha256: createHash("sha256").update(contextPng).digest("hex"),
            frameProof: playback ? {
              beforePngSha256: createHash("sha256").update(beforePng).digest("hex"),
              afterPngSha256: createHash("sha256").update(png).digest("hex"),
              sampleIntervalMilliseconds: 100,
              beforeDrawsCompleted,
              afterDrawsCompleted
            } : null,
            png,
            pngSha256: createHash("sha256").update(png).digest("hex")
          };
        });
        const checkpoints = checkpointArtifacts.map(({ manifest }) => manifest);
        for (const artifact of checkpointArtifacts) {
          const checkpoint = artifact.manifest;
          writes.push(
            writeJson(
              resolve(runRoot, checkpoint.reportPath),
              diagnosticReport(
                expectedOutcome,
                expectedAuthoredCodecs,
                checkpoint.visualState,
                slot,
                demo,
                mode
              )
            ),
            writeFile(resolve(runRoot, checkpoint.pngPath), artifact.png),
            writeFile(resolve(runRoot, checkpoint.contextPngPath), artifact.contextPng)
          );
          if (checkpoint.frameProof !== null) {
            writes.push(writeFile(
              resolve(runRoot, checkpoint.frameProof.beforePngPath),
              artifact.beforePng
            ));
          }
        }
        const ledgerPath = `${slot.id}/${demo.id}/${mode}-interaction-ledger.json`;
        writes.push(writeJson(resolve(runRoot, ledgerPath), interactionLedger({
          slotId: slot.id,
          demo,
          mode,
          expectedOutcome,
          interactionProfile: slot.interactionProfile,
          checkpoints: checkpointArtifacts
        })));
        manifestSlot.cases.push({
          id,
          demoId: demo.id,
          mode,
          expectedOutcome,
          expectedAuthoredCodecs,
          selectedCodec: expectedOutcome === "playback"
            ? expectedAuthoredCodecs[0]
            : null,
          checkpoints,
          ledgerPath
        });
      }
    }
    manifest.slots.push(manifestSlot);
  }
  await Promise.all(writes);
  await writeJson(resolve(runRoot, "manifest.json"), manifest);
  return { manifest, policy, repoRoot, runRoot };
}

function diagnosticReport(
  expectedOutcome: "playback" | "deterministic-error",
  codecs: string[],
  visualState: string | null,
  slot: any,
  demo: any,
  mode: string
) {
  const codecStrings: Record<string, string> = {
    av1: "av01.0.08M.08.0.110.01.01.01.0",
    vp9: "vp09.00.10.08.01.01.01.01.00",
    h265: "hvc1.1.6.L93.B0",
    h264: "avc1.42E020"
  };
  const playback = expectedOutcome === "playback";
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-19T12:00:00.000Z",
    serializationBudgetExhausted: false,
    session: {
      url: `${demo.route}?avalDiagnostics=1&avalCertificationMode=${mode}`
    },
    environment: browserEnvironment(slot),
    players: [],
    authoredSources: codecs.map((codec, index) => ({
      playerId: "player-1",
      index,
      codec
    })),
    checkpoints: [],
    latest: {
      playerId: "player-1",
      element: {
        readiness: playback ? "interactiveReady" : "error",
        visualState,
        diagnostics: {
          lastFailure: playback ? null : { code: "unsupported-browser" },
          sourceGeneration: 1,
          outstanding: {},
          terminalCleanup: playback ? null : {
            completed: true,
            sourceCleanupCompleted: true
          },
          runtime: {
            selectedRendition: playback ? demo.renditionId : null,
            selectedCodec: playback ? codecStrings[codecs[0]] : null,
            activeTransportBodies: 0,
            pendingLoads: 0,
            interestedWaiters: 0,
            activeLeaseCount: 0,
            pageActiveDecoderSlotCount: 0,
            pageQueuedDecoderTicketCount: 0,
            pageParkedDecoderTicketCount: 0,
            pageParticipantCount: 0,
            cleanupFailureCount: 0,
            playbackLifecycle: counters(playback ? 1 : 0),
            decoderDiagnostics: [],
            rendererDiagnostics: []
          },
          presentation: {
            backingWidth: playback ? 16 : 0,
            backingHeight: playback ? 16 : 0
          }
        }
      }
    }
  };
}

function browserEnvironment(slot: any) {
  const version = String(slot.browser.version);
  const engineVersion = String(slot.browser.engineVersion ?? version);
  const platformToken = slot.platform === "windows"
    ? "Windows NT 10.0; Win64; x64"
    : slot.platform === "macos"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : slot.platform === "ios"
        ? `iPhone; CPU iPhone OS ${String(slot.os.version).replaceAll(".", "_")} like Mac OS X`
        : "Linux; Android 10; K";
  if (slot.browser.brand === "Chrome") {
    return {
      userAgent: `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 ` +
        `Chrome/${version}.0.0${slot.platform === "android" ? " Mobile" : ""} ` +
        "Safari/537.36",
      userAgentData: {
        brands: [{ brand: "Google Chrome", version: version.split(".")[0] }],
        mobile: slot.platform === "android",
        platform: slot.platform === "android" ? "Android" : slot.os.name
      },
      capabilities: { braveBrandApi: false }
    };
  }
  if (slot.browser.brand === "Firefox") {
    return {
      userAgent: `Mozilla/5.0 (${platformToken}; rv:${version}) ` +
        `Gecko/20100101 Firefox/${version}`,
      userAgentData: null,
      capabilities: { braveBrandApi: false }
    };
  }
  if (slot.browser.brand === "Safari") {
    return {
      userAgent: `Mozilla/5.0 (${platformToken}) AppleWebKit/605.1.15 ` +
        `Version/${version} Safari/605.1.15`,
      userAgentData: null,
      capabilities: { braveBrandApi: false }
    };
  }
  return {
    userAgent: `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 ` +
      `Chrome/${engineVersion} Safari/537.36`,
    userAgentData: {
      brands: [{ brand: "Chromium", version: engineVersion.split(".")[0] }],
      mobile: false,
      platform: slot.os.name
    },
    capabilities: { braveBrandApi: true }
  };
}

function interactionLedger({
  slotId,
  demo,
  mode,
  expectedOutcome,
  interactionProfile,
  checkpoints
}: any) {
  const playback = expectedOutcome === "playback";
  return {
    schemaVersion: 1,
    slotId,
    demoId: demo.id,
    mode,
    interactionProfile,
    startedAt: "2026-07-19T12:00:00.000Z",
    finishedAt: "2026-07-19T12:01:01.000Z",
    terminalFailures: 0,
    events: playback ? interactionEvents(demo) : [],
    visualCheckpoints: checkpoints.map((artifact: any) => ({
      id: artifact.manifest.id,
      visualState: artifact.manifest.visualState,
      advancingFrame: artifact.manifest.advancingFrame,
      pngSha256: artifact.pngSha256,
      contextPngSha256: artifact.contextPngSha256,
      frameProof: artifact.frameProof
    })),
    soak: {
      requiredMilliseconds: 60_000,
      elapsedMilliseconds: 60_000,
      samples: [
        { elapsedMilliseconds: 0, terminalFailures: 0, counters: counters(0) },
        { elapsedMilliseconds: 60_000, terminalFailures: 0, counters: counters(playback ? 1 : 0) }
      ]
    }
  };
}

function interactionEvents(demo: any) {
  const events = demo.states.map((state: string, index: number) => ({
    type: "visualstatechange",
    atMilliseconds: index * 10,
    from: null,
    to: state,
    edge: null
  }));
  for (const [index, edge] of requiredEdges(demo).entries()) {
    events.push({
      type: "transitionstart",
      atMilliseconds: 100 + index * 10,
      from: edge.split(".")[0],
      to: edge.split(".")[1],
      edge
    }, {
      type: "transitionend",
      atMilliseconds: 101 + index * 10,
      from: edge.split(".")[0],
      to: edge.split(".")[1],
      edge
    });
  }
  return events;
}

function requiredEdges(demo: any) {
  return demo.states.length === 2
    ? ["idle.engaged", "engaged.idle"]
    : [
        "idle.entering",
        "entering.hover",
        "hover.exiting",
        "exiting.idle",
        "entering.exiting",
        "exiting.entering"
      ];
}

function expectedCodecs(policy: any, mode: string) {
  return [...policy.requirements.authoredCodecsByMode[mode]];
}

function startupCodecDiagnostic(source: any, rendition: string, input: any) {
  return {
    sourceGeneration: 1,
    sourceIndex: source.index,
    rendition,
    codec: exactCodecString(source.codec),
    code: input.code,
    phase: input.phase,
    exception: input.exception ?? null,
    outputFailure: input.outputFailure ?? null
  };
}

function startupRendererDiagnostic(source: any, rendition: string) {
  return {
    sourceGeneration: 1,
    sourceIndex: source.index,
    rendition,
    codec: exactCodecString(source.codec),
    phase: "rgba-copy",
    operation: "runtime",
    exception: { name: "NotSupportedError", message: "unsupported" },
    glError: null,
    contextLost: false,
    uploadPath: "rgba-copy"
  };
}

function exactCodecString(codec: string): string | undefined {
  return ({
    av1: "av01.0.08M.08.0.110.01.01.01.0",
    vp9: "vp09.00.10.08.01.01.01.01.00",
    h265: "hvc1.1.6.L93.B0",
    h264: "avc1.42E020"
  } as Record<string, string>)[codec];
}

function counters(value: number) {
  return {
    outputsAccepted: value,
    drawsCompleted: value,
    logicalRunsCreated: value,
    candidateCommits: value,
    runsClosed: value,
    transitionStarts: value,
    transitionEnds: value,
    loopCrossings: value,
    nativeDecoderCreatesByLane: [value, value],
    nativeDecoderClosesByLane: [value, value]
  };
}

function rgbaPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number, number]
) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const rgba = pixel(x, y);
      const offset = rowOffset + 1 + x * 4;
      for (let channel = 0; channel < 4; channel += 1) rows[offset + channel] = rgba[channel]!;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function pngChunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}
