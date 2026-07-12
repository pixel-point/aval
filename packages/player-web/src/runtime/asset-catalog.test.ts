import { validateCompleteAsset } from "@rendered-motion/format";
import { describe, expect, it } from "vitest";

import { createOpaqueTestAsset } from "./asset-test-fixture.js";
import {
  RuntimeAssetCatalog,
  installRuntimeAssetCatalog
} from "./asset-catalog.js";
import { RuntimePlaybackError } from "./errors.js";

describe("owned validated runtime asset catalog", () => {
  it("validates and retains only one owned copy of caller bytes", () => {
    const caller = createOpaqueTestAsset();
    const expected = caller.slice();
    const layout = validateCompleteAsset({ bytes: expected });
    const catalog = installRuntimeAssetCatalog(caller);

    caller.fill(0);
    structuredClone(caller.buffer, { transfer: [caller.buffer] });

    expect(catalog.ownedByteLength).toBe(expected.byteLength);
    expect(new Uint8Array(catalog.copySample("opaque", "body", 0))).toEqual(
      expected.slice(
        layout.frontIndex.records[0]!.payloadOffset,
        layout.frontIndex.records[0]!.payloadOffset +
          layout.frontIndex.records[0]!.payloadLength
      )
    );
  });

  it("exposes exact immutable metadata indexes from the validated layout", () => {
    const catalog = installRuntimeAssetCatalog(createOpaqueTestAsset());

    expect(catalog.renditions.size).toBe(1);
    expect(catalog.renditions.require("opaque").profile).toBe(
      "avc-annexb-opaque-v0"
    );
    expect(catalog.units.keys()).toEqual(["body", "intro"]);
    expect(catalog.states.keys()).toEqual(["idle"]);
    expect(catalog.edges.size).toBe(0);
    expect(catalog.ports.require("body", "default")).toMatchObject({
      unit: "body",
      port: { id: "default", entryFrame: 0, portalFrames: [0, 1] }
    });
    expect(catalog.staticFrames.require("idle")).toMatchObject({
      frame: { id: "idle", width: 64, height: 64 },
      range: { staticFrame: "idle", length: 33 }
    });

    for (const index of [
      catalog.renditions,
      catalog.units,
      catalog.states,
      catalog.edges,
      catalog.staticFrames
    ]) {
      expect(Object.isFrozen(index)).toBe(true);
      expect("set" in index).toBe(false);
      expect(Object.isFrozen(index.values())).toBe(true);
    }
    expect(Object.isFrozen(catalog.ports)).toBe(true);
    expect(Object.isFrozen(catalog.records)).toBe(true);
    expect(Object.isFrozen(catalog.layout)).toBe(true);
    expect(Object.isFrozen(catalog.manifest)).toBe(true);
    expect(Object.isFrozen(catalog.graph)).toBe(true);
  });

  it("resolves every validated record by authored identity and exact range", () => {
    const asset = createOpaqueTestAsset();
    const validated = validateCompleteAsset({ bytes: asset });
    const catalog = installRuntimeAssetCatalog(asset);

    expect(catalog.records.size).toBe(validated.frontIndex.records.length);
    for (const record of validated.frontIndex.records) {
      const rendition = validated.frontIndex.manifest.renditions[
        record.renditionIndex
      ]!;
      const unit = validated.frontIndex.manifest.units[record.unitIndex]!;
      const entry = catalog.records.require(
        rendition.id,
        unit.id,
        record.frameIndex
      );
      expect(entry.record).toEqual(record);
      expect(entry.range).toEqual({
        offset: record.payloadOffset,
        length: record.payloadLength
      });
      expect(new Uint8Array(
        catalog.copySample(rendition.id, unit.id, record.frameIndex)
      )).toEqual(
        asset.slice(
          record.payloadOffset,
          record.payloadOffset + record.payloadLength
        )
      );
    }
  });

  it("returns fresh transferable sample and static buffers without aliasing", () => {
    const catalog = installRuntimeAssetCatalog(createOpaqueTestAsset());
    const first = catalog.copySample("opaque", "body", 0);
    const expected = new Uint8Array(first).slice();
    const second = catalog.copySample("opaque", "body", 0);
    const transferred = structuredClone(first, { transfer: [first] });

    expect(first.byteLength).toBe(0);
    expect(new Uint8Array(transferred)).toEqual(expected);
    expect(new Uint8Array(second)).toEqual(expected);
    new Uint8Array(second).fill(0);
    expect(new Uint8Array(
      catalog.copySample("opaque", "body", 0)
    )).toEqual(expected);

    const staticOne = catalog.copyStaticPng("idle");
    const staticTwo = catalog.copyStaticPng("idle");
    staticOne.fill(0);
    expect(staticTwo.slice(0, 8)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
    expect(catalog.copyStaticPng("idle")).toEqual(staticTwo);
  });

  it("normalizes invalid assets, sparse lookups, and hostile ranges", () => {
    expect(() => installRuntimeAssetCatalog(new Uint8Array([1, 2, 3])))
      .toThrow(RuntimePlaybackError);
    try {
      installRuntimeAssetCatalog(new Uint8Array([1, 2, 3]));
      throw new Error("invalid asset unexpectedly installed");
    } catch (error) {
      expect(error).toMatchObject({
        name: "RuntimePlaybackError",
        code: "invalid-asset",
        failure: {
          context: { sourceCode: "HEADER_INVALID" }
        }
      });
    }

    const catalog = installRuntimeAssetCatalog(createOpaqueTestAsset());
    expect(() => catalog.records.require("opaque", "missing", 0))
      .toThrow(RuntimePlaybackError);
    expect(() => catalog.copySample("opaque", "body", 99))
      .toThrow(RuntimePlaybackError);
    expect(() => catalog.copyStaticPng("missing"))
      .toThrow(RuntimePlaybackError);

    const corrupt = createOpaqueTestAsset();
    const layout = validateCompleteAsset({ bytes: corrupt });
    const firstRecordOffset = layout.frontIndex.header.indexOffset + 16;
    corrupt.fill(0xff, firstRecordOffset, firstRecordOffset + 8);
    try {
      installRuntimeAssetCatalog(corrupt);
      throw new Error("hostile range unexpectedly installed");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimePlaybackError);
      expect(error).not.toBeInstanceOf(RangeError);
      expect(error).toMatchObject({ code: "invalid-asset" });
    }
  });

  it("releases owned storage and rejects every read after idempotent disposal", () => {
    const catalog = installRuntimeAssetCatalog(createOpaqueTestAsset());
    const retainedIndex = catalog.records;

    catalog.dispose();
    catalog.dispose();

    expect(catalog.disposed).toBe(true);
    expect(catalog.ownedByteLength).toBe(0);
    for (const read of [
      () => catalog.layout,
      () => catalog.manifest,
      () => catalog.copySample("opaque", "body", 0),
      () => catalog.copyStaticPng("idle"),
      () => retainedIndex.size
    ]) {
      expect(read).toThrow(RuntimePlaybackError);
      try {
        read();
      } catch (error) {
        expect(error).toMatchObject({ code: "disposed" });
      }
    }
  });

  it("rejects non-byte caller input through the typed boundary", () => {
    expect(() => installRuntimeAssetCatalog(
      null as unknown as Uint8Array
    )).toThrow(RuntimePlaybackError);
    expect(() => new RuntimeAssetCatalog(
      null as unknown as Uint8Array
    )).toThrow(RuntimePlaybackError);
  });
});
