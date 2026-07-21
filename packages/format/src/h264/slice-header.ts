import {
  H264_NAL_TYPE_IDR,
  type AnnexBNalUnit
} from "./annex-b.js";
import { RbspBitReader } from "./bit-reader.js";
import { requireH264 } from "./failure.js";
import type { ParsedPps, ParsedSps } from "./parameter-sets.js";

export interface ParsedSliceHeader {
  readonly firstMacroblock: number;
  readonly sliceType: "I" | "P";
  readonly ppsId: number;
  readonly frameNum: number;
  readonly referenceIdc: number;
  readonly idr: boolean;
  readonly idrPicId: number | undefined;
  readonly picOrderCntLsb: number | undefined;
  readonly deltaPicOrderCnt0: number;
  readonly sliceQpDelta: number;
}
export function parseSliceHeader(
  nal: AnnexBNalUnit,
  pps: ParsedPps,
  sps: ParsedSps,
  macroblocksPerFrame: number,
  path: string
): ParsedSliceHeader {
  const reader = new RbspBitReader(nal.rbsp, path, nal.offset + 1);
  const firstMacroblock = reader.readUnsignedExpGolomb(
    "first_mb_in_slice",
    macroblocksPerFrame - 1
  );
  const rawSliceType = reader.readUnsignedExpGolomb("slice_type", 9);
  const normalizedSliceType = rawSliceType % 5;
  requireH264(
    normalizedSliceType === 0 || normalizedSliceType === 2,
    path,
    "Constrained Baseline permits only I and P slices",
    nal.offset + 1 + Math.floor(reader.bitOffset / 8)
  );
  const sliceType = normalizedSliceType === 2 ? "I" : "P";
  const idr = nal.type === H264_NAL_TYPE_IDR;
  requireH264(
    !idr || sliceType === "I",
    path,
    "an IDR picture must contain only I slices",
    nal.offset + 1 + Math.floor(reader.bitOffset / 8)
  );

  const ppsId = reader.readUnsignedExpGolomb("pic_parameter_set_id", 255);
  requireH264(
    ppsId === pps.id,
    path,
    "slice references an unexpected PPS",
    nal.offset + 1 + Math.floor(reader.bitOffset / 8)
  );
  const frameNum = reader.readBits(sps.frameNumBits, "frame_num");
  const idrPicId = idr
    ? reader.readUnsignedExpGolomb("idr_pic_id", 65_535)
    : undefined;

  let picOrderCntLsb: number | undefined;
  let deltaPicOrderCnt0 = 0;
  if (sps.picOrderCount.type === 0) {
    picOrderCntLsb = reader.readBits(
      sps.picOrderCount.lsbBits,
      "pic_order_cnt_lsb"
    );
  } else if (
    sps.picOrderCount.type === 1 &&
    !sps.picOrderCount.deltaPicOrderAlwaysZero
  ) {
    deltaPicOrderCnt0 = reader.readSignedExpGolomb("delta_pic_order_cnt[0]");
  }

  if (sliceType === "P") {
    if (reader.readBit("num_ref_idx_active_override_flag")) {
      const numRefIdxL0ActiveMinus1 = reader.readUnsignedExpGolomb(
        "num_ref_idx_l0_active_minus1",
        31
      );
      requireH264(
        numRefIdxL0ActiveMinus1 === 0,
        path,
        "Constrained Baseline slice reference count must equal one",
        nal.offset + 1 + Math.floor(reader.bitOffset / 8)
      );
    }
    parseReferenceListModifications(reader, path, nal.offset + 1);
  }

  if (idr) {
    reader.readBit("no_output_of_prior_pics_flag");
    requireH264(
      !reader.readBit("long_term_reference_flag"),
      path,
      "long-term IDR references are forbidden",
      nal.offset + 1 + Math.floor(reader.bitOffset / 8)
    );
  } else if (nal.referenceIdc !== 0) {
    parseReferencePictureMarking(reader, path, nal.offset + 1);
  }

  const sliceQpDelta = reader.readSignedExpGolomb("slice_qp_delta", -87, 77);
  const finalQp = 26 + pps.picInitQpMinus26 + sliceQpDelta;
  requireH264(
    finalQp >= 0 && finalQp <= 51,
    path,
    "final slice QP is outside the 8-bit H264 range",
    nal.offset + 1 + Math.floor(reader.bitOffset / 8)
  );
  const disableDeblockingFilterIdc = reader.readUnsignedExpGolomb(
    "disable_deblocking_filter_idc",
    2
  );
  if (disableDeblockingFilterIdc !== 1) {
    reader.readSignedExpGolomb("slice_alpha_c0_offset_div2", -6, 6);
    reader.readSignedExpGolomb("slice_beta_offset_div2", -6, 6);
  }
  requireH264(
    reader.bitsRemaining > 0,
    path,
    "slice_data and RBSP trailing bits are missing",
    nal.offset + 1 + Math.floor(reader.bitOffset / 8)
  );

  return Object.freeze({
    firstMacroblock,
    sliceType,
    ppsId,
    frameNum,
    referenceIdc: nal.referenceIdc,
    idr,
    idrPicId,
    picOrderCntLsb,
    deltaPicOrderCnt0,
    sliceQpDelta
  });
}

function parseReferencePictureMarking(
  reader: RbspBitReader,
  path: string,
  absoluteOffset: number
): void {
  if (!reader.readBit("adaptive_ref_pic_marking_mode_flag")) return;
  for (let index = 0; index < 64; index += 1) {
    const operation = reader.readUnsignedExpGolomb(
      `memory_management_control_operation[${String(index)}]`,
      6
    );
    if (operation === 0) return;
    requireH264(
      operation === 1,
      path,
      "only short-term reference release is permitted",
      absoluteOffset + Math.floor(reader.bitOffset / 8)
    );
    reader.readUnsignedExpGolomb(
      `difference_of_pic_nums_minus1[${String(index)}]`,
      65_535
    );
  }
  requireH264(
    false,
    path,
    "reference-picture marking exceeds the syntax budget",
    absoluteOffset + Math.floor(reader.bitOffset / 8)
  );
}

function parseReferenceListModifications(
  reader: RbspBitReader,
  path: string,
  absoluteOffset: number
): void {
  if (!reader.readBit("ref_pic_list_modification_flag_l0")) return;
  for (let index = 0; index < 64; index += 1) {
    const operation = reader.readUnsignedExpGolomb(
      `modification_of_pic_nums_idc_l0[${String(index)}]`,
      3
    );
    if (operation === 3) return;
    if (operation === 0 || operation === 1) {
      reader.readUnsignedExpGolomb(
        `abs_diff_pic_num_minus1_l0[${String(index)}]`,
        65_535
      );
    } else {
      requireH264(
        false,
        path,
        "long-term reference-list entries are forbidden in independent units",
        absoluteOffset + Math.floor(reader.bitOffset / 8)
      );
    }
  }
  requireH264(
    false,
    path,
    "reference-list modification exceeds the syntax budget",
    absoluteOffset + Math.floor(reader.bitOffset / 8)
  );
}

export function samePrimaryPicture(
  left: ParsedSliceHeader,
  right: ParsedSliceHeader
): boolean {
  return (
    left.sliceType === right.sliceType &&
    left.ppsId === right.ppsId &&
    left.frameNum === right.frameNum &&
    left.referenceIdc === right.referenceIdc &&
    left.idr === right.idr &&
    left.idrPicId === right.idrPicId &&
    left.picOrderCntLsb === right.picOrderCntLsb &&
    left.deltaPicOrderCnt0 === right.deltaPicOrderCnt0
  );
}
