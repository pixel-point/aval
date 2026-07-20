import { describe, expect, it } from "vitest";

import {
  DecoderPool,
  type DecoderPoolDiagnostic,
  type DecoderPoolRunIdentity
} from "../src/decoder-pool.js";
import {
  createDecoderFailureDiagnostic,
  type DecoderFailureDiagnostic
} from "../src/decoder-diagnostics.js";
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
    const candidate = pool.createCandidate("candidate", samples(3));
    const candidateRun = candidate.run;
    expect(foreground.generation).toBe(1);
    expect(candidateRun.generation).toBe(1);
    expect(pool.identity(foreground)).toEqual({ logicalId: 1, lane: 0 });
    expect(pool.identity(candidateRun)).toEqual({ logicalId: 2, lane: 1 });
    expect(Object.isFrozen(pool.identity(candidateRun))).toBe(true);

    start(harness.workers[0]!, foreground.generation);
    start(harness.workers[1]!, candidateRun.generation);
    harness.workers[1]!.emit({
      t: "frame",
      run: candidateRun.generation,
      timestamp: 0,
      frame: decodedFrame()
    });

    await candidateRun.ready(1);
    expect(harness.workers[0]!.posted).toContainEqual({
      t: "flush",
      run: foreground.generation
    });
    expect(pool.snapshot()).toMatchObject({
      workerCount: 2,
      openFrames: 1,
      openFrameBytes: 1_024,
      decoderDiagnostics: []
    });

    pool.dispose();
  });

  it("commits atomically, retires foreground, and makes terminal calls idempotent", async () => {
    const harness = fakeWorker();
    const pool = configuredPool(harness);
    await configure(pool, harness.workers);
    const foreground = pool.createForegroundRun(samples(1));
    const candidate = pool.createCandidate("candidate", frameSamples(6));
    expect(candidate.unitId).toBe("candidate");
    expect(pool.candidateAvailable).toBe(false);

    const readiness = candidate.ready();
    start(harness.workers[1]!, candidate.run.generation);
    for (let timestamp = 0; timestamp < 5; timestamp += 1) {
      harness.workers[1]!.emit({
        t: "frame",
        run: candidate.run.generation,
        timestamp,
        frame: decodedFrame(timestamp)
      });
    }
    expect(() => candidate.commit()).toThrow("decoder candidate is not ready");
    expect(foreground.closed).toBe(false);
    harness.workers[1]!.emit({
      t: "frame",
      run: candidate.run.generation,
      timestamp: 5,
      frame: decodedFrame(5)
    });
    await readiness;
    candidate.commit();
    candidate.commit();
    candidate.cancel();
    expect(pool.snapshot().playbackLifecycle).toMatchObject({
      logicalRunsCreated: 2,
      candidateCommits: 1,
      nativeDecoderCreatesByLane: [0, 1],
      nativeDecoderClosesByLane: [0, 0]
    });
    expect(Object.isFrozen(
      pool.snapshot().playbackLifecycle.nativeDecoderCreatesByLane
    )).toBe(true);
    expect(foreground.closed).toBe(true);
    expect(pool.candidateAvailable).toBe(false);
    harness.workers[0]!.emit({ t: "closed", run: foreground.generation });
    expect(pool.candidateAvailable).toBe(true);
    const nextCandidate = pool.createCandidate("next", samples(1));

    expect(pool.identity(nextCandidate.run)).toEqual({ logicalId: 3, lane: 0 });
    nextCandidate.cancel();
    nextCandidate.cancel();

    pool.dispose();
  });

  it("admits only one live run for each decoder role", async () => {
    const harness = fakeWorker();
    const pool = configuredPool(harness);
    await configure(pool, harness.workers);
    const foreground = pool.createForegroundRun(samples(1));
    const candidate = pool.createCandidate("candidate", samples(1));

    expect(() => pool.createForegroundRun(samples(1))).toThrow(
      "decoder foreground lane already owns a run"
    );
    expect(() => pool.createCandidate("duplicate", samples(1))).toThrow(
      "decoder candidate lane already owns a run"
    );

    candidate.cancel();
    expect(pool.candidateAvailable).toBe(false);
    harness.workers[1]!.emit({ t: "closed", run: candidate.run.generation });
    expect(pool.candidateAvailable).toBe(true);
    expect(() => pool.createCandidate("next", samples(1))).not.toThrow();
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
    const candidate = pool.createCandidate("candidate", samples(3));

    expect(pool.encodedBytes).toBe(5);
    expect(encodedBytes).toEqual([2, 5]);
    start(harness.workers[0]!, foreground.generation);
    start(harness.workers[1]!, candidate.run.generation);
    harness.workers[0]!.emit({
      t: "frame",
      run: foreground.generation,
      timestamp: 0,
      frame: decodedFrame()
    });
    harness.workers[1]!.emit({
      t: "frame",
      run: candidate.run.generation,
      timestamp: 0,
      frame: decodedFrame()
    });

    expect(pool.snapshot()).toMatchObject({
      workerCount: 2,
      openFrames: 2,
      openFrameBytes: 2_048,
      decoderDiagnostics: []
    });
    expect(decodedBytes).toEqual([1_024, 2_048]);

    const taken = await foreground.take(0);
    foreground.release(taken);
    expect(pool.snapshot().openFrameBytes).toBe(1_024);
    expect(decodedBytes).toEqual([1_024, 2_048, 1_024]);

    pool.dispose();
    expect(pool.snapshot()).toMatchObject({
      workerCount: 0,
      openFrames: 0,
      openFrameBytes: 0,
      decoderDiagnostics: []
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
    const candidate = pool.createCandidate("candidate", samples(1));
    start(harness.workers[0]!, foreground.generation);
    start(harness.workers[1]!, candidate.run.generation);

    harness.workers[0]!.emit({
      t: "frame",
      run: foreground.generation,
      timestamp: 0,
      frame: decodedFrame()
    });
    harness.workers[1]!.emit({
      t: "frame",
      run: candidate.run.generation,
      timestamp: 0,
      frame: decodedFrame()
    });

    await expect(candidate.run.take(0)).rejects.toThrow(
      "AVAL decoded surfaces exceed their byte ceiling"
    );
    expect(pool.snapshot()).toMatchObject({
      workerCount: 1,
      openFrames: 1,
      openFrameBytes: 1_024,
      decoderDiagnostics: [expect.objectContaining({
        lane: 1,
        phase: "decode",
        code: "decoder-operation"
      })]
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
    const candidate = pool.createCandidate("candidate", samples(1));
    const identity: DecoderPoolRunIdentity = pool.identity(run);

    pool.dispose();
    pool.dispose();

    expect(harness.workers.map((worker) => worker.terminateCalls)).toEqual([1, 1]);
    expect(pool.identity(run)).toBe(identity);
    expect(() => pool.createForegroundRun(samples(1))).toThrowError(
      expect.objectContaining({ name: "AbortError" })
    );
    expect(() => candidate.commit()).toThrowError(
      expect.objectContaining({ name: "AbortError" })
    );
  });

  it("cleans up the first worker when the second worker cannot be created", () => {
    const harness = fakeWorker(1);

    expect(() => configuredPool(harness)).toThrow("worker construction failed");
    expect(harness.workers).toHaveLength(1);
    expect(harness.workers[0]!.terminateCalls).toBe(1);
  });

  it("surfaces a fatal worker failure from an idle candidate lane", async () => {
    const harness = fakeWorker();
    const pool = configuredPool(harness);
    await configure(pool, harness.workers);
    const failure = pool.failure();

    const diagnostic = workerDiagnostic({
      phase: "configure",
      code: "decoder-operation",
      run: null,
      decodeOrdinal: null,
      reason: new Error("candidate worker failed")
    });
    harness.workers[1]!.emit({ t: "error", diagnostic });

    await expect(failure).rejects.toThrow("AVAL decoder failed");
    expect(pool.candidateAvailable).toBe(false);
    expect(harness.workers[1]!.terminated).toBe(true);
    expect(pool.snapshot().decoderDiagnostics).toEqual([{
      lane: 1,
      logicalRunId: null,
      role: null,
      ...diagnostic
    }]);
    pool.dispose();
    expect(pool.snapshot().decoderDiagnostics).toEqual([{
      lane: 1,
      logicalRunId: null,
      role: null,
      ...diagnostic
    }]);
  });

  it("reports the logical identity and role of a failing active candidate", async () => {
    const harness = fakeWorker();
    const pool = configuredPool(harness);
    await configure(pool, harness.workers);
    pool.createForegroundRun(samples(1));
    const candidate = pool.createCandidate("candidate", samples(1));
    const failure = pool.failure();

    start(harness.workers[1]!, candidate.run.generation);
    const diagnostic = workerDiagnostic({
      phase: "decode",
      code: "decoder-operation",
      run: candidate.run.generation,
      decodeOrdinal: 0,
      reason: new Error("active candidate failed")
    });
    harness.workers[1]!.emit({ t: "error", diagnostic });

    await expect(failure).rejects.toThrow("AVAL decoder failed");
    expect(pool.snapshot().decoderDiagnostics).toEqual([{
      lane: 1,
      logicalRunId: 2,
      role: "candidate",
      ...diagnostic
    }]);
    pool.dispose();
  });

  it("surfaces a fatal worker failure while the promoted lane retires", async () => {
    const harness = fakeWorker();
    const pool = configuredPool(harness);
    await configure(pool, harness.workers);
    const foreground = pool.createForegroundRun(samples(1));
    const candidate = pool.createCandidate("candidate", frameSamples(6));
    const readiness = candidate.ready();
    start(harness.workers[1]!, candidate.run.generation);
    for (let timestamp = 0; timestamp < 6; timestamp += 1) {
      harness.workers[1]!.emit({
        t: "frame",
        run: candidate.run.generation,
        timestamp,
        frame: decodedFrame(timestamp)
      });
    }
    await readiness;
    candidate.commit();
    expect(foreground.closed).toBe(true);
    expect(harness.workers[0]!.posted).toContainEqual({
      t: "close",
      run: foreground.generation
    });
    const failure = pool.failure();

    const diagnostic = workerDiagnostic({
      phase: "flush",
      code: "decoder-operation",
      run: foreground.generation,
      decodeOrdinal: null,
      reason: new Error("retiring lane failed")
    });
    harness.workers[0]!.emit({ t: "error", diagnostic });

    await expect(failure).rejects.toThrow("AVAL decoder failed");
    expect(pool.candidateAvailable).toBe(false);
    expect(harness.workers[0]!.terminated).toBe(true);
    expect(pool.snapshot().decoderDiagnostics).toEqual([{
      lane: 0,
      logicalRunId: 1,
      role: "candidate",
      ...diagnostic
    }]);
    pool.dispose();
  });

  it.each([
    [0, 1],
    [1, 0]
  ] as const)(
    "retains at most one diagnostic per physical lane when lane %i fails first",
    async (firstLane, secondLane) => {
      const harness = fakeWorker();
      const pool = configuredPool(harness);
      await configure(pool, harness.workers);
      const failure = pool.failure();
      const diagnostics = [
        workerDiagnostic({
          phase: "decode",
          code: "decoder-operation",
          run: 1,
          decodeOrdinal: 0,
          reason: new Error("foreground lane failed")
        }),
        workerDiagnostic({
          phase: "flush",
          code: "watchdog-timeout",
          run: 2,
          decodeOrdinal: 4,
          reason: new DOMException("candidate lane stalled", "TimeoutError")
        })
      ] as const;

      harness.workers[firstLane]!.emit({
        t: "error",
        diagnostic: diagnostics[firstLane]
      });
      harness.workers[secondLane]!.emit({
        t: "error",
        diagnostic: diagnostics[secondLane]
      });

      await expect(failure).rejects.toThrow("AVAL decoder failed");
      const retained: readonly Readonly<DecoderPoolDiagnostic>[] =
        pool.snapshot().decoderDiagnostics;
      expect(retained).toHaveLength(2);
      expect(retained.map(({ lane }) => lane)).toEqual([0, 1]);
      expect(retained[0]).toEqual({
        lane: 0,
        logicalRunId: null,
        role: null,
        ...diagnostics[0]
      });
      expect(retained[1]).toEqual({
        lane: 1,
        logicalRunId: null,
        role: null,
        ...diagnostics[1]
      });
      expect(Object.isFrozen(retained)).toBe(true);
      expect(Object.isFrozen(retained[0])).toBe(true);

      pool.dispose();
      const afterDispose = pool.snapshot().decoderDiagnostics;
      expect(afterDispose).toBe(retained);
      expect(afterDispose).toHaveLength(2);
    }
  );
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

function frameSamples(frameCount: number): readonly DecodeSample[] {
  return [{
    data: new Uint8Array(frameCount).buffer,
    timestamp: 0,
    duration: 1,
    key: true,
    displayedFrames: frameCount
  }];
}

function decodedFrame(timestamp = 0): VideoFrame {
  return new FakeVideoFrame(16, 16, timestamp) as unknown as VideoFrame;
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

function workerDiagnostic(input: Readonly<{
  phase: DecoderFailureDiagnostic["phase"];
  code: DecoderFailureDiagnostic["code"];
  run: number | null;
  decodeOrdinal: number | null;
  reason: unknown;
}>): Readonly<DecoderFailureDiagnostic> {
  return createDecoderFailureDiagnostic({
    ...input,
    firstFrame: null
  });
}
