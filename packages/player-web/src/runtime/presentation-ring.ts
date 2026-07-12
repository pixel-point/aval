import type { ManagedDecoderWorkerFrame } from "../decoder-worker/client.js";

export const MIN_PRESENTATION_RING_CAPACITY = 6 as const;
export const MAX_PRESENTATION_RING_CAPACITY = 12 as const;

const MAX_MEDIA_ID_LENGTH = 128;

export interface PresentationRingExpectedFrame {
  readonly generation: number;
  readonly path: string;
  readonly unitId: string;
  readonly unitInstance: number;
  readonly unitFrame: number;
  readonly decodeOrdinal: number;
  readonly timestamp: number;
  readonly duration: number;
  readonly intendedPresentationOrdinal: bigint;
}

export interface PresentationRingInsertion {
  readonly expected: PresentationRingExpectedFrame;
  readonly frame: ManagedDecoderWorkerFrame;
  readonly workerOutputTimeMs: number;
  readonly uploadReadyTimeMs: number | null;
}

export interface PresentationRingEntry
  extends PresentationRingExpectedFrame {
  readonly frameId: number;
  readonly decodedBytes: number;
  readonly workerOutputTimeMs: number;
  readonly uploadReadyTimeMs: number | null;
  readonly frame: ManagedDecoderWorkerFrame;
}

export type PresentationRingEnqueueResult =
  | {
      readonly kind: "accepted";
      readonly size: number;
    }
  | {
      readonly kind: "stale";
      readonly activeGeneration: number;
      readonly discardedGeneration: number;
    };

export type PresentationRingTakeResult =
  | {
      readonly kind: "frame";
      readonly entry: Readonly<PresentationRingEntry>;
    }
  | {
      readonly kind: "underflow";
      readonly expected: Readonly<PresentationRingExpectedFrame>;
    };

export interface PresentationRingSnapshotEntry
  extends PresentationRingExpectedFrame {
  readonly frameId: number;
  readonly decodedBytes: number;
  readonly workerOutputTimeMs: number;
  readonly uploadReadyTimeMs: number | null;
}

export interface PresentationRingSnapshot {
  readonly capacity: number;
  readonly generation: number;
  readonly activePath: string;
  readonly size: number;
  readonly decodedBytes: number;
  readonly underflows: number;
  readonly staleFrames: number;
  readonly closedFrames: number;
  readonly disposed: boolean;
  readonly entries: readonly Readonly<PresentationRingSnapshotEntry>[];
}

export interface PresentationRingOptions {
  readonly capacity: number;
  readonly generation: number;
  readonly path: string;
}

/** Bounded FIFO owner for one active streaming media path. */
export class PresentationRing {
  readonly #capacity: number;
  #generation: number;
  #activePath: string;
  readonly #entries: PresentationRingEntry[] = [];
  #decodedBytes = 0;
  #underflows = 0;
  #staleFrames = 0;
  #closedFrames = 0;
  #disposed = false;

  public constructor(options: PresentationRingOptions) {
    validatePresentationRingCapacity(options.capacity);
    validatePositiveSafeInteger(options.generation, "ring generation");
    validateMediaId(options.path, "ring path");
    this.#capacity = options.capacity;
    this.#generation = options.generation;
    this.#activePath = options.path;
  }

