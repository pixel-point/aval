import type { ByteRange } from "@rendered-motion/format";

export type { PlannedRuntimeBlob } from "./blob-range-plan.js";
import type { PlannedRuntimeBlob } from "./blob-range-plan.js";

export interface BlobAssemblyLease {
  release(): void;
}

export interface BlobAssemblyResourceHost {
  reserve(
    bytes: number
  ): BlobAssemblyLease | PromiseLike<BlobAssemblyLease>;
}

export interface BlobAssemblySegment {
  readonly generation: number;
  readonly offset: number;
  readonly bytes: Uint8Array;
  readonly lease?: BlobAssemblyLease;
}

export interface QuarantinedRuntimeBlob {
  readonly bytes: Uint8Array<ArrayBuffer>;
  release(): void;
}

export interface BlobAssemblySnapshot {
  readonly generation: number;
  readonly acceptedStorageBytes: number;
  readonly blobBytes: number;
  readonly complete: boolean;
  readonly disposed: boolean;
  readonly liveAssemblyBytes: number;
  readonly peakAssemblyBytes: number;
}

interface AcceptedInterval {
  readonly start: number;
  readonly end: number;
}

/** One exact, generation-bound quarantine destination for a canonical blob. */
export class RuntimeBlobAssembly {
  readonly #blob: PlannedRuntimeBlob;
  readonly #generation: number;
  readonly #intervals: AcceptedInterval[] = [];
  readonly #peakAssemblyBytes: number;

  #bytes: Uint8Array<ArrayBuffer> | null;
  #lease: BlobAssemblyLease | null;
  #acceptedStorageBytes = 0;
  #completed = false;
  #disposed = false;
  #failure: Error | null = null;

  private constructor(input: Readonly<{
    readonly blob: PlannedRuntimeBlob;
    readonly generation: number;
    readonly bytes: Uint8Array<ArrayBuffer>;
    readonly lease: BlobAssemblyLease;
  }>) {
    this.#blob = input.blob;
    this.#generation = input.generation;
    this.#bytes = input.bytes;
    this.#lease = input.lease;
    this.#peakAssemblyBytes = input.bytes.byteLength;
  }

  /** Admit exact quarantine ownership before allocating its backing buffer. */
  public static async create(input: Readonly<{
    readonly blob: PlannedRuntimeBlob;
    readonly generation: number;
    readonly resources: BlobAssemblyResourceHost;
    readonly signal?: AbortSignal;
    readonly allocate?: (byteLength: number) => Uint8Array<ArrayBuffer>;
  }>): Promise<RuntimeBlobAssembly> {
    const captured = captureAssemblyInput(input);
    throwIfAborted(captured.signal);
    const pending = Promise.resolve().then(() => Reflect.apply(
      captured.reserve,
      captured.resources,
      [captured.blob.blobRange.length]
    ) as BlobAssemblyLease | PromiseLike<BlobAssemblyLease>);
    const lease = await awaitAssemblyLease(pending, captured.signal);
    try {
      throwIfAborted(captured.signal);
      const bytes = captureAssemblyAllocation(
        captured.allocate(captured.blob.blobRange.length),
        captured.blob.blobRange.length
      );
      throwIfAborted(captured.signal);
      return new RuntimeBlobAssembly({
        blob: captured.blob,
        generation: captured.generation,
        bytes,
        lease
      });
    } catch (error) {
      safelyRelease(lease);
      throw error;
    }
  }

  public accept(segment: Readonly<BlobAssemblySegment>): void {
    const segmentLease = captureLease(segment?.lease);
    try {
      if (typeof segment !== "object" || segment === null) {
        throw new TypeError("blob assembly segment must be an object");
      }
      if (this.#disposed) {
        throw new Error("blob assembly is already terminal");
      }
      if (segment.generation !== this.#generation) {
        throw new Error("blob assembly segment belongs to another generation");
      }
      if (!(segment.bytes instanceof Uint8Array) || segment.bytes.byteLength === 0) {
        this.#fail(new TypeError("blob assembly segment must contain bytes"));
      }
      requireNonNegativeSafeInteger(segment.offset, "segment offset");
      const end = checkedAdd(segment.offset, segment.bytes.byteLength, "segment end");
      const storageEnd = rangeEnd(this.#blob.storageRange);
      if (
        segment.offset < this.#blob.storageRange.offset ||
        end > storageEnd
      ) {
        this.#fail(new RangeError("blob assembly segment exceeds its storage span"));
      }
      if (this.#overlaps(segment.offset, end)) {
        this.#fail(new RangeError("blob assembly segments overlap"));
      }

      this.#validatePadding(segment.offset, segment.bytes);
      this.#copyBlobIntersection(segment.offset, end, segment.bytes);
      this.#insertInterval(Object.freeze({ start: segment.offset, end }));
      this.#acceptedStorageBytes = checkedAdd(
        this.#acceptedStorageBytes,
        segment.bytes.byteLength,
        "accepted assembly bytes"
      );
    } finally {
      safelyRelease(segmentLease);
    }
  }

