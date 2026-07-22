#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { inflateSync } from "node:zlib";

import { chromium } from "playwright";
import {
  SOURCE_CODEC_PRIORITY
} from "@pixel-point/aval-element";
import { parseVideoCodecString } from "@pixel-point/aval-format";

import { verifyBraveVersionOutput } from "./acquire-builds.mjs";

const execFile = promisify(execFileCallback);
const MODES = Object.freeze(["forced-h264", "full-ladder"]);
const DEMO_TIMEOUT_MS = 45_000;
const FRAME_SAMPLE_MS = 50;
const PROFILE_PREFIX = "aval-brave-profile-";
const MAX_LEDGER_EVENTS = 4_096;
const PLAYBACK_COUNTER_KEYS = Object.freeze([
  "outputsAccepted",
  "drawsCompleted",
  "logicalRunsCreated",
  "candidateCommits",
  "runsClosed",
  "transitionStarts",
  "transitionEnds",
  "loopCrossings"
]);
const PLAYBACK_LANE_COUNTER_KEYS = Object.freeze([
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

export function planBraveRuns(policy, { platform, hostOsVersion, manifest }) {
  const providerKind = platform === "macos"
    ? "managed-macos-arm64"
    : platform === "windows"
      ? "github-hosted-windows-x64"
      : null;
  if (providerKind === null) throw new Error(`brave-run-platform-invalid:${String(platform)}`);
  if (manifest?.platform !== (platform === "macos" ? "macos-arm64" : "windows-x64")) {
    throw new Error("brave-run-install-platform-mismatch");
  }
  if (manifest.schemaVersion !== 1 || !Number.isFinite(Date.parse(manifest.acquiredAt ?? "")) ||
      !Array.isArray(manifest.builds) || manifest.builds.length !== 2 ||
      new Set(manifest.builds.map(({ role }) => role)).size !== 2 ||
      !manifest.builds.every(({ role }) => role === "current" || role === "boundary")) {
    throw new Error("brave-run-install-manifest-invalid");
  }
  let slots = (policy?.slots ?? []).filter((slot) =>
    slot?.platform === platform && slot?.browser?.brand === "Brave" &&
    slot?.provider?.kind === providerKind &&
    String(slot?.os?.version) === String(hostOsVersion)
  );
  const builds = new Map((manifest?.builds ?? []).map((build) => [build.role, build]));
  if (slots.length !== 2 || new Set(slots.map(({ braveBuild }) => braveBuild)).size !== 2) {
    throw new Error(`brave-run-slot-count:${String(slots.length)}`);
  }
  const demos = new Map(policy.requirements.demos.map((demo) => [demo.id, demo]));
  return slots.sort((left, right) => left.braveBuild.localeCompare(right.braveBuild))
    .map((slot) => {
      const build = builds.get(slot.braveBuild);
      if (build === undefined || build.version !== slot.browser.version ||
          build.chromiumVersion !== slot.browser.engineVersion) {
        throw new Error(`brave-run-build-mismatch:${slot.id}`);
      }
      const expectedBuild = policy.braveBuilds?.[slot.braveBuild];
      const expectedAsset = expectedBuild?.assets?.[manifest.platform];
      if (expectedBuild === undefined || expectedAsset === undefined ||
          build.releaseDate !== expectedBuild.releaseDate ||
          build.source?.name !== expectedAsset.name ||
          build.source?.url !== expectedAsset.url ||
          build.source?.sha256 !== expectedAsset.sha256 ||
          build.source?.size !== expectedAsset.size ||
          typeof build.executablePath !== "string") {
        throw new Error(`brave-run-provenance-mismatch:${slot.id}`);
      }
      verifyBraveVersionOutput(build.versionOutput, build);
      const signer = String(build.signer ?? "");
      const signerValid = platform === "macos"
        ? signer.startsWith("Developer ID Application: Brave Software, Inc.") &&
          signer.includes("KL8N8XSYF4")
        : signer.includes("Brave Software, Inc.");
      if (!signerValid) throw new Error(`brave-run-signer-mismatch:${slot.id}`);
      if (slot.expectation !== "playback" || slot.interactionProfile !== "desktop" ||
          !Array.isArray(slot.demoIds) ||
          JSON.stringify(slot.demoIds) !== JSON.stringify([...demos.keys()]) ||
          JSON.stringify(slot.playbackModes) !== JSON.stringify(MODES) ||
          slot.soakSeconds !== policy.requirements.soakSeconds || slot.soakSeconds < 60) {
        throw new Error(`brave-run-requirements-invalid:${slot.id}`);
      }
      const cases = slot.demoIds.flatMap((demoId) => {
        const demo = demos.get(demoId);
        if (demo === undefined) throw new Error(`brave-run-demo-missing:${demoId}`);
        return MODES.map((mode) => Object.freeze({ demo, mode }));
      });
      return Object.freeze({ build, cases: Object.freeze(cases), slot });
    });
}

export function validateBraveEvidencePlan(plans) {
  for (const plan of plans) {
    if (plan.slot.browser.brand !== "Brave") throw new Error("brave-run-brand-substitution");
    if (plan.cases.length !== 8) throw new Error(`brave-run-case-count:${plan.slot.id}`);
    const keys = new Set(plan.cases.map(({ demo, mode }) => `${demo.id}:${mode}`));
    if (keys.size !== 8) throw new Error(`brave-run-duplicate-case:${plan.slot.id}`);
    if (plan.slot.soakSeconds < 60) throw new Error(`brave-run-soak-too-short:${plan.slot.id}`);
  }
  return plans;
}

export function requiredInteractionEvidence(demo) {
  const states = [...(demo?.states ?? [])];
  if (JSON.stringify(states) === JSON.stringify(["idle", "engaged"])) {
    return Object.freeze({
      states: Object.freeze(states),
      edges: Object.freeze(["idle.engaged", "engaged.idle"])
    });
  }
  if (JSON.stringify(states) === JSON.stringify(["idle", "entering", "hover", "exiting"])) {
    return Object.freeze({
      states: Object.freeze(states),
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
  throw new Error(`brave-run-state-contract-unsupported:${String(demo?.id)}`);
}

export function createBraveEvidenceSession({
  sessionId,
  slot,
  sourceCommit,
  testedAt,
  tunnelCreatedAt,
  tunnelUrl
}) {
  const identity = validateEvidenceIdentity({ sessionId, sourceCommit });
  const origin = validateBaseUrl(tunnelUrl);
  const created = requireIsoDateTime(tunnelCreatedAt, "brave-run-tunnel-created-at-invalid");
  const tested = requireIsoDateTime(testedAt, "brave-run-tested-at-invalid");
  if (Date.parse(tested) < Date.parse(created)) {
    throw new Error("brave-run-session-time-order-invalid");
  }
  if (slot?.browser?.brand !== "Brave" || slot?.browser?.engine !== "Chromium" ||
      typeof slot?.browser?.version !== "string" ||
      typeof slot?.browser?.engineVersion !== "string") {
    throw new Error("brave-run-session-browser-invalid");
  }
  const providerSessionId = `${identity.sessionId}_${slot.id}`;
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(providerSessionId)) {
    throw new Error("brave-run-provider-session-id-invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    sessionId: identity.sessionId,
    slotId: slot.id,
    provider: Object.freeze({
      kind: slot.provider.kind,
      sessionId: providerSessionId
    }),
    sourceCommit: identity.sourceCommit,
    tunnelUrl: origin.href,
    tunnelCreatedAt: created,
    testedAt: tested,
    os: Object.freeze({ name: slot.os.name, version: slot.os.version }),
    device: slot.device === null
      ? null
      : Object.freeze({ name: slot.device.name }),
    browser: Object.freeze({
      brand: "Brave",
      version: slot.browser.version,
      engine: "Chromium",
      engineVersion: slot.browser.engineVersion
    })
  });
}

export function createBraveCaseEvidenceContract({
  checkpoints,
  demo,
  events,
  expectedAuthoredCodecs,
  finishedAt,
  interactionProfile = "desktop",
  mode,
  selectedCodec,
  soak,
  startedAt,
  terminalFailures = 0,
  slotId
}) {
  assertEvidenceIdentifier(slotId, "slot-id");
  assertEvidenceIdentifier(demo?.id, "demo-id");
  if (!MODES.includes(mode)) throw new Error(`brave-run-mode-invalid:${String(mode)}`);
  if (interactionProfile !== "desktop") {
    throw new Error(`brave-run-interaction-profile:${String(interactionProfile)}`);
  }
  const start = requireIsoDateTime(startedAt, "brave-run-ledger-started-at-invalid");
  const finish = requireIsoDateTime(finishedAt, "brave-run-ledger-finished-at-invalid");
  if (Date.parse(finish) < Date.parse(start)) throw new Error("brave-run-ledger-time-order-invalid");
  if (terminalFailures !== 0) throw new Error("brave-run-terminal-failure");
  const codecs = normalizeExpectedCodecs(expectedAuthoredCodecs);
  if (typeof selectedCodec !== "string" || !codecs.includes(selectedCodec)) {
    throw new Error("brave-run-selected-codec-contract-invalid");
  }
  if (!Array.isArray(checkpoints) || checkpoints.length < 2 || checkpoints.length > 64) {
    throw new Error("brave-run-checkpoint-count-invalid");
  }
  const seen = new Set();
  const manifestCheckpoints = checkpoints.map((checkpoint) => {
    assertEvidenceIdentifier(checkpoint?.id, "checkpoint-id");
    if (seen.has(checkpoint.id)) throw new Error("brave-run-checkpoint-duplicate");
    seen.add(checkpoint.id);
    if (checkpoint.visualState !== null &&
        !["idle", "engaged", "entering", "hover", "exiting"].includes(checkpoint.visualState)) {
      throw new Error("brave-run-checkpoint-state-invalid");
    }
    const frameProof = checkpoint.frameProof;
    if (typeof checkpoint.advancingFrame !== "boolean" ||
        !/^[a-f0-9]{64}$/u.test(String(checkpoint.pngSha256)) ||
        !/^[a-f0-9]{64}$/u.test(String(checkpoint.contextPngSha256)) ||
        frameProof === null || typeof frameProof !== "object" ||
        !/^[a-f0-9]{64}$/u.test(String(frameProof.beforeCanvasSha256)) ||
        !/^[a-f0-9]{64}$/u.test(String(frameProof.afterCanvasSha256)) ||
        frameProof.afterCanvasSha256 !== checkpoint.pngSha256 ||
        !Number.isFinite(frameProof.sampleIntervalMilliseconds) ||
        frameProof.sampleIntervalMilliseconds < 1 ||
        frameProof.sampleIntervalMilliseconds > 5_000 ||
        !Number.isSafeInteger(frameProof.beforeDrawsCompleted) ||
        !Number.isSafeInteger(frameProof.afterDrawsCompleted) ||
        frameProof.beforeDrawsCompleted < 0 ||
        frameProof.afterDrawsCompleted < frameProof.beforeDrawsCompleted ||
        checkpoint.advancingFrame !== (
          frameProof.beforeCanvasSha256 !== frameProof.afterCanvasSha256 &&
          frameProof.afterDrawsCompleted > frameProof.beforeDrawsCompleted
        )) {
      throw new Error("brave-run-checkpoint-proof-invalid");
    }
    const stem = `${slotId}/${demo.id}/${mode}-${checkpoint.id}`;
    return Object.freeze({
      id: checkpoint.id,
      visualState: checkpoint.visualState,
      advancingFrame: checkpoint.advancingFrame,
      reportPath: `${stem}.json`,
      pngPath: `${stem}.png`,
      contextPngPath: `${stem}-context.png`,
      frameProof: Object.freeze({
        beforePngPath: `${stem}-before.png`,
        sampleIntervalMilliseconds: frameProof.sampleIntervalMilliseconds,
        beforeDrawsCompleted: frameProof.beforeDrawsCompleted,
        afterDrawsCompleted: frameProof.afterDrawsCompleted
      })
    });
  });
  const checkpointStates = new Set(checkpoints.map(({ visualState }) => visualState));
  if (demo.states.some((state) => !checkpointStates.has(state)) ||
      !checkpoints.some(({ advancingFrame }) => advancingFrame)) {
    throw new Error("brave-run-checkpoint-state-coverage-invalid");
  }
  const normalizedSoak = normalizeSoakEvidence(soak);
  const ledgerPath = `${slotId}/${demo.id}/${mode}-interaction-ledger.json`;
  const ledger = Object.freeze({
    schemaVersion: 1,
    slotId,
    demoId: demo.id,
    mode,
    interactionProfile,
    startedAt: start,
    finishedAt: finish,
    terminalFailures,
    events: Object.freeze(createBraveEvidenceEvents(events)),
    visualCheckpoints: Object.freeze(checkpoints.map((checkpoint) => Object.freeze({
      id: checkpoint.id,
      visualState: checkpoint.visualState,
      advancingFrame: checkpoint.advancingFrame,
      pngSha256: checkpoint.pngSha256,
      contextPngSha256: checkpoint.contextPngSha256,
      frameProof: Object.freeze({
        beforePngSha256: checkpoint.frameProof.beforeCanvasSha256,
        afterPngSha256: checkpoint.frameProof.afterCanvasSha256,
        sampleIntervalMilliseconds: checkpoint.frameProof.sampleIntervalMilliseconds,
        beforeDrawsCompleted: checkpoint.frameProof.beforeDrawsCompleted,
        afterDrawsCompleted: checkpoint.frameProof.afterDrawsCompleted
      })
    }))),
    soak: normalizedSoak
  });
  return Object.freeze({
    ledger,
    ledgerPath,
    manifestCase: Object.freeze({
      id: `${demo.id}-${mode}`,
      demoId: demo.id,
      mode,
      expectedOutcome: "playback",
      expectedAuthoredCodecs: codecs,
      selectedCodec,
      checkpoints: Object.freeze(manifestCheckpoints),
      ledgerPath
    })
  });
}

export function createBraveEvidenceEvents(events) {
  if (!Array.isArray(events)) throw new Error("brave-run-events-invalid");
  const evidenceEvents = [];
  for (const event of events) {
    if (!["transitionstart", "visualstatechange", "transitionend"].includes(event?.type)) {
      continue;
    }
    if (!Number.isFinite(event.at) || event.at < 0) {
      throw new Error("brave-run-event-time-invalid");
    }
    const from = typeof event.detail?.from === "string" ? event.detail.from : null;
    const to = typeof event.detail?.to === "string" ? event.detail.to : null;
    const edge = typeof event.detail?.edge === "string" ? event.detail.edge : null;
    if ([from, to].some((value) => value !== null && value.length > 64) ||
        (edge !== null && edge.length > 129)) {
      throw new Error("brave-run-event-value-invalid");
    }
    evidenceEvents.push(Object.freeze({
      type: event.type,
      atMilliseconds: event.at,
      from,
      to,
      edge
    }));
  }
  if (evidenceEvents.length > MAX_LEDGER_EVENTS) throw new Error("brave-run-events-over-limit");
  return evidenceEvents;
}

export function createBraveManifestSlot(slot, manifestCases) {
  assertEvidenceIdentifier(slot?.id, "slot-id");
  if (!Array.isArray(manifestCases) || manifestCases.length !== 8) {
    throw new Error(`brave-run-manifest-case-count:${String(manifestCases?.length)}`);
  }
  const expectedIds = slot.demoIds.flatMap((demoId) =>
    MODES.map((mode) => `${demoId}-${mode}`)
  );
  const actualIds = manifestCases.map(({ id }) => id);
  if (new Set(actualIds).size !== 8 ||
      expectedIds.some((id) => !actualIds.includes(id)) ||
      actualIds.some((id) => !expectedIds.includes(id))) {
    throw new Error(`brave-run-manifest-case-set:${slot.id}`);
  }
  return Object.freeze({
    slotId: slot.id,
    sessionPath: `${slot.id}/session.json`,
    cases: Object.freeze([...manifestCases])
  });
}

export function createBraveManifestFragment({
  createdAt,
  sessionId,
  slots,
  sourceCommit
}) {
  const identity = validateEvidenceIdentity({ sessionId, sourceCommit });
  const created = requireIsoDateTime(createdAt, "brave-run-fragment-created-at-invalid");
  if (!Array.isArray(slots) || slots.length < 1 || slots.length > 6 ||
      new Set(slots.map(({ slotId }) => slotId)).size !== slots.length) {
    throw new Error("brave-run-fragment-slots-invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    sessionId: identity.sessionId,
    createdAt: created,
    sourceCommit: identity.sourceCommit,
    slots: Object.freeze([...slots])
  });
}

export async function runBraveMatrix({
  baseUrl,
  hostOsVersion,
  installRoot,
  platform,
  policy,
  runRoot,
  sessionId,
  sourceCommit,
  tunnelCreatedAt,
  hostOsIdentity = null,
  launchPersistentContext = chromium.launchPersistentContext
}) {
  const evidenceIdentity = validateEvidenceIdentity({ sessionId, sourceCommit });
  const origin = validateBaseUrl(baseUrl);
  requireIsoDateTime(tunnelCreatedAt, "brave-run-tunnel-created-at-invalid");
  const absoluteInstallRoot = resolve(installRoot);
  const absoluteRunRoot = validateRunRoot(runRoot, evidenceIdentity);
  const fragmentCreatedAt = new Date().toISOString();
  const manifest = JSON.parse(await readFile(resolve(absoluteInstallRoot, "manifest.json"), "utf8"));
  const plans = validateBraveEvidencePlan(planBraveRuns(policy, {
    hostOsVersion,
    manifest,
    platform
  }));
  await mkdir(absoluteRunRoot, { recursive: true });
  await assertCanonicalEvidenceRoot(absoluteRunRoot);
  await writeJsonExclusive(
    resolve(
      absoluteRunRoot,
      acquisitionEvidenceFilename(platform, hostOsVersion)
    ),
    manifest
  );
  const summaries = [];
  const matrixFailures = [];
  for (const plan of plans) {
    const executablePath = resolveContained(
      absoluteInstallRoot,
      plan.build.executablePath
    );
    const profileRoot = await mkdtemp(resolve(tmpdir(), PROFILE_PREFIX));
    let context;
    try {
      context = await launchPersistentContext(profileRoot, {
        executablePath,
        headless: process.env.AVAL_BRAVE_HEADED !== "1",
        args: [
          "--disable-extensions",
          "--disable-component-extensions-with-background-pages",
          "--no-default-browser-check",
          "--no-first-run"
        ],
        viewport: { width: 1440, height: 1100 }
      });
      const runtimeChromiumVersion = context.browser()?.version();
      assertRuntimeChromiumVersion(runtimeChromiumVersion, plan.build.chromiumVersion);
      const session = createBraveEvidenceSession({
        ...evidenceIdentity,
        slot: plan.slot,
        testedAt: new Date().toISOString(),
        tunnelCreatedAt,
        tunnelUrl: origin.href
      });
      const cases = [];
      for (const testCase of plan.cases) {
        try {
          cases.push(await runCase({
            context,
            origin,
            policy,
            runRoot: absoluteRunRoot,
            slot: plan.slot,
            ...testCase
          }));
        } catch (error) {
          const message = boundedText(error instanceof Error ? error.message : String(error));
          cases.push(Object.freeze({
            demoId: testCase.demo.id,
            mode: testCase.mode,
            status: "failed",
            error: message
          }));
          matrixFailures.push(`${plan.slot.id}:${testCase.demo.id}:${testCase.mode}:${message}`);
        }
      }
      const manifestSlot = cases.every(({ status }) => status === "passed")
        ? createBraveManifestSlot(
          plan.slot,
          cases.map(({ manifestCase }) => manifestCase)
        )
        : null;
      const summary = Object.freeze({
        schemaVersion: 1,
        status: cases.every(({ status }) => status === "passed") ? "passed" : "failed",
        slotId: plan.slot.id,
        sourceCommit: evidenceIdentity.sourceCommit,
        sessionId: evidenceIdentity.sessionId,
        hostOsVersion,
        hostOsIdentity,
        browser: Object.freeze({
          brand: "Brave",
          version: plan.build.version,
          chromiumVersion: plan.build.chromiumVersion,
          runtimeChromiumVersion,
          versionOutput: plan.build.versionOutput,
          signer: plan.build.signer
        }),
        cases: Object.freeze(cases),
        manifestSlot,
        session
      });
      const slotRoot = resolve(absoluteRunRoot, plan.slot.id);
      await ensureRealEvidenceDirectory(slotRoot);
      await writeJsonExclusive(resolve(slotRoot, "session.json"), session);
      summaries.push(summary);
    } finally {
      await context?.close();
      await rm(profileRoot, { recursive: true, force: true });
    }
  }
  if (matrixFailures.length !== 0) {
    throw new Error(
      `brave-run-matrix-failed:${String(matrixFailures.length)}:${boundedText(matrixFailures.join("|"))}`
    );
  }
  const fragment = createBraveManifestFragment({
    ...evidenceIdentity,
    createdAt: fragmentCreatedAt,
    slots: summaries.map(({ manifestSlot }) => manifestSlot)
  });
  await writeJsonExclusive(
    resolve(absoluteRunRoot, manifestFragmentFilename(platform, hostOsVersion)),
    fragment
  );
  return Object.freeze(summaries);
}

async function runCase({ context, demo, mode, origin, policy, runRoot, slot }) {
  const caseRoot = resolve(runRoot, slot.id, demo.id);
  await ensureRealEvidenceDirectory(resolve(runRoot, slot.id));
  await ensureRealEvidenceDirectory(caseRoot);
  const errors = [];
  let page;
  const url = new URL(demo.route, origin);
  url.searchParams.set("avalDiagnostics", "1");
  url.searchParams.set("avalCertificationMode", mode);
  const startedAt = new Date().toISOString();
  try {
    page = await context.newPage();
    page.on("pageerror", (error) => {
      errors.push({ kind: "pageerror", message: boundedText(error.message) });
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push({ kind: "console", message: boundedText(message.text()) });
      }
    });
    if (mode === "forced-h264") await installForcedH264SourcePolicy(page);
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: DEMO_TIMEOUT_MS });
    if (demo.id === "grass-rabbit-codecs" && mode === "forced-h264") {
      await page.locator("#codec-tab-h264").click({ timeout: DEMO_TIMEOUT_MS });
    }
    const player = page.locator(demo.playerSelector).last();
    await player.waitFor({ state: "visible", timeout: DEMO_TIMEOUT_MS });
    await installPageLedger(player);
    await waitForReadiness(player, "interactiveReady");
    await assertBrandedBrave(page, slot);
    const readyReport = await readPageReport(page);
    assertHealthyReport(readyReport, slot.id, demo.id, mode);
    assertBraveReportProof(readyReport, slot);
    const observedCodecs = assertAuthoredSources(readyReport, demo.id, mode, policy);
    const codecSelection = assertCodecSelection(readyReport, demo.id, mode, policy);
    await exerciseInteractions(page, player, demo, slot.interactionProfile);
    const target = page.locator(demo.interactionSelector).last();
    const checkpoints = await capturePixelWitness({
      caseRoot,
      demo,
      mode,
      page,
      player,
      slot,
      target
    });
    const soak = await soakInteractions(
      page,
      player,
      target,
      demo,
      slot.soakSeconds
    );
    const finalReport = await readPageReport(page);
    assertHealthyReport(finalReport, slot.id, demo.id, mode);
    assertBraveReportProof(finalReport, slot);
    const finalObservedCodecs = assertAuthoredSources(finalReport, demo.id, mode, policy);
    if (JSON.stringify(finalObservedCodecs) !== JSON.stringify(observedCodecs)) {
      throw new Error(`brave-run-authored-codecs-changed:${slot.id}:${demo.id}:${mode}`);
    }
    const finalCodecSelection = assertCodecSelection(finalReport, demo.id, mode, policy);
    if (finalCodecSelection.selectedCodec !== codecSelection.selectedCodec) {
      throw new Error(`brave-run-codec-changed-after-readiness:${slot.id}:${demo.id}:${mode}`);
    }
    const pageLedger = await player.evaluate((element) =>
      element.__avalCertificationLedger ?? { events: [], terminalFailures: 0 }
    );
    assertInteractionEvents(pageLedger.events, slot.id, demo, mode);
    if (pageLedger.terminalFailures !== 0) {
      throw new Error(`brave-run-fatal-after-readiness:${slot.id}:${demo.id}:${mode}`);
    }
    if (errors.length !== 0) throw new Error(`brave-run-page-errors:${slot.id}:${demo.id}:${mode}`);
    const contract = createBraveCaseEvidenceContract({
      checkpoints,
      demo,
      events: pageLedger.events,
      expectedAuthoredCodecs: observedCodecs,
      finishedAt: new Date().toISOString(),
      interactionProfile: slot.interactionProfile,
      mode,
      selectedCodec: codecSelection.selectedCodec,
      soak,
      startedAt,
      terminalFailures: 0,
      slotId: slot.id
    });
    await writeJsonExclusive(resolve(runRoot, contract.ledgerPath), contract.ledger);
    return Object.freeze({
      demoId: demo.id,
      mode,
      status: "passed",
      soakElapsedMilliseconds: soak.elapsedMilliseconds,
      eventCount: pageLedger.events.length,
      manifestCase: contract.manifestCase
    });
  } catch (error) {
    const failure = {
      schemaVersion: 1,
      slotId: slot.id,
      demoId: demo.id,
      mode,
      failedAt: new Date().toISOString(),
      error: boundedText(error instanceof Error ? error.message : String(error)),
      errors
    };
    await writeJsonExclusive(resolve(caseRoot, `${mode}-failure.json`), failure);
    if (page !== undefined) {
      const failurePng = await page.screenshot({ fullPage: true }).catch(() => null);
      if (failurePng !== null) {
        await writeFile(resolve(caseRoot, `${mode}-failure.png`), failurePng, {
          flag: "wx",
          mode: 0o444
        }).catch(() => undefined);
      }
    }
    throw error;
  } finally {
    await page?.close().catch(() => undefined);
  }
}

async function capturePixelWitness({ caseRoot, demo, mode, page, player, slot, target }) {
  const idle = demo.states[0];
  const active = demo.states.includes("hover") ? "hover" : demo.states.at(-1);
  const checkpoints = [];
  await waitForSettledState(player, idle);
  checkpoints.push(await captureDiagnosticCheckpoint({
    caseRoot,
    demo,
    id: idle,
    mode,
    page,
    player,
    slot,
    visualState: idle
  }));
  if (demo.states.includes("hover")) {
    await target.hover();
    await waitForVisualState(player, "entering");
    checkpoints.push(await captureDiagnosticCheckpoint({
      caseRoot,
      demo,
      id: "entering",
      mode,
      page,
      player,
      slot,
      visualState: "entering"
    }));
    await waitForSettledState(player, active);
    checkpoints.push(await captureDiagnosticCheckpoint({
      caseRoot,
      demo,
      id: active,
      mode,
      page,
      player,
      slot,
      visualState: active
    }));
    await movePointerOutside(page, target);
    await waitForVisualState(player, "exiting");
    checkpoints.push(await captureDiagnosticCheckpoint({
      caseRoot,
      demo,
      id: "exiting",
      mode,
      page,
      player,
      slot,
      visualState: "exiting"
    }));
    await waitForSettledState(player, idle);
  } else {
    await requestAndAwaitState(player, active);
    checkpoints.push(await captureDiagnosticCheckpoint({
      caseRoot,
      demo,
      id: active,
      mode,
      page,
      player,
      slot,
      visualState: active
    }));
    await requestAndAwaitState(player, idle);
  }
  const hashes = new Set(checkpoints.map(({ pngSha256 }) => pngSha256));
  if (hashes.size !== checkpoints.length ||
      !checkpoints.some(({ advancingFrame }) => advancingFrame)) {
    throw new Error(`brave-run-pixel-witness-invalid:${slot.id}:${demo.id}:${mode}`);
  }
  return Object.freeze(checkpoints);
}

async function captureDiagnosticCheckpoint({
  caseRoot,
  demo,
  id,
  mode,
  page,
  player,
  slot,
  visualState
}) {
  const outputSurface = player.locator('canvas[data-aval-layer="animated"]').last();
  await outputSurface.waitFor({ state: "visible", timeout: DEMO_TIMEOUT_MS });
  const [beforeReport, beforePng] = await Promise.all([
    readPageReport(page),
    outputSurface.screenshot({ animations: "allow", type: "png" })
  ]);
  if (beforeReport?.latest?.element?.visualState !== visualState) {
    throw new Error(`brave-run-checkpoint-state-mismatch:${slot.id}:${demo.id}:${mode}:${id}`);
  }
  await page.waitForTimeout(FRAME_SAMPLE_MS);
  await player.evaluate((element, label) => {
    const diagnostics = window.avalBrowserDiagnostics;
    if (diagnostics === undefined || diagnostics === null ||
        typeof diagnostics.checkpoint !== "function") {
      throw new Error("window.avalBrowserDiagnostics.checkpoint() unavailable");
    }
    diagnostics.checkpoint(label, element);
  }, `certification:${mode}:${id}`);
  const [report, png, contextPng] = await Promise.all([
    readPageReport(page),
    outputSurface.screenshot({ animations: "allow", type: "png" }),
    page.screenshot({ animations: "allow", fullPage: true, type: "png" })
  ]);
  assertHealthyReport(report, slot.id, demo.id, mode);
  assertBraveReportProof(report, slot);
  if (report?.latest?.element?.visualState !== visualState) {
    throw new Error(`brave-run-checkpoint-state-mismatch:${slot.id}:${demo.id}:${mode}:${id}`);
  }
  const beforeDrawsCompleted = readReportDrawsCompleted(beforeReport, slot, demo, mode, id);
  const afterDrawsCompleted = readReportDrawsCompleted(report, slot, demo, mode, id);
  const beforeCanvasSha256 = createHash("sha256").update(beforePng).digest("hex");
  const pngSha256 = createHash("sha256").update(png).digest("hex");
  const contextPngSha256 = createHash("sha256").update(contextPng).digest("hex");
  const beforePixels = analyzePngWitness(beforePng);
  const pixels = analyzePngWitness(png);
  const contextPixels = analyzePngWitness(contextPng);
  if (beforePng.length < 128 || png.length < 128 || contextPng.length < 128 ||
      !isMeaningfulPixelWitness(beforePixels) || !isMeaningfulPixelWitness(pixels) ||
      !isMeaningfulPixelWitness(contextPixels) || contextPngSha256 === pngSha256 ||
      contextPixels.width < pixels.width || contextPixels.height < pixels.height ||
      (contextPixels.width === pixels.width && contextPixels.height === pixels.height)) {
    throw new Error(`brave-run-pixel-witness-invalid:${slot.id}:${demo.id}:${mode}:${id}`);
  }
  await writeDiagnosticCheckpointExclusive(
    resolve(caseRoot, `${mode}-${id}.json`),
    report,
    resolve(caseRoot, `${mode}-${id}.png`),
    png,
    resolve(caseRoot, `${mode}-${id}-before.png`),
    beforePng,
    resolve(caseRoot, `${mode}-${id}-context.png`),
    contextPng
  );
  const advancingFrame = beforeCanvasSha256 !== pngSha256 &&
    afterDrawsCompleted > beforeDrawsCompleted;
  return Object.freeze({
    id,
    visualState,
    advancingFrame,
    pngSha256,
    contextPngSha256,
    frameProof: Object.freeze({
      beforeCanvasSha256,
      afterCanvasSha256: pngSha256,
      sampleIntervalMilliseconds: FRAME_SAMPLE_MS,
      beforeDrawsCompleted,
      afterDrawsCompleted
    })
  });
}

function readReportDrawsCompleted(report, slot, demo, mode, id) {
  const value = report?.latest?.element?.diagnostics?.runtime
    ?.playbackLifecycle?.drawsCompleted;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`brave-run-frame-counter-invalid:${slot.id}:${demo.id}:${mode}:${id}`);
  }
  return value;
}

