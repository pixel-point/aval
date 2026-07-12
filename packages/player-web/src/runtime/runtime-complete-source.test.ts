import { describe, expect, it, vi } from "vitest";

import {
  assertLiveRuntimeCompleteSourceRange,
  createRuntimeCompleteSource
} from "./runtime-complete-source.js";

describe("retained complete runtime source", () => {
  it("issues exact live views and revokes every view before release", () => {
    const release = vi.fn();
    const bytes = new Uint8Array(new ArrayBuffer(5));
    bytes.set([1, 2, 3, 4, 5]);
    const source = createRuntimeCompleteSource(bytes, release);
    const range = source.read(1, 3);

    expect([...range.bytes]).toEqual([2, 3, 4]);
    expect(() => assertLiveRuntimeCompleteSourceRange(range, range.bytes))
      .not.toThrow();
    expect(() => assertLiveRuntimeCompleteSourceRange(
      { bytes: range.bytes },
      range.bytes
    )).toThrow(TypeError);

    source.release();
    source.release();
    expect(release).toHaveBeenCalledOnce();
    expect(() => assertLiveRuntimeCompleteSourceRange(range, range.bytes))
      .toThrow(TypeError);
    expect(() => source.read(0, 1)).toThrow(RangeError);
  });

  it("rejects shared, sliced, empty, and out-of-bounds source ownership", () => {
    expect(() => createRuntimeCompleteSource(
      new Uint8Array(new SharedArrayBuffer(4)),
      () => {}
    )).toThrow(TypeError);
    const backing = new ArrayBuffer(4);
    expect(() => createRuntimeCompleteSource(
      new Uint8Array(backing, 1, 2),
      () => {}
    )).toThrow(TypeError);
    expect(() => createRuntimeCompleteSource(new Uint8Array(), () => {}))
      .toThrow(TypeError);

    const source = createRuntimeCompleteSource(new Uint8Array(4), () => {});
    expect(() => source.read(-1, 1)).toThrow(RangeError);
    expect(() => source.read(0, 0)).toThrow(RangeError);
    expect(() => source.read(4, 1)).toThrow(RangeError);
  });
});
