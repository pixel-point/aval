import {
  parseFrontIndex,
  parseHeader,
  validateCompleteAsset,
  validatePngProfile,
  type ParsedFrontIndex,
  type ValidatedAssetLayout,
  type ValidatedStaticPngProfile
} from "@rendered-motion/format";
import { describe, expect, it, vi } from "vitest";

import { createOpaqueTestAsset } from "./asset-test-fixture.js";
import type {
  BoundedBodyByteLease,
  BoundedBodyByteResourceHost
} from "./bounded-body-reader.js";
import type {
  BlobAssemblyLease,
  BlobAssemblyResourceHost
} from "./blob-assembly.js";
import {
  openRuntimeAssetBytes,
  type RuntimeAssetSessionResources
} from "./runtime-asset-session.js";
import type {
  Sha256DigestAdapter
} from "./sha256-verifier.js";
import type {
  VerifiedBlobPersistentLease,
  VerifiedBlobResourceCategory,
  VerifiedBlobResourceHost
} from "./verified-blob-store.js";

describe("complete-source runtime asset adapter", () => {
  it("retains one full source while verified blobs borrow it without allocations", async () => {
    const asset = createOpaqueTestAsset();
    const layout = validateCompleteAsset({ bytes: asset });
    const resources = new FullSourceResources();
    const allocations: number[] = [];
    let digestCalls = 0;
    const session = await openRuntimeAssetBytes(asset, {
      resources,
      digestAdapter: zeroDigest(() => { digestCalls += 1; }),
      allocate(byteLength) {
        allocations.push(byteLength);
        return new Uint8Array(new ArrayBuffer(byteLength));
      }
    });

    await session.ensureAllStatics();
    await session.ensureRenditionUnits("opaque");
    const verifiedBytes = [...layout.frontIndex.unitBlobs,
      ...layout.frontIndex.staticBlobs].reduce(
      (total, blob) => total + blob.length,
      0
    );
    expect(allocations).toEqual([asset.byteLength]);
    expect(resources.full.reservations).toEqual([asset.byteLength]);
    expect(resources.assembly.reservations).toEqual([]);
    expect(resources.verified.reservations).toEqual([]);
    expect(session.catalog.ownedByteLength).toBe(asset.byteLength);
    expect(session.snapshot()).toMatchObject({ verifiedPayloadBytes: verifiedBytes });

    const record = layout.frontIndex.records[0]!;
    const rendition = layout.frontIndex.manifest.renditions[record.renditionIndex]!.id;
    const unit = layout.frontIndex.manifest.units[record.unitIndex]!.id;
    const sample = new Uint8Array(session.catalog.copySample(
      rendition,
      unit,
      record.frameIndex
    ));
    const expectedSample = asset.slice(
      record.payloadOffset,
      record.payloadOffset + record.payloadLength
    );
    sample.fill(0xff);
    expect(new Uint8Array(session.catalog.copySample(
      rendition,
      unit,
      record.frameIndex
    ))).toEqual(expectedSample);
    const png = session.catalog.copyStaticPng("idle");
    const expectedPng = staticBytes(asset, layout.frontIndex, "idle");
    png.fill(0);
    expect(session.catalog.copyStaticPng("idle")).toEqual(expectedPng);

    const digestsBeforeEviction = digestCalls;
    const released = session.evictRenditionUnits("opaque");
    expect(released).toBe(layout.frontIndex.unitBlobs.reduce(
      (total, blob) => total + blob.length,
      0
    ));
    expect(session.snapshot().unitBlobs).toMatchObject({ verified: 0 });
    await session.ensureUnit("opaque", "body");
    expect(digestCalls).toBe(digestsBeforeEviction + 1);
    expect(allocations).toEqual([asset.byteLength]);
    expect(resources.assembly.reservations).toEqual([]);
    expect(resources.verified.reservations).toEqual([]);
    expect(session.catalog.ownedByteLength).toBe(asset.byteLength);

    await session.dispose();
    expect(resources.live).toBe(0);
    expect(session.catalog.ownedByteLength).toBe(0);
  });

  it("rejects nonzero canonical padding before digest or publication", async () => {
    const clean = createOpaqueTestAsset();
    const layout = validateCompleteAsset({ bytes: clean });
    const target = firstBlobWithPadding(layout.frontIndex);
    const corrupt = clean.slice();
    corrupt[target.paddingOffset] = 1;
    const resources = new FullSourceResources();
    const digest = vi.fn(async () => new Uint8Array(32));
    const session = await openRuntimeAssetBytes(corrupt, {
      resources,
      digestAdapter: { digestSha256: digest },
      format: trustedLayoutAdapter(layout)
    });

    await expect(ensureBlob(session, target.blob)).rejects.toMatchObject({
      code: "load-failure"
    });
    expect(digest).not.toHaveBeenCalled();
    expect(resources.assembly.reservations).toEqual([]);
    expect(resources.verified.reservations).toEqual([]);
    expect(session.snapshot().verifiedPayloadBytes).toBe(0);
    await session.dispose();
    expect(resources.live).toBe(0);
  });

  it("rejects a corrupt borrowed static before PNG validation or residency", async () => {
    const clean = createOpaqueTestAsset();
    const layout = validateCompleteAsset({ bytes: clean });
    const blob = layout.frontIndex.staticBlobs[0]!;
    const corrupt = clean.slice();
    corrupt[blob.offset + Math.floor(blob.length / 2)]! ^= 1;
    const expected = clean.slice(blob.offset, blob.offset + blob.length);
    const validateStaticPng = vi.fn(() => {
      throw new Error("corrupt bytes reached PNG validation");
    });
    const resources = new FullSourceResources();
    const session = await openRuntimeAssetBytes(corrupt, {
      resources,
      digestAdapter: matchingZeroDigest(expected),
      format: trustedLayoutAdapter(layout),
      validateStaticPng
    });

    await expect(session.ensureStatic(blob.staticFrame)).rejects.toMatchObject({
      code: "integrity-mismatch"
    });
    expect(validateStaticPng).not.toHaveBeenCalled();
    expect(resources.assembly.reservations).toEqual([]);
    expect(resources.verified.reservations).toEqual([]);
    expect(session.snapshot().staticBlobs).toMatchObject({
      absent: 1,
      verified: 0,
      verifiedBytes: 0
    });
    await session.dispose();
    expect(resources.live).toBe(0);
  });

  it("reserves the complete source before allocation and rolls back rejection", async () => {
    const asset = createOpaqueTestAsset();
    const allocation = vi.fn((byteLength: number) =>
      new Uint8Array(new ArrayBuffer(byteLength))
    );
    const resources = new FullSourceResources(asset.byteLength - 1);

    await expect(openRuntimeAssetBytes(asset, {
      resources,
      digestAdapter: zeroDigest(),
      allocate: allocation
    })).rejects.toMatchObject({ code: "resource-rejection" });
    expect(allocation).not.toHaveBeenCalled();
    expect(resources.live).toBe(0);
  });

  it("retains the complete-source lease until an aborted digest retires", async () => {
    const asset = createOpaqueTestAsset();
    const resources = new FullSourceResources();
    const digest = deferred<ArrayBuffer | Uint8Array>();
    const session = await openRuntimeAssetBytes(asset, {
      resources,
      digestAdapter: { digestSha256: () => digest.promise }
    });
    const ensure = session.ensureUnit("opaque", "body");
    await flushMicrotasks();

    const disposal = session.dispose();
    await flushMicrotasks();
    expect(resources.full.live).toBe(asset.byteLength);
    digest.resolve(new Uint8Array(32));
    await expect(ensure).rejects.toMatchObject({ name: "AbortError" });
    await disposal;
    expect(resources.live).toBe(0);
  });

  it("captures every hostile static-profile getter exactly once", async () => {
    const asset = createOpaqueTestAsset();
    const layout = validateCompleteAsset({ bytes: asset });
    const frame = layout.frontIndex.manifest.staticFrames.find(
      ({ id }) => id === "idle"
    )!;
    const resources = new FullSourceResources();
    const reads: Record<string, number> = {};
    const session = await openRuntimeAssetBytes(asset, {
      resources,
      digestAdapter: zeroDigest(),
      validateStaticPng(input) {
        return changingStaticProfile(validatePngProfile(input), reads);
      }
    });

    await session.ensureStatic("idle");
    expect(reads).toEqual({
      width: 1,
      height: 1,
      byteRange: 1,
      zlibByteLength: 1,
      expectedFilteredBytes: 1,
      expectedRgbaBytes: 1,
      offset: 1,
      length: 1
    });
    const expectedProfile = validatePngProfile({
      png: staticBytes(asset, layout.frontIndex, "idle"),
      expectedWidth: frame.width,
      expectedHeight: frame.height
    });
    const published = session.catalog.staticFrames.require("idle").png;
    expect(published).toMatchObject({
      width: expectedProfile.width,
      height: expectedProfile.height,
      byteRange: expectedProfile.byteRange,
      zlibByteLength: expectedProfile.zlibByteLength,
      expectedFilteredBytes: expectedProfile.expectedFilteredBytes,
      expectedRgbaBytes: expectedProfile.expectedRgbaBytes
    });
    expect(Object.isFrozen(published)).toBe(true);
    await session.dispose();
    expect(resources.live).toBe(0);
  });
});

