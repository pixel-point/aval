import { describe, expect, it } from "vitest";

import {
  AvcIncrementalInspector,
  type AvcConstrainedBaselineProfile,
  type AvcIncrementalAccessUnitInput
} from "../src/avc/index.js";
import { FormatError } from "../src/errors.js";
import {
  makeAccessUnit,
  makeAud,
  makePps,
  makeSlice,
  makeSps
} from "./avc-fixture.js";

describe("incremental strict AVC inspector", () => {
  it("preserves scalar syntax state across calls without retaining input bytes", () => {
    const inspector = new AvcIncrementalInspector(strictProfile());
    const stableSps = strictSps();
    const first = sample({
      unitInstance: 0,
      unitFrame: 0,
      unitFrameCount: 2,
      bytes: keyBytes(stableSps)
    });

    const key = inspector.inspect(first);
    first.bytes.fill(0);
    const delta = inspector.inspect(
      sample({
        unitInstance: 0,
        unitFrame: 1,
        unitFrameCount: 2,
        bytes: deltaBytes(1),
        key: false
      })
    );
    // A fresh identical SPS must still match after the original caller buffer
    // was destroyed; retaining the original view would make this fail.
    expect(() =>
      inspector.inspect(
        sample({
          unitInstance: 1,
          unitFrame: 0,
          unitFrameCount: 1,
          bytes: keyBytes(stableSps)
        })
      )
    ).not.toThrow();

    expect(key).toMatchObject({
      unitId: "idle",
      unitInstance: 0,
      unitFrame: 0,
      unitComplete: false,
      chunkType: "key",
      accessUnit: { idr: true, sliceType: "I", sliceCount: 1 }
    });
    expect(delta).toMatchObject({
      unitFrame: 1,
      unitComplete: true,
      chunkType: "delta",
      accessUnit: { idr: false, sliceType: "P" }
    });
    expect(inspector.macroblocksPerFrame).toBe(16);
    expect(inspector.parameterSet).toMatchObject({
      constraintSet2: true,
      fixedFrameRate: true,
      squareSampleAspect: true,
      hrdPresent: false
    });
    expect(Object.isFrozen(key)).toBe(true);
    expect(Object.isFrozen(key.accessUnit)).toBe(true);
    expect(Object.isFrozen(inspector.parameterSet)).toBe(true);
  });

  it("accepts contiguous units across arbitrary call/batch boundaries", () => {
    const inspector = new AvcIncrementalInspector(strictProfile());
    inspector.inspect(
      sample({
        unitId: "idle",
        unitInstance: 4,
        unitFrame: 0,
        unitFrameCount: 2,
        bytes: keyBytes(strictSps())
      })
    );
    inspector.inspect(
      sample({
        unitId: "idle",
        unitInstance: 4,
        unitFrame: 1,
        unitFrameCount: 2,
        bytes: deltaBytes(1),
        key: false
      })
    );

    const repeated = inspector.inspect(
      sample({
        unitId: "idle",
        unitInstance: 5,
        unitFrame: 0,
        unitFrameCount: 1,
        bytes: keyBytes(strictSps())
      })
    );
    expect(repeated.unitComplete).toBe(true);
  });

  it("rejects gaps and inconsistent unit occurrence metadata transactionally", () => {
    const inspector = new AvcIncrementalInspector(strictProfile());
    inspector.inspect(
      sample({
        unitInstance: 0,
        unitFrame: 0,
        unitFrameCount: 3,
        bytes: keyBytes(strictSps())
      })
    );

    expectProfileError(() =>
      inspector.inspect(
        sample({
          unitInstance: 0,
          unitFrame: 2,
          unitFrameCount: 3,
          bytes: deltaBytes(2),
          key: false
        })
      )
    );
    expectProfileError(() =>
      inspector.inspect(
        sample({
          unitId: "hover",
          unitInstance: 0,
          unitFrame: 1,
          unitFrameCount: 3,
          bytes: deltaBytes(1),
          key: false
        })
      )
    );

    expect(() =>
      inspector.inspect(
        sample({
          unitInstance: 0,
          unitFrame: 1,
          unitFrameCount: 3,
          bytes: deltaBytes(1),
          key: false
        })
      )
    ).not.toThrow();
  });

  it("requires monotonically new unit instances and independent frame-zero starts", () => {
    const inspector = new AvcIncrementalInspector(strictProfile());
    inspector.inspect(
      sample({
        unitInstance: 2,
        unitFrame: 0,
        unitFrameCount: 1,
        bytes: keyBytes(strictSps())
      })
    );
    expectProfileError(() =>
      inspector.inspect(
        sample({
          unitInstance: 2,
          unitFrame: 0,
          unitFrameCount: 1,
          bytes: keyBytes(strictSps())
        })
      )
    );
    expectProfileError(() =>
      inspector.inspect(
        sample({
          unitInstance: 3,
          unitFrame: 1,
          unitFrameCount: 2,
          bytes: deltaBytes(1),
          key: false
        })
      )
    );
  });

  it("resets generation sequencing but preserves rendition parameter identity", () => {
    const inspector = new AvcIncrementalInspector(strictProfile());
    inspector.inspect(
      sample({
        unitInstance: 8,
        unitFrame: 0,
        unitFrameCount: 1,
        bytes: keyBytes(strictSps())
      })
    );
    inspector.resetUnitSequence();
    expect(() =>
      inspector.inspect(
        sample({
          unitInstance: 0,
          unitFrame: 0,
          unitFrameCount: 1,
          bytes: keyBytes(strictSps())
        })
      )
    ).not.toThrow();

    inspector.resetUnitSequence();
    expectProfileError(() =>
      inspector.inspect(
        sample({
          unitInstance: 0,
          unitFrame: 0,
          unitFrameCount: 1,
          bytes: keyBytes(makeSps({ ...STRICT_SPS, spsId: 1 }), makePps({ spsId: 1 }))
        })
      )
    );
  });

  it("copies the profile instead of retaining a caller-owned object", () => {
    const profile = strictProfile() as MutableProfile;
    const inspector = new AvcIncrementalInspector(profile);
    profile.codedWidth = 80;
    profile.frameRate.numerator = 60;

    expect(() =>
      inspector.inspect(
        sample({
          unitInstance: 0,
          unitFrame: 0,
          unitFrameCount: 1,
          bytes: keyBytes(strictSps())
        })
      )
    ).not.toThrow();
  });

  it("rejects noncanonical strict-worker SPS profiles", () => {
    const badSps = [
      makeSps({ ...STRICT_SPS, compatibility: 0xc0 }),
      makeSps({ ...STRICT_SPS, crop: [0, 1, 0, 0] }),
      makeSps({ ...STRICT_SPS, fixedFrameRate: false }),
      makeSps({
        ...STRICT_SPS,
        sampleAspectRatio: [4, 3]
      }),
      makeSps({
        ...STRICT_SPS,
        hrd: { bitRateValueMinus1: 10_000, cpbSizeValueMinus1: 10_000 }
      })
    ];
    for (const sps of badSps) {
      const inspector = new AvcIncrementalInspector(strictProfile());
      expectProfileError(() =>
        inspector.inspect(
          sample({
            unitInstance: 0,
            unitFrame: 0,
            unitFrameCount: 1,
            bytes: keyBytes(sps)
          })
        )
      );
    }
  });

  it("requires exact AUD/SPS/PPS/IDR then AUD/non-IDR grammar with one slice", () => {
    const malformedFirstFrames = [
      makeAccessUnit({
        idr: true,
        frameNum: 0,
        sps: strictSps(),
        pps: makePps()
      }).bytes,
      makeAccessUnit({
        idr: true,
        frameNum: 0,
        aud: makeAud(0),
        sps: strictSps(),
        pps: makePps(),
        slices: [
          makeSlice({ idr: true, frameNum: 0, sliceType: "I" }),
          makeSlice({
            idr: true,
            frameNum: 0,
            sliceType: "I",
            firstMacroblock: 8
          })
        ]
      }).bytes
    ];
    for (const bytes of malformedFirstFrames) {
      const inspector = new AvcIncrementalInspector(strictProfile());
      expectProfileError(() =>
        inspector.inspect(
          sample({
            unitInstance: 0,
            unitFrame: 0,
            unitFrameCount: 1,
            bytes
          })
        )
      );
    }

    for (const later of [
      {
        idr: true,
        slice: makeSlice({ idr: true, frameNum: 0, sliceType: "I" })
      },
      {
        idr: false,
        slice: makeSlice({ idr: false, frameNum: 1, sliceType: "I" })
      }
    ]) {
      const inspector = new AvcIncrementalInspector(strictProfile());
      inspector.inspect(
        sample({
          unitInstance: 0,
          unitFrame: 0,
          unitFrameCount: 2,
          bytes: keyBytes(strictSps())
        })
      );
      expectProfileError(() =>
        inspector.inspect(
          sample({
            unitInstance: 0,
            unitFrame: 1,
            unitFrameCount: 2,
            bytes: makeAccessUnit({
              idr: later.idr,
              frameNum: later.idr ? 0 : 1,
              aud: makeAud(later.idr ? 0 : 1),
              ...(later.idr ? { sps: strictSps(), pps: makePps() } : {}),
              slices: [later.slice]
            }).bytes,
            key: later.idr
          })
        )
      );
    }
  });

  it("rejects a worker CPB profile that differs from peak bitrate", () => {
    const profile = strictProfile() as MutableProfile;
    profile.cpbBufferBits = profile.peakBitrate - 1;
    expectProfileError(() => new AvcIncrementalInspector(profile));
  });
});

