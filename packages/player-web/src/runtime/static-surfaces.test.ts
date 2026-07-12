import type { CompiledManifestV01 } from "@rendered-motion/format";
import { describe, expect, it, vi } from "vitest";

import { strictTestPng } from "./asset-test-fixture.js";
import { FakeCatalog, fakeBitmap } from "./static-surfaces.test-support.js";
import { PageResourceManager } from "./page-resource-manager.js";
import { createRuntimePageResourcePolicy } from "./page-resource-policy.js";
import { PlayerResourceAccount } from "./player-resource-account.js";
import { createPlayerStaticSurfaceResourceHost } from "./player-resource-hosts.js";

import {
  BrowserStaticSurfaceDecoder,
  StaticSurfaceStore,
  StaticSurfaceStoreDisposedError,
  StaticSurfaceDecodeTimeoutError,
  type DecodedStaticSurface,
  type StaticPresentationPlane,
  type StaticSurfaceCatalogView,
  type StaticSurfaceDecoder,
  type StaticSurfaceStoreOptions,
  type StaticSurfaceStoreResourceHost,
  type StaticSurfaceStoreResourceLease,
  type StaticSurfaceStoreSurfaceRole
} from "./static-surfaces.js";

describe("bounded static surface store", () => {
  it("retains validated optional surfaces with an opt-in resource host", async () => {
    const resources = new FakeStaticResourceHost();
    const fixture = createFixture({
      resourceHost: resources,
      retainOptionalSurfaces: true
    });
    await fixture.store.installInitial();
    await fixture.store.validateAll();
    const callsBeforeHit = fixture.decoder.calls.length;
    const copiesBeforeHit = fixture.catalog.copies.length;

    const hover = await fixture.store.presentState("hover");

    expect(hover.redecoded).toBe(false);
    expect(fixture.decoder.calls).toHaveLength(callsBeforeHit);
    expect(fixture.catalog.copies).toHaveLength(copiesBeforeHit);
    expect(resources.snapshot()).toMatchObject({
      reservations: 3,
      releases: 0,
      active: 3,
      roles: { current: 1, incoming: 0, optional: 2 }
    });
    expect(fixture.store.snapshot()).toMatchObject({
      retainedSurfaces: 3,
      decodedSurfaces: 3,
      redecodedSurfaces: 0,
      leaseReservations: 3,
      leaseReleases: 0,
      cache: {
        retainedSurfaces: 3,
        hits: 1,
        evictions: 0
      }
    });
  });

  it("reclaims deterministic optional LRU, hard-pins current, and re-decodes from verified PNG", async () => {
    const resources = new FakeStaticResourceHost();
    const fixture = createFixture({
      resourceHost: resources,
      retainOptionalSurfaces: true
    });
    await fixture.store.installInitial();
    await fixture.store.validateAll();
    const copiesBefore = fixture.catalog.copies.length;

    expect(fixture.store.reclaimOldest()).toMatchObject({
      staticFrame: "done"
    });
    expect(fixture.store.snapshot().currentStaticFrame).toBe("shared");
    expect(resources.snapshot()).toMatchObject({ active: 2, releases: 1 });
    const report = await fixture.store.presentState("done");

    expect(report.redecoded).toBe(true);
    expect(fixture.catalog.copies).toHaveLength(copiesBefore + 1);
    expect(fixture.catalog.copies.at(-1)).toBe("done");
    expect(fixture.store.snapshot()).toMatchObject({
      currentStaticFrame: "done",
      redecodedSurfaces: 1,
      cache: { evictions: 1 }
    });
  });

  it("reserves an incoming hard pin before decode and preserves current on pressure/failure", async () => {
    const resources = new FakeStaticResourceHost();
    const fixture = createFixture({
      resourceHost: resources,
      retainOptionalSurfaces: true
    });
    await fixture.store.installInitial();
    await fixture.store.validateAll();
    const current = fixture.decoder.surfaces[0]!;
    const gate = deferred<void>();
    fixture.decoder.gates.set("done", gate.promise);
    fixture.store.reclaimOldest();
    const operation = fixture.store.presentState("done");
    await Promise.resolve();

    expect(resources.snapshot().roles.incoming).toBe(1);
    expect(current.closeCalls).toBe(0);
    expect(fixture.store.reclaimOldest()?.staticFrame).toBe("hover");
    expect(fixture.store.reclaimOldest()).toBeNull();
    fixture.decoder.fail.add("done");
    gate.resolve(undefined);

    await expect(operation).rejects.toThrow("injected decode failure");
    expect(fixture.store.snapshot().currentStaticFrame).toBe("shared");
    expect(current.closeCalls).toBe(0);
    expect(resources.snapshot()).toMatchObject({
      active: 1,
      roles: { current: 1, incoming: 0, optional: 0 }
    });
  });

  it("rejects resource pressure before copying PNG bytes or calling the decoder", async () => {
    const resources = new FakeStaticResourceHost();
    const fixture = createFixture({
      resourceHost: resources,
      retainOptionalSurfaces: true
    });
    await fixture.store.installInitial();
    const calls = fixture.decoder.calls.length;
    const copies = fixture.catalog.copies.length;
    resources.failReservations = true;

    await expect(fixture.store.presentState("hover"))
      .rejects.toThrow("injected static resource pressure");

    expect(fixture.decoder.calls).toHaveLength(calls);
    expect(fixture.catalog.copies).toHaveLength(copies);
    expect(fixture.store.snapshot().currentStaticFrame).toBe("shared");
    expect(resources.snapshot()).toMatchObject({ active: 1, reservations: 1 });
  });

  it("releases an async admission when abort-listener registration attaches then throws", async () => {
    const pending = deferred<StaticSurfaceStoreResourceLease>();
    let releases = 0;
    const fixture = createFixture({
      resourceHost: {
        reserveDecodedSurface: () => pending.promise,
        nextTouchSequence: () => 1
      },
      retainOptionalSurfaces: true
    });
    const nativeAdd = AbortSignal.prototype.addEventListener;
    const add = vi.spyOn(AbortSignal.prototype, "addEventListener")
      .mockImplementation(function (
        this: AbortSignal,
        ...args: Parameters<AbortSignal["addEventListener"]>
      ): void {
        Reflect.apply(nativeAdd, this, args);
        throw new Error("attached then failed");
      });

    const operation = fixture.store.installInitial();
    await expect(operation).rejects.toThrow("attached then failed");
    add.mockRestore();
    pending.resolve({
      setRole: () => undefined,
      release: () => { releases += 1; }
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(releases).toBe(1);
    expect(fixture.catalog.copies).toEqual([]);
    expect(fixture.decoder.calls).toEqual([]);
  });

  it("removes a caller abort listener when registration attaches then throws", () => {
    const fixture = createFixture();
    let retained: EventListenerOrEventListenerObject | null = null;
    let removals = 0;
    const signal = {
      aborted: false,
      reason: undefined,
      addEventListener(
        _type: string,
        listener: EventListenerOrEventListenerObject
      ): void {
        retained = listener;
        throw new Error("attached caller listener then failed");
      },
      removeEventListener(
        _type: string,
        listener: EventListenerOrEventListenerObject
      ): void {
        removals += 1;
        if (retained === listener) retained = null;
      }
    } as unknown as AbortSignal;

    expect(() => fixture.store.installInitial({ signal }))
      .toThrow("attached caller listener then failed");
    expect(removals).toBe(1);
    expect(retained).toBeNull();
    expect(fixture.catalog.copies).toEqual([]);
    expect(fixture.decoder.calls).toEqual([]);
  });

  it("does not retain a controller when caller listener removal throws", async () => {
    const fixture = createFixture();
    const nativeAbort = AbortController.prototype.abort;
    const abort = vi.spyOn(AbortController.prototype, "abort")
      .mockImplementation(function (
        this: AbortController,
        ...args: Parameters<AbortController["abort"]>
      ): void {
        Reflect.apply(nativeAbort, this, args);
      });
    let retained: EventListenerOrEventListenerObject | null = null;
    let removals = 0;
    const signal = {
      aborted: false,
      reason: undefined,
      addEventListener(
        _type: string,
        listener: EventListenerOrEventListenerObject
      ): void {
        retained = listener;
      },
      removeEventListener(
        _type: string,
        listener: EventListenerOrEventListenerObject
      ): void {
        removals += 1;
        if (retained === listener) retained = null;
        throw new Error("caller listener removal failed");
      }
    } as unknown as AbortSignal;

    await expect(fixture.store.installInitial({ signal })).resolves.toMatchObject({
      staticFrame: "shared"
    });
    expect(removals).toBe(1);
    expect(retained).toBeNull();

    fixture.store.dispose();
    expect(abort).not.toHaveBeenCalled();
    abort.mockRestore();
  });

  it("keeps the current cover when a later account-backed incoming surface is rejected", async () => {
    const manager = new PageResourceManager(createRuntimePageResourcePolicy({
      maximumPagePhysicalBytes: 48,
      maximumPlayerLogicalBytes: 48
    }));
    const account = new PlayerResourceAccount(manager);
    const fixture = createFixture({
      resourceHost: createPlayerStaticSurfaceResourceHost(account),
      retainOptionalSurfaces: true
    });
    await fixture.store.installInitial();
    const current = fixture.store.currentState();
    const copies = fixture.catalog.copies.length;

    await expect(fixture.store.presentState("hover"))
      .rejects.toMatchObject({ code: "resource-rejection" });

    expect(fixture.store.currentState()).toBe(current);
    expect(fixture.store.snapshot().currentStaticFrame).toBe("shared");
    expect(fixture.catalog.copies).toHaveLength(copies);
    expect(manager.snapshot()).toMatchObject({
      physicalBytes: 48,
      byteLeaseCount: 1
    });
    fixture.store.dispose();
    expect(manager.snapshot().physicalBytes).toBe(0);
    account.dispose();
  });

  it("never reclaims current or incoming surfaces during an atomic cached draw", async () => {
    const resources = new FakeStaticResourceHost();
    const fixture = createFixture({
      resourceHost: resources,
      retainOptionalSurfaces: true
    });
    await fixture.store.installInitial();
    await fixture.store.validateAll();
    const reclaimed: Array<string | null> = [];
    fixture.plane.observePresent = () => {
      reclaimed.push(fixture.store.reclaimOldest()?.staticFrame ?? null);
      reclaimed.push(fixture.store.reclaimOldest()?.staticFrame ?? null);
      fixture.plane.observePresent = null;
    };

    await fixture.store.presentState("hover");

    expect(reclaimed).toEqual(["done", null]);
    expect(fixture.store.snapshot()).toMatchObject({
      currentStaticFrame: "hover",
      retainedSurfaces: 2,
      cache: { currentStaticFrame: "hover", incomingStaticFrame: null }
    });
  });

  it("closes every cached surface and releases every lease at disposal", async () => {
    const resources = new FakeStaticResourceHost();
    const fixture = createFixture({
      resourceHost: resources,
      retainOptionalSurfaces: true
    });
    await fixture.store.installInitial();
    await fixture.store.validateAll();

    fixture.store.dispose();
    fixture.store.dispose();

    expect(resources.snapshot()).toMatchObject({
      reservations: 3,
      releases: 3,
      active: 0,
      roles: { current: 0, incoming: 0, optional: 0 }
    });
    expect(fixture.store.snapshot()).toMatchObject({
      state: "disposed",
      retainedSurfaces: 0,
      closedSurfaces: 3,
      leaseReservations: 3,
      leaseReleases: 3,
      cache: { retainedSurfaces: 0, closes: 3, releases: 3 }
    });
  });

  it("installs visual-ready, validates unique statics sequentially, and deduplicates shared IDs", async () => {
    const fixture = createFixture();
    const initial = await fixture.store.installInitial();
    const validation = await fixture.store.validateAll();

    expect(initial).toEqual({
      state: "idle",
      staticFrame: "shared",
      redecoded: true,
      rgbaBytes: 48
    });
    expect(validation).toEqual({
      uniqueStaticFrames: 3,
      newlyValidated: 2,
      validatedRgbaBytes: 144
    });
    expect(fixture.decoder.calls).toEqual(["shared", "done", "hover"]);
    expect(fixture.decoder.maximumConcurrentDecodes).toBe(1);
    expect(fixture.catalog.copies).toEqual(["shared", "done", "hover"]);
    expect(fixture.plane.events).toEqual([["present", "shared", 4, 3]]);
    expect(fixture.store.snapshot()).toMatchObject({
      currentState: "idle",
      currentStaticFrame: "shared",
      retainedSurfaces: 1,
      peakRetainedSurfaces: 2,
      validatedStaticFrames: 3,
      decodedSurfaces: 3,
      closedSurfaces: 2
    });
  });

  it("re-decodes validated noncurrent states and atomically closes the replaced surface", async () => {
    const fixture = createFixture();
    await fixture.store.installInitial();
    await fixture.store.validateAll();
    const shared = fixture.decoder.surfaces[0]!;
    fixture.plane.observePresent = () => {
      expect(shared.closeCalls).toBe(0);
      expect(fixture.decoder.openSurfaces()).toBe(2);
      fixture.plane.observePresent = null;
    };

    const hover = await fixture.store.presentState("hover");
    expect(hover.redecoded).toBe(true);
    expect(fixture.decoder.calls).toEqual([
      "shared",
      "done",
      "hover",
      "hover"
    ]);
    expect(shared.closeCalls).toBe(1);
    expect(fixture.store.snapshot()).toMatchObject({
      currentState: "hover",
      currentStaticFrame: "hover",
      retainedSurfaces: 1,
      peakRetainedSurfaces: 2
    });

    await fixture.store.presentState("alt");
    const callsBeforeSharedNoop = fixture.decoder.calls.length;
    const same = await fixture.store.presentState("idle");
    expect(same.redecoded).toBe(false);
    expect(fixture.decoder.calls).toHaveLength(callsBeforeSharedNoop);
    expect(fixture.plane.events.at(-1)).toEqual(["cover"]);
  });

  it("keeps current pixels visible when decode, geometry, or draw fails", async () => {
    const decodeFixture = createFixture();
    await decodeFixture.store.installInitial();
    const initial = decodeFixture.decoder.surfaces[0]!;
    decodeFixture.decoder.fail.add("hover");
    await expect(decodeFixture.store.presentState("hover"))
      .rejects.toThrow("injected decode failure");
    expect(initial.closeCalls).toBe(0);
    expect(decodeFixture.store.snapshot().currentStaticFrame).toBe("shared");

    const geometryFixture = createFixture();
    await geometryFixture.store.installInitial();
    geometryFixture.decoder.wrongDimensions.add("hover");
    await expect(geometryFixture.store.presentState("hover"))
      .rejects.toThrow("dimensions do not match");
    expect(geometryFixture.decoder.surfaces.at(-1)?.closeCalls).toBe(1);
    expect(geometryFixture.store.snapshot().currentStaticFrame).toBe("shared");

    const drawFixture = createFixture();
    await drawFixture.store.installInitial();
    const current = drawFixture.decoder.surfaces[0]!;
    drawFixture.plane.failPresent = true;
    await expect(drawFixture.store.presentState("hover"))
      .rejects.toThrow("injected static draw failure");
    expect(current.closeCalls).toBe(0);
    expect(drawFixture.decoder.surfaces.at(-1)?.closeCalls).toBe(1);
    expect(drawFixture.plane.presented).toBe("shared");
    expect(drawFixture.store.snapshot()).toMatchObject({
      currentStaticFrame: "shared",
      retainedSurfaces: 1,
      errors: 1
    });
  });

  it("aborts a pending decode and closes a late surface without replacing current", async () => {
    const fixture = createFixture();
    await fixture.store.installInitial();
    const gate = deferred<void>();
    fixture.decoder.gates.set("hover", gate.promise);
    const controller = new AbortController();
    const operation = fixture.store.presentState("hover", {
      signal: controller.signal
    });
    await Promise.resolve();
    controller.abort();
    gate.resolve(undefined);

    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.decoder.surfaces.at(-1)?.tag).toBe("hover");
    expect(fixture.decoder.surfaces.at(-1)?.closeCalls).toBe(1);
    expect(fixture.store.snapshot()).toMatchObject({
      currentStaticFrame: "shared",
      retainedSurfaces: 1,
      errors: 0
    });
  });

  it("serializes supersession, rejects the old request, and commits only newest pixels", async () => {
    const fixture = createFixture();
    await fixture.store.installInitial();
    const gate = deferred<void>();
    fixture.decoder.gates.set("hover", gate.promise);
    const hover = fixture.store.presentState("hover");
    await Promise.resolve();
    const done = fixture.store.presentState("done");
    gate.resolve(undefined);

    await expect(hover).rejects.toMatchObject({ name: "AbortError" });
    await expect(done).resolves.toMatchObject({ staticFrame: "done" });
    expect(fixture.plane.presented).toBe("done");
    expect(fixture.decoder.calls).toEqual(["shared", "hover", "done"]);
    expect(fixture.decoder.maximumConcurrentDecodes).toBe(1);
    expect(fixture.store.snapshot()).toMatchObject({
      currentState: "done",
      currentStaticFrame: "done",
      retainedSurfaces: 1,
      peakRetainedSurfaces: 2
    });
  });

  it("restores retained pixels when reentry supersedes a draw with an aborted successor", async () => {
    const fixture = createFixture();
    await fixture.store.installInitial();
    const initial = fixture.decoder.surfaces[0]!;
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    let successor: Promise<unknown> | null = null;
    fixture.plane.observePresent = () => {
      fixture.plane.observePresent = null;
      successor = fixture.store.presentState("done", {
        signal: alreadyAborted.signal
      });
    };

    const superseded = fixture.store.presentState("hover");

    await expect(superseded).rejects.toMatchObject({ name: "AbortError" });
    await expect(successor).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.plane.presented).toBe("shared");
    expect(initial.closeCalls).toBe(0);
    expect(fixture.decoder.surfaces.at(-1)?.tag).toBe("hover");
    expect(fixture.decoder.surfaces.at(-1)?.closeCalls).toBe(1);
    expect(fixture.store.snapshot()).toMatchObject({
      currentState: "idle",
      currentStaticFrame: "shared",
      retainedSurfaces: 1
    });
  });

  it("lets a reentrant newest request replace the provisional first surface", async () => {
    const fixture = createFixture();
    let successor: Promise<unknown> | null = null;
    fixture.plane.observePresent = () => {
      fixture.plane.observePresent = null;
      successor = fixture.store.presentState("done");
    };

    const initial = fixture.store.installInitial();

    await expect(initial).rejects.toMatchObject({ name: "AbortError" });
    await expect(successor).resolves.toMatchObject({
      state: "done",
      staticFrame: "done"
    });
    expect(fixture.plane.presented).toBe("done");
    expect(fixture.decoder.surfaces[0]?.tag).toBe("shared");
    expect(fixture.decoder.surfaces[0]?.closeCalls).toBe(1);
    expect(fixture.decoder.surfaces[1]?.tag).toBe("done");
    expect(fixture.decoder.surfaces[1]?.closeCalls).toBe(0);
    expect(fixture.store.snapshot()).toMatchObject({
      state: "active",
      currentState: "done",
      currentStaticFrame: "done",
      retainedSurfaces: 1,
      presentations: 2
    });
  });

  it("retires a decoded surface whose dimension accessor throws", async () => {
    let closes = 0;
    const decoder: StaticSurfaceDecoder = {
      async decode() {
        return {
          close() {
            closes += 1;
          },
          get width(): number {
            throw new RangeError("/private/decoded-surface-secret");
          },
          height: 3
        } as DecodedStaticSurface;
      }
    };
    const store = new StaticSurfaceStore(
      new FakeCatalog(),
      decoder,
      new FakePlane()
    );

    const failure = await store.installInitial().catch(
      (error: unknown) => error
    );

    expect(failure).toMatchObject({
      message: "decoded static surface is invalid"
    });
    expect((failure as Error).message).not.toContain("private");
    expect(closes).toBe(1);
    expect(store.snapshot()).toMatchObject({
      retainedSurfaces: 0,
      decodedSurfaces: 1,
      closedSurfaces: 1
    });
  });

  it("covers and recovers independently after animated WebGL resources fail", async () => {
    const fixture = createFixture();
    await fixture.store.installInitial();
    fixture.store.revealAnimated();
    const animatedResources = { disposed: true };

    await fixture.store.presentState("done");
    fixture.store.coverCurrent();

    expect(animatedResources.disposed).toBe(true);
    expect(fixture.plane.visible).toBe(true);
    expect(fixture.plane.presented).toBe("done");
    expect(fixture.plane.events).toEqual([
      ["present", "shared", 4, 3],
      ["reveal"],
      ["present", "done", 4, 3],
      ["cover"]
    ]);
  });

  it("disposes pending and retained surfaces exactly once and becomes final", async () => {
    const fixture = createFixture();
    await fixture.store.installInitial();
    const current = fixture.decoder.surfaces[0]!;
    const gate = deferred<void>();
    fixture.decoder.gates.set("hover", gate.promise);
    const pending = fixture.store.presentState("hover");
    await Promise.resolve();
    fixture.store.dispose();
    fixture.store.dispose();
    gate.resolve(undefined);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await fixture.store.settled();
    expect(current.closeCalls).toBe(1);
    expect(fixture.decoder.surfaces.at(-1)?.closeCalls).toBe(1);
    expect(fixture.plane.disposeCalls).toBe(1);
    expect(fixture.store.snapshot()).toMatchObject({
      state: "disposed",
      retainedSurfaces: 0
    });
    expect(() => fixture.store.presentState("idle"))
      .toThrow(StaticSurfaceStoreDisposedError);
  });

  it("does not provisionally commit after a plane reenters disposal", async () => {
    const catalog = new FakeCatalog();
    const decoder = new FakeDecoder();
    let store!: StaticSurfaceStore<FakeSurface>;
    let planeDisposals = 0;
    const plane: StaticPresentationPlane<FakeSurface> = {
      present() {
        store.dispose();
      },
      coverStatic() {},
      revealAnimated() {},
      dispose() {
        planeDisposals += 1;
      }
    };
    store = new StaticSurfaceStore(catalog, decoder, plane);

    await expect(store.installInitial())
      .rejects.toMatchObject({ name: "AbortError" });

    expect(decoder.surfaces[0]?.closeCalls).toBe(1);
    expect(planeDisposals).toBe(1);
    expect(store.snapshot()).toMatchObject({
      state: "disposed",
      currentState: null,
      currentStaticFrame: null,
      retainedSurfaces: 0,
      validatedStaticFrames: 0,
      presentations: 0,
      decodedSurfaces: 1,
      closedSurfaces: 1
    });
  });

  it("browser decoder closes a bitmap when abort wins and closes success idempotently", async () => {
    const pending = deferred<ImageBitmap>();
    const decoder = new BrowserStaticSurfaceDecoder({
      nativeInflater: null,
      createBitmap: () => pending.promise
    });
    const controller = new AbortController();
    const operation = decoder.decode(strictTestPng(4, 3), {
      signal: controller.signal,
      expectedWidth: 4,
      expectedHeight: 3
    });
    controller.abort();
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    const abortedBitmap = fakeBitmap();
    pending.resolve(abortedBitmap.bitmap);
    await Promise.resolve();
    expect(abortedBitmap.closeCalls()).toBe(1);

    const successBitmap = fakeBitmap();
    const successDecoder = new BrowserStaticSurfaceDecoder({
      nativeInflater: null,
      createBitmap: async () => successBitmap.bitmap
    });
    const surface = await successDecoder.decode(strictTestPng(4, 3), {
      signal: new AbortController().signal,
      expectedWidth: 4,
      expectedHeight: 3
    });
    surface.close();
    surface.close();
    expect(successBitmap.closeCalls()).toBe(1);
  });

  it("bounds a native image decode that never settles", async () => {
    const callbacks: Array<() => void> = [];
    const decoder = new BrowserStaticSurfaceDecoder({
      nativeInflater: null,
      createBitmap: () => new Promise<ImageBitmap>(() => undefined),
      timeoutMs: 10,
      timers: {
        setTimeout(callback) {
          callbacks.push(callback);
          return callbacks.length;
        },
        clearTimeout() {}
      }
    });
    const operation = decoder.decode(strictTestPng(4, 3), {
      signal: new AbortController().signal,
      expectedWidth: 4,
      expectedHeight: 3
    });
    expect(callbacks).toHaveLength(1);

    callbacks[0]!();

    await expect(operation).rejects.toBeInstanceOf(
      StaticSurfaceDecodeTimeoutError
    );
  });

  it("rejects unsafe aggregate static byte counters before decoding", () => {
    const catalog = new FakeCatalog();
    const manifest = {
      ...catalog.manifest,
      canvas: {
        ...catalog.manifest.canvas,
        width: 1_000_000_000,
        height: 1_000_000
      }
    } satisfies CompiledManifestV01;

    expect(() => new StaticSurfaceStore(
      {
        manifest,
        copyStaticPng: catalog.copyStaticPng.bind(catalog)
      },
      new FakeDecoder(),
      new FakePlane()
    )).toThrow("validated static bytes exceeds JavaScript's safe-integer range");
  });
});

