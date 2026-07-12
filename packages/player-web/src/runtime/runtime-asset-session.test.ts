import {
  parseFrontIndex,
  parseHeader,
  validateCompleteAsset,
  validatePngProfile
} from "@rendered-motion/format";
import { describe, expect, it, vi } from "vitest";

import type {
  RuntimeFetchAdapter,
  RuntimeFetchInit,
  RuntimeFetchResponseView
} from "./asset-fetch-contracts.js";
import {
  createIntegratedPathTestAsset,
  createOpaqueTestAsset
} from "./asset-test-fixture.js";
import type {
  BoundedBodyByteLease,
  BoundedBodyByteResourceHost,
  RuntimeBodyReader,
  RuntimeBodyReadResult
} from "./bounded-body-reader.js";
import type {
  BlobAssemblyLease,
  BlobAssemblyResourceHost
} from "./blob-assembly.js";
import type { LoadWatchdogTimerHost } from "./load-watchdogs.js";
import {
  openRuntimeAsset,
  openRuntimeAssetBytes,
  type RuntimeAssetSessionResources
} from "./runtime-asset-session.js";
import type { Sha256DigestAdapter } from "./sha256-verifier.js";
import type {
  VerifiedBlobPersistentLease,
  VerifiedBlobResourceCategory,
  VerifiedBlobResourceHost
} from "./verified-blob-store.js";

