import type { CertificationStatus } from "./status.js";

export interface FunctionalEngineResult {
  readonly engine: "chromium" | "firefox" | "webkit";
  readonly label: string;
  readonly claimLayer: "functional-engine";
  readonly animatedStatus: CertificationStatus;
  readonly fatalErrorBoundaryStatus: CertificationStatus;
  readonly exactProbe: string;
}

export function functionalEngineResult(input: {
  readonly engine: FunctionalEngineResult["engine"];
  readonly exactProbe: string;
  readonly animationSupported: boolean;
  readonly functionalAssertionsPassed: boolean;
  readonly fatalErrorBoundaryPassed: boolean;
}): FunctionalEngineResult {
  if (input.exactProbe.length === 0 || input.exactProbe.length > 512) throw new RangeError("exactProbe is invalid");
  const label = ({
    chromium: "Playwright Chromium engine",
    firefox: "Playwright Firefox engine",
    webkit: "Playwright WebKit engine"
  } as const)[input.engine];
  return {
    engine: input.engine,
    label,
    claimLayer: "functional-engine",
    animatedStatus: input.animationSupported ? (input.functionalAssertionsPassed ? "passed" : "failed") : "unsupported",
    fatalErrorBoundaryStatus: input.fatalErrorBoundaryPassed ? "passed" : "failed",
    exactProbe: input.exactProbe
  };
}
