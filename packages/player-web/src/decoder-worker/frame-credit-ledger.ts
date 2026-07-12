import { DecoderWorkerCoreError } from "./core-validation.js";

interface FrameLease {
  readonly generation: number;
  readonly decodedBytes: number;
}

/** Accounts transferred VideoFrames until the main-thread owner releases them. */
export class FrameCreditLedger {
  readonly #leases = new Map<number, FrameLease>();
  #nextFrameId = 1;
  #decodedBytes = 0;

  public get count(): number {
    return this.#leases.size;
  }

  public get decodedBytes(): number {
    return this.#decodedBytes;
  }

  public hasSubmissionCredit(
    submittedFrames: number,
    maximumOutstandingFrames: number
  ): boolean {
    return submittedFrames + this.#leases.size < maximumOutstandingFrames;
  }

  public lease(
    generation: number,
    decodedBytes: number,
    maximumDecodedBytes: number
  ): number {
    if (this.#decodedBytes + decodedBytes > maximumDecodedBytes) {
      throw new DecoderWorkerCoreError(
        "DECODED_BYTE_BUDGET_EXCEEDED",
        "decoded output exceeds the worker frame-byte budget",
        true
      );
    }
    const frameId = this.#nextFrameId;
    if (!Number.isSafeInteger(frameId)) {
      throw new DecoderWorkerCoreError(
        "DECODER_OUTPUT_INVALID",
        "decoder frame id space was exhausted",
        true
      );
    }
    this.#nextFrameId += 1;
    this.#leases.set(frameId, { generation, decodedBytes });
    this.#decodedBytes += decodedBytes;
    return frameId;
  }

  public release(frameId: number): void {
    const lease = this.#requireLease(frameId);
    this.#leases.delete(frameId);
    this.#decodedBytes -= lease.decodedBytes;
  }

  /** Rolls back a transfer that failed before ownership changed. */
  public revoke(frameId: number): void {
    this.release(frameId);
  }

  public clear(): void {
    this.#leases.clear();
    this.#decodedBytes = 0;
  }

  #requireLease(frameId: number): FrameLease {
    if (!Number.isSafeInteger(frameId) || frameId <= 0) {
      throw new DecoderWorkerCoreError(
        "FRAME_RELEASE_INVALID",
        "released frame id must be a positive safe integer",
        true
      );
    }
    const lease = this.#leases.get(frameId);
    if (lease === undefined) {
      throw new DecoderWorkerCoreError(
        "FRAME_RELEASE_INVALID",
        "released frame id is not owned by this decoder worker",
        true
      );
    }
    return lease;
  }
}
