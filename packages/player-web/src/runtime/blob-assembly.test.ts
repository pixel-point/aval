import { describe, expect, it } from "vitest";

import {
  RuntimeBlobAssembly,
  type BlobAssemblyLease,
  type PlannedRuntimeBlob
} from "./blob-assembly.js";

describe("runtime blob quarantine assembly", () => {
  it("accepts out-of-order segments, validates padding, and transfers one exact lease", async () => {
    const resources = createResourceHost();
    const assembly = await RuntimeBlobAssembly.create({
      blob: plannedBlob(10, 3, 7),
      generation: 4,
      resources
    });

    assembly.accept({ generation: 4, offset: 16, bytes: bytes(6, 7, 8, 9) });
    assembly.accept({ generation: 4, offset: 10, bytes: bytes(0, 0, 0, 1, 2, 3) });
    const result = assembly.complete();

    expect([...result.bytes]).toEqual([1, 2, 3, 6, 7, 8, 9]);
    expect(result.bytes.byteLength).toBe(7);
    expect(resources.snapshot()).toEqual({ live: 7, peak: 7, releases: 0 });
    result.release();
    result.release();
    expect(resources.snapshot()).toEqual({ live: 0, peak: 7, releases: 1 });
    expect(assembly.snapshot()).toEqual({
      generation: 4,
      acceptedStorageBytes: 10,
      blobBytes: 7,
      complete: true,
      disposed: true,
      liveAssemblyBytes: 0,
      peakAssemblyBytes: 7
    });
  });

  it("releases accepted segment leases after copying", async () => {
    const segmentLease = countingLease();
    const assembly = await RuntimeBlobAssembly.create({
      blob: plannedBlob(0, 0, 3),
      generation: 1,
      resources: createResourceHost()
    });
    assembly.accept({
      generation: 1,
      offset: 0,
      bytes: bytes(1, 2, 3),
      lease: segmentLease.lease
    });
    expect(segmentLease.releases()).toBe(1);
    assembly.complete().release();
  });

  it.each([
    { label: "nonzero padding", segments: [[0, bytes(1, 0, 0, 5, 6)]] },
    { label: "overlap", segments: [[0, bytes(0, 0, 0, 5)], [3, bytes(5, 6)]] },
    { label: "hole", segments: [[0, bytes(0, 0)], [3, bytes(5, 6, 7, 8)]] }
  ] as const)("rejects $label and releases quarantine", async ({ segments }) => {
    const resources = createResourceHost();
    const assembly = await RuntimeBlobAssembly.create({
      blob: plannedBlob(0, 3, 4),
      generation: 1,
      resources
    });
    for (const [offset, value] of segments) {
      if (assembly.snapshot().disposed) break;
      try {
        assembly.accept({ generation: 1, offset, bytes: value });
      } catch {
        // Completion below observes the same terminal outcome.
      }
    }
    expect(() => assembly.complete()).toThrow();
    expect(resources.snapshot().live).toBe(0);
  });

  it("rejects duplicate completion without double-releasing detached ownership", async () => {
    const resources = createResourceHost();
    const assembly = await RuntimeBlobAssembly.create({
      blob: plannedBlob(0, 0, 2),
      generation: 1,
      resources
    });
    assembly.accept({ generation: 1, offset: 0, bytes: bytes(2, 3) });
    const result = assembly.complete();
    expect(() => assembly.complete()).toThrow();
    expect(resources.snapshot().live).toBe(2);
    result.release();
    expect(resources.snapshot().live).toBe(0);
  });

  it("releases late and cross-generation segment ownership without corrupting live input", async () => {
    const resources = createResourceHost();
    const assembly = await RuntimeBlobAssembly.create({
      blob: plannedBlob(0, 0, 2),
      generation: 7,
      resources
    });
    const stale = countingLease();
    expect(() => assembly.accept({
      generation: 6,
      offset: 0,
      bytes: bytes(9, 9),
      lease: stale.lease
    })).toThrow();
    expect(stale.releases()).toBe(1);

    assembly.accept({ generation: 7, offset: 0, bytes: bytes(1, 2) });
    const result = assembly.complete();
    const late = countingLease();
    expect(() => assembly.accept({
      generation: 7,
      offset: 0,
      bytes: bytes(3, 4),
      lease: late.lease
    })).toThrow();
    expect(late.releases()).toBe(1);
    result.release();
    expect(resources.snapshot().live).toBe(0);
  });

  it("continues cleanup when segment or quarantine release throws", async () => {
    const resources = createResourceHost(true);
    const assembly = await RuntimeBlobAssembly.create({
      blob: plannedBlob(0, 0, 2),
      generation: 1,
      resources
    });
    const throwingSegment: BlobAssemblyLease = {
      release() { throw new Error("segment release"); }
    };
    assembly.accept({
      generation: 1,
      offset: 0,
      bytes: bytes(1),
      lease: throwingSegment
    });
    expect(() => assembly.complete()).toThrow();
    expect(resources.snapshot().live).toBe(0);
  });

  it("awaits admission before allocating the exact quarantine destination", async () => {
    const admission = deferred<BlobAssemblyLease>();
    const events: string[] = [];
    const operation = RuntimeBlobAssembly.create({
      blob: plannedBlob(0, 0, 3),
      generation: 1,
      resources: {
        reserve() {
          events.push("reserve");
          return admission.promise;
        }
      },
      allocate(byteLength) {
        events.push(`allocate:${String(byteLength)}`);
        return new Uint8Array(new ArrayBuffer(byteLength));
      }
    });

    await Promise.resolve();
    expect(events).toEqual(["reserve"]);
    admission.resolve({ release() { events.push("release"); } });
    const assembly = await operation;
    expect(events).toEqual(["reserve", "allocate:3"]);
    assembly.dispose();
    expect(events).toEqual(["reserve", "allocate:3", "release"]);
  });

  it("releases a late admission exactly once after abort without allocating", async () => {
    const admission = deferred<BlobAssemblyLease>();
    const controller = new AbortController();
    let releases = 0;
    let allocations = 0;
    const operation = RuntimeBlobAssembly.create({
      blob: plannedBlob(0, 0, 3),
      generation: 1,
      resources: { reserve: () => admission.promise },
      signal: controller.signal,
      allocate(byteLength) {
        allocations += 1;
        return new Uint8Array(new ArrayBuffer(byteLength));
      }
    });
    await Promise.resolve();
    controller.abort();
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    admission.resolve({ release() { releases += 1; } });
    await flushMicrotasks();
    expect(allocations).toBe(0);
    expect(releases).toBe(1);
  });

  it("removes an abort listener when hostile registration attaches then throws", async () => {
    const admission = deferred<BlobAssemblyLease>();
    let attached: EventListenerOrEventListenerObject | null = null;
    let removals = 0;
    let releases = 0;
    let allocations = 0;
    const signal = {
      aborted: false,
      addEventListener(
        _type: string,
        listener: EventListenerOrEventListenerObject
      ) {
        attached = listener;
        throw new Error("registration failed after attachment");
      },
      removeEventListener(
        _type: string,
        listener: EventListenerOrEventListenerObject
      ) {
        if (listener === attached) removals += 1;
      }
    } as unknown as AbortSignal;
    const operation = RuntimeBlobAssembly.create({
      blob: plannedBlob(0, 0, 3),
      generation: 1,
      resources: { reserve: () => admission.promise },
      signal,
      allocate(byteLength) {
        allocations += 1;
        return new Uint8Array(new ArrayBuffer(byteLength));
      }
    });

    await expect(operation).rejects.toThrow("registration failed after attachment");
    admission.resolve({ release() { releases += 1; } });
    await flushMicrotasks();
    expect(removals).toBe(1);
    expect(allocations).toBe(0);
    expect(releases).toBe(1);
  });

  it("releases admitted ownership when exact allocation validation fails", async () => {
    let releases = 0;
    await expect(RuntimeBlobAssembly.create({
      blob: plannedBlob(0, 0, 3),
      generation: 1,
      resources: {
        reserve: () => ({ release() { releases += 1; } })
      },
      allocate: () => new Uint8Array(2)
    })).rejects.toThrow("does not match");
    expect(releases).toBe(1);
  });
});

