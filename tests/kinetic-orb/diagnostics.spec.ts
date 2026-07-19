import { expect, test } from "@playwright/test";

import {
  captureBrowserDiagnosticArtifacts,
  captureOperation,
  openWithDiagnostics
} from "../support/browser-diagnostic-capture.js";

test("captures kinetic orb readiness and interaction diagnostics", async ({
  page
}, testInfo) => {
  await openWithDiagnostics(page);
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

  let hovered = null;
  if (ready.outcome === "completed") {
    hovered = await captureOperation(
      page,
      "kinetic-orb-hover",
      async () => {
        const motion = page.locator("#kinetic-orb");
        await motion.hover();
        await page.waitForFunction(() =>
          (document.querySelector("#kinetic-orb") as HTMLElement & {
            readonly visualState?: string | null;
          } | null)?.visualState === "hover"
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
  const report = await captureBrowserDiagnosticArtifacts(
    page,
    testInfo,
    "kinetic-orb-diagnostics"
  );

  expect(ready.outcome).toBe("completed");
  expect(hovered?.outcome).toBe("completed");
  expect(failed.outcome).toBe("error");
  expect(timedOut.outcome).toBe("timeout");
  expect(report.authoredSources.map(({ codec }) => codec)).toEqual([
    "avc1.64001E"
  ]);
  expect(report.checkpoints.map(({ label }) => label)).toEqual(
    expect.arrayContaining([
      "before:kinetic-orb-ready",
      "after:kinetic-orb-ready",
      "error:synthetic-error",
      "timeout:synthetic-timeout"
    ])
  );
});
