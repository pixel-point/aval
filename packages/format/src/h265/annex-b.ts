import { requireH265 } from "./failure.js";

export const H265_NAL_BLA_W_LP = 16;
export const H265_NAL_BLA_W_RADL = 17;
export const H265_NAL_BLA_N_LP = 18;
export const H265_NAL_IDR_W_RADL = 19;
export const H265_NAL_IDR_N_LP = 20;
export const H265_NAL_CRA_NUT = 21;
export const H265_NAL_VPS = 32;
export const H265_NAL_SPS = 33;
export const H265_NAL_PPS = 34;
export const H265_NAL_AUD = 35;
export const H265_NAL_EOS = 36;
export const H265_NAL_EOB = 37;
export const H265_NAL_FILLER = 38;
export const H265_NAL_PREFIX_SEI = 39;
export const H265_NAL_SUFFIX_SEI = 40;

export const H265_MAX_ACCESS_UNIT_BYTES = 64 * 1024 * 1024;
export const H265_MAX_NAL_UNITS = 4_096;
const MAX_PARAMETER_SET_BYTES = 1024 * 1024;

export interface H265AnnexBOptions {
  readonly maximumBytes?: number;
  readonly maximumNalUnits?: number;
  readonly allowEncoderMetadata?: boolean;
}

export interface H265AnnexBNalUnit {
  readonly type: number;
  readonly layerId: 0;
  readonly temporalId: number;
  readonly offset: number;
  readonly prefixLength: 3 | 4;
  readonly payload: Uint8Array;
  readonly rbsp: Uint8Array;
}

interface StartCode {
  readonly offset: number;
  readonly length: 3 | 4;
}

/** Splits one canonical Annex-B access unit without retaining hidden copies. */
export function splitH265AnnexBAccessUnit(
  bytes: Uint8Array,
  path = "accessUnit",
  options: H265AnnexBOptions = {}
): readonly H265AnnexBNalUnit[] {
  requireH265(bytes instanceof Uint8Array, path, "access unit must be bytes");
  const maximumBytes = options.maximumBytes ?? H265_MAX_ACCESS_UNIT_BYTES;
  const maximumNalUnits = options.maximumNalUnits ?? H265_MAX_NAL_UNITS;
  requireH265(
    Number.isSafeInteger(maximumBytes) && maximumBytes > 0,
    path,
    "access-unit byte budget is invalid"
  );
  requireH265(
    Number.isSafeInteger(maximumNalUnits) && maximumNalUnits > 0,
    path,
    "NAL-unit count budget is invalid"
  );
  requireH265(bytes.length >= 6, path, "Annex-B access unit is too short");
  requireH265(
    bytes.length <= maximumBytes,
    path,
    "Annex-B access unit exceeds the byte budget"
  );

  const starts = findStartCodes(bytes, path, maximumNalUnits);
  requireH265(starts.length > 0, path, "Annex-B start code is missing", 0);
  requireH265(starts[0]?.offset === 0, path, "bytes precede the first start code", 0);

  const units = starts.map((start, index) => {
    const payloadOffset = start.offset + start.length;
    const payloadEnd = starts[index + 1]?.offset ?? bytes.length;
    requireH265(
      payloadEnd >= payloadOffset + 3,
      path,
      "empty or truncated HEVC NAL unit",
      start.offset
    );
    const payload = bytes.subarray(payloadOffset, payloadEnd);
    const first = payload[0];
    const second = payload[1];
    requireH265(
      first !== undefined && second !== undefined,
      path,
      "HEVC NAL header is truncated",
      payloadOffset
    );
    requireH265(
      payload[payload.length - 1] !== 0,
      path,
      "NAL units may not contain trailing_zero_8bits",
      payloadEnd - 1
    );
    requireH265(
      (first & 0x80) === 0,
      path,
      "forbidden_zero_bit must be zero",
      payloadOffset
    );
    const type = (first >> 1) & 0x3f;
    const layerId = ((first & 1) << 5) | (second >> 3);
    const temporalIdPlusOne = second & 0x07;
    requireH265(layerId === 0, path, "multilayer HEVC is unsupported", payloadOffset);
    requireH265(
      temporalIdPlusOne !== 0,
      path,
      "nuh_temporal_id_plus1 must not be zero",
      payloadOffset + 1
    );
    requireH265(
      isPermittedH265NalType(type, options.allowEncoderMetadata === true),
      path,
      `NAL unit type ${String(type)} is outside the production HEVC profile`,
      payloadOffset
    );
    if (type >= H265_NAL_VPS) {
      requireH265(
        temporalIdPlusOne === 1,
        path,
        "non-VCL NAL units must use temporal_id zero",
        payloadOffset + 1
      );
    }
    if (type === H265_NAL_VPS || type === H265_NAL_SPS || type === H265_NAL_PPS) {
      requireH265(
        payload.length <= MAX_PARAMETER_SET_BYTES,
        path,
        "HEVC parameter set exceeds the syntax budget",
        payloadOffset
      );
    }
    return Object.freeze({
      type,
      layerId: 0 as const,
      temporalId: temporalIdPlusOne - 1,
      offset: payloadOffset,
      prefixLength: start.length,
      payload,
      rbsp: removeH265EmulationPrevention(
        payload.subarray(2),
        path,
        payloadOffset + 2
      )
    });
  });
  return Object.freeze(units);
}

