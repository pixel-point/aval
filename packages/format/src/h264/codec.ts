import { FormatError } from "../errors.js";

export type H264LevelIdc =
  | 10 | 11 | 12 | 13
  | 20 | 21 | 22
  | 30 | 31 | 32
  | 40 | 41 | 42
  | 50 | 51 | 52
  | 60 | 61 | 62;

export type H264ConstrainedBaselineCodec =
  | "avc1.42E00A" | "avc1.42E00B" | "avc1.42E00C" | "avc1.42E00D"
  | "avc1.42E014" | "avc1.42E015" | "avc1.42E016"
  | "avc1.42E01E" | "avc1.42E01F" | "avc1.42E020"
  | "avc1.42E028" | "avc1.42E029" | "avc1.42E02A"
  | "avc1.42E032" | "avc1.42E033" | "avc1.42E034"
  | "avc1.42E03C" | "avc1.42E03D" | "avc1.42E03E";

export type H264Codec = H264ConstrainedBaselineCodec;

/** Level geometry plus Constrained Baseline MaxBR/MaxCPB production limits. */
export interface H264LevelLimits {
  readonly levelIdc: H264LevelIdc;
  readonly codec: H264ConstrainedBaselineCodec;
  readonly maximumMacroblocksPerSecond: number;
  readonly maximumMacroblocksPerFrame: number;
  readonly maximumMacroblockDimension: number;
  readonly maximumDpbMacroblocks: number;
  readonly maximumBitrate: number;
  readonly maximumCpbBits: number;
}

export interface ParsedH264Codec extends Omit<H264LevelLimits, "codec"> {
  readonly codec: H264Codec;
  readonly profile: "constrained-baseline";
  readonly profileIdc: 66;
  /** Exact RFC 6381 profile_compatibility byte. */
  readonly profileCompatibility: 0xe0;
}

export interface H264CompatibilityLevelInput {
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly frameRate: {
    readonly numerator: number;
    readonly denominator: number;
  };
  /** Maximum encoder bitrate that the selected level must admit, in bits/s. */
  readonly maximumBitrate: number;
  /** Maximum coded-picture-buffer size that the selected level must admit. */
  readonly maximumCpbBits: number;
}

const LEVEL_ROWS = Object.freeze([
  [10, "avc1.42E00A", 1_485, 99, 396, 64_000, 175_000],
  [11, "avc1.42E00B", 3_000, 396, 900, 192_000, 500_000],
  [12, "avc1.42E00C", 6_000, 396, 2_376, 384_000, 1_000_000],
  [13, "avc1.42E00D", 11_880, 396, 2_376, 768_000, 2_000_000],
  [20, "avc1.42E014", 11_880, 396, 2_376, 2_000_000, 2_000_000],
  [21, "avc1.42E015", 19_800, 792, 4_752, 4_000_000, 4_000_000],
  [22, "avc1.42E016", 20_250, 1_620, 8_100, 4_000_000, 4_000_000],
  [30, "avc1.42E01E", 40_500, 1_620, 8_100, 10_000_000, 10_000_000],
  [31, "avc1.42E01F", 108_000, 3_600, 18_000, 14_000_000, 14_000_000],
  [32, "avc1.42E020", 216_000, 5_120, 20_480, 20_000_000, 20_000_000],
  [40, "avc1.42E028", 245_760, 8_192, 32_768, 20_000_000, 25_000_000],
  [41, "avc1.42E029", 245_760, 8_192, 32_768, 50_000_000, 62_500_000],
  [42, "avc1.42E02A", 522_240, 8_704, 34_816, 50_000_000, 62_500_000],
  [50, "avc1.42E032", 589_824, 22_080, 110_400, 135_000_000, 135_000_000],
  [51, "avc1.42E033", 983_040, 36_864, 184_320, 240_000_000, 240_000_000],
  [52, "avc1.42E034", 2_073_600, 36_864, 184_320, 240_000_000, 240_000_000],
  [60, "avc1.42E03C", 4_177_920, 139_264, 696_320, 240_000_000, 240_000_000],
  [61, "avc1.42E03D", 8_355_840, 139_264, 696_320, 480_000_000, 480_000_000],
  [62, "avc1.42E03E", 16_711_680, 139_264, 696_320, 800_000_000, 800_000_000]
] as const);

/** Every exact H.264 codec admitted by the current Constrained Baseline profile. */
export const H264_CONSTRAINED_BASELINE_CODECS:
  readonly H264ConstrainedBaselineCodec[] = Object.freeze(
    LEVEL_ROWS.map((row) => row[1])
  );

