import { describe, expect, it } from "vitest";

import { writeUint16LE, writeUint32LE, writeUint64LE } from "../src/checked-integer.js";
import { FormatError } from "../src/errors.js";
import { deriveCanonicalAssetLayout } from "../src/layout.js";
import { parseFrontIndex, validateCompleteAsset } from "../src/parser.js";
import {
  generateVideoGraphFixture,
  generateVideoLoopFixture
} from "./fixture-generator.js";
import { canonicalAssetFixture } from "./asset-fixture.js";
import { mutationSeeds } from "../../../tests/mutation/seed-profile.js";

const SEEDS = mutationSeeds([1, 0x5eedc0de, 0xc0ffee, 0xffff_ffff]);

function randomFor(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function expectDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    expectDeepFrozen((value as Record<PropertyKey, unknown>)[key], seen);
  }
}

function expectStableOutcome(bytes: Uint8Array): void {
  try {
    const result = validateCompleteAsset({ bytes });
    expectDeepFrozen(result);
  } catch (error) {
    expect(error).toBeInstanceOf(FormatError);
    expect(Object.isFrozen(error)).toBe(true);
    expect(typeof (error as FormatError).code).toBe("string");
  }
}

function mutateSingleByte(bytes: Uint8Array, random: () => number): Uint8Array {
  const result = bytes.slice();
  if (result.byteLength === 0) return result;
  const offset = random() % result.byteLength;
  const original = result[offset] ?? 0;
  let replacement = random() & 0xff;
  if (replacement === original) replacement = (replacement + 1) & 0xff;
  result[offset] = replacement;
  return result;
}

function mutateSlice(bytes: Uint8Array, random: () => number): Uint8Array {
  const result = bytes.slice();
  if (result.byteLength === 0) return result;
  const start = random() % result.byteLength;
  const maximum = Math.min(32, result.byteLength - start);
  const length = 1 + (random() % maximum);
  for (let index = start; index < start + length; index += 1) {
    result[index] = random() & 0xff;
  }
  return result;
}

function mutateInsertion(bytes: Uint8Array, random: () => number): Uint8Array {
  const offset = random() % (bytes.byteLength + 1);
  const insertionLength = 1 + (random() % 8);
  const result = new Uint8Array(bytes.byteLength + insertionLength);
  result.set(bytes.subarray(0, offset), 0);
  for (let index = 0; index < insertionLength; index += 1) {
    result[offset + index] = random() & 0xff;
  }
  result.set(bytes.subarray(offset), offset + insertionLength);
  return result;
}

function mutateDeletion(bytes: Uint8Array, random: () => number): Uint8Array {
  if (bytes.byteLength === 0) return bytes.slice();
  const offset = random() % bytes.byteLength;
  const maximum = Math.min(32, bytes.byteLength - offset);
  const deletionLength = 1 + (random() % maximum);
  const result = new Uint8Array(bytes.byteLength - deletionLength);
  result.set(bytes.subarray(0, offset), 0);
  result.set(bytes.subarray(offset + deletionLength), offset);
  return result;
}

function randomMutation(bytes: Uint8Array, random: () => number): Uint8Array {
  switch (random() % 4) {
    case 0:
      return mutateSingleByte(bytes, random);
    case 1:
      return mutateSlice(bytes, random);
    case 2:
      return mutateInsertion(bytes, random);
    default:
      return mutateDeletion(bytes, random);
  }
}

function replaceAscii(
  source: Uint8Array,
  from: string,
  to: string
): Uint8Array {
  if (from.length !== to.length) throw new Error("replacement length changed");
  const bytes = source.slice();
  const needle = new TextEncoder().encode(from);
  const replacement = new TextEncoder().encode(to);
  for (let offset = 0; offset <= bytes.byteLength - needle.byteLength; offset += 1) {
    if (needle.every((value, index) => bytes[offset + index] === value)) {
      bytes.set(replacement, offset);
      return bytes;
    }
  }
  throw new Error(`fixture does not contain ${from}`);
}

function withByte(source: Uint8Array, offset: number, value: number): Uint8Array {
  const bytes = source.slice();
  bytes[offset] = value;
  return bytes;
}

function fixtureWithPadding(): Uint8Array {
  for (let suffixLength = 0; suffixLength < 8; suffixLength += 1) {
    const fixture = canonicalAssetFixture({
      generatorSuffix: "x".repeat(suffixLength)
    });
    const layout = deriveCanonicalAssetLayout(
      parseFrontIndex(fixture.bytes).header,
      fixture.manifest,
      fixture.records
    );
    if (layout.paddingRanges.some(({ length }) => length > 0)) {
      return fixture.bytes;
    }
  }
  throw new Error("could not construct a fixture with padding");
}

