import { describe, expect, it, vi } from "vitest";

import {
  selectRendererBackend,
  WebGlUnavailableError
} from "../src/renderer-selection.js";

describe("renderer backend selection", () => {
  it("selects Canvas2D only for the exact WebGL-null discriminator", () => {
    const primary = vi.fn(() => {
      throw new WebGlUnavailableError();
    });
    const fallback = Object.freeze({ backend: "canvas2d" as const });
    const secondary = vi.fn(() => fallback);

    expect(selectRendererBackend(primary, secondary)).toBe(fallback);
    expect(primary).toHaveBeenCalledOnce();
    expect(secondary).toHaveBeenCalledOnce();
  });

  it.each([
    new Error("getContext threw"),
    new DOMException("context was already lost", "InvalidStateError")
  ])("preserves every non-null WebGL failure without probing Canvas2D", (reason) => {
    const secondary = vi.fn(() => Object.freeze({ backend: "canvas2d" as const }));

    expect(() => selectRendererBackend(() => { throw reason; }, secondary))
      .toThrow(reason);
    expect(secondary).not.toHaveBeenCalled();
  });

  it("preserves the Canvas2D construction failure as the single terminal cause", () => {
    const reason = new Error("Canvas2D is unavailable");

    expect(() => selectRendererBackend(
      () => { throw new WebGlUnavailableError(); },
      () => { throw reason; }
    )).toThrow(reason);
  });
});
