import { describe, expect, it, vi } from "vitest";

import type {
  CompiledManifest,
  ProductionRendition,
  VideoBitDepth,
  VideoBitstream,
  VideoCodec
} from "@pixel-point/aval-format";
import {
  inspectBorrowedVideoRendition,
  type BorrowedVideoRenditionPlan
} from "./video-codec-adapters.js";
import { certifyVideoRenditions } from "./video-rendition-certification.js";

const H264_ACCESS_UNITS = Object.freeze([
  Object.freeze({
    key: true,
    bytes: fromHex(
      "000000010910000000016742e020f42134d40404050000030001000003003c8da08846a00000000168ce32c80000000165b840fc"
    )
  }),
  Object.freeze({
    key: false,
    bytes: fromHex("0000000109300000000141e243f0")
  })
]);

const H265_ACCESS_UNITS = Object.freeze([
  Object.freeze({
    key: true,
    bytes: fromHex(
      "000000014601100000000140010c01ffff01600000030090000003000003001e95c0900000000142010101600000030090000003000003001ea02081059657924caf016a020202080000030008000003002840000000014401c171839920000000012801ae55565556"
    )
  }),
  Object.freeze({
    key: false,
    bytes: fromHex("00000001460130000000010201d021494055565556")
  }),
  Object.freeze({
    key: false,
    bytes: fromHex("00000001460150000000010201e044955055565556")
  }),
  Object.freeze({
    key: false,
    bytes: fromHex("00000001460150000000010001e024bd55565556")
  }),
  Object.freeze({
    key: false,
    bytes: fromHex("00000001460150000000010001e064bd55565556")
  }),
  Object.freeze({
    key: false,
    bytes: fromHex("00000001460130000000010201d0297455565556")
  })
]);

const VP9_KEY = Uint8Array.of(
  0x82, 0x49, 0x83, 0x42, 0x40, 0x03, 0xf0, 0x01, 0xf6, 0x08
);
const VP9_HIDDEN = Uint8Array.of(0x84);
const VP9_SHOWN = Uint8Array.of(0x86);

const AV1_SEQUENCE = fromHex("00000002a7ff36be4404040410");
const AV1_KEY = packet(
  obu(2, new Uint8Array()),
  obu(1, AV1_SEQUENCE),
  obu(6, Uint8Array.of(0x14))
);
const AV1_HIDDEN = packet(obu(2, new Uint8Array()), obu(6, Uint8Array.of(0x24)));
const AV1_SHOWN = packet(obu(2, new Uint8Array()), obu(6, Uint8Array.of(0x34)));

interface CodecFixture {
  readonly plan: BorrowedVideoRenditionPlan;
  readonly blobs: Map<string, Uint8Array>;
}

const EXPECTED = Object.freeze({
  h264: Object.freeze({
    codec: "avc1.42E020",
    bitstream: "annex-b" as const,
    bitDepth: 8 as const,
    width: 64,
    height: 64,
    types: Object.freeze(["key", "delta"]),
    presentations: Object.freeze([[0], [1]])
  }),
  h265: Object.freeze({
    codec: "hvc1.1.6.L30.90",
    bitstream: "annex-b" as const,
    bitDepth: 8 as const,
    width: 64,
    height: 64,
    types: Object.freeze(["key", "delta", "delta", "delta", "delta", "delta"]),
    presentations: Object.freeze([[0], [4], [2], [1], [3], [5]])
  }),
  vp9: Object.freeze({
    codec: "vp09.00.10.08.01.01.01.01.00",
    bitstream: "frame" as const,
    bitDepth: 8 as const,
    width: 64,
    height: 32,
    types: Object.freeze(["key", "delta", "delta"]),
    presentations: Object.freeze([[0], [], [1]])
  }),
  av1: Object.freeze({
    codec: "av01.0.00M.08.0.110.01.01.01.0",
    bitstream: "low-overhead" as const,
    bitDepth: 8 as const,
    width: 64,
    height: 32,
    types: Object.freeze(["key", "delta", "delta"]),
    presentations: Object.freeze([[0], [], [1]])
  })
});

