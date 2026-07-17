import { describe, expect, it } from "vitest";

import {
  DecoderPool,
  type DecoderPoolRunIdentity
} from "../src/decoder-pool.js";
import type { DecoderLimits, DecodeSample } from "../src/decoder.js";
import {
  isDecoderCommand,
  type DecoderCommand,
  type DecoderWorkerEvent
} from "../src/decoder-protocol.js";

const CONFIG = Object.freeze({
  codec: "avc1.640020",
  codedWidth: 16,
  codedHeight: 16,
  displayAspectWidth: 2,
  displayAspectHeight: 2
});

describe("DecoderPool", () => {
  it("decodes a candidate while the foreground lane remains unsettled", async () => {
    const harness = fakeWorker();
    const pool = configuredPool(harness);
    await configure(pool, harness.workers);

    const foreground = pool.createForegroundRun(samples(2));
    const candidate = pool.createCandidateRun(samples(3));
    expect(foreground.generation).toBe(1);
    expect(candidate.generation).toBe(1);
    expect(pool.identity(foreground)).toEqual({ logicalId: 1, lane: 0 });
    expect(pool.identity(candidate)).toEqual({ logicalId: 2, lane: 1 });
    expect(Object.isFrozen(pool.identity(candidate))).toBe(true);

    start(harness.workers[0]!, foreground.generation);
    start(harness.workers[1]!, candidate.generation);
    harness.workers[1]!.emit({
      t: "frame",
      run: candidate.generation,
      timestamp: 0,
      frame: decodedFrame()
    });

    await candidate.ready(1);
    expect(harness.workers[0]!.posted).toContainEqual({
      t: "flush",
      run: foreground.generation
    });
    expect(pool.snapshot()).toEqual({
      workerCount: 2,
      openFrames: 1,
      openFrameBytes: 1_024
    });

    pool.dispose();
  });

  it("swaps lane roles on promotion and rejects stale promotion identities", async () => {
    const harness = fakeWorker();
    const pool = configuredPool(harness);
    await configure(pool, harness.workers);
    const foreground = pool.createForegroundRun(samples(1));
    const candidate = pool.createCandidateRun(samples(1));
    expect(pool.candidateAvailable).toBe(false);

    pool.promote(candidate);
    foreground.close();
    expect(pool.candidateAvailable).toBe(false);
    harness.workers[0]!.emit({ t: "closed", run: foreground.generation });
    expect(pool.candidateAvailable).toBe(true);
    const nextCandidate = pool.createCandidateRun(samples(1));

    expect(pool.identity(nextCandidate)).toEqual({ logicalId: 3, lane: 0 });
    expect(() => pool.promote(candidate)).toThrow(
      "decoder run is not owned by the candidate lane"
    );
    expect(() => pool.promote(foreground)).toThrow(
      "decoder run is not owned by the candidate lane"
    );

    pool.dispose();
  });

  it("admits only one live run for each decoder role", async () => {
    const harness = fakeWorker();
    const pool = configuredPool(harness);
    await configure(pool, harness.workers);
    const foreground = pool.createForegroundRun(samples(1));
    const candidate = pool.createCandidateRun(samples(1));

    expect(() => pool.createForegroundRun(samples(1))).toThrow(
      "decoder foreground lane already owns a run"
    );
    expect(() => pool.createCandidateRun(samples(1))).toThrow(
      "decoder candidate lane already owns a run"
    );

    candidate.close();
    expect(pool.candidateAvailable).toBe(false);
    harness.workers[1]!.emit({ t: "closed", run: candidate.generation });
    expect(pool.candidateAvailable).toBe(true);
    expect(() => pool.createCandidateRun(samples(1))).not.toThrow();
    foreground.close();
    harness.workers[0]!.emit({ t: "closed", run: foreground.generation });
    expect(() => pool.createForegroundRun(samples(1))).not.toThrow();
    pool.dispose();
  });

  it("reports exact aggregate frame and encoded-copy ownership", async () => {
    const harness = fakeWorker();
    const decodedBytes: number[] = [];
    const encodedBytes: number[] = [];
    const pool = configuredPool(harness, {
      onDecodedBytes: (bytes) => decodedBytes.push(bytes),
      onEncodedBytes: (bytes) => encodedBytes.push(bytes)
    });
    await configure(pool, harness.workers);
    const foreground = pool.createForegroundRun(samples(2));
    const candidate = pool.createCandidateRun(samples(3));

    expect(pool.encodedBytes).toBe(5);
    expect(encodedBytes).toEqual([2, 5]);
    start(harness.workers[0]!, foreground.generation);
    start(harness.workers[1]!, candidate.generation);
    harness.workers[0]!.emit({
      t: "frame",
      run: foreground.generation,
      timestamp: 0,
      frame: decodedFrame()
    });
    harness.workers[1]!.emit({
      t: "frame",
      run: candidate.generation,
      timestamp: 0,
      frame: decodedFrame()
    });

    expect(pool.snapshot()).toEqual({
      workerCount: 2,
      openFrames: 2,
      openFrameBytes: 2_048
    });
    expect(decodedBytes).toEqual([1_024, 2_048]);

    const taken = await foreground.take(0);
    foreground.release(taken);
    expect(pool.snapshot().openFrameBytes).toBe(1_024);
    expect(decodedBytes).toEqual([1_024, 2_048, 1_024]);

    pool.dispose();
    expect(pool.snapshot()).toEqual({
      workerCount: 0,
      openFrames: 0,
      openFrameBytes: 0
    });
    expect(pool.encodedBytes).toBe(0);
    expect(decodedBytes.at(-1)).toBe(0);
    expect(encodedBytes.at(-1)).toBe(0);
  });

  it("enforces one decoded-byte ceiling across both lanes", async () => {
    const harness = fakeWorker();
    const pool = configuredPool(harness, { maxDecodedBytes: 1_500 });
    await configure(pool, harness.workers);
    const foreground = pool.createForegroundRun(samples(1));
    const candidate = pool.createCandidateRun(samples(1));
    start(harness.workers[0]!, foreground.generation);
    start(harness.workers[1]!, candidate.generation);

    harness.workers[0]!.emit({
      t: "frame",
      run: foreground.generation,
      timestamp: 0,
      frame: decodedFrame()
    });
    harness.workers[1]!.emit({
      t: "frame",
      run: candidate.generation,
      timestamp: 0,
      frame: decodedFrame()
    });

    await expect(candidate.take(0)).rejects.toThrow(
      "AVAL decoded surfaces exceed their byte ceiling"
    );
    expect(pool.snapshot()).toEqual({
      workerCount: 1,
      openFrames: 1,
      openFrameBytes: 1_024
    });
    expect(harness.workers[0]!.terminated).toBe(false);
    expect(harness.workers[1]!.terminated).toBe(true);
    pool.dispose();
  });

  it("disposes both workers exactly once and preserves trace identities", async () => {
    const harness = fakeWorker();
    const pool = configuredPool(harness);
    await configure(pool, harness.workers);
    const run = pool.createForegroundRun(samples(1));
    const identity: DecoderPoolRunIdentity = pool.identity(run);

    pool.dispose();
    pool.dispose();

    expect(harness.workers.map((worker) => worker.terminateCalls)).toEqual([1, 1]);
    expect(pool.identity(run)).toBe(identity);
    expect(() => pool.createForegroundRun(samples(1))).toThrowError(
      expect.objectContaining({ name: "AbortError" })
    );
    expect(() => pool.promote(run)).toThrowError(
      expect.objectContaining({ name: "AbortError" })
    );
  });

  it("cleans up the first worker when the second worker cannot be created", () => {
    const harness = fakeWorker(1);

    expect(() => configuredPool(harness)).toThrow("worker construction failed");
    expect(harness.workers).toHaveLength(1);
    expect(harness.workers[0]!.terminateCalls).toBe(1);
  });
});

