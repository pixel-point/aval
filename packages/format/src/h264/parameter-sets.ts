import type { AnnexBNalUnit } from "./annex-b.js";
import { RbspBitReader } from "./bit-reader.js";
import { requireH264 } from "./failure.js";
import { isH264LevelIdc, type H264LevelIdc } from "./codec.js";
import type {
  H264ColorSummary,
  H264CropSummary
} from "./types.js";

const BASELINE_PROFILE_IDC = 66;
const MAX_HRD_BITS = BigInt(Number.MAX_SAFE_INTEGER);

export type H264SpsCompatibilityPolicy = "strict" | "encoder-candidate";

export interface ParsedSps {
  readonly id: number;
  /** Exact, immutable payload identity without retaining caller byte views. */
  readonly payloadSignature: string;
  readonly profileIdc: 66;
  readonly constraintSet2: boolean;
  readonly levelIdc: H264LevelIdc;
  readonly frameNumBits: number;
  readonly picOrderCount: PicOrderCountSyntax;
  readonly maxNumRefFrames: number;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly crop: H264CropSummary;
  readonly timing: {
    readonly numUnitsInTick: number;
    readonly timeScale: number;
    readonly fixedFrameRate: boolean;
  };
  readonly maxNumReorderFrames: number;
  readonly maxDecFrameBuffering: number;
  readonly hrdPresent: boolean;
  readonly hrdMaximumBitrate: number | undefined;
  readonly hrdMaximumCpbBits: number | undefined;
  readonly squareSampleAspect: boolean;
  readonly color: H264ColorSummary;
}

export type PicOrderCountSyntax =
  | {
      readonly type: 0;
      readonly lsbBits: number;
    }
  | {
      readonly type: 1;
      readonly deltaPicOrderAlwaysZero: boolean;
      readonly offsetForNonRefPic: number;
      readonly offsetForTopToBottomField: number;
      readonly offsetForRefFrame: readonly number[];
    }
  | { readonly type: 2 };

export interface ParsedPps {
  readonly id: number;
  readonly spsId: number;
  /** Exact, immutable payload identity without retaining caller byte views. */
  readonly payloadSignature: string;
  readonly picInitQpMinus26: number;
}

interface HrdSummary {
  readonly maximumBitrate: number;
  readonly maximumCpbBits: number;
}

interface VuiSummary {
  readonly timing: {
    readonly numUnitsInTick: number;
    readonly timeScale: number;
    readonly fixedFrameRate: boolean;
  };
  readonly maxNumReorderFrames: number;
  readonly maxDecFrameBuffering: number;
  readonly hrdPresent: boolean;
  readonly hrdMaximumBitrate: number | undefined;
  readonly hrdMaximumCpbBits: number | undefined;
  readonly squareSampleAspect: boolean;
  readonly color: H264ColorSummary;
}