type PlannedSourceBlob =
  | ParsedFrontIndex["unitBlobs"][number]
  | ParsedFrontIndex["staticBlobs"][number];

function ensureBlob(
  session: Awaited<ReturnType<typeof openRuntimeAssetBytes>>,
  blob: PlannedSourceBlob
): Promise<unknown> {
  return "staticFrame" in blob
    ? session.ensureStatic(blob.staticFrame)
    : session.ensureUnit(blob.rendition, blob.unit);
}

function firstBlobWithPadding(frontIndex: ParsedFrontIndex): Readonly<{
  blob: PlannedSourceBlob;
  paddingOffset: number;
}> {
  const blobs: PlannedSourceBlob[] = [
    ...frontIndex.unitBlobs,
    ...frontIndex.staticBlobs
  ].sort((left, right) => left.offset - right.offset);
  let cursor = frontIndex.frontIndexRange.length;
  for (const blob of blobs) {
    if (blob.offset > cursor) return Object.freeze({ blob, paddingOffset: cursor });
    cursor = blob.offset + blob.length;
  }
  throw new Error("complete-source fixture has no payload padding");
}

function trustedLayoutAdapter(layout: Readonly<ValidatedAssetLayout>) {
  return {
    parseHeader: (bytes: Uint8Array, cap: number) => parseHeader(bytes, {
      budgets: { maxFileBytes: cap }
    }),
    parseFrontIndex: (bytes: Uint8Array, cap: number) => parseFrontIndex(bytes, {
      budgets: { maxFileBytes: cap }
    }),
    validateCompleteAsset: () => layout
  };
}

