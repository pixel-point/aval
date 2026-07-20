import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import {
  delimiter,
  dirname,
  isAbsolute,
  join
} from "node:path";
import { cwd } from "node:process";

import { deriveVideoRenditionGeometry } from "@pixel-point/aval-format";

import { CompilerError } from "../diagnostics.js";
import {
  fingerprintRegularFile,
  sameRegularFileIdentity
} from "../file-fingerprint.js";
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  MAX_PROCESS_STDERR_BYTES,
  type ToolProvenance,
  type VideoCodec
} from "../model.js";
import { runBoundedProcess } from "../process-runner.js";
import { sha256Hex } from "../compile/hash.js";
import { convertRgba16ToYuv420 } from "../compile/rgba16-to-yuv420.js";
import { composeVideoSurfaceRgba16 } from "../compile/video-surface-rgba16.js";
import { createEncodeVideoUnitInvocation } from "./video-encode-unit.js";

const VERSION_OUTPUT_LIMIT = 256 * 1024;
const ENCODERS_OUTPUT_LIMIT = 512 * 1024;
const MAX_TOOL_BYTES = 1024 * 1024 * 1024;

export const FFMPEG_VERSION_ARGUMENTS = Object.freeze(["-version"] as const);
export const FFMPEG_ENCODERS_ARGUMENTS = Object.freeze([
  "-hide_banner",
  "-encoders"
] as const);
export const FFPROBE_VERSION_ARGUMENTS = Object.freeze(["-version"] as const);

/** Resolve, fingerprint, and capability-check the caller-owned FFmpeg pair. */
export async function discoverFfmpeg(
  executable?: string,
  signal?: AbortSignal,
  ffprobeExecutable?: string,
  requestedCodecs: readonly VideoCodec[] = Object.freeze(["h264"])
): Promise<Readonly<ToolProvenance>> {
  const ffmpeg = await resolveExecutable(
    executable,
    process.env.AVL_FFMPEG,
    "ffmpeg"
  );
  const ffprobe = await resolveFfprobe(
    ffprobeExecutable,
    process.env.AVL_FFPROBE,
    ffmpeg
  );
  const [versionResult, encodersResult, probeVersion, ffmpegFile, ffprobeFile] =
    await Promise.all([
      runTool(ffmpeg, FFMPEG_VERSION_ARGUMENTS, VERSION_OUTPUT_LIMIT, signal),
      runTool(ffmpeg, FFMPEG_ENCODERS_ARGUMENTS, ENCODERS_OUTPUT_LIMIT, signal),
      runTool(ffprobe, FFPROBE_VERSION_ARGUMENTS, VERSION_OUTPUT_LIMIT, signal),
      fingerprintRegularFile(ffmpeg, MAX_TOOL_BYTES, "FFmpeg executable", signal),
      fingerprintRegularFile(ffprobe, MAX_TOOL_BYTES, "FFprobe executable", signal)
    ]);
  const text = new TextDecoder().decode(versionResult.stdout);
  const lines = text.split(/\r?\n/u);
  const versionLine = lines.find((line) => line.startsWith("ffmpeg version "));
  const configurationLine = lines.find((line) => line.startsWith("configuration:"));
  const probeLine = new TextDecoder().decode(probeVersion.stdout)
    .split(/\r?\n/u)
    .find((line) => line.startsWith("ffprobe version "));
  if (
    versionLine === undefined ||
    configurationLine === undefined ||
    probeLine === undefined
  ) {
    throw new CompilerError(
      "FFMPEG_UNSUPPORTED",
      "FFmpeg/FFprobe did not report parseable version metadata"
    );
  }
  const encoders = new TextDecoder().decode(encodersResult.stdout);
  validateRequestedEncoders(requestedCodecs, encoders);
  const calibrationSha256 = await runCalibration(ffmpeg, signal);
  const [finalFfmpeg, finalFfprobe] = await Promise.all([
    fingerprintRegularFile(ffmpeg, MAX_TOOL_BYTES, "FFmpeg executable", signal),
    fingerprintRegularFile(ffprobe, MAX_TOOL_BYTES, "FFprobe executable", signal)
  ]);
  requireSameTool(ffmpegFile, finalFfmpeg, "FFmpeg");
  requireSameTool(ffprobeFile, finalFfprobe, "FFprobe");
  return Object.freeze({
    executable: ffmpeg,
    executableSha256: ffmpegFile.sha256,
    executableIdentity: ffmpegFile.identity,
    versionLine,
    versionOutputSha256: sha256Hex(versionResult.stdout),
    configurationLine,
    encodersOutputSha256: sha256Hex(encodersResult.stdout),
    calibrationSha256,
    ffprobeExecutable: ffprobe,
    ffprobeExecutableSha256: ffprobeFile.sha256,
    ffprobeExecutableIdentity: ffprobeFile.identity,
    ffprobeVersionLine: probeLine,
    ffprobeVersionOutputSha256: sha256Hex(probeVersion.stdout),
    aggregateMemoryLimit: "derived"
  });
}

