import {
  COMPILE_BUNDLE_REPORT_LIMITS,
  createCompileBundleSourceMarkup,
  FormatError,
  isVideoCodecString,
  SHA256_HEX_PATTERN,
  serializeCanonicalJsonWithLimits,
  type CompileBundleReportAsset as PublishedCompileBundleReportAsset,
  type CompileBundleReportTool as PublishedCompileBundleReportTool,
  type CompileBundleReportToolchain as PublishedCompileBundleReportToolchain,
  type ParsedCompileBundleReport,
  VIDEO_CODECS
} from "@pixel-point/aval-format";

import { CompilerError } from "../diagnostics.js";
import type { RegularFileIdentity } from "../file-fingerprint.js";
import {
  type CompileInvocationDetails,
  type NormalizedVideoEncoding,
  type ToolProvenance,
  type VideoCodec
} from "../model.js";
import { sha256Hex } from "./hash.js";
import { cloneNormalizedVideoEncodings } from "./video-encoding-policy.js";

const PATH_OR_URL = /(?:^|[\s"'(=])(?:https?:\/\/|file:|[A-Za-z]:[\\/]|\\\\|\/(?!\/)|\.\.?[\\/]|~[\\/])/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export interface CompileBundleAssetFact {
  readonly codec: VideoCodec;
  readonly bytes: number;
  readonly sha256: string;
  /** Exact codec string from this asset's first manifest rendition. */
  readonly codecString: string;
}

export interface CompileBundleReportInput {
  readonly assets: readonly Readonly<CompileBundleAssetFact>[];
  /** Canonical project encoding policies in the same order as `assets`. */
  readonly encodings: readonly Readonly<NormalizedVideoEncoding>[];
  readonly invocations: readonly Readonly<CompileInvocationDetails>[];
  readonly warnings: readonly string[];
  readonly provenance: Readonly<ToolProvenance>;
}

export type CompileBundleReportAsset = PublishedCompileBundleReportAsset;
export type CompileBundleReportTool = PublishedCompileBundleReportTool;
export type CompileBundleReportToolchain = PublishedCompileBundleReportToolchain;
export type CompileBundleReport = ParsedCompileBundleReport;

export interface BuiltCompileBundleReport {
  readonly report: Readonly<CompileBundleReport>;
  readonly bytes: Uint8Array;
}

/** Build the path-free canonical report published as `build.json`. */
export function buildCompileBundleReport(
  input: Readonly<CompileBundleReportInput>
): Readonly<BuiltCompileBundleReport> {
  const encodings = cloneNormalizedVideoEncodings(input.encodings);
  const assets = cloneAssetSet(input.assets, encodings);
  const invocations = cloneInvocations(input.invocations);
  const warnings = cloneWarnings(input.warnings);
  const toolchain = cloneToolchain(input.provenance);
  const sourceMarkup = createCompileBundleSourceMarkup(assets);
  const report: Readonly<CompileBundleReport> = Object.freeze({
    reportVersion: "1.0",
    assets,
    encodings,
    invocations,
    warnings,
    toolchain,
    sourceMarkup
  });

  try {
    const bytes = serializeCanonicalJsonWithLimits(
      report,
      COMPILE_BUNDLE_REPORT_LIMITS.serialization
    );
    return Object.freeze({ report, bytes });
  } catch (error) {
    if (error instanceof FormatError) {
      throw new CompilerError(
        error.code === "BUDGET_EXCEEDED" ? "OUTPUT_LIMIT" : "INPUT_INVALID",
        "Could not serialize the canonical bundle report",
        { cause: error }
      );
    }
    throw error;
  }
}

function cloneAssetSet(
  value: readonly Readonly<CompileBundleAssetFact>[],
  encodings: readonly Readonly<NormalizedVideoEncoding>[]
): readonly Readonly<CompileBundleReportAsset>[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > COMPILE_BUNDLE_REPORT_LIMITS.maxAssets ||
    value.length !== encodings.length
  ) {
    invalid("assets must contain one fact per ordered encoding", "assets");
  }
  const seen = new Set<VideoCodec>();
  return Object.freeze(value.map((asset, index) => {
    const path = `assets[${String(index)}]`;
    const codec = codecValue(asset.codec, `${path}.codec`);
    const encoding = encodings[index]!;
    if (codec !== encoding.codec) {
      invalid("asset order must match encoding order", `${path}.codec`);
    }
    if (seen.has(codec)) {
      invalid(`duplicate ${codec} asset`, `${path}.codec`);
    }
    seen.add(codec);
    const bytes = positiveSafeInteger(asset.bytes, `${path}.bytes`);
    const digest = sha256(asset.sha256, `${path}.sha256`);
    const codecString = boundedSafeText(
      asset.codecString,
      `${path}.codecString`,
      256
    );
    const bitDepth = encoding.codec === "av1" ? encoding.bitDepth : 8;
    if (!isVideoCodecString(codecString, codec, bitDepth)) {
      invalid(
        `codec string is not a fully qualified ${codec} ${String(bitDepth)}-bit string`,
        `${path}.codecString`
      );
    }
    const assetPath = `${codec}.avl` as const;
    const type = `application/vnd.aval; codecs="${codecString}"` as const;
    const integrity = `sha256-${hexDigestBase64(digest)}` as const;
    return Object.freeze({
      codec,
      path: assetPath,
      bytes,
      sha256: digest,
      codecString,
      type,
      integrity
    });
  }));
}