function configuredPool(
  harness: WorkerHarness,
  limits: Readonly<DecoderLimits> = {}
): DecoderPool {
  return new DecoderPool(CONFIG, undefined, {
    ...limits,
    Worker: harness.Worker,
    VideoFrame: FakeVideoFrame as unknown as typeof VideoFrame
  });
}

async function configure(
  pool: DecoderPool,
  workers: readonly FakeWorkerInstance[]
): Promise<void> {
  expect(workers).toHaveLength(2);
  for (const worker of workers) worker.emit({ t: "configured", supported: true });
  await expect(pool.supported()).resolves.toBe(true);
}

function start(worker: FakeWorkerInstance, run: number): void {
  worker.emit({ t: "started", run });
  worker.emit({ t: "accepted", run });
}

function samples(byteLength: number): readonly DecodeSample[] {
  return [{
    data: new Uint8Array(byteLength).buffer,
    timestamp: 0,
    duration: 1,
    key: true,
    displayedFrames: 1
  }];
}

function decodedFrame(): VideoFrame {
  return new FakeVideoFrame(16, 16) as unknown as VideoFrame;
}

interface FakeWorkerInstance {
  readonly posted: readonly DecoderCommand[];
  readonly terminated: boolean;
  readonly terminateCalls: number;
  emit(value: DecoderWorkerEvent): void;
}

interface WorkerHarness {
  readonly Worker: typeof Worker;
  readonly workers: FakeWorkerInstance[];
}

function fakeWorker(failAt?: number): WorkerHarness {
  type Listener = (event: MessageEvent<unknown>) => void;
  const workers: FakeWorkerInstance[] = [];
  class StubWorker {
    readonly #messages = new Set<Listener>();
    public readonly posted: DecoderCommand[] = [];
    public terminated = false;
    public terminateCalls = 0;

    public constructor() {
      if (workers.length === failAt) throw new Error("worker construction failed");
      workers.push(this as unknown as FakeWorkerInstance);
    }

    public addEventListener(type: string, listener: EventListener): void {
      if (type === "message") this.#messages.add(listener as Listener);
    }

    public postMessage(value: unknown): void {
      if (!isDecoderCommand(value)) throw new Error("invalid decoder command");
      this.posted.push(value);
    }

    public terminate(): void {
      this.terminateCalls += 1;
      this.terminated = true;
    }

    public emit(value: DecoderWorkerEvent): void {
      for (const listener of this.#messages) {
        listener({ data: value } as MessageEvent<unknown>);
      }
    }
  }
  return {
    Worker: StubWorker as unknown as typeof Worker,
    workers
  };
}

class FakeVideoFrame {
  public readonly duration = 1;
  public readonly displayWidth = 2;
  public readonly displayHeight = 2;
  public readonly visibleRect = { x: 0, y: 0, width: 2, height: 2 };
  public readonly colorSpace = Object.freeze({
    fullRange: false,
    matrix: "bt709" as const,
    primaries: "bt709" as const,
    transfer: "bt709" as const
  });
  public closed = false;

  public constructor(
    public readonly codedWidth: number,
    public readonly codedHeight: number,
    public readonly timestamp = 0
  ) {}

  public close(): void { this.closed = true; }
}