function staticBytes(
  asset: Uint8Array,
  frontIndex: ParsedFrontIndex,
  staticFrame: string
): Uint8Array {
  const blob = frontIndex.staticBlobs.find(
    (candidate) => candidate.staticFrame === staticFrame
  )!;
  return asset.slice(blob.offset, blob.offset + blob.length);
}

function zeroDigest(onDigest: () => void = () => {}): Sha256DigestAdapter {
  return {
    async digestSha256() {
      onDigest();
      return new Uint8Array(32);
    }
  };
}

function matchingZeroDigest(expected: Uint8Array): Sha256DigestAdapter {
  return {
    async digestSha256(bytes) {
      if (bytes.byteLength !== expected.byteLength) return new Uint8Array(32).fill(1);
      let difference = 0;
      for (let index = 0; index < bytes.byteLength; index += 1) {
        difference |= bytes[index]! ^ expected[index]!;
      }
      return new Uint8Array(32).fill(difference === 0 ? 0 : 1);
    }
  };
}

function changingStaticProfile(
  profile: Readonly<ValidatedStaticPngProfile>,
  reads: Record<string, number>
): Readonly<ValidatedStaticPngProfile> {
  const changing = (key: string, first: unknown, later: unknown) => ({
    enumerable: true,
    get(): unknown {
      reads[key] = (reads[key] ?? 0) + 1;
      return reads[key] === 1 ? first : later;
    }
  });
  const byteRange = Object.defineProperties({}, {
    offset: changing("offset", profile.byteRange.offset, 1),
    length: changing("length", profile.byteRange.length, 0)
  });
  return Object.defineProperties({}, {
    width: changing("width", profile.width, 0),
    height: changing("height", profile.height, 0),
    byteRange: changing("byteRange", byteRange, null),
    zlibByteLength: changing("zlibByteLength", profile.zlibByteLength, 0),
    expectedFilteredBytes: changing(
      "expectedFilteredBytes", profile.expectedFilteredBytes, 0
    ),
    expectedRgbaBytes: changing(
      "expectedRgbaBytes", profile.expectedRgbaBytes, 0
    )
  }) as Readonly<ValidatedStaticPngProfile>;
}

class FullSourceResources implements RuntimeAssetSessionResources {
  public readonly metadata = new ByteResources();
  public readonly response = new ByteResources();
  public readonly full: ByteResources;
  public readonly assembly = new AssemblyResources();
  public readonly verified = new VerifiedResources();
  public constructor(maximumFullBytes = Number.MAX_SAFE_INTEGER) {
    this.full = new ByteResources(maximumFullBytes);
  }
  public get live(): number {
    return this.metadata.live + this.response.live + this.full.live +
      this.assembly.live + this.verified.live;
  }
}

class ByteResources implements BoundedBodyByteResourceHost {
  public readonly reservations: number[] = [];
  public live = 0;
  readonly #maximum: number;
  public constructor(maximum = Number.MAX_SAFE_INTEGER) { this.#maximum = maximum; }
  public reserve(byteLength: number): BoundedBodyByteLease {
    if (byteLength > this.#maximum) throw new Error("byte budget exceeded");
    this.reservations.push(byteLength);
    this.live += byteLength;
    return releasable(() => { this.live -= byteLength; });
  }
}

class AssemblyResources implements BlobAssemblyResourceHost {
  public readonly reservations: number[] = [];
  public live = 0;
  public reserve(byteLength: number): BlobAssemblyLease {
    this.reservations.push(byteLength);
    this.live += byteLength;
    return releasable(() => { this.live -= byteLength; });
  }
}

class VerifiedResources implements VerifiedBlobResourceHost {
  public readonly reservations: Array<Readonly<{
    category: VerifiedBlobResourceCategory;
    byteLength: number;
  }>> = [];
  public live = 0;
  public reserve(
    category: VerifiedBlobResourceCategory,
    byteLength: number
  ): VerifiedBlobPersistentLease {
    this.reservations.push({ category, byteLength });
    this.live += byteLength;
    return releasable(() => { this.live -= byteLength; });
  }
}

function releasable(onRelease: () => void): BoundedBodyByteLease {
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      onRelease();
    }
  };
}

function deferred<Value>(): Readonly<{
  promise: Promise<Value>;
  resolve(value: Value): void;
}> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((accept) => { resolve = accept; });
  return Object.freeze({ promise, resolve });
}

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}