describe("sparse runtime asset session", () => {
  it("returns after valid range metadata without allocating the complete file", async () => {
    const asset = createOpaqueTestAsset();
    const server = new AssetServer(asset);
    const resources = new SessionResources();
    const session = await openRuntimeAsset(request(), {
      fetcher: server,
      digestAdapter: zeroDigestAdapter(),
      resources,
      generation: 3,
      timers: new PassiveTimerHost()
    });

    expect(session.mode).toBe("range");
    expect(server.calls.map(({ init }) => init.headers)).toEqual([
      { Range: "bytes=0-63" },
      {
        Range: `bytes=64-${String(session.catalog.residencySnapshot().metadataBytes - 1)}`,
        "If-Range": '"entity-v1"'
      }
    ]);
    expect(session.catalog.residencySnapshot()).toMatchObject({
      generation: 3,
      mode: "range",
      verifiedPayloadBytes: 0,
      unitBlobs: { absent: 2, loading: 0, verified: 0 },
      staticBlobs: { absent: 1, loading: 0, verified: 0 }
    });
    expect(resources.response.reservations).not.toContain(asset.byteLength);
    expect(resources.metadata.reservations).toEqual([
      session.catalog.residencySnapshot().metadataBytes
    ]);
    expect(resources.metadata.live).toBe(
      session.catalog.residencySnapshot().metadataBytes
    );
    expect(Math.max(...resources.response.reservations)).toBeLessThan(
      asset.byteLength
    );

    await session.dispose();
    expect(resources.snapshot().live).toBe(0);
  });

  it("verifies and strictly validates one static before catalog promotion", async () => {
    const asset = createOpaqueTestAsset();
    const server = new AssetServer(asset);
    const resources = new SessionResources();
    const order: string[] = [];
    const digest: Sha256DigestAdapter = {
      async digestSha256() {
        order.push("digest");
        return new Uint8Array(32);
      }
    };
    const session = await openRuntimeAsset(request(), {
      fetcher: server,
      digestAdapter: digest,
      resources,
      timers: new PassiveTimerHost(),
      validateStaticPng(input) {
        order.push("png");
        return validatePngProfile(input);
      }
    });

    await session.ensureStatic("idle");
    order.push("published");
    expect(order).toEqual(["digest", "png", "published"]);
    expect(session.catalog.copyStaticPng("idle")).toEqual(
      staticBytes(asset, "idle")
    );
    expect(session.catalog.residencySnapshot()).toMatchObject({
      staticBlobs: { absent: 0, loading: 0, verified: 1 }
    });
    expect(resources.assembly.live).toBe(0);
    expect(resources.verified.live).toBe(staticBytes(asset, "idle").byteLength);

    await session.dispose();
    expect(resources.snapshot().live).toBe(0);
  });

  it("rejects corrupt static bytes before PNG/media entry or cache admission", async () => {
    const asset = createOpaqueTestAsset();
    const server = new AssetServer(asset);
    const expected = allBlobBytes(asset);
    server.mutateNextPayload = (bytes) => {
      const changed = bytes.slice();
      changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
      return changed;
    };
    const resources = new SessionResources();
    const validateStaticPng = vi.fn((input: {
      readonly png: Uint8Array;
      readonly expectedWidth: number;
      readonly expectedHeight: number;
    }) => validatePngProfile(input));
    const session = await openRuntimeAsset(request(), {
      fetcher: server,
      digestAdapter: validatingZeroDigestAdapter(expected),
      resources,
      timers: new PassiveTimerHost(),
      validateStaticPng
    });

    await expect(session.ensureStatic("idle")).rejects.toMatchObject({
      code: "integrity-mismatch"
    });
    expect(validateStaticPng).not.toHaveBeenCalled();
    expect(session.catalog.residencySnapshot().staticBlobs).toMatchObject({
      absent: 1,
      loading: 0,
      verified: 0,
      verifiedBytes: 0
    });
    expect(() => session.catalog.copyStaticPng("idle")).toThrow();
    expect(resources.assembly.live).toBe(0);
    expect(resources.verified.live).toBe(0);
    await session.dispose();
  });

  it("keeps digest-passed but structurally invalid PNG bytes unpromoted", async () => {
    const asset = createOpaqueTestAsset();
    const server = new AssetServer(asset);
    server.mutateNextPayload = (bytes) => {
      const changed = bytes.slice();
      changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
      return changed;
    };
    const resources = new SessionResources();
    const session = await openRuntimeAsset(request(), {
      fetcher: server,
      digestAdapter: zeroDigestAdapter(),
      resources,
      timers: new PassiveTimerHost()
    });

    await expect(session.ensureStatic("idle")).rejects.toMatchObject({
      code: "load-failure"
    });
    expect(session.catalog.residencySnapshot().staticBlobs.verified).toBe(0);
    expect(resources.verified.live).toBe(0);
    await session.dispose();
  });

  it("verifies one unit before exposing fresh sample copies", async () => {
    const asset = createOpaqueTestAsset();
    const layout = validateCompleteAsset({ bytes: asset });
    const record = layout.frontIndex.records.find((entry) =>
      entry.frameIndex === 0 &&
      layout.frontIndex.manifest.units[entry.unitIndex]?.id === "body"
    )!;
    const expected = asset.slice(
      record.payloadOffset,
      record.payloadOffset + record.payloadLength
    );
    const session = await openRuntimeAsset(request(), {
      fetcher: new AssetServer(asset),
      digestAdapter: zeroDigestAdapter(),
      resources: new SessionResources(),
      timers: new PassiveTimerHost()
    });

    await session.ensureUnit("opaque", "body");
    const first = new Uint8Array(session.catalog.copySample(
      "opaque",
      "body",
      0
    ));
    first.fill(0);
    expect(new Uint8Array(session.catalog.copySample(
      "opaque",
      "body",
      0
    ))).toEqual(expected);
    await session.dispose();
  });

  it("shares one blob load while one waiter aborts and its peer continues", async () => {
    const asset = createOpaqueTestAsset();
    const server = new AssetServer(asset);
    const session = await openRuntimeAsset(request(), {
      fetcher: server,
      digestAdapter: zeroDigestAdapter(),
      resources: new SessionResources(),
      timers: new PassiveTimerHost()
    });
    const pending = deferred<RuntimeFetchResponseView>();
    let pendingInit!: Readonly<RuntimeFetchInit>;
    server.enqueue((init) => {
      pendingInit = init;
      return pending.promise;
    });
    const firstController = new AbortController();
    const peerController = new AbortController();
    const first = session.ensureUnit("opaque", "body", {
      signal: firstController.signal
    });
    const peer = session.ensureUnit("opaque", "body", {
      signal: peerController.signal
    });
    await flushMicrotasks();
    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(pendingInit.signal.aborted).toBe(false);

    pending.resolve(server.respond(pendingInit));
    await expect(peer).resolves.toMatchObject({ kind: "unit" });
    expect(server.calls).toHaveLength(3);
    await session.dispose();
  });

  it("detaches one expired waiter while a later peer keeps the shared digest", async () => {
    const asset = createOpaqueTestAsset();
    const server = new AssetServer(asset);
    const timers = new ManualTimerHost();
    const digest = deferred<ArrayBuffer>();
    const digestStarted = deferred<void>();
    const session = await openRuntimeAsset(request(3_000), {
      fetcher: server,
      digestAdapter: {
        digestSha256() {
          digestStarted.resolve();
          return digest.promise;
        }
      },
      resources: new SessionResources(),
      timers
    });
    const owner = session.ensureUnit("opaque", "body");
    await digestStarted.promise;
    timers.advance(1_000);
    const peer = session.ensureUnit("opaque", "body");
    timers.advance(2_000);

    await expect(owner).rejects.toMatchObject({
      code: "watchdog-timeout",
      failure: { context: { policyPhase: "overall" } }
    });
    expect(session.snapshot()).toMatchObject({
      pendingLoads: 1,
      interestedWaiters: 1
    });

    digest.resolve(new Uint8Array(32).buffer);
    await expect(peer).resolves.toMatchObject({ kind: "unit" });
    expect(session.snapshot()).toMatchObject({
      activeTransportBodies: 0,
      pendingLoads: 0,
      interestedWaiters: 0
    });
    await session.dispose();
    expect(timers.pendingCount).toBe(0);
  });

  it("cancels the last waiter transport and permits a clean retry", async () => {
    const asset = createOpaqueTestAsset();
    const server = new AssetServer(asset);
    const resources = new SessionResources();
    const session = await openRuntimeAsset(request(), {
      fetcher: server,
      digestAdapter: zeroDigestAdapter(),
      resources,
      timers: new PassiveTimerHost()
    });
    const pendingRead = deferred<RuntimeBodyReadResult>();
    const pendingReader = new TrackedReader(pendingRead.promise);
    server.enqueue((init) => server.respond(init, pendingReader));
    const controller = new AbortController();
    const first = session.ensureUnit("opaque", "body", {
      signal: controller.signal
    });
    await flushMicrotasks();
    controller.abort();
    await flushMicrotasks();
    expect(pendingReader.cancelCount).toBe(1);
    pendingRead.resolve({ done: true, value: undefined });
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(session.catalog.residencySnapshot().unitBlobs.loading).toBe(0);

    await expect(session.ensureUnit("opaque", "body")).resolves.toMatchObject({
      kind: "unit"
    });
    expect(session.disposed).toBe(false);
    await session.dispose();
    expect(resources.snapshot().live).toBe(0);
  });

  it("cancels an active payload reader when its final waiter deadline expires", async () => {
    const asset = createOpaqueTestAsset();
    const server = new AssetServer(asset);
    const resources = new SessionResources();
    const timers = new ManualTimerHost();
    const session = await openRuntimeAsset(request(10), {
      fetcher: server,
      digestAdapter: zeroDigestAdapter(),
      resources,
      timers
    });
    const pendingRead = deferred<RuntimeBodyReadResult>();
    const reader = new TrackedReader(pendingRead.promise);
    server.enqueue((init) => server.respond(init, reader));
    const ensure = session.ensureUnit("opaque", "body");
    await flushMicrotasks();

    timers.advance(10);
    await flushMicrotasks();
    expect(reader.cancelCount).toBe(1);
    pendingRead.resolve({ done: true, value: undefined });
    await expect(ensure).rejects.toMatchObject({
      code: "watchdog-timeout",
      failure: { context: { policyPhase: "overall" } }
    });
    await flushMicrotasks();
    expect(session.snapshot()).toMatchObject({
      activeTransportBodies: 0,
      pendingLoads: 0,
      interestedWaiters: 0
    });
    expect(resources.assembly.live).toBe(0);

    await expect(session.ensureUnit("opaque", "body")).resolves.toMatchObject({
      kind: "unit"
    });
    await session.dispose();
    expect(resources.snapshot().live).toBe(0);
    expect(timers.pendingCount).toBe(0);
  });

  it("returns failed transport to absent and retries without stale promotion", async () => {
    const asset = createOpaqueTestAsset();
    const server = new AssetServer(asset);
    const session = await openRuntimeAsset(request(), {
      fetcher: server,
      digestAdapter: zeroDigestAdapter(),
      resources: new SessionResources(),
      timers: new PassiveTimerHost()
    });
    server.enqueue(async () => {
      throw new Error("https://secret.example.test/payload");
    });

    await expect(session.ensureUnit("opaque", "body")).rejects.toMatchObject({
      code: "load-failure"
    });
    expect(session.catalog.residencySnapshot().unitBlobs.loading).toBe(0);
    await expect(session.ensureUnit("opaque", "body")).resolves.toMatchObject({
      kind: "unit"
    });
    await session.dispose();
  });

  it("ensures all statics and one rendition's units with at most four bodies", async () => {
    const asset = createIntegratedPathTestAsset();
    const server = new AssetServer(asset);
    const session = await openRuntimeAsset(request(), {
      fetcher: server,
      digestAdapter: zeroDigestAdapter(),
      resources: new SessionResources(),
      timers: new PassiveTimerHost()
    });
    const beforeStatics = server.calls.length;
    await session.ensureAllStatics();
    expect(server.calls.length - beforeStatics).toBe(1);
    const beforeUnits = server.calls.length;
    await session.ensureRenditionUnits("opaque-path");
    expect(server.calls.length - beforeUnits).toBe(1);
    expect(session.catalog.residencySnapshot()).toMatchObject({
      unitBlobs: { absent: 0, verified: 9 },
      staticBlobs: { absent: 0, verified: 6 }
    });
    expect(server.maximumActiveFetches).toBeLessThanOrEqual(4);
    await session.dispose();
  });

  it("bounds one coalesced multi-blob batch through digest and promotion", async () => {
    const asset = createIntegratedPathTestAsset();
    const server = new AssetServer(asset);
    const resources = new SessionResources();
    const timers = new ManualTimerHost();
    let digestCalls = 0;
    const session = await openRuntimeAsset(request(10), {
      fetcher: server,
      digestAdapter: {
        async digestSha256() {
          digestCalls += 1;
          timers.advance(4);
          return new Uint8Array(32);
        }
      },
      resources,
      timers
    });
    const before = server.calls.length;

    await expect(session.ensureAllStatics()).rejects.toMatchObject({
      code: "watchdog-timeout",
      failure: { context: { policyPhase: "overall" } }
    });
    await flushMicrotasks();

    expect(server.calls.length - before).toBe(1);
    expect(digestCalls).toBe(3);
    expect(session.catalog.residencySnapshot().staticBlobs).toMatchObject({
      loading: 0,
      verified: 0
    });
    expect(session.snapshot()).toMatchObject({
      activeTransportBodies: 0,
      pendingLoads: 0,
      interestedWaiters: 0
    });
    expect(resources.assembly.live).toBe(0);
    expect(resources.verified.live).toBe(0);
    expect(timers.pendingCount).toBe(0);
    await session.dispose();
    expect(resources.snapshot().live).toBe(0);
  });

  it("uses an ignored-range full response as a no-more-network sparse source", async () => {
    const asset = createOpaqueTestAsset();
    const server = new AssetServer(asset);
    server.ignoreFirstRange = true;
    const resources = new SessionResources();
    const session = await openRuntimeAsset(request(), {
      fetcher: server,
      digestAdapter: zeroDigestAdapter(),
      resources,
      timers: new PassiveTimerHost()
    });
    expect(session.mode).toBe("full");
    expect(server.calls).toHaveLength(1);
    expect(resources.full.promotions).toBe(1);
    expect(resources.metadata.live).toBe(0);

    await session.ensureUnit("opaque", "body");
    await session.ensureStatic("idle");
    expect(server.calls).toHaveLength(1);
    expect(session.catalog.ownedByteLength).toBe(asset.byteLength);
    expect(resources.assembly.reservations).toEqual([]);
    expect(resources.verified.reservations).toEqual([]);
    await session.dispose();
    expect(resources.snapshot().live).toBe(0);
  });

  it("adopts a later full replacement and never returns to the network", async () => {
    const asset = createOpaqueTestAsset();
    const layout = validateCompleteAsset({ bytes: asset });
    const copiedUnit = layout.frontIndex.unitBlobs.find(
      ({ rendition, unit }) => rendition === "opaque" && unit === "body"
    )!;
    const server = new AssetServer(asset);
    const resources = new SessionResources();
    const session = await openRuntimeAsset(request(), {
      fetcher: server,
      digestAdapter: zeroDigestAdapter(),
      resources,
      timers: new PassiveTimerHost()
    });
    expect(resources.metadata.live).toBe(
      session.catalog.residencySnapshot().metadataBytes
    );

    await session.ensureUnit("opaque", "body");
    expect(session.mode).toBe("range");
    expect(resources.verified.live).toBe(copiedUnit.length);
    server.enqueue(() => response(200, asset, 0, asset.byteLength));
    expect(resources.metadata.live).toBe(
      session.catalog.residencySnapshot().metadataBytes
    );
    await session.ensureStatic("idle");
    expect(resources.metadata.live).toBe(0);
    await session.ensureUnit("opaque", "intro");

    expect(server.calls).toHaveLength(4);
    expect(session.mode).toBe("full");
    expect(session.catalog.residencySnapshot()).toMatchObject({
      mode: "full",
      unitBlobs: { verified: 2 },
      staticBlobs: { verified: 1 }
    });
    expect(resources.full.promotions).toBe(1);
    expect(session.catalog.ownedByteLength).toBe(
      asset.byteLength + copiedUnit.length
    );
    expect(resources.assembly.reservations).toEqual([copiedUnit.length]);
    expect(resources.verified.reservations).toEqual([{
      category: "verified-unit",
      byteLength: copiedUnit.length
    }]);
    const record = layout.frontIndex.records.find((entry) =>
      layout.frontIndex.manifest.units[entry.unitIndex]?.id === "body"
    )!;
    const expected = asset.slice(
      record.payloadOffset,
      record.payloadOffset + record.payloadLength
    );
    const copy = new Uint8Array(session.catalog.copySample(
      "opaque", "body", record.frameIndex
    ));
    copy.fill(0);
    expect(new Uint8Array(session.catalog.copySample(
      "opaque", "body", record.frameIndex
    ))).toEqual(expected);

    const reservationCount = resources.verified.reservations.length;
    session.evictRenditionUnits("opaque");
    expect(resources.verified.live).toBe(0);
    expect(session.catalog.ownedByteLength).toBe(asset.byteLength);
    await session.ensureUnit("opaque", "body");
    expect(resources.verified.reservations).toHaveLength(reservationCount);
    expect(session.catalog.ownedByteLength).toBe(asset.byteLength);
    expect(server.calls).toHaveLength(4);
    await session.dispose();
    expect(resources.snapshot().live).toBe(0);
  });

  it("externally gates one range-free full response before parser/session publication", async () => {
    const asset = createOpaqueTestAsset();
    const server = new AssetServer(asset);
    const resources = new SessionResources();
    const validate = vi.fn((bytes: Uint8Array, maximumFileBytes: number) =>
      validateCompleteAsset({
        bytes,
        options: { budgets: { maxFileBytes: maximumFileBytes } }
      })
    );

    await expect(openRuntimeAsset({
      url: "https://cdn.example.test/motion.rma",
      integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    }, {
      fetcher: server,
      digestAdapter: {
        async digestSha256() { return new Uint8Array(32).fill(1); }
      },
      resources,
      timers: new PassiveTimerHost(),
      format: {
        parseHeader: (bytes, cap) => parseHeader(bytes, {
          budgets: { maxFileBytes: cap }
        }),
        parseFrontIndex: (bytes, cap) => parseFrontIndex(bytes, {
          budgets: { maxFileBytes: cap }
        }),
        validateCompleteAsset: validate
      }
    })).rejects.toMatchObject({ code: "integrity-mismatch" });

    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]!.init.headers).toEqual({});
    expect(validate).not.toHaveBeenCalled();
    expect(resources.full.promotions).toBe(0);
    expect(resources.snapshot().live).toBe(0);
  });

  it("publishes externally verified full bytes through exactly one parser gate", async () => {
    const asset = createOpaqueTestAsset();
    const server = new AssetServer(asset);
    const resources = new SessionResources();
    const validate = vi.fn((bytes: Uint8Array, maximumFileBytes: number) =>
      validateCompleteAsset({
        bytes,
        options: { budgets: { maxFileBytes: maximumFileBytes } }
      })
    );
    const session = await openRuntimeAsset({
      url: FINAL_URL,
      integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    }, {
      fetcher: server,
      digestAdapter: zeroDigestAdapter(),
      resources,
      timers: new PassiveTimerHost(),
      format: {
        parseHeader: (bytes, cap) => parseHeader(bytes, {
          budgets: { maxFileBytes: cap }
        }),
        parseFrontIndex: (bytes, cap) => parseFrontIndex(bytes, {
          budgets: { maxFileBytes: cap }
        }),
        validateCompleteAsset: validate
      }
    });

    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]!.init.headers).toEqual({});
    expect(validate).toHaveBeenCalledTimes(1);
    expect(resources.full.promotions).toBe(1);
    await session.ensureUnit("opaque", "body");
    expect(validate).toHaveBeenCalledTimes(1);
    expect(resources.assembly.reservations).toEqual([]);
    expect(resources.verified.reservations).toEqual([]);
    await session.dispose();
  });

  it("adapts complete caller bytes through the same verified sparse catalog", async () => {
    const caller = createOpaqueTestAsset();
    const expected = caller.slice();
    const resources = new SessionResources();
    const session = await openRuntimeAssetBytes(caller, {
      digestAdapter: zeroDigestAdapter(),
      resources,
      generation: 9
    });
    caller.fill(0);

    expect(session.mode).toBe("full");
    expect(session.catalog.residencySnapshot()).toMatchObject({
      generation: 9,
      verifiedPayloadBytes: 0
    });
    expect(resources.full.promotions).toBe(1);
    await session.ensureUnit("opaque", "body");
    expect(session.catalog.ownedByteLength).toBe(expected.byteLength);
    expect(resources.assembly.reservations).toEqual([]);
    expect(resources.verified.reservations).toEqual([]);
    const record = validateCompleteAsset({ bytes: expected }).frontIndex.records[0]!;
    expect(new Uint8Array(session.catalog.copySample(
      "opaque",
      "body",
      record.frameIndex
    ))).toEqual(expected.slice(
      record.payloadOffset,
      record.payloadOffset + record.payloadLength
    ));
    await session.dispose();
    expect(resources.snapshot().live).toBe(0);
  });

  it("aborts pending disposal to an immutable all-zero residency snapshot", async () => {
    const asset = createOpaqueTestAsset();
    const server = new AssetServer(asset);
    const resources = new SessionResources();
    const session = await openRuntimeAsset(request(), {
      fetcher: server,
      digestAdapter: zeroDigestAdapter(),
      resources,
      timers: new PassiveTimerHost()
    });
    const pendingRead = deferred<RuntimeBodyReadResult>();
    const reader = new TrackedReader(pendingRead.promise);
    server.enqueue((init) => server.respond(init, reader));
    const ensure = session.ensureUnit("opaque", "body");
    await flushMicrotasks();
    const disposal = session.dispose();
    await flushMicrotasks();
    expect(reader.cancelCount).toBe(1);
    pendingRead.resolve({ done: true, value: undefined });
    await expect(ensure).rejects.toMatchObject({ name: "AbortError" });
    await disposal;

    const snapshot = session.snapshot();
    expect(snapshot).toMatchObject({
      disposed: true,
      metadataBytes: 0,
      verifiedPayloadBytes: 0,
      activeTransportBodies: 0,
      pendingLoads: 0
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(resources.snapshot().live).toBe(0);
  });
});

