import { describe, expect, it } from "vitest";

import {
  createVideoPayloadValidator,
  FormatError,
  type VideoPayloadValidationChunk,
  type VideoPayloadValidationProfile
} from "../src/index.js";
import {
  makeAccessUnit,
  makeAud,
  makePps,
  makeSps,
  validInspectionInput
} from "./h264-fixture.js";
import {
  loadVideoPayloadFixture,
  replaceFirstVideoChunk as replaceFirst,
  type VideoPayloadFixture
} from "./video-payload-validator-fixture.js";

describe("incremental video payload validator", () => {
  it("rejects invalid profiles with stable typed details", () => {
    expect(() => createVideoPayloadValidator({
      codec: "avc1.42E01E",
      bitDepth: 8,
      codedWidth: 0,
      codedHeight: 32,
      visibleWidth: 64,
      visibleHeight: 32,
      frameRate: { numerator: 30, denominator: 1 },
      averageBitrate: 100_000
    })).toThrowError(expect.objectContaining({
      name: "FormatError",
      code: "PROFILE_INVALID",
      path: "profile.codedWidth"
    }));
  });

  it("requires at least one unit and rejects validation after completion", () => {
    const fixture = loadVideoPayloadFixture("h264");
    const empty = createVideoPayloadValidator(fixture.profile);
    expect(() => empty.complete()).toThrowError(expect.objectContaining({
      name: "FormatError",
      code: "PROFILE_INVALID",
      path: "validator"
    }));

    const validator = createVideoPayloadValidator(fixture.profile);
    for (const unit of fixture.units) validator.validate(unit);
    validator.complete();
    validator.complete();
    expect(() => validator.validate(fixture.units[0]!)).toThrow(FormatError);
  });

  it("does not advance continuity state after a rejected unit", () => {
    const fixture = loadVideoPayloadFixture("h264");
    const validator = createVideoPayloadValidator(fixture.profile);
    const first = fixture.units[0]!;
    const truncated = replaceFirstBytes(first, first[0]!.bytes.subarray(0, 4));

    expect(() => validator.validate(truncated)).toThrow(FormatError);
    for (const unit of fixture.units) validator.validate(unit);
    validator.complete();
  });

  it.each(["h264", "h265", "vp9", "av1"] as const)(
    "accepts every unit of the %s certification asset",
    (family) => {
      const fixture = loadVideoPayloadFixture(family);
      const validator = createVideoPayloadValidator(fixture.profile);
      for (const unit of fixture.units) validator.validate(unit);
      validator.complete();
      validator.complete();
    }
  );

  it.each(["h264", "h265", "vp9", "av1"] as const)(
    "rejects truncated %s payloads",
    (family) => {
      const fixture = loadVideoPayloadFixture(family);
      const first = fixture.units[0]!;
      const truncated = replaceFirstBytes(first, first[0]!.bytes.subarray(0, 4));
      expect(() => createVideoPayloadValidator(fixture.profile).validate(truncated))
        .toThrow(FormatError);
    }
  );

  it.each(["h264", "h265", "vp9", "av1"] as const)(
    "rejects false %s key and displayed-frame assertions",
    (family) => {
      const fixture = loadVideoPayloadFixture(family);
      const first = fixture.units[0]!;
      expect(() => createVideoPayloadValidator(fixture.profile).validate(
        replaceFirst(first, { key: !first[0]!.key })
      )).toThrow(FormatError);
      expect(() => createVideoPayloadValidator(fixture.profile).validate(
        replaceFirst(first, { displayedFrames: first[0]!.displayedFrames + 1 })
      )).toThrow(FormatError);
    }
  );

  it.each(["h264", "h265", "av1"] as const)(
    "rejects a %s header that changes between independently decodable units",
    (family) => {
      const fixture = loadVideoPayloadFixture(family);
      const changed = family === "h264"
        ? makeH264ContinuityOnlyUnit(fixture.profile)
        : findContinuityOnlyMutation(fixture);
      createVideoPayloadValidator(fixture.profile).validate(changed);
      const validator = createVideoPayloadValidator(fixture.profile);
      validator.validate(fixture.units[0]!);
      expect(() => validator.validate(changed)).toThrow(FormatError);
    }
  );

  it.each([
    ["High-profile H264", "h264", "avc1.640020", 8],
    ["short VP9", "vp9", "vp09.00.10.08", 8],
    ["short AV1", "av1", "av01.0.08M.10", 10]
  ] as const)("rejects the retired %s codec declaration", (
    _name,
    family,
    codec,
    bitDepth
  ) => {
    const fixture = loadVideoPayloadFixture(family);
    expect(() => createVideoPayloadValidator({
      ...fixture.profile,
      codec,
      bitDepth
    })).toThrow(FormatError);
  });

  it("rejects a High-profile H264 payload under a canonical declaration", () => {
    const input = validInspectionInput({
      spsOptions: { profileIdc: 100 },
      ppsOptions: { profileIdc: 100 }
    });
    const validator = createVideoPayloadValidator({
      codec: "avc1.42E020",
      bitDepth: 8,
      codedWidth: input.profile.codedWidth,
      codedHeight: input.profile.codedHeight,
      visibleWidth: input.profile.expectedVisibleRect[2],
      visibleHeight: input.profile.expectedVisibleRect[3],
      frameRate: input.profile.frameRate,
      averageBitrate: 100_000
    });
    const chunks = input.units[0]!.accessUnits.map((accessUnit, index) => ({
      bytes: accessUnit.bytes,
      timestamp: index * 33_333,
      key: accessUnit.key,
      displayedFrames: 1
    }));

    expect(() => validator.validate(chunks))
      .toThrow(FormatError);
  });

  it("requires the exact rendition-global VP9 level and full codec string on completion", () => {
    const fixture = loadVideoPayloadFixture("vp9");
    const validator = createVideoPayloadValidator({
      ...fixture.profile,
      codec: "vp09.00.11.08.01.01.01.01.00"
    });
    for (const unit of fixture.units) validator.validate(unit);
    expect(() => validator.complete()).toThrow(FormatError);
  });

  it("requires the exact full AV1 codec derived from the sequence header", () => {
    const fixture = loadVideoPayloadFixture("av1");
    const terms = fixture.profile.codec.split(".");
    terms[2] = terms[2] === "00M" ? "01M" : "00M";
    const codec = terms.join(".");
    const validator = createVideoPayloadValidator({ ...fixture.profile, codec });
    expect(() => validator.validate(fixture.units[0]!))
      .toThrow(FormatError);
  });

  it("rejects an HEVC access unit above the canonical 64 MiB syntax budget", () => {
    const fixture = loadVideoPayloadFixture("h265");
    const oversized = fixture.units[0]![0]!.bytes.slice(0, 1);
    Object.defineProperty(oversized, "byteLength", { value: 64 * 1024 * 1024 + 1 });
    expect(() => createVideoPayloadValidator(fixture.profile).validate(
      replaceFirstBytes(fixture.units[0]!, oversized)
    )).toThrow(FormatError);
  });

  it.each(["h264", "h265"] as const)(
    "rejects %s timestamps that contradict bitstream presentation order",
    (family) => {
      const fixture = loadVideoPayloadFixture(family);
      const first = fixture.units[0]!;
      expect(first.length).toBeGreaterThan(1);
      const timestamps = first.map(({ timestamp }) => timestamp);
      const changed = first.map((chunk, index) => Object.freeze({
        ...chunk,
        timestamp: index === 0
          ? timestamps[1]!
          : index === 1
            ? timestamps[0]!
            : chunk.timestamp
      }));
      expect(() => createVideoPayloadValidator(fixture.profile).validate(changed))
        .toThrow(FormatError);
    }
  );
});

