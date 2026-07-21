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

describe("H264 Constrained Baseline inspection", () => {
  it("returns canonical decoder facts for independently decodable units", () => {
    const inspection = inspectH264AnnexBRendition(validInspectionInput());

    expect(inspection.parameterSet).toMatchObject({
      profile: "constrained-baseline",
      profileIdc: 66,
      codec: "avc1.42E020",
      bitDepth: 8,
      chromaFormat: "4:2:0",
      maxNumRefFrames: 1,
      maxNumReorderFrames: 0,
      maxDecFrameBuffering: 1
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
    ["B-pictures", baselineBPictureInput]
  ] as const)("rejects Constrained Baseline %s", (_name, input) => {
    expectProfileError(() => inspectH264AnnexBRendition(input()));
  });

  it("rejects an AUD that admits B pictures", () => {
    const input = baselineInput();
    input.units[0]!.accessUnits[1] = makeAccessUnit({
      idr: false,
      frameNum: 1,
      picOrderCntLsb: 2,
      aud: makeAud(2),
      entropyCoding: false
    });

    expect(() => inspectH264AnnexBRendition(input)).toThrowError(
      expect.objectContaining<Partial<FormatError>>({
        code: "PROFILE_INVALID",
        message: "AUD primary_pic_type must identify only I or P pictures"
      })
    );
  });

  it("rejects picture-order counts that do not increase with decode order", () => {
    expect(() => inspectH264AnnexBRendition(nonIdentityBaselineInput()))
      .toThrowError(expect.objectContaining<Partial<FormatError>>({
        code: "PROFILE_INVALID",
        message: "picture-order counts must increase with decode order"
      }));
  });

  it("rejects High-profile SPS input at the inspection boundary", () => {
    expectProfileError(() => inspectH264AnnexBRendition(validInspectionInput({
      spsOptions: { profileIdc: 100 },
      ppsOptions: { profileIdc: 100 }
    })));
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
        adaptiveMarkingOperation: 1,
        entropyCoding: false
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
        adaptiveMarkingOperation: 2,
        entropyCoding: false
      })]
    });
    expectProfileError(() => inspectH264AnnexBRendition(rejected));
  });

  it("accepts a one-reference slice override and rejects larger counts", () => {
    const accepted = baselineInput();
    accepted.units[0]!.accessUnits[1] = makeAccessUnit({
      idr: false,
      frameNum: 1,
      aud: makeAud(1),
      slices: [makeSlice({
        idr: false,
        frameNum: 1,
        picOrderCountType: 0,
        picOrderCntLsb: 2,
        numRefIdxL0ActiveMinus1: 0,
        entropyCoding: false
      })]
    });
    expect(() => inspectH264AnnexBRendition(accepted)).not.toThrow();

    const rejected = baselineInput();
    rejected.units[0]!.accessUnits[1] = makeAccessUnit({
      idr: false,
      frameNum: 1,
      aud: makeAud(1),
      slices: [makeSlice({
        idr: false,
        frameNum: 1,
        picOrderCountType: 0,
        picOrderCntLsb: 2,
        numRefIdxL0ActiveMinus1: 1,
        entropyCoding: false
      })]
    });

    expect(() => inspectH264AnnexBRendition(rejected)).toThrowError(
      expect.objectContaining<Partial<FormatError>>({
        code: "PROFILE_INVALID",
        message: "Constrained Baseline slice reference count must equal one"
      })
    );
  });
});

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