function cloneInvocations(
  value: readonly Readonly<CompileInvocationDetails>[]
): readonly Readonly<CompileInvocationDetails>[] {
  if (
    !Array.isArray(value) ||
    value.length > COMPILE_BUNDLE_REPORT_LIMITS.maxInvocations
  ) {
    invalid("invocation count exceeds the report limit", "invocations");
  }
  return Object.freeze(value.map((invocation, index) => {
    const path = `invocations[${String(index)}]`;
    const operation = pathFreeText(
      invocation.operation,
      `${path}.operation`,
      COMPILE_BUNDLE_REPORT_LIMITS.maxOperationCodeUnits
    );
    if (invocation.tool !== "ffmpeg" && invocation.tool !== "ffprobe") {
      invalid("tool must be ffmpeg or ffprobe", `${path}.tool`);
    }
    if (
      !Array.isArray(invocation.arguments) ||
      invocation.arguments.length >
        COMPILE_BUNDLE_REPORT_LIMITS.maxInvocationArguments
    ) {
      invalid("argument count exceeds the report limit", `${path}.arguments`);
    }
    const argumentsInput: readonly unknown[] = invocation.arguments;
    const arguments_ = Object.freeze(argumentsInput.map((argument, argumentIndex) =>
      pathFreeText(
        argument,
        `${path}.arguments[${String(argumentIndex)}]`,
        COMPILE_BUNDLE_REPORT_LIMITS.maxFreeTextCodeUnits,
        true
      )
    ));
    return Object.freeze({ operation, tool: invocation.tool, arguments: arguments_ });
  }));
}

function cloneWarnings(value: readonly string[]): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > COMPILE_BUNDLE_REPORT_LIMITS.maxWarnings
  ) {
    invalid("warning count exceeds the report limit", "warnings");
  }
  return Object.freeze(value.map((warning, index) =>
    pathFreeText(
      warning,
      `warnings[${String(index)}]`,
      COMPILE_BUNDLE_REPORT_LIMITS.maxFreeTextCodeUnits
    )
  ));
}

