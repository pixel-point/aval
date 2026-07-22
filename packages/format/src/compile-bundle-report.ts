import { IDENTIFIER_PATTERN, SHA256_HEX_PATTERN } from "./constants.js";
import { serializeCanonicalJsonWithLimits } from "./canonical-json.js";
import type { VideoCodec } from "./model.js";
import {
  isVideoCodecString,
  VIDEO_CODECS
} from "./video/codec-string.js";

const INTEGRITY = /^sha256-[A-Za-z0-9+/]{43}=$/u;
const PATH_OR_URL = /(?:^|[\s"'(=])(?:https?:\/\/|file:|[A-Za-z]:[\\/]|\\\\|\/(?!\/)|\.\.?[\\/]|~[\\/])/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const DECIMAL_TEXT = /^(?:0|[1-9][0-9]*)$/u;
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export const COMPILE_BUNDLE_H264_PRESETS = Object.freeze([
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
  "slower",
  "veryslow",
  "placebo"
] as const);
export const COMPILE_BUNDLE_H265_PRESETS = COMPILE_BUNDLE_H264_PRESETS;
export const COMPILE_BUNDLE_VP9_DEADLINES = Object.freeze([
  "best",
  "good",
  "realtime"
] as const);
export const COMPILE_BUNDLE_REPORT_LIMITS = Object.freeze({
  maxAssets: VIDEO_CODECS.length,
  maxInvocations: 16_384,
  maxInvocationArguments: 512,
  maxWarnings: 4_096,
  maxOperationCodeUnits: 256,
  maxFreeTextCodeUnits: 32 * 1024,
  serialization: Object.freeze({
    maxBytes: 64 * 1024 * 1024,
    maxDepth: 64,
    maxNodes: 2_000_000,
    maxStringBytes: 1024 * 1024
  })
});
const TOP_LEVEL_KEYS = Object.freeze([
  "reportVersion",
  "assets",
  "encodings",
  "invocations",
  "warnings",
  "toolchain",
  "sourceMarkup"
] as const);

export interface CompileBundleReportAsset {
  readonly codec: VideoCodec;
  readonly path: `${VideoCodec}.avl`;
  readonly bytes: number;
  readonly sha256: string;
  readonly codecString: string;
  readonly type: `application/vnd.aval; codecs="${string}"`;
  readonly integrity: `sha256-${string}`;
}

export interface CompileBundleReportRendition {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly crf: number;
}

interface CompileBundleReportEncodingBase {
  readonly codec: VideoCodec;
  readonly renditions: readonly Readonly<CompileBundleReportRendition>[];
}

export interface CompileBundleReportH264Encoding
  extends CompileBundleReportEncodingBase {
  readonly codec: "h264";
  readonly preset: typeof COMPILE_BUNDLE_H264_PRESETS[number];
}

export interface CompileBundleReportH265Encoding
  extends CompileBundleReportEncodingBase {
  readonly codec: "h265";
  readonly preset: typeof COMPILE_BUNDLE_H265_PRESETS[number];
  readonly threads: number;
}

export interface CompileBundleReportVp9Encoding
  extends CompileBundleReportEncodingBase {
  readonly codec: "vp9";
  readonly deadline: typeof COMPILE_BUNDLE_VP9_DEADLINES[number];
  readonly cpuUsed: number;
  readonly threads: number;
}

export interface CompileBundleReportAv1Encoding
  extends CompileBundleReportEncodingBase {
  readonly codec: "av1";
  readonly bitDepth: 8 | 10;
  readonly cpuUsed: number;
  readonly tiles: Readonly<{ readonly columns: number; readonly rows: number }>;
  readonly rowMt: boolean;
  readonly threads: number;
}

export type CompileBundleReportEncoding =
  | CompileBundleReportH264Encoding
  | CompileBundleReportH265Encoding
  | CompileBundleReportVp9Encoding
  | CompileBundleReportAv1Encoding;

export interface CompileBundleReportInvocation {
  readonly operation: string;
  readonly tool: "ffmpeg" | "ffprobe";
  readonly arguments: readonly string[];
}

export interface CompileBundleReportExecutableIdentity {
  readonly device: string;
  readonly inode: string;
  readonly size: number;
  readonly mtimeNanoseconds: string;
  readonly ctimeNanoseconds: string;
}

export interface CompileBundleReportTool {
  readonly executableSha256: string;
  readonly executableIdentity: Readonly<CompileBundleReportExecutableIdentity>;
  readonly version: string;
  readonly versionOutputSha256: string;
}

export interface CompileBundleReportToolchain {
  readonly ffmpeg: Readonly<CompileBundleReportTool> & {
    readonly configurationSha256: string;
    readonly encodersOutputSha256: string;
    readonly calibrationSha256: string;
  };
  readonly ffprobe: Readonly<CompileBundleReportTool>;
  readonly aggregateMemoryLimit: "derived";
}

export interface ParsedCompileBundleReport {
  readonly reportVersion: "1.0";
  readonly assets: readonly Readonly<CompileBundleReportAsset>[];
  readonly encodings: readonly Readonly<CompileBundleReportEncoding>[];
  readonly invocations: readonly Readonly<CompileBundleReportInvocation>[];
  readonly warnings: readonly string[];
  readonly toolchain: Readonly<CompileBundleReportToolchain>;
  readonly sourceMarkup: string;
}

/** Validate, detach, and recursively freeze one compiler-published build.json. */
export function parseCompileBundleReport(
  value: unknown
): Readonly<ParsedCompileBundleReport> {
  const input = record(value, "report");
  exactKeys(input, TOP_LEVEL_KEYS, "report");
  if (input.reportVersion !== "1.0") invalid("report.reportVersion", "must be 1.0");

  const encodings = cloneEncodings(input.encodings);
  const assets = cloneAssets(input.assets, encodings);
  const invocations = cloneInvocations(input.invocations);
  const warnings = boundedArray(
    input.warnings,
    "report.warnings",
    0,
    COMPILE_BUNDLE_REPORT_LIMITS.maxWarnings
  ).map(
    (warning, index) => pathFreeText(
      warning,
      `report.warnings[${String(index)}]`,
      COMPILE_BUNDLE_REPORT_LIMITS.maxFreeTextCodeUnits
    )
  );
  const toolchain = cloneToolchain(input.toolchain);
  const sourceMarkup = createCompileBundleSourceMarkup(assets);
  if (input.sourceMarkup !== sourceMarkup) {
    invalid("report.sourceMarkup", "must match the ordered asset metadata");
  }

  const report = Object.freeze({
    reportVersion: "1.0" as const,
    assets,
    encodings,
    invocations,
    warnings: Object.freeze(warnings),
    toolchain,
    sourceMarkup
  });
  try {
    serializeCanonicalJsonWithLimits(
      report,
      COMPILE_BUNDLE_REPORT_LIMITS.serialization
    );
  } catch {
    invalid("report", "exceeds canonical serialization limits");
  }
  return report;
}

function cloneAssets(
  value: unknown,
  encodings: readonly Readonly<CompileBundleReportEncoding>[]
): readonly Readonly<CompileBundleReportAsset>[] {
  const inputs = boundedArray(
    value,
    "report.assets",
    1,
    COMPILE_BUNDLE_REPORT_LIMITS.maxAssets
  );
  if (inputs.length !== encodings.length) {
    invalid("report.assets", "must match the encoding count");
  }
  const seen = new Set<VideoCodec>();
  return Object.freeze(inputs.map((entry, index) => {
    const path = `report.assets[${String(index)}]`;
    const input = record(entry, path);
    exactKeys(input, [
      "codec", "path", "bytes", "sha256", "codecString", "type", "integrity"
    ], path);
    const codec = codecValue(input.codec, `${path}.codec`);
    if (seen.has(codec)) invalid(`${path}.codec`, "must be unique");
    seen.add(codec);
    const encoding = encodings[index];
    if (encoding === undefined || codec !== encoding.codec) {
      invalid(`${path}.codec`, "must match the encoding in the same position");
    }
    const assetPath = `${codec}.avl` as const;
    if (input.path !== assetPath) invalid(`${path}.path`, `must be ${assetPath}`);
    const bytes = integer(input.bytes, `${path}.bytes`, 1, Number.MAX_SAFE_INTEGER);
    const sha256 = stringPattern(input.sha256, SHA256_HEX_PATTERN, `${path}.sha256`);
    const bitDepth = encoding.codec === "av1" ? encoding.bitDepth : 8;
    if (!isVideoCodecString(input.codecString, codec, bitDepth)) {
      invalid(`${path}.codecString`, "is not a supported codec string");
    }
    const codecString = input.codecString;
    const type = `application/vnd.aval; codecs="${codecString}"` as const;
    if (input.type !== type) invalid(`${path}.type`, "must match codecString");
    const integrity = stringPattern(input.integrity, INTEGRITY, `${path}.integrity`);
    if (integrity !== integrityForSha256(sha256)) {
      invalid(`${path}.integrity`, "must encode the declared sha256 digest");
    }
    return Object.freeze({
      codec,
      path: assetPath,
      bytes,
      sha256,
      codecString,
      type,
      integrity: integrity as `sha256-${string}`
    });
  }));
}

function cloneEncodings(
  value: unknown
): readonly Readonly<CompileBundleReportEncoding>[] {
  const inputs = boundedArray(
    value,
    "report.encodings",
    1,
    COMPILE_BUNDLE_REPORT_LIMITS.maxAssets
  );
  const seen = new Set<VideoCodec>();
  return Object.freeze(inputs.map((entry, index) => {
    const path = `report.encodings[${String(index)}]`;
    const input = record(entry, path);
    const codec = codecValue(input.codec, `${path}.codec`);
    if (seen.has(codec)) invalid(`${path}.codec`, "must be unique");
    seen.add(codec);
    const renditions = cloneRenditions(input.renditions, path, codec);
    switch (codec) {
      case "h264":
        exactKeys(input, ["codec", "preset", "renditions"], path);
        return Object.freeze({
          codec,
          preset: oneOf(
            input.preset,
            COMPILE_BUNDLE_H264_PRESETS,
            `${path}.preset`
          ),
          renditions
        });
      case "h265":
        exactKeys(input, ["codec", "preset", "threads", "renditions"], path);
        return Object.freeze({
          codec,
          preset: oneOf(
            input.preset,
            COMPILE_BUNDLE_H265_PRESETS,
            `${path}.preset`
          ),
          threads: integer(input.threads, `${path}.threads`, 1, 64),
          renditions
        });
      case "vp9":
        exactKeys(
          input,
          ["codec", "deadline", "cpuUsed", "threads", "renditions"],
          path
        );
        return Object.freeze({
          codec,
          deadline: oneOf(
            input.deadline,
            COMPILE_BUNDLE_VP9_DEADLINES,
            `${path}.deadline`
          ),
          cpuUsed: integer(input.cpuUsed, `${path}.cpuUsed`, -8, 8),
          threads: integer(input.threads, `${path}.threads`, 1, 64),
          renditions
        });
      case "av1": {
        exactKeys(
          input,
          [
            "codec", "bitDepth", "cpuUsed", "tiles", "rowMt", "threads",
            "renditions"
          ],
          path
        );
        const tiles = record(input.tiles, `${path}.tiles`);
        exactKeys(tiles, ["columns", "rows"], `${path}.tiles`);
        const columns = powerOfTwo(tiles.columns, `${path}.tiles.columns`);
        const rows = powerOfTwo(tiles.rows, `${path}.tiles.rows`);
        if (columns * rows > 64) invalid(`${path}.tiles`, "product must be at most 64");
        if (input.bitDepth !== 8 && input.bitDepth !== 10) {
          invalid(`${path}.bitDepth`, "must be 8 or 10");
        }
        if (typeof input.rowMt !== "boolean") {
          invalid(`${path}.rowMt`, "must be a boolean");
        }
        return Object.freeze({
          codec,
          bitDepth: input.bitDepth,
          cpuUsed: integer(input.cpuUsed, `${path}.cpuUsed`, 0, 8),
          tiles: Object.freeze({ columns, rows }),
          rowMt: input.rowMt,
          threads: integer(input.threads, `${path}.threads`, 1, 64),
          renditions
        });
      }
    }
  }));
}

function cloneRenditions(
  value: unknown,
  encodingPath: string,
  codec: VideoCodec
): readonly Readonly<CompileBundleReportRendition>[] {
  const inputs = boundedArray(value, `${encodingPath}.renditions`, 1, 4);
  const seen = new Set<string>();
  return Object.freeze(inputs.map((entry, index) => {
    const path = `${encodingPath}.renditions[${String(index)}]`;
    const input = record(entry, path);
    exactKeys(input, ["id", "width", "height", "crf"], path);
    const id = stringPattern(input.id, IDENTIFIER_PATTERN, `${path}.id`);
    if (seen.has(id)) invalid(`${path}.id`, "must be unique");
    seen.add(id);
    return Object.freeze({
      id,
      width: integer(input.width, `${path}.width`, 1, 0xffff_ffff),
      height: integer(input.height, `${path}.height`, 1, 0xffff_ffff),
      crf: integer(
        input.crf,
        `${path}.crf`,
        0,
        codec === "vp9" || codec === "av1" ? 63 : 51
      )
    });
  }));
}

function cloneInvocations(
  value: unknown
): readonly Readonly<CompileBundleReportInvocation>[] {
  const inputs = boundedArray(
    value,
    "report.invocations",
    0,
    COMPILE_BUNDLE_REPORT_LIMITS.maxInvocations
  );
  return Object.freeze(inputs.map((entry, index) => {
    const path = `report.invocations[${String(index)}]`;
    const input = record(entry, path);
    exactKeys(input, ["operation", "tool", "arguments"], path);
    const arguments_ = boundedArray(
      input.arguments,
      `${path}.arguments`,
      0,
      COMPILE_BUNDLE_REPORT_LIMITS.maxInvocationArguments
    ).map((argument, argumentIndex) => pathFreeText(
      argument,
      `${path}.arguments[${String(argumentIndex)}]`,
      COMPILE_BUNDLE_REPORT_LIMITS.maxFreeTextCodeUnits,
      true
    ));
    return Object.freeze({
      operation: pathFreeText(
        input.operation,
        `${path}.operation`,
        COMPILE_BUNDLE_REPORT_LIMITS.maxOperationCodeUnits
      ),
      tool: oneOf(input.tool, ["ffmpeg", "ffprobe"] as const, `${path}.tool`),
      arguments: Object.freeze(arguments_)
    });
  }));
}

function cloneToolchain(value: unknown): Readonly<CompileBundleReportToolchain> {
  const path = "report.toolchain";
  const input = record(value, path);
  exactKeys(input, ["ffmpeg", "ffprobe", "aggregateMemoryLimit"], path);
  if (input.aggregateMemoryLimit !== "derived") {
    invalid(`${path}.aggregateMemoryLimit`, "must be derived");
  }
  return Object.freeze({
    ffmpeg: cloneFfmpegTool(input.ffmpeg, `${path}.ffmpeg`),
    ffprobe: cloneFfprobeTool(input.ffprobe, `${path}.ffprobe`),
    aggregateMemoryLimit: "derived" as const
  });
}

function cloneFfmpegTool(
  value: unknown,
  path: string
): CompileBundleReportToolchain["ffmpeg"] {
  const input = record(value, path);
  exactKeys(input, [
    "executableSha256",
    "executableIdentity",
    "version",
    "versionOutputSha256",
    "configurationSha256",
    "encodersOutputSha256",
    "calibrationSha256"
  ], path);
  return Object.freeze({
    ...cloneToolFields(input, path),
    configurationSha256: sha256(input.configurationSha256, `${path}.configurationSha256`),
    encodersOutputSha256: sha256(
      input.encodersOutputSha256,
      `${path}.encodersOutputSha256`
    ),
    calibrationSha256: sha256(input.calibrationSha256, `${path}.calibrationSha256`)
  });
}

function cloneFfprobeTool(
  value: unknown,
  path: string
): Readonly<CompileBundleReportTool> {
  const input = record(value, path);
  exactKeys(input, [
    "executableSha256",
    "executableIdentity",
    "version",
    "versionOutputSha256"
  ], path);
  return cloneToolFields(input, path);
}

function cloneToolFields(
  input: Record<string, unknown>,
  path: string
): Readonly<CompileBundleReportTool> {
  return Object.freeze({
    executableSha256: sha256(input.executableSha256, `${path}.executableSha256`),
    executableIdentity: cloneExecutableIdentity(
      input.executableIdentity,
      `${path}.executableIdentity`
    ),
    version: pathFreeText(
      input.version,
      `${path}.version`,
      COMPILE_BUNDLE_REPORT_LIMITS.maxFreeTextCodeUnits
    ),
    versionOutputSha256: sha256(
      input.versionOutputSha256,
      `${path}.versionOutputSha256`
    )
  });
}

function cloneExecutableIdentity(
  value: unknown,
  path: string
): Readonly<CompileBundleReportExecutableIdentity> {
  const input = record(value, path);
  exactKeys(input, [
    "device",
    "inode",
    "size",
    "mtimeNanoseconds",
    "ctimeNanoseconds"
  ], path);
  return Object.freeze({
    device: decimalText(input.device, `${path}.device`),
    inode: decimalText(input.inode, `${path}.inode`),
    size: integer(input.size, `${path}.size`, 0, Number.MAX_SAFE_INTEGER),
    mtimeNanoseconds: decimalText(
      input.mtimeNanoseconds,
      `${path}.mtimeNanoseconds`
    ),
    ctimeNanoseconds: decimalText(
      input.ctimeNanoseconds,
      `${path}.ctimeNanoseconds`
    )
  });
}

export function createCompileBundleSourceMarkup(
  assets: readonly Readonly<CompileBundleReportAsset>[]
): string {
  return assets.map((asset) =>
    `<source src="${asset.path}" data-codec="${asset.codec}" integrity="${asset.integrity}">`
  ).join("\n");
}

function integrityForSha256(value: string): `sha256-${string}` {
  let result = "";
  for (let offset = 0; offset < value.length; offset += 6) {
    const byteCount = Math.min(3, (value.length - offset) / 2);
    const first = Number.parseInt(value.slice(offset, offset + 2), 16);
    const second = byteCount > 1
      ? Number.parseInt(value.slice(offset + 2, offset + 4), 16)
      : 0;
    const third = byteCount > 2
      ? Number.parseInt(value.slice(offset + 4, offset + 6), 16)
      : 0;
    const group = (first << 16) | (second << 8) | third;
    result += BASE64_ALPHABET[(group >>> 18) & 0x3f];
    result += BASE64_ALPHABET[(group >>> 12) & 0x3f];
    result += byteCount > 1 ? BASE64_ALPHABET[(group >>> 6) & 0x3f] : "=";
    result += byteCount > 2 ? BASE64_ALPHABET[group & 0x3f] : "=";
  }
  return `sha256-${result}`;
}

function codecValue(value: unknown, path: string): VideoCodec {
  if (typeof value !== "string" || !VIDEO_CODECS.includes(value as VideoCodec)) {
    invalid(path, "must be h264, h265, vp9, or av1");
  }
  return value as VideoCodec;
}

function sha256(value: unknown, path: string): string {
  return stringPattern(value, SHA256_HEX_PATTERN, path);
}

function decimalText(value: unknown, path: string): string {
  return stringPattern(value, DECIMAL_TEXT, path);
}

function powerOfTwo(value: unknown, path: string): number {
  const result = integer(value, path, 1, 64);
  if ((result & (result - 1)) !== 0) invalid(path, "must be a power of two");
  return result;
}

function integer(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) invalid(path, `must be an integer from ${String(minimum)} to ${String(maximum)}`);
  return value;
}

function boundedString(
  value: unknown,
  path: string,
  maximum: number,
  allowEmpty = false
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length < 1) ||
    value.length > maximum ||
    CONTROL_CHARACTER.test(value)
  ) {
    invalid(
      path,
      `must be ${allowEmpty ? "a" : "a non-empty"} string of at most ${String(maximum)} characters without control characters`
    );
  }
  return value;
}

function pathFreeText(
  value: unknown,
  path: string,
  maximum: number,
  allowEmpty = false
): string {
  const result = boundedString(value, path, maximum, allowEmpty);
  if (PATH_OR_URL.test(result)) {
    invalid(path, "must not contain a local path or URL");
  }
  return result;
}

function stringPattern(value: unknown, pattern: RegExp, path: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    invalid(path, `must match ${String(pattern)}`);
  }
  return value;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  path: string
): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    invalid(path, `must be one of ${choices.join(", ")}`);
  }
  return value as T[number];
}

function boundedArray(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number
): readonly unknown[] {
  const result = denseArray(value, path);
  if (result.length < minimum || result.length > maximum) {
    invalid(path, `must contain ${String(minimum)} through ${String(maximum)} entries`);
  }
  return result;
}

function denseArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(path, "must be an array");
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, String(index))) {
      invalid(path, "must not be sparse");
    }
  }
  return value;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string
): void {
  const expected = new Set(keys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !expected.has(key)) {
      invalid(path, `contains an unknown field ${String(key)}`);
    }
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      invalid(`${path}.${key}`, "is required");
    }
  }
}

function invalid(path: string, message: string): never {
  throw new TypeError(`compile bundle report: ${path} ${message}`);
}