function replaceFirstBytes(
  unit: readonly VideoPayloadValidationChunk[],
  bytes: Uint8Array
): readonly VideoPayloadValidationChunk[] {
  return replaceFirst(unit, { bytes });
}

function makeH264ContinuityOnlyUnit(
  profile: Readonly<VideoPayloadValidationProfile>
): readonly VideoPayloadValidationChunk[] {
  expect(profile.codec).toBe("avc1.42E00B");
  const sps = makeSps({
    profileIdc: 66,
    compatibility: 0xe0,
    levelIdc: 11,
    widthInMacroblocks: 3,
    heightInMacroblocks: 7,
    crop: [0, 0, 0, 4],
    maxNumRefFrames: 1,
    maxNumReorderFrames: 0,
    maxDecFrameBuffering: 1,
    pixelAspectRatio: [1, 1]
  });
  const pps = makePps({ profileIdc: 66 });
  const accessUnits = [
    makeAccessUnit({
      idr: true,
      frameNum: 0,
      sps,
      pps,
      aud: makeAud(0),
      entropyCoding: false,
      picOrderCountType: 0,
      picOrderCntLsb: 0
    }),
    makeAccessUnit({
      idr: false,
      frameNum: 1,
      aud: makeAud(1),
      entropyCoding: false,
      picOrderCountType: 0,
      picOrderCntLsb: 2
    })
  ];
  return Object.freeze(accessUnits.map((accessUnit, index) => Object.freeze({
    bytes: accessUnit.bytes,
    timestamp: index * 33_333,
    key: accessUnit.key,
    displayedFrames: 1
  })));
}

/** Find a one-bit header change that remains valid in isolation but not after unit zero. */
function findContinuityOnlyMutation(
  fixture: Readonly<VideoPayloadFixture>
): readonly VideoPayloadValidationChunk[] {
  const later = fixture.units[1]!;
  const original = later[0]!.bytes;
  const searchBytes = Math.min(original.byteLength, 2_048);
  for (let offset = 0; offset < searchBytes; offset += 1) {
    for (let bit = 1; bit <= 0x80; bit <<= 1) {
      const bytes = original.slice();
      bytes[offset] = bytes[offset]! ^ bit;
      const changed = replaceFirstBytes(later, bytes);
      try {
        createVideoPayloadValidator(fixture.profile).validate(changed);
      } catch {
        continue;
      }
      const sequential = createVideoPayloadValidator(fixture.profile);
      sequential.validate(fixture.units[0]!);
      try {
        sequential.validate(changed);
      } catch {
        return changed;
      }
    }
  }
  throw new Error("No continuity-only codec-header mutation was found");
}
