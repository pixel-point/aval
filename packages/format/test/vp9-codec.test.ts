import { describe, expect, it } from "vitest";
import {
  isVp9Codec,
  parseVp9Level
} from "../src/vp9/codec.js";

describe("VP9 codec grammar", () => {
  it("owns level parsing alongside canonical codec admission", () => {
    expect(parseVp9Level("vp09.00.31.08.01.01.01.01.00")).toBe("31");
    expect(isVp9Codec("vp09.00.31.08.01.01.01.01.00")).toBe(true);
    expect(parseVp9Level("vp09.00.99.08.01.01.01.01.00")).toBeUndefined();
    expect(parseVp9Level("vp09.00.31.10.01.01.01.01.00")).toBeUndefined();
  });
});
