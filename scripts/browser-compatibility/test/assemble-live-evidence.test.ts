import { createHash } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assembleLiveEvidenceManifest,
  LIVE_EVIDENCE_RUN_IDENTITY_FILENAME,
  writeLiveEvidenceManifestExclusive
} from "../assemble-live-evidence.mjs";
import {
  initializeBrowserDiagnosticEvidenceRunRoot,
  writeBrowserDiagnosticEvidencePair,
  writeBrowserDiagnosticEvidenceSession,
  writeBrowserDiagnosticInteractionLedger
} from "../../../tests/support/browser-diagnostic-capture.js";

const SOURCE_POLICY = resolve(
  process.cwd(),
  "config/release/browser-certification-policy.json"
);
const SOURCE_POLICY_SCHEMA = resolve(
  process.cwd(),
  "config/release/browser-certification-policy.schema.json"
);
const HEAD = "a".repeat(40);
const SESSION_ID = "20260719T220000Z-live";
const ATTESTATION = Object.freeze({
  headCommit: HEAD,
  trackedDiffSha256: "1".repeat(64),
  untrackedSourceTreeSha256: "2".repeat(64),
  policySha256: "3".repeat(64),
  servedTreeSha256: "4".repeat(64)
});
const IDENTITY = Object.freeze({
  schemaVersion: 1,
  sessionId: SESSION_ID,
  createdAt: "2026-07-19T22:00:00.000Z",
  sourceAttestation: ATTESTATION
});
const CODEC_STRINGS = Object.freeze({
  av1: "av01.0.08M.08.0.110.01.01.01.0",
  vp9: "vp09.00.10.08.01.01.01.01.00",
  h265: "hvc1.1.6.L93.B0",
  h264: "avc1.42E020"
});

