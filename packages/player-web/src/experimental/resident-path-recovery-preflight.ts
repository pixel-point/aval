import {
  ContinuousPathDecoder,
  type ManagedPathFrame
} from "./continuous-path-decoder.js";
import type {
  EncodedVideoChunkFactory,
  VideoDecoderFactory
} from "./continuous-loop-decoder.js";
import type { EncodedLoopUnit } from "./encoded-loop.js";
import {
  MAX_ENDPOINT_RUNWAY_FRAMES,
  MIN_ENDPOINT_RUNWAY_FRAMES,
  STREAMING_SLOT_COUNT
} from "./resident-frame-plan.js";

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 5_000;

export interface ResidentPathRecoveryEndpoint<
  TEndpoint extends string = string
> {
  readonly endpoint: TEndpoint;
  readonly unitId: string;
  readonly unit: EncodedLoopUnit;
  readonly cachedRunwayFrames: number;
}

export interface ResidentPathRecoveryPreflightOptions {
  /**
   * Uploads the measured continuation through the same copy/texture path used
   * by playback. The frame is borrowed for this call and closed by preflight.
   */
  readonly uploadContinuation: (frame: ManagedPathFrame) => Promise<void>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly decoderFactory?: VideoDecoderFactory;
  readonly chunkFactory?: EncodedVideoChunkFactory;
  /** Monotonic millisecond clock. Injectable so readiness math is testable. */
  readonly now?: () => number;
}

export interface ResidentPathRecoveryEndpointReport<
  TEndpoint extends string = string
> {
  readonly endpoint: TEndpoint;
  readonly unitId: string;
  readonly cachedRunwayFrames: number;
  readonly pathGeneration: number;
  readonly firstContinuationPathFrame: number;
  readonly elapsedMs: number;
  readonly frameDurationMs: number;
  /** Measured recovery plus the required one-content-frame safety margin. */
  readonly requiredContentFrames: number;
  readonly ready: boolean;
}

/**
 * Raised when an endpoint's measured recovery cannot finish inside its
 * resident runway. The frozen reports include earlier passing endpoints and
 * the failing endpoint, so callers can surface a useful readiness diagnostic.
 */
export class ResidentPathRecoveryReadinessError<
  TEndpoint extends string = string
> extends Error {
  public readonly endpointReport: Readonly<
    ResidentPathRecoveryEndpointReport<TEndpoint>
  >;
  public readonly reports: readonly Readonly<
    ResidentPathRecoveryEndpointReport<TEndpoint>
  >[];

  public constructor(
    endpointReport: Readonly<ResidentPathRecoveryEndpointReport<TEndpoint>>,
    reports: readonly Readonly<ResidentPathRecoveryEndpointReport<TEndpoint>>[]
  ) {
    super(
      `resident path recovery for endpoint ${JSON.stringify(
        endpointReport.endpoint
      )} requires ${String(
        endpointReport.requiredContentFrames
      )} content frames but its runway contains ${String(
        endpointReport.cachedRunwayFrames
      )}`
    );
    this.name = "ResidentPathRecoveryReadinessError";
    this.endpointReport = endpointReport;
    this.reports = reports;
  }
}

/**
 * Measures each endpoint sequentially with a newly configured path decoder.
 * The first exposed continuation must be path frame R because decoded outputs
 * in [0, R) duplicate already-resident runway layers.
 *
 * A successful return and every endpoint report are frozen. A readiness miss
 * throws rather than allowing the caller to label the interaction animated.
 */
export async function preflightResidentPathRecovery<
  TEndpoint extends string
>(
  endpoints: readonly ResidentPathRecoveryEndpoint<TEndpoint>[],
  options: ResidentPathRecoveryPreflightOptions
): Promise<
  readonly Readonly<ResidentPathRecoveryEndpointReport<TEndpoint>>[]
> {
  validateEndpoints(endpoints);
  if (typeof options.uploadContinuation !== "function") {
    throw new TypeError(
      "resident recovery preflight requires an uploadContinuation function"
    );
  }
  const timeoutMs = validateTimeout(
    options.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS
  );
  const now = options.now ?? defaultNow;
  if (typeof now !== "function") {
    throw new TypeError("resident recovery preflight now must be a function");
  }
  throwIfAborted(options.signal);

  const reports: Readonly<ResidentPathRecoveryEndpointReport<TEndpoint>>[] = [];
  for (const endpoint of endpoints) {
    throwIfAborted(options.signal);
    const report = await measureEndpoint(endpoint, {
      timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.decoderFactory === undefined
        ? {}
        : { decoderFactory: options.decoderFactory }),
      ...(options.chunkFactory === undefined
        ? {}
        : { chunkFactory: options.chunkFactory }),
      uploadContinuation: options.uploadContinuation,
      now
    });

    if (!report.ready) {
      const completedReports = Object.freeze([...reports, report]);
      throw new ResidentPathRecoveryReadinessError(
        report,
        completedReports
      );
    }
    reports.push(report);
  }

  return Object.freeze(reports);
}

interface NormalizedMeasureOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly decoderFactory?: VideoDecoderFactory;
  readonly chunkFactory?: EncodedVideoChunkFactory;
  readonly uploadContinuation: (frame: ManagedPathFrame) => Promise<void>;
  readonly now: () => number;
}

