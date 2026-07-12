import { describe, expect, it } from "vitest";

import {
  splitAnnexBAccessUnit,
  type AnnexBNalUnit
} from "../src/avc/annex-b.js";
import { parsePps, parseSps } from "../src/avc/parameter-sets.js";
import { parseSliceHeader } from "../src/avc/slice-header.js";
import { inspectAvcAnnexBRendition } from "../src/avc/index.js";
import { FormatError } from "../src/errors.js";
import {
  makeAccessUnit,
  makeAud,
  makePps,
  makeSlice,
  makeSps,
  nal,
  validInspectionInput
} from "./avc-fixture.js";

interface ErrorOutcome {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly offset?: number;
}

describe("exhaustive AVC syntax truncation boundaries", () => {
  it("rejects every physical byte truncation of AUD, SPS, PPS, and IDR NALs", () => {
    const components = Object.freeze({
      aud: makeAud(0),
      sps: makeSps({ compatibility: 0xe0, bt709Limited: true }),
      pps: makePps(),
      idr: makeSlice({ idr: true, frameNum: 0, sliceType: "I" })
    });

    for (const [target, bytes] of Object.entries(components)) {
      for (let byteLength = 0; byteLength < bytes.byteLength; byteLength += 1) {
        const truncated = bytes.slice(0, byteLength);
        expectStableProfileInvalid(
          () => inspectAvcAnnexBRendition(
            oneFrameInput({
              aud: target === "aud" ? truncated : components.aud,
              sps: target === "sps" ? truncated : components.sps,
              pps: target === "pps" ? truncated : components.pps,
              idr: target === "idr" ? truncated : components.idr
            })
          ),
          `${target} byte ${String(byteLength)}`
        );
      }
    }
  });

  it("rejects SPS syntax truncated at every bit before its real trailing bit", () => {
    const original = onlyNal(
      makeSps({ compatibility: 0xe0, bt709Limited: true }),
      "original.sps"
    );
    const stopBit = trailingStopBitOffset(original.rbsp);

    for (let bitOffset = 0; bitOffset < stopBit; bitOffset += 1) {
      const candidate = withRbsp(
        original,
        truncateRbspAt(original.rbsp, bitOffset)
      );
      expectStableProfileInvalid(
        () => parseSps(candidate, `sps[${String(bitOffset)}]`),
        `SPS bit ${String(bitOffset)}`
      );
    }

    expect(() => parseSps(original, "original.sps")).not.toThrow();
  });

  it("rejects PPS syntax truncated at every bit before its real trailing bit", () => {
    const original = onlyNal(makePps(), "original.pps");
    const stopBit = trailingStopBitOffset(original.rbsp);

    for (let bitOffset = 0; bitOffset < stopBit; bitOffset += 1) {
      const candidate = withRbsp(
        original,
        truncateRbspAt(original.rbsp, bitOffset)
      );
      expectStableProfileInvalid(
        () => parsePps(candidate, `pps[${String(bitOffset)}]`),
        `PPS bit ${String(bitOffset)}`
      );
    }

    expect(() => parsePps(original, "original.pps")).not.toThrow();
  });

  it.each([
    {
      label: "IDR I",
      header: 0x65,
      headerBits: 16,
      bytes: makeSlice({ idr: true, frameNum: 0, sliceType: "I" })
    },
    {
      label: "non-IDR P",
      header: 0x61,
      headerBits: 14,
      bytes: makeSlice({ idr: false, frameNum: 1, sliceType: "P" })
    }
  ])(
    "rejects every bit truncation inside the $label slice header and accepts its exact data boundary",
    ({ label, header, headerBits, bytes }) => {
      const sps = parseSps(
        onlyNal(
          makeSps({ compatibility: 0xe0, bt709Limited: true }),
          "parameterSets.sps"
        ),
        "parameterSets.sps"
      );
      const pps = parsePps(
        onlyNal(makePps(), "parameterSets.pps"),
        "parameterSets.pps"
      );
      const original = onlyNal(bytes, `original.${label}`);

      for (let bitOffset = 0; bitOffset < headerBits; bitOffset += 1) {
        const candidate = withRbsp(
          original,
          truncateRbspAt(original.rbsp, bitOffset)
        );
        expectStableProfileInvalid(
          () => parseSliceHeader(candidate, pps, sps, 16, "slice"),
          `${label} bit ${String(bitOffset)}`
        );
      }

      const firstCompleteHeader = onlyNal(
        nal(
          header,
          terminateRbspAt(original.rbsp, headerBits),
          original.prefixLength
        ),
        "slice.completeHeader"
      );
      expect(() =>
        parseSliceHeader(firstCompleteHeader, pps, sps, 16, "slice")
      ).not.toThrow();
    }
  );

  it("keeps Annex B prefix, NAL-header, and escaped-RBSP boundary errors stable", () => {
    const vectors = [
      Uint8Array.of(0),
      Uint8Array.of(0, 0),
      Uint8Array.of(0, 0, 0),
      Uint8Array.of(0, 0, 0, 1),
      Uint8Array.of(0, 0, 0, 1, 0x67),
      Uint8Array.of(0, 0, 0, 1, 0x67, 0, 0),
      Uint8Array.of(0, 0, 0, 1, 0x67, 0, 0, 3),
      Uint8Array.of(0, 0, 0, 1, 0x67, 0, 0, 3, 4)
    ];

    for (let index = 0; index < vectors.length; index += 1) {
      const bytes = vectors[index];
      expectStableProfileInvalid(
        () => splitAnnexBAccessUnit(bytes!, `annexB[${String(index)}]`),
        `Annex B vector ${String(index)}`
      );
    }
  });
});

