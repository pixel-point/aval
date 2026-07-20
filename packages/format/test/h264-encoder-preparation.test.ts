import { describe, expect, it } from "vitest";

import { FormatError } from "../src/errors.js";
import { splitAnnexBAccessUnit } from "../src/h264/annex-b.js";
import {
  inspectH264AnnexBRendition,
  prepareH264EncoderRendition
} from "../src/h264/index.js";
import {
  concat,
  makeAccessUnit,
  makeAud,
  makePps,
  makeSps,
  nal
} from "./h264-fixture.js";

const PROFILE = Object.freeze({
  codedWidth: 64,
  codedHeight: 64,
  expectedVisibleRect: Object.freeze([0, 0, 64, 64] as const),
  frameRate: Object.freeze({ numerator: 30, denominator: 1 }),
  requireBt709LimitedRange: true as const
});

// Eight 48x96 yuv420p frames emitted by libx264 r3108. Only the encoder-info
// SEI was removed to keep the checked-in fixture compact; coded NALs are exact.
const REAL_X264_HIGH_B_FRAMES =
  "AAAAAQkQAAAAAWdkAAqs2YzbAWoCAgKAAAADAIAAAB5HiRLNAAAAAWjpeBnLIsAAAAFliIQB//731LfMsu4HIrYLqPdus2Ds53A03ybfoqbhhHgfAAAAAQkwAAABQZokbF/+2qZ00AAAAAEJUAAAAUGeQji/AB8RAAAAAQlQAAABAZ5hNF8AHxAAAAABCVAAAAEBnmNqXwAfEQAAAAEJMAAAAUGaZ0moQWiZTAv//tqmdNEAAAABCVAAAAFBnoUuUTf/AB8RAAAAAQlQAAABAZ6mbl8AHxE=";

