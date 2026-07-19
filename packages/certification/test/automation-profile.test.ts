import { describe, expect, it } from "vitest";
import { functionalEngineResult } from "../src/automation-profile.js";

describe("functional browser engine labels", () => {
  it.each(["chromium", "firefox", "webkit"] as const)("never relabels Playwright %s as a branded certificate", (engine) => {
    const result = functionalEngineResult({ engine, exactProbe: "VideoDecoder.isConfigSupported(av01.0.00M.10.0.110.01.01.01.0)", animationSupported: false, functionalAssertionsPassed: true, fatalErrorBoundaryPassed: true });
    expect(result.claimLayer).toBe("functional-engine");
    expect(result.animatedStatus).toBe("unsupported");
    expect(result.fatalErrorBoundaryStatus).toBe("passed");
    expect(result.label).not.toMatch(/\b(?:Chrome|Edge|Safari)\b/u);
  });

  it("fails the error-boundary claim independently of animation capability", () => {
    const result = functionalEngineResult({
      engine: "webkit",
      exactProbe: "VideoDecoder.isConfigSupported(avc1.42E01E)",
      animationSupported: true,
      functionalAssertionsPassed: true,
      fatalErrorBoundaryPassed: false
    });
    expect(result).toMatchObject({ animatedStatus: "passed", fatalErrorBoundaryStatus: "failed" });
  });
});
