import { describe, expect, it } from "vitest";
import type {
  AvalCrossOrigin,
  AvalFit,
  AvalMotion
} from "@pixel-point/aval-element";

import {
  normalizeSources,
  normalizeUseAvalOptions,
  sameRenderOptions
} from "./sources.js";
import type { AvalSources } from "./types.js";

describe("AVAL React sources", () => {
  it("normalizes URL strings in fixed codec priority", () => {
    expect(normalizeSources({
      h264: "/motion/h264.avl",
      av1: "/motion/av1.avl",
      h265: "/motion/h265.avl",
      vp9: "/motion/vp9.avl"
    })).toEqual([
      { codec: "av1", src: "/motion/av1.avl" },
      { codec: "vp9", src: "/motion/vp9.avl" },
      { codec: "h265", src: "/motion/h265.avl" },
      { codec: "h264", src: "/motion/h264.avl" }
    ]);
  });

  it("rejects empty, descriptor, and unknown runtime inputs", () => {
    expect(() => normalizeSources({} as AvalSources)).toThrow(
      /at least one codec URL/u
    );
    expect(() => normalizeSources({ h264: "  " })).toThrow(
      /non-empty URL string/u
    );
    expect(() => normalizeSources({
      h264: { src: "/motion.avl" }
    } as unknown as AvalSources)).toThrow(/URL string/u);
    expect(() => normalizeSources({
      gif: "/motion.gif"
    } as unknown as AvalSources)).toThrow(/unsupported/u);
    expect(() => normalizeSources({
      h264: undefined
    } as unknown as AvalSources)).toThrow(/URL string/u);
    expect(() => normalizeSources({
      h264: "/motion.avl",
      [Symbol("codec")]: "/symbol.avl"
    } as unknown as AvalSources)).toThrow(/unsupported/u);
  });

  it("applies boolean defaults and compares inline objects semantically", () => {
    const first = normalizeUseAvalOptions({
      sources: { h264: "/motion.avl" }
    });
    const second = normalizeUseAvalOptions({
      sources: { h264: "/motion.avl" }
    });

    expect(first.render).toMatchObject({
      autoplay: true,
      autoBind: true
    });
    expect(first.render).not.toBe(second.render);
    expect(sameRenderOptions(first.render, second.render)).toBe(true);
    expect(sameRenderOptions(first.render, normalizeUseAvalOptions({
      sources: { h264: "/other.avl" }
    }).render)).toBe(false);
  });

  it("passes element-owned option values through without duplicating policy", () => {
    const normalized = normalizeUseAvalOptions({
      sources: { h264: "/motion.avl" },
      motion: "future-motion" as AvalMotion,
      fit: "future-fit" as AvalFit,
      crossOrigin: "future-origin" as AvalCrossOrigin
    });

    expect(normalized.render).toMatchObject({
      motion: "future-motion",
      fit: "future-fit",
      crossOrigin: "future-origin"
    });
  });
});
