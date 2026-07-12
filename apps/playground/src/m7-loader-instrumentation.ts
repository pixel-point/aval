import {
  parseFrontIndex,
  parseHeader,
  validateCompleteAsset,
  validatePngProfile
} from "@rendered-motion/format";
import type {
  OpenRuntimeAssetOptions,
  RuntimeAssetSessionResources,
  RuntimePageResourceSnapshot,
  RuntimeStaticPngValidationInput
} from "@rendered-motion/player-web";

type LoaderFetcher = NonNullable<OpenRuntimeAssetOptions["fetcher"]>;
type LoaderDigest = NonNullable<OpenRuntimeAssetOptions["digestAdapter"]>;
type LoaderTimers = NonNullable<OpenRuntimeAssetOptions["timers"]>;
type LoaderFormat = NonNullable<OpenRuntimeAssetOptions["format"]>;
type StaticValidator = NonNullable<OpenRuntimeAssetOptions["validateStaticPng"]>;

export interface M7BodyTelemetry {
  readonly ordinal: number;
  readonly status: number;
  readonly declaredBytes: number | null;
  readonly observedBytes: number;
  readonly readCalls: number;
  readonly completed: boolean;
  readonly cancelled: boolean;
  readonly readFailed: boolean;
}

export interface M7LoaderTelemetry {
  readonly bodies: readonly Readonly<M7BodyTelemetry>[];
  readonly activeBodies: number;
  readonly activeReaders: number;
  readonly peakActiveBodies: number;
  readonly peakActiveReaders: number;
  readonly cancelledReaders: number;
  readonly releasedReaders: number;
  readonly digestCalls: number;
  readonly digestBytes: number;
  readonly parserCalls: Readonly<{
    readonly header: number;
    readonly frontIndex: number;
    readonly completeAsset: number;
  }>;
  readonly pngGateCalls: number;
  readonly mediaGateCalls: number;
  readonly timers: Readonly<{
    readonly scheduled: number;
    readonly cleared: number;
    readonly fired: number;
    readonly pending: number;
    readonly peakPending: number;
  }>;
  readonly resources: Readonly<{
    readonly reservationAttempts: number;
    readonly reservationSuccesses: number;
    readonly reservationFailures: number;
    readonly reservationReleases: number;
    readonly unpromotedFullReleases: number;
    readonly peakPhysicalBytes: number;
    readonly peakPlayerBytes: number;
    readonly peakByteLeases: number;
    readonly peakCategories: Readonly<Record<string, number>>;
    readonly responseBodyPeakBytes: number;
    readonly quarantinePeakBytes: number;
    readonly assemblyPeakBytes: number;
  }>;
}

export interface M7LoaderInstrumentation {
  readonly resources: Readonly<RuntimeAssetSessionResources>;
  readonly fetcher: LoaderFetcher;
  readonly digestAdapter: LoaderDigest;
  readonly timers: LoaderTimers;
  readonly format: LoaderFormat;
  readonly validateStaticPng: StaticValidator;
  snapshot(mediaGateCalls?: number): Readonly<M7LoaderTelemetry>;
}

interface MutableBodyTelemetry {
  ordinal: number;
  status: number;
  declaredBytes: number | null;
  observedBytes: number;
  readCalls: number;
  completed: boolean;
  cancelled: boolean;
  readFailed: boolean;
}

interface MutableTelemetry {
  readonly bodies: MutableBodyTelemetry[];
  activeBodies: number;
  peakActiveBodies: number;
  activeReaders: number;
  peakActiveReaders: number;
  cancelledReaders: number;
  releasedReaders: number;
  digestCalls: number;
  digestBytes: number;
  headerCalls: number;
  frontIndexCalls: number;
  completeAssetCalls: number;
  pngGateCalls: number;
  timersScheduled: number;
  timersCleared: number;
  timersFired: number;
  timersPeakPending: number;
  reservationAttempts: number;
  reservationSuccesses: number;
  reservationFailures: number;
  reservationReleases: number;
  unpromotedFullReleases: number;
  peakPhysicalBytes: number;
  peakPlayerBytes: number;
  peakByteLeases: number;
  readonly peakCategories: Map<string, number>;
}

