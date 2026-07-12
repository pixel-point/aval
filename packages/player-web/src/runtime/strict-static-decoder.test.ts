import {
  FormatError,
  decodePngRgba,
  validatePngProfile,
  type PngDecodePlan
} from "@rendered-motion/format";
import { describe, expect, it, vi } from "vitest";

import { strictTestPng } from "./asset-test-fixture.js";
import {
  BrowserStaticSurfaceDecoder,
  StaticSurfaceDecodeTimeoutError,
  type BrowserStaticDecoderResourceHost
} from "./strict-static-decoder.js";
import { RuntimePlaybackError, normalizeRuntimeFailure } from "./errors.js";

describe("strict browser static decoder", () => {
  it("accepts native output only after independent RGBA validation", async () => {
    const pure = vi.fn<(plan: PngDecodePlan) => ReturnType<typeof decodePngRgba>>(
      decodePngRgba
    );
    const bitmap = fakeBitmap(4, 3);
    const decoder = new BrowserStaticSurfaceDecoder({
      nativeInflater: {
        supported: true,
        async inflate(_zlib, expected) {
          const filtered = filteredTransparentBlack(4, 3);
          expect(filtered).toHaveLength(expected);
          return filtered;
        }
      },
      pureDecode: pure,
      createBitmap: async (rgba, width, height) => {
        expect(rgba).toHaveLength(4 * 3 * 4);
        expect([width, height]).toEqual([4, 3]);
        return bitmap.bitmap;
      }
    });

    const surface = await decoder.decode(strictTestPng(4, 3), decodeOptions());

    expect(surface.inflatePath).toBe("native");
    expect(pure).not.toHaveBeenCalled();
    expect(decoder.snapshot()).toMatchObject({
      nativeAttempts: 1,
      nativeSuccesses: 1,
      pureAttempts: 0,
      pureSuccesses: 0,
      peakRgbaBytes: 48
    });
    surface.close();
    surface.close();
    expect(bitmap.closeCalls()).toBe(1);
    expect(decoder.snapshot().bitmapCloses).toBe(1);
  });

  it("reserves exact PNG, zlib, and scratch ownership before decode allocations", async () => {
    const png = strictTestPng(4, 3);
    const plan = validatePngProfile({
      png,
      expectedWidth: 4,
      expectedHeight: 3
    });
    const events: string[] = [];
    const active = new Map<string, number>();
    const resourceHost: BrowserStaticDecoderResourceHost = {
      reserve(category, byteLength) {
        events.push(`reserve:${category}:${String(byteLength)}`);
        active.set(category, (active.get(category) ?? 0) + byteLength);
        let released = false;
        return {
          release() {
            if (released) return;
            released = true;
            events.push(`release:${category}`);
            active.set(category, (active.get(category) ?? 0) - byteLength);
          }
        };
      }
    };
    const decoder = new BrowserStaticSurfaceDecoder({
      resourceHost,
      nativeInflater: {
        supported: true,
        async inflate(_zlib, expected) {
          events.push("inflate");
          const filtered = filteredTransparentBlack(4, 3);
          expect(filtered).toHaveLength(expected);
          return filtered;
        }
      },
      createBitmap: async () => fakeBitmap(4, 3).bitmap
    });

    const surface = await decoder.decode(png, decodeOptions());

    expect(events.slice(0, 4)).toEqual([
      `reserve:png-copy:${String(png.byteLength)}`,
      `reserve:png-zlib:${String(plan.zlibByteLength)}`,
      `reserve:png-scratch:${String(Math.max(
        plan.zlibByteLength + plan.expectedFilteredBytes * 2,
        plan.expectedFilteredBytes + plan.expectedRgbaBytes
      ))}`,
      "inflate"
    ]);
    expect([...active.values()].every((bytes) => bytes === 0)).toBe(true);
    surface.close();
  });

  it("rolls back earlier static transient leases when later admission fails", async () => {
    const releases: string[] = [];
    const decoder = new BrowserStaticSurfaceDecoder({
      resourceHost: {
        reserve(category) {
          if (category === "png-scratch") {
            throw new RuntimePlaybackError(normalizeRuntimeFailure(
              "resource-rejection"
            ));
          }
          return { release: () => releases.push(category) };
        }
      },
      nativeInflater: null
    });

    await expect(decoder.decode(strictTestPng(4, 3), decodeOptions()))
      .rejects.toMatchObject({ code: "resource-rejection" });
    expect(releases).toEqual(["png-zlib", "png-copy"]);
  });

  it("uses pure inflate only when the initial native capability is absent", async () => {
    const pure = vi.fn(decodePngRgba);
    const decoder = new BrowserStaticSurfaceDecoder({
      nativeInflater: null,
      pureDecode: pure,
      createBitmap: async () => fakeBitmap(4, 3).bitmap
    });

    const surface = await decoder.decode(strictTestPng(4, 3), decodeOptions());

    expect(surface.inflatePath).toBe("pure");
    expect(pure).toHaveBeenCalledOnce();
    expect(decoder.snapshot()).toMatchObject({
      nativeAttempts: 0,
      pureAttempts: 1,
      pureSuccesses: 1
    });
    surface.close();
  });

  it.each([
    ["native throw", async () => { throw new Error("corrupt native stream"); }],
    ["short native output", async () => new Uint8Array(1)],
    ["long native output", async (_zlib: Uint8Array, expected: number) =>
      new Uint8Array(expected + 1)]
  ] as const)("never retries pure decode after %s", async (_label, inflate) => {
    const pure = vi.fn(decodePngRgba);
    const decoder = new BrowserStaticSurfaceDecoder({
      nativeInflater: { supported: true, inflate },
      pureDecode: pure,
      createBitmap: async () => fakeBitmap(4, 3).bitmap
    });

    await expect(decoder.decode(strictTestPng(4, 3), decodeOptions()))
      .rejects.toBeDefined();
    expect(pure).not.toHaveBeenCalled();
    expect(decoder.snapshot()).toMatchObject({
      nativeAttempts: 1,
      nativeSuccesses: 0,
      pureAttempts: 0,
      errors: 1
    });
  });

  it("rejects corrupt PNG before either inflater receives bytes", async () => {
    const native = vi.fn(async () => new Uint8Array());
    const pure = vi.fn(decodePngRgba);
    const decoder = new BrowserStaticSurfaceDecoder({
      nativeInflater: { supported: true, inflate: native },
      pureDecode: pure,
      createBitmap: async () => fakeBitmap(4, 3).bitmap
    });
    const corrupt = strictTestPng(4, 3);
    const terminal = corrupt.length - 1;
    corrupt[terminal] = corrupt[terminal]! ^ 1;

    await expect(decoder.decode(corrupt, decodeOptions())).rejects.toBeDefined();
    expect(native).not.toHaveBeenCalled();
    expect(pure).not.toHaveBeenCalled();
  });

  it("bounds bitmap creation and closes a bitmap that arrives after timeout", async () => {
    const callbacks: Array<() => void> = [];
    let resolve!: (image: ImageBitmap) => void;
    const pending = new Promise<ImageBitmap>((done) => { resolve = done; });
    const late = fakeBitmap(4, 3);
    const decoder = new BrowserStaticSurfaceDecoder({
      nativeInflater: null,
      createBitmap: () => pending,
      timeoutMs: 10,
      timers: {
        setTimeout(callback) {
          callbacks.push(callback);
          return callbacks.length;
        },
        clearTimeout() {}
      }
    });
    const operation = decoder.decode(strictTestPng(4, 3), decodeOptions());
    callbacks[0]!();

    await expect(operation).rejects.toBeInstanceOf(
      StaticSurfaceDecodeTimeoutError
    );
    resolve(late.bitmap);
    await Promise.resolve();
    await Promise.resolve();
    expect(late.closeCalls()).toBe(1);
    expect(decoder.snapshot().bitmapCloses).toBe(1);
  });

  it.each(["width", "height"] as const)(
    "retires the exact bitmap and redacts a throwing %s accessor",
    async (throwingField) => {
      const secret = `/private/${throwingField}-bitmap-secret`;
      let closeReads = 0;
      let closeCalls = 0;
      let closeReceiver: unknown;
      let widthReads = 0;
      let heightReads = 0;
      const bitmap = Object.create(null) as ImageBitmap;
      Object.defineProperties(bitmap, {
        close: {
          configurable: true,
          get() {
            closeReads += 1;
            return function(this: unknown): void {
              closeCalls += 1;
              closeReceiver = this;
            };
          }
        },
        width: {
          configurable: true,
          get() {
            widthReads += 1;
            if (throwingField === "width") throw new RangeError(secret);
            return 4;
          }
        },
        height: {
          configurable: true,
          get() {
            heightReads += 1;
            if (throwingField === "height") throw new RangeError(secret);
            return 3;
          }
        }
      });
      const decoder = new BrowserStaticSurfaceDecoder({
        nativeInflater: null,
        createBitmap: async () => bitmap
      });

      const failure = await decoder.decode(
        strictTestPng(4, 3),
        decodeOptions()
      ).catch((error: unknown) => error);

      expect(failure).toMatchObject({
        code: "PNG_DEFLATE_INVALID",
        message: "validated static pixels could not create a browser surface"
      });
      expect((failure as Error).message).not.toContain("private");
      expect(closeReads).toBe(1);
      expect(closeCalls).toBe(1);
      expect(closeReceiver).toBe(bitmap);
      expect(widthReads).toBe(1);
      expect(heightReads).toBe(throwingField === "height" ? 1 : 0);
      expect(decoder.snapshot()).toMatchObject({
        errors: 1,
        bitmapCloses: 1
      });
    }
  );

  it("retires an invalid bitmap identity without re-reading a throwing closer", async () => {
    const secret = "/private/bitmap-close-accessor-secret";
    let closeReads = 0;
    let widthReads = 0;
    let heightReads = 0;
    const bitmap = Object.create(null) as ImageBitmap;
    Object.defineProperties(bitmap, {
      close: {
        get() {
          closeReads += 1;
          throw new RangeError(secret);
        }
      },
      width: {
        get() {
          widthReads += 1;
          return 4;
        }
      },
      height: {
        get() {
          heightReads += 1;
          return 3;
        }
      }
    });
    const decoder = new BrowserStaticSurfaceDecoder({
      nativeInflater: null,
      createBitmap: async () => bitmap
    });

    const failure = await decoder.decode(
      strictTestPng(4, 3),
      decodeOptions()
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "PNG_DEFLATE_INVALID",
      message: "validated static pixels could not create a browser surface"
    });
    expect((failure as Error).message).not.toContain("private");
    expect(closeReads).toBe(1);
    expect(widthReads).toBe(0);
    expect(heightReads).toBe(0);
    expect(decoder.snapshot()).toMatchObject({
      errors: 1,
      bitmapCloses: 1
    });
  });

  it("captures toggling bitmap fields once and retires once when close throws", async () => {
    const secret = "/private/toggling-bitmap-secret";
    let closeReads = 0;
    let closeCalls = 0;
    let closeReceiver: unknown;
    let widthReads = 0;
    let heightReads = 0;
    const bitmap = Object.create(null) as ImageBitmap;
    Object.defineProperties(bitmap, {
      close: {
        get() {
          closeReads += 1;
          if (closeReads > 1) throw new RangeError(secret);
          return function(this: unknown): void {
            closeCalls += 1;
            closeReceiver = this;
            throw new RangeError(secret);
          };
        }
      },
      width: {
        get() {
          widthReads += 1;
          if (widthReads > 1) throw new RangeError(secret);
          return 4;
        }
      },
      height: {
        get() {
          heightReads += 1;
          if (heightReads > 1) throw new RangeError(secret);
          return 3;
        }
      }
    });
    const decoder = new BrowserStaticSurfaceDecoder({
      nativeInflater: null,
      createBitmap: async () => bitmap
    });

    const surface = await decoder.decode(
      strictTestPng(4, 3),
      decodeOptions()
    );

    expect(() => surface.close()).not.toThrow();
    expect(() => surface.close()).not.toThrow();
    expect(closeReads).toBe(1);
    expect(widthReads).toBe(1);
    expect(heightReads).toBe(1);
    expect(closeCalls).toBe(1);
    expect(closeReceiver).toBe(bitmap);
    expect(decoder.snapshot()).toMatchObject({
      errors: 0,
      bitmapCloses: 1
    });
  });

  it("redacts a forged format error from the bitmap factory", async () => {
    const secret = "/private/forged-format-error";
    const decoder = new BrowserStaticSurfaceDecoder({
      nativeInflater: null,
      createBitmap: async () => {
        throw new FormatError("PNG_DEFLATE_INVALID", secret);
      }
    });

    const failure = await decoder.decode(
      strictTestPng(4, 3),
      decodeOptions()
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "PNG_DEFLATE_INVALID",
      message: "validated static pixels could not create a browser surface"
    });
    expect((failure as Error).message).not.toContain("private");
    expect(decoder.snapshot()).toMatchObject({
      errors: 1,
      bitmapCloses: 0
    });
  });

  it.each(["native", "pure"] as const)(
    "redacts a forged format error from an injected %s decoder",
    async (path) => {
      const secret = `/private/${path}-format-secret`;
      const decoder = new BrowserStaticSurfaceDecoder(path === "native"
        ? {
            nativeInflater: {
              supported: true,
              async inflate() {
                throw new FormatError("PNG_DEFLATE_INVALID", secret);
              }
            }
          }
        : {
            nativeInflater: null,
            pureDecode() {
              throw new FormatError("PNG_SCANLINE_INVALID", secret);
            }
          });

      const failure = await decoder.decode(
        strictTestPng(4, 3),
        decodeOptions()
      ).catch((error: unknown) => error);

      expect(failure).toMatchObject({
        code: "PNG_DEFLATE_INVALID",
        message: path === "native"
          ? "native static inflate failed"
          : "pure static decode failed"
      });
      expect((failure as Error).message).not.toContain("private");
      expect(decoder.snapshot()).toMatchObject({
        errors: 1,
        bitmapCloses: 0
      });
    }
  );

  it("aborts native inflater ownership when the decode deadline wins", async () => {
    const callbacks: Array<() => void> = [];
    let operationSignal: AbortSignal | null = null;
    const decoder = new BrowserStaticSurfaceDecoder({
      nativeInflater: {
        supported: true,
        inflate(_zlib, _expected, signal) {
          operationSignal = signal;
          return new Promise<Uint8Array>(() => undefined);
        }
      },
      timeoutMs: 10,
      timers: {
        setTimeout(callback) {
          callbacks.push(callback);
          return callbacks.length;
        },
        clearTimeout() {}
      }
    });
    const operation = decoder.decode(strictTestPng(4, 3), decodeOptions());
    callbacks[0]!();

    await expect(operation).rejects.toBeInstanceOf(
      StaticSurfaceDecodeTimeoutError
    );
    expect(operationSignal).not.toBeNull();
    expect(operationSignal!.aborted).toBe(true);
  });
});

function decodeOptions() {
  return {
    signal: new AbortController().signal,
    expectedWidth: 4,
    expectedHeight: 3
  };
}

function filteredTransparentBlack(width: number, height: number): Uint8Array {
  const stride = width * 4 + 1;
  const filtered = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      filtered[y * stride + 1 + x * 4 + 3] = 255;
    }
  }
  return filtered;
}

function fakeBitmap(width: number, height: number) {
  let closes = 0;
  return {
    bitmap: {
      width,
      height,
      close() {
        closes += 1;
      }
    } as ImageBitmap,
    closeCalls: () => closes
  };
}