export function analyzePngWitness(value) {
  const png = Buffer.isBuffer(value) ? value : Buffer.from(value ?? []);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (png.length < 33 || !png.subarray(0, 8).equals(signature)) {
    throw new Error("brave-run-pixel-png-invalid");
  }
  let offset = 8;
  let header = null;
  const imageData = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (length > 32 * 1_024 * 1_024 || end > png.length) {
      throw new Error("brave-run-pixel-png-invalid");
    }
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      if (header !== null || length !== 13) throw new Error("brave-run-pixel-png-invalid");
      header = Object.freeze({
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12]
      });
    } else if (type === "IDAT") {
      imageData.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = end;
  }
  if (header === null || imageData.length === 0 || header.width < 1 || header.height < 1 ||
      header.width * header.height > 16_777_216 || header.bitDepth !== 8 ||
      ![2, 6].includes(header.colorType) || header.compression !== 0 ||
      header.filter !== 0 || header.interlace !== 0) {
    throw new Error("brave-run-pixel-png-unsupported");
  }
  const bytesPerPixel = header.colorType === 6 ? 4 : 3;
  const rowBytes = header.width * bytesPerPixel;
  const inflated = inflateSync(Buffer.concat(imageData), {
    maxOutputLength: (rowBytes + 1) * header.height
  });
  if (inflated.length !== (rowBytes + 1) * header.height) {
    throw new Error("brave-run-pixel-png-invalid");
  }
  const previous = Buffer.alloc(rowBytes);
  const current = Buffer.alloc(rowBytes);
  let opaquePixels = 0;
  let nonBlackPixels = 0;
  let minimumLuma = 255;
  let maximumLuma = 0;
  const quantizedColors = new Set();
  for (let row = 0; row < header.height; row += 1) {
    const inputOffset = row * (rowBytes + 1);
    const filter = inflated[inputOffset];
    if (filter > 4) throw new Error("brave-run-pixel-png-invalid");
    for (let index = 0; index < rowBytes; index += 1) {
      const raw = inflated[inputOffset + 1 + index];
      const left = index >= bytesPerPixel ? current[index - bytesPerPixel] : 0;
      const above = previous[index];
      const upperLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;
      current[index] = unfilterPngByte(filter, raw, left, above, upperLeft);
    }
    for (let index = 0; index < rowBytes; index += bytesPerPixel) {
      const alpha = bytesPerPixel === 4 ? current[index + 3] : 255;
      if (alpha <= 16) continue;
      const red = current[index];
      const green = current[index + 1];
      const blue = current[index + 2];
      const luma = Math.round((red * 54 + green * 183 + blue * 19) / 256);
      opaquePixels += 1;
      if (luma > 6) nonBlackPixels += 1;
      minimumLuma = Math.min(minimumLuma, luma);
      maximumLuma = Math.max(maximumLuma, luma);
      if (quantizedColors.size < 257) {
        quantizedColors.add(`${red >> 4}:${green >> 4}:${blue >> 4}:${alpha >> 4}`);
      }
    }
    current.copy(previous);
  }
  return Object.freeze({
    width: header.width,
    height: header.height,
    opaquePixels,
    nonBlackPixels,
    lumaRange: opaquePixels === 0 ? 0 : maximumLuma - minimumLuma,
    quantizedColorCount: quantizedColors.size
  });
}