function plannedBlob(
  storageOffset: number,
  paddingLength: number,
  blobLength: number
): PlannedRuntimeBlob {
  return Object.freeze({
    ordinal: 0,
    kind: "static",
    staticFrame: "poster",
    sha256: "00".repeat(32),
    paddingRange: Object.freeze({ offset: storageOffset, length: paddingLength }),
    blobRange: Object.freeze({
      offset: storageOffset + paddingLength,
      length: blobLength
    }),
    storageRange: Object.freeze({
      offset: storageOffset,
      length: paddingLength + blobLength
    })
  });
}

function bytes(...values: number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(values);
}

function countingLease(): {
  readonly lease: BlobAssemblyLease;
  readonly releases: () => number;
} {
  let releases = 0;
  return {
    lease: { release() { releases += 1; } },
    releases: () => releases
  };
}

function createResourceHost(throwOnRelease = false): {
  readonly reserve: (bytes: number) => BlobAssemblyLease;
  readonly snapshot: () => { live: number; peak: number; releases: number };
} {
  let live = 0;
  let peak = 0;
  let releases = 0;
  return {
    reserve(byteLength) {
      live += byteLength;
      peak = Math.max(peak, live);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          live -= byteLength;
          releases += 1;
          if (throwOnRelease) throw new Error("quarantine release");
        }
      };
    },
    snapshot: () => ({ live, peak, releases })
  };
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((accept) => { resolve = accept; });
  return Object.freeze({ promise, resolve });
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
