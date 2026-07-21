import {
  adaptManifestToMotionGraph,
  type CompiledManifest
} from "@pixel-point/aval-format";

import {
  calculateReadinessMetrics,
  idealReadinessDeadlineMs,
  type ReadinessFrameMeasurement,
  type ReadinessMetricsReport
} from "./readiness-metrics.js";
import type {
  AllRoutesReadinessEvidence,
  CutReadinessEvidence,
  EdgeDryRunEvidence,
  EndpointRecoveryEvidence,
  InverseReadinessEvidence,
  LoopReadinessEvidence,
  RoutePhaseEvidence
} from "./readiness-evaluator.js";

const DIGEST = "0".repeat(64);

export function readinessFixture(): {
  readonly manifest: Readonly<CompiledManifest>;
  readonly graph: ReturnType<typeof adaptManifestToMotionGraph>;
} {
  const manifest = manifestFixture();
  return Object.freeze({
    manifest,
    graph: adaptManifestToMotionGraph(manifest)
  });
}

export function passingMetrics(): Readonly<ReadinessMetricsReport> {
  return calculateReadinessMetrics({
    frameRate: { numerator: 30, denominator: 1 },
    measurements: passingMeasurements("warmup", "body-idle")
  });
}

export function passingMeasurements(
  path: string,
  unit: string
): readonly Readonly<ReadinessFrameMeasurement>[] {
  return Object.freeze(Array.from({ length: 24 }, (_, index) => {
    const submitTimeMs = index * 0.01;
    const workerOutputTimeMs = 1 + index * 0.1;
    return Object.freeze({
      outputOrdinal: index,
      media: Object.freeze({
        path,
        unit,
        unitInstance: 0,
        localFrame: index
      }),
      submitTimeMs,
      workerOutputTimeMs,
      uploadReadyTimeMs: workerOutputTimeMs + 1,
      idealDeadlineMs: idealReadinessDeadlineMs(
        10,
        index + 1,
        { numerator: 30, denominator: 1 }
      )
    });
  }));
}

export function passingEvidence(): AllRoutesReadinessEvidence {
  const metrics = passingMetrics();
  const targetProbeFrames = 6;
  const loops: readonly LoopReadinessEvidence[] = Object.freeze([
    Object.freeze({
      unit: "body-idle",
      seamReady: true,
      availableHeadroomFrames: 6
    })
  ]);
  const edgeDryRuns: readonly EdgeDryRunEvidence[] = Object.freeze([
    edgeDryRun("edge-finish", metrics, 0, targetProbeFrames),
    edgeDryRun("edge-locked", metrics, 2, targetProbeFrames)
  ]);
  const cuts: readonly CutReadinessEvidence[] = Object.freeze([
    Object.freeze({
      edge: "edge-cut",
      runwayPrepared: true,
      responseFrames: 1,
      runwayFrames: 6,
      continuationFrame: 6,
      recoveryFrames: 5,
      deadlineSafe: true,
      withinBudget: true
    })
  ]);
  const endpoints: readonly EndpointRecoveryEvidence[] = Object.freeze([
    endpoint("rev", "finite", "default"),
    endpoint("rev", "held", "default")
  ]);
  const phases: readonly RoutePhaseEvidence[] = Object.freeze([
    "edge-cut",
    "edge-finish",
    "edge-locked",
    "edge-rev-forward",
    "edge-rev-reverse"
  ].map((edge) => Object.freeze({
    edge,
    pendingCancellationReady: true,
    pendingReplacementReady: true,
    prospectiveTargetReady: true,
    lockedFollowOnReady: true
  })));
  const inverses: readonly InverseReadinessEvidence[] = Object.freeze([
    Object.freeze({
      unit: "rev",
      responseFrames: 1,
      adjacentFrame: true
    })
  ]);
  return Object.freeze({
    warmupMetrics: metrics,
    loops,
    edgeDryRuns,
    cuts,
    endpoints,
    phases,
    inverses,
    resource: Object.freeze({
      passed: true,
      totalBytes: 1_000,
      capBytes: 2_000
    }),
    initialRing: Object.freeze({
      passed: true,
      frameCount: 6
    })
  });
}

function edgeDryRun(
  edge: string,
  metrics: ReadinessMetricsReport,
  transitionFrames: number,
  targetProbeFrames: number
): EdgeDryRunEvidence {
  return Object.freeze({
    edge,
    metrics,
    availableConsecutiveFrames: Math.max(2, transitionFrames + 1),
    transitionFrames,
    targetProbeFrames,
    sequenceFrameCount: transitionFrames + targetProbeFrames,
    completeSequence: true,
    deadlineSafe: true,
    withinBudget: true
  });
}

function endpoint(
  unit: string,
  state: string,
  port: string
): EndpointRecoveryEvidence {
  return Object.freeze({
    unit,
    state,
    port,
    runwayPrepared: true,
    runwayFrames: 6,
    continuationFrame: 6,
    recoveryFrames: 5,
    deadlineSafe: true,
    withinBudget: true
  });
}

