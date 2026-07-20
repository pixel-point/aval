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

test("captures grass rabbit readiness and interaction diagnostics", async ({
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
      demoId: "grass-rabbit",
      playerSelector: "#grass-rabbit",
      artifactName: "grass-rabbit"
    });
    return;
  }
  const ready = await captureOperation(
    page,
    "grass-rabbit-ready",
    () => page.waitForFunction(() =>
      (document.querySelector("#grass-rabbit") as HTMLElement & {
        readonly readiness?: string;
      } | null)?.readiness === "interactiveReady"
    ),
    { playerSelector: "#grass-rabbit" }
  );
  const captureState = async (state: "idle" | "entering" | "hover" | "exiting") =>
    captureBrowserDiagnosticArtifacts(page, testInfo, `grass-rabbit-${state}`, {
      evidence: browserDiagnosticEvidenceTargetFromEnvironment({
        demoId: "grass-rabbit",
        checkpoint: state
      }),
      onEvidenceWritten: (artifacts) => evidenceCheckpoints.push(artifacts)
    });
  await captureState("idle");

  let hovered = null;
  if (ready.outcome === "completed") {
    hovered = await captureOperation(
      page,
      "grass-rabbit-hover",
      async () => {
        const motion = page.locator("#grass-rabbit");
        await activateBrowserDiagnosticTarget(page, motion);
        await page.waitForFunction(() =>
          (document.querySelector("#grass-rabbit") as HTMLElement & {
            readonly visualState?: string | null;
          } | null)?.visualState === "entering"
        );
        await captureState("entering");
        await page.waitForFunction(() =>
          (document.querySelector("#grass-rabbit") as HTMLElement & {
            readonly visualState?: string | null;
          } | null)?.visualState === "hover"
        );
        await captureState("hover");
        await deactivateBrowserDiagnosticTarget(page, motion);
        await page.waitForFunction(() =>
          (document.querySelector("#grass-rabbit") as HTMLElement & {
            readonly visualState?: string | null;
          } | null)?.visualState === "exiting"
        );
        await captureState("exiting");
        await page.waitForFunction(() =>
          (document.querySelector("#grass-rabbit") as HTMLElement & {
            readonly visualState?: string | null;
          } | null)?.visualState === "idle"
        );
      },
      { playerSelector: "#grass-rabbit", timeoutMilliseconds: 20_000 }
    );
  }
  const failed = await captureOperation(
    page,
    "synthetic-error",
    () => Promise.reject(new Error("Synthetic diagnostic capture failure")),
    { playerSelector: "#grass-rabbit" }
  );
  const timedOut = await captureOperation(
    page,
    "synthetic-timeout",
    () => new Promise<never>(() => undefined),
    { playerSelector: "#grass-rabbit", timeoutMilliseconds: 25 }
  );
  const motion = page.locator("#grass-rabbit");
  if (interactionProfile === "desktop") {
    await motion.focus();
    await waitForRabbitState(page, "hover", true);
    await motion.evaluate((element) => (element as HTMLElement).blur());
    await waitForRabbitState(page, "idle", true);
  }
  const measuredRun = await captureBrowserDiagnosticPlaybackSoak(
    page,
    "#grass-rabbit",
    async () => {
      await waitForRabbitState(page, "idle", true);
      await activateBrowserDiagnosticTarget(page, motion);
      await waitForRabbitState(page, "entering");
      await deactivateBrowserDiagnosticTarget(page, motion);
      await waitForRabbitState(page, "exiting");
      await activateBrowserDiagnosticTarget(page, motion);
      await waitForRabbitState(page, "entering");
      await waitForRabbitState(page, "hover", true);
      await deactivateBrowserDiagnosticTarget(page, motion);
      await waitForRabbitState(page, "exiting");
      await waitForRabbitState(page, "idle", true);
    }
  );
  const report = await captureBrowserDiagnosticArtifacts(
    page,
    testInfo,
    "grass-rabbit-interacted"
  );
  await finalizeBrowserDiagnosticEvidenceFromEnvironment({
    demoId: "grass-rabbit",
    checkpoints: evidenceCheckpoints,
    measuredRun
  });

  expect(ready.outcome).toBe("completed");
  expect(hovered?.outcome).toBe("completed");
  expect(failed.outcome).toBe("error");
  expect(timedOut.outcome).toBe("timeout");
  expect(report.authoredSources).toHaveLength(
    certificationMode === "forced-h264" ? 1 : 4
  );
  expect(report.checkpoints.map(({ label }) => label)).toEqual(
    expect.arrayContaining([
      "before:grass-rabbit-ready",
      "after:grass-rabbit-ready",
      "error:synthetic-error",
      "timeout:synthetic-timeout"
    ])
  );
});

async function waitForRabbitState(
  page: Page,
  state: "idle" | "entering" | "hover" | "exiting",
  settled = false
): Promise<void> {
  await page.waitForFunction(({ expectedState, requireSettled }) => {
    const player = document.querySelector("#grass-rabbit") as HTMLElement & {
      readonly visualState?: string | null;
      readonly isTransitioning?: boolean;
    } | null;
    return player !== null && player.visualState === expectedState &&
      (!requireSettled || player.isTransitioning === false);
  }, { expectedState: state, requireSettled: settled });
}
