import {
  validateCompleteAsset,
  validatePngProfile,
  type ParsedFrontIndex,
  type ValidatedStaticPngProfile
} from "@rendered-motion/format";
import { describe, expect, it, vi } from "vitest";

import {
  createOpaqueTestAsset,
  strictTestPng
} from "./asset-test-fixture.js";
import {
  RuntimeAssetCatalog,
  createMetadataRuntimeAssetCatalog,
  createRuntimeCatalogBlobDescriptors,
  runtimeStaticBlobKey,
  runtimeUnitBlobKey,
  installRuntimeAssetCatalog
} from "./asset-catalog.js";
import { RuntimePlaybackError } from "./errors.js";
import {
  createRuntimeCompleteSource,
  type RuntimeCompleteSource
} from "./runtime-complete-source.js";
import {
  createAvcRenditionCandidates,
  inspectAvcRenditionCandidate
} from "./avc-rendition-selection.js";
import {
  decodeSha256Hex,
  verifySha256AndPromote
} from "./sha256-verifier.js";
import {
  promoteBorrowedVerifiedBlob,
  VerifiedBlobStore,
  type VerifiedBlobLoadRequest,
  type VerifiedBlobPersistentLease,
  type VerifiedBlobResourceCategory,
  type VerifiedBlobResourceHost
} from "./verified-blob-store.js";