function cloneToolchain(
  provenance: Readonly<ToolProvenance>
): Readonly<CompileBundleReportToolchain> {
  if (provenance.aggregateMemoryLimit !== "derived") {
    invalid("aggregate memory limit provenance is invalid", "provenance");
  }
  const ffmpeg: CompileBundleReportToolchain["ffmpeg"] = Object.freeze({
    executableSha256: sha256(
      provenance.executableSha256,
      "provenance.executableSha256"
    ),
    executableIdentity: cloneIdentity(
      provenance.executableIdentity,
      "provenance.executableIdentity"
    ),
    version: pathFreeText(
      provenance.versionLine,
      "provenance.versionLine",
      COMPILE_BUNDLE_REPORT_LIMITS.maxFreeTextCodeUnits
    ),
    versionOutputSha256: sha256(
      provenance.versionOutputSha256,
      "provenance.versionOutputSha256"
    ),
    configurationSha256: sha256Hex(
      new TextEncoder().encode(boundedSafeText(
        provenance.configurationLine,
        "provenance.configurationLine",
        1024 * 1024
      ))
    ),
    encodersOutputSha256: sha256(
      provenance.encodersOutputSha256,
      "provenance.encodersOutputSha256"
    ),
    calibrationSha256: sha256(
      provenance.calibrationSha256,
      "provenance.calibrationSha256"
    )
  });
  const ffprobe: CompileBundleReportToolchain["ffprobe"] = Object.freeze({
    executableSha256: sha256(
      provenance.ffprobeExecutableSha256,
      "provenance.ffprobeExecutableSha256"
    ),
    executableIdentity: cloneIdentity(
      provenance.ffprobeExecutableIdentity,
      "provenance.ffprobeExecutableIdentity"
    ),
    version: pathFreeText(
      provenance.ffprobeVersionLine,
      "provenance.ffprobeVersionLine",
      COMPILE_BUNDLE_REPORT_LIMITS.maxFreeTextCodeUnits
    ),
    versionOutputSha256: sha256(
      provenance.ffprobeVersionOutputSha256,
      "provenance.ffprobeVersionOutputSha256"
    )
  });
  return Object.freeze({ ffmpeg, ffprobe, aggregateMemoryLimit: "derived" });
}

function cloneIdentity(
  value: Readonly<RegularFileIdentity>,
  path: string
): Readonly<RegularFileIdentity> {
  return Object.freeze({
    device: decimalText(value.device, `${path}.device`),
    inode: decimalText(value.inode, `${path}.inode`),
    size: integer(value.size, `${path}.size`, 0, Number.MAX_SAFE_INTEGER),
    mtimeNanoseconds: decimalText(
      value.mtimeNanoseconds,
      `${path}.mtimeNanoseconds`
    ),
    ctimeNanoseconds: decimalText(
      value.ctimeNanoseconds,
      `${path}.ctimeNanoseconds`
    )
  });
}

function hexDigestBase64(value: string): string {
  return Buffer.from(value, "hex").toString("base64");
}

function codecValue(value: unknown, path: string): VideoCodec {
  return oneOf(value, VIDEO_CODECS, path);
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
  path: string
): T[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    invalid(`must be one of ${values.join(", ")}`, path);
  }
  return value as T[number];
}

function positiveSafeInteger(value: unknown, path: string): number {
  return integer(value, path, 1, Number.MAX_SAFE_INTEGER);
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
  ) {
    invalid(
      `must be an integer from ${String(minimum)} through ${String(maximum)}`,
      path
    );
  }
  return value;
}

function sha256(value: unknown, path: string): string {
  if (typeof value !== "string" || !SHA256_HEX_PATTERN.test(value)) {
    invalid("must be a lowercase SHA-256 digest", path);
  }
  return value;
}

function decimalText(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    invalid("must be an unsigned canonical decimal string", path);
  }
  return value;
}

function boundedSafeText(
  value: unknown,
  path: string,
  maximumCodeUnits: number,
  allowControls = false
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumCodeUnits ||
    (!allowControls && CONTROL_CHARACTER.test(value))
  ) {
    invalid("must be bounded nonempty text without control characters", path);
  }
  return value;
}

function pathFreeText(
  value: unknown,
  path: string,
  maximumCodeUnits: number,
  allowEmpty = false
): string {
  if (allowEmpty && value === "") return "";
  const text = boundedSafeText(value, path, maximumCodeUnits);
  if (PATH_OR_URL.test(text)) {
    invalid("must not contain a local path or URL", path);
  }
  return text;
}

function invalid(message: string, field?: string): never {
  throw new CompilerError("INPUT_INVALID", message, {
    ...(field === undefined ? {} : { field })
  });
}
