import {
  ContinuousLoopDecoder,
  type ContinuousLoopDecoderOptions,
  type ManagedDecodedFrame
} from "./continuous-loop-decoder.js";
import type { EncodedLoopUnit } from "./encoded-loop.js";
import type {
  ResidentFrameKey,
  ResidentFramePlan
} from "./resident-frame-plan.js";
import type {
  ResidentFrameHandle,
  WebGlFrameRenderer
} from "./webgl-frame-renderer.js";

const DEFAULT_PREPARATION_TIMEOUT_MS = 5_000;
const MAX_PREPARATION_IN_FLIGHT = 24;

export interface ResidentPreparationUnit {
  readonly rendition: string;
  readonly id: string;
  readonly unit: EncodedLoopUnit;
}

export interface ResidentFrameUploadTarget {
  readonly resourceGeneration: number;
  uploadResident(
    layer: number,
    source: ManagedDecodedFrame,
    resourceGeneration?: number
  ): Promise<ResidentFrameHandle | null>;
}

export interface PrepareResidentFramesOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly decoderOptions?: Omit<
    ContinuousLoopDecoderOptions,
    "startVirtualFrame" | "maxInFlight"
  >;
}

export interface ResidentFramePreparationReport {
  readonly decoderCount: number;
  readonly decodedFrames: number;
  readonly uploadedFrames: number;
  readonly dependencyFramesClosed: number;
  readonly sourceFramesClosed: number;
  readonly resourceGeneration: number;
}

interface UnitPreparation {
  readonly descriptor: ResidentPreparationUnit;
  readonly layerByLocalFrame: ReadonlyMap<number, number>;
  readonly stopBeforeFrame: number;
  readonly firstLayer: number;
}

/**
 * Decodes exactly the prefixes needed by a frozen resident plan. Each decoded
 * frame is either transferred to the renderer or closed as a dependency frame;
 * no VideoFrame survives this function's successful completion.
 */
export async function prepareResidentFrames(
  plan: ResidentFramePlan,
  units: readonly ResidentPreparationUnit[],
  renderer: ResidentFrameUploadTarget,
  options: PrepareResidentFramesOptions = {}
): Promise<ResidentFramePreparationReport> {
  const timeoutMs = validateTimeout(
    options.timeoutMs ?? DEFAULT_PREPARATION_TIMEOUT_MS
  );
  if (options.signal?.aborted === true) {
    throw abortReason(options.signal);
  }

  const preparations = buildPreparations(plan, units);
  const resourceGeneration = renderer.resourceGeneration;
  let decodedFrames = 0;
  let uploadedFrames = 0;
  let dependencyFramesClosed = 0;

  for (const preparation of preparations) {
    throwIfAborted(options.signal);
    const maxInFlight = Math.min(
      MAX_PREPARATION_IN_FLIGHT,
      preparation.stopBeforeFrame
    );
    const decoder = new ContinuousLoopDecoder(preparation.descriptor.unit, {
      maxInFlight,
      ...options.decoderOptions
    });
    let nextExpectedFrame = 0;
    let submittedFrames = 0;
    let terminalDrain: Promise<void> | null = null;

    const fillFinitePrefix = (): void => {
      if (terminalDrain !== null) {
        return;
      }
      submittedFrames += decoder.fillToAhead(
        maxInFlight,
        preparation.stopBeforeFrame
      );
      if (
        submittedFrames === preparation.stopBeforeFrame &&
        terminalDrain === null
      ) {
        terminalDrain = decoder.terminalFlush();
        void terminalDrain.catch(() => undefined);
      }
    };

    try {
      // Submit the complete finite prefix before its one terminal drain. For
      // long dependency prefixes, consuming a chronological output releases
      // one horizon slot and permits the next input chunk to be submitted.
      fillFinitePrefix();
      while (nextExpectedFrame < preparation.stopBeforeFrame) {
        throwIfAborted(options.signal);
        await decoder.waitForFrames(1, {
          timeoutMs,
          ...(options.signal === undefined ? {} : { signal: options.signal })
        });

        for (;;) {
          const decoded = decoder.takeFrame();
          if (decoded === undefined) {
            break;
          }
          decodedFrames += 1;

          if (
            decoded.iteration !== 0n ||
            decoded.virtualFrame !== BigInt(nextExpectedFrame) ||
            decoded.contentFrame !== nextExpectedFrame
          ) {
            decoded.close();
            throw new Error(
              `resident preparation decoded an unexpected frame for ${preparation.descriptor.id}`
            );
          }

          const layer = preparation.layerByLocalFrame.get(nextExpectedFrame);
          nextExpectedFrame += 1;
          if (layer === undefined) {
            decoded.close();
            dependencyFramesClosed += 1;
          } else {
            const handle = await renderer.uploadResident(
              layer,
              decoded,
              resourceGeneration
            );
            if (handle === null) {
              throw new DOMException(
                "resident frame preparation was superseded",
                "AbortError"
              );
            }
            uploadedFrames += 1;
          }

          if (nextExpectedFrame >= preparation.stopBeforeFrame) {
            break;
          }
          fillFinitePrefix();
        }
      }
      if (terminalDrain === null) {
        throw new Error("resident preparation did not submit its finite prefix");
      }
      await terminalDrain;
    } finally {
      decoder.dispose();
    }
  }

  if (uploadedFrames !== plan.layerCount) {
    throw new Error(
      `resident preparation uploaded ${String(uploadedFrames)} of ${String(plan.layerCount)} planned layers`
    );
  }

  return Object.freeze({
    decoderCount: preparations.length,
    decodedFrames,
    uploadedFrames,
    dependencyFramesClosed,
    sourceFramesClosed: decodedFrames,
    resourceGeneration
  });
}

