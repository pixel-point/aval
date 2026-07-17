import { FormatError } from "../errors.js";
import { maximumH264DecodedRgbaBytes } from "../h264/decoder-surface.js";
import type { VideoCodec } from "../model.js";

/** Worst-case RGBA allocation for one browser-decoder surface. */
export function maximumDecodedRgbaBytes(
  codec: VideoCodec,
  codedWidth: number,
  codedHeight: number
): number {
  if (codec === "h264") {
    return maximumH264DecodedRgbaBytes(codedWidth, codedHeight);
  }
  if (codec !== "h265" && codec !== "vp9" && codec !== "av1") {
    throw new FormatError("INPUT_INVALID", "video codec is unsupported");
  }
  if (
    !Number.isSafeInteger(codedWidth) ||
    !Number.isSafeInteger(codedHeight) ||
    codedWidth < 1 ||
    codedHeight < 1
  ) {
    throw new FormatError(
      "INPUT_INVALID",
      "decoder surface dimensions must be positive safe integers"
    );
  }
  return checkedMultiply(checkedMultiply(codedWidth, codedHeight), 4);
}

function checkedMultiply(left: number, right: number): number {
  if (left !== 0 && right > Math.floor(Number.MAX_SAFE_INTEGER / left)) {
    throw new FormatError(
      "INPUT_INVALID",
      "decoded RGBA byte size exceeds the safe-integer range"
    );
  }
  return left * right;
}