/** Public-seam instrumentation used only by the deterministic M7 proof. */
export function createM7LoaderInstrumentation(input: Readonly<{
  readonly resources: Readonly<RuntimeAssetSessionResources>;
  readonly snapshotResources: () => Readonly<RuntimePageResourceSnapshot>;
}>): Readonly<M7LoaderInstrumentation> {
  const metrics: MutableTelemetry = {
    bodies: [],
    activeBodies: 0,
    peakActiveBodies: 0,
    activeReaders: 0,
    peakActiveReaders: 0,
    cancelledReaders: 0,
    releasedReaders: 0,
    digestCalls: 0,
    digestBytes: 0,
    headerCalls: 0,
    frontIndexCalls: 0,
    completeAssetCalls: 0,
    pngGateCalls: 0,
    timersScheduled: 0,
    timersCleared: 0,
    timersFired: 0,
    timersPeakPending: 0,
    reservationAttempts: 0,
    reservationSuccesses: 0,
    reservationFailures: 0,
    reservationReleases: 0,
    unpromotedFullReleases: 0,
    peakPhysicalBytes: 0,
    peakPlayerBytes: 0,
    peakByteLeases: 0,
    peakCategories: new Map()
  };
  const pendingTimers = new Map<unknown, ReturnType<typeof setTimeout>>();
  const sampleResources = (): void => {
    const snapshot = input.snapshotResources();
    metrics.peakPhysicalBytes = Math.max(
      metrics.peakPhysicalBytes,
      snapshot.physicalBytes
    );
    metrics.peakByteLeases = Math.max(
      metrics.peakByteLeases,
      snapshot.byteLeaseCount
    );
    for (const participant of snapshot.participants) {
      metrics.peakPlayerBytes = Math.max(
        metrics.peakPlayerBytes,
        participant.logicalBytes
      );
    }
    for (const { category, bytes } of snapshot.categories) {
      metrics.peakCategories.set(
        category,
        Math.max(metrics.peakCategories.get(category) ?? 0, bytes)
      );
    }
  };

  const fetcher: LoaderFetcher = Object.freeze({
    async fetch(url: string, init: Readonly<{
      readonly method: "GET";
      readonly credentials: "omit" | "same-origin";
      readonly signal: AbortSignal;
      readonly headers: Readonly<Record<string, string>>;
    }>) {
      const response = await globalThis.fetch(url, {
        method: init.method,
        credentials: init.credentials,
        signal: init.signal,
        headers: init.headers
      });
      return {
        status: response.status,
        type: response.type,
        url: response.url,
        headers: response.headers,
        body: response.body === null
          ? null
          : {
              getReader() {
                const reader = response.body!.getReader();
                const body: MutableBodyTelemetry = {
                  ordinal: metrics.bodies.length + 1,
                  status: response.status,
                  declaredBytes: parseDeclaredBytes(
                    response.headers.get("Content-Length")
                  ),
                  observedBytes: 0,
                  readCalls: 0,
                  completed: false,
                  cancelled: false,
                  readFailed: false
                };
                metrics.bodies.push(body);
                metrics.activeBodies += 1;
                metrics.activeReaders += 1;
                metrics.peakActiveBodies = Math.max(
                  metrics.peakActiveBodies,
                  metrics.activeBodies
                );
                metrics.peakActiveReaders = Math.max(
                  metrics.peakActiveReaders,
                  metrics.activeReaders
                );
                let terminal = false;
                let released = false;
                const finish = (): void => {
                  if (terminal) return;
                  terminal = true;
                  metrics.activeBodies -= 1;
                };
                return {
                  async read() {
                    body.readCalls += 1;
                    try {
                      const result = await reader.read();
                      if (result.done) {
                        body.completed = true;
                        finish();
                      } else if (result.value !== undefined) {
                        body.observedBytes = checkedSum(
                          body.observedBytes,
                          result.value.byteLength,
                          "observed response bytes"
                        );
                      }
                      return result;
                    } catch (error) {
                      body.readFailed = true;
                      finish();
                      throw error;
                    }
                  },
                  async cancel(reason?: unknown) {
                    if (!body.cancelled) {
                      body.cancelled = true;
                      metrics.cancelledReaders += 1;
                    }
                    try { await reader.cancel(reason); } finally { finish(); }
                  },
                  releaseLock() {
                    if (!released) {
                      released = true;
                      metrics.releasedReaders += 1;
                      metrics.activeReaders -= 1;
                    }
                    reader.releaseLock();
                  }
                };
              }
            }
      };
    }
  });

  const digestAdapter: LoaderDigest = Object.freeze({
    digestSha256(bytes: Uint8Array) {
      metrics.digestCalls += 1;
      metrics.digestBytes = checkedSum(
        metrics.digestBytes,
        bytes.byteLength,
        "digest input bytes"
      );
      if (!(bytes.buffer instanceof ArrayBuffer)) {
        throw new TypeError("digest input must use an ArrayBuffer backing");
      }
      const view = new Uint8Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength
      );
      return globalThis.crypto.subtle.digest("SHA-256", view);
    }
  });

  const timers: LoaderTimers = Object.freeze({
    now: () => performance.now(),
    setTimeout(callback: () => void, milliseconds: number) {
      metrics.timersScheduled += 1;
      const token = Object.freeze({ ordinal: metrics.timersScheduled });
      const handle = globalThis.setTimeout(() => {
        if (!pendingTimers.delete(token)) return;
        metrics.timersFired += 1;
        callback();
      }, milliseconds);
      pendingTimers.set(token, handle);
      metrics.timersPeakPending = Math.max(
        metrics.timersPeakPending,
        pendingTimers.size
      );
      return token;
    },
    clearTimeout(token: unknown) {
      const handle = pendingTimers.get(token);
      if (handle === undefined) return;
      pendingTimers.delete(token);
      metrics.timersCleared += 1;
      globalThis.clearTimeout(handle);
    }
  });

  const format: LoaderFormat = Object.freeze({
    parseHeader(bytes: Uint8Array, maximumFileBytes: number) {
      metrics.headerCalls += 1;
      return parseHeader(bytes, {
        budgets: { maxFileBytes: maximumFileBytes }
      });
    },
    parseFrontIndex(bytes: Uint8Array, maximumFileBytes: number) {
      metrics.frontIndexCalls += 1;
      return parseFrontIndex(bytes, {
        budgets: { maxFileBytes: maximumFileBytes }
      });
    },
    validateCompleteAsset(bytes: Uint8Array, maximumFileBytes: number) {
      metrics.completeAssetCalls += 1;
      return validateCompleteAsset({
        bytes,
        options: { budgets: { maxFileBytes: maximumFileBytes } }
      });
    }
  });

  const validateStaticPng: StaticValidator = (
    validation: Readonly<RuntimeStaticPngValidationInput>
  ) => {
    metrics.pngGateCalls += 1;
    return validatePngProfile(validation);
  };

  const resources = instrumentResources(
    input.resources,
    metrics,
    sampleResources
  );

  return Object.freeze({
    resources,
    fetcher,
    digestAdapter,
    timers,
    format,
    validateStaticPng,
    snapshot(mediaGateCalls = 0): Readonly<M7LoaderTelemetry> {
      sampleResources();
      const categories = Object.fromEntries(
        [...metrics.peakCategories.entries()].sort(([left], [right]) =>
          left.localeCompare(right)
        )
      );
      return Object.freeze({
        bodies: Object.freeze(metrics.bodies.map((body) => Object.freeze({
          ...body
        }))),
        activeBodies: metrics.activeBodies,
        activeReaders: metrics.activeReaders,
        peakActiveBodies: metrics.peakActiveBodies,
        peakActiveReaders: metrics.peakActiveReaders,
        cancelledReaders: metrics.cancelledReaders,
        releasedReaders: metrics.releasedReaders,
        digestCalls: metrics.digestCalls,
        digestBytes: metrics.digestBytes,
        parserCalls: Object.freeze({
          header: metrics.headerCalls,
          frontIndex: metrics.frontIndexCalls,
          completeAsset: metrics.completeAssetCalls
        }),
        pngGateCalls: metrics.pngGateCalls,
        mediaGateCalls,
        timers: Object.freeze({
          scheduled: metrics.timersScheduled,
          cleared: metrics.timersCleared,
          fired: metrics.timersFired,
          pending: pendingTimers.size,
          peakPending: metrics.timersPeakPending
        }),
        resources: Object.freeze({
          reservationAttempts: metrics.reservationAttempts,
          reservationSuccesses: metrics.reservationSuccesses,
          reservationFailures: metrics.reservationFailures,
          reservationReleases: metrics.reservationReleases,
          unpromotedFullReleases: metrics.unpromotedFullReleases,
          peakPhysicalBytes: metrics.peakPhysicalBytes,
          peakPlayerBytes: metrics.peakPlayerBytes,
          peakByteLeases: metrics.peakByteLeases,
          peakCategories: Object.freeze(categories),
          responseBodyPeakBytes: categories["response-body"] ?? 0,
          quarantinePeakBytes: categories.quarantine ?? 0,
          assemblyPeakBytes: categories["blob-assembly"] ?? 0
        })
      });
    }
  });
}

