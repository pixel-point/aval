import type {
  ParsedFrontIndex,
  StaticBlobRange,
  UnitBlobRange
} from "@rendered-motion/format";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_BLOB_RANGE_TARGET_BYTES,
  planBlobStorageRanges,
  type RuntimeBlobSelection
} from "./blob-range-plan.js";

const digest = "00".repeat(32);

describe("canonical blob storage range planning", () => {
  it("associates each blob with only its immediately preceding padding", () => {
    const frontIndex = fixtureFrontIndex({
      frontIndexEnd: 100,
      declaredFileLength: 160,
      units: [unit("r", "u0", 104, 10), unit("r", "u1", 120, 8)],
      statics: [staticBlob("s0", 136, 24)]
    });

    const plan = planBlobStorageRanges({
      frontIndex,
      requested: [
        { kind: "static", staticFrame: "s0" },
        { kind: "unit", rendition: "r", unit: "u0" }
      ]
    });

    expect(plan.blobs.map((entry) => ({
      kind: entry.kind,
      padding: entry.paddingRange,
      blob: entry.blobRange,
      storage: entry.storageRange
    }))).toEqual([
      {
        kind: "unit",
        padding: { offset: 100, length: 4 },
        blob: { offset: 104, length: 10 },
        storage: { offset: 100, length: 14 }
      },
      {
        kind: "static",
        padding: { offset: 128, length: 8 },
        blob: { offset: 136, length: 24 },
        storage: { offset: 128, length: 32 }
      }
    ]);
    expect(plan.requests).toEqual([
      { ordinal: 0, offset: 100, length: 14, blobOrdinals: [0] },
      { ordinal: 1, offset: 128, length: 32, blobOrdinals: [1] }
    ]);
    expect(plan.totalStorageBytes).toBe(46);
  });

  it("sorts request identity canonically, coalesces adjacent spans, and freezes output", () => {
    const frontIndex = fixtureFrontIndex({
      frontIndexEnd: 64,
      declaredFileLength: 100,
      units: [unit("r", "a", 64, 12), unit("r", "b", 80, 12)],
      statics: [staticBlob("poster", 96, 4)]
    });
    const requested: RuntimeBlobSelection[] = [
      { kind: "static", staticFrame: "poster" },
      { kind: "unit", rendition: "r", unit: "b" },
      { kind: "unit", rendition: "r", unit: "a" }
    ];

    const plan = planBlobStorageRanges({
      frontIndex,
      requested,
      targetRequestBytes: 64
    });

    expect(plan.requests).toEqual([
      { ordinal: 0, offset: 64, length: 36, blobOrdinals: [0, 1, 2] }
    ]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.blobs)).toBe(true);
    expect(Object.isFrozen(plan.requests[0]?.blobOrdinals)).toBe(true);
  });

  it("splits one legal large storage span and reports every touched blob", () => {
    const frontIndex = fixtureFrontIndex({
      frontIndexEnd: 64,
      declaredFileLength: 90,
      units: [unit("r", "a", 66, 24)],
      statics: []
    });

    const plan = planBlobStorageRanges({
      frontIndex,
      requested: [{ kind: "unit", rendition: "r", unit: "a" }],
      targetRequestBytes: 8
    });

    expect(plan.requests).toEqual([
      { ordinal: 0, offset: 64, length: 8, blobOrdinals: [0] },
      { ordinal: 1, offset: 72, length: 8, blobOrdinals: [0] },
      { ordinal: 2, offset: 80, length: 8, blobOrdinals: [0] },
      { ordinal: 3, offset: 88, length: 2, blobOrdinals: [0] }
    ]);
  });

  it("uses the frozen four MiB default target", () => {
    expect(DEFAULT_BLOB_RANGE_TARGET_BYTES).toBe(4 * 1024 * 1024);
  });

  it.each([
    {
      label: "unknown selection",
      frontIndex: fixtureFrontIndex({
        frontIndexEnd: 64,
        declaredFileLength: 72,
        units: [unit("r", "u", 64, 8)],
        statics: []
      }),
      requested: [{ kind: "unit", rendition: "r", unit: "missing" }]
    },
    {
      label: "duplicate selection",
      frontIndex: fixtureFrontIndex({
        frontIndexEnd: 64,
        declaredFileLength: 72,
        units: [unit("r", "u", 64, 8)],
        statics: []
      }),
      requested: [
        { kind: "unit", rendition: "r", unit: "u" },
        { kind: "unit", rendition: "r", unit: "u" }
      ]
    },
    {
      label: "overlap",
      frontIndex: fixtureFrontIndex({
        frontIndexEnd: 64,
        declaredFileLength: 80,
        units: [unit("r", "u", 64, 12)],
        statics: [staticBlob("s", 72, 8)]
      }),
      requested: [{ kind: "static", staticFrame: "s" }]
    },
    {
      label: "gap after final blob",
      frontIndex: fixtureFrontIndex({
        frontIndexEnd: 64,
        declaredFileLength: 81,
        units: [unit("r", "u", 64, 8)],
        statics: []
      }),
      requested: [{ kind: "unit", rendition: "r", unit: "u" }]
    }
  ])("rejects $label", ({ frontIndex, requested }) => {
    expect(() => planBlobStorageRanges({
      frontIndex,
      requested: requested as readonly RuntimeBlobSelection[]
    })).toThrow();
  });

  it("holds its range invariants over generated canonical layouts", () => {
    for (let count = 1; count <= 32; count += 1) {
      let cursor = 64;
      const units: UnitBlobRange[] = [];
      for (let index = 0; index < count; index += 1) {
        cursor += index % 8;
        const length = (index * 13) % 31 + 1;
        units.push(unit("r", `u${String(index)}`, cursor, length));
        cursor += length;
      }
      const plan = planBlobStorageRanges({
        frontIndex: fixtureFrontIndex({
          frontIndexEnd: 64,
          declaredFileLength: cursor,
          units,
          statics: []
        }),
        requested: units.map((entry) => ({
          kind: "unit" as const,
          rendition: entry.rendition,
          unit: entry.unit
        })),
        targetRequestBytes: 47
      });
      expect(plan.requests.every((request) => request.length <= 47)).toBe(true);
      expect(plan.requests.reduce((sum, request) => sum + request.length, 0))
        .toBe(cursor - 64);
      for (let index = 1; index < plan.requests.length; index += 1) {
        const previous = plan.requests[index - 1]!;
        const current = plan.requests[index]!;
        expect(current.offset).toBe(previous.offset + previous.length);
      }
    }
  });
});