export function parseSps(
  nal: AnnexBNalUnit,
  path: string,
  compatibilityPolicy: H264SpsCompatibilityPolicy = "strict"
): ParsedSps {
  const reader = new RbspBitReader(nal.rbsp, path, nal.offset + 1);
  const profileIdc = reader.readBits(8, "profile_idc");
  requireH264(
    profileIdc === BASELINE_PROFILE_IDC,
    path,
    "profile_idc must be Constrained Baseline (66)",
    nal.offset + 1
  );

  const compatibility = reader.readBits(8, "constraint flags");
  requireH264(
    compatibility === 0xe0 ||
      (compatibilityPolicy === "encoder-candidate" && compatibility === 0xc0),
    path,
    compatibilityPolicy === "strict"
      ? "Constrained Baseline compatibility byte must equal E0"
      : "encoder Baseline compatibility byte must equal C0 or E0",
    nal.offset + 2
  );
  const levelIdc = reader.readBits(8, "level_idc");
  requireH264(
    isH264LevelIdc(levelIdc),
    path,
    "level_idc must identify a supported H264 level",
    nal.offset + 3
  );
  const id = reader.readUnsignedExpGolomb("seq_parameter_set_id", 31);
  const log2MaxFrameNumMinus4 = reader.readUnsignedExpGolomb(
    "log2_max_frame_num_minus4",
    12
  );
  const frameNumBits = log2MaxFrameNumMinus4 + 4;
  const picOrderCount = parsePicOrderCount(reader);
  const maxNumRefFrames = reader.readUnsignedExpGolomb("max_num_ref_frames", 16);
  requireH264(maxNumRefFrames > 0, path, "max_num_ref_frames must be positive");
  requireH264(
    !reader.readBit("gaps_in_frame_num_value_allowed_flag"),
    path,
    "frame_num gaps are forbidden",
    nal.offset + 1 + Math.floor(reader.bitOffset / 8)
  );

  const widthInMacroblocks =
    reader.readUnsignedExpGolomb("pic_width_in_mbs_minus1", 8_191) + 1;
  const heightInMapUnits =
    reader.readUnsignedExpGolomb("pic_height_in_map_units_minus1", 8_191) + 1;
  const frameMbsOnly = reader.readBit("frame_mbs_only_flag");
  requireH264(
    frameMbsOnly,
    path,
    "interlaced and field-coded pictures are forbidden",
    nal.offset + 1 + Math.floor(reader.bitOffset / 8)
  );
  reader.readBit("direct_8x8_inference_flag");

  const codedWidth = widthInMacroblocks * 16;
  const codedHeight = heightInMapUnits * 16;
  let cropLeftOffset = 0;
  let cropRightOffset = 0;
  let cropTopOffset = 0;
  let cropBottomOffset = 0;
  if (reader.readBit("frame_cropping_flag")) {
    cropLeftOffset = reader.readUnsignedExpGolomb("frame_crop_left_offset");
    cropRightOffset = reader.readUnsignedExpGolomb("frame_crop_right_offset");
    cropTopOffset = reader.readUnsignedExpGolomb("frame_crop_top_offset");
    cropBottomOffset = reader.readUnsignedExpGolomb("frame_crop_bottom_offset");
  }

  // Both accepted progressive 4:2:0 profiles use 2x2 crop units.
  const left = cropLeftOffset * 2;
  const right = cropRightOffset * 2;
  const top = cropTopOffset * 2;
  const bottom = cropBottomOffset * 2;
  requireH264(
    left + right < codedWidth && top + bottom < codedHeight,
    path,
    "SPS crop removes the complete coded picture",
    nal.offset + 1 + Math.floor(reader.bitOffset / 8)
  );
  const crop: H264CropSummary = Object.freeze({
    left,
    right,
    top,
    bottom,
    visibleWidth: codedWidth - left - right,
    visibleHeight: codedHeight - top - bottom
  });

  requireH264(
    reader.readBit("vui_parameters_present_flag"),
    path,
    "VUI parameters are required by the H264 profile",
    nal.offset + 1 + Math.floor(reader.bitOffset / 8)
  );
  const vui = parseVui(reader, maxNumRefFrames, path, nal.offset + 1);
  reader.readTrailingBits();

  return Object.freeze({
    id,
    payloadSignature: createPayloadSignature(nal.payload),
    profileIdc,
    constraintSet2: (compatibility & 0x20) !== 0,
    levelIdc,
    frameNumBits,
    picOrderCount,
    maxNumRefFrames,
    codedWidth,
    codedHeight,
    crop,
    timing: vui.timing,
    maxNumReorderFrames: vui.maxNumReorderFrames,
    maxDecFrameBuffering: vui.maxDecFrameBuffering,
    hrdPresent: vui.hrdPresent,
    hrdMaximumBitrate: vui.hrdMaximumBitrate,
    hrdMaximumCpbBits: vui.hrdMaximumCpbBits,
    squareSampleAspect: vui.squareSampleAspect,
    color: vui.color
  });
}

