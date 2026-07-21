import { describe, expect, it } from "vitest";

import { writeUint64LE } from "../src/checked-integer.js";
import { FormatError } from "../src/errors.js";
import { parseHeader } from "../src/header.js";
import { parseFrontIndex, parseManifestPrefix } from "../src/parser.js";
import type { ParsedFrontIndex, ParsedManifestPrefix } from "../src/model.js";
import { canonicalAssetFixture } from "./asset-fixture.js";

function expectFormatError(
  action: () => unknown,
  code: FormatError["code"]
): FormatError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(FormatError);
    expect((error as FormatError).code).toBe(code);
    return error as FormatError;
  }
  throw new Error("expected a FormatError");
}

function expectRecursivelyFrozenAndRangeOnly(value: unknown): void {
  const seen = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (typeof candidate !== "object" || candidate === null || seen.has(candidate)) {
      return;
    }
    expect(candidate).not.toBeInstanceOf(Uint8Array);
    expect(Object.isFrozen(candidate)).toBe(true);
    seen.add(candidate);
    for (const key of Reflect.ownKeys(candidate)) {
      visit((candidate as Record<PropertyKey, unknown>)[key]);
    }
  };
  visit(value);
}

function frontPrefix(bytes: Uint8Array): Uint8Array {
  const header = parseHeader(bytes);
  return bytes.slice(0, header.indexOffset + header.indexLength);
}

function fixtureWithManifestPadding() {
  for (let suffixLength = 0; suffixLength < 8; suffixLength += 1) {
    const fixture = canonicalAssetFixture({
      generatorSuffix: "x".repeat(suffixLength)
    });
    const header = parseHeader(fixture.bytes);
    const manifestEnd = header.manifestOffset + header.manifestLength;
    if (header.indexOffset > manifestEnd) return fixture;
  }
  throw new Error("could not create a padded manifest fixture");
}

function replaceAscii(
  bytes: Uint8Array,
  from: string,
  to: string
): Uint8Array {
  const needle = new TextEncoder().encode(from);
  const replacement = new TextEncoder().encode(to);
  if (needle.byteLength !== replacement.byteLength) {
    throw new Error("ASCII replacements must preserve byte length");
  }
  const result = bytes.slice();
  for (let offset = 0; offset <= result.byteLength - needle.byteLength; offset += 1) {
    if (needle.every((byte, index) => result[offset + index] === byte)) {
      result.set(replacement, offset);
      return result;
    }
  }
  throw new Error(`could not find ${JSON.stringify(from)}`);
}

describe("parseManifestPrefix", () => {
  it("admits exactly the bytes through the manifest padding", () => {
    const fixture = canonicalAssetFixture();
    const header = parseHeader(fixture.bytes);
    const parsed: ParsedManifestPrefix = parseManifestPrefix(
      fixture.bytes.subarray(0, header.indexOffset)
    );

    expect(parsed.header).toEqual(header);
    expect(parsed.manifest).toEqual(fixture.manifest);
    expect(parsed.frontIndexRange).toEqual({
      offset: 0,
      length: header.indexOffset + header.indexLength
    });
    expectRecursivelyFrozenAndRangeOnly(parsed);
  });

  it("rejects a truncated manifest-stage prefix", () => {
    const fixture = canonicalAssetFixture();
    const header = parseHeader(fixture.bytes);

    const error = expectFormatError(
      () => parseManifestPrefix(fixture.bytes.subarray(0, header.indexOffset - 1)),
      "JSON_INVALID"
    );

    expect(error.offset).toBe(header.indexOffset - 1);
  });

  it("rejects manifest/header version drift", () => {
    const fixture = canonicalAssetFixture();
    const bytes = replaceAscii(fixture.bytes, '"formatVersion":"1.1"', '"formatVersion":"1.0"');
    const header = parseHeader(bytes);

    const error = expectFormatError(
      () => parseManifestPrefix(bytes.subarray(0, header.indexOffset)),
      "MANIFEST_INVALID"
    );

    expect(error.path).toBe("formatVersion");
  });

  it("rejects a declared file length above the manifest limit", () => {
    const fixture = canonicalAssetFixture();
    const bytes = fixture.bytes.slice();
    writeUint64LE(
      bytes,
      24,
      fixture.manifest.limits.maxCompiledBytes + 1,
      "HEADER_INVALID"
    );
    const header = parseHeader(bytes);

    const error = expectFormatError(
      () => parseManifestPrefix(bytes.subarray(0, header.indexOffset)),
      "BUDGET_EXCEEDED"
    );

    expect(error.path).toBe("limits.maxCompiledBytes");
  });

  it("rejects index length inconsistent with manifest chunk counts", () => {
    const fixture = canonicalAssetFixture();
    const bytes = fixture.bytes.slice();
    const original = parseHeader(bytes);
    writeUint64LE(
      bytes,
      56,
      original.indexLength + 48,
      "HEADER_INVALID"
    );
    const header = parseHeader(bytes);

    const prefixError = expectFormatError(
      () => parseManifestPrefix(bytes.subarray(0, header.indexOffset)),
      "INDEX_INVALID"
    );
    const frontError = expectFormatError(
      () => parseFrontIndex(bytes),
      "INDEX_INVALID"
    );

    expect(prefixError.offset).toBe(56);
    expect(frontError.offset).toBe(56);
  });
});

