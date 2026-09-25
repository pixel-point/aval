import { CompilerError } from "../diagnostics.js";
import { H265_ENCODER_PRESETS } from "../model.js";
import type { AlphaCompileOptions, AlphaEncoding, ResolvedAlphaOptions } from "./types.js";

export function resolveAlphaOptions(options: AlphaCompileOptions): ResolvedAlphaOptions {
  if (!options || typeof options.out !== "string" || !options.out) invalid("out is required");
  keys(options, ["out", "encodings", "fps", "width", "height", "layout", "startNumber", "frames", "premultiplied", "ffmpeg", "ffprobe", "timeoutMs", "signal", "baseUrl", "optimize"]);
  if (options.layout !== undefined && !["auto", "vertical", "horizontal"].includes(options.layout)) invalid("Unknown packing layout");
  for (const key of ["fps", "width", "height", "frames", "timeoutMs"] as const) {
    if (options[key] !== undefined) finite(options[key], key, key === "fps" ? 0.001 : 1, Number.MAX_SAFE_INTEGER, key !== "fps");
  }
  if (options.startNumber !== undefined) finite(options.startNumber, "startNumber", 0, Number.MAX_SAFE_INTEGER, true);
  if (options.premultiplied !== undefined && typeof options.premultiplied !== "boolean") invalid("premultiplied must be boolean");
  for (const key of ["ffmpeg", "ffprobe", "baseUrl"] as const) {
    if (options[key] !== undefined && (typeof options[key] !== "string" || options[key].includes("\0"))) invalid(`${key} must be a string without NUL`);
  }
  const encodings = options.encodings === undefined ? [{ codec: "av1" }, { codec: "vp9" }, { codec: "h265" }, { codec: "h264" }] as const : options.encodings;
  if (!Array.isArray(encodings) || encodings.length < 1 || encodings.length > 4) invalid("encodings must contain one to four codecs");
  const resolved = Array.from(encodings, resolveEncoding);
  if (new Set(resolved.map((e) => e.codec)).size !== resolved.length) invalid("Duplicate codec");
  if (options.optimize !== undefined) {
    keys(options.optimize, ["crfs", "maxAlphaMae", "maxCompositeMae", "presets"]);
    const { crfs, maxAlphaMae, maxCompositeMae } = options.optimize;
    if (!Array.isArray(crfs) || crfs.length < 1 || crfs.length > 32) invalid("optimize.crfs needs 1–32 values");
    for (const crf of crfs) for (const encoding of resolved) validateCrf(crf, encoding.codec);
    finite(maxAlphaMae, "maxAlphaMae", 0, 255);
    finite(maxCompositeMae, "maxCompositeMae", 0, 255);
    if (options.optimize.presets !== undefined) {
      keys(options.optimize.presets, resolved.map((e) => e.codec));
      for (const encoding of resolved) {
        const presets = options.optimize.presets[encoding.codec];
        if (presets === undefined) continue;
        if (!Array.isArray(presets) || !presets.length || presets.length * crfs.length > 64) invalid("At most 64 CRF/preset combinations per codec");
        const authored = encodings.find((entry) => entry.codec === encoding.codec)!;
        for (const preset of presets) resolveEncoding({ ...authored, preset });
      }
    }
  }
  const optimize = options.optimize;
  return {
    ...options, encodings: resolved, ffmpeg: options.ffmpeg ?? "ffmpeg", ffprobe: options.ffprobe ?? "ffprobe",
    ...(optimize === undefined ? {} : { optimize: {
      ...optimize, crfs: [...optimize.crfs],
      ...(optimize.presets === undefined ? {} : { presets: Object.fromEntries(
        Object.entries(optimize.presets).map(([codec, presets]) => [codec, presets === undefined ? undefined : [...presets]])
      ) })
    } })
  };
}