function validateRequestedEncoders(
  requested: readonly VideoCodec[],
  encoders: string
): void {
  if (requested.length < 1) {
    throw new CompilerError("INPUT_INVALID", "At least one output codec is required");
  }
  const encoderByCodec = Object.freeze({
    h264: "libx264",
    h265: "libx265",
    vp9: "libvpx-vp9",
    av1: "libaom-av1"
  } satisfies Readonly<Record<VideoCodec, string>>);
  const seen = new Set<VideoCodec>();
  for (const codec of requested) {
    if (seen.has(codec)) {
      throw new CompilerError("INPUT_INVALID", "Requested output codecs are invalid or duplicated");
    }
    seen.add(codec);
    const encoder = encoderByCodec[codec];
    if (!new RegExp(`(?:^|\\s)${encoder}(?:\\s|$)`, "mu").test(encoders)) {
      throw new CompilerError(
        "FFMPEG_UNSUPPORTED",
        `FFmpeg does not expose the requested ${encoder} encoder`,
        { hint: `Install an FFmpeg build that enables ${encoder}.` }
      );
    }
  }
}

/** Re-prove the effective encoder and both exact tool identities after use. */
export async function verifyFfmpegProvenance(
  provenance: Readonly<ToolProvenance>,
  signal?: AbortSignal
): Promise<void> {
  const [version, encoders, probeVersion, calibrationSha256] = await Promise.all([
    runTool(
      provenance.executable,
      FFMPEG_VERSION_ARGUMENTS,
      VERSION_OUTPUT_LIMIT,
      signal
    ),
    runTool(
      provenance.executable,
      FFMPEG_ENCODERS_ARGUMENTS,
      ENCODERS_OUTPUT_LIMIT,
      signal
    ),
    runTool(
      provenance.ffprobeExecutable,
      FFPROBE_VERSION_ARGUMENTS,
      VERSION_OUTPUT_LIMIT,
      signal
    ),
    runCalibration(provenance.executable, signal)
  ]);
  const [ffmpeg, ffprobe] = await Promise.all([
    fingerprintRegularFile(
      provenance.executable,
      MAX_TOOL_BYTES,
      "FFmpeg executable",
      signal
    ),
    fingerprintRegularFile(
      provenance.ffprobeExecutable,
      MAX_TOOL_BYTES,
      "FFprobe executable",
      signal
    )
  ]);
  if (
    calibrationSha256 !== provenance.calibrationSha256 ||
    sha256Hex(version.stdout) !== provenance.versionOutputSha256 ||
    sha256Hex(encoders.stdout) !== provenance.encodersOutputSha256 ||
    sha256Hex(probeVersion.stdout) !==
      provenance.ffprobeVersionOutputSha256 ||
    ffmpeg.sha256 !== provenance.executableSha256 ||
    ffprobe.sha256 !== provenance.ffprobeExecutableSha256 ||
    !sameRegularFileIdentity(ffmpeg.identity, provenance.executableIdentity) ||
    !sameRegularFileIdentity(
      ffprobe.identity,
      provenance.ffprobeExecutableIdentity
    )
  ) {
    throw new CompilerError(
      "FFMPEG_UNSUPPORTED",
      "FFmpeg toolchain changed during compilation"
    );
  }
}

async function runCalibration(
  executable: string,
  signal?: AbortSignal
): Promise<string> {
  const calibration = createCalibrationPayload();
  const result = await runBoundedProcess({
    executable,
    arguments: calibration.invocation.arguments,
    cwd: calibration.invocation.cwd,
    stdin: calibration.bytes,
    limits: {
      timeoutMs: Math.min(DEFAULT_PROBE_TIMEOUT_MS, 5_000),
      maxStdoutBytes: 1024 * 1024,
      maxStderrBytes: MAX_PROCESS_STDERR_BYTES
    },
    privateWorkingDirectory: true,
    ...(signal === undefined ? {} : { signal })
  });
  return sha256Hex(result.stdout);
}

export function createCalibrationInvocation() {
  return createCalibrationPayload().invocation;
}