describe("codec-neutral borrowed video inspection", () => {
  it.each(["h264", "h265", "vp9", "av1"] as const)(
    "certifies %s and derives an exact byte-free decoder plan",
    (family) => {
      const fixture = createFixture(family);
      let active = true;
      const borrow = vi.fn((key: string, offset: number, length: number) => {
        expect(active).toBe(true);
        const bytes = fixture.blobs.get(key);
        if (bytes === undefined) throw new Error("unknown fixture blob");
        return bytes.subarray(offset, offset + length);
      });

      const result = inspectBorrowedVideoRendition(fixture.plan, borrow);
      active = false;
      const expected = EXPECTED[family];

      expect(result).toMatchObject({
        family,
        bitstream: expected.bitstream,
        bitDepth: expected.bitDepth,
        decoderConfig: {
          codec: expected.codec,
          codedWidth: expected.width,
          codedHeight: expected.height,
          displayAspectWidth: expected.width,
          displayAspectHeight: expected.height,
          colorSpace: {
            primaries: "bt709",
            transfer: "bt709",
            matrix: "bt709",
            fullRange: false
          }
        }
      });
      expect(Object.hasOwn(result.decoderConfig, "description")).toBe(false);
      expect(result.units).toHaveLength(1);
      expect(result.units[0]!.submissions.map(({ chunkType }) => chunkType)).toEqual(
        expected.types
      );
      expect(
        result.units[0]!.submissions.map(({ presentationIndices }) =>
          presentationIndices
        )
      ).toEqual(expected.presentations);
      expect(
        result.units[0]!.submissions.map(({ decodeIndex }) => decodeIndex)
      ).toEqual(expected.types.map((_, index) => index));
      expect(borrow).toHaveBeenCalledTimes(expected.types.length);
      expect(containsBorrowedAuthority(result)).toBe(false);
      expect(isDeeplyFrozen(result)).toBe(true);

      const stableResult = JSON.stringify(result);
      for (const bytes of fixture.blobs.values()) bytes.fill(0xff);
      expect(JSON.stringify(result)).toBe(stableResult);
    }
  );

  it("keeps codec-specific color certification behind the selected adapter", () => {
    const color = createFixture("vp9");
    color.blobs.get("chunk-0")![4] = 0x20;
    expect(() => inspectBorrowedVideoRendition(
      color.plan,
      createBorrow(color)
    )).toThrow(/BT\.709/iu);
  });

  it("rejects an H264 manifest profile that disagrees with the inspected SPS", () => {
    const mismatch = createFixture("h264", "avc1.640020");
    expect(() => inspectBorrowedVideoRendition(
      mismatch.plan,
      createBorrow(mismatch)
    )).toThrow(/inspected codec string disagrees/iu);
  });

  it("rejects hostile chunk metadata before producing decoder submissions", () => {
    const displayed = createFixture("vp9");
    const hidden = displayed.plan.units[0]!.chunks[1]!;
    expect(() => inspectBorrowedVideoRendition({
      ...displayed.plan,
      units: [{
        ...displayed.plan.units[0]!,
        chunks: [
          displayed.plan.units[0]!.chunks[0]!,
          {
            ...hidden,
            record: {
              ...hidden.record,
              duration: 1_000,
              displayedFrameCount: 1
            }
          },
          displayed.plan.units[0]!.chunks[2]!
        ]
      }]
    }, createBorrow(displayed))).toThrow(/bitstream displayed frame count disagrees/iu);

    const key = createFixture("vp9");
    const hiddenKey = key.plan.units[0]!.chunks[1]!;
    expect(() => inspectBorrowedVideoRendition({
      ...key.plan,
      units: [{
        ...key.plan.units[0]!,
        chunks: [
          key.plan.units[0]!.chunks[0]!,
          {
            ...hiddenKey,
            record: { ...hiddenKey.record, randomAccess: true }
          },
          key.plan.units[0]!.chunks[2]!
        ]
      }]
    }, createBorrow(key))).toThrow(/key assertion disagrees/iu);

    const timeline = createFixture("h265");
    const second = timeline.plan.units[0]!.chunks[1]!;
    expect(() => inspectBorrowedVideoRendition({
      ...timeline.plan,
      units: [{
        ...timeline.plan.units[0]!,
        chunks: [
          timeline.plan.units[0]!.chunks[0]!,
          {
            ...second,
            record: { ...second.record, presentationTimestamp: 0 }
          },
          ...timeline.plan.units[0]!.chunks.slice(2)
        ]
      }]
    }, createBorrow(timeline))).toThrow(/duplicate presentation timestamps/iu);
  });

  it("rejects malformed borrowed views", () => {
    const fixture = createFixture("av1");
    expect(() => inspectBorrowedVideoRendition(
      fixture.plan,
      (_key, _offset, length) => new Uint8Array(length - 1)
    )).toThrow(/borrowed bytes.*malformed/iu);
  });
});

