import { isAbsolute } from "node:path";

import { CompilerError } from "./diagnostics.js";
import {
  H264_ENCODER_PRESETS,
  H265_ENCODER_PRESETS,
  VP9_DEADLINES,
  type H264EncoderPreset,
  type H265EncoderPreset,
  type Rational,
  type SourceAlphaPolicy,
  type Vp9Deadline
} from "./model.js";

interface CliBaseArguments {
  readonly json: boolean;
}

interface CompileCliBaseArguments extends CliBaseArguments {
  readonly command: "compile";
  readonly input: string;
  readonly output: string;
  readonly loop?: readonly [number, number];
  readonly fps?: Rational;
  readonly canvas?: readonly [number, number];
  readonly alpha?: SourceAlphaPolicy;
  readonly frames?: { readonly firstNumber: number; readonly frameCount: number };
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly mediaTimeoutMs?: number;
  readonly normalizeVfr: boolean;
  readonly force: boolean;
}

interface H264CompileCodecArguments {
  readonly codec: "h264";
  readonly crf?: number;
  readonly preset?: H264EncoderPreset;
  readonly deadline?: never;
  readonly cpuUsed?: never;
  readonly bitDepth?: never;
  readonly tiles?: never;
  readonly rowMt?: never;
  readonly threads?: never;
}

interface H265CompileCodecArguments {
  readonly codec: "h265";
  readonly crf?: number;
  readonly preset?: H265EncoderPreset;
  readonly threads?: number;
  readonly deadline?: never;
  readonly cpuUsed?: never;
  readonly bitDepth?: never;
  readonly tiles?: never;
  readonly rowMt?: never;
}

interface Vp9CompileCodecArguments {
  readonly codec: "vp9";
  readonly crf?: number;
  readonly deadline?: Vp9Deadline;
  readonly cpuUsed?: number;
  readonly threads?: number;
  readonly preset?: never;
  readonly bitDepth?: never;
  readonly tiles?: never;
  readonly rowMt?: never;
}

interface Av1CompileCodecArguments {
  readonly codec: "av1";
  readonly crf?: number;
  readonly bitDepth?: 8 | 10;
  readonly cpuUsed?: number;
  readonly tiles?: Readonly<{ readonly columns: number; readonly rows: number }>;
  readonly rowMt: boolean;
  readonly threads?: number;
  readonly preset?: never;
  readonly deadline?: never;
}

interface ProjectCompileCodecArguments {
  readonly codec?: never;
  readonly crf?: never;
  readonly preset?: never;
  readonly deadline?: never;
  readonly cpuUsed?: never;
  readonly bitDepth?: never;
  readonly tiles?: never;
  readonly rowMt?: never;
  readonly threads?: never;
}

type DirectCompileCodecArguments =
  | H264CompileCodecArguments
  | H265CompileCodecArguments
  | Vp9CompileCodecArguments
  | Av1CompileCodecArguments;

export type CompileCliArguments = CompileCliBaseArguments & (
  | H264CompileCodecArguments
  | H265CompileCodecArguments
  | Vp9CompileCodecArguments
  | Av1CompileCodecArguments
  | ProjectCompileCodecArguments
);

export interface InspectCliArguments extends CliBaseArguments {
  readonly command: "inspect";
  readonly input: string;
}

export interface ValidateCliArguments extends CliBaseArguments {
  readonly command: "validate";
  readonly input: string;
}

export interface UnpackCliArguments extends CliBaseArguments {
  readonly command: "unpack";
  readonly input: string;
  readonly output: string;
}

export interface InitCliArguments extends CliBaseArguments {
  readonly command: "init";
  readonly directory: string;
}

export interface DevCliArguments extends CliBaseArguments {
  readonly command: "dev";
  readonly project: string;
  readonly output: string;
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly mediaTimeoutMs?: number;
  readonly force: boolean;
  readonly port?: number;
  readonly open?: boolean;
}