const LEVELS = new Map<number, H264LevelLimits>(LEVEL_ROWS.map((row) => [
  row[0],
  Object.freeze({
    levelIdc: row[0],
    codec: row[1],
    maximumMacroblocksPerSecond: row[2],
    maximumMacroblocksPerFrame: row[3],
    maximumMacroblockDimension: Math.floor(Math.sqrt(row[3] * 8)),
    maximumDpbMacroblocks: row[4],
    maximumBitrate: row[5],
    maximumCpbBits: row[6]
  })
]));

const CODECS = new Map<string, ParsedH264Codec>();
for (const limits of LEVELS.values()) {
  CODECS.set(limits.codec, Object.freeze({
    ...limits,
    codec: limits.codec,
    profile: "constrained-baseline",
    profileIdc: 66,
    profileCompatibility: 0xe0
  }));
}

export function isH264LevelIdc(value: number): value is H264LevelIdc {
  return LEVELS.has(value);
}

/** Return the Constrained Baseline production limits for one level. */
export function h264LevelLimits(levelIdc: number): Readonly<H264LevelLimits> {
  const limits = LEVELS.get(levelIdc);
  if (limits === undefined) {
    throw new FormatError("PROFILE_INVALID", "H264 level_idc is unsupported");
  }
  return limits;
}

export function h264CodecForLevel(levelIdc: number): H264ConstrainedBaselineCodec {
  return h264LevelLimits(levelIdc).codec;
}

export function h264LevelName(levelIdc: number): string {
  h264LevelLimits(levelIdc);
  return `${String(Math.floor(levelIdc / 10))}.${String(levelIdc % 10)}`;
}

/** Select the lowest practical constrained-baseline level for one rendition. */
export function minimumH264CompatibilityLevel(
  input: Readonly<H264CompatibilityLevelInput>
): H264LevelIdc {
  const {
    codedWidth,
    codedHeight,
    frameRate,
    maximumBitrate,
    maximumCpbBits
  } = input;
  if (
    !Number.isSafeInteger(codedWidth) ||
    !Number.isSafeInteger(codedHeight) ||
    codedWidth < 16 ||
    codedHeight < 16 ||
    codedWidth % 16 !== 0 ||
    codedHeight % 16 !== 0 ||
    !Number.isSafeInteger(frameRate?.numerator) ||
    !Number.isSafeInteger(frameRate?.denominator) ||
    frameRate.numerator < 1 ||
    frameRate.denominator < 1 ||
    !Number.isSafeInteger(maximumBitrate) ||
    maximumBitrate < 1 ||
    !Number.isSafeInteger(maximumCpbBits) ||
    maximumCpbBits < 1
  ) {
    throw new FormatError(
      "PROFILE_INVALID",
      "H264 compatibility geometry and frame rate are invalid"
    );
  }
  const widthInMacroblocks = codedWidth / 16;
  const heightInMacroblocks = codedHeight / 16;
  const macroblocksPerFrame = widthInMacroblocks * heightInMacroblocks;
  if (!Number.isSafeInteger(macroblocksPerFrame)) {
    throw new FormatError("PROFILE_INVALID", "H264 macroblock count is not representable");
  }
  for (const limits of LEVELS.values()) {
    // Level 1.0's 64 kbps ceiling is not practical for independently encoded
    // interactive units. Level 1b is deliberately outside the canonical set.
    if (limits.levelIdc < 11) continue;
    if (
      widthInMacroblocks <= limits.maximumMacroblockDimension &&
      heightInMacroblocks <= limits.maximumMacroblockDimension &&
      macroblocksPerFrame <= limits.maximumMacroblocksPerFrame &&
      BigInt(macroblocksPerFrame) * BigInt(frameRate.numerator) <=
        BigInt(limits.maximumMacroblocksPerSecond) *
          BigInt(frameRate.denominator) &&
      Math.floor(limits.maximumDpbMacroblocks / macroblocksPerFrame) >= 1 &&
      maximumBitrate <= limits.maximumBitrate &&
      maximumCpbBits <= limits.maximumCpbBits
    ) {
      return limits.levelIdc;
    }
  }
  throw new FormatError(
    "PROFILE_INVALID",
    "H264 compatibility rendition exceeds the supported level table"
  );
}

export function parseH264Codec(codec: unknown): Readonly<ParsedH264Codec> {
  const limits = typeof codec === "string" ? CODECS.get(codec) : undefined;
  if (limits === undefined) {
    throw new FormatError(
      "PROFILE_INVALID",
      "H264 codec must identify a supported constrained-baseline level"
    );
  }
  return limits;
}

export function isH264Codec(codec: unknown): codec is H264Codec {
  return typeof codec === "string" && CODECS.has(codec);
}
