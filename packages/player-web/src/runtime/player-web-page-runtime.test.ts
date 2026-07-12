import { describe, expect, it, vi } from "vitest";

import { createIntegratedOpaqueTestAsset } from "./asset-test-fixture.js";
import { createRuntimePageResourcePolicy } from "./page-resource-policy.js";
import {
  PlayerWebPageRuntime,
  type PlayerWebRuntimeParticipant
} from "./player-web-page-runtime.js";
import type { RuntimeResourceAllocationSnapshot } from "./resource-plan.js";

describe("player web page runtime", () => {
  it("rejects a caller generation so lifecycle and account cannot diverge", async () => {
    const page = new PlayerWebPageRuntime();
    expect(() => page.createParticipant({ generation: 5 } as never))
      .toThrow("lifecycle-owned");
    expect(page.snapshot()).toMatchObject({
      activeParticipants: 0,
      resources: { participants: [] }
    });
    await page.dispose();
  });

  it("evicts registered static LRU bytes when a real asset open hits pressure", async () => {
    const asset = createIntegratedOpaqueTestAsset();
    const page = new PlayerWebPageRuntime({
      policy: createRuntimePageResourcePolicy({
        maximumDecoderLeases: 1,
        maximumPagePhysicalBytes: asset.byteLength,
        maximumPlayerLogicalBytes: asset.byteLength
      })
    });
    const victim = page.createParticipant();
    const requester = page.createParticipant();
    const surface = await victim.resources.staticSurfaces.reserveDecodedSurface({
      staticFrame: "idle-static",
      byteLength: 12,
      role: "incoming"
    });
    surface.setRole("optional");
    let retained = true;
    let evictionByteReads = 0;
    const reclaimOldest = vi.fn(() => {
      if (!retained) return null;
      retained = false;
      surface.release();
      return Object.defineProperty({}, "byteLength", {
        enumerable: true,
        get() {
          evictionByteReads += 1;
          return evictionByteReads === 1 ? 12 : Number.NaN;
        }
      }) as Readonly<{ readonly byteLength: number }>;
    });
    victim.registerStaticSurfaceReclaimer({ reclaimOldest });

    const session = await requester.openAssetBytes(asset);

    expect(reclaimOldest).toHaveBeenCalledOnce();
    expect(evictionByteReads).toBe(1);
    expect(victim.snapshot().account.participant?.reclaimable).toEqual([]);
    expect(page.snapshot()).toMatchObject({
      activeParticipants: 2,
      resources: {
        physicalBytes: asset.byteLength,
        byteLeaseCount: 1,
        pendingReclamations: 0
      }
    });
    expect(page.snapshot().resources.categories).toEqual(expect.arrayContaining([
      { category: "asset-full", bytes: asset.byteLength }
    ]));
    await session.dispose();
    await page.dispose();
    expect(page.snapshot()).toMatchObject({
      disposed: true,
      activeParticipants: 0,
      resources: {
        physicalBytes: 0,
        byteLeaseCount: 0,
        decoderLeaseCount: 0,
        decoderQueueLength: 0,
        pendingReclamations: 0,
        participants: []
      }
    });
  });

  it("composes static and animation reclaimers behind one participant callback", async () => {
    const page = new PlayerWebPageRuntime({
      policy: createRuntimePageResourcePolicy({
        maximumDecoderLeases: 1,
        maximumPagePhysicalBytes: 8,
        maximumPlayerLogicalBytes: 8
      })
    });
    const victim = page.createParticipant({ phase: "static" });
    const requester = page.createParticipant();
    const surface = await victim.resources.staticSurfaces.reserveDecodedSurface({
      staticFrame: "optional",
      byteLength: 4,
      role: "incoming"
    });
    surface.setRole("optional");
    const transient = await victim.resources.staticDecoder.reserve("png-copy", 4);
    const order: string[] = [];
    victim.registerReclamationParticipant({
      categories: ["png-copy"],
      reclaim(request) {
        order.push(`animation:${request.reason}`);
        transient.release();
        return Promise.resolve(Object.freeze({
          token: request.token,
          releasedBytes: 4,
          covered: true
        }));
      }
    });
    victim.registerStaticSurfaceReclaimer({
      reclaimOldest() {
        order.push("static");
        surface.release();
        return Object.freeze({ byteLength: 4 });
      }
    });

    expect(page.snapshot().reclamation.registeredParticipantCount).toBe(1);
    expect(victim.snapshot().account.participant?.reclaimable).toEqual([
      { category: "png-copy", bytes: 4 },
      { category: "decoded-static-cache", bytes: 4 }
    ]);
    const lease = await requester.reserveWithReclamation("asset-metadata", 8);
    expect(order).toEqual(["static", "animation:optional-cache"]);
    expect(victim.snapshot().account.participant?.reclaimable).toEqual([]);
    lease.release();
    await page.dispose();
  });

  it("routes every asynchronous production host through page reclamation", async () => {
    await expectHostAdmission(8, async (requester) =>
      requester.resources.staticDecoder.reserve("png-copy", 8)
    );
    await expectHostAdmission(8, async (requester) =>
      requester.resources.staticSurfaces.reserveDecodedSurface({
        staticFrame: "incoming",
        byteLength: 8,
        role: "incoming"
      })
    );
    await expectHostAdmission(8, async (requester) =>
      requester.resources.assetSession.assembly.reserve(8)
    );
    await expectHostAdmission(8, async (requester) =>
      requester.resources.assetSession.verified.reserve("verified-unit", 8)
    );
    await expectHostAdmission(8, async (requester) => {
      const host = requester.resources.canvasBacking;
      const transition = await host.beginTransition({
        animatedAllocationBytes: 4,
        staticAllocationBytes: 4
      });
      transition.commit();
      return Object.freeze({ release: () => host.release() });
    });
    await expectHostAdmission(27, async (requester) =>
      requester.resources.candidate.reservePlan(candidateAllocationSnapshot())
    );
  });

  it("uses the player's transient pressure fallback for requester self-reclamation", async () => {
    const page = new PlayerWebPageRuntime({
      policy: createRuntimePageResourcePolicy({
        maximumDecoderLeases: 1,
        maximumPagePhysicalBytes: 32,
        maximumPlayerLogicalBytes: 27
      })
    });
    const participant = page.createParticipant({ phase: "animated" });
    const candidate = await participant.resources.candidate.reservePlan(
      candidateAllocationSnapshot()
    );
    const reclaimForPagePressure = vi.fn(async () => {
      candidate.release();
      return true;
    });
    participant.ownPlayer({
      dispose: () => undefined,
      reclaimForPagePressure
    });

    const replacement = await participant.reserveWithReclamation("png-copy", 1);

    expect(reclaimForPagePressure).toHaveBeenCalledOnce();
    expect(participant.snapshot().account.participant).toMatchObject({
      generation: 1,
      visibility: "visible",
      logicalBytes: 1,
      reclaimable: []
    });
    replacement.release();
    await page.dispose();
  });

  it("retires player ownership before asset bytes and publishes one fresh generation", async () => {
    const page = new PlayerWebPageRuntime();
    const participant = page.createParticipant();
    const oldResources = participant.resources;
    const oldCanvas = oldResources.canvasBacking;
    (await oldCanvas.beginTransition({
      animatedAllocationBytes: 7,
      staticAllocationBytes: 5
    })).commit();
    const oldSurface = await oldResources.staticSurfaces.reserveDecodedSurface({
      staticFrame: "old-idle",
      byteLength: 11,
      role: "incoming"
    });
    oldSurface.setRole("optional");
    const oldConnection = oldResources.participant.attach({
      onDecoderGrant: () => undefined
    });
    const session = await participant.openAssetBytes(
      createIntegratedOpaqueTestAsset()
    );
    const playerDispose = vi.fn(async () => {
      expect(session.disposed).toBe(false);
    });
    participant.ownPlayer({ dispose: playerDispose });
    const unregisterReclaimer = vi.fn();
    participant.registerReclamationParticipant({
      reclaim(request) {
        unregisterReclaimer();
        return Promise.resolve(Object.freeze({
          token: request.token,
          releasedBytes: 0,
          covered: true
        }));
      }
    });

    await expect(participant.replace()).resolves.toBe(2);

    expect(playerDispose).toHaveBeenCalledOnce();
    expect(session.disposed).toBe(true);
    expect(participant.resources).not.toBe(oldResources);
    expect(() => oldCanvas.beginTransition({
      animatedAllocationBytes: 1,
      staticAllocationBytes: 1
    })).toThrow(/released/u);
    await expect(oldResources.staticDecoder.reserve("png-copy", 1))
      .rejects.toMatchObject({
      code: "abort",
      failure: { context: { operation: "stale-resource-admission" } }
    });
    expect(captureThrown(() =>
      oldConnection.update({ phase: "static" })
    )).toMatchObject({
      code: "abort",
      failure: { context: { operation: "stale-participant-binding" } }
    });
    expect(participant.snapshot()).toMatchObject({
      disposed: false,
      generation: 2,
      account: {
        activeLeaseCount: 0,
        participant: {
          generation: 2,
          phase: "loading",
          reclaimable: []
        }
      },
      lifecycle: {
        currentGeneration: 2,
        state: "active",
        retiredGenerationCount: 1,
        registeredCleanupCount: 0,
        pendingWaitCount: 0,
        trackedWorkCount: 0
      }
    });
    expect(page.snapshot().reclamation.registeredParticipantCount).toBe(0);

    const newCanvas = participant.resources.canvasBacking;
    (await newCanvas.beginTransition({
      animatedAllocationBytes: 3,
      staticAllocationBytes: 2
    })).commit();
    expect(page.snapshot().resources.categories).toEqual(expect.arrayContaining([
      { category: "animated-canvas-backing", bytes: 3 },
      { category: "static-canvas-backing", bytes: 2 }
    ]));
    newCanvas.release();
    const replacementSession = await participant.openAssetBytes(
      createIntegratedOpaqueTestAsset()
    );
    await replacementSession.dispose();

    await page.dispose();
    expect(page.snapshot().resources.physicalBytes).toBe(0);
  });

  it("serializes concurrent replacements without publishing a stale bundle", async () => {
    const page = new PlayerWebPageRuntime();
    const participant = page.createParticipant();
    const generationOne = participant.resources;

    await expect(Promise.all([
      participant.replace(),
      participant.replace()
    ])).resolves.toEqual([2, 3]);

    expect(participant.generation).toBe(3);
    expect(participant.resources).not.toBe(generationOne);
    expect(participant.snapshot().account.participant?.generation).toBe(3);
    await expect(generationOne.staticDecoder.reserve("png-copy", 1))
      .rejects.toMatchObject({
      code: "abort",
      failure: { context: { operation: "stale-resource-admission" } }
    });
    const lease = await participant.resources.staticDecoder.reserve("png-copy", 1);
    lease.release();
    await page.dispose();
  });

  it("replaces during owned-byte pressure without waiting for a victim callback", async () => {
    const asset = createIntegratedOpaqueTestAsset();
    const page = new PlayerWebPageRuntime({
      policy: createRuntimePageResourcePolicy({
        maximumDecoderLeases: 1,
        maximumPagePhysicalBytes: asset.byteLength,
        maximumPlayerLogicalBytes: asset.byteLength
      })
    });
    const victim = page.createParticipant({ phase: "static" });
    const requester = page.createParticipant();
    const victimLease = await victim.resources.staticDecoder.reserve("png-copy", 4);
    const callbackGate = deferredValue<void>();
    let callbackStarted = false;
    victim.registerReclamationParticipant({
      categories: ["png-copy"],
      reclaim(request) {
        callbackStarted = true;
        return callbackGate.promise.then(() => {
          victimLease.release();
          return Object.freeze({
            token: request.token,
            releasedBytes: 4,
            covered: true
          });
        });
      }
    });
    const opening = requester.openAssetBytes(asset);
    opening.catch(() => undefined);
    await vi.waitFor(() => { expect(callbackStarted).toBe(true); });
    expect(page.snapshot().reclamation.pendingCount).toBe(1);

    await expect(requester.replace()).resolves.toBe(2);
    await expect(opening).rejects.toMatchObject({ code: "abort" });
    expect(requester.snapshot()).toMatchObject({
      generation: 2,
      account: {
        activeLeaseCount: 0,
        participant: { generation: 2, logicalBytes: 0 }
      }
    });
    expect(page.snapshot()).toMatchObject({
      reclamation: { pendingCount: 0 },
      resources: { physicalBytes: 4, byteLeaseCount: 1 }
    });

    callbackGate.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(requester.snapshot().account).toMatchObject({
      activeLeaseCount: 0,
      participant: { logicalBytes: 0 }
    });
    expect(page.snapshot().resources).toMatchObject({
      physicalBytes: 0,
      byteLeaseCount: 0
    });

    await page.dispose();
    expect(page.snapshot()).toMatchObject({
      activeParticipants: 0,
      reclamation: { pendingCount: 0 },
      resources: {
        physicalBytes: 0,
        byteLeaseCount: 0,
        participants: []
      }
    });
  });

  it("fails closed when an old-generation cleanup cannot be proven complete", async () => {
    const page = new PlayerWebPageRuntime();
    const participant = page.createParticipant();
    const oldResources = participant.resources;
    (await oldResources.canvasBacking.beginTransition({
      animatedAllocationBytes: 4,
      staticAllocationBytes: 4
    })).commit();
    participant.ownPlayer({
      dispose() { throw new Error("decoder close failed"); }
    });

    await expect(participant.replace()).rejects.toMatchObject({
      name: "AbortError"
    });

    expect(participant.snapshot()).toMatchObject({
      disposed: true,
      account: { activeLeaseCount: 0, participant: null },
      lifecycle: { state: "disposed", cleanupFailureCount: 1 }
    });
    expect(page.snapshot()).toMatchObject({
      activeParticipants: 0,
      resources: { physicalBytes: 0, byteLeaseCount: 0 }
    });
    expect(() => oldResources.canvasBacking.beginTransition({
      animatedAllocationBytes: 1,
      staticAllocationBytes: 1
    })).toThrow(/released/u);
    await page.dispose();
  });

  it("continues terminal cleanup after a hostile player disposer", async () => {
    const page = new PlayerWebPageRuntime();
    const participant = page.createParticipant();
    const lease = await participant.reserveWithReclamation("asset-metadata", 7);
    expect(participant.snapshot().account.activeLeaseCount).toBe(1);
    participant.ownPlayer({
      dispose() { throw new Error("hostile close"); }
    });

    await expect(participant.dispose()).resolves.toBeUndefined();

    expect(lease.snapshot().released).toBe(true);
    expect(participant.snapshot()).toMatchObject({
      disposed: true,
      account: { activeLeaseCount: 0, participant: null },
      lifecycle: {
        state: "disposed",
        cleanupFailureCount: 1,
        registeredCleanupCount: 0,
        trackedWorkCount: 0,
        pendingWaitCount: 0
      }
    });
    expect(page.snapshot()).toMatchObject({
      activeParticipants: 0,
      resources: { physicalBytes: 0, byteLeaseCount: 0 }
    });
    await page.dispose();
  });

  it("captures request/options once and rejects unknown fields before fetch", async () => {
    const page = new PlayerWebPageRuntime();
    const participant = page.createParticipant();
    const fetcher = {
      fetch: vi.fn(() => Promise.reject(new Error("network seam")))
    };
    const requestReads = new Map<string, number>();
    const optionReads = new Map<string, number>();
    const getter = <Value>(
      reads: Map<string, number>,
      key: string,
      value: Value
    ) => ({
      enumerable: true,
      get() {
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return value;
      }
    });
    const request = Object.defineProperties({}, {
      url: getter(requestReads, "url", "https://example.test/motion.rma"),
      integrity: getter(requestReads, "integrity", undefined),
      signal: getter(requestReads, "signal", undefined),
      timeoutMs: getter(requestReads, "timeoutMs", 100),
      credentials: getter(requestReads, "credentials", "omit")
    });
    const options = Object.defineProperties({}, {
      fetcher: getter(optionReads, "fetcher", fetcher),
      timers: getter(optionReads, "timers", undefined),
      digestAdapter: getter(optionReads, "digestAdapter", undefined),
      maximumFileBytes: getter(optionReads, "maximumFileBytes", undefined),
      format: getter(optionReads, "format", undefined),
      validateStaticPng: getter(optionReads, "validateStaticPng", undefined),
      allocate: getter(optionReads, "allocate", undefined)
    });

    await expect(participant.openAsset(request as never, options as never))
      .rejects.toMatchObject({ code: "load-failure" });
    expect(Object.fromEntries(requestReads)).toEqual({
      url: 1,
      integrity: 1,
      signal: 1,
      timeoutMs: 1,
      credentials: 1
    });
    expect(Object.fromEntries(optionReads)).toEqual({
      fetcher: 1,
      timers: 1,
      digestAdapter: 1,
      maximumFileBytes: 1,
      format: 1,
      validateStaticPng: 1,
      allocate: 1
    });

    await expect(participant.openAsset({
      url: "https://example.test/motion.rma",
      unexpected: true
    } as never, { fetcher })).rejects.toThrow("unknown field");
    await expect(participant.openAsset(
      { url: "https://example.test/motion.rma" },
      { fetcher, resources: {} } as never
    )).rejects.toThrow("unknown field");
    expect(fetcher.fetch).toHaveBeenCalledOnce();
    await page.dispose();
  });

  it("rolls back the first signal listener if the second link fails", async () => {
    const page = new PlayerWebPageRuntime();
    const participant = page.createParticipant();
    const generationSignal = participant.signal;
    const remove = vi.spyOn(generationSignal, "removeEventListener");
    const hostileSignal = {
      aborted: false,
      reason: undefined,
      addEventListener() { throw new Error("link install failed"); },
      removeEventListener() {}
    } as unknown as AbortSignal;

    await expect(participant.openAsset({
      url: "https://example.test/motion.rma",
      signal: hostileSignal
    })).rejects.toThrow("link install failed");
    expect(remove).toHaveBeenCalledOnce();
    await page.dispose();
  });

  it("removes a hostile signal listener even when registration throws afterward", async () => {
    const page = new PlayerWebPageRuntime();
    const participant = page.createParticipant();
    let retained: EventListenerOrEventListenerObject | null = null;
    const remove = vi.fn((_: string, listener: EventListenerOrEventListenerObject) => {
      if (retained === listener) retained = null;
    });
    const hostileSignal = {
      aborted: false,
      reason: undefined,
      addEventListener(_: string, listener: EventListenerOrEventListenerObject) {
        retained = listener;
        throw new Error("attached then failed");
      },
      removeEventListener: remove
    } as unknown as AbortSignal;

    await expect(participant.openAsset({
      url: "https://example.test/motion.rma",
      signal: hostileSignal
    })).rejects.toThrow("attached then failed");
    expect(remove).toHaveBeenCalledOnce();
    expect(retained).toBeNull();
    await page.dispose();
  });
});

function captureThrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected callback to throw");
}

function deferredValue<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  return {
    promise: new Promise<Value>((done) => { resolve = done; }),
    resolve
  };
}

async function expectHostAdmission(
  maximumBytes: number,
  reserve: (
    requester: PlayerWebRuntimeParticipant
  ) => PromiseLike<Readonly<{ release(): void }>>
): Promise<void> {
  const page = new PlayerWebPageRuntime({
    policy: createRuntimePageResourcePolicy({
      maximumDecoderLeases: 1,
      maximumPagePhysicalBytes: maximumBytes,
      maximumPlayerLogicalBytes: maximumBytes
    })
  });
  const victim = page.createParticipant();
  const requester = page.createParticipant();
  const surface = await victim.resources.staticSurfaces.reserveDecodedSurface({
    staticFrame: "victim-optional",
    byteLength: 4,
    role: "incoming"
  });
  surface.setRole("optional");
  let reclaimCalls = 0;
  victim.registerStaticSurfaceReclaimer({
    reclaimOldest() {
      reclaimCalls += 1;
      surface.release();
      return Object.freeze({ byteLength: 4 });
    }
  });

  const lease = await reserve(requester);
  expect(reclaimCalls).toBe(1);
  expect(page.snapshot().resources.physicalBytes).toBe(maximumBytes);
  lease.release();
  await page.dispose();
  expect(page.snapshot().resources.physicalBytes).toBe(0);
}

function candidateAllocationSnapshot(): RuntimeResourceAllocationSnapshot {
  return Object.freeze({
    ownedAssetBytes: 1,
    maximumEncodedWindowBytes: 2,
    decoderEncodedWindowBytes: 3,
    decodedSurfaceBytes: 4,
    persistentAllocationBytes: 5,
    streamingAllocationBytes: 6,
    frameStagingBytes: 7,
    staticDecodePngCopyBytes: 8,
    staticDecodeOwnedZlibBytes: 9,
    staticDecodeWorkingPeakBytes: 10,
    currentStaticSurfaceAllocationBytes: 11,
    incomingStaticSurfaceAllocationBytes: 12,
    animatedCanvasBackingAllocationBytes: 13,
    staticCanvasBackingAllocationBytes: 14,
    totalBytes: 105
  });
}