/** Real renderer satisfies the narrow upload target without an adapter. */
export function asResidentUploadTarget(
  renderer: WebGlFrameRenderer
): ResidentFrameUploadTarget {
  return renderer;
}

function buildPreparations(
  plan: ResidentFramePlan,
  units: readonly ResidentPreparationUnit[]
): readonly UnitPreparation[] {
  if (!Array.isArray(units) || units.length === 0) {
    throw new TypeError("resident preparation units must be a non-empty array");
  }

  const descriptorByIdentity = new Map<string, ResidentPreparationUnit>();
  for (const [index, descriptor] of units.entries()) {
    validateDescriptor(descriptor, index, plan);
    const identity = unitIdentity(descriptor.rendition, descriptor.id);
    if (descriptorByIdentity.has(identity)) {
      throw new RangeError(
        `duplicate resident preparation unit ${JSON.stringify(descriptor.id)}`
      );
    }
    descriptorByIdentity.set(identity, descriptor);
  }

  const mutableByIdentity = new Map<
    string,
    {
      descriptor: ResidentPreparationUnit;
      layerByLocalFrame: Map<number, number>;
      maximumLocalFrame: number;
      firstLayer: number;
    }
  >();

  for (const planned of plan.uniqueFrames) {
    const identity = unitIdentity(planned.key.rendition, planned.key.unit);
    const descriptor = descriptorByIdentity.get(identity);
    if (descriptor === undefined) {
      throw new RangeError(
        `resident frame ${describeKey(planned.key)} has no encoded unit`
      );
    }
    if (planned.key.localFrame >= descriptor.unit.frames.length) {
      throw new RangeError(
        `resident frame ${describeKey(planned.key)} exceeds its encoded unit`
      );
    }

    let mutable = mutableByIdentity.get(identity);
    if (mutable === undefined) {
      mutable = {
        descriptor,
        layerByLocalFrame: new Map(),
        maximumLocalFrame: planned.key.localFrame,
        firstLayer: planned.layer
      };
      mutableByIdentity.set(identity, mutable);
    }
    if (mutable.layerByLocalFrame.has(planned.key.localFrame)) {
      throw new Error(
        `resident plan assigned ${describeKey(planned.key)} more than once`
      );
    }
    mutable.layerByLocalFrame.set(planned.key.localFrame, planned.layer);
    mutable.maximumLocalFrame = Math.max(
      mutable.maximumLocalFrame,
      planned.key.localFrame
    );
    mutable.firstLayer = Math.min(mutable.firstLayer, planned.layer);
  }

  const preparations = [...mutableByIdentity.values()]
    .sort((left, right) => left.firstLayer - right.firstLayer)
    .map((mutable) =>
      Object.freeze({
        descriptor: mutable.descriptor,
        layerByLocalFrame: mutable.layerByLocalFrame,
        stopBeforeFrame: mutable.maximumLocalFrame + 1,
        firstLayer: mutable.firstLayer
      })
    );

  return Object.freeze(preparations);
}

function validateDescriptor(
  descriptor: ResidentPreparationUnit,
  index: number,
  plan: ResidentFramePlan
): void {
  if (descriptor === null || typeof descriptor !== "object") {
    throw new TypeError(`resident preparation unit ${String(index)} must be an object`);
  }
  if (
    typeof descriptor.rendition !== "string" ||
    descriptor.rendition.trim().length === 0 ||
    typeof descriptor.id !== "string" ||
    descriptor.id.trim().length === 0
  ) {
    throw new TypeError(
      `resident preparation unit ${String(index)} needs rendition and id strings`
    );
  }
  if (
    descriptor.unit.displayWidth !== plan.width ||
    descriptor.unit.displayHeight !== plan.height
  ) {
    throw new RangeError(
      `resident preparation unit ${descriptor.id} dimensions do not match the plan`
    );
  }
}

function unitIdentity(rendition: string, unit: string): string {
  return JSON.stringify([rendition, unit]);
}

function describeKey(key: ResidentFrameKey): string {
  return JSON.stringify([key.rendition, key.unit, key.localFrame]);
}

function validateTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("resident preparation timeout must be positive and finite");
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw abortReason(signal);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("resident preparation aborted", "AbortError");
}