export function isMeaningfulPixelWitness(analysis) {
  const total = analysis.width * analysis.height;
  return analysis.opaquePixels >= Math.max(4, Math.ceil(total * 0.002)) &&
    analysis.nonBlackPixels >= Math.max(4, Math.ceil(analysis.opaquePixels * 0.002)) &&
    analysis.lumaRange >= 12 && analysis.quantizedColorCount >= 8;
}

function unfilterPngByte(filter, raw, left, above, upperLeft) {
  if (filter === 0) return raw;
  if (filter === 1) return (raw + left) & 255;
  if (filter === 2) return (raw + above) & 255;
  if (filter === 3) return (raw + Math.floor((left + above) / 2)) & 255;
  const predictor = left + above - upperLeft;
  const leftDistance = Math.abs(predictor - left);
  const aboveDistance = Math.abs(predictor - above);
  const upperLeftDistance = Math.abs(predictor - upperLeft);
  const paeth = leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
    ? left
    : aboveDistance <= upperLeftDistance ? above : upperLeft;
  return (raw + paeth) & 255;
}

async function installForcedH264SourcePolicy(page) {
  await page.addInitScript(() => {
    const isH264 = (source) => source.getAttribute("data-codec") === "h264";
    const prune = (root) => {
      if (!(root instanceof Element || root instanceof Document)) return;
      for (const source of root.querySelectorAll("aval-player > source")) {
        if (!isH264(source)) source.remove();
      }
    };
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) prune(node);
      }
      prune(document);
    }).observe(document, { childList: true, subtree: true });
  });
}