const FINAL_URL = "https://cdn.example.test/motion.rma";

function request(timeoutMs?: number) {
  return {
    url: FINAL_URL,
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  } as const;
}

class AssetServer implements RuntimeFetchAdapter {
  public readonly calls: Array<Readonly<{
    url: string;
    init: Readonly<RuntimeFetchInit>;
  }>> = [];
  public ignoreFirstRange = false;
  public mutateNextPayload: ((bytes: Uint8Array) => Uint8Array) | null = null;
  public maximumActiveFetches = 0;
  readonly #asset: Uint8Array;
  readonly #behaviors: Array<(
    init: Readonly<RuntimeFetchInit>
  ) => RuntimeFetchResponseView | PromiseLike<RuntimeFetchResponseView>> = [];
  #activeFetches = 0;

  public constructor(asset: Uint8Array) { this.#asset = asset; }

  public enqueue(
    behavior: (
      init: Readonly<RuntimeFetchInit>
    ) => RuntimeFetchResponseView | PromiseLike<RuntimeFetchResponseView>
  ): void {
    this.#behaviors.push(behavior);
  }

  public async fetch(
    url: string,
    init: Readonly<RuntimeFetchInit>
  ): Promise<RuntimeFetchResponseView> {
    this.calls.push({ url, init });
    this.#activeFetches += 1;
    this.maximumActiveFetches = Math.max(
      this.maximumActiveFetches,
      this.#activeFetches
    );
    try {
      const behavior = this.#behaviors.shift();
      if (behavior !== undefined) return await behavior(init);
      return this.respond(init);
    } finally {
      this.#activeFetches -= 1;
    }
  }

  public respond(
    init: Readonly<RuntimeFetchInit>,
    suppliedReader?: RuntimeBodyReader
  ): RuntimeFetchResponseView {
    const range = init.headers.Range;
    if (range === undefined || (this.ignoreFirstRange && this.calls.length === 1)) {
      return response(200, this.#asset, 0, this.#asset.byteLength, suppliedReader);
    }
    const match = /^bytes=([0-9]+)-([0-9]+)$/.exec(range);
    if (match === null) throw new Error("invalid fixture range");
    const start = Number(match[1]);
    const end = Number(match[2]);
    let bytes: Uint8Array = this.#asset.slice(start, end + 1);
    const frontEnd = validateCompleteAsset({ bytes: this.#asset })
      .frontIndex.frontIndexRange.length;
    if (start >= frontEnd && this.mutateNextPayload !== null) {
      const mutate = this.mutateNextPayload;
      this.mutateNextPayload = null;
      bytes = mutate(bytes);
    }
    return response(206, bytes, start, this.#asset.byteLength, suppliedReader);
  }
}

function response(
  status: number,
  bytes: Uint8Array,
  start: number,
  total: number,
  suppliedReader?: RuntimeBodyReader
): RuntimeFetchResponseView {
  const end = start + bytes.byteLength - 1;
  const headers: Readonly<Record<string, string | null>> = {
    "content-encoding": null,
    "content-length": String(bytes.byteLength),
    "content-range": status === 206
      ? `bytes ${String(start)}-${String(end)}/${String(total)}`
      : null,
    etag: '"entity-v1"'
  };
  return {
    status,
    type: "cors",
    url: FINAL_URL,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: { getReader: () => suppliedReader ?? new TrackedReader(bytes) }
  };
}

class TrackedReader implements RuntimeBodyReader {
  public cancelCount = 0;
  public releaseLockCount = 0;
  readonly #steps: Array<
    RuntimeBodyReadResult | PromiseLike<RuntimeBodyReadResult>
  >;

  public constructor(
    value: Uint8Array | PromiseLike<RuntimeBodyReadResult>
  ) {
    this.#steps = value instanceof Uint8Array
      ? [
          { done: false, value: value.slice() },
          { done: true, value: undefined }
        ]
      : [value];
  }

  public read(): PromiseLike<RuntimeBodyReadResult> {
    return Promise.resolve(
      this.#steps.shift() ?? { done: true, value: undefined }
    );
  }
  public async cancel(): Promise<void> { this.cancelCount += 1; }
  public releaseLock(): void { this.releaseLockCount += 1; }
}

class SessionResources implements RuntimeAssetSessionResources {
  public readonly metadata = new ByteResources();
  public readonly response = new ByteResources();
  public readonly full = new ByteResources(true);
  public readonly assembly = new AssemblyResources();
  public readonly verified = new VerifiedResources();
  public snapshot() {
    return {
      live: this.metadata.live + this.response.live + this.full.live +
        this.assembly.live + this.verified.live
    };
  }
}

class ByteResources implements BoundedBodyByteResourceHost {
  public readonly reservations: number[] = [];
  public promotions = 0;
  public live = 0;
  readonly #promotable: boolean;
  public constructor(promotable = false) { this.#promotable = promotable; }
  public reserve(byteLength: number): BoundedBodyByteLease {
    this.reservations.push(byteLength);
    this.live += byteLength;
    const owned = lease(() => { this.live -= byteLength; });
    return this.#promotable
      ? {
          ...owned,
          promoteToAssetFull: () => { this.promotions += 1; }
        }
      : owned;
  }
}

class AssemblyResources implements BlobAssemblyResourceHost {
  public readonly reservations: number[] = [];
  public live = 0;
  public reserve(byteLength: number): BlobAssemblyLease {
    this.reservations.push(byteLength);
    this.live += byteLength;
    return lease(() => { this.live -= byteLength; });
  }
}

class VerifiedResources implements VerifiedBlobResourceHost {
  public readonly reservations: Array<Readonly<{
    category: VerifiedBlobResourceCategory;
    byteLength: number;
  }>> = [];
  public live = 0;
  public reserve(
    category: VerifiedBlobResourceCategory,
    byteLength: number
  ): VerifiedBlobPersistentLease {
    this.reservations.push({ category, byteLength });
    this.live += byteLength;
    return lease(() => { this.live -= byteLength; });
  }
}

function lease(onRelease: () => void) {
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      onRelease();
    }
  };
}

class PassiveTimerHost implements LoadWatchdogTimerHost {
  public now(): number { return 0; }
  public setTimeout(): object { return {}; }
  public clearTimeout(): void {}
}

class ManualTimerHost implements LoadWatchdogTimerHost {
  readonly #tasks = new Map<number, Readonly<{
    deadline: number;
    callback: () => void;
  }>>();
  #nextId = 1;
  #now = 0;
  public get pendingCount(): number { return this.#tasks.size; }
  public now(): number { return this.#now; }
  public setTimeout(callback: () => void, milliseconds: number): number {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#tasks.set(id, { deadline: this.#now + milliseconds, callback });
    return id;
  }
  public clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.#tasks.delete(handle);
  }
  public advance(milliseconds: number): void {
    this.#now += milliseconds;
    while (true) {
      const due = [...this.#tasks]
        .filter(([, task]) => task.deadline <= this.#now)
        .sort((left, right) => left[1].deadline - right[1].deadline)[0];
      if (due === undefined) return;
      this.#tasks.delete(due[0]);
      due[1].callback();
    }
  }
}

function zeroDigestAdapter(): Sha256DigestAdapter {
  return { async digestSha256() { return new Uint8Array(32); } };
}

function validatingZeroDigestAdapter(
  valid: readonly Uint8Array[]
): Sha256DigestAdapter {
  return {
    async digestSha256(bytes) {
      const matches = valid.some((expected) => equalBytes(expected, bytes));
      return new Uint8Array(32).fill(matches ? 0 : 1);
    }
  };
}

function allBlobBytes(asset: Uint8Array): readonly Uint8Array[] {
  const front = validateCompleteAsset({ bytes: asset }).frontIndex;
  return [...front.unitBlobs, ...front.staticBlobs].map((blob) =>
    asset.slice(blob.offset, blob.offset + blob.length)
  );
}

function staticBytes(asset: Uint8Array, staticFrame: string): Uint8Array {
  const blob = validateCompleteAsset({ bytes: asset }).frontIndex.staticBlobs
    .find((entry) => entry.staticFrame === staticFrame)!;
  return asset.slice(blob.offset, blob.offset + blob.length);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}