function instrumentResources(
  source: Readonly<RuntimeAssetSessionResources>,
  metrics: MutableTelemetry,
  sample: () => void
): Readonly<RuntimeAssetSessionResources> {
  const body = (
    host: RuntimeAssetSessionResources["response"],
    category: "asset-metadata" | "response-body" | "quarantine",
    promotable: boolean
  ): RuntimeAssetSessionResources["response"] => Object.freeze({
    reserve(byteLength: number) {
      metrics.reservationAttempts += 1;
      let reservation;
      try { reservation = host.reserve(byteLength); } catch (error) {
        metrics.reservationFailures += 1;
        sample();
        throw error;
      }
      return Promise.resolve(reservation).then((lease) => {
        metrics.reservationSuccesses += 1;
        sample();
        let promoted = false;
        let released = false;
        return Object.freeze({
          ...(promotable && lease.promoteToAssetFull !== undefined
            ? {
                promoteToAssetFull() {
                  if (promoted) return;
                  lease.promoteToAssetFull!();
                  promoted = true;
                  sample();
                }
              }
            : {}),
          release() {
            if (released) return;
            released = true;
            if (category === "quarantine" && !promoted) {
              metrics.unpromotedFullReleases += 1;
            }
            metrics.reservationReleases += 1;
            lease.release();
            sample();
          }
        });
      }, (error) => {
        metrics.reservationFailures += 1;
        sample();
        throw error;
      });
    }
  });
  const simpleLease = <Lease extends { release(): void }>(
    lease: Lease
  ): Lease => {
    metrics.reservationSuccesses += 1;
    sample();
    let released = false;
    return Object.freeze({
      release() {
        if (released) return;
        released = true;
        metrics.reservationReleases += 1;
        lease.release();
        sample();
      }
    }) as Lease;
  };
  return Object.freeze({
    metadata: body(source.metadata, "asset-metadata", false),
    response: body(source.response, "response-body", false),
    full: body(source.full, "quarantine", true),
    assembly: Object.freeze({
      async reserve(byteLength: number) {
        metrics.reservationAttempts += 1;
        try {
          return simpleLease(await source.assembly.reserve(byteLength));
        } catch (error) {
          metrics.reservationFailures += 1;
          sample();
          throw error;
        }
      }
    }),
    verified: Object.freeze({
      async reserve(
        category: "verified-unit" | "verified-static",
        byteLength: number
      ) {
        metrics.reservationAttempts += 1;
        try {
          return simpleLease(await source.verified.reserve(category, byteLength));
        } catch (error) {
          metrics.reservationFailures += 1;
          sample();
          throw error;
        }
      }
    })
  });
}

function parseDeclaredBytes(value: string | null): number | null {
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

function checkedSum(left: number, right: number, label: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum) || sum < 0) {
    throw new RangeError(`${label} exceeded the safe-integer range`);
  }
  return sum;
}