async function installPageLedger(player) {
  await player.evaluate((element, maximumEvents) => {
    const ledger = { events: [], terminalFailures: 0 };
    Object.defineProperty(element, "__avalCertificationLedger", {
      configurable: true,
      enumerable: false,
      value: ledger,
      writable: false
    });
    for (const type of ["transitionstart", "visualstatechange", "transitionend", "error"]) {
      element.addEventListener(type, (event) => {
        if (type === "error") {
          if (event.detail?.fatal === true) ledger.terminalFailures += 1;
          return;
        }
        if (ledger.events.length >= maximumEvents) return;
        ledger.events.push({
          type,
          at: performance.now(),
          detail: event.detail === undefined ? null : JSON.parse(JSON.stringify(event.detail))
        });
      });
    }
  }, MAX_LEDGER_EVENTS);
}

async function waitForReadiness(player, expected) {
  await player.evaluate((element, value) => new Promise((resolvePromise, reject) => {
    const inspect = () => {
      if (element.readiness === value) {
        cleanup();
        resolvePromise();
      } else if (element.readiness === "error") {
        cleanup();
        reject(new Error(`AVAL readiness error: ${JSON.stringify(element.getDiagnostics?.().lastFailure ?? null)}`));
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`AVAL readiness timeout: ${String(element.readiness)}`));
    }, 45_000);
    const cleanup = () => {
      clearTimeout(timeout);
      element.removeEventListener("readinesschange", inspect);
    };
    element.addEventListener("readinesschange", inspect);
    inspect();
  }), expected);
}