export interface HelpCliArguments {
  readonly command: "help";
}

export type CliArguments =
  | CompileCliArguments
  | InspectCliArguments
  | ValidateCliArguments
  | UnpackCliArguments
  | InitCliArguments
  | DevCliArguments
  | HelpCliArguments;

const VALUE_FLAGS = new Set([
  "--out",
  "--loop",
  "--fps",
  "--canvas",
  "--codec",
  "--crf",
  "--preset",
  "--deadline",
  "--cpu-used",
  "--bit-depth",
  "--tiles",
  "--threads",
  "--alpha",
  "--frames",
  "--ffmpeg",
  "--ffprobe",
  "--media-timeout-ms",
  "--port"
]);

const BOOLEAN_FLAGS = new Set([
  "--json",
  "--force",
  "--normalize-vfr",
  "--row-mt",
  "--open"
]);

interface RawCommand {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, string>;
  readonly booleans: ReadonlySet<string>;
}

/** Parse the closed, noninteractive launch command grammar without reading IO. */
export function parseCliArguments(argv: readonly string[]): CliArguments {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help") {
    return Object.freeze({ command: "help" });
  }
  const command = argv[0];
  if (
    command !== "compile" &&
    command !== "inspect" &&
    command !== "validate" &&
    command !== "unpack" &&
    command !== "init" &&
    command !== "dev"
  ) {
    usage(`Unknown command ${safeToken(command)}`);
  }
  const raw = parseRaw(argv.slice(1));
  if (raw.booleans.has("--help")) {
    return Object.freeze({ command: "help" });
  }
  switch (command) {
    case "compile":
      return parseCompile(raw);
    case "inspect":
      return parseOneInput(command, raw);
    case "validate":
      return parseOneInput(command, raw);
    case "unpack":
      return parseUnpack(raw);
    case "init":
      return parseInit(raw);
    case "dev":
      return parseDev(raw);
  }
}

function parseRaw(tokens: readonly string[]): RawCommand {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  let positionalOnly = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!positionalOnly && token === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && token.startsWith("--")) {
      if (token.includes("=")) {
        usage(`Flag values must be separate arguments: ${safeToken(token)}`);
      }
      if (VALUE_FLAGS.has(token)) {
        rejectDuplicate(token, values, booleans);
        const value = tokens[index + 1];
        if (value === undefined || value === "--" || value.startsWith("--")) {
          usage(`${token} requires a value`);
        }
        values.set(token, value);
        index += 1;
        continue;
      }
      if (BOOLEAN_FLAGS.has(token) || token === "--help") {
        rejectDuplicate(token, values, booleans);
        booleans.add(token);
        continue;
      }
      usage(`Unknown flag ${safeToken(token)}`);
    }
    positionals.push(pathToken(token, "positional path"));
  }
  return Object.freeze({
    positionals: Object.freeze(positionals),
    values,
    booleans
  });
}