describe("BrowserStack Live evidence assembler", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;

  beforeAll(async () => {
    fixture = await createFixture();
  }, 60_000);

  afterAll(async () => {
    if (fixture !== undefined) {
      await rm(fixture.tempRoot, { force: true, recursive: true });
    }
  });

  it("assembles a raw capture tree into one policy-exact manifest", async () => {
    const assemble = (overrides: Record<string, unknown> = {}) =>
      assembleLiveEvidenceManifest({
        createAttestation: async () => ATTESTATION,
        policyPath: "config/release/browser-certification-policy.json",
        repoRoot: fixture.repoRoot,
        runRoot: fixture.runRoot,
        ...overrides
      });

    const markerPath = resolve(
      fixture.runRoot,
      LIVE_EVIDENCE_RUN_IDENTITY_FILENAME
    );
    expect(JSON.parse(await readFile(markerPath, "utf8"))).toEqual(IDENTITY);
    await expect(readFile(resolve(fixture.runRoot, "manifest.json"))).rejects
      .toMatchObject({ code: "ENOENT" });

    const manifest = await assemble();
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      sessionId: SESSION_ID,
      sourceAttestation: ATTESTATION
    });
    expect(manifest.slots).toHaveLength(fixture.policy.slots.length);
    expect(manifest.slots.flatMap(({ cases }) => cases)).toHaveLength(
      fixture.policy.slots.reduce(
        (sum: number, slot: { demoIds: string[]; playbackModes: string[] }) =>
          sum + slot.demoIds.length * slot.playbackModes.length,
        0
      )
    );
    expect(manifest.slots.map(({ slotId }) => slotId)).toEqual(
      fixture.policy.slots.map(({ id }: { id: string }) => id)
    );

    const signedSessionPath = resolve(
      fixture.runRoot,
      fixture.policy.slots[0].id,
      "session.json"
    );
    const signedSessionBytes = await readFile(signedSessionPath, "utf8");
    expect(JSON.parse(signedSessionBytes).provider.sessionId).toBe(
      `signed-live-${fixture.policy.slots[0].id}`
    );
    await assemble();
    expect(await readFile(signedSessionPath, "utf8")).toBe(signedSessionBytes);

    const parkedMarker = resolve(fixture.tempRoot, "parked-run-identity.json");
    await rename(markerPath, parkedMarker);
    await expect(assemble()).rejects.toThrow(
      "live-assembly-run-identity-read-failed"
    );
    await rename(parkedMarker, markerPath);

    const removedSlot = fixture.policy.slots[0].id;
    const removedSlotPath = resolve(fixture.runRoot, removedSlot);
    const parkedSlotPath = resolve(fixture.tempRoot, removedSlot);
    await rename(removedSlotPath, parkedSlotPath);
    await expect(assemble()).rejects.toThrow(`live-assembly-slot-missing:${removedSlot}`);
    await rename(parkedSlotPath, removedSlotPath);

    const extraSlotPath = resolve(fixture.runRoot, "extra-slot");
    await mkdir(extraSlotPath);
    await expect(assemble()).rejects.toThrow("live-assembly-slot-extra:extra-slot");
    await rm(extraSlotPath, { recursive: true });

    const target = fixture.firstCase;
    const parkedLedger = resolve(fixture.tempRoot, "parked-ledger.json");
    await rename(target.ledgerPath, parkedLedger);
    await expect(assemble()).rejects.toThrow("live-assembly-case-missing:full-ladder");
    await rename(parkedLedger, target.ledgerPath);

    const duplicateLedger = resolve(
      dirname(target.ledgerPath),
      "duplicate-interaction-ledger.json"
    );
    await copyFile(target.ledgerPath, duplicateLedger);
    await expect(assemble()).rejects.toThrow(
      `live-assembly-case-duplicate:${target.demoId}-full-ladder`
    );
    await unlink(duplicateLedger);

    const parkedPng = resolve(fixture.tempRoot, "parked-checkpoint.png");
    await rename(target.pngPath, parkedPng);
    await expect(assemble()).rejects.toThrow("live-assembly-png-missing");
    await rename(parkedPng, target.pngPath);

    const extraArtifact = resolve(dirname(target.pngPath), "unclaimed.png");
    await writeFile(extraArtifact, "not evidence");
    await expect(assemble()).rejects.toThrow("live-assembly-artifact-extra");
    await unlink(extraArtifact);

    await expect(assemble({
      createAttestation: async () => ({
        ...ATTESTATION,
        servedTreeSha256: "f".repeat(64)
      })
    })).rejects.toThrow("source-tree-attestation-mismatch:servedTreeSha256");

    const unresolvedPolicy = structuredClone(fixture.policy);
    unresolvedPolicy.inventoryState = "awaiting-device-browser-identities";
    unresolvedPolicy.unresolvedProductVersionSlotIds = [
      "android-17-pixel-9-chrome",
      "android-16-pixel-9-chrome",
      "android-15-galaxy-s25-chrome"
    ];
    for (const slot of unresolvedPolicy.slots) {
      if (slot.platform !== "android") continue;
      slot.browser.version = null;
      slot.browser.engineVersion = null;
    }
    await writeJson(fixture.policyPath, unresolvedPolicy);
    await expect(assemble()).rejects.toThrow(
      "certification-policy-inventory-unresolved"
    );
    await writeJson(fixture.policyPath, fixture.policy);

    const androidSlot = fixture.policy.slots.find(
      ({ platform }: { platform: string }) => platform === "android"
    );
    const androidSessionPath = resolve(
      fixture.runRoot,
      androidSlot.id,
      "session.json"
    );
    const androidSession = JSON.parse(await readFile(androidSessionPath, "utf8"));
    androidSession.browser.version = "146.0.0.0";
    const parkedAndroidSession = resolve(
      fixture.tempRoot,
      "parked-android-session.json"
    );
    await rename(androidSessionPath, parkedAndroidSession);
    try {
      await writeJson(androidSessionPath, androidSession);
      await expect(assemble()).rejects.toThrow(
        `live-assembly-session-product-identity-mismatch:${androidSlot.id}`
      );
    } finally {
      await unlink(androidSessionPath).catch(() => undefined);
      await rename(parkedAndroidSession, androidSessionPath);
    }

    const iosReports = await Promise.all(
      fixture.iosFullLadderCase.reportPaths.map((path) => readFile(path, "utf8"))
    );
    const parkedIosReports = fixture.iosFullLadderCase.reportPaths.map(
      (_, index) => resolve(fixture.tempRoot, `parked-ios-report-${index}.json`)
    );
    await Promise.all(fixture.iosFullLadderCase.reportPaths.map(
      (path, index) => rename(path, parkedIosReports[index])
    ));
    try {
      await Promise.all(fixture.iosFullLadderCase.reportPaths.map(
        async (path, index) => {
          const report = JSON.parse(iosReports[index]);
          report.latest.element.diagnostics.runtime.selectedCodec =
            CODEC_STRINGS.h264;
          await writeJson(path, report);
        }
      ));
      await expect(assemble()).rejects.toThrow(
        `live-assembly-platform-codec-floor:${fixture.iosFullLadderCase.caseId}`
      );
    } finally {
      await Promise.all(fixture.iosFullLadderCase.reportPaths.map(
        async (path, index) => {
          await unlink(path).catch(() => undefined);
          await rename(parkedIosReports[index], path);
        }
      ));
    }

    const finalManifest = await assemble();
    const manifestPath = await writeLiveEvidenceManifestExclusive(
      fixture.runRoot,
      finalManifest
    );
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual(finalManifest);
    await expect(writeLiveEvidenceManifestExclusive(
      fixture.runRoot,
      finalManifest
    )).rejects.toMatchObject({ code: "EEXIST" });
  }, 60_000);
});

