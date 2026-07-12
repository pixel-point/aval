import type {
  AvcAccessUnitInput,
  AvcRenditionInspectionInput
} from "../src/avc/index.js";

class BitWriter {
  readonly #bits: number[] = [];

  public bit(value: boolean | number): this {
    this.#bits.push(value ? 1 : 0);
    return this;
  }

  public bits(value: number, width: number): this {
    for (let shift = width - 1; shift >= 0; shift -= 1) {
      this.bit(Math.floor(value / 2 ** shift) % 2);
    }
    return this;
  }

  public ue(value: number): this {
    const code = value + 1;
    const width = Math.floor(Math.log2(code)) + 1;
    for (let index = 1; index < width; index += 1) {
      this.bit(0);
    }
    return this.bits(code, width);
  }

  public se(value: number): this {
    return this.ue(value <= 0 ? -2 * value : 2 * value - 1);
  }

  public trailing(): this {
    this.bit(1);
    while (this.#bits.length % 8 !== 0) {
      this.bit(0);
    }
    return this;
  }

  public toBytes(): Uint8Array {
    if (this.#bits.length % 8 !== 0) {
      throw new Error("fixture bits must be byte-aligned");
    }
    const bytes = new Uint8Array(this.#bits.length / 8);
    for (let index = 0; index < this.#bits.length; index += 1) {
      if (this.#bits[index] === 1) {
        const byteIndex = Math.floor(index / 8);
        bytes[byteIndex] = (bytes[byteIndex] ?? 0) | (1 << (7 - (index % 8)));
      }
    }
    return bytes;
  }
}

export interface SpsFixtureOptions {
  readonly profileIdc?: number;
  readonly compatibility?: number;
  readonly levelIdc?: number;
  readonly spsId?: number;
  readonly picOrderCountType?: 0 | 1 | 2;
  readonly maxNumRefFrames?: number;
  readonly widthInMacroblocks?: number;
  readonly heightInMacroblocks?: number;
  readonly crop?: readonly [left: number, right: number, top: number, bottom: number];
  readonly numUnitsInTick?: number;
  readonly timeScale?: number;
  readonly fixedFrameRate?: boolean;
  readonly maxNumReorderFrames?: number;
  readonly maxDecFrameBuffering?: number;
  readonly includeVui?: boolean;
  readonly includeBitstreamRestriction?: boolean;
  readonly bt709Limited?: boolean;
  readonly sampleAspectRatio?: readonly [width: number, height: number];
  readonly hrd?: {
    readonly bitRateValueMinus1: number;
    readonly cpbSizeValueMinus1: number;
    readonly bitRateScale?: number;
    readonly cpbSizeScale?: number;
  };
}

export function makeSps(options: SpsFixtureOptions = {}): Uint8Array {
  const writer = new BitWriter()
    .bits(options.profileIdc ?? 66, 8)
    .bits(options.compatibility ?? 0xc0, 8)
    .bits(options.levelIdc ?? 32, 8)
    .ue(options.spsId ?? 0)
    .ue(0);
  const pocType = options.picOrderCountType ?? 2;
  writer.ue(pocType);
  if (pocType === 0) {
    writer.ue(0);
  } else if (pocType === 1) {
    writer.bit(true).se(0).se(0).ue(1).se(2);
  }
  writer
    .ue(options.maxNumRefFrames ?? 1)
    .bit(false)
    .ue((options.widthInMacroblocks ?? 4) - 1)
    .ue((options.heightInMacroblocks ?? 4) - 1)
    .bit(true)
    .bit(true);
  const crop = options.crop;
  writer.bit(crop !== undefined);
  if (crop !== undefined) {
    writer.ue(crop[0]).ue(crop[1]).ue(crop[2]).ue(crop[3]);
  }
  writer.bit(options.includeVui !== false);
  if (options.includeVui !== false) {
    writer.bit(options.sampleAspectRatio !== undefined);
    if (options.sampleAspectRatio !== undefined) {
      writer
        .bits(255, 8)
        .bits(options.sampleAspectRatio[0], 16)
        .bits(options.sampleAspectRatio[1], 16);
    }
    writer.bit(false); // overscan
    writer.bit(options.bt709Limited === true);
    if (options.bt709Limited === true) {
      writer.bits(5, 3).bit(false).bit(true).bits(1, 8).bits(1, 8).bits(1, 8);
    }
    writer.bit(false); // chroma location
    writer
      .bit(true)
      .bits(options.numUnitsInTick ?? 1, 32)
      .bits(options.timeScale ?? 60, 32)
      .bit(options.fixedFrameRate !== false);
    writer.bit(options.hrd !== undefined);
    if (options.hrd !== undefined) {
      writeHrd(writer, options.hrd);
    }
    writer.bit(false); // vcl hrd
    if (options.hrd !== undefined) {
      writer.bit(true); // low delay HRD
    }
    writer.bit(false); // pic struct
    writer.bit(options.includeBitstreamRestriction !== false);
    if (options.includeBitstreamRestriction !== false) {
      writer
        .bit(true)
        .ue(2)
        .ue(1)
        .ue(16)
        .ue(16)
        .ue(options.maxNumReorderFrames ?? 0)
        .ue(options.maxDecFrameBuffering ?? 1);
    }
  }
  return nal(0x67, writer.trailing().toBytes(), 4);
}

function writeHrd(
  writer: BitWriter,
  hrd: NonNullable<SpsFixtureOptions["hrd"]>
): void {
  writer
    .ue(0)
    .bits(hrd.bitRateScale ?? 0, 4)
    .bits(hrd.cpbSizeScale ?? 0, 4)
    .ue(hrd.bitRateValueMinus1)
    .ue(hrd.cpbSizeValueMinus1)
    .bit(false)
    .bits(23, 5)
    .bits(23, 5)
    .bits(23, 5)
    .bits(0, 5);
}

export interface PpsFixtureOptions {
  readonly ppsId?: number;
  readonly spsId?: number;
  readonly entropyCoding?: boolean;
  readonly sliceGroupsMinus1?: number;
  readonly refList0Minus1?: number;
  readonly weightedPrediction?: boolean;
  readonly bottomFieldPicOrder?: boolean;
  readonly picInitQpMinus26?: number;
  readonly picInitQsMinus26?: number;
  readonly chromaQpIndexOffset?: number;
  readonly deblockingFilterControl?: boolean;
  readonly constrainedIntraPrediction?: boolean;
  readonly redundantPictures?: boolean;
  readonly extensionBit?: boolean;
}

export function makePps(options: PpsFixtureOptions = {}): Uint8Array {
  const writer = new BitWriter()
    .ue(options.ppsId ?? 0)
    .ue(options.spsId ?? 0)
    .bit(options.entropyCoding === true)
    .bit(options.bottomFieldPicOrder === true)
    .ue(options.sliceGroupsMinus1 ?? 0)
    .ue(options.refList0Minus1 ?? 0)
    .ue(0)
    .bit(options.weightedPrediction === true)
    .bits(0, 2)
    .se(options.picInitQpMinus26 ?? 0)
    .se(options.picInitQsMinus26 ?? 0)
    .se(options.chromaQpIndexOffset ?? -2)
    .bit(options.deblockingFilterControl !== false)
    .bit(options.constrainedIntraPrediction === true)
    .bit(options.redundantPictures === true);
  if (options.extensionBit === true) {
    writer.bit(true);
  }
  return nal(0x68, writer.trailing().toBytes(), 3);
}

export interface SliceFixtureOptions {
  readonly idr: boolean;
  readonly frameNum: number;
  readonly sliceType?: "I" | "P" | "B";
  readonly firstMacroblock?: number;
  readonly ppsId?: number;
  readonly idrPicId?: number;
  readonly picOrderCountType?: 0 | 1 | 2;
  readonly picOrderCntLsb?: number;
  readonly referenceListModification?: boolean;
  readonly adaptiveMarking?: boolean;
  readonly longTermReference?: boolean;
}

export function makeSlice(options: SliceFixtureOptions): Uint8Array {
  const normalizedType =
    options.sliceType === "B" ? 1 : options.sliceType === "I" ? 2 : 0;
  const writer = new BitWriter()
    .ue(options.firstMacroblock ?? 0)
    .ue(normalizedType)
    .ue(options.ppsId ?? 0)
    .bits(options.frameNum, 4);
  if (options.idr) {
    writer.ue(options.idrPicId ?? 0);
  }
  if (options.picOrderCountType === 0) {
    writer.bits(options.picOrderCntLsb ?? 0, 4);
  }
  if (normalizedType === 0) {
    writer.bit(false).bit(options.referenceListModification === true);
  }
  if (options.idr) {
    writer.bit(false).bit(options.longTermReference === true);
  } else {
    writer.bit(options.adaptiveMarking === true);
  }
  writer.se(0).ue(0).se(0).se(0);
  // One opaque fixture bit stands in for CAVLC slice_data; the inspector does
  // not attempt to entropy-decode macroblocks.
  writer.bit(true).trailing();
  return nal(options.idr ? 0x65 : 0x61, writer.toBytes(), 3);
}

export function makeAud(primaryPicType: 0 | 1 | 2 = 0): Uint8Array {
  return nal(0x09, new BitWriter().bits(primaryPicType, 3).trailing().toBytes(), 4);
}

export function makeAccessUnit(options: {
  readonly idr: boolean;
  readonly frameNum: number;
  readonly key?: boolean;
  readonly sps?: Uint8Array;
  readonly pps?: Uint8Array;
  readonly aud?: Uint8Array;
  readonly slices?: readonly Uint8Array[];
  readonly picOrderCountType?: 0 | 1 | 2;
  readonly picOrderCntLsb?: number;
}): AvcAccessUnitInput {
  const slices =
    options.slices ??
    [
      makeSlice({
        idr: options.idr,
        frameNum: options.frameNum,
        sliceType: options.idr ? "I" : "P",
        ...(options.picOrderCountType === undefined
          ? {}
          : { picOrderCountType: options.picOrderCountType }),
        ...(options.picOrderCntLsb === undefined
          ? {}
          : { picOrderCntLsb: options.picOrderCntLsb })
      })
    ];
  return {
    key: options.key ?? options.idr,
    bytes: concat(
      options.aud,
      options.sps,
      options.pps,
      ...slices
    )
  };
}

export interface MutableInspectionInput {
  profile: {
    codedWidth: number;
    codedHeight: number;
    frameRate: { numerator: number; denominator: number };
    averageBitrate: number;
    peakBitrate: number;
    cpbBufferBits: number;
    requireBt709LimitedRange: true;
  };
  units: Array<{
    id: string;
    accessUnits: Array<{ bytes: Uint8Array; key: boolean }>;
  }>;
}

export function validInspectionInput(options: {
  readonly spsOptions?: SpsFixtureOptions;
  readonly requireBt709LimitedRange?: boolean;
  readonly units?: AvcRenditionInspectionInput["units"];
} = {}): MutableInspectionInput {
  const sps = makeSps({
    ...options.spsOptions,
    compatibility: options.spsOptions?.compatibility ?? 0xe0,
    bt709Limited: options.spsOptions?.bt709Limited ?? true
  });
  const pps = makePps();
  return {
    profile: {
      codedWidth: (options.spsOptions?.widthInMacroblocks ?? 4) * 16,
      codedHeight: (options.spsOptions?.heightInMacroblocks ?? 4) * 16,
      frameRate: { numerator: 30, denominator: 1 },
      averageBitrate: 1_000_000,
      peakBitrate: 2_000_000,
      cpbBufferBits: 2_000_000,
      requireBt709LimitedRange: true
    },
    units: (options.units ?? [
        {
          id: "idle",
          accessUnits: [
            makeAccessUnit({ idr: true, frameNum: 0, sps, pps, aud: makeAud(0) }),
            makeAccessUnit({ idr: false, frameNum: 1, aud: makeAud(1) })
          ]
        },
        {
          id: "hover",
          accessUnits: [
            makeAccessUnit({
              idr: true,
              frameNum: 0,
              sps,
              pps,
              aud: makeAud(0)
            }),
            makeAccessUnit({ idr: false, frameNum: 1, aud: makeAud(1) })
          ]
        }
      ]).map((unit) => ({
        id: unit.id,
        accessUnits: unit.accessUnits.map((accessUnit) => ({
          bytes: accessUnit.bytes,
          key: accessUnit.key
        }))
      }))
  };
}

export function nal(
  header: number,
  rbsp: Uint8Array,
  prefixLength: 3 | 4 = 3
): Uint8Array {
  const escaped = escapeRbsp(rbsp);
  const output = new Uint8Array(prefixLength + 1 + escaped.length);
  output[prefixLength - 1] = 1;
  output[prefixLength] = header;
  output.set(escaped, prefixLength + 1);
  return output;
}

export function concat(...parts: readonly (Uint8Array | undefined)[]): Uint8Array {
  const present = parts.filter((part): part is Uint8Array => part !== undefined);
  const result = new Uint8Array(
    present.reduce((length, part) => length + part.length, 0)
  );
  let offset = 0;
  for (const part of present) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function escapeRbsp(rbsp: Uint8Array): Uint8Array {
  const bytes: number[] = [];
  let zeroCount = 0;
  for (const byte of rbsp) {
    if (zeroCount === 2 && byte <= 3) {
      bytes.push(3);
      zeroCount = 0;
    }
    bytes.push(byte);
    zeroCount = byte === 0 ? zeroCount + 1 : 0;
  }
  return Uint8Array.from(bytes);
}
