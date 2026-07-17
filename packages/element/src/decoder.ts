import {
  DECODER_RING_SIZE,
  isDecoderTerminalEvent,
  isDecoderWorkerEvent,
  type DecoderChunk,
  type DecoderCommand,
  type DecoderRunEvent
} from "./decoder-protocol.js";

export interface DecodeSample {
  readonly data: ArrayBuffer;
  readonly timestamp: number;
  readonly duration: number;
  readonly key: boolean;
  readonly displayedFrames: number;
}

export interface DecoderOutputExpectation {
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly visibleRect: Readonly<{
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }>;
  readonly colorSpace: Readonly<{
    readonly fullRange: boolean | null;
    readonly matrix: VideoMatrixCoefficients | null;
    readonly primaries: VideoColorPrimaries | null;
    readonly transfer: VideoTransferCharacteristics | null;
  }> | null;
}

export interface DecoderLimits {
  readonly maxDecodedBytes?: number;
  readonly onDecodedBytes?: (bytes: number) => void;
  readonly onEncodedBytes?: (bytes: number) => void;
  readonly Worker?: typeof globalThis.Worker;
  readonly VideoFrame?: typeof globalThis.VideoFrame;
  readonly setTimeout?: (callback: () => void, delay: number) => number;
  readonly clearTimeout?: (handle: number) => void;
}

const PROGRESS_MS = 2_000;
const MAX_BYTES = Number.MAX_SAFE_INTEGER;

type DecoderLane =
  | Readonly<{ phase: "idle"; generationFloor: number }>
  | Readonly<{ phase: "running"; run: DecodeRun }>
  | Readonly<{ phase: "closing"; run: DecodeRun }>
  | Readonly<{ phase: "terminal" }>;

export class Decoder {
  readonly #worker: Worker;
  readonly #runs = new Map<number, DecodeRun>();
  readonly #queue: DecodeRun[] = [];
  readonly #expectation: DecoderOutputExpectation;
  readonly #maxDecodedBytes: number;
  readonly #onDecodedBytes: ((bytes: number) => void) | undefined;
  readonly #onEncodedBytes: ((bytes: number) => void) | undefined;
  readonly #VideoFrame: typeof globalThis.VideoFrame;
  readonly #setTimeout: (callback: () => void, delay: number) => number;
  readonly #clearTimeout: (handle: number) => void;
  readonly #support = deferred<boolean>();
  #sequence = 0;
  #decodedBytes = 0;
  #encodedBytes = 0;
  #lane: DecoderLane = { phase: "idle", generationFloor: 0 };
  #configured = false;
  #disposed = false;
  #error: Error | undefined;

