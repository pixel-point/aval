import { describe, expect, it } from "vitest";

import {
  parseExternalIntegrity
} from "./external-integrity.js";

const EMPTY_SHA256_BASE64 = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
const EMPTY_SHA256_HEX =
  "e3b0c44298fc1c149afbf4c8996fb924" +
  "27ae41e4649b934ca495991b7852b855";

describe("external SHA-256 integrity", () => {
  it("normalizes exact canonical standard Base64 into immutable hex", () => {
    const value = `sha256-${EMPTY_SHA256_BASE64}`;
    const normalized = parseExternalIntegrity(value);

    expect(normalized).toEqual({
      algorithm: "sha256",
      token: value,
      digestBase64: EMPTY_SHA256_BASE64,
      sha256Hex: EMPTY_SHA256_HEX
    });
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  it("accepts both ends of the standard Base64 alphabet", () => {
    expect(parseExternalIntegrity(
      "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    ).sha256Hex).toBe("00".repeat(32));
    expect(parseExternalIntegrity(
      "sha256-//////////////////////////////////////////8="
    ).sha256Hex).toBe("ff".repeat(32));
  });

  it.each([
    ["empty", ""],
    ["algorithm only", "sha256-"],
    ["wrong algorithm", `sha384-${EMPTY_SHA256_BASE64}`],
    ["uppercase algorithm", `SHA256-${EMPTY_SHA256_BASE64}`],
    ["missing separator", `sha256${EMPTY_SHA256_BASE64}`],
    ["short payload", `sha256-${EMPTY_SHA256_BASE64.slice(0, -2)}=`],
    ["long payload", `sha256-${EMPTY_SHA256_BASE64}A`],
    ["unpadded", `sha256-${EMPTY_SHA256_BASE64.slice(0, -1)}`],
    ["double padding", `sha256-${EMPTY_SHA256_BASE64.slice(0, -1)}==`],
    ["padding in middle", `sha256-${EMPTY_SHA256_BASE64.slice(0, 10)}=${EMPTY_SHA256_BASE64.slice(11)}`],
    ["leading whitespace", ` sha256-${EMPTY_SHA256_BASE64}`],
    ["trailing whitespace", `sha256-${EMPTY_SHA256_BASE64} `],
    ["embedded newline", `sha256-${EMPTY_SHA256_BASE64.slice(0, 20)}\n${EMPTY_SHA256_BASE64.slice(20)}`],
    ["multiple whitespace tokens", `sha256-${EMPTY_SHA256_BASE64} sha256-${EMPTY_SHA256_BASE64}`],
    ["multiple comma tokens", `sha256-${EMPTY_SHA256_BASE64},sha256-${EMPTY_SHA256_BASE64}`],
    ["URL-safe dash", `sha256-${EMPTY_SHA256_BASE64.replace("+", "-")}`],
    ["URL-safe underscore", `sha256-${EMPTY_SHA256_BASE64.replace("/", "_")}`],
    ["invalid alphabet", `sha256-${EMPTY_SHA256_BASE64.replace("+", "*")}`],
    ["option suffix", `sha256-${EMPTY_SHA256_BASE64}?foo=bar`],
    ["noncanonical pad bits", `sha256-${EMPTY_SHA256_BASE64.slice(0, -2)}V=`]
  ])("rejects %s", (_label, value) => {
    expect(() => parseExternalIntegrity(value)).toThrow(TypeError);
  });

  it("rejects non-string host input without inspecting it", () => {
    const hostile = Object.create(null) as { toString?: () => string };
    Object.defineProperty(hostile, "toString", {
      get() {
        throw new Error("host integrity accessor must not run");
      }
    });

    expect(() => parseExternalIntegrity(
      hostile as unknown as string
    )).toThrow(TypeError);
  });
});