async function exerciseInteractions(page, player, demo, profile) {
  if (profile !== "desktop") throw new Error(`brave-run-interaction-profile:${profile}`);
  const target = page.locator(demo.interactionSelector).last();
  const idle = demo.states[0];
  const active = demo.states.includes("hover") ? "hover" : demo.states.at(-1);
  await waitForSettledState(player, idle);

  await target.hover();
  await waitForSettledState(player, active);
  await movePointerOutside(page, target);
  await waitForSettledState(player, idle);

  await target.focus();
  await waitForSettledState(player, active);
  await target.evaluate((element) => element.blur());
  await waitForSettledState(player, idle);

  if (!demo.states.includes("entering") || !demo.states.includes("exiting")) return;

  await target.focus();
  await waitForVisualState(player, "entering");
  await target.evaluate((element) => element.blur());
  await waitForSettledState(player, idle);

  await target.focus();
  await waitForSettledState(player, active);
  await target.evaluate((element) => element.blur());
  await waitForVisualState(player, "exiting");
  await target.focus();
  await waitForSettledState(player, active);
  await target.evaluate((element) => element.blur());
  await waitForSettledState(player, idle);

  await target.hover();
  await waitForVisualState(player, "entering");
  await movePointerOutside(page, target);
  await waitForSettledState(player, idle);

  await target.hover();
  await waitForSettledState(player, active);
  await movePointerOutside(page, target);
  await waitForVisualState(player, "exiting");
  await target.hover();
  await waitForSettledState(player, active);
  await movePointerOutside(page, target);
  await waitForSettledState(player, idle);
}

async function movePointerOutside(page, target) {
  const box = await target.boundingBox();
  const viewport = page.viewportSize() ?? { width: 1440, height: 1100 };
  const candidates = [
    { x: 1, y: 1 },
    { x: viewport.width - 2, y: 1 },
    { x: 1, y: viewport.height - 2 },
    { x: viewport.width - 2, y: viewport.height - 2 }
  ];
  const point = candidates.find(({ x, y }) => box === null ||
    x < box.x || x > box.x + box.width || y < box.y || y > box.y + box.height
  );
  if (point === undefined) throw new Error("brave-run-pointer-outside-unavailable");
  await page.mouse.move(point.x, point.y);
}

