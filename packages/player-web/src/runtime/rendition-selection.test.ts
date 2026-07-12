import type { RenditionV01 } from "@rendered-motion/format";
import { describe, expect, it, vi } from "vitest";

import { installRuntimeAssetCatalog } from "./asset-catalog.js";
import {
  createOpaqueTestAsset,
  opaqueTestRendition
} from "./asset-test-fixture.js";
import { RuntimePlaybackError } from "./errors.js";
import {
  createAvcRenditionCandidates,
  createOpaqueRenditionCandidates,
  inspectAvcRenditionCandidate,
  inspectOpaqueRenditionCandidate
} from "./avc-rendition-selection.js";

describe("deterministic AVC rendition selection", () => {
  it("accepts exact packed alpha and records visible color area separately", () => {
    const packed: RenditionV01 = {
      id: "packed",
      profile: "avc-annexb-packed-alpha-v0",
      codec: "avc1.42E020",
      codedWidth: 64,
      codedHeight: 144,
      alphaLayout: {
        type: "stacked-v0",
        colorRect: [0, 0, 64, 64],
        alphaRect: [0, 72, 64, 64]
      },
      bitrate: { average: 1_000, peak: 2_000 },
      capabilities: ["webcodecs", "webgl2"]
    };

    const candidates = createAvcRenditionCandidates(
      [packed],
      { width: 64, height: 64 }
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      rank: 0,
      visibleColorArea: 4_096,
      codedArea: 9_216,
      rendition: { id: "packed" },
      geometry: {
        profile: "avc-annexb-packed-alpha-v0",
        decodedStorageRect: [0, 0, 64, 136]
      }
    });
    expect(createOpaqueRenditionCandidates).toBe(createAvcRenditionCandidates);
    expect(inspectOpaqueRenditionCandidate).toBe(inspectAvcRenditionCandidate);
  });

  it("is independent of input order and applies every exact tie break", () => {
    const renditions = [
      opaqueTestRendition("z-area", 128, 128, 5_000, 4_000),
      opaqueTestRendition("z-peak", 96, 96, 7_000, 4_000),
      opaqueTestRendition("b-tie", 96, 96, 8_000, 4_000),
      opaqueTestRendition("a-tie", 96, 96, 8_000, 4_000),
      opaqueTestRendition("low", 64, 64, 8_000, 4_000)
    ];

    const expected = ["z-area", "a-tie", "b-tie", "z-peak", "low"];
    expect(createAvcRenditionCandidates(renditions).map(id)).toEqual(
      expected
    );
    expect(createAvcRenditionCandidates(
      [...renditions].reverse()
    ).map(id)).toEqual(expected);
    expect(createAvcRenditionCandidates([
      renditions[2]!,
      renditions[4]!,
      renditions[0]!,
      renditions[3]!,
      renditions[1]!
    ]).map(id)).toEqual(expected);
  });

  it("retains exact AVC tuples and rejects mixed production alpha classes", () => {
    const opaque = opaqueTestRendition("opaque");
    const reference: RenditionV01 = {
      id: "reference",
      profile: "reference-rgba-v0",
      codec: "rma.reference-rgba",
      codedWidth: 64,
      codedHeight: 64,
      alphaLayout: { type: "straight-rgba-v0" },
      capabilities: []
    };
    const packed: RenditionV01 = {
      id: "packed",
      profile: "avc-annexb-packed-alpha-v0",
      codec: "avc1.42E020",
      codedWidth: 64,
      codedHeight: 144,
      alphaLayout: {
        type: "stacked-v0",
        colorRect: [0, 0, 64, 64],
        alphaRect: [0, 72, 64, 64]
      },
      bitrate: { average: 1_000, peak: 2_000 },
      capabilities: ["webcodecs", "webgl2"]
    };
    const wrongCodec = {
      ...opaqueTestRendition("wrong-codec"),
      codec: "avc1.bad"
    } as unknown as RenditionV01;
    const wrongCapabilities = {
      ...opaqueTestRendition("wrong-capabilities"),
      capabilities: ["webgl2", "webcodecs"]
    } as unknown as RenditionV01;
    const wrongAlpha = {
      ...opaqueTestRendition("wrong-alpha"),
      alphaLayout: { type: "straight-rgba-v0" }
    } as unknown as RenditionV01;

    expect(createAvcRenditionCandidates([
      reference,
      wrongCodec,
      opaque,
      wrongCapabilities,
      wrongAlpha
    ]).map(id)).toEqual(["opaque"]);
    expect(() => createAvcRenditionCandidates(
      [opaque, packed],
      { width: 64, height: 64 }
    )).toThrow("cannot be mixed");
    expect(Object.isFrozen(createAvcRenditionCandidates([reference]))).toBe(
      true
    );
    expect(createAvcRenditionCandidates([reference])).toEqual([]);
  });

  it("checks coded-area arithmetic before sorting", () => {
    const unsafe = {
      ...opaqueTestRendition("unsafe"),
      codedWidth: Number.MAX_SAFE_INTEGER,
      codedHeight: 2,
      alphaLayout: {
        type: "opaque-v0",
        colorRect: [0, 0, Number.MAX_SAFE_INTEGER, 2]
      }
    } as unknown as RenditionV01;

    expect(() => createAvcRenditionCandidates([unsafe]))
      .toThrow(RuntimePlaybackError);
    try {
      createAvcRenditionCandidates([unsafe]);
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid-asset",
        failure: { context: { rendition: "unsafe" } }
      });
      expect(error).not.toBeInstanceOf(RangeError);
    }
  });

  it("rejects forged opaque rectangles and unsafe average bitrates", () => {
    const wrongRect = {
      ...opaqueTestRendition("wrong-rect"),
      alphaLayout: {
        type: "opaque-v0",
        colorRect: [1, 0, 63, 64]
      }
    } as unknown as RenditionV01;
    const zeroAverage = {
      ...opaqueTestRendition("zero-average"),
      bitrate: { average: 0, peak: 2_000 }
    } as unknown as RenditionV01;
    const abovePeak = {
      ...opaqueTestRendition("above-peak"),
      bitrate: { average: 2_001, peak: 2_000 }
    } as unknown as RenditionV01;
    const unsafeAverage = {
      ...opaqueTestRendition("unsafe-average"),
      bitrate: { average: Number.MAX_SAFE_INTEGER + 1, peak: 2_000 }
    } as unknown as RenditionV01;

    for (const rendition of [
      wrongRect,
      zeroAverage,
      abovePeak,
      unsafeAverage
    ]) {
      expect(() => createAvcRenditionCandidates([rendition]))
        .toThrow(RuntimePlaybackError);
      try {
        createAvcRenditionCandidates([rendition]);
      } catch (error) {
        expect(error).toMatchObject({
          code: "invalid-asset",
          failure: { context: { rendition: rendition.id } }
        });
      }
    }
  });

  it("returns deeply immutable candidates detached from mutable input", () => {
    const source = opaqueTestRendition("opaque");
    const candidates = createAvcRenditionCandidates([source]);
    const candidate = candidates[0]!;

    expect(candidate).toMatchObject({
      rank: 0,
      visibleColorArea: 4_096,
      codedArea: 4_096,
      rendition: { id: "opaque" }
    });
    expect(Object.isFrozen(candidates)).toBe(true);
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(Object.isFrozen(candidate.rendition)).toBe(true);
    expect(Object.isFrozen(candidate.rendition.alphaLayout)).toBe(true);
    expect(Object.isFrozen(candidate.rendition.alphaLayout.colorRect)).toBe(
      true
    );
    expect(Object.isFrozen(candidate.rendition.bitrate)).toBe(true);
    expect(Object.isFrozen(candidate.rendition.capabilities)).toBe(true);
  });

  it("strictly inspects every catalog unit before a candidate reaches a worker", () => {
    const catalog = installRuntimeAssetCatalog(createOpaqueTestAsset());
    const candidate = createAvcRenditionCandidates(
      catalog.manifest.renditions
    )[0]!;
    const result = inspectAvcRenditionCandidate(catalog, candidate);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("valid opaque fixture failed strict inspection");
    }
    expect(result.inspection.units.map((unit) => unit.id)).toEqual([
      "body",
      "intro"
    ]);
    expect(result.inspection.units.map((unit) => unit.frames.length)).toEqual([
      2,
      2
    ]);
    expect(result.report).toEqual({
      rendition: "opaque",
      rank: 0,
      outcome: "eligible",
      failure: null
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.report)).toBe(true);
    expect(Object.isFrozen(result.inspection)).toBe(true);
  });

  it("inspects borrowed backing without allocating samples or mutating residency", () => {
    const catalog = installRuntimeAssetCatalog(createOpaqueTestAsset());
    const expected = catalog.records.values().map((entry) => ({
      identity: `${entry.rendition}/${entry.unit}/${String(entry.localFrame)}`,
      bytes: new Uint8Array(catalog.copySample(
        entry.rendition,
        entry.unit,
        entry.localFrame
      )).slice()
    }));
    const before = catalog.residencySnapshot();
    const copySample = vi.spyOn(catalog, "copySample");
    const candidate = createAvcRenditionCandidates(
      catalog.manifest.renditions,
      catalog.manifest.canvas
    )[0]!;

    const result = inspectAvcRenditionCandidate(catalog, candidate);

    expect(result.ok).toBe(true);
    expect(copySample).not.toHaveBeenCalled();
    expect(catalog.residencySnapshot()).toEqual(before);
    copySample.mockRestore();
    expect(catalog.records.values().map((entry) => ({
      identity: `${entry.rendition}/${entry.unit}/${String(entry.localFrame)}`,
      bytes: new Uint8Array(catalog.copySample(
        entry.rendition,
        entry.unit,
        entry.localFrame
      ))
    }))).toEqual(expected);
    catalog.dispose();
  });

  it("normalizes strict inspector context into an immutable rejected report", () => {
    const catalog = installRuntimeAssetCatalog(createOpaqueTestAsset({
      corruptIntroDelta: true
    }));
    const candidate = createAvcRenditionCandidates(
      catalog.manifest.renditions
    )[0]!;
    const result = inspectAvcRenditionCandidate(catalog, candidate);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("corrupt opaque fixture passed strict inspection");
    }
    expect(result.inspection).toBeNull();
    expect(result.report.outcome).toBe("rejected");
    expect(result.report.failure).toMatchObject({
      code: "unsupported-profile",
      context: {
        rendition: "opaque",
        sourceCode: "PROFILE_INVALID"
      }
    });
    expect(result.report.failure?.context.sourcePath).toContain("units[1]");
    expect(result.report.failure?.message).not.toContain("intro");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.report)).toBe(true);
    expect(Object.isFrozen(result.report.failure)).toBe(true);
    expect(Object.isFrozen(result.report.failure?.context)).toBe(true);
  });
});

function id(candidate: { readonly rendition: { readonly id: string } }): string {
  return candidate.rendition.id;
}