  public complete(): Readonly<QuarantinedRuntimeBlob> {
    if (this.#completed) {
      throw new Error("blob assembly was already completed");
    }
    if (this.#failure !== null) throw this.#failure;
    if (this.#disposed || this.#bytes === null || this.#lease === null) {
      throw new Error("blob assembly is disposed");
    }
    if (!this.#hasCompleteCoverage()) {
      this.#fail(new Error("blob assembly has missing storage bytes"));
    }

    const bytes = this.#bytes;
    const lease = this.#lease;
    this.#bytes = null;
    this.#lease = null;
    this.#completed = true;
    this.#disposed = true;
    let released = false;
    return Object.freeze({
      bytes,
      release() {
        if (released) return;
        released = true;
        safelyRelease(lease);
      }
    });
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#bytes = null;
    const lease = this.#lease;
    this.#lease = null;
    safelyRelease(lease);
  }

  public snapshot(): Readonly<BlobAssemblySnapshot> {
    return Object.freeze({
      generation: this.#generation,
      acceptedStorageBytes: this.#acceptedStorageBytes,
      blobBytes: this.#blob.blobRange.length,
      complete: this.#completed,
      disposed: this.#disposed,
      liveAssemblyBytes: this.#bytes?.byteLength ?? 0,
      peakAssemblyBytes: this.#peakAssemblyBytes
    });
  }

  #validatePadding(offset: number, bytes: Uint8Array): void {
    const paddingEnd = rangeEnd(this.#blob.paddingRange);
    const checkedEnd = Math.min(paddingEnd, offset + bytes.byteLength);
    for (let absolute = offset; absolute < checkedEnd; absolute += 1) {
      if (bytes[absolute - offset] !== 0) {
        this.#fail(new Error("canonical blob padding must contain only zero bytes"));
      }
    }
  }

  #copyBlobIntersection(
    segmentStart: number,
    segmentEnd: number,
    segmentBytes: Uint8Array
  ): void {
    const bytes = this.#bytes;
    if (bytes === null) this.#fail(new Error("blob assembly has no destination"));
    const blobStart = this.#blob.blobRange.offset;
    const blobEnd = rangeEnd(this.#blob.blobRange);
    const copyStart = Math.max(segmentStart, blobStart);
    const copyEnd = Math.min(segmentEnd, blobEnd);
    if (copyEnd <= copyStart) return;
    bytes.set(
      segmentBytes.subarray(copyStart - segmentStart, copyEnd - segmentStart),
      copyStart - blobStart
    );
  }

  #overlaps(start: number, end: number): boolean {
    return this.#intervals.some((interval) =>
      start < interval.end && interval.start < end
    );
  }

  #insertInterval(interval: AcceptedInterval): void {
    const index = this.#intervals.findIndex((entry) => entry.start > interval.start);
    if (index === -1) this.#intervals.push(interval);
    else this.#intervals.splice(index, 0, interval);
  }

  #hasCompleteCoverage(): boolean {
    if (this.#acceptedStorageBytes !== this.#blob.storageRange.length) return false;
    let cursor = this.#blob.storageRange.offset;
    for (const interval of this.#intervals) {
      if (interval.start !== cursor) return false;
      cursor = interval.end;
    }
    return cursor === rangeEnd(this.#blob.storageRange);
  }

  #fail(error: Error): never {
    if (this.#failure === null) this.#failure = error;
    this.#disposed = true;
    this.#bytes = null;
    const lease = this.#lease;
    this.#lease = null;
    safelyRelease(lease);
    throw this.#failure;
  }
}

interface CapturedAssemblyInput {
  readonly blob: PlannedRuntimeBlob;
  readonly generation: number;
  readonly resources: BlobAssemblyResourceHost;
  readonly reserve: BlobAssemblyResourceHost["reserve"];
  readonly signal: AbortSignal | null;
  readonly allocate: (byteLength: number) => Uint8Array<ArrayBuffer>;
}

function captureAssemblyInput(value: Readonly<{
  readonly blob: PlannedRuntimeBlob;
  readonly generation: number;
  readonly resources: BlobAssemblyResourceHost;
  readonly signal?: AbortSignal;
  readonly allocate?: (byteLength: number) => Uint8Array<ArrayBuffer>;
}>): Readonly<CapturedAssemblyInput> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("blob assembly input must be an object");
  }
  let blob: PlannedRuntimeBlob;
  let generation: number;
  let resources: BlobAssemblyResourceHost;
  let signal: AbortSignal | undefined;
  let allocate: ((byteLength: number) => Uint8Array<ArrayBuffer>) | undefined;
  let reserve: BlobAssemblyResourceHost["reserve"];
  try {
    blob = value.blob;
    generation = value.generation;
    resources = value.resources;
    signal = value.signal;
    allocate = value.allocate;
    reserve = resources.reserve;
  } catch {
    throw new TypeError("blob assembly input is inaccessible");
  }
  validateBlob(blob);
  requireNonNegativeSafeInteger(generation, "assembly generation");
  if (typeof resources !== "object" || resources === null) {
    throw new TypeError("blob assembly resource host must be an object");
  }
  if (typeof reserve !== "function") {
    throw new TypeError("blob assembly resource host must provide reserve()");
  }
  if (signal !== undefined && !isAbortSignal(signal)) {
    throw new TypeError("blob assembly signal must be an AbortSignal");
  }
  if (allocate !== undefined && typeof allocate !== "function") {
    throw new TypeError("blob assembly allocator must be a function");
  }
  return Object.freeze({
    blob,
    generation,
    resources,
    reserve,
    signal: signal ?? null,
    allocate: allocate ?? allocateAssemblyBytes
  });
}

