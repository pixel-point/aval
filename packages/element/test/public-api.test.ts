import { describe, expect, it } from "vitest";

import {
  AVAL_ELEMENT_API_MAJOR,
  AVAL_TAG_NAME,
  ELEMENT_DECODER_CAPACITY
} from "../src/index.js";
import { createAvalElementClass } from "../src/aval-element.js";

describe("public element API", () => {
  it("freezes the prototype tag and API major", () => {
    expect(AVAL_TAG_NAME).toBe("aval-player");
    expect(AVAL_ELEMENT_API_MAJOR).toBe(1);
    expect(ELEMENT_DECODER_CAPACITY).toEqual({
      workerCount: 2,
      ringSize: 12,
      candidateReadyFrames: 6,
      totalDecodedSurfaces: 24
    });
    expect(Object.isFrozen(ELEMENT_DECODER_CAPACITY)).toBe(true);
  });

  it("keeps source identity exclusively in direct source children", () => {
    const Base = class {} as unknown as typeof HTMLElement;
    const Constructor = createAvalElementClass(Base);
    const observed = (Constructor as typeof Constructor & {
      readonly observedAttributes: readonly string[];
    }).observedAttributes;
    expect(observed).not.toContain("src");
    expect(observed).not.toContain("integrity");
    expect(Object.getOwnPropertyDescriptor(Constructor.prototype, "src")).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(Constructor.prototype, "integrity")).toBeUndefined();
  });
});
