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
  RUNTIME_BLOB_RESIDENCY_STATES,
  RUNTIME_BYTE_CATEGORIES,
  RUNTIME_TRANSPORT_MODES,
  RUNTIME_TRACE_CAPACITY,
  STATIC_REASON_CLASSIFICATIONS,
  STATIC_REASONS,
  TRANSIENT_STATIC_REASONS,
  createRuntimeCandidateReport,
  createRuntimeReadinessReport,
  isTransientStaticReason,
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
      "load-failure",
      "range-response-invalid",
      "entity-changed",
      "integrity-mismatch",
      "unsupported-profile",
      "resource-rejection",
      "readiness-failure",
      "worker-decode-failure",
      "renderer-failure",
      "context-loss",
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
        ordinal: 7,
        width: 511,
        height: 257,
        alphaStatistic: "p99",
        policyPhase: "enter-full",
        lifecyclePhase: "payload-range",
        requestOrdinal: 9,
        httpStatus: 206,
        expectedBytes: 64,
        observedBytes: 63,
        declaredTotalBytes: 4_096,
        playerBytes: 1_024,
        pageBytes: 2_048
      }
    );

    expect(failure.message).toHaveLength(MAX_RUNTIME_FAILURE_MESSAGE_LENGTH);
    expect(failure.message).not.toContain(untrustedUnit);
    expect(failure.context.unit).toHaveLength(
      MAX_RUNTIME_DIAGNOSTIC_TEXT_LENGTH
    );
    expect(failure.context.ordinal).toBe(7);
    expect(failure.context).toMatchObject({
      width: 511,
      height: 257,
      alphaStatistic: "p99",
      policyPhase: "enter-full",
      lifecyclePhase: "payload-range",
      requestOrdinal: 9,
      httpStatus: 206,
      expectedBytes: 64,
      observedBytes: 63,
      declaredTotalBytes: 4_096,
      playerBytes: 1_024,
      pageBytes: 2_048
    });
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

  it("uses the exact M7 static reasons and deterministic precedence", () => {
    expect(STATIC_REASONS).toEqual([
      "reduced-motion",
      "no-avc-rendition",
      "worker-unavailable",
      "renderer-unavailable",
      "codec-unsupported",
      "resource-budget",
      "readiness-failed",
      "preparation-timeout",
      "animation-failure",
      "visibility-suspended",
      "decoder-queued"
    ]);
    expect(Object.isFrozen(STATIC_REASONS)).toBe(true);
    expect(TRANSIENT_STATIC_REASONS).toEqual([
      "visibility-suspended",
      "decoder-queued"
    ]);
    expect(Object.isFrozen(TRANSIENT_STATIC_REASONS)).toBe(true);
    expect(STATIC_REASON_CLASSIFICATIONS).toEqual({
      "reduced-motion": "sticky",
      "no-avc-rendition": "sticky",
      "worker-unavailable": "sticky",
      "renderer-unavailable": "sticky",
      "codec-unsupported": "sticky",
      "resource-budget": "sticky",
      "readiness-failed": "sticky",
      "preparation-timeout": "sticky",
      "animation-failure": "sticky",
      "visibility-suspended": "transient",
      "decoder-queued": "transient"
    });
    expect(Object.isFrozen(STATIC_REASON_CLASSIFICATIONS)).toBe(true);
    expect(isTransientStaticReason("visibility-suspended")).toBe(true);
    expect(isTransientStaticReason("decoder-queued")).toBe(true);
    expect(isTransientStaticReason("resource-budget")).toBe(false);

    const unsupported = normalizeRuntimeFailure("unsupported-profile");
    const resource = normalizeRuntimeFailure("resource-rejection");
    const readiness = normalizeRuntimeFailure("readiness-failure");
    const base = {
      phase: "preparation" as const,
      staticReady: true,
      deadlineExpired: false,
      hasAvcRendition: true,
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
      hasAvcRendition: false,
      workerAvailable: false,
      rendererAvailable: false
    })).toBe("no-avc-rendition");
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

  it("freezes the closed M7 transport, residency, and byte categories", () => {
    expect(RUNTIME_TRANSPORT_MODES).toEqual(["range", "full"]);
    expect(RUNTIME_BLOB_RESIDENCY_STATES).toEqual([
      "absent",
      "loading",
      "verified"
    ]);
    expect(RUNTIME_BYTE_CATEGORIES).toEqual([
      "asset-metadata",
      "asset-full",
      "response-body",
      "quarantine",
      "blob-assembly",
      "verified-unit",
      "verified-static",
      "worker-transfer",
      "decoder-output",
      "persistent-animation",
      "streaming-texture",
      "frame-staging",
      "png-copy",
      "png-zlib",
      "png-scratch",
      "decoded-static-cache",
      "current-static-surface",
      "incoming-static-surface",
      "animated-canvas-backing",
      "static-canvas-backing"
    ]);
    expect(Object.isFrozen(RUNTIME_TRANSPORT_MODES)).toBe(true);
    expect(Object.isFrozen(RUNTIME_BLOB_RESIDENCY_STATES)).toBe(true);
    expect(Object.isFrozen(RUNTIME_BYTE_CATEGORIES)).toBe(true);
  });
});