async function awaitAssemblyLease(
  pending: Promise<BlobAssemblyLease>,
  signal: AbortSignal | null
): Promise<BlobAssemblyLease> {
  if (signal === null) return captureRequiredLease(await pending);
  let remove = (): void => undefined;
  let selectedRaw: BlobAssemblyLease | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    const listener = (): void => { reject(abortError()); };
    let removed = false;
    remove = () => {
      if (removed) return;
      removed = true;
      try { signal.removeEventListener("abort", listener); } catch {}
    };
    try {
      signal.addEventListener("abort", listener, { once: true });
      if (signal.aborted) listener();
    } catch (error) {
      // A hostile signal may attach the listener and then throw. Retire that
      // partial registration before rejecting the admission race.
      remove();
      reject(error);
    }
  });
  try {
    const raw = await Promise.race([pending, aborted]);
    selectedRaw = raw;
    const lease = captureRequiredLease(raw);
    if (signal.aborted) {
      safelyRelease(lease);
      throw abortError();
    }
    return lease;
  } catch (error) {
    if (selectedRaw === null) {
      void pending.then(
        (late) => { bestEffortRelease(late); },
        () => undefined
      );
    }
    throw error;
  } finally {
    remove();
  }
}

function captureRequiredLease(value: BlobAssemblyLease): BlobAssemblyLease {
  const lease = captureLease(value);
  if (lease !== null) return lease;
  bestEffortRelease(value);
  throw new TypeError("blob assembly resource lease is malformed");
}

function bestEffortRelease(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  try {
    const release = Reflect.get(value, "release");
    if (typeof release === "function") Reflect.apply(release, value, []);
  } catch {
    // Preserve the selected admission or contract failure.
  }
}

function allocateAssemblyBytes(byteLength: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(byteLength));
}

function captureAssemblyAllocation(
  value: Uint8Array<ArrayBuffer>,
  expectedBytes: number
): Uint8Array<ArrayBuffer> {
  if (
    !(value instanceof Uint8Array) ||
    !(value.buffer instanceof ArrayBuffer) ||
    value.byteOffset !== 0 ||
    value.byteLength !== expectedBytes ||
    value.buffer.byteLength !== expectedBytes
  ) {
    throw new TypeError("blob assembly allocation does not match its lease");
  }
  return value;
}

function isAbortSignal(value: AbortSignal): boolean {
  try {
    return typeof value === "object" && value !== null &&
      typeof value.aborted === "boolean" &&
      typeof value.addEventListener === "function" &&
      typeof value.removeEventListener === "function";
  } catch {
    return false;
  }
}

function throwIfAborted(signal: AbortSignal | null): void {
  if (signal?.aborted === true) throw abortError();
}

function abortError(): DOMException {
  return new DOMException("blob assembly admission was aborted", "AbortError");
}

function validateBlob(blob: PlannedRuntimeBlob): void {
  if (typeof blob !== "object" || blob === null) {
    throw new TypeError("planned blob must be an object");
  }
  requireRange(blob.paddingRange, "padding");
  requireRange(blob.blobRange, "blob");
  requireRange(blob.storageRange, "storage");
  if (blob.blobRange.length === 0) {
    throw new RangeError("planned blob must contain bytes");
  }
  if (
    blob.paddingRange.offset !== blob.storageRange.offset ||
    rangeEnd(blob.paddingRange) !== blob.blobRange.offset ||
    blob.storageRange.length !== blob.paddingRange.length + blob.blobRange.length
  ) {
    throw new RangeError("planned blob storage geometry is inconsistent");
  }
}

function requireRange(range: Readonly<ByteRange>, label: string): void {
  if (typeof range !== "object" || range === null) {
    throw new TypeError(`${label} range must be an object`);
  }
  requireNonNegativeSafeInteger(range.offset, `${label} offset`);
  requireNonNegativeSafeInteger(range.length, `${label} length`);
  rangeEnd(range);
}

function captureLease(lease: BlobAssemblyLease | undefined): BlobAssemblyLease | null {
  if (lease === undefined) return null;
  if (typeof lease !== "object" || lease === null) return null;
  try {
    const release = lease.release;
    if (typeof release !== "function") return null;
    return Object.freeze({ release: () => release.call(lease) });
  } catch {
    return null;
  }
}

function safelyRelease(lease: BlobAssemblyLease | null): void {
  if (lease === null) return;
  try {
    lease.release();
  } catch {
    // Cleanup failures never prevent the remaining ownership transition.
  }
}

function requireNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${label} exceeds the safe-integer range`);
  }
  return result;
}

function rangeEnd(range: Readonly<ByteRange>): number {
  return checkedAdd(range.offset, range.length, "range end");
}
