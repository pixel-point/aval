import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseFrontIndex } from "../../format/src/parser.js";
import {
  createCodecValidator,
  type CodecValidationChunk,
  type CodecValidationProfile
} from "../src/codec-validator.js";

type Family = "h264" | "h265" | "vp9" | "av1";

interface Fixture {
  readonly profile: CodecValidationProfile;
  readonly units: readonly (readonly CodecValidationChunk[])[];
}

describe("codec validator", () => {
  it.each(["h264", "h265", "vp9", "av1"] as const)(
    "accepts every unit of the %s conformance asset",
    (family) => {
      const fixture = loadFixture(family);
      const validator = createCodecValidator(fixture.profile);
      for (const unit of fixture.units) validator.validate(unit);
      validator.complete();
      validator.complete();
    }
  );

  it.each(["h264", "h265", "vp9", "av1"] as const)(
    "rejects truncated %s payloads",
    (family) => {
      const fixture = loadFixture(family);
      const first = fixture.units[0]!;
      const truncated = replaceFirstBytes(first, first[0]!.bytes.subarray(0, 4));
      expect(() => createCodecValidator(fixture.profile).validate(truncated))
        .toThrow("Invalid AVAL encoded payload");
    }
  );

  it.each(["h264", "h265", "vp9", "av1"] as const)(
    "rejects false %s key and displayed-frame assertions",
    (family) => {
      const fixture = loadFixture(family);
      const first = fixture.units[0]!;
      expect(() => createCodecValidator(fixture.profile).validate(
        replaceFirst(first, { key: !first[0]!.key })
      )).toThrow("Invalid AVAL encoded payload");
      expect(() => createCodecValidator(fixture.profile).validate(
        replaceFirst(first, { displayedFrames: first[0]!.displayedFrames + 1 })
      )).toThrow("Invalid AVAL encoded payload");
    }
  );

  it.each(["h264", "h265", "av1"] as const)(
    "rejects a %s header that changes between independently decodable units",
    (family) => {
      const fixture = loadFixture(family);
      const changed = findContinuityOnlyMutation(fixture);
      const validator = createCodecValidator(fixture.profile);
      validator.validate(fixture.units[0]!);
      expect(() => validator.validate(changed)).toThrow("Invalid AVAL encoded payload");
    }
  );

  it("requires the exact rendition-global VP9 level and full codec string on completion", () => {
    const fixture = loadFixture("vp9");
    for (const codec of [
      "vp09.00.11.08.01.01.01.01.00",
      "vp09.00.10.08"
    ]) {
      const validator = createCodecValidator({ ...fixture.profile, codec });
      for (const unit of fixture.units) validator.validate(unit);
      expect(() => validator.complete()).toThrow("Invalid AVAL encoded payload");
    }
  });

  it("requires the exact full AV1 codec derived from the sequence header", () => {
    const fixture = loadFixture("av1");
    const codec = fixture.profile.codec.split(".").slice(0, 4).join(".");
    const validator = createCodecValidator({ ...fixture.profile, codec });
    expect(() => validator.validate(fixture.units[0]!))
      .toThrow("Invalid AVAL encoded payload");
  });

  it("rejects an HEVC access unit above the canonical 64 MiB syntax budget", () => {
    const fixture = loadFixture("h265");
    const oversized = fixture.units[0]![0]!.bytes.slice(0, 1);
    Object.defineProperty(oversized, "byteLength", { value: 64 * 1024 * 1024 + 1 });
    expect(() => createCodecValidator(fixture.profile).validate(
      replaceFirstBytes(fixture.units[0]!, oversized)
    )).toThrow("Invalid AVAL encoded payload");
  });
});

function loadFixture(family: Family): Fixture {
  const bytes = Uint8Array.from(readFileSync(new URL(
    `../../../fixtures/conformance/v1/${family}.avl`,
    import.meta.url
  )));
  const front = parseFrontIndex(bytes);
  const rendition = front.manifest.renditions[0]!;
  const color = rendition.alphaLayout.colorRect;
  const visibleWidth = color[2] + color[2] % 2;
  const paneHeight = color[3] + color[3] % 2;
  const visibleHeight = rendition.alphaLayout.type === "stacked"
    ? paneHeight * 2 + 8
    : paneHeight;
  const units = front.manifest.units.map((unit) => {
    const span = unit.chunks[0]!;
    return Object.freeze(Array.from({ length: span.chunkCount }, (_, index) => {
      const record = front.records[span.chunkStart + index]!;
      return Object.freeze({
        bytes: bytes.subarray(record.byteOffset, record.byteOffset + record.byteLength),
        timestamp: record.presentationTimestamp,
        key: record.randomAccess,
        displayedFrames: record.displayedFrameCount
      });
    }));
  });
  return Object.freeze({
    profile: Object.freeze({
      codec: rendition.codec,
      bitDepth: rendition.bitDepth,
      codedWidth: rendition.codedWidth,
      codedHeight: rendition.codedHeight,
      visibleWidth,
      visibleHeight,
      frameRate: front.manifest.frameRate,
      averageBitrate: rendition.bitrate.average
    }),
    units: Object.freeze(units)
  });
}

function replaceFirst(
  unit: readonly CodecValidationChunk[],
  change: Partial<CodecValidationChunk>
): readonly CodecValidationChunk[] {
  return Object.freeze([
    Object.freeze({ ...unit[0]!, ...change }),
    ...unit.slice(1)
  ]);
}

function replaceFirstBytes(
  unit: readonly CodecValidationChunk[],
  bytes: Uint8Array
): readonly CodecValidationChunk[] {
  return replaceFirst(unit, { bytes });
}

/** Find a one-bit header change that remains valid in isolation but not after unit zero. */
function findContinuityOnlyMutation(
  fixture: Readonly<Fixture>
): readonly CodecValidationChunk[] {
  const later = fixture.units[1]!;
  const original = later[0]!.bytes;
  const searchBytes = Math.min(original.byteLength, 2_048);
  for (let offset = 0; offset < searchBytes; offset += 1) {
    for (let bit = 1; bit <= 0x80; bit <<= 1) {
      const bytes = original.slice();
      bytes[offset] = bytes[offset]! ^ bit;
      const changed = replaceFirstBytes(later, bytes);
      try {
        createCodecValidator(fixture.profile).validate(changed);
      } catch {
        continue;
      }
      const sequential = createCodecValidator(fixture.profile);
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
