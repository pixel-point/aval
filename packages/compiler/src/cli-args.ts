import { isAbsolute } from "node:path";

import { CompilerError } from "./diagnostics.js";
import type { RationalV01 } from "./model.js";

interface CliBaseArguments {
  readonly json: boolean;
}

export interface CompileCliArguments extends CliBaseArguments {
  readonly command: "compile";
  readonly input: string;
  readonly output: string;
  readonly report?: string;
  readonly loop?: readonly [number, number];
  readonly fps?: RationalV01;
  readonly canvas?: readonly [number, number];
  readonly bitrate?: { readonly average: number; readonly peak: number };
  readonly frames?: { readonly firstNumber: number; readonly frameCount: number };
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly normalizeVfr: boolean;
  readonly force: boolean;
}

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
  readonly force: boolean;
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
  "--report",
  "--loop",
  "--fps",
  "--canvas",
  "--bitrate",
  "--frames",
  "--ffmpeg",
  "--ffprobe"
]);

const BOOLEAN_FLAGS = new Set([
  "--json",
  "--force",
  "--normalize-vfr"
]);

interface RawCommand {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, string>;
  readonly booleans: ReadonlySet<string>;
}

/** Parse the closed, noninteractive M5 command grammar without reading IO. */
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
    "--out", "--report", "--loop", "--fps", "--canvas", "--bitrate",
    "--frames", "--ffmpeg", "--ffprobe", "--json", "--force",
    "--normalize-vfr"
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
      "--loop", "--fps", "--canvas", "--bitrate", "--frames",
      "--normalize-vfr"
    ]) {
      if (raw.values.has(flag) || raw.booleans.has(flag)) {
        usage(`${flag} is valid only for direct media input`);
      }
    }
  } else if (pngPattern) {
    const fileName = input.split(/[\\/]/u).at(-1) ?? "";
    if (!/^[^%]*%0[1-9]d[^%]*\.png$/u.test(fileName)) {
      usage("PNG input requires exactly one %0Nd token with N from 1 through 9");
    }
    for (const flag of ["--frames", "--fps", "--canvas"] as const) {
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
  const ffmpegPath = optionalToolPath(raw.values.get("--ffmpeg"), "--ffmpeg");
  const ffprobePath = optionalToolPath(raw.values.get("--ffprobe"), "--ffprobe");
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
    ...(raw.values.has("--report")
      ? { report: pathToken(raw.values.get("--report")!, "--report") }
      : {}),
    ...(loop === undefined ? {} : { loop }),
    ...(raw.values.has("--fps")
      ? { fps: parseRational(raw.values.get("--fps")!, "--fps") }
      : {}),
    ...(raw.values.has("--canvas")
      ? { canvas: parseCanvas(raw.values.get("--canvas")!) }
      : {}),
    ...(raw.values.has("--bitrate")
      ? { bitrate: parseBitrate(raw.values.get("--bitrate")!) }
      : {}),
    ...(frames === undefined ? {} : { frames }),
    ...(ffmpegPath === undefined ? {} : { ffmpegPath }),
    ...(ffprobePath === undefined ? {} : { ffprobePath }),
    normalizeVfr: raw.booleans.has("--normalize-vfr"),
    force: raw.booleans.has("--force"),
    json: raw.booleans.has("--json")
  });
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
  allowFlags(raw, ["--out", "--ffmpeg", "--ffprobe", "--json", "--force"]);
  const ffmpegPath = optionalToolPath(raw.values.get("--ffmpeg"), "--ffmpeg");
  const ffprobePath = optionalToolPath(raw.values.get("--ffprobe"), "--ffprobe");
  return Object.freeze({
    command: "dev",
    project: onePositional(raw, "dev"),
    output: pathToken(requiredValue(raw, "--out"), "--out"),
    ...(ffmpegPath === undefined ? {} : { ffmpegPath }),
    ...(ffprobePath === undefined ? {} : { ffprobePath }),
    force: raw.booleans.has("--force"),
    json: raw.booleans.has("--json")
  });
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

function parseRational(value: string, label: string): RationalV01 {
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
  if (
    width < 16 || height < 16 || width > 512 || height > 512 ||
    width % 16 !== 0 || height % 16 !== 0
  ) {
    usage("--canvas dimensions must be 16-aligned and from 16 through 512");
  }
  return Object.freeze([width, height]);
}

function parseBitrate(value: string): { readonly average: number; readonly peak: number } {
  const match = /^(\d+):(\d+)$/u.exec(value);
  if (match === null) usage("--bitrate must use average:peak");
  const average = safeInteger(match[1]!, "--bitrate");
  const peak = safeInteger(match[2]!, "--bitrate");
  if (average < 1 || peak < average || peak > 8_000_000) {
    usage("--bitrate requires 1 <= average <= peak <= 8,000,000");
  }
  return Object.freeze({ average, peak });
}

function parseFrameSelection(value: string): {
  readonly firstNumber: number;
  readonly frameCount: number;
} {
  const match = /^(\d+):(\d+)$/u.exec(value);
  if (match === null) usage("--frames must use first-number:count");
  const firstNumber = safeInteger(match[1]!, "--frames");
  const frameCount = safeInteger(match[2]!, "--frames");
  if (frameCount < 1 || frameCount > 1_800) {
    usage("--frames count must be from 1 through 1,800");
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