async function createFixture() {
  const tempRoot = await realpath(await mkdtemp(
    resolve(tmpdir(), "aval-live-assembler-")
  ));
  const repoRoot = resolve(tempRoot, "repo");
  const policyPath = resolve(
    repoRoot,
    "config/release/browser-certification-policy.json"
  );
  const policySchemaPath = resolve(
    repoRoot,
    "config/release/browser-certification-policy.schema.json"
  );
  const runRoot = resolve(
    repoRoot,
    "artifacts/browser-compatibility/runs",
    HEAD,
    SESSION_ID
  );
  await mkdir(dirname(policyPath), { recursive: true });
  await copyFile(SOURCE_POLICY_SCHEMA, policySchemaPath);
  const policy = JSON.parse(await readFile(SOURCE_POLICY, "utf8"));
  await writeJson(policyPath, policy);
  await initializeBrowserDiagnosticEvidenceRunRoot(runRoot, IDENTITY);

  let firstCase: {
    demoId: string;
    ledgerPath: string;
    pngPath: string;
  } | null = null;
  let iosFullLadderCase: {
    caseId: string;
    reportPaths: string[];
  } | null = null;
  for (const slot of policy.slots) {
    for (const demoId of slot.demoIds) {
      const demo = policy.requirements.demos.find(
        ({ id }: { id: string }) => id === demoId
      );
      const demoRoot = resolve(runRoot, slot.id, demoId);
      for (const mode of slot.playbackModes) {
        const captured = await writeCaseArtifacts({
          demo,
          demoRoot,
          mode,
          policy,
          runRoot,
          slot
        });
        if (firstCase === null && mode === "full-ladder") {
          firstCase = {
            demoId,
            ledgerPath: captured.ledgerPath,
            pngPath: captured.pngPath
          };
        }
        if (iosFullLadderCase === null && slot.platform === "ios" &&
            slot.expectation === "playback" && mode === "full-ladder") {
          iosFullLadderCase = {
            caseId: `${demoId}-${mode}`,
            reportPaths: captured.reportPaths
          };
        }
      }
    }
    await writeBrowserDiagnosticEvidenceSession(
      { runRoot, slotId: slot.id },
      exactSession(slot)
    );
  }
  if (firstCase === null || iosFullLadderCase === null) {
    throw new Error("fixture case missing");
  }
  return {
    firstCase,
    iosFullLadderCase,
    policy,
    policyPath,
    repoRoot,
    runRoot,
    tempRoot
  };
}

