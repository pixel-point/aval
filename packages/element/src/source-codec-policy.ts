import type { AvalSourceCodec } from "./public-types.js";

/** AVAL runtime source preference, from most to least preferred. */
export const SOURCE_CODEC_PRIORITY = Object.freeze([
  "av1",
  "vp9",
  "h265",
  "h264"
] as const satisfies readonly AvalSourceCodec[]);

export function sourceCodec(value: unknown): AvalSourceCodec | undefined {
  return typeof value === "string" &&
    (SOURCE_CODEC_PRIORITY as readonly string[]).includes(value)
    ? value as AvalSourceCodec
    : undefined;
}

export function compareSourceCodec(
  left: AvalSourceCodec,
  right: AvalSourceCodec
): number {
  return SOURCE_CODEC_PRIORITY.indexOf(left) -
    SOURCE_CODEC_PRIORITY.indexOf(right);
}