function parseCompile(raw: RawCommand): CompileCliArguments {
  allowFlags(raw, [
    "--out", "--loop", "--fps", "--canvas", "--codec",
    "--crf", "--preset", "--deadline", "--cpu-used", "--bit-depth",
    "--tiles", "--threads", "--row-mt", "--alpha", "--frames", "--ffmpeg",
    "--ffprobe", "--media-timeout-ms", "--json", "--force", "--normalize-vfr"
  ]);
  const input = onePositional(raw, "compile");
  const output = requiredValue(raw, "--out");
  const direct = !input.toLowerCase().endsWith(".json");
  const pngPattern = direct && input.includes("%");
  if (direct && !raw.values.has("--loop")) {
    usage("Direct compile requires --loop <start:end>");
  }
  if (!direct) {
    for (const flag of [
      "--loop", "--fps", "--canvas", "--codec", "--crf", "--preset",
      "--deadline", "--cpu-used", "--bit-depth", "--tiles", "--threads",
      "--row-mt", "--alpha", "--frames", "--normalize-vfr"
    ]) {
      if (raw.values.has(flag) || raw.booleans.has(flag)) {
        usage(`${flag} is valid only for direct media input`);
      }
    }
  } else if (pngPattern) {
    const fileName = input.split(/[\\/]/u).at(-1) ?? "";
    if (!/^[^%]+%0(?:[1-9]|1[0-2])d\.png$/u.test(fileName)) {
      usage("PNG input requires <prefix>%0Nd.png with N from 1 through 12");
    }
    for (const flag of ["--frames", "--fps"] as const) {
      if (!raw.values.has(flag)) usage(`PNG input requires ${flag}`);
    }
    if (raw.booleans.has("--normalize-vfr")) {
      usage("--normalize-vfr is valid only for direct video input");
    }
  } else if (direct && raw.values.has("--frames")) {
    usage("--frames is valid only for PNG sequence input");
  }
  if (raw.booleans.has("--normalize-vfr") && !raw.values.has("--fps")) {
    usage("--normalize-vfr requires --fps");
  }
  const codecArguments = direct ? parseDirectCodecArguments(raw) : {};
  const ffmpegPath = optionalToolPath(raw.values.get("--ffmpeg"), "--ffmpeg");
  const ffprobePath = optionalToolPath(raw.values.get("--ffprobe"), "--ffprobe");
  const mediaTimeoutMs = raw.values.has("--media-timeout-ms")
    ? parsePositiveInteger(raw.values.get("--media-timeout-ms")!, "--media-timeout-ms")
    : undefined;
  const loop = raw.values.has("--loop")
    ? parseHalfOpenRange(raw.values.get("--loop")!, "--loop")
    : undefined;
  const frames = raw.values.has("--frames")
    ? parseFrameSelection(raw.values.get("--frames")!)
    : undefined;
  if (pngPattern && loop !== undefined && frames !== undefined && loop[1] > frames.frameCount) {
    usage("--loop must fit within the normalized --frames count");
  }
  return Object.freeze({
    command: "compile",
    input,
    output: pathToken(output, "--out"),
    ...(loop === undefined ? {} : { loop }),
    ...(raw.values.has("--fps")
      ? { fps: parseRational(raw.values.get("--fps")!, "--fps") }
      : {}),
    ...(raw.values.has("--canvas")
      ? { canvas: parseCanvas(raw.values.get("--canvas")!) }
      : {}),
    ...codecArguments,
    ...(direct
      ? { alpha: parseAlphaPolicy(raw.values.get("--alpha") ?? "auto") }
      : {}),
    ...(frames === undefined ? {} : { frames }),
    ...(ffmpegPath === undefined ? {} : { ffmpegPath }),
    ...(ffprobePath === undefined ? {} : { ffprobePath }),
    ...(mediaTimeoutMs === undefined ? {} : { mediaTimeoutMs }),
    normalizeVfr: raw.booleans.has("--normalize-vfr"),
    force: raw.booleans.has("--force"),
    json: raw.booleans.has("--json")
  });
}

function parseAlphaPolicy(value: string): SourceAlphaPolicy {
  if (value !== "auto" && value !== "opaque" && value !== "packed") {
    usage("--alpha must be auto, opaque, or packed");
  }
  return value;
}