describe("parseFrontIndex", () => {
  it("parses the minimum prefix and ignores payload bytes in a full-file view", () => {
    const fixture = canonicalAssetFixture();
    const prefix = frontPrefix(fixture.bytes);
    const fromPrefix = parseFrontIndex(prefix);

    const withCorruptPayload = fixture.bytes.slice();
    const firstPayloadOffset = fromPrefix.records[0]!.byteOffset;
    withCorruptPayload[firstPayloadOffset] =
      (withCorruptPayload[firstPayloadOffset] ?? 0) ^ 0xff;
    const fromFullFile = parseFrontIndex(withCorruptPayload);

    expect(fromPrefix).toEqual(fromFullFile);
    expect(fromPrefix.frontIndexRange).toEqual({
      offset: 0,
      length: prefix.byteLength
    });
    expect(fromPrefix.records).toHaveLength(18);
    expect(fromPrefix.unitBlobs).toHaveLength(6);
  });

  it("returns recursively frozen numeric metadata detached from caller bytes", () => {
    const prefix = frontPrefix(canonicalAssetFixture().bytes);
    const parsed = parseFrontIndex(prefix);
    const snapshot = JSON.stringify(parsed);

    prefix.fill(0);

    expect(JSON.stringify(parsed)).toBe(snapshot);
    expectRecursivelyFrozenAndRangeOnly(parsed);
  });

  it("supports an unaligned caller-owned view whose offset zero is the file start", () => {
    const fixture = canonicalAssetFixture();
    const carrier = new Uint8Array(fixture.bytes.byteLength + 5);
    carrier.set(fixture.bytes, 3);
    const unaligned = carrier.subarray(3, 3 + fixture.bytes.byteLength);

    const parsed = parseFrontIndex(unaligned);

    expect(parsed.header.declaredFileLength).toBe(fixture.bytes.byteLength);
    expect(parsed.records[0]?.byteOffset).toBe(fixture.records[0]?.byteOffset);
  });

  it("requires every byte through the exact end of the encoded-chunk index", () => {
    const prefix = frontPrefix(canonicalAssetFixture().bytes);

    const error = expectFormatError(
      () => parseFrontIndex(prefix.subarray(0, prefix.byteLength - 1)),
      "INDEX_INVALID"
    );

    expect(error.offset).toBe(prefix.byteLength - 1);
  });

  it("rejects nonzero manifest-to-index padding", () => {
    const fixture = fixtureWithManifestPadding();
    const bytes = fixture.bytes.slice();
    const header = parseHeader(bytes);
    const paddingOffset = header.manifestOffset + header.manifestLength;
    bytes[paddingOffset] = 1;

    const error = expectFormatError(
      () => parseFrontIndex(bytes),
      "LAYOUT_INVALID"
    );

    expect(error.offset).toBe(paddingOffset);
  });

  it("rejects a noncanonical encoded-chunk byte offset using front metadata only", () => {
    const fixture = canonicalAssetFixture();
    const bytes = fixture.bytes.slice();
    const header = parseHeader(bytes);
    const firstRecordOffset = header.indexOffset + 16;
    writeUint64LE(
      bytes,
      firstRecordOffset,
      fixture.records[0]!.byteOffset + 1,
      "INDEX_INVALID"
    );

    expectFormatError(() => parseFrontIndex(bytes), "LAYOUT_INVALID");
  });

  it("rejects a declared trailing gap before reading payloads", () => {
    const fixture = canonicalAssetFixture();
    const trailingGap = fixture.bytes.slice();
    writeUint64LE(
      trailingGap,
      24,
      fixture.bytes.byteLength + 1,
      "HEADER_INVALID"
    );
    expectFormatError(() => parseFrontIndex(trailingGap), "LAYOUT_INVALID");
  });

  it("enforces caller-lowered budgets before accepting the prefix", () => {
    const fixture = canonicalAssetFixture();

    expectFormatError(
      () =>
        parseFrontIndex(fixture.bytes, {
          budgets: { maxFileBytes: fixture.bytes.byteLength - 1 }
        }),
      "BUDGET_EXCEEDED"
    );
  });

  it("never returns a partially mutable result envelope", () => {
    const parsed: ParsedFrontIndex = parseFrontIndex(
      canonicalAssetFixture().bytes
    );

    expect(Object.isFrozen(parsed.records)).toBe(true);
    expect(Object.isFrozen(parsed.unitBlobs)).toBe(true);
    expect(Object.isFrozen(parsed.graph)).toBe(true);
  });
});