export function parsePps(
  nal: AnnexBNalUnit,
  path: string
): ParsedPps {
  const reader = new RbspBitReader(nal.rbsp, path, nal.offset + 1);
  const id = reader.readUnsignedExpGolomb("pic_parameter_set_id", 255);
  const spsId = reader.readUnsignedExpGolomb("seq_parameter_set_id", 31);
  requireH264(
    !reader.readBit("entropy_coding_mode_flag"),
    path,
    "CABAC is forbidden by Constrained Baseline",
    nal.offset + 1 + Math.floor(reader.bitOffset / 8)
  );
  requireH264(
    !reader.readBit("bottom_field_pic_order_in_frame_present_flag"),
    path,
    "bottom-field picture order syntax is forbidden",
    nal.offset + 1 + Math.floor(reader.bitOffset / 8)
  );
  requireH264(
    reader.readUnsignedExpGolomb("num_slice_groups_minus1", 8) === 0,
    path,
    "slice groups/FMO are forbidden",
    nal.offset + 1 + Math.floor(reader.bitOffset / 8)
  );
  const numRefIdxL0DefaultActiveMinus1 = reader.readUnsignedExpGolomb(
    "num_ref_idx_l0_default_active_minus1",
    31
  );
  const numRefIdxL1DefaultActiveMinus1 = reader.readUnsignedExpGolomb(
    "num_ref_idx_l1_default_active_minus1",
    31
  );
  const weightedPrediction = reader.readBit("weighted_pred_flag");
  const weightedBipredIdc = reader.readBits(2, "weighted_bipred_idc");
  requireH264(
    weightedBipredIdc <= 2,
    path,
    "weighted_bipred_idc is reserved",
    nal.offset + 1 + Math.floor(reader.bitOffset / 8)
  );
  requireH264(
    numRefIdxL0DefaultActiveMinus1 === 0 &&
      numRefIdxL1DefaultActiveMinus1 === 0,
    path,
    "Constrained Baseline default reference counts must equal one",
    nal.offset + 1 + Math.floor(reader.bitOffset / 8)
  );
  requireH264(
    !weightedPrediction && weightedBipredIdc === 0,
    path,
    "weighted prediction is forbidden by Constrained Baseline",
    nal.offset + 1 + Math.floor(reader.bitOffset / 8)
  );
  const picInitQpMinus26 = reader.readSignedExpGolomb(
    "pic_init_qp_minus26",
    -26,
    25
  );
  requireH264(
    reader.readSignedExpGolomb("pic_init_qs_minus26", -26, 25) === 0,
    path,
    "pic_init_qs_minus26 must match the frozen encoder profile",
    nal.offset + 1 + Math.floor(reader.bitOffset / 8)
  );
  reader.readSignedExpGolomb(
    "chroma_qp_index_offset",
    -12,
    12
  );
  requireH264(
    reader.readBit("deblocking_filter_control_present_flag"),
    path,
    "deblocking filter control must be present",
    nal.offset + 1 + Math.floor(reader.bitOffset / 8)
  );
  requireH264(
    !reader.readBit("constrained_intra_pred_flag"),
    path,
    "constrained intra prediction is outside the production profile",
    nal.offset + 1 + Math.floor(reader.bitOffset / 8)
  );
  requireH264(
    !reader.readBit("redundant_pic_cnt_present_flag"),
    path,
    "redundant pictures are forbidden",
    nal.offset + 1 + Math.floor(reader.bitOffset / 8)
  );
  requireH264(
    !reader.moreRbspData(),
    path,
    "PPS extension syntax is forbidden by Constrained Baseline",
    nal.offset + 1 + Math.floor(reader.bitOffset / 8)
  );
  reader.readTrailingBits();

  return Object.freeze({
    id,
    spsId,
    payloadSignature: createPayloadSignature(nal.payload),
    picInitQpMinus26
  });
}

function createPayloadSignature(bytes: Uint8Array): string {
  let signature = "";
  for (const byte of bytes) {
    signature += byte.toString(16).padStart(2, "0");
  }
  return signature;
}

function parsePicOrderCount(reader: RbspBitReader): PicOrderCountSyntax {
  const type = reader.readUnsignedExpGolomb("pic_order_cnt_type", 2);
  if (type === 0) {
    return Object.freeze({
      type: 0,
      lsbBits:
        reader.readUnsignedExpGolomb("log2_max_pic_order_cnt_lsb_minus4", 12) + 4
    });
  }
  if (type === 2) {
    return Object.freeze({ type: 2 });
  }

  const deltaPicOrderAlwaysZero = reader.readBit(
    "delta_pic_order_always_zero_flag"
  );
  const offsetForNonRefPic = reader.readSignedExpGolomb("offset_for_non_ref_pic");
  const offsetForTopToBottomField = reader.readSignedExpGolomb(
    "offset_for_top_to_bottom_field"
  );
  const cycleLength = reader.readUnsignedExpGolomb(
    "num_ref_frames_in_pic_order_cnt_cycle",
    255
  );
  const offsetForRefFrame: number[] = [];
  for (let index = 0; index < cycleLength; index += 1) {
    offsetForRefFrame.push(
      reader.readSignedExpGolomb(`offset_for_ref_frame[${String(index)}]`)
    );
  }
  return Object.freeze({
    type: 1,
    deltaPicOrderAlwaysZero,
    offsetForNonRefPic,
    offsetForTopToBottomField,
    offsetForRefFrame: Object.freeze(offsetForRefFrame)
  });
}

