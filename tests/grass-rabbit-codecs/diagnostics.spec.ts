import { expect, test } from "@playwright/test";

import {
  captureBrowserDiagnosticArtifacts,
  captureOperation,
  openWithDiagnostics
} from "../support/browser-diagnostic-capture.js";

test("captures codec controller preparation diagnostics", async ({
  page
}, testInfo) => {
  await openWithDiagnostics(page);
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
  const report = await captureBrowserDiagnosticArtifacts(
    page,
    testInfo,
    "grass-rabbit-codecs-diagnostics"
  );

  expect(ready.outcome).toBe("completed");
  expect(failed.outcome).toBe("error");
  expect(timedOut.outcome).toBe("timeout");
  expect(report.checkpoints.map(({ label }) => label)).toEqual(
    expect.arrayContaining([
      "before:codec-demo-controller",
      "before:codec-demo-ready",
      "after:codec-demo-ready",
      "error:synthetic-error",
      "timeout:synthetic-timeout"
    ])
  );
});