function createFixture(family: VideoCodec, codecOverride?: string): CodecFixture {
  const spec = fixtureSpec(family);
  const blobs = new Map<string, Uint8Array>();
  let byteOffset = 0;
  const chunks = spec.chunks.map((chunk, index) => {
    const key = `chunk-${String(index)}`;
    const bytes = chunk.bytes.slice();
    blobs.set(key, bytes);
    const record = Object.freeze({
      byteOffset,
      byteLength: bytes.byteLength,
      presentationTimestamp: spec.timestamps[index]!,
      duration: spec.durations[index]!,
      randomAccess: chunk.key,
      displayedFrameCount: spec.displayedFrameCounts[index]!
    });
    byteOffset += bytes.byteLength;
    return Object.freeze({
      blobKey: key,
      relativeOffset: 0,
      byteLength: bytes.byteLength,
      record
    });
  });
  const rendition: ProductionRendition = Object.freeze({
    id: "main",
    codec: codecOverride ?? spec.codec,
    bitDepth: spec.bitDepth,
    codedWidth: spec.width,
    codedHeight: spec.height,
    alphaLayout: Object.freeze({
      type: "opaque" as const,
      colorRect: Object.freeze([0, 0, spec.width, spec.height] as const)
    }),
    bitrate: Object.freeze(spec.bitrate)
  });
  const manifest: CompiledManifest = Object.freeze({
    formatVersion: "1.0",
    generator: "adapter-test",
    codec: family,
    bitstream: spec.bitstream,
    layout: "opaque",
    canvas: Object.freeze({
      width: spec.width,
      height: spec.height,
      fit: "contain" as const,
      pixelAspect: Object.freeze([1, 1] as const),
      colorSpace: "srgb" as const
    }),
    frameRate: Object.freeze(spec.frameRate),
    renditions: Object.freeze([rendition]),
    units: Object.freeze([]),
    initialState: "idle",
    states: Object.freeze([]),
    edges: Object.freeze([]),
    bindings: Object.freeze([]),
    readiness: Object.freeze({
      policy: "all-routes" as const,
      bootstrapUnits: Object.freeze([]),
      immediateEdges: Object.freeze([])
    }),
    limits: Object.freeze({
      maxCompiledBytes: 1_000_000,
      maxRuntimeBytes: 1_000_000,
      decodedPixelBytes: 1,
      persistentCacheBytes: 1,
      runtimeWorkingSetBytes: 1
    })
  });
  const candidate = certifyVideoRenditions(manifest)[0]!;
  return {
    plan: Object.freeze({
      candidate,
      frameRate: manifest.frameRate,
      units: Object.freeze([Object.freeze({
        id: "unit",
        expectedDisplayedFrames: spec.expectedDisplayedFrames,
        chunks: Object.freeze(chunks)
      })])
    }),
    blobs
  };
}

