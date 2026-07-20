import { expect, test, type Locator } from "@playwright/test";

import {
  activateBrowserDiagnosticTarget,
  type BrowserDiagnosticEvidenceCheckpointArtifacts,
  browserDiagnosticCertificationModeFromEnvironment,
  browserDiagnosticEvidenceTargetFromEnvironment,
  browserDiagnosticExpectedOutcomeFromEnvironment,
  browserDiagnosticInteractionProfileFromEnvironment,
  captureBrowserDiagnosticArtifacts,
  captureBrowserDiagnosticPlaybackSoak,
  captureDeterministicUnsupportedBrowserEvidence,
  captureOperation,
  deactivateBrowserDiagnosticTarget,
  finalizeBrowserDiagnosticEvidenceFromEnvironment,
  openWithDiagnostics
} from "../support/browser-diagnostic-capture.js";

test("captures codec controller preparation diagnostics", async ({
  page
}, testInfo) => {
  const certificationMode = browserDiagnosticCertificationModeFromEnvironment();
  const expectedOutcome = browserDiagnosticExpectedOutcomeFromEnvironment();
  const interactionProfile = browserDiagnosticInteractionProfileFromEnvironment();
  const evidenceCheckpoints: BrowserDiagnosticEvidenceCheckpointArtifacts[] = [];
  if (process.env.AVAL_BROWSER_EVIDENCE_RUN_ROOT !== undefined) {
    testInfo.setTimeout(Math.max(testInfo.timeout, 150_000));
  }
  await openWithDiagnostics(page);
  if (expectedOutcome === "deterministic-error") {
    await captureDeterministicUnsupportedBrowserEvidence(page, testInfo, {
      demoId: "grass-rabbit-codecs",
      playerSelector: "aval-player",
      artifactName: "grass-rabbit-codecs"
    });
    return;
  }
  if (certificationMode === "forced-h264") {
    await page.waitForFunction(() =>
      (window as Window & { readonly grassRabbitCodecs?: unknown })
        .grassRabbitCodecs !== undefined
    );
    await page.locator("#codec-tab-h264").click();
  }
  const ready = await captureOperation(
    page,
    "codec-demo-ready",
    () => page.evaluate(async () => {
      const api = (window as Window & {
        readonly grassRabbitCodecs?: { readonly ready: Promise<void> };
      }).grassRabbitCodecs;
      if (api === undefined) throw new Error("Codec demo API is unavailable");
      await api.ready;
    })
  );
  const captureState = async (state: "idle" | "entering" | "hover" | "exiting") =>
    captureBrowserDiagnosticArtifacts(
      page,
      testInfo,
      `grass-rabbit-codecs-${state}`,
      {
        evidence: browserDiagnosticEvidenceTargetFromEnvironment({
          demoId: "grass-rabbit-codecs",
          checkpoint: state
        }),
        onEvidenceWritten: (artifacts) => evidenceCheckpoints.push(artifacts)
      }
    );
  await captureState("idle");
  const player = page.locator("aval-player:visible").last();
  if (ready.outcome === "completed") {
    await activateBrowserDiagnosticTarget(page, player);
    await waitForCodecState(player, "entering");
    await captureState("entering");
    await waitForCodecState(player, "hover", true);
    await captureState("hover");
    await deactivateBrowserDiagnosticTarget(page, player);
    await waitForCodecState(player, "exiting");
    await captureState("exiting");
    await waitForCodecState(player, "idle", true);
  }
  const failed = await captureOperation(
    page,
    "synthetic-error",
    () => Promise.reject(new Error("Synthetic diagnostic capture failure"))
  );
  const timedOut = await captureOperation(
    page,
    "synthetic-timeout",
    () => new Promise<never>(() => undefined),
    { timeoutMilliseconds: 25 }
  );
  if (interactionProfile === "desktop") {
    await player.focus();
    await waitForCodecState(player, "hover", true);
    await player.evaluate((element) => (element as HTMLElement).blur());
    await waitForCodecState(player, "idle", true);
  }
  const measuredRun = await captureBrowserDiagnosticPlaybackSoak(
    page,
    "aval-player:visible",
    async () => {
      await waitForCodecState(player, "idle", true);
      await activateBrowserDiagnosticTarget(page, player);
      await waitForCodecState(player, "entering");
      await deactivateBrowserDiagnosticTarget(page, player);
      await waitForCodecState(player, "exiting");
      await activateBrowserDiagnosticTarget(page, player);
      await waitForCodecState(player, "entering");
      await waitForCodecState(player, "hover", true);
      await deactivateBrowserDiagnosticTarget(page, player);
      await waitForCodecState(player, "exiting");
      await waitForCodecState(player, "idle", true);
    }
  );
  const report = await captureBrowserDiagnosticArtifacts(
    page,
    testInfo,
    "grass-rabbit-codecs-interacted"
  );
  await finalizeBrowserDiagnosticEvidenceFromEnvironment({
    demoId: "grass-rabbit-codecs",
    checkpoints: evidenceCheckpoints,
    measuredRun
  });

  expect(ready.outcome).toBe("completed");
  expect(failed.outcome).toBe("error");
  expect(timedOut.outcome).toBe("timeout");
  if (certificationMode === "forced-h264") {
    expect(report.authoredSources.map(({ codec }) => codec)).toEqual([
      "avc1.42E01E"
    ]);
  } else {
    const runtime = report.latest?.element.diagnostics?.runtime as
      Readonly<{ readonly selectedCodec?: unknown }> | undefined;
    expect(runtime?.selectedCodec).not.toMatch(/^avc1\./u);
  }
  expect(ready.report.checkpoints.map(({ label }) => label)).toEqual(
    expect.arrayContaining([
      "before:codec-demo-controller",
      "before:codec-demo-ready",
      "after:codec-demo-ready"
    ])
  );
  expect(failed.report.checkpoints.map(({ label }) => label)).toContain(
    "error:synthetic-error"
  );
  expect(timedOut.report.checkpoints.map(({ label }) => label)).toContain(
    "timeout:synthetic-timeout"
  );
});

async function waitForCodecState(
  player: Locator,
  state: "idle" | "entering" | "hover" | "exiting",
  settled = false
): Promise<void> {
  await expect.poll(async () => player.evaluate((element) => ({
    isTransitioning: (element as HTMLElement & {
      readonly isTransitioning?: boolean;
    }).isTransitioning,
    visualState: (element as HTMLElement & {
      readonly visualState?: string | null;
    }).visualState
  })), { timeout: 20_000 }).toEqual({
    isTransitioning: settled ? false : expect.any(Boolean),
    visualState: state
  });
}