  /** Takes ownership of `frame` on every success and failure path. */
  public enqueue(
    insertion: PresentationRingInsertion
  ): Readonly<PresentationRingEnqueueResult> {
    const frame = insertion.frame;
    try {
      this.#requireUsable();
      validateExpected(insertion.expected);
      validateTiming(
        insertion.workerOutputTimeMs,
        insertion.uploadReadyTimeMs
      );
      validatePositiveSafeInteger(frame.frameId, "worker frame ID");
      validatePositiveSafeInteger(frame.decodedBytes, "decoded frame bytes");
      validateFrameMatches(frame, insertion.expected);

      if (insertion.expected.generation < this.#generation) {
        this.#closeOwnedFrame(frame);
        this.#staleFrames += 1;
        return Object.freeze({
          kind: "stale",
          activeGeneration: this.#generation,
          discardedGeneration: insertion.expected.generation
        });
      }
      if (insertion.expected.generation > this.#generation) {
        throw new RangeError(
          "ring output generation is newer than the active generation"
        );
      }
      if (insertion.expected.path !== this.#activePath) {
        throw new RangeError("ring output did not target the active media path");
      }
      if (frame.closed) {
        throw new RangeError("ring cannot own an already closed frame");
      }
      if (this.#entries.length >= this.#capacity) {
        throw new RangeError("presentation ring capacity is full");
      }
      if (this.#entries.some((entry) =>
        entry.frameId === frame.frameId ||
        sameExpected(entry, insertion.expected)
      )) {
        throw new RangeError("presentation ring rejected a duplicate identity");
      }

      const tail = this.#entries.at(-1);
      if (tail !== undefined) {
        validateNextFifoIdentity(tail, insertion.expected);
      }
      if (this.#decodedBytes > Number.MAX_SAFE_INTEGER - frame.decodedBytes) {
        throw new RangeError("presentation ring decoded bytes exceed safe range");
      }

      const entry = Object.freeze({
        ...copyExpected(insertion.expected),
        frameId: frame.frameId,
        decodedBytes: frame.decodedBytes,
        workerOutputTimeMs: insertion.workerOutputTimeMs,
        uploadReadyTimeMs: insertion.uploadReadyTimeMs,
        frame
      });
      this.#entries.push(entry);
      this.#decodedBytes += frame.decodedBytes;
      return Object.freeze({ kind: "accepted", size: this.#entries.length });
    } catch (error) {
      this.#closeOwnedFrame(frame);
      throw error;
    }
  }

  /**
   * Removes only the exact expected head. A frame result transfers ownership
   * to the renderer; the renderer becomes responsible for its single close.
   */
  public takeExpected(
    expected: PresentationRingExpectedFrame
  ): Readonly<PresentationRingTakeResult> {
    this.#requireUsable();
    validateExpected(expected);
    if (
      expected.generation !== this.#generation ||
      expected.path !== this.#activePath
    ) {
      throw new RangeError(
        "expected presentation does not target the active ring path"
      );
    }

    const head = this.#entries[0];
    if (head === undefined) {
      this.#underflows += 1;
      return Object.freeze({
        kind: "underflow",
        expected: copyExpected(expected)
      });
    }
    if (!sameExpected(head, expected)) {
      throw new RangeError(
        "ring head did not match the expected presentation identity"
      );
    }

    this.#removeHead(head);
    if (head.frame.closed) {
      throw new RangeError("ring-owned frame was already closed before take");
    }
    return Object.freeze({ kind: "frame", entry: head });
  }

  /** Retires all old path frames before activating a strictly newer token. */
  public activatePath(input: {
    readonly generation: number;
    readonly path: string;
  }): Readonly<{
    readonly closedFrames: number;
    readonly generation: number;
    readonly path: string;
  }> {
    this.#requireUsable();
    validatePositiveSafeInteger(input.generation, "ring generation");
    validateMediaId(input.path, "ring path");

    if (
      input.generation === this.#generation &&
      input.path === this.#activePath
    ) {
      return Object.freeze({
        closedFrames: 0,
        generation: this.#generation,
        path: this.#activePath
      });
    }
    if (input.generation <= this.#generation) {
      throw new RangeError(
        "ring generation must increase before replacing the active path"
      );
    }

    const closedFrames = this.#closeAllEntries();
    this.#generation = input.generation;
    this.#activePath = input.path;
    return Object.freeze({
      closedFrames,
      generation: this.#generation,
      path: this.#activePath
    });
  }

  public clear(): Readonly<{ readonly closedFrames: number }> {
    this.#requireUsable();
    return Object.freeze({ closedFrames: this.#closeAllEntries() });
  }

  public dispose(): Readonly<{ readonly closedFrames: number }> {
    if (this.#disposed) {
      return Object.freeze({ closedFrames: 0 });
    }
    this.#disposed = true;
    return Object.freeze({ closedFrames: this.#closeAllEntries() });
  }

  public snapshot(): Readonly<PresentationRingSnapshot> {
    return Object.freeze({
      capacity: this.#capacity,
      generation: this.#generation,
      activePath: this.#activePath,
      size: this.#entries.length,
      decodedBytes: this.#decodedBytes,
      underflows: this.#underflows,
      staleFrames: this.#staleFrames,
      closedFrames: this.#closedFrames,
      disposed: this.#disposed,
      entries: Object.freeze(this.#entries.map((entry) =>
        Object.freeze({
          ...copyExpected(entry),
          frameId: entry.frameId,
          decodedBytes: entry.decodedBytes,
          workerOutputTimeMs: entry.workerOutputTimeMs,
          uploadReadyTimeMs: entry.uploadReadyTimeMs
        })
      ))
    });
  }

  #requireUsable(): void {
    if (this.#disposed) {
      throw new RangeError("presentation ring is disposed");
    }
  }

  #removeHead(head: PresentationRingEntry): void {
    this.#entries.shift();
    this.#decodedBytes -= head.decodedBytes;
  }

  #closeOwnedFrame(frame: ManagedDecoderWorkerFrame): boolean {
    const wasOpen = !frame.closed;
    frame.close();
    if (wasOpen) {
      this.#closedFrames += 1;
    }
    return wasOpen;
  }

  #closeAllEntries(): number {
    const entries = this.#entries.splice(0);
    this.#decodedBytes = 0;
    let closedFrames = 0;
    const errors: unknown[] = [];
    for (const entry of entries) {
      try {
        if (this.#closeOwnedFrame(entry.frame)) {
          closedFrames += 1;
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "presentation ring frame cleanup failed");
    }
    return closedFrames;
  }
}

export function validatePresentationRingCapacity(capacity: number): void {
  if (
    !Number.isSafeInteger(capacity) ||
    capacity < MIN_PRESENTATION_RING_CAPACITY ||
    capacity > MAX_PRESENTATION_RING_CAPACITY
  ) {
    throw new RangeError(
      `presentation ring capacity must be ${String(
        MIN_PRESENTATION_RING_CAPACITY
      )}-${String(MAX_PRESENTATION_RING_CAPACITY)}`
    );
  }
}

function validateExpected(expected: PresentationRingExpectedFrame): void {
  validatePositiveSafeInteger(expected.generation, "frame generation");
  validateMediaId(expected.path, "frame path");
  validateMediaId(expected.unitId, "frame unit ID");
  validateNonNegativeSafeInteger(expected.unitInstance, "unit instance");
  validateNonNegativeSafeInteger(expected.unitFrame, "unit frame");
  validateNonNegativeSafeInteger(expected.decodeOrdinal, "decode ordinal");
  if (expected.decodeOrdinal >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("decode ordinal leaves no safe successor");
  }
  validateNonNegativeSafeInteger(expected.timestamp, "frame timestamp");
  validatePositiveSafeInteger(expected.duration, "frame duration");
  if (expected.timestamp > Number.MAX_SAFE_INTEGER - expected.duration) {
    throw new RangeError("frame timestamp plus duration exceeds safe range");
  }
  if (expected.intendedPresentationOrdinal < 0n) {
    throw new RangeError("presentation ordinal must be non-negative");
  }
}

function validateFrameMatches(
  frame: ManagedDecoderWorkerFrame,
  expected: PresentationRingExpectedFrame
): void {
  if (
    frame.generation !== expected.generation ||
    frame.ordinal !== expected.decodeOrdinal ||
    frame.unitId !== expected.unitId ||
    frame.unitInstance !== expected.unitInstance ||
    frame.unitFrame !== expected.unitFrame ||
    frame.timestamp !== expected.timestamp ||
    frame.duration !== expected.duration
  ) {
    throw new RangeError(
      "managed decoder frame did not match its expected ring identity"
    );
  }
}

function validateNextFifoIdentity(
  previous: PresentationRingExpectedFrame,
  next: PresentationRingExpectedFrame
): void {
  if (
    next.decodeOrdinal !== previous.decodeOrdinal + 1 ||
    next.timestamp !== previous.timestamp + previous.duration ||
    next.intendedPresentationOrdinal !==
      previous.intendedPresentationOrdinal + 1n
  ) {
    throw new RangeError("presentation ring rejected noncontiguous FIFO order");
  }

  if (next.unitInstance === previous.unitInstance) {
    if (
      next.unitId !== previous.unitId ||
      next.unitFrame !== previous.unitFrame + 1
    ) {
      throw new RangeError("presentation ring rejected noncontiguous unit order");
    }
    return;
  }
  if (
    next.unitInstance !== previous.unitInstance + 1 ||
    next.unitFrame !== 0
  ) {
    throw new RangeError("presentation ring rejected noncontiguous occurrence order");
  }
}

function sameExpected(
  left: PresentationRingExpectedFrame,
  right: PresentationRingExpectedFrame
): boolean {
  return (
    left.generation === right.generation &&
    left.path === right.path &&
    left.unitId === right.unitId &&
    left.unitInstance === right.unitInstance &&
    left.unitFrame === right.unitFrame &&
    left.decodeOrdinal === right.decodeOrdinal &&
    left.timestamp === right.timestamp &&
    left.duration === right.duration &&
    left.intendedPresentationOrdinal === right.intendedPresentationOrdinal
  );
}

function copyExpected(
  expected: PresentationRingExpectedFrame
): Readonly<PresentationRingExpectedFrame> {
  return Object.freeze({
    generation: expected.generation,
    path: expected.path,
    unitId: expected.unitId,
    unitInstance: expected.unitInstance,
    unitFrame: expected.unitFrame,
    decodeOrdinal: expected.decodeOrdinal,
    timestamp: expected.timestamp,
    duration: expected.duration,
    intendedPresentationOrdinal: expected.intendedPresentationOrdinal
  });
}

function validateTiming(
  workerOutputTimeMs: number,
  uploadReadyTimeMs: number | null
): void {
  if (!Number.isFinite(workerOutputTimeMs) || workerOutputTimeMs < 0) {
    throw new RangeError("worker output time must be finite and non-negative");
  }
  if (
    uploadReadyTimeMs !== null &&
    (!Number.isFinite(uploadReadyTimeMs) ||
      uploadReadyTimeMs < workerOutputTimeMs)
  ) {
    throw new RangeError(
      "upload-ready time must be null or no earlier than worker output"
    );
  }
}

function validateMediaId(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_MEDIA_ID_LENGTH
  ) {
    throw new RangeError(`${label} length must be 1-${String(MAX_MEDIA_ID_LENGTH)}`);
  }
}

function validatePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function validateNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}