async function soakInteractions(page, player, target, demo, seconds) {
  const first = await readPlaybackEvidenceSnapshot(player);
  const clock = createMonotonicSoakClock(seconds);
  const active = demo.states.includes("hover") ? "hover" : demo.states.at(-1);
  const idle = demo.states[0];
  while (clock.shouldContinue()) {
    if (demo.states.includes("hover")) {
      await target.hover();
      await waitForSettledState(player, active);
      await movePointerOutside(page, target);
      await waitForSettledState(player, idle);
    } else {
      await requestAndAwaitState(player, active);
      await requestAndAwaitState(player, idle);
    }
  }
  const elapsedMilliseconds = clock.elapsedMilliseconds();
  if (elapsedMilliseconds < clock.requiredMilliseconds) {
    throw new Error("brave-run-soak-short");
  }
  const last = await readPlaybackEvidenceSnapshot(player);
  return Object.freeze({
    requiredMilliseconds: seconds * 1_000,
    elapsedMilliseconds,
    samples: Object.freeze([
      Object.freeze({ elapsedMilliseconds: 0, ...first }),
      Object.freeze({ elapsedMilliseconds, ...last })
    ])
  });
}

async function readPlaybackEvidenceSnapshot(player) {
  const snapshot = await player.evaluate((element) => {
    const diagnostics = typeof element.getDiagnostics === "function"
      ? element.getDiagnostics()
      : null;
    return {
      counters: diagnostics?.runtime?.playbackLifecycle ?? null,
      terminalFailures: element.__avalCertificationLedger?.terminalFailures ?? 0
    };
  });
  return Object.freeze({
    counters: normalizePlaybackCounters(snapshot.counters),
    terminalFailures: requireSafeCounter(
      snapshot.terminalFailures,
      "brave-run-terminal-failure-counter-invalid"
    )
  });
}

export function createMonotonicSoakClock(
  seconds,
  monotonicNow = () => performance.now()
) {
  if (!Number.isInteger(seconds) || seconds < 60) {
    throw new Error("brave-run-soak-too-short");
  }
  if (typeof monotonicNow !== "function") throw new Error("brave-run-soak-clock-invalid");
  const requiredMilliseconds = seconds * 1_000;
  const startedAt = monotonicNow();
  if (!Number.isFinite(startedAt)) throw new Error("brave-run-soak-clock-invalid");
  let lastObserved = startedAt;
  const readElapsed = () => {
    const observed = monotonicNow();
    if (!Number.isFinite(observed) || observed < lastObserved) {
      throw new Error("brave-run-soak-clock-nonmonotonic");
    }
    lastObserved = observed;
    return observed - startedAt;
  };
  return Object.freeze({
    requiredMilliseconds,
    shouldContinue: () => readElapsed() < requiredMilliseconds,
    elapsedMilliseconds: readElapsed
  });
}

async function requestAndAwaitState(player, state) {
  await player.evaluate(async (element, requested) => {
    if (typeof element.setState !== "function") throw new Error("setState() unavailable");
    await element.setState(requested);
    if (element.readiness !== "interactiveReady" || element.visualState !== requested ||
        element.isTransitioning) {
      throw new Error(`state did not settle: ${requested}/${String(element.visualState)}`);
    }
  }, state);
}

async function waitForSettledState(player, state) {
  await waitForPublicState(player, {
    isTransitioning: false,
    requestedState: state,
    visualState: state
  });
}

async function waitForVisualState(player, state) {
  await waitForPublicState(player, { visualState: state });
}

async function waitForPublicState(player, expected) {
  await player.evaluate((element, input) => new Promise((resolvePromise, reject) => {
    const matches = () => Object.entries(input).every(([key, value]) => element[key] === value);
    const inspect = () => {
      if (!matches()) return;
      cleanup();
      resolvePromise();
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`AVAL state timeout: ${JSON.stringify({
        expected: input,
        actual: {
          isTransitioning: element.isTransitioning,
          requestedState: element.requestedState,
          visualState: element.visualState
        }
      })}`));
    }, 30_000);
    const interval = setInterval(inspect, 16);
    const cleanup = () => {
      clearTimeout(timeout);
      clearInterval(interval);
      element.removeEventListener("transitionstart", inspect);
      element.removeEventListener("visualstatechange", inspect);
      element.removeEventListener("transitionend", inspect);
    };
    element.addEventListener("transitionstart", inspect);
    element.addEventListener("visualstatechange", inspect);
    element.addEventListener("transitionend", inspect);
    inspect();
  }), expected);
}

async function assertBrandedBrave(page, slot) {
  const proof = await page.evaluate(async () => ({
    isBrave: typeof navigator.brave?.isBrave === "function"
      ? await navigator.brave.isBrave()
      : false,
    userAgent: navigator.userAgent
  }));
  const chromiumMajor = String(slot.browser.engineVersion).split(".")[0];
  if (proof.isBrave !== true ||
      !new RegExp(`\\bChrome/${escapeRegExp(chromiumMajor)}\\.`, "u").test(proof.userAgent)) {
    throw new Error("brave-run-brand-substitution");
  }
  return Object.freeze(proof);
}

async function readPageReport(page) {
  return page.evaluate(() => {
    const diagnostics = window.avalBrowserDiagnostics;
    if (diagnostics === undefined || diagnostics === null ||
        typeof diagnostics.report !== "function") {
      throw new Error("window.avalBrowserDiagnostics.report() unavailable");
    }
    return diagnostics.report();
  });
}

function assertBraveReportProof(report, slot) {
  const environment = report?.environment;
  const userAgent = environment?.userAgent;
  const observedMajor = typeof userAgent === "string"
    ? /\bChrome\/([0-9]+)(?:\.|\b)/u.exec(userAgent)?.[1] ?? null
    : null;
  const expectedMajor = String(slot.browser.engineVersion).split(".")[0];
  if (environment?.capabilities?.braveBrandApi !== true ||
      observedMajor !== expectedMajor) {
    throw new Error(`brave-run-report-brand-proof-invalid:${slot.id}`);
  }
}

export function assertAuthoredSources(report, demoId, mode, policy) {
  const activePlayerId = report?.latest?.playerId;
  if (typeof activePlayerId !== "string") {
    throw new Error(`brave-run-active-player-missing:${demoId}:${mode}`);
  }
  const activeSources = (report?.authoredSources ?? []).filter(
    ({ playerId }) => playerId === activePlayerId
  );
  if (activeSources.length === 0) {
    throw new Error(`brave-run-active-sources-missing:${demoId}:${mode}`);
  }
  const observed = activeSources.map(({ codec }) => sourceCodecFamily(codec));
  if (observed.some((codec) => codec === null)) {
    throw new Error(`brave-run-authored-codec-unrecognized:${demoId}:${mode}`);
  }
  const expected = policy.requirements.authoredCodecsByMode[mode];
  if (JSON.stringify(observed) === JSON.stringify(expected)) return observed;
  throw new Error(`brave-run-authored-sources-mismatch:${demoId}:${mode}:${JSON.stringify(observed)}`);
}

