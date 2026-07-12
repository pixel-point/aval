import {
  DECODER_WORKER_PROTOCOL_VERSION,
  DEFAULT_DECODER_WAIT_TIMEOUT_MS,
  type DecoderWorkerClientPort,
  type DecoderWorkerCommand,
  type DecoderWorkerEvent,
  type DecoderWorkerLimits,
  type DecoderWorkerMetrics,
  type DecoderWorkerRequestOperation,
  type DecoderWorkerSample
} from "./protocol.js";
import { isDecoderWorkerEvent } from "./protocol-validation.js";
import {
  DecoderWorkerGenerationAbortedError,
  DecoderWorkerRemoteError,
  DecoderWorkerTransportError,
  DecoderWorkerWatchdogError,
  ManagedDecoderWorkerFrameImpl,
  abortReason,
  assertSubmissionCredit,
  closeFrameFromMalformedEvent,
  collectUniqueSampleBuffers,
  createAbortError,
  normalizeTransportError,
  validateDisposeTimeout,
  validateRequestTimeout,
  validateWaitMinimum,
  validateWaitTimeout,
  type DecoderWorkerClientOptions,
  type DecoderWorkerConfigureOptions,
  type DecoderWorkerWaitOptions,
  type ManagedDecoderWorkerFrame
} from "./client-support.js";

export {
  DecoderWorkerGenerationAbortedError,
  DecoderWorkerRemoteError,
  DecoderWorkerTransportError,
  DecoderWorkerWatchdogError,
  type DecoderWorkerClientOptions,
  type DecoderWorkerConfigureOptions,
  type DecoderWorkerWaitOptions,
  type ManagedDecoderWorkerFrame
} from "./client-support.js";

const DEFAULT_DISPOSE_TIMEOUT_MS = 2_000;

interface PendingRequest {
  readonly operation: DecoderWorkerRequestOperation | "snapshot";
  readonly resolve: (event: DecoderWorkerEvent) => void;
  readonly reject: (reason: unknown) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface FrameWaiter {
  readonly generation: number;
  readonly minimum: number;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal | null;
  readonly abortListener: (() => void) | null;
  timeout: ReturnType<typeof setTimeout> | null;
}

/**
 * Main-thread owner for a dedicated decoder worker.
 *
 * VideoFrames are exposed only through managed handles. Closing a handle
 * returns its worker credit. Activating or aborting a generation closes every
 * still-owned frame from that generation before more work can consume credit.
 */
export class DecoderWorkerClient {
  readonly #port: DecoderWorkerClientPort;
  readonly #disposeTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #pendingRequests = new Map<number, PendingRequest>();
  readonly #readyFrames: ManagedDecoderWorkerFrameImpl[] = [];
  readonly #openFrames = new Map<number, ManagedDecoderWorkerFrameImpl>();
  readonly #waiters = new Set<FrameWaiter>();
  readonly #messageListener: (event: MessageEvent<unknown>) => void;
  readonly #messageErrorListener: (event: MessageEvent<unknown>) => void;
  readonly #errorListener: (event: ErrorEvent) => void;

  #nextRequestId = 1;
  #configured = false;
  #limits: DecoderWorkerLimits | null = null;
  #activeGeneration: number | null = null;
  #failure: Error | null = null;
  #disposing = false;
  #disposed = false;
  #disposeRequestId: number | null = null;
  #disposePromise: Promise<void> | null = null;
  #resolveDispose: (() => void) | null = null;
  #disposeTimer: ReturnType<typeof setTimeout> | null = null;
  #submissionTail: Promise<void> = Promise.resolve();

