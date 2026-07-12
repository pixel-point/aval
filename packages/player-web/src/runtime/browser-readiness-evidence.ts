import type { RationalFrameRate } from "./rational-time.js";
import type {
  ReadinessFrameMeasurement,
  ReadinessMetricsReport
} from "./readiness-metrics.js";
import { calculateReadinessMetrics } from "./readiness-metrics.js";

export interface BrowserMeasuredSequenceEvidence {
  readonly metrics: Readonly<ReadinessMetricsReport>;
  readonly deadlineSafe: boolean;
  readonly consecutiveDeadlineSafeFrames: number;
}

export function measureBrowserSequenceEvidence(
  measurements: readonly Readonly<ReadinessFrameMeasurement>[],
  frameRate: Readonly<RationalFrameRate>
): Readonly<BrowserMeasuredSequenceEvidence> {
  const metrics = calculateReadinessMetrics({ frameRate, measurements });
  let consecutive = 0;
  for (const measurement of measurements) {
    if (measurement.uploadReadyTimeMs > measurement.idealDeadlineMs) break;
    consecutive += 1;
  }
  return Object.freeze({
    metrics,
    deadlineSafe: consecutive === measurements.length,
    consecutiveDeadlineSafeFrames: consecutive
  });
}

export function browserRecoveryFrames(
  measurements: readonly Readonly<ReadinessFrameMeasurement>[],
  continuationIndex: number,
  frameRate: Readonly<RationalFrameRate>
): number {
  const first = measurements[0];
  const continuation = measurements[continuationIndex];
  if (first === undefined || continuation === undefined) {
    return Number.MAX_SAFE_INTEGER;
  }
  const duration = 1_000 * frameRate.denominator / frameRate.numerator;
  return Math.max(
    0,
    Math.ceil((continuation.uploadReadyTimeMs - first.submitTimeMs) / duration)
  );
}