function parseDirectCodecArguments(raw: RawCommand): DirectCompileCodecArguments {
  const codec = parseVideoCodec(requiredValue(raw, "--codec"));
  const allowed = new Set<string>(["--crf"]);
  switch (codec) {
    case "h264":
      allowed.add("--preset");
      break;
    case "h265":
      allowed.add("--preset");
      allowed.add("--threads");
      break;
    case "vp9":
      allowed.add("--deadline");
      allowed.add("--cpu-used");
      allowed.add("--threads");
      break;
    case "av1":
      allowed.add("--bit-depth");
      allowed.add("--cpu-used");
      allowed.add("--tiles");
      allowed.add("--row-mt");
      allowed.add("--threads");
      break;
  }
  const codecFlags = [
    "--crf", "--preset", "--deadline", "--cpu-used", "--bit-depth",
    "--tiles", "--row-mt", "--threads"
  ];
  for (const flag of codecFlags) {
    if (
      (raw.values.has(flag) || raw.booleans.has(flag)) &&
      !allowed.has(flag)
    ) {
      usage(`${flag} is not valid with --codec ${codec}`);
    }
  }
  const crf = raw.values.has("--crf")
    ? parseCrf(raw.values.get("--crf")!, codec)
    : undefined;
  switch (codec) {
    case "h264":
      return Object.freeze({
        codec,
        ...(crf === undefined ? {} : { crf }),
        ...(raw.values.has("--preset")
          ? { preset: parseH264Preset(raw.values.get("--preset")!) }
          : {})
      });
    case "h265":
      return Object.freeze({
        codec,
        ...(crf === undefined ? {} : { crf }),
        ...(raw.values.has("--preset")
          ? { preset: parseH265Preset(raw.values.get("--preset")!) }
          : {}),
        ...(raw.values.has("--threads")
          ? { threads: parseThreads(raw.values.get("--threads")!) }
          : {})
      });
    case "vp9":
      return Object.freeze({
        codec,
        ...(crf === undefined ? {} : { crf }),
        ...(raw.values.has("--deadline")
          ? { deadline: parseDeadline(raw.values.get("--deadline")!) }
          : {}),
        ...(raw.values.has("--cpu-used")
          ? { cpuUsed: parseCpuUsed(raw.values.get("--cpu-used")!, codec) }
          : {}),
        ...(raw.values.has("--threads")
          ? { threads: parseThreads(raw.values.get("--threads")!) }
          : {})
      });
    case "av1":
      return Object.freeze({
        codec,
        ...(crf === undefined ? {} : { crf }),
        ...(raw.values.has("--bit-depth")
          ? { bitDepth: parseBitDepth(raw.values.get("--bit-depth")!) }
          : {}),
        ...(raw.values.has("--cpu-used")
          ? { cpuUsed: parseCpuUsed(raw.values.get("--cpu-used")!, codec) }
          : {}),
        ...(raw.values.has("--tiles")
          ? { tiles: parseTiles(raw.values.get("--tiles")!) }
          : {}),
        rowMt: raw.booleans.has("--row-mt"),
        ...(raw.values.has("--threads")
          ? { threads: parseThreads(raw.values.get("--threads")!) }
          : {})
      });
  }
}

function parseVideoCodec(value: string): DirectCompileCodecArguments["codec"] {
  if (value !== "h264" && value !== "h265" && value !== "vp9" && value !== "av1") {
    usage("--codec must be h264, h265, vp9, or av1");
  }
  return value;
}

function parseCrf(
  value: string,
  codec: DirectCompileCodecArguments["codec"]
): number {
  const maximum = codec === "h264" || codec === "h265" ? 51 : 63;
  return parseIntegerInRange(value, "--crf", codec === "h264" ? 1 : 0, maximum);
}

function parseH264Preset(value: string): H264EncoderPreset {
  const preset = H264_ENCODER_PRESETS.find((candidate) => candidate === value);
  if (preset === undefined) {
    usage(`--preset must be one of ${H264_ENCODER_PRESETS.join(", ")}`);
  }
  return preset;
}

function parseH265Preset(value: string): H265EncoderPreset {
  const preset = H265_ENCODER_PRESETS.find((candidate) => candidate === value);
  if (preset === undefined) {
    usage(`--preset must be one of ${H265_ENCODER_PRESETS.join(", ")}`);
  }
  return preset;
}

function parseDeadline(value: string): Vp9Deadline {
  const deadline = VP9_DEADLINES.find((candidate) => candidate === value);
  if (deadline === undefined) {
    usage(`--deadline must be one of ${VP9_DEADLINES.join(", ")}`);
  }
  return deadline;
}

