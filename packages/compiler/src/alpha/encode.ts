import type { AlphaEncoding } from "./types.js";
import type { prepareAlphaFrames } from "./frames.js";
import { videoCompressionArguments } from "../compile/video-encoding-policy.js";

export function alphaEncoder(encoding: Required<AlphaEncoding>): string {
  return encoding.codec === "av1" ? encoding.encoder : { vp9: "libvpx-vp9", h265: "libx265", h264: "libx264" }[encoding.codec];
}

export function alphaEncodeArguments(input: Awaited<ReturnType<typeof prepareAlphaFrames>>, encoding: Required<AlphaEncoding>, output: string): string[] {
  const { codec, crf, preset, threads, bitDepth, gop, cpuUsed, deadline, encoder, x265 } = encoding;
  const x265Names = { aqMode: "aq-mode", aqStrength: "aq-strength", psyRd: "psy-rd", psyRdoq: "psy-rdoq", rd: "rd",
    rdoqLevel: "rdoq-level", lookahead: "rc-lookahead", bframes: "bframes", ref: "ref", sao: "sao" };
  const x265Params = Object.entries(x265).map(([key, value]) => `${x265Names[key as keyof typeof x265Names]}=${typeof value === "boolean" ? Number(value) : value}`).join(":");
  let compression: readonly string[];
  if (codec === "av1" && encoder === "libsvtav1") compression = ["-crf", String(crf), "-preset", preset, "-svtav1-params", `lp=${threads}:color-primaries=1:transfer-characteristics=1:matrix-coefficients=1`];
  else if (codec === "av1") compression = videoCompressionArguments({ codec, bitDepth, cpuUsed, threads, tiles: { columns: 1, rows: 1 }, rowMt: true }, { crf });
  else if (codec === "vp9") compression = videoCompressionArguments({ codec, cpuUsed, deadline, threads }, { crf });
  else compression = videoCompressionArguments({ codec, preset, threads }, { crf });
  return ["-nostdin", "-v", "error", "-n", "-f", "rawvideo", "-pixel_format", bitDepth === 10 ? "yuv420p10le" : "yuv420p",
    "-video_size", `${input.geometry.codedWidth}x${input.geometry.codedHeight}`, "-framerate", String(input.fps),
    "-i", input.paths.get(bitDepth)!, "-an", "-sn", "-dn", "-frames:v", String(input.frames),
    // The spool already contains BT.709 limited YUV. Tag before negotiation so
    // FFmpeg cannot reinterpret untagged raw samples through a different matrix.
    "-vf", "setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
    "-c:v", alphaEncoder(encoding),
    ...compression, "-pix_fmt", bitDepth === 10 ? "yuv420p10le" : "yuv420p", "-threads", String(threads),
    "-g", String(Math.max(1, Math.round(input.fps * gop))),
    "-color_range", "tv", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
    ...(codec === "h265" ? ["-tag:v", "hvc1", "-x265-params", `log-level=error:pools=${threads}${x265Params ? ":" + x265Params : ""}`] : []),
    ...(codec === "av1" && encoder === "libaom-av1" ? ["-aom-params", "color-primaries=1:transfer-characteristics=1:matrix-coefficients=1"] : []),
    ...(codec !== "vp9" ? ["-movflags", "+faststart"] : []), output];
}