function fixtureSpec(family: VideoCodec): {
  readonly codec: string;
  readonly bitstream: VideoBitstream;
  readonly bitDepth: VideoBitDepth;
  readonly width: number;
  readonly height: number;
  readonly frameRate: { readonly numerator: number; readonly denominator: number };
  readonly bitrate: { readonly average: number; readonly peak: number };
  readonly chunks: readonly { readonly key: boolean; readonly bytes: Uint8Array }[];
  readonly timestamps: readonly number[];
  readonly durations: readonly number[];
  readonly displayedFrameCounts: readonly number[];
  readonly expectedDisplayedFrames: number;
} {
  switch (family) {
    case "h264":
      return {
        ...EXPECTED.h264,
        frameRate: { numerator: 30, denominator: 1 },
        bitrate: { average: 1_000_000, peak: 2_000_000 },
        chunks: H264_ACCESS_UNITS,
        timestamps: [0, 1_000],
        durations: [1_000, 1_000],
        displayedFrameCounts: [1, 1],
        expectedDisplayedFrames: 2
      };
    case "h265":
      return {
        ...EXPECTED.h265,
        frameRate: { numerator: 5, denominator: 1 },
        bitrate: { average: 100_000, peak: 200_000 },
        chunks: H265_ACCESS_UNITS,
        timestamps: [0, 4_000, 2_000, 1_000, 3_000, 5_000],
        durations: [1_000, 1_000, 1_000, 1_000, 1_000, 1_000],
        displayedFrameCounts: [1, 1, 1, 1, 1, 1],
        expectedDisplayedFrames: 6
      };
    case "vp9":
      return {
        ...EXPECTED.vp9,
        frameRate: { numerator: 30, denominator: 1 },
        bitrate: { average: 100_000, peak: 200_000 },
        chunks: [
          { key: true, bytes: VP9_KEY },
          { key: false, bytes: VP9_HIDDEN },
          { key: false, bytes: VP9_SHOWN }
        ],
        timestamps: [0, 1_000, 1_000],
        durations: [1_000, 0, 1_000],
        displayedFrameCounts: [1, 0, 1],
        expectedDisplayedFrames: 2
      };
    case "av1":
      return {
        ...EXPECTED.av1,
        frameRate: { numerator: 30, denominator: 1 },
        bitrate: { average: 100_000, peak: 200_000 },
        chunks: [
          { key: true, bytes: AV1_KEY },
          { key: false, bytes: AV1_HIDDEN },
          { key: false, bytes: AV1_SHOWN }
        ],
        timestamps: [0, 1_000, 1_000],
        durations: [1_000, 0, 1_000],
        displayedFrameCounts: [1, 0, 1],
        expectedDisplayedFrames: 2
      };
    default:
      return exhaustiveFamily(family);
  }
}

function createBorrow(fixture: CodecFixture) {
  return (key: string, offset: number, length: number): Uint8Array => {
    const bytes = fixture.blobs.get(key);
    if (bytes === undefined) throw new Error("unknown fixture blob");
    return bytes.subarray(offset, offset + length);
  };
}

function containsBorrowedAuthority(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === "function" || value instanceof Uint8Array) return true;
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((entry) => containsBorrowedAuthority(entry, seen));
}

function isDeeplyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== "object" || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) &&
    Object.values(value).every((entry) => isDeeplyFrozen(entry, seen));
}

function fromHex(value: string): Uint8Array {
  if (value.length % 2 !== 0) throw new Error("fixture hex must contain whole bytes");
  const bytes = new Uint8Array(value.length / 2);
  for (let offset = 0; offset < value.length; offset += 2) {
    bytes[offset / 2] = Number.parseInt(value.slice(offset, offset + 2), 16);
  }
  return bytes;
}

function obu(type: number, payload: Uint8Array): Uint8Array {
  return Uint8Array.of((type << 3) | 0x02, payload.byteLength, ...payload);
}

function packet(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function exhaustiveFamily(value: never): never {
  throw new Error(`unsupported fixture family ${String(value)}`);
}