const STRICT_SPS = Object.freeze({
  compatibility: 0xe0,
  bt709Limited: true
} as const);

function strictSps(): Uint8Array {
  return makeSps(STRICT_SPS);
}

function strictProfile(): AvcConstrainedBaselineProfile {
  return {
    codedWidth: 64,
    codedHeight: 64,
    frameRate: { numerator: 30, denominator: 1 },
    averageBitrate: 1_000_000,
    peakBitrate: 2_000_000,
    cpbBufferBits: 2_000_000,
    requireBt709LimitedRange: true
  };
}

function keyBytes(sps: Uint8Array, pps = makePps()): Uint8Array {
  return makeAccessUnit({
    idr: true,
    frameNum: 0,
    aud: makeAud(0),
    sps,
    pps
  }).bytes;
}

function deltaBytes(frameNum: number): Uint8Array {
  return makeAccessUnit({
    idr: false,
    frameNum,
    aud: makeAud(1)
  }).bytes;
}

function sample(
  overrides: Partial<AvcIncrementalAccessUnitInput> &
    Pick<
      AvcIncrementalAccessUnitInput,
      "unitInstance" | "unitFrame" | "unitFrameCount" | "bytes"
    >
): AvcIncrementalAccessUnitInput {
  return {
    unitId: "idle",
    key: overrides.unitFrame === 0,
    ...overrides
  };
}

interface MutableProfile {
  codedWidth: number;
  codedHeight: number;
  frameRate: { numerator: number; denominator: number };
  averageBitrate: number;
  peakBitrate: number;
  cpbBufferBits: number;
  requireBt709LimitedRange: true;
}

function expectProfileError(callback: () => unknown): void {
  expect(callback).toThrowError(FormatError);
  try {
    callback();
  } catch (error) {
    expect(error).toMatchObject({ code: "PROFILE_INVALID" });
  }
}