function createFixture(options?: Readonly<StaticSurfaceStoreOptions>) {
  const catalog = new FakeCatalog();
  const decoder = new FakeDecoder();
  const plane = new FakePlane();
  const store = new StaticSurfaceStore(catalog, decoder, plane, options);
  return { catalog, decoder, plane, store };
}

class FakeStaticResourceHost implements StaticSurfaceStoreResourceHost {
  public failReservations = false;
  #touch = 0;
  #reservations = 0;
  #releases = 0;
  readonly #roles = new Map<number, StaticSurfaceStoreSurfaceRole>();

  public nextTouchSequence(): number {
    this.#touch += 1;
    return this.#touch;
  }

  public reserveDecodedSurface(): StaticSurfaceStoreResourceLease {
    if (this.failReservations) {
      throw new Error("injected static resource pressure");
    }
    this.#reservations += 1;
    const id = this.#reservations;
    this.#roles.set(id, "incoming");
    let released = false;
    return {
      setRole: (role) => {
        if (released) throw new Error("lease released");
        this.#roles.set(id, role);
      },
      release: () => {
        if (released) return;
        released = true;
        this.#roles.delete(id);
        this.#releases += 1;
      }
    };
  }

  public snapshot(): {
    readonly reservations: number;
    readonly releases: number;
    readonly active: number;
    readonly roles: Readonly<Record<StaticSurfaceStoreSurfaceRole, number>>;
  } {
    const roles = { current: 0, incoming: 0, optional: 0 };
    for (const role of this.#roles.values()) roles[role] += 1;
    return {
      reservations: this.#reservations,
      releases: this.#releases,
      active: this.#roles.size,
      roles
    };
  }
}
class FakeSurface implements DecodedStaticSurface {
  public closeCalls = 0;