async function writeCaseArtifacts({
  demo,
  demoRoot,
  mode,
  policy,
  runRoot,
  slot
}: {
  demo: any;
  demoRoot: string;
  mode: string;
  policy: any;
  runRoot: string;
  slot: any;
}) {
  const playback = slot.expectation === "playback";
  const states = playback ? demo.states : [null, null];
  const ids = playback ? demo.states : ["unsupported", "unsupported-soaked"];
  const codecs = policy.requirements.authoredCodecsByMode[mode];
  const selectedCodec = playback ? codecs[0] : null;
  const visualCheckpoints = [];
  const reportPaths = [];
  let firstPngPath = "";
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    const stem = `${mode}-${id}`;
    const png = Buffer.from(`png:${slot.id}:${demo.id}:${stem}`);
    const contextPng = Buffer.from(`context:${slot.id}:${demo.id}:${stem}`);
    const beforePng = Buffer.from(`before:${slot.id}:${demo.id}:${stem}`);
    const pngSha256 = sha256(png);
    const contextPngSha256 = sha256(contextPng);
    if (firstPngPath === "") firstPngPath = resolve(demoRoot, `${stem}.png`);
    const reportPath = resolve(demoRoot, `${stem}.json`);
    reportPaths.push(reportPath);
    const report = {
      schemaVersion: 1,
      generatedAt: "2026-07-19T22:00:30.000Z",
      serializationBudgetExhausted: false,
      session: {
        url: `${demo.route}?avalDiagnostics=1&avalCertificationMode=${mode}`
      },
      environment: {
        userAgent: "fixture-browser/1.0",
        userAgentData: null,
        capabilities: { braveBrandApi: false }
      },
      players: [],
      authoredSources: codecs.map((codec: keyof typeof CODEC_STRINGS, sourceIndex: number) => ({
        playerId: "player-1",
        index: sourceIndex,
        codec
      })),
      checkpoints: [],
      latest: {
        playerId: "player-1",
        element: {
          readiness: playback ? "interactiveReady" : "error",
          visualState: states[index],
          diagnostics: {
            lastFailure: playback ? null : { code: "fixture-unsupported" },
            sourceGeneration: 1,
            outstanding: {},
            terminalCleanup: playback ? null : {
              completed: true,
              sourceCleanupCompleted: true
            },
            runtime: {
              selectedRendition: selectedCodec === null ? null : demo.renditionId,
              selectedCodec: selectedCodec === null
                ? null
                : CODEC_STRINGS[selectedCodec as keyof typeof CODEC_STRINGS],
              activeTransportBodies: 0,
              pendingLoads: 0,
              interestedWaiters: 0,
              activeLeaseCount: playback ? 1 : 0,
              pageActiveDecoderSlotCount: playback ? 1 : 0,
              pageQueuedDecoderTicketCount: 0,
              pageParkedDecoderTicketCount: 0,
              pageParticipantCount: playback ? 1 : 0,
              cleanupFailureCount: 0,
              playbackLifecycle: counters(index * 10 + (playback ? 1 : 0)),
              decoderDiagnostics: [],
              rendererDiagnostics: []
            },
            presentation: { backingWidth: 320, backingHeight: 180 }
          }
        }
      }
    };
    const frameProof = playback ? {
      beforePngSha256: sha256(beforePng),
      afterPngSha256: pngSha256,
      sampleIntervalMilliseconds: 100,
      beforeDrawsCompleted: index * 10,
      afterDrawsCompleted: index * 10 + 1
    } : null;
    visualCheckpoints.push({
      id,
      visualState: states[index],
      advancingFrame: playback,
      pngSha256,
      contextPngSha256,
      frameProof
    });
    await writeBrowserDiagnosticEvidencePair(
      {
        runRoot,
        slotId: slot.id,
        demoId: demo.id,
        mode,
        checkpoint: id
      },
      report,
      png,
      playback ? beforePng : undefined,
      contextPng
    );
  }
  const ledgerPath = resolve(demoRoot, `${mode}-interaction-ledger.json`);
  const ledger = {
    schemaVersion: 1,
    slotId: slot.id,
    demoId: demo.id,
    mode,
    interactionProfile: slot.interactionProfile,
    startedAt: "2026-07-19T22:00:00.000Z",
    finishedAt: "2026-07-19T22:01:01.000Z",
    terminalFailures: 0,
    events: [],
    visualCheckpoints,
    soak: {
      requiredMilliseconds: 60_000,
      elapsedMilliseconds: 60_000,
      samples: [
        {
          elapsedMilliseconds: 0,
          terminalFailures: 0,
          counters: counters(0)
        },
        {
          elapsedMilliseconds: 60_000,
          terminalFailures: 0,
          counters: counters(playback ? 10 : 0)
        }
      ]
    }
  };
  await writeBrowserDiagnosticInteractionLedger(
    {
      runRoot,
      slotId: slot.id,
      demoId: demo.id,
      mode
    },
    ledger
  );
  return { ledgerPath, pngPath: firstPngPath, reportPaths };
}

function counters(drawsCompleted: number) {
  return {
    outputsAccepted: drawsCompleted,
    drawsCompleted,
    logicalRunsCreated: drawsCompleted === 0 ? 0 : 1,
    candidateCommits: drawsCompleted === 0 ? 0 : 1,
    runsClosed: 0,
    transitionStarts: 0,
    transitionEnds: 0,
    loopCrossings: 0,
    nativeDecoderCreatesByLane: [drawsCompleted === 0 ? 0 : 1, 0],
    nativeDecoderClosesByLane: [0, 0]
  };
}

function exactSession(slot: any) {
  return {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    slotId: slot.id,
    provider: {
      kind: slot.provider.kind,
      sessionId: `signed-live-${slot.id}`
    },
    sourceCommit: HEAD,
    tunnelUrl: "https://evidence.example/",
    tunnelCreatedAt: "2026-07-19T21:58:00.000Z",
    testedAt: "2026-07-19T22:00:00.000Z",
    os: { name: slot.os.name, version: slot.os.version },
    device: slot.device === null ? null : { name: slot.device.name },
    browser: {
      brand: slot.browser.brand,
      version: slot.browser.version,
      engine: slot.browser.engine,
      engineVersion: slot.browser.engineVersion
    }
  };
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
