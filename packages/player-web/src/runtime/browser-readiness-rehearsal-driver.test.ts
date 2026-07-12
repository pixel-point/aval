import { describe, expect, it } from "vitest";

import { assertRehearsalActive } from "./browser-readiness-rehearsal-driver.js";

describe("browser production readiness boundary", () => {
  it("rejects an abort before publishing production evidence", () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));

    expect(() => assertRehearsalActive({
      signal: controller.signal,
      clock: { now: () => 1 },
      deadlineMs: 10
    })).toThrowError(expect.objectContaining({ name: "AbortError" }));
  });

  it("rejects an expired production rehearsal deadline", () => {
    expect(() => assertRehearsalActive({
      signal: new AbortController().signal,
      clock: { now: () => 10 },
      deadlineMs: 10
    })).toThrowError(expect.objectContaining({ name: "TimeoutError" }));
  });
});