describe("H264 encoder preparation", () => {
  it("canonicalizes libx264 C0 Baseline signalling to strict E0", () => {
    const sps = makeSps({
      profileIdc: 66,
      compatibility: 0xc0,
      maxNumRefFrames: 1,
      maxNumReorderFrames: 0,
      maxDecFrameBuffering: 1
    });
    const pps = makePps({ profileIdc: 66 });
    const bytes = makeAccessUnit({
      idr: true,
      frameNum: 0,
      sps,
      pps,
      aud: makeAud(0),
      entropyCoding: false
    }).bytes;

    const prepared = prepareH264EncoderRendition({
      profile: PROFILE,
      units: [{ id: "unit", bytes, expectedAccessUnitCount: 1 }]
    });
    const canonical = prepared.units[0]?.accessUnits[0]?.bytes;
    const canonicalSps = splitAnnexBAccessUnit(
      canonical ?? new Uint8Array(),
      "canonical"
    ).find(({ type }) => type === 7);

    expect(canonicalSps?.payload[2]).toBe(0xe0);
    expect(splitAnnexBAccessUnit(bytes, "candidate").find(({ type }) => type === 7)
      ?.payload[2]).toBe(0xc0);
    expect(prepared.inspection.parameterSet).toMatchObject({
      profile: "constrained-baseline",
      codec: "avc1.42E020"
    });
  });

  it("rejects a real libx264 High-profile candidate at the publication boundary", () => {
    expectProfileError(() => prepareH264EncoderRendition({
      profile: {
        codedWidth: 48,
        codedHeight: 96,
        expectedVisibleRect: [0, 0, 48, 96],
        frameRate: { numerator: 30, denominator: 1 },
        requireBt709LimitedRange: true
      },
      units: [{
        id: "unit",
        bytes: new Uint8Array(Buffer.from(REAL_X264_HIGH_B_FRAMES, "base64")),
        expectedAccessUnitCount: 8
      }]
    }));
  });

  it("keeps the real legacy High rendition readable through strict inspection", () => {
    const bytes = new Uint8Array(Buffer.from(REAL_X264_HIGH_B_FRAMES, "base64"));
    const accessUnitOffsets = splitAnnexBAccessUnit(bytes, "legacy-high")
      .filter(({ type }) => type === 9)
      .map(({ offset, prefixLength }) => offset - prefixLength);
    const inspection = inspectH264AnnexBRendition({
      profile: {
        codedWidth: 48,
        codedHeight: 96,
        expectedVisibleRect: [0, 0, 48, 96],
        frameRate: { numerator: 30, denominator: 1 },
        requireBt709LimitedRange: true
      },
      units: [{
        id: "unit",
        accessUnits: accessUnitOffsets.map((offset, index) => ({
          key: index === 0,
          bytes: canonicalizeStartCodes(bytes.slice(
            offset,
            accessUnitOffsets[index + 1] ?? bytes.length
          ))
        }))
      }]
    });

    expect(inspection.parameterSet.codec).toBe("avc1.64000A");
    expect(inspection.units[0]?.accessUnits.map(({ sliceType }) => sliceType))
      .toEqual(["I", "P", "B", "B", "B", "P", "B", "B"]);
    expect(inspection.units[0]?.decodeToPresentation)
      .toEqual([0, 4, 2, 1, 3, 7, 5, 6]);
  });

  it("strips bounded encoder SEI and emits canonical four-byte start codes", () => {
    const sps = makeSps({
      profileIdc: 66,
      compatibility: 0xc0,
      maxNumRefFrames: 1,
      maxNumReorderFrames: 0,
      maxDecFrameBuffering: 1
    });
    const pps = makePps({ profileIdc: 66 });
    const key = makeAccessUnit({
      idr: true,
      frameNum: 0,
      picOrderCntLsb: 0,
      sps,
      pps,
      aud: makeAud(0),
      entropyCoding: false
    });
    const sei = nal(0x06, Uint8Array.of(0x80), 3);
    const bytes = concat(
      makeAud(0),
      sps,
      pps,
      sei,
      key.bytes.slice(makeAud(0).byteLength + sps.byteLength + pps.byteLength)
    );
    const prepared = prepareH264EncoderRendition({
      profile: PROFILE,
      units: [{ id: "unit", bytes, expectedAccessUnitCount: 1 }]
    });
    const canonical = prepared.units[0]?.accessUnits[0]?.bytes;

    expect(canonical).toBeInstanceOf(Uint8Array);
    expect(splitAnnexBAccessUnit(canonical ?? new Uint8Array(), "canonical"))
      .toMatchObject([
        { type: 9, prefixLength: 4 },
        { type: 7, prefixLength: 4 },
        { type: 8, prefixLength: 4 },
        { type: 5, prefixLength: 4 }
      ]);
  });

  it("rejects count mismatches, duplicate unit ids, and unsupported NAL syntax", () => {
    const bytes = baselineStream();
    expectProfileError(() => prepareH264EncoderRendition({
      profile: PROFILE,
      units: [{ id: "unit", bytes, expectedAccessUnitCount: 1 }]
    }));
    expectProfileError(() => prepareH264EncoderRendition({
      profile: PROFILE,
      units: [
        { id: "unit", bytes, expectedAccessUnitCount: 2 },
        { id: "unit", bytes, expectedAccessUnitCount: 2 }
      ]
    }));
    expectProfileError(() => prepareH264EncoderRendition({
      profile: PROFILE,
      units: [{
        id: "unit",
        bytes: concat(makeAud(0), nal(0x0c, Uint8Array.of(0x80), 4)),
        expectedAccessUnitCount: 1
      }]
    }));
  });
});

function baselineStream(): Uint8Array {
  const sps = makeSps({
    profileIdc: 66,
    compatibility: 0xc0,
    maxNumRefFrames: 1,
    maxNumReorderFrames: 0,
    maxDecFrameBuffering: 1
  });
  const pps = makePps({ profileIdc: 66 });
  return concat(
    makeAccessUnit({
      idr: true,
      frameNum: 0,
      picOrderCntLsb: 0,
      sps,
      pps,
      aud: makeAud(0),
      entropyCoding: false
    }).bytes,
    makeAccessUnit({
      idr: false,
      frameNum: 1,
      picOrderCntLsb: 2,
      aud: makeAud(1),
      entropyCoding: false
    }).bytes
  );
}

function expectProfileError(operation: () => unknown): void {
  expect(operation).toThrow(FormatError);
}

function canonicalizeStartCodes(accessUnit: Uint8Array): Uint8Array {
  const startCode = Uint8Array.of(0, 0, 0, 1);
  const nals = splitAnnexBAccessUnit(accessUnit, "legacy-high.access-unit");
  return concat(...nals.flatMap(({ payload }) => [startCode, payload]));
}
