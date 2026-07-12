import { describe, expect, it } from "vitest";

import { FormatError } from "../src/errors.js";
import {
  inspectAvcAnnexBEncoderCandidateRendition,
  inspectAvcAnnexBRendition
} from "../src/avc/index.js";
import {
  concat,
  makeAccessUnit,
  makeAud,
  makePps,
  makeSlice,
  makeSps,
  nal,
  validInspectionInput
} from "./avc-fixture.js";

describe("AVC Annex B Constrained Baseline inspector", () => {
  it("accepts stable independently decodable I/P units", () => {
    const inspection = inspectAvcAnnexBRendition(validInspectionInput());

    expect(inspection.macroblocksPerFrame).toBe(16);
    expect(inspection.parameterSet).toMatchObject({
      profileIdc: 66,
      constraintSet2: true,
      levelIdc: 32,
      codedWidth: 64,
      codedHeight: 64,
      maxNumRefFrames: 1,
      maxNumReorderFrames: 0,
      maxDecFrameBuffering: 1,
      hrdPresent: false
    });
    expect(inspection.units.map((unit) => unit.id)).toEqual(["idle", "hover"]);
    expect(inspection.units[0]?.frames).toMatchObject([
      { key: true, idr: true, sliceType: "I", nalUnitTypes: [9, 7, 8, 5] },
      { key: false, idr: false, sliceType: "P", nalUnitTypes: [9, 1] }
    ]);
    expect(Object.isFrozen(inspection)).toBe(true);
    expect(Object.isFrozen(inspection.units[0]?.frames)).toBe(true);
  });

  it("requires E0 strictly while the named encoder candidate accepts only C0/E0", () => {
    expect(
      inspectAvcAnnexBRendition(validInspectionInput()).parameterSet.constraintSet2
    ).toBe(true);
    const c0 = validInspectionInput({ spsOptions: { compatibility: 0xc0 } });
    expectProfileError(() => inspectAvcAnnexBRendition(c0));
    expect(
      inspectAvcAnnexBEncoderCandidateRendition(c0).parameterSet.constraintSet2
    ).toBe(false);
    expect(
      inspectAvcAnnexBEncoderCandidateRendition(
        validInspectionInput({ spsOptions: { compatibility: 0xe0 } })
      ).parameterSet.constraintSet2
    ).toBe(true);
  });

  it("rejects multiple slices even when they partition one picture", () => {
    const sps = makeSps({ compatibility: 0xe0 });
    const pps = makePps();
    const input = validInspectionInput({
      units: [
        {
          id: "idle",
          accessUnits: [
            makeAccessUnit({
              idr: true,
              frameNum: 0,
              sps,
              pps,
              slices: [
                makeSlice({ idr: true, frameNum: 0, sliceType: "I" }),
                makeSlice({
                  idr: true,
                  frameNum: 0,
                  sliceType: "I",
                  firstMacroblock: 8
                })
              ]
            })
          ]
        }
      ]
    });

    expectProfileError(() => inspectAvcAnnexBRendition(input));
  });

  it("rejects SPS crop and non-BT.709 signalling", () => {
    expectProfileError(() => inspectAvcAnnexBRendition(
      validInspectionInput({ spsOptions: { crop: [1, 2, 3, 4] } })
    ));
    expectProfileError(() => inspectAvcAnnexBRendition(
      validInspectionInput({ spsOptions: { bt709Limited: false } })
    ));
  });

  it("rejects NAL HRD declarations", () => {
    expectProfileError(() => inspectAvcAnnexBRendition(
      validInspectionInput({
        spsOptions: {
          hrd: { bitRateValueMinus1: 10_000, cpbSizeValueMinus1: 100_000 }
        }
      })
    ));
  });

  it.each([
    ["wrong profile", { profileIdc: 77 }],
    ["missing constraints", { compatibility: 0x00 }],
    ["reserved constraints", { compatibility: 0xc1 }],
    ["wrong level", { levelIdc: 31 }],
    ["too many references", { maxNumRefFrames: 2 }],
    ["reordering", { maxNumReorderFrames: 1 }],
    ["undersized DPB", { maxDecFrameBuffering: 0 }],
    ["missing VUI", { includeVui: false }],
    ["missing restriction", { includeBitstreamRestriction: false }]
  ])("rejects SPS profile violation: %s", (_label, spsOptions) => {
    expectProfileError(() =>
      inspectAvcAnnexBRendition(validInspectionInput({ spsOptions }))
    );
  });

  it("rejects a clear fixed_frame_rate_flag", () => {
    expectProfileError(() =>
      inspectAvcAnnexBRendition(
        validInspectionInput({ spsOptions: { fixedFrameRate: false } })
      )
    );
  });

  it("rejects dimensions, macroblock rate, VUI timing, and packed-alpha colour mismatches", () => {
    const dimensions = validInspectionInput();
    dimensions.profile.codedWidth = 80;
    expectProfileError(() => inspectAvcAnnexBRendition(dimensions));

    const macroblockRate = validInspectionInput({
      spsOptions: { widthInMacroblocks: 81, heightInMacroblocks: 64 }
    });
    expectProfileError(() => inspectAvcAnnexBRendition(macroblockRate));

    const perSecond = validInspectionInput({
      spsOptions: {
        widthInMacroblocks: 80,
        heightInMacroblocks: 64,
        timeScale: 120
      }
    });
    perSecond.profile.frameRate.numerator = 60;
    expectProfileError(() => inspectAvcAnnexBRendition(perSecond));

    const dpb = validInspectionInput({
      spsOptions: { maxDecFrameBuffering: 5 }
    });
    expectProfileError(() => inspectAvcAnnexBRendition(dpb));

    const timing = validInspectionInput({ spsOptions: { timeScale: 50 } });
    expectProfileError(() => inspectAvcAnnexBRendition(timing));

    const color = validInspectionInput({
      spsOptions: { bt709Limited: false },
      requireBt709LimitedRange: true
    });
    expectProfileError(() => inspectAvcAnnexBRendition(color));
  });

  it("requires the exact CPB rule and BT.709 profile declaration", () => {
    const cpb = validInspectionInput();
    cpb.profile.cpbBufferBits -= 1;
    expectProfileError(() => inspectAvcAnnexBRendition(cpb));

    const color = validInspectionInput();
    (color.profile as { requireBt709LimitedRange?: boolean })
      .requireBt709LimitedRange = false;
    expectProfileError(() => inspectAvcAnnexBRendition(color));
  });

  it("rejects declared and signalled rate/buffer excesses", () => {
    const declared = validInspectionInput();
    declared.profile.peakBitrate = 8_000_001;
    expectProfileError(() => inspectAvcAnnexBRendition(declared));

    const hrdBitrate = validInspectionInput({
      spsOptions: {
        hrd: { bitRateValueMinus1: 125_000, cpbSizeValueMinus1: 1 }
      }
    });
    expectProfileError(() => inspectAvcAnnexBRendition(hrdBitrate));

    const hrdCpb = validInspectionInput({
      spsOptions: {
        hrd: { bitRateValueMinus1: 1, cpbSizeValueMinus1: 500_000 }
      }
    });
    expectProfileError(() => inspectAvcAnnexBRendition(hrdCpb));

    const aboveDeclaredBitrate = validInspectionInput({
      spsOptions: {
        hrd: { bitRateValueMinus1: 20_000, cpbSizeValueMinus1: 1 }
      }
    });
    aboveDeclaredBitrate.profile.peakBitrate = 1_000_000;
    expectProfileError(() => inspectAvcAnnexBRendition(aboveDeclaredBitrate));

    const aboveConfiguredCpb = validInspectionInput({
      spsOptions: {
        hrd: { bitRateValueMinus1: 1, cpbSizeValueMinus1: 150_000 }
      }
    });
    expectProfileError(() => inspectAvcAnnexBRendition(aboveConfiguredCpb));
  });

  it.each([
    ["CABAC", { entropyCoding: true }],
    ["FMO", { sliceGroupsMinus1: 1 }],
    ["multiple default refs", { refList0Minus1: 1 }],
    ["weighted prediction", { weightedPrediction: true }],
    ["bottom-field picture order", { bottomFieldPicOrder: true }],
    ["non-frozen initial QP", { picInitQpMinus26: 1 }],
    ["non-frozen initial QS", { picInitQsMinus26: -1 }],
    ["non-frozen chroma QP", { chromaQpIndexOffset: 0 }],
    ["missing deblocking control", { deblockingFilterControl: false }],
    ["constrained intra prediction", { constrainedIntraPrediction: true }],
    ["redundant pictures", { redundantPictures: true }],
    ["PPS extension", { extensionBit: true }]
  ])("rejects PPS violation: %s", (_label, ppsOptions) => {
    const sps = makeSps({ compatibility: 0xe0 });
    const input = validInspectionInput({
      units: [
        {
          id: "idle",
          accessUnits: [
            makeAccessUnit({
              idr: true,
              frameNum: 0,
              sps,
              pps: makePps(ppsOptions)
            })
          ]
        }
      ]
    });
    expectProfileError(() => inspectAvcAnnexBRendition(input));
  });

  it("rejects B pictures, list reordering, adaptive marking, and long-term IDR", () => {
    for (const slice of [
      makeSlice({ idr: false, frameNum: 1, sliceType: "B" }),
      makeSlice({
        idr: false,
        frameNum: 1,
        sliceType: "P",
        referenceListModification: true
      }),
      makeSlice({
        idr: false,
        frameNum: 1,
        sliceType: "P",
        adaptiveMarking: true
      })
    ]) {
      const input = validInspectionInput();
      input.units[0]!.accessUnits[1] = makeAccessUnit({
        idr: false,
        frameNum: 1,
        slices: [slice]
      });
      expectProfileError(() => inspectAvcAnnexBRendition(input));
    }

    const input = validInspectionInput();
    const sps = makeSps({ compatibility: 0xe0 });
    const pps = makePps();
    input.units[0]!.accessUnits[0] = makeAccessUnit({
      idr: true,
      frameNum: 0,
      sps,
      pps,
      slices: [
        makeSlice({
          idr: true,
          frameNum: 0,
          sliceType: "I",
          longTermReference: true
        })
      ]
    });
    expectProfileError(() => inspectAvcAnnexBRendition(input));
  });

  it("rejects false key flags and non-independent unit starts", () => {
    const falseNonKey = validInspectionInput();
    falseNonKey.units[0]!.accessUnits[0]!.key = false;
    expectProfileError(() => inspectAvcAnnexBRendition(falseNonKey));

    const falseKey = validInspectionInput();
    falseKey.units[0]!.accessUnits[1]!.key = true;
    expectProfileError(() => inspectAvcAnnexBRendition(falseKey));

    const nonIdrStart = validInspectionInput();
    nonIdrStart.units[1]!.accessUnits[0] = makeAccessUnit({
      idr: false,
      frameNum: 1
    });
    expectProfileError(() => inspectAvcAnnexBRendition(nonIdrStart));
  });

  it("rejects missing or unstable parameter sets", () => {
    const missing = validInspectionInput();
    missing.units[0]!.accessUnits[0] = makeAccessUnit({ idr: true, frameNum: 0 });
    expectProfileError(() => inspectAvcAnnexBRendition(missing));

    const changed = validInspectionInput();
    changed.units[1]!.accessUnits[0] = makeAccessUnit({
      idr: true,
      frameNum: 0,
      sps: makeSps({ compatibility: 0xe0, spsId: 1 }),
      pps: makePps({ spsId: 1 })
    });
    expectProfileError(() => inspectAvcAnnexBRendition(changed));
  });

  it("rejects multiple pictures and invalid slice partitions in one access unit", () => {
    const sps = makeSps({ compatibility: 0xe0 });
    const pps = makePps();
    const multiplePictures = validInspectionInput({
      units: [
        {
          id: "idle",
          accessUnits: [
            makeAccessUnit({
              idr: true,
              frameNum: 0,
              sps,
              pps,
              slices: [
                makeSlice({ idr: true, frameNum: 0, sliceType: "I" }),
                makeSlice({ idr: true, frameNum: 1, sliceType: "I" })
              ]
            })
          ]
        }
      ]
    });
    expectProfileError(() => inspectAvcAnnexBRendition(multiplePictures));

    const badPartition = validInspectionInput({
      units: [
        {
          id: "idle",
          accessUnits: [
            makeAccessUnit({
              idr: true,
              frameNum: 0,
              sps,
              pps,
              slices: [
                makeSlice({
                  idr: true,
                  frameNum: 0,
                  sliceType: "I",
                  firstMacroblock: 1
                })
              ]
            })
          ]
        }
      ]
    });
    expectProfileError(() => inspectAvcAnnexBRendition(badPartition));
  });

  it("rejects frame_num gaps and POC reordering", () => {
    const gap = validInspectionInput();
    gap.units[0]!.accessUnits[1] = makeAccessUnit({ idr: false, frameNum: 2 });
    expectProfileError(() => inspectAvcAnnexBRendition(gap));

    const sps = makeSps({ compatibility: 0xe0, picOrderCountType: 0 });
    const pps = makePps();
    const reordered = validInspectionInput({
      spsOptions: { picOrderCountType: 0 },
      units: [
        {
          id: "idle",
          accessUnits: [
            makeAccessUnit({
              idr: true,
              frameNum: 0,
              sps,
              pps,
              picOrderCountType: 0,
              picOrderCntLsb: 0
            }),
            makeAccessUnit({
              idr: false,
              frameNum: 1,
              picOrderCountType: 0,
              picOrderCntLsb: 4
            }),
            makeAccessUnit({
              idr: false,
              frameNum: 2,
              picOrderCountType: 0,
              picOrderCntLsb: 2
            })
          ]
        }
      ]
    });
    expectProfileError(() => inspectAvcAnnexBRendition(reordered));
  });

  it("rejects forbidden NAL types, headers, order, and AUD claims", () => {
    const sps = makeSps({ compatibility: 0xe0 });
    const pps = makePps();
    const idr = makeSlice({ idr: true, frameNum: 0, sliceType: "I" });
    for (const bytes of [
      concat(nal(0x06, Uint8Array.of(0x80), 3), sps, pps, idr),
      concat(nal(0xe7, Uint8Array.of(0x80), 3), pps, idr),
      concat(nal(0x07, Uint8Array.of(0x80), 3), pps, idr),
      concat(sps, makeAud(0), pps, idr),
      concat(makeAud(2), sps, pps, idr)
    ]) {
      const input = validInspectionInput();
      input.units[0]!.accessUnits[0] = { bytes, key: true };
      expectProfileError(() => inspectAvcAnnexBRendition(input));
    }
  });

  it("rejects hostile start codes and EBSP escaping", () => {
    const hostile = [
      Uint8Array.of(1, 2, 3, 4, 5),
      Uint8Array.of(9, 0, 0, 1, 0x65, 0x80),
      Uint8Array.of(0, 0, 0, 0, 1, 0x65, 0x80),
      Uint8Array.of(0, 0, 1, 0x65, 0, 0, 1, 0x61, 0x80),
      Uint8Array.of(0, 0, 1, 0x65, 0x80, 0),
      Uint8Array.of(0, 0, 1, 0x65, 0, 0, 3, 4, 0x80),
      Uint8Array.of(0, 0, 1, 0x65, 0, 0, 2, 0x80)
    ];
    for (const bytes of hostile) {
      const input = validInspectionInput();
      input.units[0]!.accessUnits[0] = { bytes, key: true };
      expectProfileError(() => inspectAvcAnnexBRendition(input));
    }
  });

  it("rejects truncated Exp-Golomb and bad parameter-set trailing bits", () => {
    const pps = makePps();
    const idr = makeSlice({ idr: true, frameNum: 0, sliceType: "I" });
    for (const badSps of [
      nal(0x67, Uint8Array.of(66, 0xc0, 32, 0), 4),
      nal(0x67, Uint8Array.of(66, 0xc0, 32, 0x80, 0x7f), 4)
    ]) {
      const input = validInspectionInput();
      input.units[0]!.accessUnits[0] = {
        bytes: concat(badSps, pps, idr),
        key: true
      };
      expectProfileError(() => inspectAvcAnnexBRendition(input));
    }
  });
});

function expectProfileError(callback: () => unknown): void {
  expect(callback).toThrowError(FormatError);
  try {
    callback();
  } catch (error) {
    expect(error).toMatchObject({ code: "PROFILE_INVALID" });
  }
}
