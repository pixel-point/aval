import { createWriteStream } from "node:fs";
import { deriveVp9Codec, h265CodecString } from "@pixel-point/aval-format";
import { CompilerError } from "../diagnostics.js";
import { runBoundedProcess } from "../process-runner.js";
import type { ResolvedAlphaOptions, AlphaCodec } from "./types.js";

export interface VideoProbe {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly duration: number;
  readonly pixelFormat: string;
  readonly codec: string;
  readonly alphaMode: boolean;
  readonly extra: Uint8Array;
}

export async function mediaTool(options: ResolvedAlphaOptions, executable: string, args: readonly string[], output?: string) {
  return runBoundedProcess({
    executable, arguments: args, cwd: process.cwd(),
    limits: { maxStdoutBytes: output ? Number.MAX_SAFE_INTEGER : 16 * 1024 * 1024, maxStderrBytes: 4 * 1024 * 1024,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) },
    ...(output ? { stdoutSink: createWriteStream(output, { flags: "wx" }) } : {}),
    ...(options.signal ? { signal: options.signal } : {})
  });
}

export async function probeVideo(path: string, options: ResolvedAlphaOptions): Promise<VideoProbe> {
  const result = await mediaTool(options, options.ffprobe, [
    "-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "v:0", "-show_entries",
    "stream=width,height,avg_frame_rate,r_frame_rate,pix_fmt,codec_name,extradata,color_transfer,sample_aspect_ratio:stream_tags=alpha_mode:stream_side_data=rotation:format=duration", "-show_data", "-of", "json", path
  ]);
  const json = JSON.parse(new TextDecoder().decode(result.stdout)) as {
    streams?: Array<Record<string, unknown>>; format?: { duration?: string }
  };
  const stream = json.streams?.[0];
  if (!stream || typeof stream.width !== "number" || typeof stream.height !== "number") throw invalid("Input has no video stream");
  if (stream.color_transfer === "smpte2084" || stream.color_transfer === "arib-std-b67") throw invalid("HDR input requires SDR conversion before alpha compilation");
  const sar = stream.sample_aspect_ratio;
  if (sar && sar !== "1:1" && sar !== "N/A" && sar !== "0:1") throw invalid("Input must have square pixels");
  const rotation = stream.side_data_list as Array<{ rotation?: number }> | undefined;
  if (rotation?.some((s) => s.rotation)) throw invalid("Normalize input rotation before compiling");
  const rational = (v: unknown) => {
    const [n, d = 1] = String(v).split("/").map(Number);
    return n! / d;
  };
  const avg = rational(stream.avg_frame_rate);
  const nominal = rational(stream.r_frame_rate);
  if (Number.isFinite(avg) && avg > 0 && Number.isFinite(nominal) && nominal > 0 &&
    Math.abs(avg - nominal) > 0.001 && options.fps === undefined) throw invalid("Variable-rate input requires an explicit fps");
  const extra = String(stream.extradata ?? "").split("\n").map((line) => {
    const hex = line.split(":")[1]?.trimStart().split(/\s{2,}/u)[0] ?? "";
    return hex.replace(/\s/gu, "");
  }).join("");
  return { width: stream.width, height: stream.height, fps: avg || nominal,
    duration: Number(json.format?.duration), pixelFormat: String(stream.pix_fmt), codec: String(stream.codec_name),
    alphaMode: Object.entries((stream.tags ?? {}) as Record<string, unknown>).some(([key, value]) => key.toLowerCase() === "alpha_mode" && String(value) === "1"),
    extra: Buffer.from(extra, "hex") };
}

/** Read codec declarations from the muxed configuration, never from a filename. */
export function codecType(codec: AlphaCodec, probe: VideoProbe, fps: number, frames: number, bytes: number): string {
  const b = probe.extra;
  let name: string;
  if (codec === "h264") {
    if (b.length < 4 || b[0] !== 1) throw invalid("Missing AVC configuration record");
    name = `avc1.${Buffer.from(b.slice(1, 4)).toString("hex")}`;
  } else if (codec === "h265") {
    if (b.length < 23 || b[0] !== 1) throw invalid("Missing HEVC configuration record");
    let flags = 0;
    for (let bit = 0; bit < 32; bit++) if ((b[2 + (bit >> 3)]! & (128 >> (bit & 7))) !== 0) flags += 2 ** bit;
    name = h265CodecString({ profileSpace: (b[1]! >> 6) as 0 | 1 | 2 | 3, tierFlag: !!(b[1]! & 32),
      profileIdc: b[1]! & 31, profileCompatibilityFlags: flags,
      constraintIndicatorFlags: [...b.slice(6, 12)], levelIdc: b[12]! });
  } else if (codec === "av1") {
    if (b.length < 4 || b[0] !== 0x81) throw invalid("Missing AV1 configuration record");
    name = `av01.${b[1]! >> 5}.${String(b[1]! & 31).padStart(2, "0")}${b[2]! & 128 ? "H" : "M"}.${b[2]! & 64 ? b[2]! & 32 ? "12" : "10" : "08"}`;
  } else {
    name = deriveVp9Codec({ width: probe.width, height: probe.height, codedFramesPerSecond: fps,
      averageBitrate: Math.max(1, bytes * 8 * fps / frames) });
  }
  return `video/${codec === "vp9" ? "webm" : "mp4"}; codecs="${name}"`;
}
function invalid(message: string): CompilerError { return new CompilerError("INPUT_INVALID", message); }