/** Build deterministic compiler-packed bytes for the exact production encoder. */
function createCalibrationPayload() {
  const geometry = deriveVideoRenditionGeometry({
    canvasWidth: 15,
    canvasHeight: 17,
    layout: "packed-alpha",
    visibleWidth: 15,
    visibleHeight: 17,
    storage: { widthAlignment: 16, heightAlignment: 16 }
  });
  const packed = Array.from({ length: 2 }, (_, frame) => {
    const rgba = new Uint16Array(15 * 17 * 4);
    for (let pixel = 0; pixel < 15 * 17; pixel += 1) {
      const offset = pixel * 4;
      rgba[offset] = ((pixel * 17 + frame * 31) & 0xff) * 257;
      rgba[offset + 1] = ((pixel * 7 + frame * 47) & 0xff) * 257;
      rgba[offset + 2] = ((pixel * 3 + frame * 59) & 0xff) * 257;
      rgba[offset + 3] = ((pixel * 11 + frame * 73) & 0xff) * 257;
    }
    return convertRgba16ToYuv420(
      composeVideoSurfaceRgba16(rgba, geometry),
      { width: geometry.codedWidth, height: geometry.codedHeight, bitDepth: 8 }
    );
  });
  const frameBytes = packed[0]!.byteLength;
  const bytes = new Uint8Array(frameBytes * packed.length);
  packed.forEach((frame, index) => bytes.set(frame, index * frameBytes));
  const rendition = Object.freeze({
    id: "calibration",
    width: 15,
    height: 17,
    crf: 23
  });
  const invocation = createEncodeVideoUnitInvocation({
    source: {
      path: join(cwd(), "aval-compiler-packed-calibration.yuv"),
      width: geometry.codedWidth,
      height: geometry.codedHeight,
      bitDepth: 8,
      frameRate: { numerator: 30, denominator: 1 },
      frameBytes
    },
    startFrame: 0,
    endFrame: 2,
    encoding: {
      codec: "h264",
      preset: "medium",
      renditions: Object.freeze([rendition])
    },
    rendition,
    geometry
  });
  return Object.freeze({ invocation, bytes });
}

function requireSameTool(
  before: Awaited<ReturnType<typeof fingerprintRegularFile>>,
  after: Awaited<ReturnType<typeof fingerprintRegularFile>>,
  label: string
): void {
  if (
    before.sha256 !== after.sha256 ||
    !sameRegularFileIdentity(before.identity, after.identity)
  ) {
    throw new CompilerError(
      "FFMPEG_UNSUPPORTED",
      `${label} changed during capability discovery`
    );
  }
}

async function runTool(
  executable: string,
  arguments_: readonly string[],
  maxStdoutBytes: number,
  signal?: AbortSignal
) {
  return runBoundedProcess({
    executable,
    arguments: arguments_,
    cwd: cwd(),
    limits: {
      timeoutMs: Math.min(DEFAULT_PROBE_TIMEOUT_MS, 5_000),
      maxStdoutBytes,
      maxStderrBytes: MAX_PROCESS_STDERR_BYTES
    },
    privateWorkingDirectory: true,
    ...(signal === undefined ? {} : { signal })
  });
}

async function resolveFfprobe(
  explicit: string | undefined,
  environment: string | undefined,
  ffmpeg: string
): Promise<string> {
  if (explicit !== undefined || environment !== undefined) {
    return resolveExecutable(explicit, environment, "ffprobe");
  }
  const siblingName = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  const sibling = join(dirname(ffmpeg), siblingName);
  try {
    return await validateExecutable(sibling);
  } catch {
    return resolveExecutable(undefined, undefined, "ffprobe");
  }
}

async function resolveExecutable(
  explicit: string | undefined,
  environment: string | undefined,
  fallback: "ffmpeg" | "ffprobe"
): Promise<string> {
  const selected = explicit ?? environment;
  if (selected !== undefined) {
    if (!isAbsolute(selected)) {
      throw new CompilerError(
        "INPUT_INVALID",
        `${fallback} override must be an absolute path`
      );
    }
    return validateExecutable(selected);
  }
  const path = process.env.PATH ?? "";
  const names = process.platform === "win32"
    ? executableNames(fallback)
    : [fallback];
  for (const directory of path.split(delimiter)) {
    if (directory.length === 0) continue;
    for (const name of names) {
      try {
        return await validateExecutable(join(directory, name));
      } catch {
        // Continue through the caller's PATH in deterministic order.
      }
    }
  }
  throw new CompilerError("FFMPEG_NOT_FOUND", `Executable not found: ${fallback}`);
}

function executableNames(base: string): string[] {
  const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT")
    .split(";")
    .filter(Boolean);
  return [base, ...extensions.map((extension) => `${base}${extension.toLowerCase()}`)];
}

async function validateExecutable(candidate: string): Promise<string> {
  const path = await realpath(candidate).catch((error: unknown) => {
    throw new CompilerError("FFMPEG_NOT_FOUND", `Executable not found: ${candidate}`, {
      path: candidate,
      cause: error
    });
  });
  const metadata = await stat(path);
  if (!metadata.isFile()) {
    throw new CompilerError("FFMPEG_NOT_FOUND", "Tool path is not a regular file", {
      path
    });
  }
  await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  return path;
}
