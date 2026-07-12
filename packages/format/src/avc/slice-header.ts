import {
  AVC_NAL_TYPE_IDR,
  type AnnexBNalUnit
} from "./annex-b.js";
import { RbspBitReader } from "./bit-reader.js";
import { requireAvc } from "./failure.js";
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
  readonly deltaPicOrderCntBottom: number;
  readonly deltaPicOrderCnt0: number;
  readonly deltaPicOrderCnt1: number;
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
  requireAvc(
    normalizedSliceType === 0 || normalizedSliceType === 2,
    path,
    "only I and P slices are permitted (B/SP/SI are forbidden)",
    nal.offset + 1 + Math.floor(reader.bitOffset / 8)
  );
  const sliceType = normalizedSliceType === 2 ? "I" : "P";
  const idr = nal.type === AVC_NAL_TYPE_IDR;
  requireAvc(
    !idr || sliceType === "I",
    path,
    "an IDR picture must contain only I slices",
    nal.offset + 1 + Math.floor(reader.bitOffset / 8)
  );

  const ppsId = reader.readUnsignedExpGolomb("pic_parameter_set_id", 255);
  requireAvc(
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
  let deltaPicOrderCntBottom = 0;
  let deltaPicOrderCnt0 = 0;
  let deltaPicOrderCnt1 = 0;
  if (sps.picOrderCount.type === 0) {
    picOrderCntLsb = reader.readBits(
      sps.picOrderCount.lsbBits,
      "pic_order_cnt_lsb"
    );
    if (pps.bottomFieldPicOrderInFramePresent) {
      deltaPicOrderCntBottom = reader.readSignedExpGolomb(
        "delta_pic_order_cnt_bottom"
      );
    }
  } else if (
    sps.picOrderCount.type === 1 &&
    !sps.picOrderCount.deltaPicOrderAlwaysZero
  ) {
    deltaPicOrderCnt0 = reader.readSignedExpGolomb("delta_pic_order_cnt[0]");
    if (pps.bottomFieldPicOrderInFramePresent) {
      deltaPicOrderCnt1 = reader.readSignedExpGolomb("delta_pic_order_cnt[1]");
    }
  }

  if (sliceType === "P") {
    if (reader.readBit("num_ref_idx_active_override_flag")) {
      requireAvc(
        reader.readUnsignedExpGolomb("num_ref_idx_l0_active_minus1", 31) === 0,
        path,
        "P slices may use only one list0 reference",
        nal.offset + 1 + Math.floor(reader.bitOffset / 8)
      );
    }
    requireAvc(
      !reader.readBit("ref_pic_list_modification_flag_l0"),
      path,
      "reference-list reordering is forbidden",
      nal.offset + 1 + Math.floor(reader.bitOffset / 8)
    );
  }

  if (idr) {
    reader.readBit("no_output_of_prior_pics_flag");
    requireAvc(
      !reader.readBit("long_term_reference_flag"),
      path,
      "long-term IDR references are forbidden",
      nal.offset + 1 + Math.floor(reader.bitOffset / 8)
    );
  } else {
    requireAvc(
      !reader.readBit("adaptive_ref_pic_marking_mode_flag"),
      path,
      "adaptive and long-term reference marking are forbidden",
      nal.offset + 1 + Math.floor(reader.bitOffset / 8)
    );
  }

  reader.readSignedExpGolomb("slice_qp_delta", -87, 77);
  if (pps.deblockingFilterControlPresent) {
    const disableDeblockingFilterIdc = reader.readUnsignedExpGolomb(
      "disable_deblocking_filter_idc",
      2
    );
    if (disableDeblockingFilterIdc !== 1) {
      reader.readSignedExpGolomb("slice_alpha_c0_offset_div2", -6, 6);
      reader.readSignedExpGolomb("slice_beta_offset_div2", -6, 6);
    }
  }
  requireAvc(
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
    deltaPicOrderCntBottom,
    deltaPicOrderCnt0,
    deltaPicOrderCnt1
  });
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
    left.deltaPicOrderCntBottom === right.deltaPicOrderCntBottom &&
    left.deltaPicOrderCnt0 === right.deltaPicOrderCnt0 &&
    left.deltaPicOrderCnt1 === right.deltaPicOrderCnt1
  );
}