function parseCpuUsed(value: string, codec: "vp9" | "av1"): number {
  return parseIntegerInRange(value, "--cpu-used", codec === "vp9" ? -8 : 0, 8);
}

function parseBitDepth(value: string): 8 | 10 {
  const parsed = parseIntegerInRange(value, "--bit-depth", 8, 10);
  if (parsed !== 8 && parsed !== 10) usage("--bit-depth must be 8 or 10");
  return parsed;
}

function parseTiles(value: string): Readonly<{ columns: number; rows: number }> {
  const match = /^(\d+)x(\d+)$/u.exec(value);
  if (match === null) usage("--tiles must use columnsxrows");
  const columns = parseTileDimension(match[1]!, "--tiles columns");
  const rows = parseTileDimension(match[2]!, "--tiles rows");
  if (columns * rows > 64) usage("--tiles product must be at most 64");
  return Object.freeze({ columns, rows });
}

function parseTileDimension(value: string, label: string): number {
  const dimension = parseIntegerInRange(value, label, 1, 64);
  if ((dimension & (dimension - 1)) !== 0) {
    usage(`${label} must be a power of two`);
  }
  return dimension;
}

function parseThreads(value: string): number {
  return parseIntegerInRange(value, "--threads", 1, 64);
}

function parseOneInput(
  command: "inspect" | "validate",
  raw: RawCommand
): InspectCliArguments | ValidateCliArguments {
  allowFlags(raw, ["--json"]);
  return Object.freeze({
    command,
    input: onePositional(raw, command),
    json: raw.booleans.has("--json")
  });
}

function parseUnpack(raw: RawCommand): UnpackCliArguments {
  allowFlags(raw, ["--out", "--json"]);
  return Object.freeze({
    command: "unpack",
    input: onePositional(raw, "unpack"),
    output: pathToken(requiredValue(raw, "--out"), "--out"),
    json: raw.booleans.has("--json")
  });
}

function parseInit(raw: RawCommand): InitCliArguments {
  allowFlags(raw, ["--json"]);
  return Object.freeze({
    command: "init",
    directory: onePositional(raw, "init"),
    json: raw.booleans.has("--json")
  });
}

function parseDev(raw: RawCommand): DevCliArguments {
  allowFlags(raw, [
    "--out", "--ffmpeg", "--ffprobe", "--media-timeout-ms", "--port",
    "--json", "--force", "--open"
  ]);
  const ffmpegPath = optionalToolPath(raw.values.get("--ffmpeg"), "--ffmpeg");
  const ffprobePath = optionalToolPath(raw.values.get("--ffprobe"), "--ffprobe");
  const mediaTimeoutMs = raw.values.has("--media-timeout-ms")
    ? parsePositiveInteger(raw.values.get("--media-timeout-ms")!, "--media-timeout-ms")
    : undefined;
  return Object.freeze({
    command: "dev",
    project: onePositional(raw, "dev"),
    output: pathToken(requiredValue(raw, "--out"), "--out"),
    ...(ffmpegPath === undefined ? {} : { ffmpegPath }),
    ...(ffprobePath === undefined ? {} : { ffprobePath }),
    ...(mediaTimeoutMs === undefined ? {} : { mediaTimeoutMs }),
    force: raw.booleans.has("--force"),
    port: parsePort(raw.values.get("--port") ?? "4174"),
    open: raw.booleans.has("--open"),
    json: raw.booleans.has("--json")
  });
}

function parsePort(value: string): number {
  if (!/^[0-9]+$/u.test(value)) usage("--port must be an integer from 0 through 65535");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    usage("--port must be an integer from 0 through 65535");
  }
  return port;
}

function allowFlags(raw: RawCommand, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  for (const flag of [...raw.values.keys(), ...raw.booleans]) {
    if (!accepted.has(flag)) usage(`${flag} is not valid for this command`);
  }
}