  public constructor(
    public readonly tag: string,
    public readonly width = 4,
    public readonly height = 3
  ) {}

  public close(): void {
    this.closeCalls += 1;
  }
}

class FakeDecoder implements StaticSurfaceDecoder<FakeSurface> {
  public readonly calls: string[] = [];
  public readonly surfaces: FakeSurface[] = [];
  public readonly fail = new Set<string>();
  public readonly wrongDimensions = new Set<string>();
  public readonly gates = new Map<string, Promise<void>>();
  public maximumConcurrentDecodes = 0;
  #concurrentDecodes = 0;

  public async decode(png: Uint8Array): Promise<FakeSurface> {
    const tag = new TextDecoder().decode(png);
    this.calls.push(tag);
    this.#concurrentDecodes += 1;
    this.maximumConcurrentDecodes = Math.max(
      this.maximumConcurrentDecodes,
      this.#concurrentDecodes
    );
    try {
      await this.gates.get(tag);
      if (this.fail.has(tag)) throw new Error("injected decode failure");
      const surface = new FakeSurface(
        tag,
        this.wrongDimensions.has(tag) ? 5 : 4,
        3
      );
      this.surfaces.push(surface);
      return surface;
    } finally {
      this.#concurrentDecodes -= 1;
    }
  }

  public openSurfaces(): number {
    return this.surfaces.filter(({ closeCalls }) => closeCalls === 0).length;
  }
}

class FakePlane implements StaticPresentationPlane<FakeSurface> {
  public readonly events: unknown[][] = [];
  public presented: string | null = null;
  public visible = false;
  public failPresent = false;
  public disposeCalls = 0;
  public observePresent: (() => void) | null = null;

  public present(surface: FakeSurface, width: number, height: number): void {
    this.observePresent?.();
    if (this.failPresent) throw new Error("injected static draw failure");
    this.presented = surface.tag;
    this.visible = true;
    this.events.push(["present", surface.tag, width, height]);
  }

  public coverStatic(): void {
    this.visible = true;
    this.events.push(["cover"]);
  }

  public revealAnimated(): void {
    this.visible = false;
    this.events.push(["reveal"]);
  }

  public dispose(): void {
    this.disposeCalls += 1;
    this.visible = false;
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T extends void ? undefined : T): void;
} {
  let resolvePromise: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise(value as T);
    }
  };
}