  public constructor(
    config: Readonly<VideoDecoderConfig>,
    expectation: Readonly<DecoderOutputExpectation> =
      defaultExpectation(config),
    limits: Readonly<DecoderLimits> = {}
  ) {
    this.#expectation = validateExpectation(expectation);
    this.#maxDecodedBytes = limits.maxDecodedBytes ?? MAX_BYTES;
    if (!Number.isSafeInteger(this.#maxDecodedBytes) || this.#maxDecodedBytes < 1) {
      throw new RangeError("decoder byte ceiling is invalid");
    }
    if (limits.onDecodedBytes !== undefined && typeof limits.onDecodedBytes !== "function") {
      throw new TypeError("decoded byte observer is invalid");
    }
    if (limits.onEncodedBytes !== undefined && typeof limits.onEncodedBytes !== "function") {
      throw new TypeError("encoded byte observer is invalid");
    }
    this.#onDecodedBytes = limits.onDecodedBytes;
    this.#onEncodedBytes = limits.onEncodedBytes;
    this.#setTimeout = limits.setTimeout ?? ((callback, delay) =>
      globalThis.setTimeout(callback, delay) as unknown as number);
    this.#clearTimeout = limits.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle));
    const WorkerConstructor = limits.Worker ?? globalThis.Worker;
    const VideoFrameConstructor = limits.VideoFrame ?? globalThis.VideoFrame;
    if (typeof WorkerConstructor !== "function" ||
      typeof VideoFrameConstructor !== "function") {
      throw new TypeError("decoder platform is unavailable");
    }
    this.#VideoFrame = VideoFrameConstructor;
    this.#worker = new WorkerConstructor(
      new URL("./decoder-worker.js?no-inline", import.meta.url),
      { type: "module", name: "aval-decoder" }
    );
    this.#worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      this.#receive(event.data);
    });
    this.#worker.addEventListener("error", () => this.#fail());
    this.#worker.addEventListener("messageerror", () => this.#fail());
    try {
      this.#post({ t: "configure", config: { ...config } });
    } catch {
      this.#fail();
    }
    void this.#support.promise.catch(() => undefined);
  }

  /** Probes the configuration in the same worker that will decode it. */
  public supported(): Promise<boolean> {
    return this.#support.promise;
  }

  public createRun(
    samples: readonly Readonly<DecodeSample>[],
    persistent = false
  ): DecodeRun {
    if (this.#disposed) throw abortError();
    if (this.#error !== undefined) throw this.#error;
    const id = ++this.#sequence;
    const run = new DecodeRun(
      id,
      samples,
      persistent,
      this.#expectation,
      (message, transfer) => {
        if (this.#disposed || this.#error !== undefined) throw abortError();
        this.#post(message, transfer);
      },
      () => this.#availableCredit(),
      () => this.#creditChanged(),
      (bytes) => this.#claimDecodedBytes(bytes),
      (bytes) => this.#releaseDecodedBytes(bytes),
      () => this.#closeRun(run),
      (error) => this.#fail(error),
      this.#setTimeout,
      this.#clearTimeout
    );
    const previousEncodedBytes = this.#encodedBytes;
    if (run.encodedBytes > MAX_BYTES - previousEncodedBytes) {
      throw new RangeError("decoder encoded copies exceed their byte ceiling");
    }
    this.#encodedBytes += run.encodedBytes;
    try { this.#onEncodedBytes?.(this.#encodedBytes); }
    catch (error) {
      this.#encodedBytes = previousEncodedBytes;
      throw error;
    }
    this.#runs.set(id, run);
    this.#queue.push(run);
    this.#schedule();
    return run;
  }

  public snapshot(): Readonly<{
    workerCount: number;
    openFrames: number;
    openFrameBytes: number;
  }> {
    let openFrames = 0;
    for (const run of this.#runs.values()) openFrames += run.openFrames;
    return Object.freeze({
      workerCount: this.#disposed || this.#error !== undefined ? 0 : 1,
      openFrames,
      openFrameBytes: this.#decodedBytes
    });
  }

  public get encodedBytes(): number { return this.#encodedBytes; }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lane = { phase: "terminal" };
    for (const run of [...this.#runs.values()]) run.close();
    try { this.#post({ t: "dispose" }); } catch { /* terminal */ }
    this.#worker.terminate();
    for (const run of [...this.#runs.values()]) this.#deleteRun(run);
    this.#queue.length = 0;
    this.#support.reject(abortError());
  }

  #receive(value: unknown): void {
    if (this.#disposed || this.#lane.phase === "terminal") {
      closeTransferredFrame(value, this.#VideoFrame);
      return;
    }
    if (!isDecoderWorkerEvent(value, this.#VideoFrame)) {
      closeTransferredFrame(value, this.#VideoFrame);
      this.#fail();
      return;
    }
    if (value.t === "configured") {
      if (this.#configured) {
        this.#fail();
        return;
      }
      this.#configured = value.supported;
      this.#support.resolve(value.supported);
      if (!value.supported) {
        this.#fail(new Error("AVAL decoder configuration is unsupported"));
        return;
      }
      this.#schedule();
      return;
    }
    if (value.t === "error") {
      this.#fail();
      return;
    }
    this.#receiveRun(value);
  }

  #receiveRun(event: DecoderRunEvent): void {
    const lane = this.#lane;
    if (lane.phase === "terminal") {
      if (event.t === "frame") event.frame.close();
      return;
    }
    if (lane.phase === "idle") {
      if (event.run <= lane.generationFloor) this.#receiveStale(event);
      else this.#rejectRunEvent(event);
      return;
    }
    const generation = lane.run.generation;
    if (event.run < generation) {
      this.#receiveStale(event);
      return;
    }
    if (event.run > generation) {
      this.#rejectRunEvent(event);
      return;
    }
    if (lane.phase === "closing") {
      if (event.t === "frame") {
        event.frame.close();
        return;
      }
      if (isDecoderTerminalEvent(event)) {
        this.#settleActive(lane.run, true);
      }
      // Start and acceptance may already be in flight when local close wins.
      return;
    }
    if (event.t === "closed") {
      this.#fail();
      return;
    }
    try {
      lane.run.receive(event);
    } catch (error) {
      if (event.t === "frame") event.frame.close();
      this.#fail(error instanceof Error ? error : undefined);
      return;
    }
    if (event.t === "flushed") this.#settleActive(lane.run, false);
  }

  #receiveStale(event: DecoderRunEvent): void {
    if (isDecoderTerminalEvent(event)) return;
    if (event.t === "frame") event.frame.close();
    this.#fail();
  }

  #rejectRunEvent(event: DecoderRunEvent): void {
    if (event.t === "frame") event.frame.close();
    this.#fail();
  }

  #settleActive(run: DecodeRun, deleteRun: boolean): void {
    this.#lane = {
      phase: "idle",
      generationFloor: run.generation
    };
    if (deleteRun) this.#deleteRun(run);
    this.#schedule();
  }

  #schedule(): void {
    if (
      !this.#configured ||
      this.#disposed ||
      this.#error !== undefined ||
      this.#lane.phase !== "idle"
    ) return;
    const generationFloor = this.#lane.generationFloor;
    let run: DecodeRun | undefined;
    while ((run = this.#queue.shift()) !== undefined && run.closed) {
      this.#deleteRun(run);
    }
    if (run === undefined) return;
    if (run.generation <= generationFloor) {
      this.#fail();
      return;
    }
    this.#lane = { phase: "running", run };
    run.activate();
    try {
      this.#post({ t: "start", run: run.generation });
    } catch {
      this.#fail();
    }
  }

  #closeRun(run: DecodeRun): void {
    const index = this.#queue.indexOf(run);
    if (index >= 0) this.#queue.splice(index, 1);
    if (
      this.#disposed ||
      this.#error !== undefined ||
      this.#lane.phase === "terminal"
    ) {
      this.#deleteRun(run);
      return;
    }
    if (this.#lane.phase === "closing" && this.#lane.run === run) return;
    if (this.#lane.phase !== "running" || this.#lane.run !== run) {
      this.#deleteRun(run);
      return;
    }
    this.#lane = { phase: "closing", run };
    try {
      this.#post({ t: "close", run: run.generation });
    } catch {
      this.#fail();
    }
  }

  #availableCredit(): number {
    let outstanding = 0;
    for (const run of this.#runs.values()) outstanding += run.outstanding;
    return Math.max(0, DECODER_RING_SIZE - outstanding);
  }

  #creditChanged(): void {
    if (this.#lane.phase === "running") this.#lane.run.pump();
  }

  #post(message: DecoderCommand, transfer?: Transferable[]): void {
    if (transfer === undefined) this.#worker.postMessage(message);
    else this.#worker.postMessage(message, transfer);
  }

  #claimDecodedBytes(bytes: number): void {
    if (bytes > this.#maxDecodedBytes - this.#decodedBytes) {
      throw new RangeError("AVAL decoded surfaces exceed their byte ceiling");
    }
    const previous = this.#decodedBytes;
    this.#decodedBytes += bytes;
    try {
      this.#onDecodedBytes?.(this.#decodedBytes);
    } catch (error) {
      this.#decodedBytes = previous;
      throw error;
    }
  }

  #releaseDecodedBytes(bytes: number): void {
    if (bytes > this.#decodedBytes) {
      this.#fail(new Error("AVAL decoded surface accounting failed"));
      return;
    }
    this.#decodedBytes -= bytes;
    try {
      this.#onDecodedBytes?.(this.#decodedBytes);
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error("decoded byte observer failed"));
    }
  }

  #deleteRun(run: DecodeRun): void {
    if (!this.#runs.delete(run.generation)) return;
    this.#encodedBytes -= run.encodedBytes;
    try { this.#onEncodedBytes?.(this.#encodedBytes); }
    catch (error) {
      this.#fail(error instanceof Error ? error : new Error("encoded byte observer failed"));
    }
  }

  #fail(error = new Error("AVAL decoder failed")): void {
    if (this.#disposed || this.#error !== undefined) return;
    this.#error = error;
    this.#support.reject(error);
    for (const run of [...this.#runs.values()]) run.fail(error);
    for (const run of [...this.#runs.values()]) this.#deleteRun(run);
    this.#queue.length = 0;
    this.#lane = { phase: "terminal" };
    this.#worker.terminate();
  }
}

export class DecodeRun {
  readonly #id: number;
  readonly #samples: readonly Readonly<DecodeSample>[];
  readonly #expectation: DecoderOutputExpectation;
  readonly #post: (message: DecoderCommand, transfer?: Transferable[]) => void;
  readonly #credit: () => number;
  readonly #creditChanged: () => void;
  readonly #claimBytes: (bytes: number) => void;
  readonly #releaseBytes: (bytes: number) => void;
  readonly #retire: () => void;
  readonly #fatal: (error?: Error) => void;
  readonly #setTimeout: (callback: () => void, delay: number) => number;
  readonly #clearTimeout: (handle: number) => void;
  readonly #frames = new Map<number, VideoFrame>();
  readonly #leased = new Map<VideoFrame, number>();
  readonly #frameBytes = new Map<VideoFrame, number>();
  readonly #owned = new WeakSet<VideoFrame>();
  readonly #outputs = new Map<number, Readonly<{
    index: number;
    sample: number;
    duration: number;
  }>>();
  readonly #seen = new Set<number>();
  readonly #taken = new Set<number>();
  readonly #waiters = new Set<() => void>();
  #nextSample = 0;
  #received = 0;
  #outstanding = 0;
  #openBytes = 0;
  #activated = false;
  #started = false;
  #batchInFlight = false;
  #flushSent = false;
  #flushed = false;
  #closed = false;
  #error: Error | undefined;
  #progressTimer: number | undefined;

  public readonly frameCount: number;
  public readonly encodedBytes: number;

  public constructor(
    id: number,
    samples: readonly Readonly<DecodeSample>[],
    persistent: boolean,
    expectation: Readonly<DecoderOutputExpectation>,
    post: (message: DecoderCommand, transfer?: Transferable[]) => void,
    credit: () => number,
    creditChanged: () => void,
    claimBytes: (bytes: number) => void,
    releaseBytes: (bytes: number) => void,
    retire: () => void,
    fatal: (error?: Error) => void,
    setTimeout: (callback: () => void, delay: number) => number,
    clearTimeout: (handle: number) => void
  ) {
    if (!Number.isSafeInteger(id) || id < 1) throw new RangeError("invalid decoder run");
    this.#id = id;
    this.#samples = Object.freeze(samples.map((sample) => Object.freeze({ ...sample })));
    // Kept in the call shape for compatibility. Persistent pixels live in the
    // renderer's resident textures; decoded frames remain single-consumption.
    void persistent;
    this.#expectation = expectation;
    this.#post = post;
    this.#credit = credit;
    this.#creditChanged = creditChanged;
    this.#claimBytes = claimBytes;
    this.#releaseBytes = releaseBytes;
    this.#retire = retire;
    this.#fatal = fatal;
    this.#setTimeout = setTimeout;
    this.#clearTimeout = clearTimeout;
    const outputs: Array<{ timestamp: number; sample: number; duration: number }> = [];
    const buffers = new Set<ArrayBuffer>();
    let encodedBytes = 0;
    if (this.#samples.length > 0 && !this.#samples[0]!.key) {
      throw new RangeError("decoder run must begin with a key chunk");
    }
    for (let sampleIndex = 0; sampleIndex < this.#samples.length; sampleIndex += 1) {
      const sample = this.#samples[sampleIndex]!;
      validateSample(sample, buffers);
      if (sample.data.byteLength > MAX_BYTES - encodedBytes) {
        throw new RangeError("decoder encoded copies exceed their byte ceiling");
      }
      encodedBytes += sample.data.byteLength;
      for (let order = 0; order < sample.displayedFrames; order += 1) {
        const timestamp = sample.timestamp + sample.duration * order;
        if (!Number.isSafeInteger(timestamp)) throw new RangeError("unsafe frame timestamp");
        outputs.push({ timestamp, sample: sampleIndex, duration: sample.duration });
      }
    }
    outputs.sort((left, right) => left.timestamp - right.timestamp);
    for (let index = 0; index < outputs.length; index += 1) {
      const output = outputs[index]!;
      if (this.#outputs.has(output.timestamp)) {
        throw new RangeError("duplicate frame timestamp");
      }
      this.#outputs.set(output.timestamp, Object.freeze({
        index,
        sample: output.sample,
        duration: output.duration
      }));
    }
    this.encodedBytes = encodedBytes;
    this.frameCount = outputs.length;
  }

  public get generation(): number { return this.#id; }
  public get openFrames(): number { return this.#frames.size + this.#leased.size; }
  public get outstanding(): number { return this.#outstanding; }
  public get closed(): boolean { return this.#closed; }

  public activate(): void {
    if (this.#activated || this.#closed) return;
    this.#activated = true;
    this.#updateProgressWatchdog(true);
  }

  public receive(event: DecoderRunEvent): void {
    if (this.#closed) {
      if (event.t === "frame") event.frame.close();
      return;
    }
    if (event.t === "started") {
      if (this.#started) throw new Error("duplicate decoder start");
      this.#started = true;
      this.pump();
      this.#updateProgressWatchdog(true);
      return;
    }
    if (event.t === "accepted") {
      if (!this.#batchInFlight) throw new Error("unexpected decoder acceptance");
      this.#batchInFlight = false;
      this.pump();
      this.#updateProgressWatchdog(true);
      return;
    }
    if (event.t === "flushed") {
      if (
        !this.#flushSent ||
        this.#batchInFlight ||
        this.#nextSample !== this.#samples.length ||
        this.#received !== this.frameCount
      ) throw new Error("AVAL decoder output is incomplete");
      this.#flushed = true;
      this.#clearProgressWatchdog();
      this.#wake();
      return;
    }
    if (event.t === "closed") {
      this.#clearProgressWatchdog();
      return;
    }
    const expected = this.#outputs.get(event.timestamp);
    if (
      expected === undefined ||
      expected.sample >= this.#nextSample ||
      this.#outstanding < 1 ||
      this.#seen.has(event.timestamp)
    ) {
      throw new Error("AVAL decoder returned an unknown frame");
    }
    const frameBytes = validateFrame(
      event.frame,
      event.timestamp,
      expected.duration,
      this.#expectation
    );
    if (this.#frames.has(expected.index)) throw new Error("duplicate decoded frame");
    this.#claimBytes(frameBytes);
    try {
      this.#seen.add(event.timestamp);
      this.#frames.set(expected.index, event.frame);
      this.#frameBytes.set(event.frame, frameBytes);
      this.#openBytes += frameBytes;
      this.#received += 1;
    } catch (error) {
      this.#seen.delete(event.timestamp);
      this.#frames.delete(expected.index);
      this.#frameBytes.delete(event.frame);
      this.#releaseBytes(frameBytes);
      throw error;
    }
    this.#updateProgressWatchdog(true);
    this.#wake();
  }

  public async ready(minimum = Math.min(6, this.frameCount)): Promise<void> {
    const target = Math.max(0, Math.min(minimum, this.frameCount));
    await this.#wait(() => {
      for (let index = 0; index < target; index += 1) {
        if (!this.#frames.has(index) && !this.#taken.has(index)) return false;
      }
      return true;
    });
  }

  public async take(index: number): Promise<VideoFrame> {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.frameCount) {
      throw new RangeError("decoded frame index is out of range");
    }
    if (this.#taken.has(index)) throw new Error("decoded frame was already taken");
    await this.#wait(() => this.#frames.has(index));
    if (this.#taken.has(index)) throw new Error("decoded frame was already taken");
    const frame = this.#frames.get(index);
    if (frame === undefined) throw abortError();
    this.#taken.add(index);
    this.#frames.delete(index);
    this.#leased.set(frame, index);
    this.#owned.add(frame);
    return frame;
  }

  /** Closes a taken frame and returns its decoder-surface credit. */
  public release(frame: VideoFrame): void {
    if (!this.#owned.has(frame)) throw new Error("decoded frame is not owned by this run");
    if (!this.#leased.has(frame)) return;
    const frameBytes = this.#frameBytes.get(frame);
    if (frameBytes === undefined) throw new Error("decoded frame bytes are unavailable");
    this.#leased.delete(frame);
    this.#frameBytes.delete(frame);
    try {
      frame.close();
    } finally {
      this.#outstanding -= 1;
      this.#openBytes -= frameBytes;
      this.#releaseBytes(frameBytes);
      this.#creditChanged();
    }
  }

  public async complete(): Promise<void> {
    await this.#wait(() => this.#flushed);
  }

  public fail(error = new Error("AVAL decoder failed")): void {
    if (this.#closed) return;
    this.#error = error;
    this.#closed = true;
    this.#clearProgressWatchdog();
    this.#releaseFrames();
    this.#wake();
    this.#retire();
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = abortError();
    this.#clearProgressWatchdog();
    this.#releaseFrames();
    this.#wake();
    this.#retire();
  }

  public pump(): void {
    if (!this.#started || this.#closed || this.#batchInFlight || this.#flushSent) {
      this.#updateProgressWatchdog(false);
      return;
    }
    const chunks: DecoderChunk[] = [];
    const transfer: Transferable[] = [];
    let reserved = 0;
    const available = this.#credit();
    while (
      this.#nextSample < this.#samples.length &&
      chunks.length < DECODER_RING_SIZE
    ) {
      const sample = this.#samples[this.#nextSample]!;
      if (sample.displayedFrames > available - reserved) break;
      this.#nextSample += 1;
      reserved += sample.displayedFrames;
      chunks.push({
        data: sample.data,
        timestamp: sample.timestamp,
        duration: sample.duration,
        key: sample.key
      });
      transfer.push(sample.data);
    }
    if (chunks.length > 0) {
      this.#outstanding += reserved;
      this.#batchInFlight = true;
      try {
        this.#post({ t: "decode", run: this.#id, chunks }, transfer);
      } catch {
        this.#batchInFlight = false;
        this.#outstanding -= reserved;
        this.#fatal();
      }
      this.#updateProgressWatchdog(true);
      return;
    }
    if (this.#nextSample === this.#samples.length) {
      this.#flushSent = true;
      try {
        this.#post({ t: "flush", run: this.#id });
      } catch {
        this.#fatal();
      }
      this.#updateProgressWatchdog(true);
      return;
    }
    this.#updateProgressWatchdog(false);
  }

  async #wait(predicate: () => boolean): Promise<void> {
    while (!predicate()) {
      if (this.#error !== undefined) throw this.#error;
      await new Promise<void>((resolve) => {
        this.#waiters.add(resolve);
        this.#updateProgressWatchdog(true);
      });
      if (this.#error !== undefined) throw this.#error;
    }
    this.#updateProgressWatchdog(false);
  }

  #releaseFrames(): void {
    for (const frame of this.#frames.values()) frame.close();
    for (const frame of this.#leased.keys()) frame.close();
    this.#frames.clear();
    this.#leased.clear();
    this.#frameBytes.clear();
    const openBytes = this.#openBytes;
    this.#openBytes = 0;
    this.#outstanding = 0;
    if (openBytes > 0) this.#releaseBytes(openBytes);
    this.#creditChanged();
  }

  #updateProgressWatchdog(refresh: boolean): void {
    // A ready prefetched run may intentionally park reordered frames until it
    // becomes visible. Only a caller awaiting progress owns a timeout.
    const waiting = this.#waiters.size > 0 &&
      this.#activated && !this.#closed && !this.#flushed && (
      !this.#started ||
      this.#batchInFlight ||
      this.#flushSent ||
      this.#outstanding > this.openFrames
    );
    if (!waiting) {
      this.#clearProgressWatchdog();
      return;
    }
    if (!refresh && this.#progressTimer !== undefined) return;
    this.#clearProgressWatchdog();
    this.#progressTimer = this.#setTimeout(() => {
      this.#progressTimer = undefined;
      this.#fatal(decodeTimeout());
    }, PROGRESS_MS);
  }

  #clearProgressWatchdog(): void {
    if (this.#progressTimer !== undefined) this.#clearTimeout(this.#progressTimer);
    this.#progressTimer = undefined;
  }

  #wake(): void {
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
  }
}

function validateSample(sample: Readonly<DecodeSample>, buffers: Set<ArrayBuffer>): void {
  if (
    !(sample.data instanceof ArrayBuffer) ||
    sample.data.byteLength < 1 ||
    buffers.has(sample.data) ||
    !Number.isSafeInteger(sample.timestamp) ||
    sample.timestamp < 0 ||
    !Number.isSafeInteger(sample.duration) ||
    sample.duration < 0 ||
    !Number.isSafeInteger(sample.displayedFrames) ||
    sample.displayedFrames < 0 ||
    sample.displayedFrames > DECODER_RING_SIZE ||
    sample.displayedFrames > 0 && sample.duration === 0 ||
    typeof sample.key !== "boolean"
  ) throw new RangeError("invalid decoder sample");
  buffers.add(sample.data);
}

function validateFrame(
  frame: VideoFrame,
  timestamp: number,
  duration: number,
  expected: Readonly<DecoderOutputExpectation>
): number {
  const rect = frame.visibleRect;
  if (
    frame.timestamp !== timestamp ||
    frame.duration !== duration ||
    rect === null ||
    !Number.isSafeInteger(frame.codedWidth) ||
    frame.codedWidth < 1 ||
    !Number.isSafeInteger(frame.codedHeight) ||
    frame.codedHeight < 1 ||
    frame.displayWidth !== expected.displayWidth ||
    frame.displayHeight !== expected.displayHeight ||
    !Number.isSafeInteger(rect.x) ||
    rect.x < 0 ||
    !Number.isSafeInteger(rect.y) ||
    rect.y < 0 ||
    rect.width !== expected.visibleRect.width ||
    rect.height !== expected.visibleRect.height ||
    rect.x > frame.codedWidth - rect.width ||
    rect.y > frame.codedHeight - rect.height ||
    !matchesColor(frame.colorSpace, expected.colorSpace)
  ) throw new Error("AVAL decoder returned an invalid frame");
  return decodedFrameBytes(frame.codedWidth, frame.codedHeight);
}

function decodedFrameBytes(width: number, height: number): number {
  if (width > Math.floor(MAX_BYTES / height)) {
    throw new Error("AVAL decoder returned an unsafe coded allocation");
  }
  const pixels = width * height;
  if (pixels > Math.floor(MAX_BYTES / 4)) {
    throw new Error("AVAL decoder returned an unsafe coded allocation");
  }
  return pixels * 4;
}

function matchesColor(
  actual: VideoColorSpace,
  expected: DecoderOutputExpectation["colorSpace"]
): boolean {
  const compatible = actual.fullRange !== true &&
    (actual.matrix === null || actual.matrix === "bt709") &&
    (actual.primaries === null || actual.primaries === "bt709") &&
    (actual.transfer === null || actual.transfer === "bt709");
  const browserNormalized =
    (actual.fullRange === false || actual.fullRange === true) &&
    actual.matrix === "bt709" &&
    actual.primaries === "bt709" &&
    actual.transfer === "iec61966-2-1";
  if (expected === null) return compatible || browserNormalized;
  if (browserNormalized) return expected.fullRange === false &&
    expected.matrix === "bt709" &&
    expected.primaries === "bt709" &&
    expected.transfer === "bt709";
  return compatible &&
    actual.fullRange === expected.fullRange &&
    actual.matrix === expected.matrix &&
    actual.primaries === expected.primaries &&
    actual.transfer === expected.transfer;
}

function defaultExpectation(
  config: Readonly<VideoDecoderConfig>
): DecoderOutputExpectation {
  const codedWidth = config.codedWidth;
  const codedHeight = config.codedHeight;
  if (
    codedWidth === undefined ||
    codedHeight === undefined ||
    !positive(codedWidth) ||
    !positive(codedHeight)
  ) {
    throw new RangeError("decoder configuration requires coded dimensions");
  }
  const displayWidth = config.displayAspectWidth ?? codedWidth;
  const displayHeight = config.displayAspectHeight ?? codedHeight;
  const color = config.colorSpace;
  return {
    codedWidth,
    codedHeight,
    displayWidth,
    displayHeight,
    visibleRect: { x: 0, y: 0, width: displayWidth, height: displayHeight },
    colorSpace: color === undefined ? null : {
      fullRange: color.fullRange ?? null,
      matrix: color.matrix ?? null,
      primaries: color.primaries ?? null,
      transfer: color.transfer ?? null
    }
  };
}

function validateExpectation(
  value: Readonly<DecoderOutputExpectation>
): DecoderOutputExpectation {
  const rect = value.visibleRect;
  if (
    !positive(value.codedWidth) ||
    !positive(value.codedHeight) ||
    !positive(value.displayWidth) ||
    !positive(value.displayHeight) ||
    !Number.isSafeInteger(rect.x) ||
    rect.x < 0 ||
    !Number.isSafeInteger(rect.y) ||
    rect.y < 0 ||
    !positive(rect.width) ||
    !positive(rect.height) ||
    rect.x > value.codedWidth - rect.width ||
    rect.y > value.codedHeight - rect.height
  ) throw new RangeError("invalid decoder output expectation");
  return Object.freeze({
    codedWidth: value.codedWidth,
    codedHeight: value.codedHeight,
    displayWidth: value.displayWidth,
    displayHeight: value.displayHeight,
    visibleRect: Object.freeze({ ...rect }),
    colorSpace: value.colorSpace === null ? null : Object.freeze({ ...value.colorSpace })
  });
}

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function closeTransferredFrame(
  value: unknown,
  VideoFrameConstructor: typeof globalThis.VideoFrame
): void {
  if (
    typeof value === "object" &&
    value !== null &&
    "frame" in value &&
    value.frame instanceof VideoFrameConstructor
  ) value.frame.close();
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function abortError(): Error {
  return new DOMException("AVAL decoder operation was aborted", "AbortError");
}

function decodeTimeout(): Error {
  return new DOMException("AVAL decoder made no progress", "TimeoutError");
}
