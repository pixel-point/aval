import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";

import { canonicalJsonBytes } from "../../packages/certification/src/canonical-json.js";
import { evaluateFatalErrorBoundaryLedger } from "../../packages/certification/src/fatal-error-boundary-ledger.js";

interface BrowserCertificationApi {
  readonly ready: Promise<void>;
  runResourceFaultProfile(options: Readonly<{ full: boolean }>): Promise<Readonly<{
    readonly status: string;
    readonly failures: readonly string[];
    readonly lifecycle: Readonly<{
      readonly status: string;
      readonly failures: readonly string[];
      readonly requestedCycles: number;
      readonly completedCycles: number;
      readonly sourceReplacements: number;
      readonly adoptionCycles: number;
    }>;
    readonly network: readonly Readonly<{
      readonly scenario: string;
      readonly status: string;
      readonly terminalErrorBoundaryObserved: boolean;
      readonly outstandingSettled: boolean;
      readonly fatalErrorBoundary: Readonly<{
        readonly passed: boolean;
        readonly failures: readonly string[];
        readonly ledger: unknown;
      }> | null;
    }>[];
  }>>;
  getLastExport(): Readonly<{ readonly canonicalJson: string }> | null;
}

const candidateManifestDigest = "c".repeat(64);
const fixtureDigest = "a77d616640162f6f1ac504dc39bc5d55cce83e0927286cc97bc5632bb10f3898";
const harnessDigest = "d".repeat(64);
const runId = "candidate-boundary-browser-test";
const environment = Object.freeze({
  evidenceClass: "candidate-bound-functional-engine",
  brandedBrowserCertification: false,
  observedDisplayEvidence: false
});
const environmentDigest = createHash("sha256").update(canonicalJsonBytes(environment)).digest("hex");
const profileId = `profile-${environmentDigest.slice(0, 20)}`;

test("resource fault profile exports independently valid terminal-boundary ledger input", async ({ page }) => {
  await installRunConfig(page);
  await page.goto("/certification.html");
  const captured = await runResourceFaultProfile(page);

  expect(captured.lifecycle.failures).toEqual([]);
  expect(captured.result?.fatalErrorBoundary?.failures).toEqual([]);
  expect(captured.failures).toEqual([]);
  expect(captured.lifecycle).toMatchObject({
    status: "passed",
    requestedCycles: 3,
    completedCycles: 3,
    sourceReplacements: 3,
    adoptionCycles: 3
  });
  expect(captured.status).toBe("passed");
  expect(captured.result).toMatchObject({
    status: "passed",
    terminalErrorBoundaryObserved: true,
    outstandingSettled: true,
    fatalErrorBoundary: {
      passed: true,
      failures: [],
      ledger: {
        ledgerKind: "runtime-fatal-error-boundary",
        fixtureDigest,
        harnessDigest,
        runId,
        profileId,
        environmentDigest,
        errorEventCount: 1,
        errorEventFatal: true,
        rejectedErrorName: "AvalPlaybackError",
        readiness: "error",
        eventFailureIsRejectedFailure: true,
        diagnosticsFailureIsRejectedFailure: true,
        repeatedPrepareRejected: true,
        repeatedPrepareErrorIsRejectedError: true,
        sourceCleanup: { completed: true },
        outstanding: { player: 0, decoder: 0, bytes: 0 }
      }
    }
  });
  const ledger = captured.result?.fatalErrorBoundary?.ledger;
  expect(ledger).not.toBeNull();
  expect(evaluateFatalErrorBoundaryLedger(ledger, {
    candidateManifestDigest,
    fixtureDigest,
    harnessDigest,
    runId,
    profileId,
    environmentDigest
  }).evaluation).toEqual({ passed: true, failures: [] });
  expect(captured.canonicalJson).toContain('"ledgerKind":"runtime-fatal-error-boundary"');
  expect(JSON.stringify(captured.result)).not.toMatch(/alternate|fallback/iu);
});

test("a delayed duplicate fatal error event invalidates the boundary witness", async ({ page }) => {
  await page.addInitScript(() => {
    const dispatchEvent = EventTarget.prototype.dispatchEvent;
    let duplicateScheduled = false;
    EventTarget.prototype.dispatchEvent = function(this: EventTarget, event: Event): boolean {
      const dispatched = dispatchEvent.call(this, event);
      const detail = (event as CustomEvent<Readonly<{ fatal?: unknown }>>).detail;
      if (
        !duplicateScheduled && event.type === "error" && detail?.fatal === true &&
        this instanceof HTMLElement && this.localName === "aval-player"
      ) {
        duplicateScheduled = true;
        setTimeout(() => {
          dispatchEvent.call(this, new CustomEvent("error", { detail }));
        }, 0);
      }
      return dispatched;
    };
  });
  await installRunConfig(page);
  await page.goto("/certification.html");
  const captured = await runResourceFaultProfile(page);

  expect(captured.status).toBe("failed");
  expect(captured.failures).toContain("network-fault-fatal-boundary-network");
  expect(captured.result).toMatchObject({
    status: "failed",
    terminalErrorBoundaryObserved: false,
    outstandingSettled: true,
    fatalErrorBoundary: {
      passed: false,
      failures: ["error-event-count-not-one"],
      ledger: null
    }
  });
});

async function installRunConfig(page: Page): Promise<void> {
  await page.route("**/__aval_certification__/run-config.json", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "x-aval-candidate-run-config": "1",
        "x-aval-candidate-manifest-sha256": candidateManifestDigest
      },
      body: JSON.stringify({
        schemaVersion: "1.0",
        runId,
        mode: "functional",
        profile: "pull-request",
        candidateManifestDigest,
        fixtureDigest,
        harnessDigest,
        commit: "a".repeat(40),
        tree: "b".repeat(40),
        operatorRole: "automated-candidate-boundary-check",
        sourceUrl: "/__aval_v1__/h264.avl?session=m9-functional",
        profileClean: false,
        expectedRepetitions: 1,
        environment
      })
    });
  });
}

async function runResourceFaultProfile(page: Page) {
  return page.evaluate(async () => {
    const api = (window as typeof window & {
      readonly avalCertification: BrowserCertificationApi;
    }).avalCertification;
    await api.ready;
    const report = await api.runResourceFaultProfile({ full: false });
    return {
      status: report.status,
      failures: report.failures,
      lifecycle: report.lifecycle,
      result: report.network.find(({ scenario }) => scenario === "fatal-boundary-network") ?? null,
      canonicalJson: api.getLastExport()?.canonicalJson ?? null
    };
  });
}
