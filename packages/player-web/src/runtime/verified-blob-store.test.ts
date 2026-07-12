import { describe, expect, it, vi } from "vitest";

import {
  decodeSha256Hex,
  verifySha256AndPromote,
  type Sha256InputLease,
  type VerifiedSha256Input
} from "./sha256-verifier.js";
import {
  VerifiedBlobStore,
  promoteBorrowedVerifiedBlob,
  type VerifiedBlobLoadRequest,
  type VerifiedBlobPersistentLease,
  type VerifiedBlobResourceCategory,
  type VerifiedBlobResourceHost
} from "./verified-blob-store.js";
import { MARK_VERIFIED_BLOB_RECLAIMABLE } from "./verified-blob-resources.js";
import { createRuntimeCompleteSource } from "./runtime-complete-source.js";

const ZERO_SHA256 = "00".repeat(32);

describe("verified blob store", () => {
  it("starts with one immutable absent snapshot per closed descriptor", () => {
    const store = createStore().store;

    const snapshot = store.snapshot();
    expect(snapshot).toEqual({
      generation: 7,
      disposed: false,
      verifiedBytes: 0,
      persistentBytes: 0,
      persistentLeaseCount: 0,
      admittedBytes: 0,
      admittedLeaseCount: 0,
      pendingAdmissionCount: 0,
      interestedWaiterCount: 0,
      pendingLoadCount: 0,
      unitBlobs: {
        total: 2,
        absent: 2,
        loading: 0,
        verified: 0,
        verifiedBytes: 0
      },
      staticBlobs: {
        total: 1,
        absent: 1,
        loading: 0,
        verified: 0,
        verifiedBytes: 0
      }
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.unitBlobs)).toBe(true);
    expect(store.state("unit:a")).toBe("absent");
    expect(() => store.state("unknown")).toThrow();
  });

  it("shares one same-session load and promotes one exact isolated copy", async () => {
    const { store, resources } = createStore();
    const source = bytes(1, 2, 3);
    const quarantine = countingLease();
    const pending = deferred<void>();
    const loader = vi.fn(async (request: Readonly<VerifiedBlobLoadRequest>) => {
      expect(request).toMatchObject({
        key: "unit:a",
        kind: "unit",
        byteLength: 3,
        generation: 7
      });
      expect(Object.isFrozen(request)).toBe(true);
      await pending.promise;
      await promoteVerified(request, source, 7, quarantine.lease);
      // Mutation after the synchronous verifier callback but before the loader
      // settles must not alter the staged persistent copy.
      source[0] = 77;
    });

    const first = store.ensure("unit:a", { load: loader });
    const joinedLoader = vi.fn();
    const joined = store.ensure("unit:a", { load: joinedLoader });
    expect(store.snapshot()).toMatchObject({
      interestedWaiterCount: 2,
      pendingLoadCount: 1,
      unitBlobs: { absent: 1, loading: 1, verified: 0 }
    });

    pending.resolve();
    const [firstHandle, joinedHandle] = await Promise.all([first, joined]);

    expect(loader).toHaveBeenCalledOnce();
    expect(joinedLoader).not.toHaveBeenCalled();
    expect(firstHandle).toBe(joinedHandle);
    expect(firstHandle).toEqual({
      key: "unit:a",
      kind: "unit",
      byteLength: 3,
      generation: 7
    });
    expect(Object.isFrozen(firstHandle)).toBe(true);
    expect(quarantine.releaseCalls()).toBe(1);
    expect(resources.reservations).toEqual([
      { category: "verified-unit", bytes: 3 }
    ]);
    expect(resources.snapshot()).toEqual({ live: 3, peak: 3, releases: 0 });

    source[1] = 99;
    const firstCopy = store.copy("unit:a");
    firstCopy[1] = 88;
    expect([...store.copy("unit:a")]).toEqual([1, 2, 3]);
    expect(store.snapshot()).toMatchObject({
      verifiedBytes: 3,
      persistentBytes: 3,
      persistentLeaseCount: 1,
      interestedWaiterCount: 0,
      pendingLoadCount: 0,
      unitBlobs: { absent: 1, loading: 0, verified: 1, verifiedBytes: 3 }
    });
  });

  it("awaits exact copied admission before allocation while promotion stays synchronous", async () => {
    const resources = new DeferredResources();
    const events: string[] = [];
    const store = new VerifiedBlobStore({
      generation: 7,
      descriptors: [{ key: "unit:a", kind: "unit", byteLength: 3 }],
      resources,
      allocate(byteLength) {
        events.push(`allocate:${String(byteLength)}`);
        return new Uint8Array(new ArrayBuffer(byteLength));
      }
    });
    const operation = store.ensure("unit:a", {
      async load(request) {
        events.push("loader");
        await request.admit("copied");
        events.push("admitted");
        await promoteVerified(request, bytes(1, 2, 3), 7);
        events.push("promoted");
      }
    });

    await flushMicrotasks();
    expect(events).toEqual(["loader"]);
    expect(resources.reservations).toEqual([
      { category: "verified-unit", bytes: 3 }
    ]);
    resources.resolveNext();
    await expect(operation).resolves.toMatchObject({ key: "unit:a" });
    expect(events).toEqual([
      "loader",
      "admitted",
      "allocate:3",
      "promoted"
    ]);
    expect(resources.snapshot()).toEqual({ live: 3, releases: 0 });
    await store.dispose();
    expect(resources.snapshot()).toEqual({ live: 0, releases: 1 });
  });

  it("publishes copied ownership only when staged promotion commits", async () => {
    const finishLoader = deferred<void>();
    let publications = 0;
    let releases = 0;
    const store = new VerifiedBlobStore({
      generation: 7,
      descriptors: [{ key: "unit:a", kind: "unit", byteLength: 3 }],
      resources: {
        reserve() {
          return {
            [MARK_VERIFIED_BLOB_RECLAIMABLE]() { publications += 1; },
            release() { releases += 1; }
          };
        }
      }
    });
    const operation = store.ensure("unit:a", {
      async load(request) {
        await promoteVerified(request, bytes(1, 2, 3), 7);
        expect(publications).toBe(0);
        expect(store.snapshot()).toMatchObject({
          persistentBytes: 3,
          persistentLeaseCount: 1,
          unitBlobs: { loading: 1, verified: 0 }
        });
        await finishLoader.promise;
      }
    });

    await flushMicrotasks();
    expect(publications).toBe(0);
    finishLoader.resolve();
    await expect(operation).resolves.toMatchObject({ key: "unit:a" });
    expect(publications).toBe(1);
    expect(store.state("unit:a")).toBe("verified");
    await store.dispose();
    expect(releases).toBe(1);
  });

  it("rejects commit and releases staged ownership when publication fails", async () => {
    let publications = 0;
    let releases = 0;
    const store = new VerifiedBlobStore({
      generation: 7,
      descriptors: [{ key: "unit:a", kind: "unit", byteLength: 3 }],
      resources: {
        reserve() {
          return {
            [MARK_VERIFIED_BLOB_RECLAIMABLE]() {
              publications += 1;
              throw new Error("publication failed");
            },
            release() { releases += 1; }
          };
        }
      }
    });

    await expect(store.ensure("unit:a", {
      load: (request) => promoteVerified(request, bytes(1, 2, 3), 7)
    })).rejects.toMatchObject({ code: "load-failure" });
    expect(publications).toBe(1);
    expect(releases).toBe(1);
    expect(store.state("unit:a")).toBe("absent");
    expect(store.snapshot()).toMatchObject({
      persistentBytes: 0,
      persistentLeaseCount: 0,
      admittedBytes: 0,
      admittedLeaseCount: 0
    });
    await store.dispose();
    expect(releases).toBe(1);
  });

  it("borrows a complete-source range without reserving a copied blob lease", async () => {
    const { store, resources } = createStore();
    const sourceRelease = vi.fn();
    const source = createRuntimeCompleteSource(bytes(1, 2, 3), sourceRelease);
    const retained = source.read(0, 3);

    await expect(store.ensure("unit:a", {
      async load(request) {
        await request.admit("borrowed");
        await expect(request.admit("copied")).rejects.toMatchObject({
          code: "load-failure"
        });
        await verifySha256AndPromote(
          {
            digestSha256: () => Promise.resolve(decodeSha256Hex(ZERO_SHA256))
          },
          {
            bytes: retained.bytes,
            expectedSha256Hex: ZERO_SHA256,
            generation: 7,
            isGenerationCurrent: () => true,
            signal: request.signal,
            inputLease: { release() {} },
            promote: (verified) =>
              promoteBorrowedVerifiedBlob(request, verified, retained)
          }
        );
      }
    })).resolves.toMatchObject({ key: "unit:a" });

    expect(resources.reservations).toEqual([]);
    expect(store.snapshot()).toMatchObject({
      verifiedBytes: 3,
      persistentBytes: 0,
      persistentLeaseCount: 0
    });
    expect([...store.copy("unit:a")]).toEqual([1, 2, 3]);
    await store.dispose();
    source.release();
    expect(sourceRelease).toHaveBeenCalledOnce();
  });

  it("rolls copied preadmission back before a later complete-source borrow", async () => {
    const { store, resources } = createStore();
    const source = createRuntimeCompleteSource(bytes(4, 5, 6), () => {});
    const retained = source.read(0, 3);

    await store.ensure("unit:a", {
      async load(request) {
        await request.admit("copied");
        expect(resources.snapshot().live).toBe(3);
        await request.admit("borrowed");
        expect(resources.snapshot().live).toBe(0);
        await verifySha256AndPromote(
          {
            digestSha256: () => Promise.resolve(decodeSha256Hex(ZERO_SHA256))
          },
          {
            bytes: retained.bytes,
            expectedSha256Hex: ZERO_SHA256,
            generation: 7,
            isGenerationCurrent: () => true,
            signal: request.signal,
            inputLease: { release() {} },
            promote: (verified) =>
              promoteBorrowedVerifiedBlob(request, verified, retained)
          }
        );
      }
    });

    expect(resources.reservations).toEqual([
      { category: "verified-unit", bytes: 3 }
    ]);
    expect(resources.snapshot()).toEqual({ live: 0, peak: 3, releases: 1 });
    expect(store.snapshot().persistentBytes).toBe(0);
    await store.dispose();
    source.release();
  });

  it("releases a copied admission that arrives after the final waiter aborts", async () => {
    const resources = new DeferredResources();
    const store = new VerifiedBlobStore({
      generation: 7,
      descriptors: [{ key: "unit:a", kind: "unit", byteLength: 3 }],
      resources
    });
    const controller = new AbortController();
    const operation = store.ensure("unit:a", {
      signal: controller.signal,
      async load(request) {
        await request.admit("copied");
        await promoteVerified(request, bytes(1, 2, 3), 7);
      }
    });
    await flushMicrotasks();
    expect(resources.reservations).toHaveLength(1);
    controller.abort();
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    resources.resolveNext();
    await flushMicrotasks();
    expect(resources.snapshot()).toEqual({ live: 0, releases: 1 });
    expect(store.state("unit:a")).toBe("absent");
    await store.dispose();
  });

  it("awaits a late unobserved admission during no-promote disposal", async () => {
    const resources = new DeferredResources();
    const store = new VerifiedBlobStore({
      generation: 7,
      descriptors: [{ key: "unit:a", kind: "unit", byteLength: 3 }],
      resources
    });
    await expect(store.ensure("unit:a", {
      load(request) {
        void request.admit("copied").catch(() => undefined);
      }
    })).rejects.toMatchObject({ code: "integrity-mismatch" });
    expect(resources.reservations).toHaveLength(1);

    let settled = false;
    const disposal = store.dispose().then(() => { settled = true; });
    await flushMicrotasks();
    expect(settled).toBe(false);
    resources.resolveNext();
    await disposal;
    expect(resources.snapshot()).toEqual({ live: 0, releases: 1 });
  });

  it("contains a rejected async admission before digest or allocation", async () => {
    const digest = vi.fn();
    const allocate = vi.fn((byteLength: number) =>
      new Uint8Array(new ArrayBuffer(byteLength))
    );
    const store = new VerifiedBlobStore({
      generation: 7,
      descriptors: [{ key: "unit:a", kind: "unit", byteLength: 3 }],
      resources: {
        async reserve() { throw new Error("private admission detail"); }
      },
      allocate
    });

    await expect(store.ensure("unit:a", {
      async load(request) {
        await request.admit("copied");
        await verifySha256AndPromote(
          { digestSha256: digest },
          {
            bytes: bytes(1, 2, 3),
            expectedSha256Hex: ZERO_SHA256,
            generation: 7,
            isGenerationCurrent: () => true,
            signal: request.signal,
            inputLease: { release() {} },
            promote: request.promote
          }
        );
      }
    })).rejects.toMatchObject({ code: "load-failure" });
    expect(digest).not.toHaveBeenCalled();
    expect(allocate).not.toHaveBeenCalled();
    expect(store.state("unit:a")).toBe("absent");
    await store.dispose();
  });

  it("aborts only one waiter while an interested peer keeps the load alive", async () => {
    const { store } = createStore();
    const pending = deferred<void>();
    let underlyingSignal!: AbortSignal;
    const loader = vi.fn(async (request: Readonly<VerifiedBlobLoadRequest>) => {
      underlyingSignal = request.signal;
      await pending.promise;
      await promoteVerified(request, bytes(1, 2, 3), 7);
    });
    const firstController = new AbortController();
    const joinedController = new AbortController();
    const remove = vi.spyOn(firstController.signal, "removeEventListener");
    const first = store.ensure("unit:a", {
      signal: firstController.signal,
      load: loader
    });
    const joined = store.ensure("unit:a", {
      signal: joinedController.signal,
      load: loader
    });

    await Promise.resolve();
    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(underlyingSignal.aborted).toBe(false);
    expect(store.snapshot().interestedWaiterCount).toBe(1);
    expect(remove).toHaveBeenCalledOnce();

    pending.resolve();
    await expect(joined).resolves.toMatchObject({ key: "unit:a" });
    expect(loader).toHaveBeenCalledOnce();
  });

  it("cancels an unobserved load, releases its late token, and permits retry", async () => {
    const { store, resources } = createStore();
    const firstPending = deferred<void>();
    const controller = new AbortController();
    let firstUnderlying!: AbortSignal;
    const lateLease = countingLease();
    const first = store.ensure("unit:a", {
      signal: controller.signal,
      async load(request) {
        firstUnderlying = request.signal;
        await firstPending.promise;
        await promoteVerified(request, bytes(1, 2, 3), 7, lateLease.lease);
      }
    });
    await Promise.resolve();

    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(firstUnderlying.aborted).toBe(true);
    expect(store.state("unit:a")).toBe("absent");

    const retry = store.ensure("unit:a", {
      load: (request) => promoteVerified(request, bytes(4, 5, 6), 7)
    });
    await expect(retry).resolves.toMatchObject({ key: "unit:a" });
    expect([...store.copy("unit:a")]).toEqual([4, 5, 6]);

    firstPending.resolve();
    await flushMicrotasks();
    expect(lateLease.releaseCalls()).toBe(1);
    expect([...store.copy("unit:a")]).toEqual([4, 5, 6]);
    expect(resources.reservations).toHaveLength(1);
  });

  it("returns to absent after transport failure and starts a clean retry", async () => {
    const { store } = createStore();
    const failed = store.ensure("static:poster", {
      load: async () => {
        throw new Error("https://private.example/asset.rmo");
      }
    });

    await expect(failed).rejects.toMatchObject({ code: "load-failure" });
    expect(store.state("static:poster")).toBe("absent");
    await expect(store.ensure("static:poster", {
      load: (request) => promoteVerified(request, bytes(7, 8), 7)
    })).resolves.toMatchObject({ kind: "static" });
    expect([...store.copy("static:poster")]).toEqual([7, 8]);
  });

  it("rejects a loader that settles without using the verifier promotion seam", async () => {
    const { store, resources } = createStore();

    await expect(store.ensure("unit:a", {
      load: async (request) => {
        await request.admit("copied");
      }
    })).rejects.toMatchObject({ code: "integrity-mismatch" });

    expect(store.state("unit:a")).toBe("absent");
    expect(resources.reservations).toEqual([
      { category: "verified-unit", bytes: 3 }
    ]);
    expect(resources.snapshot()).toEqual({ live: 0, peak: 3, releases: 1 });
  });

  it("releases copied preadmission after digest mismatch or a forged token", async () => {
    const { store, resources } = createStore();
    const mismatchLease = countingLease();
    const mismatch = store.ensure("unit:a", {
      async load(request) {
        await request.admit("copied");
        await verifySha256AndPromote(
          {
            digestSha256: () => Promise.resolve(
              decodeSha256Hex("11".repeat(32))
            )
          },
          {
            bytes: bytes(1, 2, 3),
            expectedSha256Hex: ZERO_SHA256,
            generation: 7,
            isGenerationCurrent: () => true,
            signal: request.signal,
            inputLease: mismatchLease.lease,
            promote: request.promote
          }
        );
      }
    });

    await expect(mismatch).rejects.toMatchObject({ code: "integrity-mismatch" });
    expect(mismatchLease.releaseCalls()).toBe(1);
    expect(resources.reservations).toEqual([
      { category: "verified-unit", bytes: 3 }
    ]);
    expect(resources.snapshot()).toEqual({ live: 0, peak: 3, releases: 1 });
    expect(store.state("unit:a")).toBe("absent");

    const forgedRelease = vi.fn();
    const forged = Object.freeze({
      bytes: bytes(1, 2, 3),
      generation: 7,
      inputLease: { release: forgedRelease }
    }) as unknown as Readonly<VerifiedSha256Input>;
    await expect(store.ensure("unit:a", {
      async load(request) {
        await request.admit("copied");
        request.promote(forged);
      }
    })).rejects.toMatchObject({ code: "integrity-mismatch" });
    expect(forgedRelease).not.toHaveBeenCalled();
    expect(resources.reservations).toHaveLength(2);
    expect(resources.snapshot()).toEqual({ live: 0, peak: 3, releases: 2 });
  });

  it("rejects wrong exact length or generation and releases genuine quarantine", async () => {
    const { store, resources } = createStore();
    const wrongLengthLease = countingLease();
    await expect(store.ensure("unit:a", {
      load: (request) => promoteVerified(
        request,
        bytes(1, 2),
        7,
        wrongLengthLease.lease
      )
    })).rejects.toMatchObject({ code: "integrity-mismatch" });
    expect(wrongLengthLease.releaseCalls()).toBe(1);
    expect(resources.reservations).toEqual([
      { category: "verified-unit", bytes: 3 }
    ]);
    expect(resources.snapshot().live).toBe(0);

    const wrongGenerationLease = countingLease();
    await expect(store.ensure("unit:a", {
      load: (request) => promoteVerified(
        request,
        bytes(1, 2, 3),
        8,
        wrongGenerationLease.lease
      )
    })).rejects.toMatchObject({ code: "integrity-mismatch" });
    expect(wrongGenerationLease.releaseCalls()).toBe(1);
    expect(resources.reservations).toHaveLength(2);
    expect(resources.snapshot().live).toBe(0);

    const nonExactBackingLease = countingLease();
    const larger = bytes(9, 1, 2, 3, 9);
    await expect(store.ensure("unit:a", {
      load: (request) => promoteVerified(
        request,
        larger.subarray(1, 4),
        7,
        nonExactBackingLease.lease
      )
    })).rejects.toMatchObject({ code: "integrity-mismatch" });
    expect(nonExactBackingLease.releaseCalls()).toBe(1);
    expect(resources.reservations).toHaveLength(3);
    expect(resources.snapshot().live).toBe(0);
  });

  it("does not strand a load when a waiter abort listener cannot be installed", async () => {
    const { store } = createStore();
    const controller = new AbortController();
    vi.spyOn(controller.signal, "addEventListener").mockImplementation(() => {
      throw new Error("listener failure");
    });
    const loader = vi.fn();

    await expect(store.ensure("unit:a", {
      signal: controller.signal,
      load: loader
    })).rejects.toMatchObject({ code: "load-failure" });

    expect(loader).not.toHaveBeenCalled();
    expect(store.state("unit:a")).toBe("absent");
    expect(store.snapshot()).toMatchObject({
      interestedWaiterCount: 0,
      pendingLoadCount: 0
    });
  });

  it("removes a session listener when construction attaches then throws", () => {
    const session = new AbortController();
    const originalAdd = session.signal.addEventListener.bind(session.signal);
    vi.spyOn(session.signal, "addEventListener").mockImplementation((
      type,
      listener,
      options
    ) => {
      originalAdd(type, listener, options);
      throw new Error("registration failed after attachment");
    });
    const remove = vi.spyOn(session.signal, "removeEventListener");

    expect(() => new VerifiedBlobStore({
      generation: 7,
      descriptors: [{ key: "unit:a", kind: "unit", byteLength: 3 }],
      resources: new CountingResources(),
      signal: session.signal
    })).toThrow("registration failed after attachment");
    expect(remove).toHaveBeenCalledOnce();
  });

  it("rolls back persistent ownership when allocation fails", async () => {
    const resources = new CountingResources();
    const quarantine = countingLease();
    const store = new VerifiedBlobStore({
      generation: 7,
      descriptors: [{ key: "unit:a", kind: "unit", byteLength: 3 }],
      resources,
      allocate() {
        throw new Error("allocation failed");
      }
    });

    await expect(store.ensure("unit:a", {
      load: (request) => promoteVerified(
        request,
        bytes(1, 2, 3),
        7,
        quarantine.lease
      )
    })).rejects.toMatchObject({ code: "load-failure" });
    expect(quarantine.releaseCalls()).toBe(1);
    expect(resources.snapshot()).toEqual({ live: 0, peak: 3, releases: 1 });
    expect(store.state("unit:a")).toBe("absent");
  });

  it("evicts verified ownership exactly once and can reload the descriptor", async () => {
    const { store, resources } = createStore();
    await store.ensure("unit:a", {
      load: (request) => promoteVerified(request, bytes(1, 2, 3), 7)
    });

    expect(store.evict("unit:a")).toBe(true);
    expect(store.evict("unit:a")).toBe(false);
    expect(resources.snapshot()).toEqual({ live: 0, peak: 3, releases: 1 });
    expect(store.state("unit:a")).toBe("absent");
    expect(() => store.copy("unit:a")).toThrow();

    await store.ensure("unit:a", {
      load: (request) => promoteVerified(request, bytes(3, 2, 1), 7)
    });
    expect([...store.copy("unit:a")]).toEqual([3, 2, 1]);
    expect(resources.reservations).toHaveLength(2);
  });

  it("copies one exact verified subrange without exposing or aliasing backing bytes", async () => {
    const resources = new CountingResources();
    const store = new VerifiedBlobStore({
      generation: 7,
      descriptors: [{ key: "unit", kind: "unit", byteLength: 5 }],
      resources
    });
    await store.ensure("unit", {
      load: (request) => promoteVerified(request, bytes(1, 2, 3, 4, 5), 7)
    });

    const copy = store.copyRange("unit", 1, 3);
    expect([...copy]).toEqual([2, 3, 4]);
    expect(copy.byteOffset).toBe(0);
    expect(copy.byteLength).toBe(3);
    expect(copy.buffer.byteLength).toBe(3);
    copy.fill(9);
    expect([...store.copyRange("unit", 1, 3)]).toEqual([2, 3, 4]);
    expect(resources.snapshot().live).toBe(5);
  });

  it("rejects copy ranges before verification, outside the blob, and after disposal", async () => {
    const { store } = createStore();
    expect(() => store.copyRange("unit:a", 0, 1)).toThrow();
    await store.ensure("unit:a", {
      load: (request) => promoteVerified(request, bytes(1, 2, 3), 7)
    });
    for (const [offset, length] of [
      [-1, 1],
      [0, 0],
      [3, 1],
      [2, 2]
    ] as const) {
      expect(() => store.copyRange("unit:a", offset, length)).toThrow();
    }
    await store.dispose();
    expect(() => store.copyRange("unit:a", 0, 1)).toThrow();
  });

  it("session abort rejects waiters, aborts the load, and awaits late retirement", async () => {
    const session = new AbortController();
    const remove = vi.spyOn(session.signal, "removeEventListener");
    const { store, resources } = createStore(session.signal);
    const pending = deferred<void>();
    const lateLease = countingLease();
    let underlying!: AbortSignal;
    const waiter = store.ensure("unit:a", {
      async load(request) {
        underlying = request.signal;
        await pending.promise;
        await promoteVerified(request, bytes(1, 2, 3), 7, lateLease.lease);
      }
    });
    await Promise.resolve();

    session.abort();
    await expect(waiter).rejects.toMatchObject({ name: "AbortError" });
    expect(underlying.aborted).toBe(true);
    let disposalSettled = false;
    const disposal = store.dispose().then(() => {
      disposalSettled = true;
    });
    await Promise.resolve();
    expect(disposalSettled).toBe(false);

    pending.resolve();
    await disposal;
    expect(lateLease.releaseCalls()).toBe(1);
    expect(resources.snapshot().live).toBe(0);
    expect(remove).toHaveBeenCalledOnce();
    expect(store.snapshot()).toMatchObject({
      disposed: true,
      verifiedBytes: 0,
      persistentLeaseCount: 0,
      interestedWaiterCount: 0,
      pendingLoadCount: 0
    });
  });

  it("disposes verified leases idempotently and rejects later access", async () => {
    const { store, resources } = createStore();
    await store.ensure("static:poster", {
      load: (request) => promoteVerified(request, bytes(7, 8), 7)
    });

    const first = store.dispose();
    const second = store.dispose();
    expect(first).toBe(second);
    await first;
    expect(resources.snapshot()).toEqual({ live: 0, peak: 2, releases: 1 });
    expect(store.state("static:poster")).toBe("absent");
    expect(() => store.copy("static:poster")).toThrow();
    await expect(store.ensure("static:poster", {
      load: (request) => promoteVerified(request, bytes(7, 8), 7)
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects duplicate descriptors and unsafe geometry without reserving", () => {
    const resources = new CountingResources();
    expect(() => new VerifiedBlobStore({
      generation: 1,
      descriptors: [
        { key: "same", kind: "unit", byteLength: 1 },
        { key: "same", kind: "static", byteLength: 1 }
      ],
      resources
    })).toThrow();
    expect(() => new VerifiedBlobStore({
      generation: 1,
      descriptors: [{ key: "unit", kind: "unit", byteLength: 0 }],
      resources
    })).toThrow();
    expect(resources.reservations).toEqual([]);
  });
});

function createStore(sessionSignal?: AbortSignal): {
  readonly store: VerifiedBlobStore;
  readonly resources: CountingResources;
} {
  const resources = new CountingResources();
  const base = {
    generation: 7,
    descriptors: [
      { key: "unit:a", kind: "unit", byteLength: 3 },
      { key: "unit:b", kind: "unit", byteLength: 4 },
      { key: "static:poster", kind: "static", byteLength: 2 }
    ] as const,
    resources
  };
  return {
    store: sessionSignal === undefined
      ? new VerifiedBlobStore(base)
      : new VerifiedBlobStore({ ...base, signal: sessionSignal }),
    resources
  };
}

async function promoteVerified(
  request: Readonly<VerifiedBlobLoadRequest>,
  value: Uint8Array,
  generation: number,
  lease: Sha256InputLease = countingLease().lease
): Promise<void> {
  try {
    await request.admit("copied");
  } catch (error) {
    try { lease.release(); } catch {}
    throw error;
  }
  await verifySha256AndPromote(
    {
      digestSha256: () => Promise.resolve(decodeSha256Hex(ZERO_SHA256))
    },
    {
      bytes: value,
      expectedSha256Hex: ZERO_SHA256,
      generation,
      isGenerationCurrent: () => true,
      signal: request.signal,
      inputLease: lease,
      promote: request.promote
    }
  );
}

class CountingResources implements VerifiedBlobResourceHost {
  public readonly reservations: Array<Readonly<{
    category: VerifiedBlobResourceCategory;
    bytes: number;
  }>> = [];
  #live = 0;
  #peak = 0;
  #releases = 0;

  public reserve(
    category: VerifiedBlobResourceCategory,
    byteLength: number
  ): VerifiedBlobPersistentLease {
    this.reservations.push(Object.freeze({ category, bytes: byteLength }));
    this.#live += byteLength;
    this.#peak = Math.max(this.#peak, this.#live);
    let released = false;
    return Object.freeze({
      release: () => {
        if (released) return;
        released = true;
        this.#live -= byteLength;
        this.#releases += 1;
      }
    });
  }

  public snapshot(): Readonly<{
    live: number;
    peak: number;
    releases: number;
  }> {
    return Object.freeze({
      live: this.#live,
      peak: this.#peak,
      releases: this.#releases
    });
  }
}

class DeferredResources implements VerifiedBlobResourceHost {
  public readonly reservations: Array<Readonly<{
    category: VerifiedBlobResourceCategory;
    bytes: number;
  }>> = [];
  readonly #pending: Array<ReturnType<typeof deferred<VerifiedBlobPersistentLease>>> = [];
  #live = 0;
  #releases = 0;

  public reserve(
    category: VerifiedBlobResourceCategory,
    byteLength: number
  ): Promise<VerifiedBlobPersistentLease> {
    this.reservations.push(Object.freeze({ category, bytes: byteLength }));
    const pending = deferred<VerifiedBlobPersistentLease>();
    this.#pending.push(pending);
    return pending.promise;
  }

  public resolveNext(): void {
    const pending = this.#pending.shift();
    if (pending === undefined) throw new Error("no deferred reservation");
    const byteLength = this.reservations[
      this.reservations.length - this.#pending.length - 1
    ]!.bytes;
    this.#live += byteLength;
    let released = false;
    pending.resolve(Object.freeze({
      release: () => {
        if (released) return;
        released = true;
        this.#live -= byteLength;
        this.#releases += 1;
      }
    }));
  }

  public snapshot(): Readonly<{ live: number; releases: number }> {
    return Object.freeze({ live: this.#live, releases: this.#releases });
  }
}

function countingLease(): {
  readonly lease: Sha256InputLease;
  readonly releaseCalls: () => number;
} {
  let releases = 0;
  return Object.freeze({
    lease: Object.freeze({
      release(): void {
        releases += 1;
      }
    }),
    releaseCalls: () => releases
  });
}

function bytes(...values: number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(values);
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return Object.freeze({ promise, resolve });
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
