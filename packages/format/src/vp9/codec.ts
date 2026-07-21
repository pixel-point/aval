import { FormatError } from "../errors.js";

export type Vp9Level =
  | "10" | "11" | "20" | "21" | "30" | "31" | "40"
  | "41" | "50" | "51" | "52" | "60" | "61" | "62";

export type Vp9Codec = `vp09.00.${Vp9Level}.08.01.01.01.01.00`;

interface Vp9LevelLimit {
  readonly level: Vp9Level;
  readonly maximumLumaSampleRate: number;
  readonly maximumLumaPictureSize: number;
  readonly maximumBitrate: number;
  readonly maximumDimension: number;
}

const LEVELS: readonly Vp9LevelLimit[] = Object.freeze([
  { level: "10", maximumLumaSampleRate: 829_440, maximumLumaPictureSize: 36_864, maximumBitrate: 200_000, maximumDimension: 512 },
  { level: "11", maximumLumaSampleRate: 2_764_800, maximumLumaPictureSize: 73_728, maximumBitrate: 800_000, maximumDimension: 768 },
  { level: "20", maximumLumaSampleRate: 4_608_000, maximumLumaPictureSize: 122_880, maximumBitrate: 1_800_000, maximumDimension: 960 },
  { level: "21", maximumLumaSampleRate: 9_216_000, maximumLumaPictureSize: 245_760, maximumBitrate: 3_600_000, maximumDimension: 1_344 },
  { level: "30", maximumLumaSampleRate: 20_736_000, maximumLumaPictureSize: 552_960, maximumBitrate: 7_200_000, maximumDimension: 2_048 },
  { level: "31", maximumLumaSampleRate: 36_864_000, maximumLumaPictureSize: 983_040, maximumBitrate: 12_000_000, maximumDimension: 2_752 },
  { level: "40", maximumLumaSampleRate: 83_558_400, maximumLumaPictureSize: 2_228_224, maximumBitrate: 18_000_000, maximumDimension: 4_160 },
  { level: "41", maximumLumaSampleRate: 160_432_128, maximumLumaPictureSize: 2_228_224, maximumBitrate: 30_000_000, maximumDimension: 4_160 },
  { level: "50", maximumLumaSampleRate: 311_951_360, maximumLumaPictureSize: 8_912_896, maximumBitrate: 60_000_000, maximumDimension: 8_384 },
  { level: "51", maximumLumaSampleRate: 588_251_136, maximumLumaPictureSize: 8_912_896, maximumBitrate: 120_000_000, maximumDimension: 8_384 },
  { level: "52", maximumLumaSampleRate: 1_176_502_272, maximumLumaPictureSize: 8_912_896, maximumBitrate: 180_000_000, maximumDimension: 8_384 },
  { level: "60", maximumLumaSampleRate: 1_176_502_272, maximumLumaPictureSize: 35_651_584, maximumBitrate: 180_000_000, maximumDimension: 16_832 },
  { level: "61", maximumLumaSampleRate: 2_353_004_544, maximumLumaPictureSize: 35_651_584, maximumBitrate: 240_000_000, maximumDimension: 16_832 },
  { level: "62", maximumLumaSampleRate: 4_706_009_088, maximumLumaPictureSize: 35_651_584, maximumBitrate: 480_000_000, maximumDimension: 16_832 }
]);
const VP9_CODEC_PATTERN =
  /^vp09\.00\.(10|11|20|21|30|31|40|41|50|51|52|60|61|62)\.08\.01\.01\.01\.01\.00$/u;

export interface DeriveVp9CodecInput {
  readonly width: number;
  readonly height: number;
  readonly codedFramesPerSecond: number;
  readonly averageBitrate: number;
}

export function deriveVp9Codec(input: Readonly<DeriveVp9CodecInput>): Vp9Codec {
  for (const value of [input.width, input.height, input.codedFramesPerSecond, input.averageBitrate]) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new FormatError("PROFILE_INVALID", "VP9 level inputs must be positive");
    }
  }
  const pictureSize = input.width * input.height;
  const sampleRate = pictureSize * input.codedFramesPerSecond;
  const level = LEVELS.find((candidate) =>
    pictureSize <= candidate.maximumLumaPictureSize &&
    sampleRate <= candidate.maximumLumaSampleRate &&
    input.averageBitrate <= candidate.maximumBitrate &&
    input.width <= candidate.maximumDimension &&
    input.height <= candidate.maximumDimension
  );
  if (level === undefined) {
    throw new FormatError("PROFILE_INVALID", "VP9 stream exceeds level 6.2");
  }
  return `vp09.00.${level.level}.08.01.01.01.01.00`;
}

export function isVp9Codec(value: unknown): value is Vp9Codec {
  return parseVp9Level(value) !== undefined;
}

/** Read the level through the canonical VP9 codec grammar. */
export function parseVp9Level(value: unknown): Vp9Level | undefined {
  if (typeof value !== "string") return undefined;
  return VP9_CODEC_PATTERN.exec(value)?.[1] as Vp9Level | undefined;
}
