import { describe, expect, it } from "vitest";

import {
  RuntimePlaybackError,
  normalizeRuntimeFailure
} from "./errors.js";
import {
  createPreparationHarness,
  waitForLength
} from "./integrated-player-preparation-test-support.js";

describe("IntegratedPlayer browser playback terminal listener", () => {
  it("retains an asynchronously reported browser error without another host call", async () => {
    const terminal = new RuntimePlaybackError(normalizeRuntimeFailure(
      "worker-decode-failure",
      "injected resident continuation failure",
      { operation: "browser-resident-continuation" }
    ));
    const harness = createPreparationHarness({
      behaviors: [{ kind: "browser-terminal", error: terminal }]
    });

    await harness.player.prepare();
    await waitForLength(harness.failures, 1);

    expect(harness.player.snapshot()).toMatchObject({
      readiness: "error",
      selectedRendition: null
    });
    expect(harness.failures).toEqual([terminal.failure]);
    await expect(harness.player.settled()).rejects.toBe(terminal);
    await expect(harness.player.requestState("hover")).rejects.toBe(terminal);
    expect(harness.factory.activeAttempts).toBe(0);
  });
});
