import { describe, expect, it } from "vitest";

import { PageResourceManager } from "./page-resource-manager.js";
import { PageDecoderLeases } from "./page-decoder-leases.js";
import {
  PlayerResourceAccount,
  retainPlayerReclaimableCategories
} from "./player-resource-account.js";
import {
  createPlayerBlobAssemblyResourceHost,
  createPlayerBodyResourceHost,
  createPlayerCanvasBackingResourceHost,
  createPlayerCandidateResourceAuthority,
  createPlayerFullBodyResourceHost,
  createPlayerStaticDecoderResourceHost,
  createPlayerStaticSurfaceResourceHost,
  createPlayerVerifiedBlobResourceHost,
  reserveRuntimeResourcePlan
} from "./player-resource-hosts.js";
import type { RuntimeResourceAllocationSnapshot } from "./resource-plan.js";
import { MARK_VERIFIED_BLOB_RECLAIMABLE } from "./verified-blob-resources.js";

describe("player resource host adapters", () => {
  it("routes body, assembly, and verified stores into exact closed categories", async () => {
    const manager = new PageResourceManager();
    const account = new PlayerResourceAccount(manager);
    const response = await createPlayerBodyResourceHost(
      account,
      "response-body"
    ).reserve(3);
    const quarantine = await createPlayerBodyResourceHost(
      account,
      "quarantine"
    ).reserve(5);
    const assembly = await createPlayerBlobAssemblyResourceHost(account).reserve(7);
    const verified = createPlayerVerifiedBlobResourceHost(account);
    const unit = await verified.reserve("verified-unit", 11);
    const staticPng = await verified.reserve("verified-static", 13);

    expect(manager.snapshot().categories.filter(({ bytes }) => bytes > 0)).toEqual([
      { category: "response-body", bytes: 3 },
      { category: "quarantine", bytes: 5 },
      { category: "blob-assembly", bytes: 7 },
      { category: "verified-unit", bytes: 11 },
      { category: "verified-static", bytes: 13 }
    ]);
    response.release();
    response.release();
    quarantine.release();
    assembly.release();
    unit.release();
    staticPng.release();
    expect(manager.snapshot()).toMatchObject({
      physicalBytes: 0,
      byteLeaseCount: 0
    });
    account.dispose();
  });

  it("promotes a validated full body atomically and releases mismatches from quarantine", async () => {
    const manager = new PageResourceManager({
      maximumDecoderLeases: 1,
      maximumPagePhysicalBytes: 8,
      maximumPlayerLogicalBytes: 8,
      referenceProfile: true
    });
    const account = new PlayerResourceAccount(manager);
    const host = createPlayerFullBodyResourceHost(account);
    const mismatch = await host.reserve(8);

    expect(activeCategories(manager)).toEqual([
      { category: "quarantine", bytes: 8 }
    ]);
    mismatch.release();
    expect(manager.snapshot().physicalBytes).toBe(0);

    const valid = await host.reserve(8);
    const before = manager.snapshot();
    valid.promoteToAssetFull?.();
    valid.promoteToAssetFull?.();
    expect(activeCategories(manager)).toEqual([
      { category: "asset-full", bytes: 8 }
    ]);
    expect(manager.snapshot()).toMatchObject({
      physicalBytes: before.physicalBytes,
      byteLeaseCount: before.byteLeaseCount
    });
    valid.release();
    expect(manager.snapshot()).toMatchObject({
      physicalBytes: 0,
      byteLeaseCount: 0
    });
    account.dispose();
  });

  it("publishes verified copied bytes only after residency commits", async () => {
    const manager = new PageResourceManager();
    const account = new PlayerResourceAccount(manager);
    const releaseCategory = retainPlayerReclaimableCategories(
      account,
      ["verified-unit"]
    );
    const lease = await createPlayerVerifiedBlobResourceHost(account)
      .reserve("verified-unit", 9);

    expect(account.snapshot().participant?.reclaimable).toEqual([]);
    const mark = Reflect.get(lease, MARK_VERIFIED_BLOB_RECLAIMABLE) as
      (() => void) | undefined;
    expect(mark).toBeTypeOf("function");
    Reflect.apply(mark!, lease, []);
    expect(account.snapshot().participant?.reclaimable).toEqual([
      { category: "verified-unit", bytes: 9 }
    ]);

    lease.release();
    releaseCategory();
    expect(account.snapshot().participant?.reclaimable).toEqual([]);
    account.dispose();
  });

  it("transactionally reserves one reconciled runtime allocation plan", () => {
    const manager = new PageResourceManager();
    const account = new PlayerResourceAccount(manager);
    const plan = reserveRuntimeResourcePlan(account, allocationSnapshot());

    expect(plan.snapshot()).toEqual({
      released: false,
      totalBytes: 105,
      categories: [
        { category: "asset-full", bytes: 1 },
        { category: "worker-transfer", bytes: 5 },
        { category: "decoder-output", bytes: 4 },
        { category: "persistent-animation", bytes: 5 },
        { category: "streaming-texture", bytes: 6 },
        { category: "frame-staging", bytes: 7 },
        { category: "png-copy", bytes: 8 },
        { category: "png-zlib", bytes: 9 },
        { category: "png-scratch", bytes: 10 },
        { category: "current-static-surface", bytes: 11 },
        { category: "incoming-static-surface", bytes: 12 },
        { category: "animated-canvas-backing", bytes: 13 },
        { category: "static-canvas-backing", bytes: 14 }
      ]
    });
    expect(account.snapshot().participant?.logicalBytes).toBe(105);
    expect(() => plan.assertAllocation(allocationSnapshot())).not.toThrow();
    expect(() => plan.assertAllocation(allocationSnapshot({
      ownedAssetBytes: 2,
      totalBytes: 106
    }))).toThrowError(expect.objectContaining({ code: "resource-rejection" }));
    plan.release();
    plan.release();
    expect(() => plan.assertAllocation(allocationSnapshot()))
      .toThrowError(expect.objectContaining({ code: "resource-rejection" }));
    expect(account.snapshot()).toMatchObject({ activeLeaseCount: 0 });
    expect(manager.snapshot().physicalBytes).toBe(0);
    account.dispose();
  });

  it("moves a decoded static between exact roles without transient double reservation", async () => {
    const manager = new PageResourceManager({
      maximumDecoderLeases: 1,
      maximumPagePhysicalBytes: 12,
      maximumPlayerLogicalBytes: 12,
      referenceProfile: true
    });
    const account = new PlayerResourceAccount(manager);
    const host = createPlayerStaticSurfaceResourceHost(account);
    const firstTouch = host.nextTouchSequence();
    const lease = await host.reserveDecodedSurface({
      staticFrame: "idle-static",
      byteLength: 12,
      role: "incoming"
    });

    expect(manager.snapshot()).toMatchObject({
      physicalBytes: 12,
      byteLeaseCount: 1
    });
    expect(activeCategories(manager)).toEqual([
      { category: "incoming-static-surface", bytes: 12 }
    ]);
    expect(() => lease.setRole("current")).not.toThrow();
    expect(activeCategories(manager)).toEqual([
      { category: "current-static-surface", bytes: 12 }
    ]);
    lease.setRole("optional");
    expect(activeCategories(manager)).toEqual([
      { category: "decoded-static-cache", bytes: 12 }
    ]);
    lease.setRole("incoming");
    expect(activeCategories(manager)).toEqual([
      { category: "incoming-static-surface", bytes: 12 }
    ]);
    expect(host.nextTouchSequence()).toBeGreaterThan(firstTouch);

    lease.release();
    lease.release();
    expect(manager.snapshot()).toMatchObject({
      physicalBytes: 0,
      byteLeaseCount: 0
    });
    account.dispose();
  });

  it("publishes only optional decoded statics as participant reclaimable bytes", async () => {
    const manager = new PageResourceManager();
    const account = new PlayerResourceAccount(manager);
    const host = createPlayerStaticSurfaceResourceHost(account);
    const surface = await host.reserveDecodedSurface({
      staticFrame: "idle-static",
      byteLength: 12,
      role: "incoming"
    });

    expect(account.snapshot().participant?.reclaimable).toEqual([]);
    surface.setRole("optional");
    expect(account.snapshot().participant?.reclaimable).toEqual([
      { category: "decoded-static-cache", bytes: 12 }
    ]);
    surface.setRole("current");
    expect(account.snapshot().participant?.reclaimable).toEqual([]);
    surface.setRole("optional");
    surface.release();
    expect(account.snapshot().participant?.reclaimable).toEqual([]);

    account.dispose();
  });

  it("charges strict PNG transients to exact categories and releases each owner", async () => {
    const manager = new PageResourceManager();
    const account = new PlayerResourceAccount(manager);
    const host = createPlayerStaticDecoderResourceHost(account);
    const copy = await host.reserve("png-copy", 7);
    const zlib = await host.reserve("png-zlib", 5);
    const scratch = await host.reserve("png-scratch", 19);

    expect(activeCategories(manager)).toEqual([
      { category: "png-copy", bytes: 7 },
      { category: "png-zlib", bytes: 5 },
      { category: "png-scratch", bytes: 19 }
    ]);
    scratch.release();
    zlib.release();
    copy.release();
    expect(manager.snapshot()).toMatchObject({
      physicalBytes: 0,
      byteLeaseCount: 0
    });
    account.dispose();
  });

  it("reserves canvas growth before commit, trims shrink after commit, and rolls back", async () => {
    const manager = new PageResourceManager();
    const account = new PlayerResourceAccount(manager);
    const host = createPlayerCanvasBackingResourceHost(account);
    const initial = await host.beginTransition({
      animatedAllocationBytes: 10,
      staticAllocationBytes: 12
    });
    expect(activeCategories(manager)).toEqual([
      { category: "animated-canvas-backing", bytes: 10 },
      { category: "static-canvas-backing", bytes: 12 }
    ]);
    initial.commit();

    const resize = await host.beginTransition({
      animatedAllocationBytes: 15,
      staticAllocationBytes: 8
    });
    expect(activeCategories(manager)).toEqual([
      { category: "animated-canvas-backing", bytes: 15 },
      { category: "static-canvas-backing", bytes: 12 }
    ]);
    resize.commit();
    expect(activeCategories(manager)).toEqual([
      { category: "animated-canvas-backing", bytes: 15 },
      { category: "static-canvas-backing", bytes: 8 }
    ]);

    const rejected = await host.beginTransition({
      animatedAllocationBytes: 20,
      staticAllocationBytes: 9
    });
    expect(manager.snapshot().physicalBytes).toBe(29);
    rejected.rollback();
    rejected.rollback();
    expect(manager.snapshot().physicalBytes).toBe(23);
    expect(() => rejected.commit()).toThrowError(
      expect.objectContaining({ code: "abort" })
    );

    host.release();
    host.release();
    expect(manager.snapshot()).toMatchObject({
      physicalBytes: 0,
      byteLeaseCount: 0
    });
    account.dispose();
  });

  it("binds one candidate plan and decoder ticket to the account generation", async () => {
    const manager = new PageResourceManager();
    const decoders = new PageDecoderLeases(manager);
    const account = new PlayerResourceAccount(manager, { generation: 7 });
    const authority = createPlayerCandidateResourceAuthority(account, decoders);
    const plan = await authority.reservePlan(allocationSnapshot());
    const ticket = authority.requestDecoder();
    const decoder = await ticket.wait();

    expect(ticket.snapshot()).toMatchObject({
      participantId: account.participantId,
      generation: 7,
      state: "granted"
    });
    expect(manager.snapshot()).toMatchObject({
      physicalBytes: 27,
      decoderLeaseCount: 1,
      decoderQueueLength: 0
    });
    plan.assertAllocation(allocationSnapshot());
    const transfer = plan.claimWorkerTransfer(2);
    expect(() => plan.claimWorkerTransfer(1))
      .toThrowError(expect.objectContaining({ code: "resource-rejection" }));
    transfer.release();
    plan.claimWorkerTransfer(1).release();

    decoder.release();
    plan.release();
    expect(manager.snapshot()).toMatchObject({
      physicalBytes: 0,
      decoderLeaseCount: 0,
      byteLeaseCount: 0
    });
    account.dispose();
    decoders.dispose();
  });

  it("admits exact animation owners over independent loader, static, and canvas leases", async () => {
    const manager = new PageResourceManager();
    const decoders = new PageDecoderLeases(manager);
    const account = new PlayerResourceAccount(manager);
    const base = [
      account.reserve("asset-metadata", 5),
      account.reserve("verified-unit", 11),
      account.reserve("verified-static", 14),
      account.reserve("current-static-surface", 11),
      account.reserve("decoded-static-cache", 20),
      account.reserve("animated-canvas-backing", 13),
      account.reserve("static-canvas-backing", 14)
    ];
    const allocation = allocationSnapshot({
      ownedAssetBytes: 30,
      totalBytes: 134
    });
    const authority = createPlayerCandidateResourceAuthority(account, decoders);

    const plan = await authority.reservePlan(allocation);

    expect(plan.snapshot()).toMatchObject({
      released: false,
      totalBytes: 134
    });
    expect(account.snapshot().participant?.logicalBytes).toBe(115);
    plan.assertAllocation(allocation);
    expect(activeCategories(manager)).toEqual(expect.arrayContaining([
      { category: "asset-metadata", bytes: 5 },
      { category: "verified-unit", bytes: 11 },
      { category: "verified-static", bytes: 14 },
      { category: "current-static-surface", bytes: 11 },
      { category: "decoded-static-cache", bytes: 20 },
      { category: "worker-transfer", bytes: 5 },
      { category: "decoder-output", bytes: 4 },
      { category: "persistent-animation", bytes: 5 },
      { category: "streaming-texture", bytes: 6 },
      { category: "frame-staging", bytes: 7 }
    ]));

    plan.release();
    expect(account.snapshot().participant?.logicalBytes).toBe(88);
    for (const lease of base) lease.release();
    expect(manager.snapshot().physicalBytes).toBe(0);
    account.dispose();
    decoders.dispose();
  });

  it("rejects a later static owner under new pressure without disturbing candidate leases", async () => {
    const manager = new PageResourceManager({
      maximumDecoderLeases: 1,
      maximumPagePhysicalBytes: 27,
      maximumPlayerLogicalBytes: 27,
      referenceProfile: true
    });
    const decoders = new PageDecoderLeases(manager);
    const account = new PlayerResourceAccount(manager);
    const candidate = await createPlayerCandidateResourceAuthority(
      account,
      decoders
    ).reservePlan(allocationSnapshot());
    const staticDecoder = createPlayerStaticDecoderResourceHost(account);

    expect(manager.snapshot().physicalBytes).toBe(27);
    await expect(async () => staticDecoder.reserve("png-copy", 1))
      .rejects.toMatchObject({ code: "resource-rejection" });
    expect(manager.snapshot()).toMatchObject({
      physicalBytes: 27,
      byteLeaseCount: 5
    });
    candidate.assertAllocation(allocationSnapshot());

    candidate.release();
    expect(manager.snapshot()).toMatchObject({
      physicalBytes: 0,
      byteLeaseCount: 0
    });
    account.dispose();
    decoders.dispose();
  });

  it("rolls every earlier category back when a later reservation exceeds policy", () => {
    const manager = new PageResourceManager({
      maximumDecoderLeases: 2,
      maximumPagePhysicalBytes: 20,
      maximumPlayerLogicalBytes: 20,
      referenceProfile: true
    });
    const account = new PlayerResourceAccount(manager);
    const snapshot = allocationSnapshot({
      ownedAssetBytes: 10,
      maximumEncodedWindowBytes: 9,
      decoderEncodedWindowBytes: 9,
      totalBytes: 127
    });

    expect(() => reserveRuntimeResourcePlan(account, snapshot))
      .toThrowError(expect.objectContaining({ code: "resource-rejection" }));
    expect(account.snapshot()).toMatchObject({ activeLeaseCount: 0 });
    expect(manager.snapshot()).toMatchObject({
      physicalBytes: 0,
      byteLeaseCount: 0
    });
    account.dispose();
  });

  it("rejects generic categories and malformed account capabilities", () => {
    const manager = new PageResourceManager();
    const account = new PlayerResourceAccount(manager);
    expect(() => createPlayerBodyResourceHost(
      account,
      "asset-full" as unknown as "response-body"
    )).toThrow("category");
    expect(() => createPlayerBlobAssemblyResourceHost(
      {} as PlayerResourceAccount
    )).toThrow("account");
    account.dispose();
  });
});

function activeCategories(manager: PageResourceManager) {
  return manager.snapshot().categories.filter(({ bytes }) => bytes > 0);
}

function allocationSnapshot(
  override: Partial<RuntimeResourceAllocationSnapshot> = {}
): RuntimeResourceAllocationSnapshot {
  const base: RuntimeResourceAllocationSnapshot = {
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
  };
  return { ...base, ...override };
}
