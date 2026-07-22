import { expect, test, type Page } from "@playwright/test";

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

test("captures kinetic orb readiness and interaction diagnostics", async ({
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
      demoId: "kinetic-orb",
      playerSelector: "#kinetic-orb",
      artifactName: "kinetic-orb"
    });
    return;
  }
  const ready = await captureOperation(
    page,
    "kinetic-orb-ready",
    () => page.waitForFunction(() =>
      (document.querySelector("#kinetic-orb") as HTMLElement & {
        readonly readiness?: string;
      } | null)?.readiness === "interactiveReady"
    ),
    { playerSelector: "#kinetic-orb" }
  );
  const captureState = async (state: "idle" | "entering" | "hover" | "exiting") =>
    captureBrowserDiagnosticArtifacts(page, testInfo, `kinetic-orb-${state}`, {
      evidence: browserDiagnosticEvidenceTargetFromEnvironment({
        demoId: "kinetic-orb",
        checkpoint: state
      }),
      onEvidenceWritten: (artifacts) => evidenceCheckpoints.push(artifacts)
    });
  await captureState("idle");

  let hovered = null;
  if (ready.outcome === "completed") {
    hovered = await captureOperation(
      page,
      "kinetic-orb-hover",
      async () => {
        const motion = page.locator("#kinetic-orb");
        await activateBrowserDiagnosticTarget(page, motion);
        await page.waitForFunction(() =>
          (document.querySelector("#kinetic-orb") as HTMLElement & {
            readonly visualState?: string | null;
          } | null)?.visualState === "entering"
        );
        await captureState("entering");
        await page.waitForFunction(() =>
          (document.querySelector("#kinetic-orb") as HTMLElement & {
            readonly visualState?: string | null;
          } | null)?.visualState === "hover"
        );
        await captureState("hover");
        await deactivateBrowserDiagnosticTarget(page, motion);
        await page.waitForFunction(() =>
          (document.querySelector("#kinetic-orb") as HTMLElement & {
            readonly visualState?: string | null;
          } | null)?.visualState === "exiting"
        );
        await captureState("exiting");
        await page.waitForFunction(() =>
          (document.querySelector("#kinetic-orb") as HTMLElement & {
            readonly visualState?: string | null;
          } | null)?.visualState === "idle"
        );
      },
      { playerSelector: "#kinetic-orb" }
    );
  }
  const failed = await captureOperation(
    page,
    "synthetic-error",
    () => Promise.reject(new Error("Synthetic diagnostic capture failure")),
    { playerSelector: "#kinetic-orb" }
  );
  const timedOut = await captureOperation(
    page,
    "synthetic-timeout",
    () => new Promise<never>(() => undefined),
    { playerSelector: "#kinetic-orb", timeoutMilliseconds: 25 }
  );
  const motion = page.locator("#kinetic-orb");
  if (interactionProfile === "desktop") {
    await motion.focus();
    await waitForOrbState(page, "hover", true);
    await motion.evaluate((element) => (element as HTMLElement).blur());
    await waitForOrbState(page, "idle", true);
  }
  const measuredRun = await captureBrowserDiagnosticPlaybackSoak(
    page,
    "#kinetic-orb",
    async () => {
      await waitForOrbState(page, "idle", true);
      await activateBrowserDiagnosticTarget(page, motion);
      await waitForOrbState(page, "entering");
      await deactivateBrowserDiagnosticTarget(page, motion);
      await waitForOrbState(page, "exiting");
      await activateBrowserDiagnosticTarget(page, motion);
      await waitForOrbState(page, "entering");
      await waitForOrbState(page, "hover", true);
      await deactivateBrowserDiagnosticTarget(page, motion);
      await waitForOrbState(page, "exiting");
      await waitForOrbState(page, "idle", true);
    }
  );
  const report = await captureBrowserDiagnosticArtifacts(
    page,
    testInfo,
    "kinetic-orb-interacted"
  );
  await finalizeBrowserDiagnosticEvidenceFromEnvironment({
    demoId: "kinetic-orb",
    checkpoints: evidenceCheckpoints,
    measuredRun
  });

  expect(ready.outcome).toBe("completed");
  expect(hovered?.outcome).toBe("completed");
  expect(failed.outcome).toBe("error");
  expect(timedOut.outcome).toBe("timeout");
  expect(report.authoredSources.map(({ codec }) => codec)).toEqual(
    certificationMode === "forced-h264"
      ? ["h264"]
      : ["av1", "vp9", "h265", "h264"]
  );
  expect(report.checkpoints.map(({ label }) => label)).toEqual(
    expect.arrayContaining([
      "before:kinetic-orb-ready",
      "after:kinetic-orb-ready",
      "error:synthetic-error",
      "timeout:synthetic-timeout"
    ])
  );
});

async function waitForOrbState(
  page: Page,
  state: "idle" | "entering" | "hover" | "exiting",
  settled = false
): Promise<void> {
  await page.waitForFunction(({ expectedState, requireSettled }) => {
    const player = document.querySelector("#kinetic-orb") as HTMLElement & {
      readonly visualState?: string | null;
      readonly isTransitioning?: boolean;
    } | null;
    return player !== null && player.visualState === expectedState &&
      (!requireSettled || player.isTransitioning === false);
  }, { expectedState: state, requireSettled: settled });
}