function parseVui(
  reader: RbspBitReader,
  maxNumRefFrames: number,
  path: string,
  absoluteOffset: number
): VuiSummary {
  let squareSampleAspect = true;
  if (reader.readBit("aspect_ratio_info_present_flag")) {
    const aspectRatioIdc = reader.readBits(8, "aspect_ratio_idc");
    if (aspectRatioIdc === 255) {
      const sarWidth = reader.readBits(16, "sar_width");
      const sarHeight = reader.readBits(16, "sar_height");
      requireH264(
        sarWidth > 0 && sarHeight > 0,
        path,
        "extended sample aspect ratio must be positive",
        absoluteOffset + Math.floor(reader.bitOffset / 8)
      );
      squareSampleAspect = sarWidth === sarHeight;
    } else {
      requireH264(
        aspectRatioIdc >= 1 && aspectRatioIdc <= 16,
        path,
        "aspect_ratio_idc is reserved",
        absoluteOffset + Math.floor(reader.bitOffset / 8)
      );
      squareSampleAspect = aspectRatioIdc === 1;
    }
  }
  if (reader.readBit("overscan_info_present_flag")) {
    reader.readBit("overscan_appropriate_flag");
  }

  let fullRange = false;
  let colourPrimaries: number | undefined;
  let transferCharacteristics: number | undefined;
  let matrixCoefficients: number | undefined;
  if (reader.readBit("video_signal_type_present_flag")) {
    reader.readBits(3, "video_format");
    fullRange = reader.readBit("video_full_range_flag");
    if (reader.readBit("colour_description_present_flag")) {
      colourPrimaries = reader.readBits(8, "colour_primaries");
      transferCharacteristics = reader.readBits(8, "transfer_characteristics");
      matrixCoefficients = reader.readBits(8, "matrix_coefficients");
    }
  }
  if (reader.readBit("chroma_loc_info_present_flag")) {
    reader.readUnsignedExpGolomb("chroma_sample_loc_type_top_field", 5);
    reader.readUnsignedExpGolomb("chroma_sample_loc_type_bottom_field", 5);
  }

  requireH264(
    reader.readBit("timing_info_present_flag"),
    path,
    "VUI fixed timing is required",
    absoluteOffset + Math.floor(reader.bitOffset / 8)
  );
  const numUnitsInTick = reader.readBits(32, "num_units_in_tick");
  const timeScale = reader.readBits(32, "time_scale");
  requireH264(
    numUnitsInTick > 0 && timeScale > 0,
    path,
    "VUI timing terms must be positive",
    absoluteOffset + Math.floor(reader.bitOffset / 8)
  );
  // libx264 may leave this advisory flag clear for a CFR elementary stream.
  // The compiler proves CFR from source timestamps; the inspector still
  // requires exact VUI timing terms and checks them against that frame clock.
  const fixedFrameRate = reader.readBit("fixed_frame_rate_flag");

  const nalHrd = reader.readBit("nal_hrd_parameters_present_flag")
    ? parseHrd(reader, path, absoluteOffset)
    : undefined;
  const vclHrd = reader.readBit("vcl_hrd_parameters_present_flag")
    ? parseHrd(reader, path, absoluteOffset)
    : undefined;
  if (nalHrd !== undefined || vclHrd !== undefined) {
    reader.readBit("low_delay_hrd_flag");
  }
  reader.readBit("pic_struct_present_flag");

  requireH264(
    reader.readBit("bitstream_restriction_flag"),
    path,
    "VUI bitstream restrictions are required",
    absoluteOffset + Math.floor(reader.bitOffset / 8)
  );
  reader.readBit("motion_vectors_over_pic_boundaries_flag");
  reader.readUnsignedExpGolomb("max_bytes_per_pic_denom", 16);
  reader.readUnsignedExpGolomb("max_bits_per_mb_denom", 16);
  reader.readUnsignedExpGolomb("log2_max_mv_length_horizontal", 32);
  reader.readUnsignedExpGolomb("log2_max_mv_length_vertical", 32);
  const maxNumReorderFrames = reader.readUnsignedExpGolomb(
    "max_num_reorder_frames",
    16
  );
  const maxDecFrameBuffering = reader.readUnsignedExpGolomb(
    "max_dec_frame_buffering",
    16
  );
  requireH264(
    maxDecFrameBuffering >= maxNumRefFrames,
    path,
    "max_dec_frame_buffering is smaller than max_num_ref_frames",
    absoluteOffset + Math.floor(reader.bitOffset / 8)
  );
  requireH264(
    maxNumReorderFrames <= maxDecFrameBuffering,
    path,
    "max_num_reorder_frames exceeds max_dec_frame_buffering",
    absoluteOffset + Math.floor(reader.bitOffset / 8)
  );

  const maximumBitrate = Math.max(
    nalHrd?.maximumBitrate ?? 0,
    vclHrd?.maximumBitrate ?? 0
  );
  const maximumCpbBits = Math.max(
    nalHrd?.maximumCpbBits ?? 0,
    vclHrd?.maximumCpbBits ?? 0
  );
  return Object.freeze({
    timing: Object.freeze({ numUnitsInTick, timeScale, fixedFrameRate }),
    maxNumReorderFrames,
    maxDecFrameBuffering,
    hrdPresent: nalHrd !== undefined || vclHrd !== undefined,
    hrdMaximumBitrate:
      nalHrd === undefined && vclHrd === undefined ? undefined : maximumBitrate,
    hrdMaximumCpbBits:
      nalHrd === undefined && vclHrd === undefined ? undefined : maximumCpbBits,
    squareSampleAspect,
    color: Object.freeze({
      fullRange,
      ...(colourPrimaries === undefined ? {} : { colourPrimaries }),
      ...(transferCharacteristics === undefined ? {} : { transferCharacteristics }),
      ...(matrixCoefficients === undefined ? {} : { matrixCoefficients })
    })
  });
}

