import { expect, test } from "@playwright/test";

import {
  captureBrowserDiagnosticArtifacts,
  captureOperation,
  openWithDiagnostics
} from "../support/browser-diagnostic-capture.js";

test("captures grass rabbit readiness and interaction diagnostics", async ({
  page
}, testInfo) => {
  await openWithDiagnostics(page);
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

  let hovered = null;
  if (ready.outcome === "completed") {
    hovered = await captureOperation(
      page,
      "grass-rabbit-hover",
      async () => {
        const motion = page.locator("#grass-rabbit");
        await motion.focus();
        await page.waitForFunction(() =>
          (document.querySelector("#grass-rabbit") as HTMLElement & {
            readonly visualState?: string | null;
          } | null)?.visualState === "hover"
        );
      },
      { playerSelector: "#grass-rabbit" }
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
  const report = await captureBrowserDiagnosticArtifacts(
    page,
    testInfo,
    "grass-rabbit-diagnostics"
  );

  expect(ready.outcome).toBe("completed");
  expect(hovered?.outcome).toBe("completed");
  expect(failed.outcome).toBe("error");
  expect(timedOut.outcome).toBe("timeout");
  expect(report.authoredSources).toHaveLength(4);
  expect(report.checkpoints.map(({ label }) => label)).toEqual(
    expect.arrayContaining([
      "before:grass-rabbit-ready",
      "after:grass-rabbit-ready",
      "error:synthetic-error",
      "timeout:synthetic-timeout"
    ])
  );
});