describe("owned validated runtime asset catalog", () => {
  it("validates and retains only one owned copy of caller bytes", () => {
    const caller = createOpaqueTestAsset();
    const expected = caller.slice();
    const layout = validateCompleteAsset({ bytes: expected });
    const catalog = installRuntimeAssetCatalog(caller);

    caller.fill(0);
    structuredClone(caller.buffer, { transfer: [caller.buffer] });

    expect(catalog.ownedByteLength).toBe(expected.byteLength);
    expect(catalog.residencySnapshot()).toMatchObject({
      generation: 0,
      mode: "full",
      declaredFileBytes: expected.byteLength,
      metadataBytes: layout.frontIndex.frontIndexRange.length,
      verifiedPayloadBytes: [
        ...layout.frontIndex.unitBlobs,
        ...layout.frontIndex.staticBlobs
      ].reduce((total, blob) => total + blob.length, 0),
      unitBlobs: {
        total: layout.frontIndex.unitBlobs.length,
        verified: layout.frontIndex.unitBlobs.length
      },
      staticBlobs: {
        total: layout.frontIndex.staticBlobs.length,
        verified: layout.frontIndex.staticBlobs.length
      }
    });
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
      range: { staticFrame: "idle", length: strictTestPng(64, 64).byteLength }
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

describe("metadata-first verified runtime asset catalog", () => {
  it("publishes immutable metadata without allocating for declared payload offsets", () => {
    const fixture = sparseCatalogFixture();
    const { catalog, layout, resources } = fixture;

    expect(catalog.manifest).toBe(layout.frontIndex.manifest);
    expect(catalog.graph).toBe(layout.frontIndex.graph);
    expect(catalog.records.size).toBe(layout.frontIndex.records.length);
    expect(catalog.staticFrames.size).toBe(layout.frontIndex.staticBlobs.length);
    expect(catalog.ownedByteLength).toBe(
      layout.frontIndex.frontIndexRange.length
    );
    expect(catalog.ownedByteLength).toBeLessThan(
      layout.frontIndex.header.declaredFileLength
    );
    expect(resources.reservations).toEqual([]);
    expect(catalog.residencySnapshot()).toEqual({
      generation: 9,
      mode: "range",
      declaredFileBytes: layout.frontIndex.header.declaredFileLength,
      metadataBytes: layout.frontIndex.frontIndexRange.length,
      verifiedPayloadBytes: 0,
      unitBlobs: {
        total: layout.frontIndex.unitBlobs.length,
        absent: layout.frontIndex.unitBlobs.length,
        loading: 0,
        verified: 0,
        verifiedBytes: 0
      },
      staticBlobs: {
        total: layout.frontIndex.staticBlobs.length,
        absent: layout.frontIndex.staticBlobs.length,
        loading: 0,
        verified: 0,
        verifiedBytes: 0
      }
    });
    expect(() => catalog.layout).toThrow(RuntimePlaybackError);
    expect(Object.isFrozen(catalog.records.values())).toBe(true);
  });

  it("counts a retained complete source once as blobs become verified", async () => {
    const fixture = sparseCatalogFixture("full");
    const unit = fixture.requireUnit("opaque", "body");

    expect(fixture.catalog.ownedByteLength).toBe(fixture.asset.byteLength);
    expect(fixture.catalog.residencySnapshot().mode).toBe("full");
    await fixture.promoteUnit("opaque", "body");
    expect(unit.length).toBeGreaterThan(0);
    expect(fixture.catalog.ownedByteLength).toBe(fixture.asset.byteLength);
    expect(fixture.resources.reservations).toEqual([]);
    expect(fixture.store.snapshot().persistentLeaseCount).toBe(0);
    fixture.catalog.dispose();
  });

  it("gates exact sample copies on the verified containing unit blob", async () => {
    const fixture = sparseCatalogFixture();
    const record = fixture.catalog.records.require("opaque", "body", 0);
    const retainedRecord = record;

    expect(record.blobKey).toBe(runtimeUnitBlobKey("opaque", "body"));
    expect(() => fixture.catalog.copySample("opaque", "body", 0))
      .toThrow(RuntimePlaybackError);
    try {
      fixture.catalog.copySample("opaque", "body", 0);
    } catch (error) {
      expect(error).toMatchObject({
        code: "load-failure",
        failure: { context: { policyPhase: "absent" } }
      });
    }

    await fixture.promoteUnit("opaque", "body");
    const expected = fixture.asset.slice(
      record.range.offset,
      record.range.offset + record.range.length
    );
    const first = fixture.catalog.copySample("opaque", "body", 0);
    const second = fixture.catalog.copySample("opaque", "body", 0);
    expect(new Uint8Array(first)).toEqual(expected);
    expect(first.byteLength).toBe(record.range.length);
    expect(second.byteLength).toBe(record.range.length);
    new Uint8Array(first).fill(0);
    expect(new Uint8Array(
      fixture.catalog.copySample("opaque", "body", 0)
    )).toEqual(expected);
    expect(fixture.catalog.records.require("opaque", "body", 0))
      .toBe(retainedRecord);

    const other = fixture.layout.frontIndex.unitBlobs.find(
      (blob) => blob.unit !== "body"
    );
    expect(other).toBeDefined();
    expect(() => fixture.catalog.copySample(
      other!.rendition,
      other!.unit,
      0
    )).toThrow(RuntimePlaybackError);
  });

  it("reports loading stably while one shared verification is pending", async () => {
    const fixture = sparseCatalogFixture();
    const blob = fixture.requireUnit("opaque", "body");
    const gate = deferred<void>();
    const loading = fixture.store.ensure(runtimeUnitBlobKey("opaque", "body"), {
      async load(request) {
        await gate.promise;
        await promoteBlob(request, fixture.asset, blob);
      }
    });

    expect(() => fixture.catalog.copySample("opaque", "body", 0))
      .toThrow(RuntimePlaybackError);
    try {
      fixture.catalog.copySample("opaque", "body", 0);
    } catch (error) {
      expect(error).toMatchObject({
        code: "load-failure",
        failure: { context: { policyPhase: "loading" } }
      });
    }
    expect(fixture.catalog.residencySnapshot().unitBlobs.loading).toBe(1);

    gate.resolve();
    await loading;
    expect(fixture.catalog.residencySnapshot().unitBlobs.verified).toBe(1);
  });

  it("resolves a frozen static profile only after strict validation", async () => {
    const fixture = sparseCatalogFixture();
    const entry = fixture.catalog.staticFrames.require("idle");
    expect(entry.blobKey).toBe(runtimeStaticBlobKey("idle"));
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => entry.png).toThrow(RuntimePlaybackError);
    expect(() => fixture.catalog.copyStaticPng("idle"))
      .toThrow(RuntimePlaybackError);

    await fixture.promoteStatic("idle");

    const resolved = fixture.catalog.staticFrames.require("idle");
    expect(resolved).toBe(entry);
    expect(resolved.png).toMatchObject({
      width: entry.frame.width,
      height: entry.frame.height,
      byteRange: { offset: 0, length: entry.range.length }
    });
    expect(Object.isFrozen(resolved.png)).toBe(true);
    const first = fixture.catalog.copyStaticPng("idle");
    first.fill(0);
    expect(fixture.catalog.copyStaticPng("idle").slice(0, 8)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
    expect(Object.isFrozen(fixture.catalog.layout)).toBe(true);
  });

  it("tracks exact dynamic ownership and clears every authority on disposal", async () => {
    const fixture = sparseCatalogFixture();
    const unit = fixture.requireUnit("opaque", "body");
    const staticBlob = fixture.requireStatic("idle");
    const retainedIndex = fixture.catalog.records;

    await fixture.promoteUnit("opaque", "body");
    await fixture.promoteStatic("idle");

    const metadataBytes = fixture.layout.frontIndex.frontIndexRange.length;
    expect(fixture.catalog.ownedByteLength).toBe(
      metadataBytes + unit.length + staticBlob.length
    );
    expect(fixture.catalog.residencySnapshot()).toMatchObject({
      metadataBytes,
      verifiedPayloadBytes: unit.length + staticBlob.length,
      unitBlobs: { verified: 1, verifiedBytes: unit.length },
      staticBlobs: { verified: 1, verifiedBytes: staticBlob.length }
    });

    fixture.catalog.dispose();
    fixture.catalog.dispose();

    expect(fixture.catalog.disposed).toBe(true);
    expect(fixture.store.snapshot()).toMatchObject({
      disposed: true,
      verifiedBytes: 0,
      persistentLeaseCount: 0
    });
    expect(fixture.catalog.ownedByteLength).toBe(0);
    expect(fixture.catalog.residencySnapshot()).toMatchObject({
      metadataBytes: 0,
      verifiedPayloadBytes: 0
    });
    expect(() => retainedIndex.size).toThrow(RuntimePlaybackError);
    expect(() => fixture.catalog.copyStaticPng("idle"))
      .toThrow(RuntimePlaybackError);
  });

  it("inspects sparse verified units without copies, new leases, or mutation", async () => {
    const fixture = sparseCatalogFixture();
    for (const blob of fixture.layout.frontIndex.unitBlobs) {
      await fixture.promoteUnit(blob.rendition, blob.unit);
    }
    const expected = fixture.catalog.records.values().map((entry) =>
      new Uint8Array(fixture.catalog.copySample(
        entry.rendition,
        entry.unit,
        entry.localFrame
      )).slice()
    );
    const residency = fixture.catalog.residencySnapshot();
    const store = fixture.store.snapshot();
    const reservations = fixture.resources.reservations.length;
    const copySample = vi.spyOn(fixture.catalog, "copySample");
    const candidate = createAvcRenditionCandidates(
      fixture.catalog.manifest.renditions,
      fixture.catalog.manifest.canvas
    )[0]!;

    const result = inspectAvcRenditionCandidate(fixture.catalog, candidate);

    expect(result.ok).toBe(true);
    expect(copySample).not.toHaveBeenCalled();
    expect(fixture.catalog.residencySnapshot()).toEqual(residency);
    expect(fixture.store.snapshot()).toEqual(store);
    expect(fixture.resources.reservations).toHaveLength(reservations);
    copySample.mockRestore();
    expect(fixture.catalog.records.values().map((entry) =>
      new Uint8Array(fixture.catalog.copySample(
        entry.rendition,
        entry.unit,
        entry.localFrame
      ))
    )).toEqual(expected);
    fixture.catalog.dispose();
  });

  it("rejects mismatched declared geometry without changing store residency", () => {
    const fixture = sparseCatalogFixture();
    expect(() => createMetadataRuntimeAssetCatalog({
      frontIndex: fixture.layout.frontIndex,
      declaredFileLength:
        fixture.layout.frontIndex.header.declaredFileLength + 1,
      mode: "range",
      blobStore: fixture.store,
      staticProfiles: fixture.authority
    })).toThrow(RuntimePlaybackError);
    expect(fixture.store.snapshot().verifiedBytes).toBe(0);
  });
});

interface SparseCatalogFixture {
  readonly asset: Uint8Array;
  readonly layout: ReturnType<typeof validateCompleteAsset>;
  readonly store: VerifiedBlobStore;
  readonly catalog: RuntimeAssetCatalog;
  readonly resources: CountingBlobResources;
  readonly authority: {
    readonly resolve: (
      staticFrame: string
    ) => Readonly<ValidatedStaticPngProfile> | undefined;
  };
  readonly promoteUnit: (rendition: string, unit: string) => Promise<void>;
  readonly promoteStatic: (staticFrame: string) => Promise<void>;
  readonly requireUnit: (
    rendition: string,
    unit: string
  ) => ParsedFrontIndex["unitBlobs"][number];
  readonly requireStatic: (
    staticFrame: string
  ) => ParsedFrontIndex["staticBlobs"][number];
}

function sparseCatalogFixture(
  mode: "range" | "full" = "range"
): SparseCatalogFixture {
  const asset = createOpaqueTestAsset();
  const layout = validateCompleteAsset({ bytes: asset });
  const resources = new CountingBlobResources();
  const completeSource = mode === "full"
    ? createRuntimeCompleteSource(asset, () => {})
    : null;
  const store = new VerifiedBlobStore({
    generation: 9,
    descriptors: createRuntimeCatalogBlobDescriptors(layout.frontIndex),
    resources
  });
  const profiles = new Map<
    string,
    Readonly<ValidatedStaticPngProfile>
  >();
  const authority = Object.freeze({
    resolve: (staticFrame: string) => profiles.get(staticFrame)
  });
  const catalog = createMetadataRuntimeAssetCatalog({
    frontIndex: layout.frontIndex,
    declaredFileLength: layout.frontIndex.header.declaredFileLength,
    mode,
    blobStore: store,
    staticProfiles: authority
  });
  const requireUnit = (rendition: string, unit: string) => {
    const blob = layout.frontIndex.unitBlobs.find((candidate) =>
      candidate.rendition === rendition && candidate.unit === unit
    );
    if (blob === undefined) throw new Error("missing unit blob fixture");
    return blob;
  };
  const requireStatic = (staticFrame: string) => {
    const blob = layout.frontIndex.staticBlobs.find(
      (candidate) => candidate.staticFrame === staticFrame
    );
    if (blob === undefined) throw new Error("missing static blob fixture");
    return blob;
  };
  return Object.freeze({
    asset,
    layout,
    store,
    catalog,
    resources,
    authority,
    requireUnit,
    requireStatic,
    promoteUnit: async (rendition: string, unit: string) => {
      const blob = requireUnit(rendition, unit);
      await store.ensure(runtimeUnitBlobKey(rendition, unit), {
        load: (request) => promoteBlob(request, asset, blob, completeSource)
      });
    },
    promoteStatic: async (staticFrame: string) => {
      const blob = requireStatic(staticFrame);
      const frame = layout.frontIndex.manifest.staticFrames.find(
        (candidate) => candidate.id === staticFrame
      );
      if (frame === undefined) throw new Error("missing static frame fixture");
      const png = asset.slice(blob.offset, blob.offset + blob.length);
      const plan = validatePngProfile({
        png,
        expectedWidth: frame.width,
        expectedHeight: frame.height
      });
      profiles.set(staticFrame, plan);
      await store.ensure(runtimeStaticBlobKey(staticFrame), {
        load: (request) => promoteBlob(request, asset, blob, completeSource)
      });
    }
  });
}

async function promoteBlob(
  request: Readonly<VerifiedBlobLoadRequest>,
  asset: Uint8Array,
  blob: Readonly<{ offset: number; length: number; sha256: string }>,
  source: Readonly<RuntimeCompleteSource> | null = null
): Promise<void> {
  const retained = source?.read(blob.offset, blob.length) ?? null;
  await request.admit(retained === null ? "copied" : "borrowed");
  const pngOrUnit = retained?.bytes ??
    asset.slice(blob.offset, blob.offset + blob.length);
  await verifySha256AndPromote(
    {
      digestSha256: () => Promise.resolve(decodeSha256Hex(blob.sha256))
    },
    {
      bytes: pngOrUnit,
      expectedSha256Hex: blob.sha256,
      generation: request.generation,
      isGenerationCurrent: (generation) => generation === request.generation,
      signal: request.signal,
      inputLease: { release() {} },
      promote: (verified) => retained !== null
        ? promoteBorrowedVerifiedBlob(request, verified, retained)
        : request.promote(verified)
    }
  );
}

class CountingBlobResources implements VerifiedBlobResourceHost {
  public readonly reservations: Array<Readonly<{
    category: VerifiedBlobResourceCategory;
    bytes: number;
  }>> = [];
  #live = 0;

  public reserve(
    category: VerifiedBlobResourceCategory,
    byteLength: number
  ): VerifiedBlobPersistentLease {
    this.reservations.push(Object.freeze({ category, bytes: byteLength }));
    this.#live += byteLength;
    let released = false;
    return Object.freeze({
      release: () => {
        if (released) return;
        released = true;
        this.#live -= byteLength;
      }
    });
  }
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return Object.freeze({ promise, resolve });
}
