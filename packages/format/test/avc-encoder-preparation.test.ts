import { describe, expect, it } from "vitest";

import {
  inspectAvcAnnexBRendition,
  prepareAvcEncoderRendition,
  type AvcConstrainedBaselineProfile
} from "../src/avc/index.js";
import {
  AVC_NAL_TYPE_SEI,
  splitAnnexBAccessUnit
} from "../src/avc/annex-b.js";
import { FormatError } from "../src/errors.js";
import {
  concat,
  makeAccessUnit,
  makeAud,
  makePps,
  makeSps,
  nal
} from "./avc-fixture.js";

describe("AVC encoder rendition preparation", () => {
  it("removes SEI, normalizes four-byte prefixes, rewrites C0, and strict-reinspects", () => {
    const first = rawUnitStream(0xc0);
    const second = rawUnitStream(0xc0);
    const input = {
      profile: profile(),
      units: [
        { id: "idle", bytes: first, expectedAccessUnitCount: 2 },
        { id: "hover", bytes: second, expectedAccessUnitCount: 2 }
      ]
    };

    const prepared = prepareAvcEncoderRendition(input);
    first.fill(0);
    second.fill(0);

    expect(prepared.inspection.parameterSet.constraintSet2).toBe(true);
    expect(prepared.canonicalizations).toEqual([
      { unitId: "idle", constraintSet2Canonicalized: true },
      { unitId: "hover", constraintSet2Canonicalized: true }
    ]);
    expect(prepared.units.map((unit) => unit.id)).toEqual(["idle", "hover"]);
    expect(prepared.units[0]?.accessUnits.map((unit) => unit.key)).toEqual([
      true,
      false
    ]);
    for (const unit of prepared.units) {
      for (const [frameIndex, accessUnit] of unit.accessUnits.entries()) {
        const nals = splitAnnexBAccessUnit(accessUnit.bytes, "prepared");
        expect(nals.every((entry) => entry.prefixLength === 4)).toBe(true);
        expect(nals.some((entry) => entry.type === AVC_NAL_TYPE_SEI)).toBe(false);
        expect(nals.map((entry) => entry.type)).toEqual(
          frameIndex === 0 ? [9, 7, 8, 5] : [9, 1]
        );
      }
    }
    expect(() =>
      inspectAvcAnnexBRendition({
        profile: profile(),
        units: prepared.units
      })
    ).not.toThrow();
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.units)).toBe(true);
    expect(Object.isFrozen(prepared.units[0]?.accessUnits)).toBe(true);
  });

  it("is byte-stable for an already-E0 candidate apart from canonical framing/SEI", () => {
    const prepared = prepareAvcEncoderRendition({
      profile: profile(),
      units: [
        {
          id: "idle",
          bytes: rawUnitStream(0xe0),
          expectedAccessUnitCount: 2
        }
      ]
    });
    expect(prepared.inspection.parameterSet.constraintSet2).toBe(true);
    expect(prepared.canonicalizations).toEqual([
      { unitId: "idle", constraintSet2Canonicalized: false }
    ]);
  });

  it("rejects every encoder-only NAL type except zero-reference SEI", () => {
    for (const encoderOnlyNal of [
      nal(0x0c, Uint8Array.of(0x80)),
      nal(0x26, Uint8Array.of(0x80))
    ]) {
      const raw = concat(
        makeAud(0),
        makeSps({ compatibility: 0xc0, bt709Limited: true }),
        makePps(),
        encoderOnlyNal,
        makeAccessUnit({ idr: true, frameNum: 0 }).bytes
      );
      expectProfileError(() =>
        prepareAvcEncoderRendition({
          profile: profile(),
          units: [{ id: "idle", bytes: raw, expectedAccessUnitCount: 1 }]
        })
      );
    }
  });

  it("rejects missing/empty AUD groups and expected-count mismatches", () => {
    const noAud = concat(
      makeSps({ compatibility: 0xc0, bt709Limited: true }),
      makePps(),
      makeAccessUnit({ idr: true, frameNum: 0 }).bytes
    );
    const emptyGroup = concat(
      makeAud(0),
      nal(0x06, Uint8Array.of(0x80)),
      makeAud(0),
      makeSps({ compatibility: 0xc0, bt709Limited: true }),
      makePps(),
      makeAccessUnit({ idr: true, frameNum: 0 }).bytes
    );
    for (const [bytes, count] of [
      [noAud, 1],
      [emptyGroup, 2],
      [rawUnitStream(0xc0), 3]
    ] as const) {
      expectProfileError(() =>
        prepareAvcEncoderRendition({
          profile: profile(),
          units: [
            { id: "idle", bytes, expectedAccessUnitCount: count }
          ]
        })
      );
    }
  });

  it("candidate-inspects before rewriting and therefore rejects other profile faults", () => {
    const raw = rawUnitStream(0xc0, { fixedFrameRate: false });
    expectProfileError(() =>
      prepareAvcEncoderRendition({
        profile: profile(),
        units: [{ id: "idle", bytes: raw, expectedAccessUnitCount: 2 }]
      })
    );
  });
});

function rawUnitStream(
  compatibility: 0xc0 | 0xe0,
  options: { readonly fixedFrameRate?: boolean } = {}
): Uint8Array {
  const sei = nal(0x06, Uint8Array.of(0x05, 0x01, 0x80), 3);
  return concat(
    makeAccessUnit({
      idr: true,
      frameNum: 0,
      aud: makeAud(0),
      sps: makeSps({
        compatibility,
        bt709Limited: true,
        ...(options.fixedFrameRate === undefined
          ? {}
          : { fixedFrameRate: options.fixedFrameRate })
      }),
      pps: makePps(),
      // In normal FFmpeg output SEI follows PPS and precedes the IDR.
      slices: [sei, makeAccessUnit({ idr: true, frameNum: 0 }).bytes]
    }).bytes,
    makeAccessUnit({
      idr: false,
      frameNum: 1,
      aud: makeAud(1),
      slices: [sei, makeAccessUnit({ idr: false, frameNum: 1 }).bytes]
    }).bytes
  );
}

function profile(): AvcConstrainedBaselineProfile {
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

function expectProfileError(callback: () => unknown): void {
  expect(callback).toThrowError(FormatError);
  try {
    callback();
  } catch (error) {
    expect(error).toMatchObject({ code: "PROFILE_INVALID" });
  }
}
