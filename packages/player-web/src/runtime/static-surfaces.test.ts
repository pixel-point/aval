import type { CompiledManifestV01 } from "@rendered-motion/format";
import { describe, expect, it } from "vitest";

import {
  BrowserStaticCanvasPlane,
  BrowserStaticSurfaceDecoder,
  StaticSurfaceStore,
  StaticSurfaceStoreDisposedError,
  StaticSurfaceDecodeTimeoutError,
  type BrowserDecodedStaticSurface,
  type DecodedStaticSurface,
  type StaticPresentationPlane,
  type StaticSurfaceCatalogView,
  type StaticSurfaceDecoder
} from "./static-surfaces.js";

describe("bounded static surface store", () => {
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

  it("browser decoder closes a bitmap when abort wins and closes success idempotently", async () => {
    const pending = deferred<ImageBitmap>();
    const decoder = new BrowserStaticSurfaceDecoder(() => pending.promise);
    const controller = new AbortController();
    const operation = decoder.decode(new Uint8Array([1]), {
      signal: controller.signal
    });
    controller.abort();
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    const abortedBitmap = fakeBitmap();
    pending.resolve(abortedBitmap.bitmap);
    await Promise.resolve();
    expect(abortedBitmap.closeCalls()).toBe(1);

    const successBitmap = fakeBitmap();
    const successDecoder = new BrowserStaticSurfaceDecoder(async () =>
      successBitmap.bitmap
    );
    const surface = await successDecoder.decode(new Uint8Array([1]), {
      signal: new AbortController().signal
    });
    surface.close();
    surface.close();
    expect(successBitmap.closeCalls()).toBe(1);
  });

  it("bounds a native image decode that never settles", async () => {
    const callbacks: Array<() => void> = [];
    const decoder = new BrowserStaticSurfaceDecoder(
      () => new Promise<ImageBitmap>(() => undefined),
      {
        timeoutMs: 10,
        timers: {
          setTimeout(callback) {
            callbacks.push(callback);
            return callbacks.length;
          },
          clearTimeout() {}
        }
      }
    );
    const operation = decoder.decode(new Uint8Array([1]), {
      signal: new AbortController().signal
    });
    expect(callbacks).toHaveLength(1);

    callbacks[0]!();

    await expect(operation).rejects.toBeInstanceOf(
      StaticSurfaceDecodeTimeoutError
    );
  });

  it("browser canvas plane draws before visibility and remains a narrow host adapter", () => {
    const events: string[] = [];
    const context = {
      drawImage() {
        events.push("draw");
      },
      clearRect() {
        events.push("clear");
      }
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
      width: 0,
      height: 0,
      getContext() {
        return context;
      }
    } as unknown as HTMLCanvasElement;
    const plane = new BrowserStaticCanvasPlane(canvas, (visible) => {
      events.push(visible ? "show" : "hide");
    });
    const surface = {
      image: fakeBitmap().bitmap,
      width: 4,
      height: 3,
      close() {}
    } satisfies BrowserDecodedStaticSurface;

    plane.present(surface, 4, 3);
    plane.revealAnimated();
    plane.coverStatic();
    plane.dispose();
    plane.dispose();
    expect(events).toEqual(["draw", "show", "hide", "show", "clear", "hide"]);
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

function createFixture() {
  const catalog = new FakeCatalog();
  const decoder = new FakeDecoder();
  const plane = new FakePlane();
  const store = new StaticSurfaceStore(catalog, decoder, plane);
  return { catalog, decoder, plane, store };
}

class FakeCatalog implements StaticSurfaceCatalogView {
  public readonly manifest = staticManifest();
  public readonly copies: string[] = [];

  public copyStaticPng(staticFrame: string): Uint8Array {
    this.copies.push(staticFrame);
    return new TextEncoder().encode(staticFrame);
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

function staticManifest(): CompiledManifestV01 {
  const staticFrames = ["done", "hover", "shared"].map((id, index) => ({
    id,
    offset: 100 + index,
    length: 1,
    width: 4,
    height: 3,
    sha256: "0".repeat(64)
  }));
  return {
    formatVersion: "0.1",
    generator: "static-test",
    canvas: {
      width: 4,
      height: 3,
      fit: "contain",
      pixelAspect: [1, 1],
      colorSpace: "srgb"
    },
    frameRate: { numerator: 30, denominator: 1 },
    renditions: [],
    units: [],
    staticFrames,
    initialState: "idle",
    states: [
      { id: "alt", bodyUnit: "body-alt", staticFrame: "shared" },
      { id: "done", bodyUnit: "body-done", staticFrame: "done" },
      { id: "hover", bodyUnit: "body-hover", staticFrame: "hover" },
      { id: "idle", bodyUnit: "body-idle", staticFrame: "shared" }
    ],
    edges: [],
    bindings: [],
    readiness: {
      policy: "all-routes",
      bootstrapUnits: [],
      immediateEdges: []
    },
    fallback: {
      unsupported: "per-state-static",
      reducedMotion: "per-state-static"
    },
    limits: {
      maxCompiledBytes: 1,
      maxRuntimeBytes: 1,
      decodedPixelBytes: 0,
      persistentCacheBytes: 0,
      runtimeWorkingSetBytes: 0
    }
  };
}

function fakeBitmap(): {
  readonly bitmap: ImageBitmap;
  closeCalls(): number;
} {
  let closes = 0;
  return {
    bitmap: {
      width: 4,
      height: 3,
      close() {
        closes += 1;
      }
    } as ImageBitmap,
    closeCalls: () => closes
  };
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
