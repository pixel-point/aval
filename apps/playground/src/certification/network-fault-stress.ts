import type {
  AvalElement,
  AvalElementEventMap
} from "@pixel-point/aval-element";

import {
  captureFatalErrorBoundaryEvidence,
  type CapturedFatalErrorEvent,
  type CapturedPrepareOutcome,
  type FatalErrorBoundaryCaptureResult
} from "./fatal-error-boundary-capture.js";
import { createPublicMotionElement, retirePublicMotion } from "./public-element-host.js";

export const LOCAL_NETWORK_FAULTS = Object.freeze([
  "fatal-boundary-network",
  "ignored-initial-range", "no-validator", "weak-etag", "changed-etag",
  "wrong-total", "truncated-body", "oversized-body", "compressed-body",
  "stalled-body", "corrupt-unit", "corrupt-bootstrap-unit", "nonzero-padding",
  "valid-external-integrity", "invalid-external-integrity"
] as const);

export interface NetworkFaultResult {
  readonly scenario: typeof LOCAL_NETWORK_FAULTS[number];
  readonly status: "passed" | "failed" | "inconclusive";
  readonly terminalReadiness: string;
  readonly terminalErrorBoundaryObserved: boolean;
  readonly outstandingSettled: boolean;
  readonly failureCode: string | null;
  readonly fatalErrorBoundary: Readonly<FatalErrorBoundaryCaptureResult> | null;
}

export async function runNetworkFaultStress(options: Readonly<{
  parent: HTMLElement;
  scenarios: readonly typeof LOCAL_NETWORK_FAULTS[number][];
  timeoutMs: number;
  candidateManifestDigest: string;
  fixtureDigest: string;
  harnessDigest: string;
  runId: string;
  profileId: string;
  environmentDigest: string;
}>): Promise<readonly Readonly<NetworkFaultResult>[]> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 30_000) throw new RangeError("network fault timeout is invalid");
  if (!/^[0-9a-f]{64}$/u.test(options.candidateManifestDigest)) throw new TypeError("candidate manifest digest is invalid");
  if (!/^[0-9a-f]{64}$/u.test(options.fixtureDigest)) throw new TypeError("fixture digest is invalid");
  if (!/^[0-9a-f]{64}$/u.test(options.harnessDigest)) throw new TypeError("harness digest is invalid");
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u.test(options.runId)) throw new TypeError("run ID is invalid");
  if (!/^profile-[0-9a-f]{20}$/u.test(options.profileId)) throw new TypeError("profile ID is invalid");
  if (!/^[0-9a-f]{64}$/u.test(options.environmentDigest)) throw new TypeError("environment digest is invalid");
  if (options.scenarios.length < 1 || options.scenarios.length > LOCAL_NETWORK_FAULTS.length) throw new RangeError("network fault scenario count is invalid");
  const unique = new Set(options.scenarios);
  if (unique.size !== options.scenarios.length || [...unique].some((id) => !LOCAL_NETWORK_FAULTS.includes(id))) throw new TypeError("network fault scenarios are invalid");
  const results: NetworkFaultResult[] = [];
  for (const [index, scenario] of options.scenarios.entries()) {
    const errorEvents: CapturedFatalErrorEvent[] = [];
    const captureError = ((event: AvalElementEventMap["error"]) => {
      // One event passes and two already prove duplication; retain no more.
      if (errorEvents.length >= 2) return;
      errorEvents.push(Object.freeze({
        generation: event.detail.generation,
        fatal: event.detail.fatal,
        failure: event.detail.failure
      }));
    }) as EventListener;
    // Install the witness listener before connection so even a synchronous
    // first-generation failure cannot escape the raw event count.
    const element = createPublicMotionElement(
      faultSourceUrl(scenario, index),
      options.parent,
      undefined,
      undefined,
      captureError
    );
    const outcome = await boundedPrepare(element, options.timeoutMs);
    const repeatedPrepare = outcome.status === "rejected"
      ? await boundedPrepare(element, options.timeoutMs)
      : null;
    const before = element.getDiagnostics();
    let terminal: Readonly<ReturnType<AvalElement["getDiagnostics"]>> | null = null;
    try {
      terminal = await retirePublicMotion(element).catch(() => null);
      await drainFatalErrorObservationWindow();
    } finally {
      element.removeEventListener("error", captureError);
    }
    const fatalErrorBoundary = outcome.status === "rejected" && repeatedPrepare !== null
      ? captureFatalErrorBoundaryEvidence({
          candidateManifestDigest: options.candidateManifestDigest,
          fixtureDigest: options.fixtureDigest,
          harnessDigest: options.harnessDigest,
          runId: options.runId,
          profileId: options.profileId,
          environmentDigest: options.environmentDigest,
          errorEvents,
          rejectedPrepare: outcome,
          repeatedPrepare,
          diagnostics: before
        })
      : null;
    const settled = terminal !== null && Object.values(terminal.outstanding).every((value) => value === 0);
    const expectedUsable = scenario === "ignored-initial-range" || scenario === "no-validator" || scenario === "weak-etag" || scenario === "valid-external-integrity";
    const usablePlaybackReady = outcome.status === "ready" &&
      before.readiness === "interactiveReady";
    const terminalErrorBoundaryObserved = fatalErrorBoundary?.passed === true;
    const passed = settled && (
      expectedUsable ? usablePlaybackReady : terminalErrorBoundaryObserved
    );
    results.push(Object.freeze({
      scenario,
      status: outcome.status === "timeout" || repeatedPrepare?.status === "timeout" ? "inconclusive" : passed ? "passed" : "failed",
      terminalReadiness: before.readiness,
      terminalErrorBoundaryObserved,
      outstandingSettled: settled,
      failureCode: fatalErrorBoundary?.observation.failureCode ?? before.lastFailure?.code ?? null,
      fatalErrorBoundary
    }));
  }
  return Object.freeze(results);
}

async function drainFatalErrorObservationWindow(): Promise<void> {
  // Preserve the raw listener through retirement and two bounded task turns so
  // duplicate events queued by cleanup cannot escape the certification count.
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function faultSourceUrl(
  scenario: typeof LOCAL_NETWORK_FAULTS[number],
  index: number
): string {
  if (scenario === "fatal-boundary-network") {
    return "/__aval_certification__/fatal-boundary-network.avl";
  }
  return `/__m7__/asset?session=m9-fault-${String(index)}&scenario=${scenario}`;
}

async function boundedPrepare(element: AvalElement, timeoutMs: number): Promise<CapturedPrepareOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await element.prepare({ signal: controller.signal, timeoutMs });
    return Object.freeze({ status: "ready", error: null });
  } catch (error) {
    return controller.signal.aborted
      ? Object.freeze({ status: "timeout", error: null })
      : Object.freeze({ status: "rejected", error });
  } finally {
    clearTimeout(timeout);
  }
}