function onePositional(raw: RawCommand, command: string): string {
  if (raw.positionals.length !== 1) {
    usage(`${command} requires exactly one input path`);
  }
  return raw.positionals[0]!;
}

function requiredValue(raw: RawCommand, flag: string): string {
  const value = raw.values.get(flag);
  if (value === undefined) usage(`${flag} is required`);
  return value;
}

function optionalToolPath(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  const path = pathToken(value, flag);
  if (!isAbsolute(path)) usage(`${flag} must be an absolute path`);
  return path;
}

function pathToken(value: string, label: string): string {
  if (value.length === 0 || value.includes("\u0000")) {
    usage(`${label} must be a nonempty local path`);
  }
  return value;
}

function parseHalfOpenRange(
  value: string,
  label: string
): readonly [number, number] {
  const match = /^(\d+):(\d+)$/u.exec(value);
  if (match === null) usage(`${label} must use start:end`);
  const start = safeInteger(match[1]!, label);
  const end = safeInteger(match[2]!, label);
  if (end <= start) usage(`${label} must be a nonempty half-open range`);
  return Object.freeze([start, end]);
}

function parseRational(value: string, label: string): Rational {
  const match = /^(\d+)\/(\d+)$/u.exec(value);
  if (match === null) usage(`${label} must use numerator/denominator`);
  const numerator = safeInteger(match[1]!, label);
  const denominator = safeInteger(match[2]!, label);
  if (
    numerator < 1 ||
    denominator < 1 ||
    denominator > 1_001 ||
    numerator > denominator * 60 ||
    gcd(numerator, denominator) !== 1
  ) {
    usage(`${label} must be reduced, positive, and no greater than 60 fps`);
  }
  return Object.freeze({ numerator, denominator });
}

function parseCanvas(value: string): readonly [number, number] {
  const match = /^(\d+)x(\d+)$/u.exec(value);
  if (match === null) usage("--canvas must use widthxheight");
  const width = safeInteger(match[1]!, "--canvas");
  const height = safeInteger(match[2]!, "--canvas");
  if (width < 1 || height < 1 || width > 0xffff_ffff || height > 0xffff_ffff) {
    usage("--canvas dimensions must fit positive unsigned 32-bit PNG fields");
  }
  return Object.freeze([width, height]);
}

function parseFrameSelection(value: string): {
  readonly firstNumber: number;
  readonly frameCount: number;
} {
  const match = /^(\d+):(\d+)$/u.exec(value);
  if (match === null) usage("--frames must use first-number:count");
  const firstNumber = safeInteger(match[1]!, "--frames");
  const frameCount = safeInteger(match[2]!, "--frames");
  if (frameCount < 1) {
    usage("--frames count must be a positive safe integer");
  }
  return Object.freeze({ firstNumber, frameCount });
}

function safeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    usage(`${label} contains an unsafe integer`);
  }
  return parsed;
}

function parsePositiveInteger(value: string, label: string): number {
  if (!/^\d+$/u.test(value)) usage(`${label} must be a positive safe integer`);
  const parsed = safeInteger(value, label);
  if (parsed < 1) usage(`${label} must be a positive safe integer`);
  return parsed;
}

function parseIntegerInRange(
  value: string,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (!/^-?\d+$/u.test(value)) {
    usage(`${label} must be an integer from ${String(minimum)} through ${String(maximum)}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    usage(`${label} must be an integer from ${String(minimum)} through ${String(maximum)}`);
  }
  return parsed;
}

function gcd(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function rejectDuplicate(
  flag: string,
  values: ReadonlyMap<string, string>,
  booleans: ReadonlySet<string>
): void {
  if (values.has(flag) || booleans.has(flag)) usage(`Duplicate flag ${flag}`);
}

function safeToken(value: string | undefined): string {
  if (value === undefined) return "<missing>";
  return JSON.stringify(value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "�"));
}

function usage(message: string): never {
  throw new CompilerError("CLI_USAGE", message);
}
