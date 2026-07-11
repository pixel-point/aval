export const H264_NAL_UNIT_TYPE = {
  nonIdrSlice: 1,
  idrSlice: 5,
  sei: 6,
  sps: 7,
  pps: 8,
  accessUnitDelimiter: 9,
} as const;

export interface AnnexBNalUnit {
  readonly startOffset: number;
  readonly payloadOffset: number;
  readonly endOffset: number;
  readonly startCodeLength: 3 | 4;
  readonly type: number;
  readonly nalRefIdc: number;
}

export interface H264AnnexBKeyAccessUnitEvidence {
  readonly byteLength: number;
  readonly nalUnits: readonly AnnexBNalUnit[];
  readonly nalUnitTypes: readonly number[];
  readonly startCodeLengths: readonly (3 | 4)[];
  readonly hasSps: true;
  readonly hasPps: true;
  readonly hasIdr: true;
}

export class AnnexBInspectionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AnnexBInspectionError";
  }
}

interface StartCode {
  readonly offset: number;
  readonly length: 3 | 4;
}

function findStartCode(bytes: Uint8Array, from: number): StartCode | undefined {
  for (let index = from; index + 2 < bytes.length; index += 1) {
    if (bytes[index] !== 0 || bytes[index + 1] !== 0) {
      continue;
    }

    if (bytes[index + 2] === 1) {
      return { offset: index, length: 3 };
    }
    if (index + 3 < bytes.length && bytes[index + 2] === 0 && bytes[index + 3] === 1) {
      return { offset: index, length: 4 };
    }
  }

  return undefined;
}

/** Splits one H.264 Annex B access unit without copying its payloads. */
export function splitAnnexBAccessUnit(bytes: Uint8Array): readonly AnnexBNalUnit[] {
  if (bytes.byteLength === 0) {
    throw new AnnexBInspectionError("Annex B access unit is empty");
  }

  const starts: StartCode[] = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    const start = findStartCode(bytes, cursor);
    if (start === undefined) {
      break;
    }
    starts.push(start);
    cursor = start.offset + start.length;
  }

  if (starts.length === 0) {
    throw new AnnexBInspectionError("Access unit contains no Annex B start code");
  }
  const firstStartOffset = starts[0]?.offset;
  if (firstStartOffset === undefined) {
    throw new AnnexBInspectionError("Access unit contains no Annex B start code");
  }
  const leadingBytes = bytes.subarray(0, firstStartOffset);
  if (leadingBytes.some((byte) => byte !== 0)) {
    throw new AnnexBInspectionError(
      "Annex B access unit has non-zero bytes before its first start code",
    );
  }

  return starts.map((start, index) => {
    const payloadOffset = start.offset + start.length;
    const endOffset = starts[index + 1]?.offset ?? bytes.length;
    if (payloadOffset >= endOffset) {
      throw new AnnexBInspectionError(
        `Annex B NAL unit ${index} has an empty payload`,
      );
    }

    const header = bytes[payloadOffset];
    if (header === undefined) {
      throw new AnnexBInspectionError(`Annex B NAL unit ${index} has no header`);
    }
    if ((header & 0x80) !== 0) {
      throw new AnnexBInspectionError(
        `Annex B NAL unit ${index} sets forbidden_zero_bit`,
      );
    }

    return {
      startOffset: start.offset,
      payloadOffset,
      endOffset,
      startCodeLength: start.length,
      type: header & 0x1f,
      nalRefIdc: (header >> 5) & 0x03,
    };
  });
}

/**
 * Proves that the first key access unit is in-band Annex B rather than avcC:
 * every NAL is start-code delimited and SPS, PPS, and IDR are all present.
 */
export function inspectH264AnnexBKeyAccessUnit(
  bytes: Uint8Array,
): H264AnnexBKeyAccessUnitEvidence {
  const nalUnits = splitAnnexBAccessUnit(bytes);
  const nalUnitTypes = nalUnits.map((unit) => unit.type);
  const hasSps = nalUnitTypes.includes(H264_NAL_UNIT_TYPE.sps);
  const hasPps = nalUnitTypes.includes(H264_NAL_UNIT_TYPE.pps);
  const hasIdr = nalUnitTypes.includes(H264_NAL_UNIT_TYPE.idrSlice);

  if (!hasSps || !hasPps || !hasIdr) {
    const missing = [
      !hasSps ? "SPS" : undefined,
      !hasPps ? "PPS" : undefined,
      !hasIdr ? "IDR" : undefined,
    ].filter((value): value is string => value !== undefined);
    throw new AnnexBInspectionError(
      `First key access unit is missing ${missing.join(", ")}`,
    );
  }

  return {
    byteLength: bytes.byteLength,
    nalUnits,
    nalUnitTypes,
    startCodeLengths: nalUnits.map((unit) => unit.startCodeLength),
    hasSps: true,
    hasPps: true,
    hasIdr: true,
  };
}
