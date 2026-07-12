import { describe, expect, it } from "vitest";

import {
  MAX_RUNTIME_DIAGNOSTIC_TEXT_LENGTH,
  MAX_RUNTIME_FAILURE_MESSAGE_LENGTH,
  RUNTIME_FAILURE_CODES,
  RuntimePlaybackError,
  normalizeRuntimeFailure
} from "./errors.js";
import {
  RUNTIME_READINESS_LADDER,
  RUNTIME_READINESS_LEVELS,
  RUNTIME_TRACE_CAPACITY,
  STATIC_REASONS,
  createRuntimeCandidateReport,
  createRuntimeReadinessReport,
  summarizeStaticReason,
  translateGraphReadiness
} from "./model.js";

describe("runtime model boundary", () => {
  it("freezes the player-owned readiness ladder", () => {
    expect(RUNTIME_READINESS_LEVELS).toEqual([
      "unready",
      "metadataReady",
      "visualReady",
      "interactiveReady",
      "staticReady",
      "disposed",
      "error"
    ]);
    expect(Object.isFrozen(RUNTIME_READINESS_LEVELS)).toBe(true);
    expect(RUNTIME_READINESS_LADDER).toEqual({
      initial: "unready",
      playerOwned: ["metadataReady", "visualReady"],
      ready: ["interactiveReady", "staticReady"],
      terminal: ["disposed", "error"]
    });
    expect(Object.isFrozen(RUNTIME_READINESS_LADDER)).toBe(true);
    expect(Object.isFrozen(RUNTIME_READINESS_LADDER.playerOwned)).toBe(true);
    expect(Object.isFrozen(RUNTIME_READINESS_LADDER.ready)).toBe(true);
    expect(Object.isFrozen(RUNTIME_READINESS_LADDER.terminal)).toBe(true);
  });

  it("translates graph readiness once without inventing metadata or visual effects", () => {
    expect(translateGraphReadiness("unready")).toEqual({
      owner: "graph",
      readiness: "unready"
    });
    expect(translateGraphReadiness("preparing")).toEqual({
      owner: "player-web",
      readiness: null
    });
    expect(translateGraphReadiness("animated")).toEqual({
      owner: "graph",
      readiness: "interactiveReady"
    });
    expect(translateGraphReadiness("static")).toEqual({
      owner: "graph",
      readiness: "staticReady"
    });
    expect(translateGraphReadiness("disposed")).toEqual({
      owner: "graph",
      readiness: "disposed"
    });
    expect(translateGraphReadiness("error")).toEqual({
      owner: "graph",
      readiness: "error"
    });

    for (const graphReadiness of [
      "unready",
      "preparing",
      "animated",
      "static",
      "disposed",
      "error"
    ] as const) {
      expect(Object.isFrozen(translateGraphReadiness(graphReadiness))).toBe(true);
    }
  });

  it("exposes the exact bounded failure categories", () => {
    expect(RUNTIME_FAILURE_CODES).toEqual([
      "invalid-asset",
      "unsupported-profile",
      "resource-rejection",
      "readiness-failure",
      "worker-decode-failure",
      "renderer-failure",
      "watchdog-timeout",
      "underflow",
      "abort",
      "disposed"
    ]);
    expect(Object.isFrozen(RUNTIME_FAILURE_CODES)).toBe(true);
  });

  it("bounds normalized messages and keeps untrusted identifiers structured", () => {
    const untrustedUnit = "u".repeat(1_000);
    const failure = normalizeRuntimeFailure(
      "worker-decode-failure",
      new Error("d".repeat(2_000)),
      {
        unit: untrustedUnit,
        ordinal: 7
      }
    );

    expect(failure.message).toHaveLength(MAX_RUNTIME_FAILURE_MESSAGE_LENGTH);
    expect(failure.message).not.toContain(untrustedUnit);
    expect(failure.context.unit).toHaveLength(
      MAX_RUNTIME_DIAGNOSTIC_TEXT_LENGTH
    );
    expect(failure.context.ordinal).toBe(7);
    expect(Object.isFrozen(failure.context)).toBe(true);
    expect(Object.isFrozen(failure)).toBe(true);

    const error = new RuntimePlaybackError(failure);
    expect(error.name).toBe("RuntimePlaybackError");
    expect(error.code).toBe("worker-decode-failure");
    expect(error.failure).toBe(failure);
  });

  it("uses a stable generic message for unknown hostile throws", () => {
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "message", {
      get(): never {
        throw new Error("must not inspect hostile getters");
      }
    });

    expect(
      normalizeRuntimeFailure("readiness-failure", hostile).message
    ).toBe("animation readiness failed");
  });

  it("freezes candidate and readiness reports without retaining mutable arrays", () => {
    const candidates = [
      createRuntimeCandidateReport({
        rendition: "main",
        rank: 0,
        outcome: "selected",
        failure: null
      })
    ];
    const report = createRuntimeReadinessReport({
      readiness: "interactiveReady",
      selectedRendition: "main",
      candidates
    });
    candidates.push(
      createRuntimeCandidateReport({
        rendition: "lower",
        rank: 1,
        outcome: "rejected",
        failure: normalizeRuntimeFailure("resource-rejection")
      })
    );

    expect(report.candidates).toHaveLength(1);
    expect(Object.isFrozen(report.candidates[0])).toBe(true);
    expect(Object.isFrozen(report.candidates)).toBe(true);
    expect(Object.isFrozen(report)).toBe(true);
  });

  it("uses the exact eight static reasons and deterministic precedence", () => {
    expect(STATIC_REASONS).toEqual([
      "no-opaque-rendition",
      "worker-unavailable",
      "renderer-unavailable",
      "codec-unsupported",
      "resource-budget",
      "readiness-failed",
      "preparation-timeout",
      "animation-failure"
    ]);
    expect(Object.isFrozen(STATIC_REASONS)).toBe(true);

    const unsupported = normalizeRuntimeFailure("unsupported-profile");
    const resource = normalizeRuntimeFailure("resource-rejection");
    const readiness = normalizeRuntimeFailure("readiness-failure");
    const base = {
      phase: "preparation" as const,
      staticReady: true,
      deadlineExpired: false,
      hasOpaqueRendition: true,
      workerAvailable: true,
      rendererAvailable: true,
      candidateFailures: [readiness]
    };

    expect(summarizeStaticReason({ ...base, phase: "recovery" })).toBe(
      "animation-failure"
    );
    expect(summarizeStaticReason({ ...base, deadlineExpired: true })).toBe(
      "preparation-timeout"
    );
    expect(summarizeStaticReason({
      ...base,
      hasOpaqueRendition: false,
      workerAvailable: false,
      rendererAvailable: false
    })).toBe("no-opaque-rendition");
    expect(summarizeStaticReason({
      ...base,
      workerAvailable: false,
      rendererAvailable: false
    })).toBe("worker-unavailable");
    expect(summarizeStaticReason({ ...base, rendererAvailable: false })).toBe(
      "renderer-unavailable"
    );
    expect(summarizeStaticReason({
      ...base,
      candidateFailures: [unsupported, unsupported]
    })).toBe("codec-unsupported");
    expect(summarizeStaticReason({
      ...base,
      candidateFailures: [resource, resource]
    })).toBe("resource-budget");
    expect(summarizeStaticReason({
      ...base,
      candidateFailures: [unsupported, resource]
    })).toBe("readiness-failed");
    expect(summarizeStaticReason({ ...base, candidateFailures: [] })).toBe(
      "readiness-failed"
    );
    expect(summarizeStaticReason({ ...base, staticReady: false })).toBeNull();
  });

  it("freezes the trace capacity at 512", () => {
    expect(RUNTIME_TRACE_CAPACITY).toBe(512);
  });
});