function parseHrd(
  reader: RbspBitReader,
  path: string,
  absoluteOffset: number
): HrdSummary {
  const cpbCount = reader.readUnsignedExpGolomb("cpb_cnt_minus1", 31) + 1;
  const bitRateScale = reader.readBits(4, "bit_rate_scale");
  const cpbSizeScale = reader.readBits(4, "cpb_size_scale");
  let maximumBitrate = 0n;
  let maximumCpbBits = 0n;
  for (let index = 0; index < cpbCount; index += 1) {
    const bitRateValue =
      BigInt(reader.readUnsignedExpGolomb(`bit_rate_value_minus1[${String(index)}]`)) +
      1n;
    const cpbSizeValue =
      BigInt(reader.readUnsignedExpGolomb(`cpb_size_value_minus1[${String(index)}]`)) +
      1n;
    const bitrate = bitRateValue << BigInt(6 + bitRateScale);
    const cpbBits = cpbSizeValue << BigInt(4 + cpbSizeScale);
    requireH264(
      bitrate <= MAX_HRD_BITS,
      path,
      "HRD bitrate exceeds the JavaScript safe-integer range",
      absoluteOffset + Math.floor(reader.bitOffset / 8)
    );
    requireH264(
      cpbBits <= MAX_HRD_BITS,
      path,
      "HRD CPB exceeds the JavaScript safe-integer range",
      absoluteOffset + Math.floor(reader.bitOffset / 8)
    );
    if (bitrate > maximumBitrate) {
      maximumBitrate = bitrate;
    }
    if (cpbBits > maximumCpbBits) {
      maximumCpbBits = cpbBits;
    }
    reader.readBit(`cbr_flag[${String(index)}]`);
  }
  reader.readBits(5, "initial_cpb_removal_delay_length_minus1");
  reader.readBits(5, "cpb_removal_delay_length_minus1");
  reader.readBits(5, "dpb_output_delay_length_minus1");
  reader.readBits(5, "time_offset_length");
  return Object.freeze({
    maximumBitrate: Number(maximumBitrate),
    maximumCpbBits: Number(maximumCpbBits)
  });
}