function manifestFixture(): Readonly<CompiledManifest> {
  const rendition = "opaque";
  return Object.freeze({
    formatVersion: "1.1",
    generator: "readiness-evaluator-tests",
    codec: "h264",
    bitstream: "annex-b",
    layout: "opaque",
    canvas: Object.freeze({
      width: 64,
      height: 64,
      fit: "contain",
      pixelAspect: Object.freeze([1, 1] as const),
      colorSpace: "srgb"
    }),
    frameRate: Object.freeze({ numerator: 30, denominator: 1 }),
    renditions: Object.freeze([Object.freeze({
      id: rendition,
      codec: "avc1.42E020",
      bitDepth: 8,
      codedWidth: 64,
      codedHeight: 64,
      alphaLayout: Object.freeze({
        type: "opaque",
        colorRect: Object.freeze([0, 0, 64, 64] as const)
      }),
      bitrate: Object.freeze({ average: 1_000_000, peak: 2_000_000 })
    })]),
    units: Object.freeze([
      body("body-finite", "finite", 3, [2], 0),
      body("body-held", "finite", 1, [0], 3),
      body("body-idle", "loop", 4, [0, 2], 4),
      Object.freeze({
        id: "bridge",
        kind: "bridge",
        frameCount: 2,
        chunks: Object.freeze([chunkSpan(rendition, 8, 2)])
      }),
      Object.freeze({
        id: "rev",
        kind: "reversible",
        frameCount: 6,
        residency: Object.freeze({
          endpoints: Object.freeze([
            Object.freeze({ state: "finite", port: "default", frames: 6 }),
            Object.freeze({ state: "held", port: "default", frames: 6 })
          ] as const)
        }),
        chunks: Object.freeze([chunkSpan(rendition, 10, 6)])
      })
    ]),
    initialState: "idle",
    states: Object.freeze([
      Object.freeze({
        id: "finite",
        bodyUnit: "body-finite"
      }),
      Object.freeze({
        id: "held",
        bodyUnit: "body-held"
      }),
      Object.freeze({
        id: "idle",
        bodyUnit: "body-idle"
      })
    ]),
    edges: Object.freeze([
      Object.freeze({
        id: "edge-cut",
        from: "idle",
        to: "held",
        start: Object.freeze({
          type: "cut",
          targetPort: "default",
          maxWaitFrames: 1
        }),
        continuity: "cut",
        targetRunwayFrames: 6
      }),
      Object.freeze({
        id: "edge-finish",
        from: "finite",
        to: "idle",
        trigger: Object.freeze({ type: "completion" }),
        start: Object.freeze({
          type: "finish",
          targetPort: "default",
          maxWaitFrames: 2
        }),
        continuity: "exact-authored"
      }),
      Object.freeze({
        id: "edge-locked",
        from: "idle",
        to: "finite",
        start: Object.freeze({
          type: "portal",
          sourcePort: "default",
          targetPort: "default",
          maxWaitFrames: 12
        }),
        transition: Object.freeze({ kind: "locked", unit: "bridge" }),
        continuity: "exact-authored"
      }),
      Object.freeze({
        id: "edge-rev-forward",
        from: "finite",
        to: "held",
        start: Object.freeze({
          type: "portal",
          sourcePort: "default",
          targetPort: "default",
          maxWaitFrames: 2
        }),
        transition: Object.freeze({
          kind: "reversible",
          unit: "rev",
          direction: "forward"
        }),
        continuity: "exact-authored"
      }),
      Object.freeze({
        id: "edge-rev-reverse",
        from: "held",
        to: "finite",
        start: Object.freeze({
          type: "portal",
          sourcePort: "default",
          targetPort: "default",
          maxWaitFrames: 1
        }),
        transition: Object.freeze({
          kind: "reversible",
          unit: "rev",
          direction: "reverse",
          reverseOf: "edge-rev-forward"
        }),
        continuity: "exact-reverse"
      })
    ]),
    bindings: Object.freeze([]),
    readiness: Object.freeze({
      policy: "all-routes",
      bootstrapUnits: Object.freeze([
        "body-finite",
        "body-held",
        "body-idle",
        "bridge"
      ]),
      immediateEdges: Object.freeze(["edge-cut", "edge-locked"])
    }),
    limits: Object.freeze({
      maxCompiledBytes: 64 * 1024,
      maxRuntimeBytes: 1024 * 1024,
      decodedPixelBytes: 64 * 64 * 4,
      persistentCacheBytes: 0,
      runtimeWorkingSetBytes: 64 * 64 * 4
    })
  });
}

function body(
  id: string,
  playback: "loop" | "finite",
  frameCount: number,
  portalFrames: readonly number[],
  sampleStart: number
) {
  return Object.freeze({
    id,
    kind: "body" as const,
    playback,
    frameCount,
    ports: Object.freeze([Object.freeze({
      id: "default",
      entryFrame: 0 as const,
      portalFrames: Object.freeze([...portalFrames])
    })]),
    chunks: Object.freeze([chunkSpan("opaque", sampleStart, frameCount)])
  });
}

function chunkSpan(rendition: string, chunkStart: number, chunkCount: number) {
  return Object.freeze({
    rendition,
    chunkStart,
    chunkCount,
    frameCount: chunkCount,
    sha256: DIGEST
  });
}
