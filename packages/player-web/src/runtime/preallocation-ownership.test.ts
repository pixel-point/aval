import { decodePngRgba, type PngDecodePlan } from "@rendered-motion/format";
import { describe, expect, it, vi } from "vitest";

import { RuntimeAssetCatalog } from "./asset-catalog.js";
import { createOpaqueTestAsset } from "./asset-test-fixture.js";
import { RuntimePlaybackError, normalizeRuntimeFailure } from "./errors.js";
import {
  BrowserStaticSurfaceDecoder,
  StaticSurfaceStore,
  type BrowserStaticDecoderResourceCategory,
  type BrowserStaticDecoderResourceHost,
  type DecodedStaticSurface,
  type StaticPresentationPlane,
  type StaticSurfaceCatalogView,
  type StaticSurfaceDecoder
} from "./static-surfaces.js";

describe("M7 allocation-before-reservation ownership", () => {
  it("reserves the exact PNG copy before catalog allocation and media work", async () => {
    const catalog = new RuntimeAssetCatalog(createOpaqueTestAsset());
    const pngBytes = catalog.staticFrames.require("idle").range.length;
    const events: string[] = [];
    const resources = new StaticTransientResources(events);
    const originalCopy = catalog.copyStaticPng.bind(catalog);
    const copy = vi.spyOn(catalog, "copyStaticPng").mockImplementation((id) => {
      events.push("copy");
      return originalCopy(id);
    });
    const pure = vi.fn((plan: PngDecodePlan) => {
      events.push("pure");
      return decodePngRgba(plan);
    });
    const decoder = new BrowserStaticSurfaceDecoder({
      resourceHost: resources,
      nativeInflater: null,
      pureDecode: pure,
      createBitmap: async (_rgba, width, height) => {
        events.push("bitmap");
        return fakeBitmap(width, height);
      }
    });
    const store = new StaticSurfaceStore(catalog, decoder, new NoopPlane());

    await store.installInitial();

    expect(events[0]).toBe(`reserve:png-copy:${String(pngBytes)}`);
    expect(events.indexOf("copy")).toBeGreaterThan(
      events.indexOf(`reserve:png-copy:${String(pngBytes)}`)
    );
    expect(events.indexOf("pure")).toBeGreaterThan(
      events.findIndex((event) => event.startsWith("reserve:png-scratch:"))
    );
    expect(events.indexOf("bitmap")).toBeGreaterThan(events.indexOf("pure"));
    expect(copy).toHaveBeenCalledOnce();
    expect(resources.liveBytes).toBe(0);
    store.dispose();
    catalog.dispose();
  });

  it("rejects a PNG copy one byte over its budget before allocation or media", async () => {
    const catalog = new RuntimeAssetCatalog(createOpaqueTestAsset());
    const pngBytes = catalog.staticFrames.require("idle").range.length;
    const events: string[] = [];
    const resources = new StaticTransientResources(events, pngBytes - 1);
    const copy = vi.spyOn(catalog, "copyStaticPng");
    const pure = vi.fn(decodePngRgba);
    const createBitmap = vi.fn(async (_rgba, width: number, height: number) =>
      fakeBitmap(width, height));
    const decoder = new BrowserStaticSurfaceDecoder({
      resourceHost: resources,
      nativeInflater: null,
      pureDecode: pure,
      createBitmap
    });
    const store = new StaticSurfaceStore(catalog, decoder, new NoopPlane());

    await expect(store.installInitial()).rejects.toMatchObject({
      code: "resource-rejection"
    });

    expect(events).toEqual([`reserve:png-copy:${String(pngBytes)}`]);
    expect(copy).not.toHaveBeenCalled();
    expect(pure).not.toHaveBeenCalled();
    expect(createBitmap).not.toHaveBeenCalled();
    expect(resources.liveBytes).toBe(0);
    expect(store.snapshot()).toMatchObject({
      retainedSurfaces: 0,
      leaseReservations: 1,
      leaseReleases: 1
    });
    store.dispose();
    catalog.dispose();
  });

  it("rechecks cancellation after reservation before invoking the copy callback", async () => {
    const catalog = new RuntimeAssetCatalog(createOpaqueTestAsset());
    const events: string[] = [];
    let store!: StaticSurfaceStore;
    const resources = new StaticTransientResources(
      events,
      Number.MAX_SAFE_INTEGER,
      (category) => {
        if (category === "png-copy") store.dispose();
      }
    );
    const copy = vi.spyOn(catalog, "copyStaticPng");
    const pure = vi.fn(decodePngRgba);
    const createBitmap = vi.fn(async (_rgba, width: number, height: number) =>
      fakeBitmap(width, height));
    const decoder = new BrowserStaticSurfaceDecoder({
      resourceHost: resources,
      nativeInflater: null,
      pureDecode: pure,
      createBitmap
    });
    store = new StaticSurfaceStore(catalog, decoder, new NoopPlane());

    await expect(store.installInitial()).rejects.toMatchObject({
      name: "AbortError"
    });

    expect(copy).not.toHaveBeenCalled();
    expect(pure).not.toHaveBeenCalled();
    expect(createBitmap).not.toHaveBeenCalled();
    expect(resources.liveBytes).toBe(0);
    expect(store.snapshot()).toMatchObject({
      state: "disposed",
      leaseReservations: 1,
      leaseReleases: 1
    });
    catalog.dispose();
  });

  it.each(["throw", "short"] as const)(
    "releases the PNG-copy lease when the catalog copy is %s",
    async (failure) => {
      const catalog = new RuntimeAssetCatalog(createOpaqueTestAsset());
      const events: string[] = [];
      const resources = new StaticTransientResources(events);
      const originalCopy = catalog.copyStaticPng.bind(catalog);
      const view: StaticSurfaceCatalogView = {
        manifest: catalog.manifest,
        copyStaticPng(id) {
          events.push("copy");
          if (failure === "throw") throw new Error("injected PNG copy failure");
          return originalCopy(id).subarray(1);
        }
      };
      const pure = vi.fn(decodePngRgba);
      const createBitmap = vi.fn(async (_rgba, width: number, height: number) =>
        fakeBitmap(width, height));
      const decoder = new BrowserStaticSurfaceDecoder({
        resourceHost: resources,
        nativeInflater: null,
        pureDecode: pure,
        createBitmap
      });
      const store = new StaticSurfaceStore(view, decoder, new NoopPlane());

      await expect(store.installInitial()).rejects.toBeDefined();

      expect(events[0]).toMatch(/^reserve:png-copy:/);
      expect(events[1]).toBe("copy");
      expect(events.at(-1)).toBe("release:png-copy");
      expect(pure).not.toHaveBeenCalled();
      expect(createBitmap).not.toHaveBeenCalled();
      expect(resources.liveBytes).toBe(0);
      expect(store.snapshot()).toMatchObject({
        retainedSurfaces: 0,
        leaseReservations: 1,
        leaseReleases: 1
      });
      store.dispose();
      catalog.dispose();
    }
  );

  it("keeps the eager-copy compatibility adapter for custom decoders explicit", async () => {
    const catalog = new RuntimeAssetCatalog(createOpaqueTestAsset());
    const events: string[] = [];
    const originalCopy = catalog.copyStaticPng.bind(catalog);
    const view: StaticSurfaceCatalogView = {
      manifest: catalog.manifest,
      copyStaticPng(id) {
        events.push("copy");
        return originalCopy(id);
      }
    };
    const decoder: StaticSurfaceDecoder<DecodedStaticSurface> = {
      async decode() {
        events.push("decode");
        return fakeSurface(64, 64);
      }
    };
    const store = new StaticSurfaceStore(view, decoder, new NoopPlane());

    await store.installInitial();

    expect(events).toEqual(["copy", "decode"]);
    store.dispose();
    catalog.dispose();
  });
});

