import { describe, expect, it } from "vitest";

import {
  splitAnnexBAccessUnit,
  type AnnexBNalUnit
} from "../src/h264/annex-b.js";
import { FormatError } from "../src/errors.js";
import { inspectH264AnnexBRendition } from "../src/h264/index.js";
import { parsePps, parseSps } from "../src/h264/parameter-sets.js";
import {
  makeAccessUnit,
  makeAud,
  makePps,
  makeSlice,
  makeSps,
  validInspectionInput
} from "./h264-fixture.js";

interface ErrorOutcome {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly offset?: number;
}

const CONSTRAINED_BASELINE_SPS = makeSps();
const CONSTRAINED_BASELINE_PPS = makePps();

describe("H264 hostile syntax boundaries", () => {
  it("retains only variable PPS facts after validating fixed profile syntax", () => {
    const pps = parsePps(onlyNal(makePps(), "pps.original"), "pps.original");

    expect(Object.keys(pps)).toEqual([
      "id",
      "spsId",
      "payloadSignature",
      "picInitQpMinus26"
    ]);
  });

  it("rejects every physical byte truncation in the Constrained Baseline grammar", () => {
    const components = Object.freeze({
      aud: makeAud(0),
      sps: CONSTRAINED_BASELINE_SPS,
      pps: CONSTRAINED_BASELINE_PPS,
      idr: makeSlice({
        idr: true,
        frameNum: 0,
        sliceType: "I",
        picOrderCountType: 0,
        picOrderCntLsb: 0
      })
    });

    for (const [target, bytes] of Object.entries(components)) {
      for (let byteLength = 0; byteLength < bytes.byteLength; byteLength += 1) {
        const truncated = bytes.slice(0, byteLength);
        expectStableProfileInvalid(
          () => inspectH264AnnexBRendition(oneFrameInput({
            aud: target === "aud" ? truncated : components.aud,
            sps: target === "sps" ? truncated : components.sps,
            pps: target === "pps" ? truncated : components.pps,
            idr: target === "idr" ? truncated : components.idr
          })),
          `Constrained Baseline ${target} byte ${String(byteLength)}`
        );
      }
    }
  });

  it("rejects Constrained Baseline SPS syntax truncated before its trailing stop bit", () => {
    const original = onlyNal(
      CONSTRAINED_BASELINE_SPS,
      "Constrained Baseline.original.sps"
    );
    const stopBit = trailingStopBitOffset(original.rbsp);

    for (let bitOffset = 0; bitOffset < stopBit; bitOffset += 1) {
      const candidate = withRbsp(
        original,
        truncateRbspAt(original.rbsp, bitOffset)
      );
      expectStableProfileInvalid(
        () => parseSps(candidate, `sps[${String(bitOffset)}]`),
        `Constrained Baseline SPS bit ${String(bitOffset)}`
      );
    }
    expect(() => parseSps(original, "Constrained Baseline.original.sps"))
      .not.toThrow();
  });

  it("rejects Constrained Baseline PPS syntax truncated before its trailing stop bit", () => {
    const original = onlyNal(
      CONSTRAINED_BASELINE_PPS,
      "Constrained Baseline.original.pps"
    );
    const stopBit = trailingStopBitOffset(original.rbsp);

    for (let bitOffset = 0; bitOffset < stopBit; bitOffset += 1) {
      const candidate = withRbsp(
        original,
        truncateRbspAt(original.rbsp, bitOffset)
      );
      expectStableProfileInvalid(
        () => parsePps(candidate, `pps[${String(bitOffset)}]`),
        `Constrained Baseline PPS bit ${String(bitOffset)}`
      );
    }
    expect(() => parsePps(original, "Constrained Baseline.original.pps"))
      .not.toThrow();
  });

  it("keeps Annex B prefix, NAL-header, and escaped-RBSP failures deterministic", () => {
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
      expectStableProfileInvalid(
        () => splitAnnexBAccessUnit(vectors[index]!, `annexB[${String(index)}]`),
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
    units: [{
      id: "unit",
      accessUnits: [makeAccessUnit({
        idr: true,
        frameNum: 0,
        aud: parts.aud,
        sps: parts.sps,
        pps: parts.pps,
        slices: [parts.idr]
      })]
    }]
  });
}

function onlyNal(bytes: Uint8Array, path: string): AnnexBNalUnit {
  const units = splitAnnexBAccessUnit(bytes, path, 1);
  expect(units).toHaveLength(1);
  const unit = units[0];
  if (unit === undefined) throw new Error("test fixture contains no NAL unit");
  return unit;
}

function trailingStopBitOffset(rbsp: Uint8Array): number {
  for (let bitOffset = rbsp.byteLength * 8 - 1; bitOffset >= 0; bitOffset -= 1) {
    if (readBit(rbsp, bitOffset) === 1) return bitOffset;
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

function withRbsp(original: AnnexBNalUnit, rbsp: Uint8Array): AnnexBNalUnit {
  return Object.freeze({
    ...original,
    payload: original.payload.slice(),
    rbsp
  });
}

function readBit(bytes: Uint8Array, bitOffset: number): 0 | 1 {
  const byte = bytes[Math.floor(bitOffset / 8)];
  if (byte === undefined) throw new Error("test bit read exceeds the fixture");
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
  expect(first, label).toMatchObject({ code: "PROFILE_INVALID" });
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
    if (!(error instanceof FormatError)) throw error;
    return {
      code: error.code,
      message: error.message,
      ...(error.path === undefined ? {} : { path: error.path }),
      ...(error.offset === undefined ? {} : { offset: error.offset })
    };
  }
  throw new Error(`${label} unexpectedly passed H264 inspection`);
}
