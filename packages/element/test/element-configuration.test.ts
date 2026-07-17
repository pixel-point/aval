import { describe, expect, it } from "vitest";

import { ElementAttributeReflection } from "../src/element-attribute-reflection.js";
import {
  normalizeAutoplay,
  normalizeAutoplayAttribute,
  normalizeBindings,
  normalizeBindingsAttribute,
  normalizeCrossOrigin,
  normalizeCrossOriginAttribute,
  normalizeFit,
  normalizeFitAttribute,
  normalizeIntegrity,
  normalizeInteractionFor,
  normalizeInteractionForAttribute,
  normalizeMotion,
  normalizeMotionAttribute,
  normalizeSize,
  normalizeSizeAttribute,
  normalizeSource,
  normalizeState,
  normalizeStateAttribute
} from "../src/element-configuration.js";

describe("element configuration", () => {
  it("normalizes the exact declarative defaults", () => {
    expect(normalizeCrossOriginAttribute(null)).toBe("anonymous");
    expect(normalizeMotionAttribute(null)).toBe("auto");
    expect(normalizeAutoplayAttribute(null)).toBe("visible");
    expect(normalizeFitAttribute(null)).toBeNull();
    expect(normalizeBindingsAttribute(null)).toBe("auto");
    expect(normalizeStateAttribute(null)).toBeNull();
    expect(normalizeInteractionForAttribute(null)).toBe("");
    expect(normalizeSizeAttribute(null)).toBeNull();
  });

  it("enforces every closed property and bound", () => {
    expect(normalizeMotion("reduce")).toBe("reduce");
    expect(normalizeAutoplay("manual")).toBe("manual");
    expect(normalizeBindings("none")).toBe("none");
    expect(normalizeCrossOrigin("use-credentials")).toBe("use-credentials");
    expect(normalizeFit("cover")).toBe("cover");
    expect(normalizeFit(null)).toBeNull();
    expect(normalizeState("custom.success")).toBe("custom.success");
    expect(normalizeSize(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(normalizeSource("x".repeat(4_096))).toHaveLength(4_096);
    expect(normalizeInteractionFor("x".repeat(256))).toHaveLength(256);
    expect(normalizeIntegrity("sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="))
      .toMatch(/^sha256-/u);
    for (const invalid of ["system", "none", true, null]) {
      expect(() => normalizeMotion(invalid)).toThrow();
    }
    expect(() => normalizeState("Hovered State")).toThrow();
    expect(() => normalizeSize(0)).toThrow();
    expect(() => normalizeSize(Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => normalizeSource("")).toThrow();
    expect(() => normalizeIntegrity("")).toThrow();
    expect(() => normalizeSource("x".repeat(4_097))).toThrow();
    expect(() => normalizeInteractionFor("x".repeat(257))).toThrow();
  });

  it("accepts safe-integer size attributes above the former element cap", () => {
    expect(normalizeSizeAttribute("1048576")).toBe(1_048_576);
    expect(normalizeSizeAttribute(String(Number.MAX_SAFE_INTEGER)))
      .toBe(Number.MAX_SAFE_INTEGER);
    expect(normalizeSizeAttribute("000000000000000001048576")).toBe(1_048_576);
  });

  it("rejects hostile reflected attribute values", () => {
    expect(() => normalizeMotionAttribute("maybe")).toThrow();
    expect(() => normalizeCrossOriginAttribute("credentialed")).toThrow();
    expect(() => normalizeSizeAttribute("1.5")).toThrow();
    expect(() => normalizeStateAttribute("<script>")).toThrow();
  });

  it("keeps reflected getters safe when markup contains hostile values", () => {
    const values = new Map<string, string>([
      ["motion", "maybe"],
      ["crossorigin", "credentialed"],
      ["width", "1.5"],
      ["state", "<script>"]
    ]);
    const host = {
      getAttribute: (name: string) => values.get(name) ?? null,
      setAttribute: (name: string, value: string) => { values.set(name, value); },
      removeAttribute: (name: string) => { values.delete(name); }
    } as unknown as HTMLElement;
    const reflection = new ElementAttributeReflection(host);

    expect(reflection.motion).toBe("auto");
    expect(reflection.crossOrigin).toBe("anonymous");
    expect(reflection.width).toBeNull();
    expect(reflection.state).toBeNull();
  });

  it("rejects huge host scalars before numeric conversion", () => {
    const huge = "9".repeat(1_048_576);
    expect(() => normalizeMotionAttribute(huge)).toThrow();
    expect(() => normalizeSizeAttribute(huge)).toThrow();
  });
});