function oneFrameInput(parts: {
  readonly aud: Uint8Array;
  readonly sps: Uint8Array;
  readonly pps: Uint8Array;
  readonly idr: Uint8Array;
}): ReturnType<typeof validInspectionInput> {
  return validInspectionInput({
    units: [
      {
        id: "idle",
        accessUnits: [
          makeAccessUnit({
            idr: true,
            frameNum: 0,
            aud: parts.aud,
            sps: parts.sps,
            pps: parts.pps,
            slices: [parts.idr]
          })
        ]
      }
    ]
  });
}

function onlyNal(bytes: Uint8Array, path: string): AnnexBNalUnit {
  const units = splitAnnexBAccessUnit(bytes, path, 1);
  expect(units).toHaveLength(1);
  const unit = units[0];
  if (unit === undefined) {
    throw new Error("test fixture contains no NAL unit");
  }
  return unit;
}

function trailingStopBitOffset(rbsp: Uint8Array): number {
  for (let bitOffset = rbsp.byteLength * 8 - 1; bitOffset >= 0; bitOffset -= 1) {
    if (readBit(rbsp, bitOffset) === 1) {
      return bitOffset;
    }
  }
  throw new Error("test fixture has no RBSP stop bit");
}

function truncateRbspAt(rbsp: Uint8Array, bitOffset: number): Uint8Array {
  if (!Number.isSafeInteger(bitOffset) || bitOffset < 0) {
    throw new Error("test truncation bit offset is invalid");
  }
  const output = new Uint8Array(Math.ceil(bitOffset / 8));
  for (let bit = 0; bit < bitOffset; bit += 1) {
    writeBit(output, bit, readBit(rbsp, bit));
  }
  return output;
}

function terminateRbspAt(rbsp: Uint8Array, bitOffset: number): Uint8Array {
  if (!Number.isSafeInteger(bitOffset) || bitOffset < 0) {
    throw new Error("test truncation bit offset is invalid");
  }
  const output = new Uint8Array(Math.ceil((bitOffset + 1) / 8));
  for (let bit = 0; bit < bitOffset; bit += 1) {
    writeBit(output, bit, readBit(rbsp, bit));
  }
  writeBit(output, bitOffset, 1);
  return output;
}

function withRbsp(
  original: AnnexBNalUnit,
  rbsp: Uint8Array
): AnnexBNalUnit {
  return Object.freeze({
    ...original,
    payload: original.payload.slice(),
    rbsp
  });
}

function readBit(bytes: Uint8Array, bitOffset: number): 0 | 1 {
  const byte = bytes[Math.floor(bitOffset / 8)];
  if (byte === undefined) {
    throw new Error("test bit read exceeds the fixture");
  }
  return ((byte >> (7 - (bitOffset % 8))) & 1) as 0 | 1;
}

function writeBit(bytes: Uint8Array, bitOffset: number, value: 0 | 1): void {
  if (value === 0) return;
  const byteIndex = Math.floor(bitOffset / 8);
  bytes[byteIndex] = (bytes[byteIndex] ?? 0) | (1 << (7 - (bitOffset % 8)));
}

function expectStableProfileInvalid(
  callback: () => unknown,
  label: string
): void {
  const first = captureProfileInvalid(callback, label);
  const second = captureProfileInvalid(callback, label);
  expect(second, label).toEqual(first);
  expect(first, label).toMatchObject({
    code: "PROFILE_INVALID"
  });
  expect(first.path, label).toBeTypeOf("string");
  if (first.offset !== undefined) {
    expect(Number.isSafeInteger(first.offset), label).toBe(true);
    expect(first.offset, label).toBeGreaterThanOrEqual(0);
  }
}

function captureProfileInvalid(
  callback: () => unknown,
  label: string
): ErrorOutcome {
  try {
    callback();
  } catch (error) {
    if (!(error instanceof FormatError)) {
      throw error;
    }
    return {
      code: error.code,
      message: error.message,
      ...(error.path === undefined ? {} : { path: error.path }),
      ...(error.offset === undefined ? {} : { offset: error.offset })
    };
  }
  throw new Error(`${label} unexpectedly passed AVC inspection`);
}
