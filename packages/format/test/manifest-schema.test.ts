import { describe, expect, it } from "vitest";

import { FormatError } from "../src/errors.js";
import { validateCompiledManifest } from "../src/manifest-schema.js";
import type { CompiledManifest, VideoCodec } from "../src/model.js";
import { limitManifest, validManifest } from "./manifest-fixture.js";

function mutableManifest(): Record<string, any> {
  return structuredClone(validManifest()) as Record<string, any>;
}

function configureCodec(manifest: Record<string, any>, codec: VideoCodec, bitDepth: 8 | 10 = 8): void {
  manifest.codec = codec;
  manifest.bitstream = codec === "vp9" ? "frame" : codec === "av1" ? "low-overhead" : "annex-b";
  manifest.renditions[0].codec = {
    h264: "avc1.42E020",
    h265: "hvc1.1.6.L93.B0",
    vp9: "vp09.00.10.08.01.01.01.01.00",
    av1: bitDepth === 10
      ? "av01.0.08M.10.0.110.01.01.01.0"
      : "av01.0.08M.08.0.110.01.01.01.0"
  }[codec];
  manifest.renditions[0].bitDepth = bitDepth;
}

function expectManifestInvalid(value: unknown, path?: string): FormatError {
  try {
    validateCompiledManifest(value);
  } catch (error) {
    expect(error).toBeInstanceOf(FormatError);
    expect((error as FormatError).code).toBe("MANIFEST_INVALID");
    if (path !== undefined) expect((error as FormatError).path).toBe(path);
    return error as FormatError;
  }
  throw new Error("expected manifest validation to fail");
}

describe("validateCompiledManifest 1.1", () => {
  it("validates, detaches, and recursively freezes the canonical manifest", () => {
    const source = validManifest();
    const result = validateCompiledManifest(source);
    expect(result).toEqual(source);
    expect(result).not.toBe(source);
    expect(result.formatVersion).toBe("1.1");
    expect(result.codec).toBe("h264");
    expect(result.bitstream).toBe("annex-b");
    expect(result.layout).toBe("opaque");
    expectDeepFrozen(result);
  });

  it("supports the four codec families and AV1 10-bit", () => {
    for (const [codec, bitDepth] of [
      ["h264", 8],
      ["h265", 8],
      ["vp9", 8],
      ["av1", 8],
      ["av1", 10]
    ] as const) {
      const manifest = mutableManifest();
      configureCodec(manifest, codec, bitDepth);
      expect(validateCompiledManifest(manifest).renditions[0]).toMatchObject({ bitDepth });
    }
  });

  it("requires exact codec, bitstream, and bit-depth agreement", () => {
    for (const mutate of [
      (value: Record<string, any>) => { value.bitstream = "frame"; },
      (value: Record<string, any>) => { value.renditions[0].codec = "vp09.00.10.08"; },
      (value: Record<string, any>) => { value.renditions[0].bitDepth = 10; },
      (value: Record<string, any>) => {
        configureCodec(value, "av1", 10);
        value.renditions[0].codec = "av01.0.08M.08.0.110.01.01.01.0";
      }
    ]) {
      const manifest = mutableManifest();
      mutate(manifest);
      expectManifestInvalid(manifest);
    }
  });

  it("supports and strictly validates the shared packed-alpha layout", () => {
    const manifest = mutableManifest();
    manifest.layout = "packed-alpha";
    manifest.renditions[0].codedHeight = 32;
    manifest.renditions[0].alphaLayout = {
      type: "stacked",
      colorRect: [0, 0, 2, 2],
      alphaRect: [0, 10, 2, 2]
    };
    manifest.renditions[0].outputQualification = {
      kind: "packed-alpha-v1",
      unit: "body-a",
      frame: 0,
      samples: [{ x: 0, y: 0, expectedRange: [0, 32] }]
    };
    manifest.limits.decodedPixelBytes = 16 * 32 * 4;
    manifest.limits.runtimeWorkingSetBytes = 16 * 32 * 4;
    expect(validateCompiledManifest(manifest).layout).toBe("packed-alpha");

    manifest.renditions[0].alphaLayout.alphaRect[1] = 9;
    expectManifestInvalid(manifest, "renditions[0].alphaLayout.alphaRect");
  });

  it("preserves authored rendition quality order and rejects duplicate IDs", () => {
    const manifest = mutableManifest();
    const high = manifest.renditions[0];
    const low = { ...high, id: "low", bitrate: { average: 500, peak: 1_000 } };
    manifest.renditions = [high, low];
    let start = 18;
    for (const unit of manifest.units) {
      unit.chunks.push({
        rendition: "low",
        chunkStart: start,
        chunkCount: unit.frameCount,
        frameCount: unit.frameCount,
        sha256: "0".repeat(64)
      });
      start += unit.frameCount;
    }
    expect(validateCompiledManifest(manifest).renditions.map(({ id }) => id))
      .toEqual(["video", "low"]);
    manifest.renditions[1].id = "video";
    expectManifestInvalid(manifest, "renditions[1].id");
  });

  it("requires canonical decode-order spans and independent frame coverage metadata", () => {
    for (const mutate of [
      (value: Record<string, any>) => { value.units[0].chunks[0].chunkStart = 1; },
      (value: Record<string, any>) => { value.units[0].chunks[0].chunkCount = 0; },
      (value: Record<string, any>) => { value.units[0].chunks[0].frameCount = 3; },
      (value: Record<string, any>) => { value.units[0].chunks[0].rendition = "other"; }
    ]) {
      const manifest = mutableManifest();
      mutate(manifest);
      expectManifestInvalid(manifest);
    }
  });

  it("rejects old wire/profile fields instead of dispatching versions", () => {
    const oldVersion = mutableManifest();
    oldVersion.formatVersion = "0.1";
    expectManifestInvalid(oldVersion, "formatVersion");

    const legacyProfile = mutableManifest();
    legacyProfile.renditions[0].profile = "reference-rgba-v0";
    expectManifestInvalid(legacyProfile);

    const legacySamples = mutableManifest();
    legacySamples.units[0].samples = legacySamples.units[0].chunks;
    delete legacySamples.units[0].chunks;
    expectManifestInvalid(legacySamples);
  });

  it("honors chunk, frame, rendition, unit, and blob budgets", () => {
    for (const budgets of [
      { maxChunkRecords: 17 },
      { maxTotalUnitFrames: 17 },
      { maxRenditions: 0 },
      { maxUnits: 5 },
      { maxBlobRanges: 5 }
    ]) {
      expect(() => validateCompiledManifest(validManifest(), { budgets }))
        .toThrowError(FormatError);
    }
  });

  it("validates the graph-heavy ceiling fixture", () => {
    const result = validateCompiledManifest(limitManifest());
    expect(result.units).toHaveLength(96);
    expect(result.states).toHaveLength(32);
    expect(result.edges).toHaveLength(64);
  });

  it("never leaks built-in errors for hostile input", () => {
    expect(() => validateCompiledManifest(null)).toThrowError(FormatError);
    expect(() => validateCompiledManifest(new Proxy({}, {
      ownKeys() { throw new Error("hostile"); }
    }))).toThrowError(FormatError);
  });
});

function expectDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    expectDeepFrozen((value as Record<PropertyKey, unknown>)[key], seen);
  }
}