export function assertCodecSelection(report, demoId, mode, policy) {
  const latest = report?.latest;
  const activePlayerId = latest?.playerId;
  const runtime = latest?.element?.diagnostics?.runtime;
  const selectedCodec = codecFamily(runtime?.selectedCodec);
  if (typeof activePlayerId !== "string" || selectedCodec === null) {
    throw new Error(`brave-run-selected-codec-missing:${demoId}:${mode}`);
  }
  const sources = (report?.authoredSources ?? []).filter(
    ({ playerId }) => playerId === activePlayerId
  );
  const sourceFamilies = sources.map(({ codec }) => sourceCodecFamily(codec));
  if (sourceFamilies.length === 0 || sourceFamilies.some((codec) => codec === null)) {
    throw new Error(`brave-run-selected-codec-source-missing:${demoId}:${mode}`);
  }
  const demo = policy.requirements.demos.find(({ id }) => id === demoId);
  if (demo === undefined) throw new Error(`brave-run-demo-missing:${demoId}`);
  if (runtime?.selectedRendition !== demo.renditionId) {
    throw new Error(`brave-run-selected-rendition-mismatch:${demoId}`);
  }
  if (mode === "forced-h264") {
    if (selectedCodec !== "h264") {
      throw new Error(`brave-run-forced-h264-not-selected:${demoId}:${selectedCodec}`);
    }
    return Object.freeze({ selectedCodec, selectedSourceIndex: sources[0].index, skipped: [] });
  }
  const selectedOffset = sourceFamilies.indexOf(selectedCodec);
  if (selectedOffset < 0) {
    throw new Error(`brave-run-selected-codec-not-authored:${demoId}:${selectedCodec}`);
  }
  const decoderDiagnostics = Array.isArray(runtime?.decoderDiagnostics)
    ? runtime.decoderDiagnostics
    : [];
  const rendererDiagnostics = Array.isArray(runtime?.rendererDiagnostics)
    ? runtime.rendererDiagnostics
    : [];
  const sourceGeneration = latest?.element?.diagnostics?.sourceGeneration;
  const skipped = sources.slice(0, selectedOffset).map((source, offset) => {
    const scopedDecoderDiagnostics = decoderDiagnostics.filter((candidate) =>
      diagnosticMatchesCandidate(
        candidate,
        source,
        sourceGeneration,
        demo.renditionId
      )
    );
    const scopedRendererDiagnostics = rendererDiagnostics.filter((candidate) =>
      diagnosticMatchesCandidate(
        candidate,
        source,
        sourceGeneration,
        demo.renditionId
      )
    );
    if (
      scopedDecoderDiagnostics.length + scopedRendererDiagnostics.length === 0 ||
      !scopedDecoderDiagnostics.every(permittedStartupDecoderFailure) ||
      !scopedRendererDiagnostics.every(permittedStartupRendererFailure)
    ) {
      throw new Error(
        `brave-run-unproven-codec-skip:${demoId}:${String(sourceFamilies[offset])}`
      );
    }
    const diagnostic = scopedDecoderDiagnostics[0] ?? scopedRendererDiagnostics[0];
    return Object.freeze({
      codec: sourceFamilies[offset],
      sourceIndex: source.index,
      code: diagnostic.code ?? "renderer-not-supported",
      phase: diagnostic.phase
    });
  });
  return Object.freeze({
    selectedCodec,
    selectedSourceIndex: sources[selectedOffset].index,
    skipped: Object.freeze(skipped)
  });
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

function assertHealthyReport(report, slotId, demoId, mode) {
  const latest = report?.latest?.element;
  if (latest?.readiness !== "interactiveReady" || latest?.diagnostics?.lastFailure !== null) {
    throw new Error(`brave-run-unhealthy-report:${slotId}:${demoId}:${mode}`);
  }
}

function assertInteractionEvents(events, slotId, demo, mode) {
  const demoId = demo.id;
  const types = new Set(events.map(({ type }) => type));
  for (const required of ["transitionstart", "visualstatechange", "transitionend"]) {
    if (!types.has(required)) {
      throw new Error(`brave-run-interaction-event-missing:${slotId}:${demoId}:${mode}:${required}`);
    }
  }
  const requiredEvidence = requiredInteractionEvidence(demo);
  const observedStates = new Set(events.flatMap(({ type, detail }) =>
    type === "visualstatechange" && typeof detail?.to === "string" ? [detail.to] : []
  ));
  const startedEdges = new Set(events.flatMap(({ type, detail }) =>
    type === "transitionstart" && typeof detail?.edge === "string" ? [detail.edge] : []
  ));
  const endedEdges = new Set(events.flatMap(({ type, detail }) =>
    type === "transitionend" && typeof detail?.edge === "string" ? [detail.edge] : []
  ));
  for (const state of requiredEvidence.states) {
    if (!observedStates.has(state)) {
      throw new Error(`brave-run-visual-state-missing:${slotId}:${demoId}:${mode}:${state}`);
    }
  }
  for (const edge of requiredEvidence.edges) {
    if (!startedEdges.has(edge) || !endedEdges.has(edge)) {
      throw new Error(`brave-run-transition-edge-missing:${slotId}:${demoId}:${mode}:${edge}`);
    }
  }
  if (events.some(({ type, detail }) => type === "error" && detail?.fatal === true)) {
    throw new Error(`brave-run-fatal-after-readiness:${slotId}:${demoId}:${mode}`);
  }
}

async function resolveHostOsIdentity(platform) {
  if (platform === "windows") {
    if (process.env.GITHUB_ACTIONS !== "true" || process.env.ImageOS !== "win25") {
      throw new Error("brave-run-windows-runner-not-windows-2025");
    }
    const script = [
      "$os = Get-CimInstance -ClassName Win32_OperatingSystem",
      "[pscustomobject]@{ caption = $os.Caption; version = $os.Version; build = $os.BuildNumber } | ConvertTo-Json -Compress"
    ].join("; ");
    const result = await execFile("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script
    ], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    let record;
    try {
      record = JSON.parse(result.stdout.trim());
    } catch {
      throw new Error("brave-host-os-identity-invalid");
    }
    if (!/\bWindows Server 2025\b/u.test(String(record.caption)) ||
        !/^10\.0\.26100(?:\.|$)/u.test(String(record.version)) ||
        String(record.build) !== "26100") {
      throw new Error("brave-run-windows-host-mismatch");
    }
    return Object.freeze({
      policyVersion: "2025",
      productName: String(record.caption),
      productVersion: String(record.version),
      buildVersion: String(record.build),
      runnerImage: process.env.ImageOS,
      runnerImageVersion: process.env.ImageVersion ?? null
    });
  }
  if (platform !== "macos") throw new Error(`brave-run-platform-invalid:${platform}`);
  const [versionResult, buildResult] = await Promise.all([
    execFile("sw_vers", ["-productVersion"], {
      encoding: "utf8",
      timeout: 10_000
    }),
    execFile("sw_vers", ["-buildVersion"], {
      encoding: "utf8",
      timeout: 10_000
    })
  ]);
  const version = versionResult.stdout.trim();
  const buildVersion = buildResult.stdout.trim();
  if (!/^\d+(?:\.\d+){1,2}$/u.test(version) || !/^[A-Za-z0-9]+$/u.test(buildVersion)) {
    throw new Error("brave-host-os-identity-invalid");
  }
  return Object.freeze({
    policyVersion: version,
    productName: "macOS",
    productVersion: version,
    buildVersion,
    runnerImage: null,
    runnerImageVersion: null
  });
}

export function assertRuntimeChromiumVersion(observed, expected) {
  if (typeof observed !== "string" || observed !== expected) {
    throw new Error(
      `brave-run-runtime-chromium-mismatch:${String(observed)}:${String(expected)}`
    );
  }
  return observed;
}

export function validateEvidenceIdentity({ sessionId, sourceCommit }) {
  if (typeof sourceCommit !== "string" || !/^[a-f0-9]{40}$/u.test(sourceCommit)) {
    throw new Error("brave-run-source-commit-invalid");
  }
  if (typeof sessionId !== "string" ||
      !/^[0-9]{8}T[0-9]{6}Z(?:-[a-z0-9][a-z0-9-]{0,47})?$/u.test(sessionId)) {
    throw new Error("brave-run-session-id-invalid");
  }
  return Object.freeze({ sessionId, sourceCommit });
}

function evidencePathSegment(value) {
  const segment = String(value).toLowerCase().replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  if (segment.length === 0 || segment.length > 64) {
    throw new Error("brave-run-host-os-version-invalid");
  }
  return segment;
}

export function acquisitionEvidenceFilename(platform, hostOsVersion) {
  if (platform !== "macos" && platform !== "windows") {
    throw new Error("brave-run-platform-invalid");
  }
  return `brave-acquisition-${platform}-${evidencePathSegment(hostOsVersion)}.json`;
}

export function manifestFragmentFilename(platform, hostOsVersion) {
  if (platform !== "macos" && platform !== "windows") {
    throw new Error("brave-run-platform-invalid");
  }
  return `brave-manifest-fragment-${platform}-${evidencePathSegment(hostOsVersion)}.json`;
}

function normalizeExpectedCodecs(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4 ||
      new Set(value).size !== value.length ||
      value.some((codec) => !SOURCE_CODEC_PRIORITY.includes(codec))) {
    throw new Error("brave-run-expected-codecs-invalid");
  }
  return Object.freeze([...value]);
}