  public constructor(
    port: DecoderWorkerClientPort,
    options: DecoderWorkerClientOptions = {}
  ) {
    this.#port = port;
    this.#disposeTimeoutMs = validateDisposeTimeout(
      options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS
    );
    this.#requestTimeoutMs = validateRequestTimeout(
      options.requestTimeoutMs ?? DEFAULT_DECODER_WAIT_TIMEOUT_MS
    );
    this.#messageListener = (event) => {
      this.#handleMessage(event.data);
    };
    this.#errorListener = (event) => {
      this.#failTransport(
        new DecoderWorkerTransportError(
          event.message.length > 0
            ? `decoder worker failed: ${event.message}`
            : "decoder worker failed"
        )
      );
    };
    this.#messageErrorListener = () => {
      this.#failTransport(
        new DecoderWorkerTransportError(
          "decoder worker message could not be deserialized"
        )
      );
    };
    this.#port.addEventListener("message", this.#messageListener);
    this.#port.addEventListener("messageerror", this.#messageErrorListener);
    this.#port.addEventListener("error", this.#errorListener);
  }

  public get activeGeneration(): number | null {
    return this.#activeGeneration;
  }

  public get queuedFrames(): number {
    return this.#readyFrames.length;
  }

  public get openFrames(): number {
    return this.#openFrames.size;
  }

  public async configure(options: DecoderWorkerConfigureOptions): Promise<void> {
    this.#assertOperational();
    if (this.#configured) {
      throw new DecoderWorkerRemoteError(
        "ALREADY_CONFIGURED",
        "decoder worker client is already configured",
        false
      );
    }
    const event = await this.#request(
      {
        type: "configure",
        protocolVersion: DECODER_WORKER_PROTOCOL_VERSION,
        requestId: this.#allocateRequestId(),
        config: options.config,
        avcProfile: options.avcProfile,
        expectedOutput: options.expectedOutput,
        limits: options.limits
      },
      "configure"
    );
    if (event.type !== "ack" || event.operation !== "configure") {
      throw this.#unexpectedResponse("configure");
    }
    this.#configured = true;
    this.#limits = options.limits;
  }

  public async activateGeneration(generation: number): Promise<void> {
    this.#assertConfigured();
    await this.#submissionTail;
    this.#assertConfigured();
    const event = await this.#request(
      {
        type: "activate-generation",
        protocolVersion: DECODER_WORKER_PROTOCOL_VERSION,
        requestId: this.#allocateRequestId(),
        generation
      },
      "activate-generation"
    );
    if (event.type !== "ack" || event.operation !== "activate-generation") {
      throw this.#unexpectedResponse("activate-generation");
    }
    this.#activeGeneration = generation;
    this.#closeFramesExceptGeneration(generation);
    this.#rejectWaitersExceptGeneration(generation);
  }

  /** Posting the submission transfers every sample ArrayBuffer to the worker. */
  public async submit(
    generation: number,
    samples: readonly DecoderWorkerSample[]
  ): Promise<void> {
    this.#assertConfigured();
    if (generation !== this.#activeGeneration) {
      throw new DecoderWorkerGenerationAbortedError(generation);
    }
    const transfer = collectUniqueSampleBuffers(samples);
    const operation = this.#submissionTail.then(async () => {
      await this.#submitWithCredit(generation, samples, transfer);
    });
    this.#submissionTail = operation.catch(() => undefined);
    await operation;
  }

  async #submitWithCredit(
    generation: number,
    samples: readonly DecoderWorkerSample[],
    transfer: Transferable[]
  ): Promise<void> {
    this.#assertConfigured();
    if (generation !== this.#activeGeneration) {
      throw new DecoderWorkerGenerationAbortedError(generation);
    }
    const limits = this.#limits;
    if (limits === null) {
      throw new DecoderWorkerRemoteError(
        "NOT_CONFIGURED",
        "decoder worker limits are unavailable",
        false
      );
    }
    const metrics = await this.#requestSnapshot();
    this.#assertConfigured();
    if (generation !== this.#activeGeneration) {
      throw new DecoderWorkerGenerationAbortedError(generation);
    }
    assertSubmissionCredit(samples.length, limits, metrics);
    const event = await this.#request(
      {
        type: "submit",
        protocolVersion: DECODER_WORKER_PROTOCOL_VERSION,
        requestId: this.#allocateRequestId(),
        generation,
        samples
      },
      "submit",
      transfer
    );
    if (event.type !== "ack" || event.operation !== "submit") {
      throw this.#unexpectedResponse("submit");
    }
  }

  public async abortGeneration(generation: number): Promise<void> {
    this.#assertConfigured();
    await this.#submissionTail;
    this.#assertConfigured();
    const event = await this.#request(
      {
        type: "abort-generation",
        protocolVersion: DECODER_WORKER_PROTOCOL_VERSION,
        requestId: this.#allocateRequestId(),
        generation
      },
      "abort-generation"
    );
    if (event.type !== "ack" || event.operation !== "abort-generation") {
      throw this.#unexpectedResponse("abort-generation");
    }
    if (this.#activeGeneration === generation) {
      this.#activeGeneration = null;
    }
    this.#closeFramesForGeneration(generation);
    this.#rejectWaitersForGeneration(generation);
  }

  public takeFrame(): ManagedDecoderWorkerFrame | undefined {
    this.#assertOperational();
    const frame = this.#readyFrames.shift();
    if (frame === undefined) {
      return undefined;
    }
    if (frame.generation !== this.#activeGeneration) {
      frame.close();
      return undefined;
    }
    return frame;
  }

  public waitForFrames(
    minimum = 1,
    options: DecoderWorkerWaitOptions = {}
  ): Promise<void> {
    try {
      this.#assertConfigured();
      validateWaitMinimum(minimum, this.#limits);
      validateWaitTimeout(options.timeoutMs);
    } catch (error) {
      return Promise.reject(error);
    }
    const generation = this.#activeGeneration;
    if (generation === null) {
      return Promise.reject(
        new DecoderWorkerRemoteError(
          "GENERATION_MISMATCH",
          "no decoder generation is active",
          false
        )
      );
    }
    if (this.#readyFrames.length >= minimum) {
      return Promise.resolve();
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(abortReason(options.signal));
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_DECODER_WAIT_TIMEOUT_MS;

    return new Promise<void>((resolve, reject) => {
      const signal = options.signal ?? null;
      let waiter: FrameWaiter;
      const abortListener =
        signal === null
          ? null
          : () => {
              this.#finishWaiter(waiter, () => {
                reject(abortReason(signal));
              });
            };
      waiter = {
        generation,
        minimum,
        resolve,
        reject,
        signal,
        abortListener,
        timeout: null
      };
      waiter.timeout = setTimeout(() => {
        this.#finishWaiter(waiter, () => {
          reject(
            new DecoderWorkerWatchdogError(
              `no decoded-frame progress for ${String(
                timeoutMs
              )} ms in generation ${String(generation)}`
            )
          );
        });
      }, timeoutMs);
      if (signal !== null && abortListener !== null) {
        signal.addEventListener("abort", abortListener, { once: true });
      }
      this.#waiters.add(waiter);
      this.#settleWaiters();
    });
  }

  public async snapshotMetrics(): Promise<DecoderWorkerMetrics> {
    this.#assertOperational();
    return this.#requestSnapshot();
  }

  async #requestSnapshot(): Promise<DecoderWorkerMetrics> {
    const event = await this.#request(
      {
        type: "snapshot",
        protocolVersion: DECODER_WORKER_PROTOCOL_VERSION,
        requestId: this.#allocateRequestId()
      },
      "snapshot"
    );
    if (event.type !== "snapshot") {
      throw this.#unexpectedResponse("snapshot");
    }
    return Object.freeze({ ...event.metrics });
  }

  /**
   * Closes every managed frame, asks the worker to close its decoder, and then
   * terminates the owned worker. A bounded timeout still guarantees teardown.
   */
  public dispose(): Promise<void> {
    if (this.#disposePromise !== null) {
      return this.#disposePromise;
    }
    if (this.#disposed) {
      return Promise.resolve();
    }

    this.#disposing = true;
    const abortError = createAbortError("decoder worker client was disposed");
    this.#rejectAllRequests(abortError);
    this.#rejectAllWaiters(abortError);
    this.#closeAllFrames(true);

    const requestId = this.#allocateRequestId();
    this.#disposeRequestId = requestId;
    this.#disposePromise = new Promise<void>((resolve) => {
      this.#resolveDispose = resolve;
    });
    this.#disposeTimer = setTimeout(() => {
      this.#finishDispose();
    }, this.#disposeTimeoutMs);

    try {
      this.#port.postMessage({
        type: "dispose",
        protocolVersion: DECODER_WORKER_PROTOCOL_VERSION,
        requestId
      } satisfies DecoderWorkerCommand);
    } catch {
      this.#finishDispose();
    }
    return this.#disposePromise;
  }

  #request(
    command: Exclude<DecoderWorkerCommand, { readonly type: "release-frame" | "dispose" }>,
    operation: PendingRequest["operation"],
    transfer?: Transferable[]
  ): Promise<DecoderWorkerEvent> {
    this.#assertOperational();
    return new Promise<DecoderWorkerEvent>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.#pendingRequests.has(command.requestId)) return;
        this.#failTransport(
          new DecoderWorkerWatchdogError(
            `decoder worker did not answer ${operation} request ${String(
              command.requestId
            )} within ${String(this.#requestTimeoutMs)} ms`
          )
        );
      }, this.#requestTimeoutMs);
      this.#pendingRequests.set(command.requestId, {
        operation,
        resolve,
        reject,
        timeout
      });
      try {
        this.#port.postMessage(command, transfer);
      } catch (error) {
        const pending = this.#takePendingRequest(command.requestId);
        const failure = normalizeTransportError(error, "failed to post decoder command");
        (pending?.reject ?? reject)(failure);
        this.#failTransport(failure);
      }
    });
  }

  #handleMessage(value: unknown): void {
    if (!isDecoderWorkerEvent(value)) {
      closeFrameFromMalformedEvent(value);
      this.#failTransport(
        new DecoderWorkerTransportError("decoder worker sent a malformed event")
      );
      return;
    }
    if (value.type === "disposed") {
      if (this.#disposing && value.requestId === this.#disposeRequestId) {
        this.#finishDispose();
      } else if (this.#failure === null) {
        this.#failTransport(
          new DecoderWorkerTransportError(
            "decoder worker sent an unexpected disposed event"
          )
        );
      }
      return;
    }
    if (this.#failure !== null) {
      if (value.type === "frame") value.frame.close();
      return;
    }
    if (this.#disposing) {
      if (value.type === "frame") {
        value.frame.close();
      }
      return;
    }
    if (this.#disposed) {
      if (value.type === "frame") {
        value.frame.close();
      }
      return;
    }
    if (value.type === "frame") {
      this.#receiveFrame(value);
      return;
    }
    if (value.type === "error") {
      this.#receiveError(value);
      return;
    }

    const pending = this.#pendingRequests.get(value.requestId);
    if (pending === undefined) {
      this.#failTransport(
        new DecoderWorkerTransportError("decoder worker replied to an unknown request")
      );
      return;
    }
    const matches =
      (value.type === "ack" && value.operation === pending.operation) ||
      (value.type === "snapshot" && pending.operation === "snapshot");
    if (!matches) {
      this.#failTransport(this.#unexpectedResponse(pending.operation));
      return;
    }
    this.#takePendingRequest(value.requestId);
    pending.resolve(value);
  }

  #receiveFrame(
    event: Extract<DecoderWorkerEvent, { readonly type: "frame" }>
  ): void {
    if (this.#disposing || event.generation !== this.#activeGeneration) {
      event.frame.close();
      if (!this.#disposing) {
        this.#postRelease(event.frameId);
      }
      return;
    }
    if (this.#openFrames.has(event.frameId)) {
      event.frame.close();
      this.#failTransport(
        new DecoderWorkerTransportError("decoder worker reused a live frame id")
      );
      return;
    }

    const managed = new ManagedDecoderWorkerFrameImpl(event, () => {
      this.#openFrames.delete(event.frameId);
      this.#postRelease(event.frameId);
    });
    this.#openFrames.set(event.frameId, managed);
    this.#readyFrames.push(managed);
    this.#settleWaiters();
  }

  #receiveError(
    event: Extract<DecoderWorkerEvent, { readonly type: "error" }>
  ): void {
    const error = new DecoderWorkerRemoteError(
      event.code,
      event.message,
      event.fatal
    );
    if (event.requestId !== null) {
      const pending = this.#pendingRequests.get(event.requestId);
      if (pending === undefined) {
        this.#failTransport(
          event.fatal
            ? error
            : new DecoderWorkerTransportError(
                "decoder worker reported an error for an unknown request"
              )
        );
        return;
      }
      this.#takePendingRequest(event.requestId);
      pending.reject(error);
    }
    if (event.fatal) {
      this.#failTransport(error);
    } else if (event.requestId === null) {
      this.#failTransport(
        new DecoderWorkerTransportError(
          `unsolicited decoder worker error: ${event.message}`
        )
      );
    }
  }

  #postRelease(frameId: number): void {
    if (this.#disposed || this.#disposing || this.#failure !== null) {
      return;
    }
    try {
      this.#port.postMessage({
        type: "release-frame",
        protocolVersion: DECODER_WORKER_PROTOCOL_VERSION,
        frameId
      } satisfies DecoderWorkerCommand);
    } catch (error) {
      this.#failTransport(normalizeTransportError(error, "failed to release decoded frame"));
    }
  }

  #settleWaiters(): void {
    for (const waiter of [...this.#waiters]) {
      if (waiter.generation !== this.#activeGeneration) {
        this.#finishWaiter(waiter, () => {
          waiter.reject(new DecoderWorkerGenerationAbortedError(waiter.generation));
        });
      } else if (this.#readyFrames.length >= waiter.minimum) {
        this.#finishWaiter(waiter, waiter.resolve);
      }
    }
  }

  #finishWaiter(waiter: FrameWaiter, settle: () => void): void {
    if (!this.#waiters.delete(waiter)) {
      return;
    }
    if (waiter.timeout !== null) {
      clearTimeout(waiter.timeout);
      waiter.timeout = null;
    }
    if (waiter.signal !== null && waiter.abortListener !== null) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
    }
    settle();
  }

  #closeFramesExceptGeneration(generation: number): void {
    for (const frame of [...this.#openFrames.values()]) {
      if (frame.generation !== generation) {
        frame.close();
      }
    }
    this.#removeClosedReadyFrames();
  }

  #closeFramesForGeneration(generation: number): void {
    for (const frame of [...this.#openFrames.values()]) {
      if (frame.generation === generation) {
        frame.close();
      }
    }
    this.#removeClosedReadyFrames();
  }

  #closeAllFrames(release: boolean): void {
    for (const frame of [...this.#openFrames.values()]) {
      if (release) {
        frame.close();
      } else {
        frame.closeWithoutRelease();
      }
    }
    this.#openFrames.clear();
    this.#readyFrames.length = 0;
  }

  #removeClosedReadyFrames(): void {
    let write = 0;
    for (const frame of this.#readyFrames) {
      if (!frame.closed) {
        this.#readyFrames[write] = frame;
        write += 1;
      }
    }
    this.#readyFrames.length = write;
  }

  #rejectWaitersExceptGeneration(generation: number): void {
    for (const waiter of [...this.#waiters]) {
      if (waiter.generation !== generation) {
        this.#finishWaiter(waiter, () => {
          waiter.reject(new DecoderWorkerGenerationAbortedError(waiter.generation));
        });
      }
    }
  }

  #rejectWaitersForGeneration(generation: number): void {
    for (const waiter of [...this.#waiters]) {
      if (waiter.generation === generation) {
        this.#finishWaiter(waiter, () => {
          waiter.reject(new DecoderWorkerGenerationAbortedError(generation));
        });
      }
    }
  }

  #rejectAllWaiters(reason: unknown): void {
    for (const waiter of [...this.#waiters]) {
      this.#finishWaiter(waiter, () => {
        waiter.reject(reason);
      });
    }
  }

  #rejectAllRequests(reason: unknown): void {
    for (const pending of this.#pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(reason);
    }
    this.#pendingRequests.clear();
  }

  #failTransport(error: Error): void {
    if (this.#failure !== null || this.#disposed) {
      return;
    }
    this.#failure = error;
    this.#activeGeneration = null;
    this.#rejectAllRequests(error);
    this.#rejectAllWaiters(error);
    this.#closeAllFrames(false);
    this.#port.terminate?.();
    if (this.#disposing) this.#finishDispose();
  }

  #takePendingRequest(requestId: number): PendingRequest | undefined {
    const pending = this.#pendingRequests.get(requestId);
    if (pending === undefined) return undefined;
    this.#pendingRequests.delete(requestId);
    clearTimeout(pending.timeout);
    return pending;
  }

  #finishDispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#disposing = false;
    if (this.#disposeTimer !== null) {
      clearTimeout(this.#disposeTimer);
      this.#disposeTimer = null;
    }
    this.#port.removeEventListener("message", this.#messageListener);
    this.#port.removeEventListener("messageerror", this.#messageErrorListener);
    this.#port.removeEventListener("error", this.#errorListener);
    this.#port.terminate?.();
    const resolve = this.#resolveDispose;
    this.#resolveDispose = null;
    resolve?.();
  }

  #assertConfigured(): void {
    this.#assertOperational();
    if (!this.#configured) {
      throw new DecoderWorkerRemoteError(
        "NOT_CONFIGURED",
        "decoder worker client is not configured",
        false
      );
    }
  }

  #assertOperational(): void {
    if (this.#failure !== null) {
      throw this.#failure;
    }
    if (this.#disposed || this.#disposing) {
      throw createAbortError("decoder worker client is disposed");
    }
  }

  #allocateRequestId(): number {
    const requestId = this.#nextRequestId;
    if (!Number.isSafeInteger(requestId) || requestId <= 0) {
      throw new RangeError("decoder worker request id space was exhausted");
    }
    this.#nextRequestId += 1;
    return requestId;
  }

  #unexpectedResponse(operation: string): DecoderWorkerTransportError {
    return new DecoderWorkerTransportError(
      `decoder worker sent an unexpected ${operation} response`
    );
  }
}
