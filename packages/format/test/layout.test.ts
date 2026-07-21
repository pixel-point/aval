import { describe, expect, it } from "vitest";

import { FormatError } from "../src/errors.js";
import {
  deriveCanonicalAssetLayout,
  planCanonicalAssetLayout,
  validateZeroPadding
} from "../src/layout.js";
import { parseFrontIndex, validateCompleteAsset } from "../src/parser.js";
import { canonicalAssetFixture } from "./asset-fixture.js";

function expectFormatError(action: () => unknown, code?: FormatError["code"]): FormatError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(FormatError);
    if (code !== undefined) expect((error as FormatError).code).toBe(code);
    return error as FormatError;
  }
  throw new Error("expected operation to throw");
}

describe("canonical 1.1 asset layout", () => {
  it("derives the exact front index, unit blobs, padding, and file range", () => {
    const fixture = canonicalAssetFixture();
    const front = parseFrontIndex(fixture.bytes);
    const layout = deriveCanonicalAssetLayout(front.header, front.manifest, front.records);
    expect(layout.frontIndexRange.length).toBe(front.header.indexOffset + front.header.indexLength);
    expect(layout.unitBlobs).toHaveLength(
      front.manifest.renditions.length * front.manifest.units.length
    );
    expect(layout.fileRange).toEqual({ offset: 0, length: fixture.bytes.byteLength });
    for (const blob of layout.unitBlobs) {
      expect(blob.chunkCount).toBeGreaterThan(0);
      expect(blob.frameCount).toBeGreaterThan(0);
      expect(blob.length).toBeGreaterThan(0);
    }
  });

  it("plans decode-order records with independent presentation metadata", () => {
    const fixture = canonicalAssetFixture();
    const manifest = fixture.manifest;
    const chunks = fixture.records.map((record, index) => ({
      byteLength: fixture.payloads[index]!.byteLength,
      presentationTimestamp: record.presentationTimestamp,
      duration: record.duration,
      randomAccess: record.randomAccess,
      displayedFrameCount: record.displayedFrameCount
    }));
    const plan = planCanonicalAssetLayout(fixture.manifestBytes.byteLength, manifest, chunks);
    expect(plan.records).toEqual(fixture.records);
    expect(plan.records[0]).toMatchObject({ randomAccess: true, displayedFrameCount: 1 });
  });

  it("requires byte-canonical payload offsets and timeline fields", () => {
    const fixture = canonicalAssetFixture();
    const front = parseFrontIndex(fixture.bytes);
    for (const mutation of [
      { ...front.records[0]!, byteOffset: front.records[0]!.byteOffset + 1 },
      { ...front.records[0]!, byteLength: front.records[0]!.byteLength + 1 },
      { ...front.records[0]!, randomAccess: false },
      { ...front.records[0]!, displayedFrameCount: 0 }
    ]) {
      const records = [mutation, ...front.records.slice(1)];
      expectFormatError(
        () => deriveCanonicalAssetLayout(front.header, front.manifest, records),
        "LAYOUT_INVALID"
      );
    }
  });

  it("rejects nonzero alignment padding and incomplete/extended files", () => {
    const fixture = canonicalAssetFixture({ generatorSuffix: "x" });
    const front = parseFrontIndex(fixture.bytes);
    const layout = deriveCanonicalAssetLayout(front.header, front.manifest, front.records);
    const padded = layout.paddingRanges.find(({ length }) => length > 0);
    if (padded !== undefined) {
      const bytes = fixture.bytes.slice();
      bytes[padded.offset] = 1;
      expectFormatError(() => validateCompleteAsset({ bytes }), "LAYOUT_INVALID");
    }
    expectFormatError(
      () => validateCompleteAsset({ bytes: fixture.bytes.subarray(0, fixture.bytes.length - 1) })
    );
    const extended = new Uint8Array(fixture.bytes.length + 1);
    extended.set(fixture.bytes);
    expectFormatError(() => validateCompleteAsset({ bytes: extended }), "LAYOUT_INVALID");
  });

  it("validates caller ranges without leaking built-in exceptions", () => {
    expectFormatError(
      () => validateZeroPadding(null as unknown as Uint8Array, []),
      "INPUT_INVALID"
    );
    expectFormatError(
      () => validateZeroPadding(new Uint8Array(1), [{ offset: 1, length: 1 }]),
      "BUDGET_EXCEEDED"
    );
  });
});