function resolveEncoding(encoding: AlphaEncoding): Required<AlphaEncoding> {
  keys(encoding, ["codec", "crf", "preset", "encoder", "cpuUsed", "deadline", "threads", "bitDepth", "gop", "x265"]);
  if (!["av1", "vp9", "h265", "h264"].includes(encoding.codec)) invalid("Unknown codec");
  const codec = encoding.codec;
  if (codec !== "av1" && encoding.encoder !== undefined) invalid("encoder is an AV1 option");
  const encoder = encoding.encoder ?? "libsvtav1";
  if (!["libsvtav1", "libaom-av1"].includes(encoder)) invalid("Unknown AV1 encoder");
  const preset = encoding.preset ?? (codec === "av1" ? "6" : "slow");
  if (typeof preset !== "string") invalid("preset must be a string");
  if (encoding.preset !== undefined && (codec === "vp9" || codec === "av1" && encoder === "libaom-av1")) invalid("This encoder uses cpuUsed instead of preset");
  if (codec === "h264" || codec === "h265") {
    if (!(H265_ENCODER_PRESETS as readonly string[]).includes(preset)) invalid("Invalid compression preset");
  } else if (codec === "av1" && encoder === "libsvtav1") {
    if (!/^(?:[0-9]|1[0-3])$/u.test(preset)) invalid("SVT-AV1 preset must be 0–13");
  }
  if (encoding.cpuUsed !== undefined && (codec === "h264" || codec === "h265" || codec === "av1" && encoder === "libsvtav1")) invalid("cpuUsed is only supported by VP9/libaom");
  if (encoding.deadline !== undefined && codec !== "vp9") invalid("deadline is a VP9 option");
  const bitDepth = encoding.bitDepth ?? 8;
  if (bitDepth !== 8 && bitDepth !== 10 || bitDepth === 10 && (codec === "vp9" || codec === "h264")) invalid("10-bit is available for AV1 and HEVC only");
  const deadline = encoding.deadline ?? "good";
  if (deadline !== "good" && deadline !== "best") invalid("Invalid VP9 deadline");
  const crf = encoding.crf ?? (codec === "av1" ? 32 : codec === "vp9" ? 30 : 23);
  validateCrf(crf, codec);
  const x265 = encoding.x265 === undefined ? {} : encoding.x265;
  if (encoding.x265 !== undefined && codec !== "h265") invalid("x265 controls require h265");
  keys(x265, ["aqMode", "aqStrength", "psyRd", "psyRdoq", "rd", "rdoqLevel", "lookahead", "bframes", "ref", "sao"]);
  const ranges = { aqMode: [0, 4, true], aqStrength: [0, 3, false], psyRd: [0, 5, false], psyRdoq: [0, 50, false],
    rd: [0, 6, true], rdoqLevel: [0, 2, true], lookahead: [0, 250, true], bframes: [0, 16, true], ref: [1, 16, true] } as const;
  for (const key of Object.keys(ranges) as (keyof typeof ranges)[]) {
    const [min, max, integer] = ranges[key];
    if (x265[key] !== undefined) finite(x265[key], key, min, max, integer);
  }
  if (x265.sao !== undefined && typeof x265.sao !== "boolean") invalid("sao must be boolean");
  return { codec, crf, preset, encoder, deadline, bitDepth,
    x265: { ...x265 },
    cpuUsed: finite(encoding.cpuUsed ?? 2, "cpuUsed", 0, codec === "vp9" ? 5 : 8, true),
    threads: finite(encoding.threads ?? 4, "threads", 1, 64, true),
    gop: finite(encoding.gop ?? 2, "gop", 0.01, 60) };
}
function validateCrf(crf: number, codec: string) { const integer = codec === "av1" || codec === "vp9"; finite(crf, "crf", 0, integer ? 63 : 51, integer); }
function finite(value: number, key: string, min: number, max: number, integer = false): number {
  if (!Number.isFinite(value) || value < min || value > max || integer && !Number.isSafeInteger(value)) invalid(`Invalid ${key}`);
  return value;
}
function keys(value: object, allowed: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Expected an options object");
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`Unknown option ${key}`);
}
function invalid(message: string): never { throw new CompilerError("INPUT_INVALID", message); }