async function measureEndpoint<TEndpoint extends string>(
  endpoint: ResidentPathRecoveryEndpoint<TEndpoint>,
  options: NormalizedMeasureOptions
): Promise<Readonly<ResidentPathRecoveryEndpointReport<TEndpoint>>> {
  const startedAt = readClock(options.now);
  let decoder: ContinuousPathDecoder | null = null;
  let continuation: ManagedPathFrame | undefined;

  try {
    const maxInFlight =
      endpoint.cachedRunwayFrames + STREAMING_SLOT_COUNT;
    decoder = new ContinuousPathDecoder(
      [{ id: endpoint.unitId, unit: endpoint.unit }],
      {
        maxInFlight,
        ...(options.decoderFactory === undefined
          ? {}
          : { decoderFactory: options.decoderFactory }),
        ...(options.chunkFactory === undefined
          ? {}
          : { chunkFactory: options.chunkFactory })
      }
    );
    const pathGeneration = decoder.startPath(endpoint.unitId, {
      cachedRunwayFrames: endpoint.cachedRunwayFrames,
      aheadFrames: maxInFlight
    });
    await decoder.waitForFrames(1, {
      timeoutMs: options.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });

    continuation = decoder.takeFrame();
    if (continuation === undefined) {
      throw new Error(
        `resident path recovery for endpoint ${JSON.stringify(
          endpoint.endpoint
        )} became ready without a continuation frame`
      );
    }
    const expectedPathFrame = BigInt(endpoint.cachedRunwayFrames);
    if (
      continuation.pathGeneration !== pathGeneration ||
      continuation.unitId !== endpoint.unitId ||
      continuation.pathFrame !== expectedPathFrame
    ) {
      throw new Error(
        `resident path recovery for endpoint ${JSON.stringify(
          endpoint.endpoint
        )} exposed path frame ${String(
          continuation.pathFrame
        )}; expected ${String(expectedPathFrame)}`
      );
    }

    await options.uploadContinuation(continuation);

    const completedAt = readClock(options.now);
    const elapsedMs = completedAt - startedAt;
    if (elapsedMs < 0) {
      throw new RangeError(
        "resident recovery preflight clock must be monotonic"
      );
    }
    const frameDurationMs =
      (1_000 * endpoint.unit.frameRate.denominator) /
      endpoint.unit.frameRate.numerator;
    const requiredContentFrames = Math.ceil(elapsedMs / frameDurationMs) + 1;

    return Object.freeze({
      endpoint: endpoint.endpoint,
      unitId: endpoint.unitId,
      cachedRunwayFrames: endpoint.cachedRunwayFrames,
      pathGeneration,
      firstContinuationPathFrame: Number(continuation.pathFrame),
      elapsedMs,
      frameDurationMs,
      requiredContentFrames,
      ready: requiredContentFrames <= endpoint.cachedRunwayFrames
    });
  } finally {
    continuation?.close();
    decoder?.dispose();
  }
}

function validateEndpoints<TEndpoint extends string>(
  endpoints: readonly ResidentPathRecoveryEndpoint<TEndpoint>[]
): void {
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    throw new RangeError(
      "resident path recovery preflight requires at least one endpoint"
    );
  }

  const seenEndpoints = new Set<string>();
  for (const [index, endpoint] of endpoints.entries()) {
    if (endpoint === null || typeof endpoint !== "object") {
      throw new TypeError(
        `resident path recovery endpoint ${String(index)} must be an object`
      );
    }
    if (typeof endpoint.endpoint !== "string" || endpoint.endpoint.length === 0) {
      throw new TypeError(
        `resident path recovery endpoint ${String(index)} name must be a non-empty string`
      );
    }
    if (seenEndpoints.has(endpoint.endpoint)) {
      throw new RangeError(
        `duplicate resident path recovery endpoint ${JSON.stringify(
          endpoint.endpoint
        )}`
      );
    }
    seenEndpoints.add(endpoint.endpoint);

    if (typeof endpoint.unitId !== "string" || endpoint.unitId.length === 0) {
      throw new TypeError(
        `resident path recovery endpoint ${String(index)} unitId must be a non-empty string`
      );
    }
    if (
      !Number.isSafeInteger(endpoint.cachedRunwayFrames) ||
      endpoint.cachedRunwayFrames < MIN_ENDPOINT_RUNWAY_FRAMES ||
      endpoint.cachedRunwayFrames > MAX_ENDPOINT_RUNWAY_FRAMES
    ) {
      throw new RangeError(
        `resident path recovery endpoint ${String(
          index
        )} cachedRunwayFrames must be an integer from ${String(
          MIN_ENDPOINT_RUNWAY_FRAMES
        )} through ${String(MAX_ENDPOINT_RUNWAY_FRAMES)}`
      );
    }
  }
}

function validateTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("preflight timeoutMs must be positive and finite");
  }
  return value;
}

function readClock(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value)) {
    throw new RangeError("resident recovery preflight clock must be finite");
  }
  return value;
}

function defaultNow(): number {
  return performance.now();
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  }
}