describe("seeded complete-asset mutation fuzzing", () => {
  const sources = [generateVideoLoopFixture(), generateVideoGraphFixture()];

  for (const seed of SEEDS) {
    it(
      `maps single-byte, slice, insertion, and deletion mutations to a frozen value or FormatError for seed ${seed.toString(16)}`,
      () => {
        const random = randomFor(seed);
        for (let iteration = 0; iteration < 500; iteration += 1) {
          const source = sources[random() % sources.length]!;
          expectStableOutcome(randomMutation(source, random));
        }
      },
      30_000
    );
  }

  it("maps structured header, index, padding, and profile mutations to stable outcomes", () => {
    const source = fixtureWithPadding();
    const front = parseFrontIndex(source);
    const index = front.header.indexOffset;
    const firstRecord = index + 16;
    const layout = deriveCanonicalAssetLayout(
      front.header,
      front.manifest,
      front.records
    );
    const padding = layout.paddingRanges.find(({ length }) => length > 0);
    if (padding === undefined) throw new Error("fixture has no padding range");

    const mutations: readonly [name: string, create: () => Uint8Array][] = [
      ["header magic", () => withByte(source, 0, 0)],
      [
        "header version",
        () => {
          const bytes = source.slice();
          writeUint16LE(bytes, 8, 1, "HEADER_INVALID", "major version");
          return bytes;
        }
      ],
      ["header reserved", () => withByte(source, 20, 1)],
      [
        "header unsafe file length",
        () => {
          const bytes = source.slice();
          writeUint64LE(bytes, 24, 1n << 53n, "HEADER_INVALID", "file length");
          return bytes;
        }
      ],
      [
        "header manifest range",
        () => {
          const bytes = source.slice();
          writeUint64LE(bytes, 40, 0xffff_ffff, "HEADER_INVALID", "manifest length");
          return bytes;
        }
      ],
      [
        "header index offset",
        () => {
          const bytes = source.slice();
          writeUint64LE(
            bytes,
            48,
            front.header.indexOffset + 1,
            "HEADER_INVALID",
            "index offset"
          );
          return bytes;
        }
      ],
      [
        "header index length",
        () => {
          const bytes = source.slice();
          writeUint64LE(
            bytes,
            56,
            front.header.indexLength - 1,
            "HEADER_INVALID",
            "index length"
          );
          return bytes;
        }
      ],
      ["index magic", () => withByte(source, index, 0)],
      [
        "index record size",
        () => {
          const bytes = source.slice();
          writeUint16LE(bytes, index + 4, 31, "INDEX_INVALID", "record size");
          return bytes;
        }
      ],
      ["index reserved", () => withByte(source, index + 6, 1)],
      [
        "index count",
        () => {
          const bytes = source.slice();
          writeUint32LE(bytes, index + 8, 0xffff_ffff, "INDEX_INVALID", "count");
          return bytes;
        }
      ],
      [
        "record unsafe offset",
        () => {
          const bytes = source.slice();
          writeUint64LE(
            bytes,
            firstRecord,
            1n << 53n,
            "INDEX_INVALID",
            "payload offset"
          );
          return bytes;
        }
      ],
      [
        "record zero size",
        () => {
          const bytes = source.slice();
          writeUint32LE(bytes, firstRecord + 8, 0, "INDEX_INVALID", "size");
          return bytes;
        }
      ],
      [
        "record displayed frame count",
        () => {
          const bytes = source.slice();
          writeUint32LE(bytes, firstRecord + 12, 0, "INDEX_INVALID", "displayed frames");
          return bytes;
        }
      ],
      [
        "record unsafe presentation timestamp",
        () => {
          const bytes = source.slice();
          writeUint64LE(bytes, firstRecord + 16, 1n << 53n, "INDEX_INVALID", "timestamp");
          return bytes;
        }
      ],
      [
        "record flags",
        () => {
          const bytes = source.slice();
          writeUint32LE(bytes, firstRecord + 32, 2, "INDEX_INVALID", "flags");
          return bytes;
        }
      ],
      [
        "record zero duration",
        () => {
          const bytes = source.slice();
          writeUint64LE(bytes, firstRecord + 24, 0, "INDEX_INVALID", "duration");
          return bytes;
        }
      ],
      ["record reserved", () => withByte(source, firstRecord + 36, 1)],
      ["padding byte", () => withByte(source, padding.offset, 1)],
      [
        "manifest codec",
        () => replaceAscii(source, "avc1.42E020", "avc1.42E02G")
      ],
      [
        "opaque encoded payload",
        () => withByte(source, front.records[0]!.byteOffset + 1, 1)
      ]
    ];

    for (const [, create] of mutations) {
      expectStableOutcome(create());
    }
  });
});
