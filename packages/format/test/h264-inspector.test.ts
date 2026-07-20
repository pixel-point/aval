import { describe, expect, it } from "vitest";

import { FormatError } from "../src/errors.js";
import { inspectH264AnnexBRendition } from "../src/h264/index.js";
import {
  makeAccessUnit,
  makeAud,
  makePps,
  makeSlice,
  makeSps,
  type PpsFixtureOptions,
  type SpsFixtureOptions,
  validInspectionInput
} from "./h264-fixture.js";

describe("H264 profile-aware inspection", () => {
  it("returns canonical decoder facts for independently decodable units", () => {
    const inspection = inspectH264AnnexBRendition(validInspectionInput());

    expect(inspection.parameterSet).toMatchObject({
      profileIdc: 100,
      codec: "avc1.640020",
      bitDepth: 8,
      chromaFormat: "4:2:0",
      maxNumRefFrames: 4,
      maxNumReorderFrames: 2,
      maxDecFrameBuffering: 4
    });
    expect(inspection.units.map((unit) => unit.decodeToPresentation))
      .toEqual([[0, 1], [0, 1]]);
    expect(inspection.units[0]?.accessUnits.map((unit) => unit.sliceType))
      .toEqual(["I", "P"]);
  });

  it("accepts the canonical Constrained Baseline subset without reordering", () => {
    const inspection = inspectH264AnnexBRendition(validInspectionInput({
      spsOptions: {
        profileIdc: 66,
        maxNumRefFrames: 1,
        maxNumReorderFrames: 0,
        maxDecFrameBuffering: 1
      },
      ppsOptions: { profileIdc: 66 }
    }));

    expect(inspection.parameterSet).toMatchObject({
      profile: "constrained-baseline",
      profileIdc: 66,
      codec: "avc1.42E020",
      maxNumRefFrames: 1,
      maxNumReorderFrames: 0,
      maxDecFrameBuffering: 1
    });
    expect(inspection.units[0]?.accessUnits.map(({ sliceType }) => sliceType))
      .toEqual(["I", "P"]);
    expect(inspection.units[0]?.decodeToPresentation).toEqual([0, 1]);
  });

  it.each([
    ["CABAC", () => baselineInput({ pps: { entropyCoding: true } })],
    ["more than one SPS reference", () => baselineInput({
      sps: { maxNumRefFrames: 2, maxDecFrameBuffering: 2 }
    })],
    ["more than one default PPS reference", () => baselineInput({
      pps: { refList0Minus1: 1 }
    })],
    ["weighted prediction", () => baselineInput({
      pps: { weightedPrediction: true }
    })],
    ["8x8 transform extension", () => baselineInput({
      pps: { transform8x8: true }
    })],
    ["B-pictures", baselineBPictureInput],
    ["non-identity presentation order", nonIdentityBaselineInput]
  ] as const)("rejects Constrained Baseline %s", (_name, input) => {
    expectProfileError(() => inspectH264AnnexBRendition(input()));
  });

  it("derives a bounded decode-to-presentation map for reference and non-reference B pictures", () => {
    const inspection = inspectH264AnnexBRendition(reorderedInput(2));
    const unit = inspection.units[0];

    expect(unit?.decodeToPresentation).toEqual([0, 4, 2, 1, 3]);
    expect(unit?.accessUnits.map(({ decodeIndex, presentationIndex, pictureOrderCount }) => ({
      decodeIndex,
      presentationIndex,
      pictureOrderCount
    }))).toEqual([
      { decodeIndex: 0, presentationIndex: 0, pictureOrderCount: 0 },
      { decodeIndex: 1, presentationIndex: 4, pictureOrderCount: 8 },
      { decodeIndex: 2, presentationIndex: 2, pictureOrderCount: 4 },
      { decodeIndex: 3, presentationIndex: 1, pictureOrderCount: 2 },
      { decodeIndex: 4, presentationIndex: 3, pictureOrderCount: 6 }
    ]);
    expect(unit?.accessUnits.map(({ sliceType }) => sliceType))
      .toEqual(["I", "P", "B", "B", "B"]);
  });

  it("rejects reordering beyond the SPS declaration", () => {
    expectProfileError(() => inspectH264AnnexBRendition(reorderedInput(1)));
  });

  it("rejects duplicate picture-order counts and broken short-term frame numbering", () => {
    const duplicate = reorderedInput(2);
    duplicate.units[0]!.accessUnits[4] = makeAccessUnit({
      idr: false,
      frameNum: 3,
      sliceType: "B",
      reference: false,
      picOrderCntLsb: 4,
      aud: makeAud(2)
    });
    expectProfileError(() => inspectH264AnnexBRendition(duplicate));

    const numbering = reorderedInput(2);
    numbering.units[0]!.accessUnits[1] = makeAccessUnit({
      idr: false,
      frameNum: 2,
      picOrderCntLsb: 8,
      aud: makeAud(1)
    });
    expectProfileError(() => inspectH264AnnexBRendition(numbering));
  });

  it("rejects noncanonical Baseline flags, start codes, and unit starts without an IDR", () => {
    expectProfileError(() => inspectH264AnnexBRendition(validInspectionInput({
      spsOptions: { profileIdc: 66, compatibility: 0xc0 }
    })));

    const noncanonical = validInspectionInput();
    const bytes = noncanonical.units[0]!.accessUnits[0]!.bytes;
    noncanonical.units[0]!.accessUnits[0]!.bytes = bytes.slice(1);
    expectProfileError(() => inspectH264AnnexBRendition(noncanonical));

    const missingIdr = validInspectionInput();
    missingIdr.units[0]!.accessUnits[0] = makeAccessUnit({
      idr: false,
      frameNum: 1,
      aud: makeAud(1)
    });
    expectProfileError(() => inspectH264AnnexBRendition(missingIdr));
  });

  it("rejects every strict prefix truncation of a canonical key access unit", () => {
    const canonical = validInspectionInput();
    const key = canonical.units[0]!.accessUnits[0]!.bytes;
    for (let length = 0; length < key.byteLength; length += 1) {
      const input = validInspectionInput();
      input.units[0]!.accessUnits[0]!.bytes = key.slice(0, length);
      expectProfileError(() => inspectH264AnnexBRendition(input));
    }
  });

  it("rejects B-picture syntax that disagrees with the AUD", () => {
    const input = reorderedInput(2);
    input.units[0]!.accessUnits[2] = makeAccessUnit({
      idr: false,
      frameNum: 2,
      sliceType: "B",
      picOrderCntLsb: 4,
      aud: makeAud(1)
    });
    expectProfileError(() => inspectH264AnnexBRendition(input));
  });

  it("rejects long-term reference assignment while accepting bounded short-term release", () => {
    const accepted = validInspectionInput();
    accepted.units[0]!.accessUnits[1] = makeAccessUnit({
      idr: false,
      frameNum: 1,
      aud: makeAud(1),
      slices: [makeSlice({
        idr: false,
        frameNum: 1,
        picOrderCountType: 0,
        picOrderCntLsb: 2,
        adaptiveMarking: true,
        adaptiveMarkingOperation: 1
      })]
    });
    expect(() => inspectH264AnnexBRendition(accepted)).not.toThrow();

    const rejected = validInspectionInput();
    rejected.units[0]!.accessUnits[1] = makeAccessUnit({
      idr: false,
      frameNum: 1,
      aud: makeAud(1),
      slices: [makeSlice({
        idr: false,
        frameNum: 1,
        picOrderCountType: 0,
        picOrderCntLsb: 2,
        adaptiveMarking: true,
        adaptiveMarkingOperation: 2
      })]
    });
    expectProfileError(() => inspectH264AnnexBRendition(rejected));
  });
});