class StaticTransientResources implements BrowserStaticDecoderResourceHost {
  public liveBytes = 0;

  public constructor(
    readonly events: string[],
    readonly maximumPngCopyBytes = Number.MAX_SAFE_INTEGER,
    readonly onReserve: (
      category: BrowserStaticDecoderResourceCategory
    ) => void = () => undefined
  ) {}

  public reserve(
    category: BrowserStaticDecoderResourceCategory,
    byteLength: number
  ) {
    this.events.push(`reserve:${category}:${String(byteLength)}`);
    this.onReserve(category);
    if (category === "png-copy" && byteLength > this.maximumPngCopyBytes) {
      throw new RuntimePlaybackError(normalizeRuntimeFailure(
        "resource-rejection"
      ));
    }
    this.liveBytes += byteLength;
    let released = false;
    return Object.freeze({
      release: () => {
        if (released) return;
        released = true;
        this.liveBytes -= byteLength;
        this.events.push(`release:${category}`);
      }
    });
  }
}

class NoopPlane implements StaticPresentationPlane<DecodedStaticSurface> {
  public present(): void {}
  public coverStatic(): void {}
  public revealAnimated(): void {}
}

function fakeBitmap(width: number, height: number): ImageBitmap {
  return { width, height, close() {} } as ImageBitmap;
}

function fakeSurface(width: number, height: number): DecodedStaticSurface {
  return Object.freeze({ width, height, close() {} });
}
