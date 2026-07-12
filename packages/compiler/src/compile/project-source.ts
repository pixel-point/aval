import { join, relative, sep } from "node:path";

import type { CanvasV01, RationalV01 } from "@rendered-motion/format";

import { CompilerError } from "../diagnostics.js";
import {
  fingerprintRegularFile,
  sameRegularFileIdentity,
  type RegularFileIdentity
} from "../file-fingerprint.js";
import {
  createNativeAlphaAuditInvocation,
  type FfmpegFrameInput
} from "../ffmpeg/encode-unit.js";
import {
  createProbeMediaInvocation,
  createProbePngSequenceInvocation,
  probeMedia,
  probePngSequence
} from "../ffmpeg/probe.js";
import { inspectPngSequence } from "../input/png-sequence.js";
import { resolveExistingLocalFile } from "../local-path.js";
import type {
  MediaProbe,
  SourceDescriptorV01
} from "../model.js";
import { normalizeHoldTimeline } from "./normalize-timeline.js";
import { materializeNormalizedRgbaSource } from "./rgba-spool.js";
import { scanSelectedNativeOpacity } from "./opaque-frames.js";

export interface PreparedProjectSource {
  readonly id: string;
  readonly input: Extract<FfmpegFrameInput, { readonly type: "raw-rgba" }>;
  /** Exact native-source probe retained for provenance and diagnostics. */
  readonly sourceProbe: MediaProbe;
  /** Canonical project-grid probe used by later compiler stages. */
  readonly probe: MediaProbe;
  readonly spoolFrameCount: number;
  readonly projectFrameToSpoolFrame: ReadonlyMap<number, number>;
  readonly inputFiles: readonly SourceInputFingerprint[];
  readonly normalization: SourceNormalizationReport;
  readonly alphaAudit: "passed" | "skipped-no-alpha";
  readonly invocations: readonly PreparedSourceInvocation[];
  readonly warnings: readonly string[];
  readonly cleanup: () => Promise<void>;
}

export interface PreparedSourceInvocation {
  readonly operation: string;
  readonly tool: "ffmpeg" | "ffprobe";
  readonly arguments: readonly string[];
}

export interface SourceInputFingerprint {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly identity: RegularFileIdentity;
}

export type SourceNormalizationReport =
  | {
      readonly mode: "exact";
      readonly projectFrameCount: number;
      readonly selectedProjectFrames: readonly number[];
      readonly selectedNativeFrames: readonly number[];
    }
  | {
      readonly mode: "normalize-hold";
      readonly projectFrameCount: number;
      readonly selectedProjectFrames: readonly number[];
      readonly selectedNativeFrames: readonly number[];
      readonly duplicatedSourceFrames: readonly number[];
      readonly droppedSourceFrames: readonly number[];
    };

const MAX_AGGREGATE_SOURCE_FILE_BYTES = 1024 * 1024 * 1024;

