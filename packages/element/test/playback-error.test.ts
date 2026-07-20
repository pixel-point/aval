import { describe, expect, it } from "vitest";

import {
  AvalPlaybackError,
  type AvalPublicFailure
} from "../src/index.js";

describe("AvalPlaybackError", () => {
  it("preserves the identity of an already frozen public failure", () => {
    const failure = Object.freeze({
      code: "worker-decode-failure" as const,
      message: "Playback could not continue.",
      operation: "prepare"
    }) satisfies Readonly<AvalPublicFailure>;

    const error = new AvalPlaybackError(failure, 7);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AvalPlaybackError");
    expect(error.message).toBe("aval-player playback could not continue");
    expect(error.failure).toBe(failure);
    expect(error.generation).toBe(7);
    expect(Object.isFrozen(error.failure)).toBe(true);
  });

  it("retains a frozen defensive copy of mutable input", () => {
    const failure = {
      code: "renderer-failure" as const,
      message: "A browser-provided message that must not become Error.message.",
      operation: "resume"
    };

    const error = new AvalPlaybackError(failure, 11);

    expect(error.failure).not.toBe(failure);
    expect(error.failure).toEqual(failure);
    expect(Object.isFrozen(error.failure)).toBe(true);
    expect(error.message).toBe("aval-player playback could not continue");
    expect(error).not.toHaveProperty("cause");

    failure.message = "changed after construction";
    failure.operation = "changed";
    expect(error.failure).toEqual({
      code: "renderer-failure",
      message: "A browser-provided message that must not become Error.message.",
      operation: "resume"
    });
  });

  it("rejects an invalid source generation", () => {
    expect(() => new AvalPlaybackError(Object.freeze({
      code: "readiness-failure",
      message: "Playback could not continue.",
      operation: "prepare"
    }), 0)).toThrow(RangeError);
  });
});
