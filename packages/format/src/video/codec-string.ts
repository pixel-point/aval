import { isAv1Codec } from "../av1/codec.js";
import { isH264Codec } from "../h264/codec.js";
import { parseH265Codec } from "../h265/codec.js";
import { isVp9Codec } from "../vp9/codec.js";
import type {
  VideoBitDepth,
  VideoBitstream,
  VideoCodec
} from "../model.js";

export const VIDEO_CODECS = Object.freeze([
  "h264",
  "h265",
  "vp9",
  "av1"
] as const satisfies readonly VideoCodec[]);

export const VIDEO_BITSTREAM_BY_CODEC: Readonly<
  Record<VideoCodec, VideoBitstream>
> = Object.freeze({
  h264: "annex-b",
  h265: "annex-b",
  vp9: "frame",
  av1: "low-overhead"
});

export type ParsedVideoCodecString =
  | { readonly family: "h264"; readonly bitDepth: 8 }
  | { readonly family: "h265"; readonly bitDepth: 8 }
  | { readonly family: "vp9"; readonly bitDepth: 8 }
  | { readonly family: "av1"; readonly bitDepth: 8 | 10 };

/** Parse one canonical WebCodecs codec string supported by the AVAL format. */
export function parseVideoCodecString(
  value: string
): Readonly<ParsedVideoCodecString> | undefined {
  if (isH264Codec(value)) {
    return Object.freeze({ family: "h264", bitDepth: 8 });
  }

  const h265 = parseH265Codec(value);
  if (h265 !== undefined) {
    return Object.freeze({ family: "h265", bitDepth: h265.bitDepth });
  }

  if (isVp9Codec(value)) {
    return Object.freeze({ family: "vp9", bitDepth: 8 });
  }

  if (isAv1Codec(value)) {
    const bitDepthTerm = value.split(".")[3];
    return Object.freeze({
      family: "av1",
      bitDepth: bitDepthTerm === "10" ? 10 : 8
    });
  }

  return undefined;
}

export function isVideoCodecString(
  value: unknown,
  family: VideoCodec,
  bitDepth: VideoBitDepth
): value is string {
  if (typeof value !== "string") return false;
  const parsed = parseVideoCodecString(value);
  return parsed?.family === family && parsed.bitDepth === bitDepth;
}