export async function prepareProjectSources(input: {
  readonly root: string;
  readonly sources: readonly SourceDescriptorV01[];
  readonly canvas: CanvasV01;
  readonly frameRate: RationalV01;
  readonly sourceFrameReferences: ReadonlyMap<string, readonly number[]>;
  readonly ffmpeg: string;
  readonly ffprobe?: string;
  readonly probeTimeoutMs?: number;
  readonly mediaTimeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<ReadonlyMap<string, Readonly<PreparedProjectSource>>> {
  const prepared = new Map<string, Readonly<PreparedProjectSource>>();
  try {
    for (const source of input.sources) {
      const result = source.type === "video"
        ? await prepareVideoSource(source, input)
        : await preparePngSource(source, input);
      prepared.set(source.id, Object.freeze(result));
    }
    return prepared;
  } catch (error) {
    await Promise.all(
      [...prepared.values()].map(({ cleanup }) => cleanup?.())
    );
    throw error;
  }
}

export async function cleanupProjectSources(
  sources: ReadonlyMap<string, Readonly<PreparedProjectSource>>
): Promise<void> {
  await Promise.all([...sources.values()].map(({ cleanup }) => cleanup?.()));
}

async function prepareVideoSource(
  source: Extract<SourceDescriptorV01, { readonly type: "video" }>,
  input: Parameters<typeof prepareProjectSources>[0]
): Promise<PreparedProjectSource> {
  const path = await resolveExistingLocalFile(input.root, source.path, true);
  const inputFiles = await fingerprintSourceInputs(input.root, [path], input.signal);
  const ffmpegInput: FfmpegFrameInput = { type: "video", path };
  const redactedSource = `$SOURCE/${source.id}`;
  const probeInvocation = preparedInvocation(
    `${source.id}:probe`,
    "ffprobe",
    createProbeMediaInvocation(path).arguments,
    path,
    redactedSource
  );
  const probe = await probeMedia(
    path,
    input.ffprobe,
    input.signal,
    input.probeTimeoutMs
  );
  validateSourceGeometry(probe, input.canvas, source.id);
  let projectProbe = probe;
  let sourceFrameByProjectFrame: readonly number[] | undefined;
  let duplicatedSourceFrames: readonly number[] = Object.freeze([]);
  let droppedSourceFrames: readonly number[] = Object.freeze([]);
  let warnings: readonly string[] = Object.freeze([]);
  if (source.timing.mode === "exact") {
    if (probe.variableFrameRate || !sameRate(probe.frameRate, input.frameRate)) {
      throw new CompilerError(
        "VFR_UNSUPPORTED",
        `Source ${source.id} does not lie on the project CFR grid`,
        { path: source.path, hint: "Use timing.mode normalize-hold explicitly." }
      );
    }
  } else {
    const timeline = normalizeHoldTimeline(
      probe.frames,
      input.frameRate,
      probe.timeBase
    );
    sourceFrameByProjectFrame = timeline.sourceFrameByOutputFrame;
    duplicatedSourceFrames = timeline.duplicatedSourceFrames;
    droppedSourceFrames = timeline.droppedSourceFrames;
    projectProbe = normalizedProbe(
      probe,
      timeline.sourceFrameByOutputFrame.length,
      input.canvas,
      input.frameRate
    );
    warnings = Object.freeze([
      `${source.id}: normalized to ${String(timeline.sourceFrameByOutputFrame.length)} hold frames`,
      `${source.id}: duplicated ${timeline.duplicatedSourceFrames.join(",") || "none"}`,
      `${source.id}: dropped ${timeline.droppedSourceFrames.join(",") || "none"}`
    ]);
  }
  const references = requiredReferences(
    input.sourceFrameReferences,
    source.id,
    projectProbe.frameCount
  );
  const nativeFrames = references.map((frame) =>
    sourceFrameByProjectFrame?.[frame] ?? frame
  );
  const alphaInvocation = await scanReferencedNativeOpacity(
    ffmpegInput,
    nativeFrames,
    probe,
    input.ffmpeg,
    source.id,
    redactedSource,
    input.signal,
    input.mediaTimeoutMs
  );
  const materialized = await materializeNormalizedRgbaSource({
    source: ffmpegInput,
    probe,
    frameRate: input.frameRate,
    outputWidth: input.canvas.width,
    outputHeight: input.canvas.height,
    sourceFrameByOutputFrame: nativeFrames,
    executable: input.ffmpeg,
    ...(input.mediaTimeoutMs === undefined
      ? {}
      : { timeoutMs: input.mediaTimeoutMs }),
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  try {
    await verifySourceInputFingerprints(
      input.root,
      [path],
      inputFiles,
      input.signal
    );
  } catch (error) {
    await materialized.cleanup().catch(() => undefined);
    throw error;
  }
  return {
    id: source.id,
    input: materialized.input,
    sourceProbe: probe,
    probe: projectProbe === probe
      ? normalizedProbe(probe, probe.frameCount, input.canvas, input.frameRate)
      : projectProbe,
    spoolFrameCount: materialized.frameCount,
    projectFrameToSpoolFrame: frameMap(references),
    inputFiles,
    normalization: sourceFrameByProjectFrame === undefined
      ? Object.freeze({
          mode: "exact" as const,
          projectFrameCount: projectProbe.frameCount,
          selectedProjectFrames: references,
          selectedNativeFrames: Object.freeze([...nativeFrames])
        })
      : Object.freeze({
          mode: "normalize-hold" as const,
          projectFrameCount: projectProbe.frameCount,
          selectedProjectFrames: references,
          selectedNativeFrames: Object.freeze([...nativeFrames]),
          duplicatedSourceFrames,
          droppedSourceFrames
        }),
    alphaAudit: probe.hasAlpha ? "passed" : "skipped-no-alpha",
    invocations: Object.freeze([
      probeInvocation,
      ...(alphaInvocation === null ? [] : [alphaInvocation]),
      preparedInvocation(
        `${source.id}:materialize-rgba`,
        "ffmpeg",
        materialized.invocation.arguments,
        path,
        redactedSource
      )
    ]),
    warnings,
    cleanup: materialized.cleanup
  };
}

async function preparePngSource(
  source: Extract<SourceDescriptorV01, { readonly type: "png-sequence" }>,
  input: Parameters<typeof prepareProjectSources>[0]
): Promise<PreparedProjectSource> {
  const token = `%0${String(source.digits)}d`;
  const pattern = join(
    input.root,
    source.directory,
    `${source.prefix}${token}${source.suffix}`
  );
  const sequence = await inspectPngSequence(
    input.root,
    pattern,
    source.firstNumber,
    source.frameCount,
    input.signal
  );
  const inputFiles = await fingerprintSourceInputs(
    input.root,
    sequence.files,
    input.signal
  );
  if (sequence.frameCount !== source.frameCount) {
    throw new CompilerError(
      "INPUT_INVALID",
      `${source.id} declares ${String(source.frameCount)} PNG frames but found ${String(sequence.frameCount)}`
    );
  }
  const probe = await probePngSequence(
    sequence.pattern,
    sequence.firstFileNumber,
    input.frameRate,
    input.ffprobe,
    input.signal,
    source.frameCount,
    input.probeTimeoutMs
  );
  validateSourceGeometry(probe, input.canvas, source.id);
  const references = requiredReferences(
    input.sourceFrameReferences,
    source.id,
    probe.frameCount
  );
  const ffmpegInput: FfmpegFrameInput = {
    type: "png-sequence",
    path: sequence.pattern,
    firstFileNumber: sequence.firstFileNumber,
    frameRate: input.frameRate
  };
  const redactedSource = `$SOURCE/${source.id}`;
  const probeInvocation = preparedInvocation(
    `${source.id}:probe`,
    "ffprobe",
    createProbePngSequenceInvocation(
      sequence.pattern,
      sequence.firstFileNumber,
      input.frameRate,
      source.frameCount
    ).arguments,
    sequence.pattern,
    redactedSource
  );
  const alphaInvocation = await scanReferencedNativeOpacity(
    ffmpegInput,
    references,
    probe,
    input.ffmpeg,
    source.id,
    redactedSource,
    input.signal,
    input.mediaTimeoutMs
  );
  const materialized = await materializeNormalizedRgbaSource({
    source: ffmpegInput,
    probe,
    frameRate: input.frameRate,
    outputWidth: input.canvas.width,
    outputHeight: input.canvas.height,
    sourceFrameByOutputFrame: references,
    executable: input.ffmpeg,
    ...(input.mediaTimeoutMs === undefined
      ? {}
      : { timeoutMs: input.mediaTimeoutMs }),
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  try {
    await verifySourceInputFingerprints(
      input.root,
      sequence.files,
      inputFiles,
      input.signal
    );
  } catch (error) {
    await materialized.cleanup().catch(() => undefined);
    throw error;
  }
  return {
    id: source.id,
    input: materialized.input,
    sourceProbe: probe,
    probe: normalizedProbe(probe, probe.frameCount, input.canvas, input.frameRate),
    spoolFrameCount: materialized.frameCount,
    projectFrameToSpoolFrame: frameMap(references),
    inputFiles,
    normalization: Object.freeze({
      mode: "exact" as const,
      projectFrameCount: probe.frameCount,
      selectedProjectFrames: references,
      selectedNativeFrames: Object.freeze([...references])
    }),
    alphaAudit: probe.hasAlpha ? "passed" : "skipped-no-alpha",
    invocations: Object.freeze([
      probeInvocation,
      ...(alphaInvocation === null ? [] : [alphaInvocation]),
      preparedInvocation(
        `${source.id}:materialize-rgba`,
        "ffmpeg",
        materialized.invocation.arguments,
        sequence.pattern,
        redactedSource
      )
    ]),
    warnings: Object.freeze([]),
    cleanup: materialized.cleanup
  };
}

export async function fingerprintSourceInputs(
  root: string,
  files: readonly string[],
  signal?: AbortSignal
): Promise<readonly SourceInputFingerprint[]> {
  const results: SourceInputFingerprint[] = [];
  let aggregateBytes = 0;
  for (const file of files) {
    const fingerprint = await fingerprintRegularFile(
      file,
      MAX_AGGREGATE_SOURCE_FILE_BYTES,
      "source input",
      signal
    );
    aggregateBytes += fingerprint.identity.size;
    if (
      !Number.isSafeInteger(aggregateBytes) ||
      aggregateBytes > MAX_AGGREGATE_SOURCE_FILE_BYTES
    ) {
      throw new CompilerError(
        "SOURCE_LIMIT",
        "Aggregate source-file bytes exceed 1 GiB"
      );
    }
    results.push(Object.freeze({
      path: relative(root, file).split(sep).join("/"),
      bytes: fingerprint.identity.size,
      sha256: fingerprint.sha256,
      identity: fingerprint.identity
    }));
  }
  return Object.freeze(results);
}

export async function verifySourceInputFingerprints(
  root: string,
  files: readonly string[],
  expected: readonly SourceInputFingerprint[],
  signal?: AbortSignal
): Promise<void> {
  const actual = await fingerprintSourceInputs(root, files, signal);
  if (
    actual.length !== expected.length ||
    actual.some((file, index) => {
      const before = expected[index];
      return before === undefined ||
        file.path !== before.path ||
        file.sha256 !== before.sha256 ||
        !sameRegularFileIdentity(file.identity, before.identity);
    })
  ) {
    throw new CompilerError(
      "INPUT_INVALID",
      "A source input changed during canonicalization"
    );
  }
}

export function resolvePreparedFrameRange(
  source: Readonly<PreparedProjectSource>,
  startFrame: number,
  endFrame: number
): readonly [number, number] {
  if (endFrame <= startFrame) {
    throw new CompilerError("FRAME_RANGE_INVALID", "Prepared range is empty");
  }
  const start = source.projectFrameToSpoolFrame.get(startFrame);
  if (start === undefined) {
    throw new CompilerError("IO_FAILED", "Prepared source frame is missing");
  }
  for (let frame = startFrame; frame < endFrame; frame += 1) {
    if (source.projectFrameToSpoolFrame.get(frame) !== start + frame - startFrame) {
      throw new CompilerError(
        "IO_FAILED",
        "Prepared source range is not contiguous in the canonical spool"
      );
    }
  }
  return Object.freeze([start, start + endFrame - startFrame]);
}

function normalizedProbe(
  probe: MediaProbe,
  frameCount: number,
  canvas: CanvasV01,
  frameRate: RationalV01
): MediaProbe {
  return Object.freeze({
    ...probe,
    width: canvas.width,
    height: canvas.height,
    frameRate: Object.freeze({ ...frameRate }),
    timeBase: Object.freeze({
      numerator: frameRate.denominator,
      denominator: frameRate.numerator
    }),
    frameCount,
    durationMicros: framesToRoundedMicros(frameCount, frameRate),
    pixelFormat: "rgba",
    hasAlpha: true,
    variableFrameRate: false,
    frames: Object.freeze([])
  });
}

function requiredReferences(
  all: ReadonlyMap<string, readonly number[]>,
  sourceId: string,
  frameCount: number
): readonly number[] {
  const references = all.get(sourceId);
  if (
    references === undefined ||
    references.length < 1 ||
    references.some((frame, index) =>
      !Number.isSafeInteger(frame) ||
      frame < 0 ||
      frame >= frameCount ||
      (index > 0 && frame <= references[index - 1]!)
    )
  ) {
    throw new CompilerError(
      "FRAME_RANGE_INVALID",
      `Source ${sourceId} has invalid or empty frame references`
    );
  }
  return references;
}

function frameMap(frames: readonly number[]): ReadonlyMap<number, number> {
  return new Map(frames.map((frame, index) => [frame, index]));
}

async function scanReferencedNativeOpacity(
  source: FfmpegFrameInput,
  sourceFrames: readonly number[],
  probe: MediaProbe,
  ffmpeg: string,
  sourceId: string,
  redactedSource: string,
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<Readonly<PreparedSourceInvocation> | null> {
  if (!probe.hasAlpha) return null;
  const unique = [...new Set(sourceFrames)].sort((left, right) => left - right);
  const invocation = createNativeAlphaAuditInvocation({
    source,
    sourceFrames: unique
  });
  await scanSelectedNativeOpacity(
    source,
    unique,
    probe.width,
    probe.height,
    ffmpeg,
    signal,
    timeoutMs
  );
  return preparedInvocation(
    `${sourceId}:alpha-audit`,
    "ffmpeg",
    invocation.arguments,
    source.path,
    redactedSource
  );
}

function preparedInvocation(
  operation: string,
  tool: PreparedSourceInvocation["tool"],
  arguments_: readonly string[],
  sourcePath: string,
  redactedSource: string
): Readonly<PreparedSourceInvocation> {
  return Object.freeze({
    operation,
    tool,
    arguments: Object.freeze(arguments_.map((argument) =>
      argument === sourcePath ? redactedSource : argument
    ))
  });
}

function validateSourceGeometry(
  probe: MediaProbe,
  canvas: CanvasV01,
  id: string
): void {
  if (
    probe.width < canvas.width ||
    probe.height < canvas.height ||
    probe.width * canvas.height !== probe.height * canvas.width
  ) {
    throw new CompilerError(
      "SOURCE_LIMIT",
      `Source ${id} must preserve canvas aspect and may not be upscaled`
    );
  }
}

function sameRate(left: RationalV01, right: RationalV01): boolean {
  return BigInt(left.numerator) * BigInt(right.denominator) ===
    BigInt(right.numerator) * BigInt(left.denominator);
}

function framesToRoundedMicros(
  frameCount: number,
  frameRate: RationalV01
): number {
  const denominator = BigInt(frameRate.numerator);
  const numerator =
    BigInt(frameCount) * BigInt(frameRate.denominator) * 1_000_000n;
  const rounded = (numerator + denominator / 2n) / denominator;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CompilerError(
      "SOURCE_LIMIT",
      "Normalized source duration exceeds safe microseconds"
    );
  }
  return Number(rounded);
}