export function isH265VclNalType(type: number): boolean {
  return (type >= 0 && type <= 9) || (type >= 16 && type <= 21);
}

export function isH265RandomAccessNalType(type: number): boolean {
  return type >= H265_NAL_BLA_W_LP && type <= H265_NAL_CRA_NUT;
}

export function isH265IdrNalType(type: number): boolean {
  return type === H265_NAL_IDR_W_RADL || type === H265_NAL_IDR_N_LP;
}

function isPermittedH265NalType(type: number, allowMetadata: boolean): boolean {
  if (isH265VclNalType(type)) return true;
  if (
    type === H265_NAL_VPS ||
    type === H265_NAL_SPS ||
    type === H265_NAL_PPS ||
    type === H265_NAL_AUD
  ) {
    return true;
  }
  return allowMetadata && (
    type === H265_NAL_EOS ||
    type === H265_NAL_EOB ||
    type === H265_NAL_FILLER ||
    type === H265_NAL_PREFIX_SEI ||
    type === H265_NAL_SUFFIX_SEI
  );
}

function findStartCodes(
  bytes: Uint8Array,
  path: string,
  maximumNalUnits: number
): readonly StartCode[] {
  const starts: StartCode[] = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    if (bytes[cursor] !== 0) {
      cursor += 1;
      continue;
    }
    const runStart = cursor;
    while (cursor < bytes.length && bytes[cursor] === 0) cursor += 1;
    if (bytes[cursor] !== 1 || cursor - runStart < 2) continue;
    const zeroCount = cursor - runStart;
    requireH265(
      zeroCount === 2 || zeroCount === 3,
      path,
      "start codes may contain only two or three zero bytes",
      runStart
    );
    starts.push(Object.freeze({
      offset: runStart,
      length: (zeroCount + 1) as 3 | 4
    }));
    requireH265(
      starts.length <= maximumNalUnits,
      path,
      "NAL-unit count exceeds the inspection budget",
      runStart
    );
    cursor += 1;
  }
  return Object.freeze(starts);
}

/** Removes emulation-prevention bytes and rejects non-canonical EBSP. */
export function removeH265EmulationPrevention(
  ebsp: Uint8Array,
  path: string,
  absoluteOffset: number
): Uint8Array {
  requireH265(ebsp.length > 0, path, "NAL RBSP is empty", absoluteOffset);
  const rbsp = new Uint8Array(ebsp.length);
  let outputLength = 0;
  let zeroCount = 0;
  for (let index = 0; index < ebsp.length; index += 1) {
    const byte = ebsp[index];
    requireH265(byte !== undefined, path, "truncated EBSP", absoluteOffset + index);
    if (zeroCount === 2) {
      if (byte === 0x03) {
        const escaped = ebsp[index + 1];
        requireH265(
          escaped !== undefined && escaped <= 0x03,
          path,
          "emulation_prevention_three_byte is not followed by 0x00..0x03",
          absoluteOffset + index
        );
        zeroCount = 0;
        continue;
      }
      requireH265(
        byte > 0x02,
        path,
        "unescaped start-code emulation sequence in EBSP",
        absoluteOffset + index
      );
    }
    rbsp[outputLength] = byte;
    outputLength += 1;
    zeroCount = byte === 0 ? zeroCount + 1 : 0;
  }
  return rbsp.slice(0, outputLength);
}