function unit(
  rendition: string,
  unitId: string,
  offset: number,
  length: number
): UnitBlobRange {
  return Object.freeze({
    rendition,
    unit: unitId,
    sampleStart: 0,
    sampleCount: 1,
    sha256: digest,
    offset,
    length
  });
}

function staticBlob(
  staticFrame: string,
  offset: number,
  length: number
): StaticBlobRange {
  return Object.freeze({ staticFrame, sha256: digest, offset, length });
}

function fixtureFrontIndex(input: Readonly<{
  frontIndexEnd: number;
  declaredFileLength: number;
  units: readonly UnitBlobRange[];
  statics: readonly StaticBlobRange[];
}>): ParsedFrontIndex {
  return {
    header: {
      major: 0,
      minor: 1,
      headerLength: 64,
      requiredFeatureFlags: 0,
      declaredFileLength: input.declaredFileLength,
      manifestOffset: 64,
      manifestLength: 0,
      indexOffset: input.frontIndexEnd,
      indexLength: 0
    },
    manifest: {} as ParsedFrontIndex["manifest"],
    graph: {} as ParsedFrontIndex["graph"],
    records: [],
    frontIndexRange: { offset: 0, length: input.frontIndexEnd },
    unitBlobs: input.units,
    staticBlobs: input.statics
  };
}