function normalizeSoakEvidence(value) {
  if (value?.requiredMilliseconds !== 60_000 ||
      !Number.isFinite(value?.elapsedMilliseconds) || value.elapsedMilliseconds < 60_000 ||
      !Array.isArray(value?.samples) || value.samples.length < 2 || value.samples.length > 128) {
    throw new Error("brave-run-soak-evidence-invalid");
  }
  let previous = null;
  const samples = value.samples.map((sample) => {
    if (!Number.isFinite(sample?.elapsedMilliseconds) || sample.elapsedMilliseconds < 0) {
      throw new Error("brave-run-soak-sample-time-invalid");
    }
    const normalized = Object.freeze({
      elapsedMilliseconds: sample.elapsedMilliseconds,
      terminalFailures: requireSafeCounter(
        sample.terminalFailures,
        "brave-run-terminal-failure-counter-invalid"
      ),
      counters: normalizePlaybackCounters(sample.counters)
    });
    if (normalized.terminalFailures !== 0) throw new Error("brave-run-terminal-failure");
    if (previous !== null) {
      if (normalized.elapsedMilliseconds < previous.elapsedMilliseconds) {
        throw new Error("brave-run-soak-clock-nonmonotonic");
      }
      assertPlaybackCountersMonotonic(previous.counters, normalized.counters);
    }
    previous = normalized;
    return normalized;
  });
  const first = samples[0];
  const last = samples.at(-1);
  if (last.elapsedMilliseconds - first.elapsedMilliseconds < 60_000 ||
      last.counters.outputsAccepted <= first.counters.outputsAccepted ||
      last.counters.drawsCompleted <= first.counters.drawsCompleted) {
    throw new Error("brave-run-soak-counters-not-advancing");
  }
  return Object.freeze({
    requiredMilliseconds: 60_000,
    elapsedMilliseconds: value.elapsedMilliseconds,
    samples: Object.freeze(samples)
  });
}

function normalizePlaybackCounters(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("brave-run-playback-counters-invalid");
  }
  const counters = {};
  for (const key of PLAYBACK_COUNTER_KEYS) {
    counters[key] = requireSafeCounter(value[key], `brave-run-playback-counter-invalid:${key}`);
  }
  for (const key of PLAYBACK_LANE_COUNTER_KEYS) {
    const lanes = value[key];
    if (!Array.isArray(lanes) || lanes.length !== 2) {
      throw new Error(`brave-run-playback-counter-invalid:${key}`);
    }
    counters[key] = Object.freeze(lanes.map((lane, index) =>
      requireSafeCounter(lane, `brave-run-playback-counter-invalid:${key}:${String(index)}`)
    ));
  }
  return Object.freeze(counters);
}

function assertPlaybackCountersMonotonic(previous, current) {
  for (const key of PLAYBACK_COUNTER_KEYS) {
    if (current[key] < previous[key]) throw new Error(`brave-run-playback-counter-regressed:${key}`);
  }
  for (const key of PLAYBACK_LANE_COUNTER_KEYS) {
    for (let lane = 0; lane < 2; lane += 1) {
      if (current[key][lane] < previous[key][lane]) {
        throw new Error(`brave-run-playback-counter-regressed:${key}:${String(lane)}`);
      }
    }
  }
}

function requireSafeCounter(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
  return value;
}

function assertEvidenceIdentifier(value, label) {
  if (typeof value !== "string" || value.length > 128 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) {
    throw new Error(`brave-run-${label}-invalid`);
  }
}

function requireIsoDateTime(value, code) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(code);
  }
  return new Date(value).toISOString();
}

/* The endpoint must be HTTPS; its source commit is separately bound into every evidence file. */
function validateBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
      url.search !== "" || url.hash !== "" || url.pathname !== "/") {
    throw new Error("brave-run-base-url-must-be-https");
  }
  return url;
}

function validateRunRoot(value, identity) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error("brave-run-root-must-be-absolute");
  }
  const path = resolve(value);
  if (path === resolve(sep) || basename(path) !== identity.sessionId ||
      basename(dirname(path)) !== identity.sourceCommit ||
      basename(dirname(dirname(path))) !== "runs") {
    throw new Error("brave-run-root-unsafe");
  }
  return path;
}

async function assertCanonicalEvidenceRoot(path) {
  const [stat, canonical] = await Promise.all([lstat(path), realpath(path)]);
  const comparablePath = process.platform === "win32" ? path.toLowerCase() : path;
  const comparableCanonical = process.platform === "win32"
    ? resolve(canonical).toLowerCase()
    : resolve(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink() || comparableCanonical !== comparablePath) {
    throw new Error("brave-run-root-symlink-invalid");
  }
}

async function ensureRealEvidenceDirectory(path) {
  try {
    await mkdir(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("brave-run-evidence-directory-invalid");
  }
}

function resolveContained(root, path) {
  const resolved = resolve(root, path);
  const relation = relative(root, resolved);
  if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`) ||
      isAbsolute(relation)) throw new Error("brave-executable-path-invalid");
  return resolved;
}

async function writeJsonExclusive(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o444
  });
}

async function writeDiagnosticCheckpointExclusive(
  reportPath,
  report,
  pngPath,
  png,
  beforePngPath,
  beforePng,
  contextPngPath,
  contextPng
) {
  const targets = [reportPath, pngPath, beforePngPath, contextPngPath];
  const handles = [];
  try {
    for (const target of targets) handles.push(await open(target, "wx", 0o444));
    await Promise.all([
      handles[0].writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8"),
      handles[1].writeFile(png),
      handles[2].writeFile(beforePng),
      handles[3].writeFile(contextPng)
    ]);
    await Promise.all(handles.map((handle) => handle.sync()));
  } catch (error) {
    await Promise.allSettled(handles.map((handle) => handle.close()));
    await Promise.allSettled(targets.slice(0, handles.length).map((target) =>
      rm(target, { force: true })
    ));
    throw error;
  }
  await Promise.all(handles.map((handle) => handle.close()));
}

function boundedText(value) {
  return String(value).replace(/[\r\n\t]+/gu, " ").slice(0, 1_024);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function parseArguments(values) {
  const parsed = {
    baseUrl: null,
    installRoot: null,
    platform: null,
    policy: null,
    runRoot: null,
    sessionId: null,
    sourceCommit: null,
    tunnelCreatedAt: null
  };
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    const next = values[++index] ?? null;
    if (key === "--base-url") parsed.baseUrl = next;
    else if (key === "--install-root") parsed.installRoot = next;
    else if (key === "--platform") parsed.platform = next;
    else if (key === "--policy") parsed.policy = next;
    else if (key === "--run-root") parsed.runRoot = next;
    else if (key === "--session-id") parsed.sessionId = next;
    else if (key === "--source-commit") parsed.sourceCommit = next;
    else if (key === "--tunnel-created-at") parsed.tunnelCreatedAt = next;
    else throw new Error(`unknown argument: ${String(key)}`);
  }
  for (const required of [
    "baseUrl",
    "installRoot",
    "platform",
    "policy",
    "runRoot",
    "sessionId",
    "sourceCommit",
    "tunnelCreatedAt"
  ]) {
    if (parsed[required] === null) throw new Error(`missing argument: --${required.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`);
  }
  return parsed;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const policy = JSON.parse(await readFile(resolve(args.policy), "utf8"));
  const hostOsIdentity = await resolveHostOsIdentity(args.platform);
  const hostOsVersion = hostOsIdentity.policyVersion;
  const summaries = await runBraveMatrix({
    ...args,
    hostOsIdentity,
    hostOsVersion,
    policy
  });
  process.stdout.write(`${JSON.stringify({
    cases: summaries.reduce((count, summary) => count + summary.cases.length, 0),
    slots: summaries.map(({ slotId }) => slotId),
    status: "passed"
  })}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