function reorderedInput(maxNumReorderFrames: number) {
  const sps = makeSps({ maxNumReorderFrames, maxDecFrameBuffering: 4 });
  const pps = makePps();
  return {
    profile: {
      codedWidth: 64,
      codedHeight: 64,
      expectedVisibleRect: [0, 0, 64, 64] as const,
      frameRate: { numerator: 30, denominator: 1 },
      requireBt709LimitedRange: true as const
    },
    units: [{
      id: "unit",
      accessUnits: [
        makeAccessUnit({ idr: true, frameNum: 0, picOrderCntLsb: 0, sps, pps, aud: makeAud(0) }),
        makeAccessUnit({ idr: false, frameNum: 1, picOrderCntLsb: 8, aud: makeAud(1) }),
        makeAccessUnit({ idr: false, frameNum: 2, sliceType: "B", picOrderCntLsb: 4, aud: makeAud(2) }),
        makeAccessUnit({
          idr: false,
          frameNum: 3,
          sliceType: "B",
          reference: false,
          picOrderCntLsb: 2,
          aud: makeAud(2)
        }),
        makeAccessUnit({
          idr: false,
          frameNum: 3,
          sliceType: "B",
          reference: false,
          picOrderCntLsb: 6,
          aud: makeAud(2)
        })
      ]
    }]
  };
}

function baselineInput(options: {
  readonly sps?: Readonly<SpsFixtureOptions>;
  readonly pps?: Readonly<PpsFixtureOptions>;
} = {}) {
  return validInspectionInput({
    spsOptions: {
      profileIdc: 66,
      maxNumRefFrames: 1,
      maxNumReorderFrames: 0,
      maxDecFrameBuffering: 1,
      ...options.sps
    },
    ppsOptions: {
      profileIdc: 66,
      ...options.pps
    }
  });
}

function baselineBPictureInput() {
  const input = baselineInput();
  input.units[0]!.accessUnits[1] = makeAccessUnit({
    idr: false,
    frameNum: 1,
    sliceType: "B",
    reference: false,
    picOrderCntLsb: 2,
    aud: makeAud(2),
    entropyCoding: false
  });
  return input;
}

function nonIdentityBaselineInput() {
  const spsOptions = Object.freeze({
    profileIdc: 66 as const,
    maxNumRefFrames: 1,
    maxNumReorderFrames: 0,
    maxDecFrameBuffering: 1
  });
  const sps = makeSps(spsOptions);
  const pps = makePps({ profileIdc: 66 });
  return validInspectionInput({
    spsOptions,
    ppsOptions: { profileIdc: 66 },
    units: [{
      id: "unit",
      accessUnits: [
        makeAccessUnit({
          idr: true,
          frameNum: 0,
          picOrderCntLsb: 0,
          sps,
          pps,
          aud: makeAud(0),
          entropyCoding: false
        }),
        makeAccessUnit({
          idr: false,
          frameNum: 1,
          picOrderCntLsb: 4,
          aud: makeAud(1),
          entropyCoding: false
        }),
        makeAccessUnit({
          idr: false,
          frameNum: 2,
          picOrderCntLsb: 2,
          aud: makeAud(1),
          entropyCoding: false
        })
      ]
    }]
  });
}

function expectProfileError(operation: () => unknown): void {
  expect(operation).toThrow(FormatError);
}
