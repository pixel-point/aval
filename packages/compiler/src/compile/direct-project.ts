import { basename, dirname, extname, parse, resolve } from "node:path";

import { CompilerError } from "../diagnostics.js";
import { discoverFfmpeg } from "../ffmpeg/discovery.js";
import { mediaTimeout } from "../ffmpeg/encode-unit.js";
import {
  createProbeMediaInvocation,
  createProbePngSequenceInvocation,
  probeMedia,
  probePngSequence,
  probeTimeout
} from "../ffmpeg/probe.js";
import { inspectPngSequence } from "../input/png-sequence.js";
import { resolveExistingLocalFile } from "../local-path.js";
import type {
  CompileInvocationDetails,
  DirectArtifactOptions,
  MediaProbe,
  NormalizedSourceProject,
  NormalizedVideoEncoding,
  Rational,
  SourceDescriptor,
  SourceProject,
  ToolProvenance
} from "../model.js";
import { validateSourceProject } from "../source-project-schema.js";
import { resolveDirectCanvas } from "./direct-canvas.js";
import { buildDirectFramePlan } from "./frame-plan.js";
import { normalizeHoldTimeline } from "./normalize-timeline.js";

const DEFAULT_THREADS = 8;

export interface DirectProjectLowering {
  readonly project: Readonly<NormalizedSourceProject>;
  readonly sourceRoot: string;
  readonly provenance: Readonly<ToolProvenance>;
  readonly invocations: readonly Readonly<CompileInvocationDetails>[];
  readonly warnings: readonly string[];
}

/** Preflight direct media and lower it to the canonical one-source project. */
export async function lowerDirectInputToProject(
  options: DirectArtifactOptions
): Promise<Readonly<DirectProjectLowering>> {
  probeTimeout(options.probeTimeoutMs);
  mediaTimeout(options.mediaTimeoutMs);
  const inputPath = resolve(options.inputPath);
  const provenance = await discoverFfmpeg(
    options.ffmpegPath,
    options.signal,
    options.ffprobePath,
    [options.codec]
  );
  const source = inputPath.includes("%")
    ? await preflightPngSource(options, inputPath, provenance.ffprobeExecutable)
    : await preflightVideoSource(options, inputPath, provenance.ffprobeExecutable);
  const normalized = normalizedPlanProbe(source.probe, options, source.kind);
  const plan = buildDirectFramePlan(
    normalized.probe,
    options.loop,
    normalized.frameRate
  );
  const canvas = resolveDirectCanvas(source.probe, options.canvas);
  const authored = directProject({
    options,
    source: source.descriptor,
    canvas,
    frameRate: plan.frameRate,
    plan
  });
  const project = validateSourceProject(authored);
  return Object.freeze({
    project,
    sourceRoot: source.root,
    provenance,
    invocations: Object.freeze([source.invocation]),
    warnings: plan.warnings
  });
}

interface DirectSourcePreflight {
  readonly kind: "video" | "png-sequence";
  readonly root: string;
  readonly descriptor: SourceDescriptor;
  readonly probe: Readonly<MediaProbe>;
  readonly invocation: Readonly<CompileInvocationDetails>;
}

async function preflightVideoSource(
  options: DirectArtifactOptions,
  inputPath: string,
  ffprobe: string
): Promise<Readonly<DirectSourcePreflight>> {
  if (!new Set([".mov", ".mp4", ".m4v"]).has(extname(inputPath).toLowerCase())) {
    throw new CompilerError(
      "INPUT_INVALID",
      "Direct video input must use .mov, .mp4, or .m4v"
    );
  }
  const path = await resolveExistingLocalFile(dirname(inputPath), inputPath, false);
  const root = dirname(path);
  const probe = await probeMedia(
    path,
    ffprobe,
    options.signal,
    options.probeTimeoutMs
  );
  return Object.freeze({
    kind: "video" as const,
    root,
    descriptor: Object.freeze({
      id: "direct",
      type: "video" as const,
      path: basename(path),
      timing: Object.freeze({
        mode: options.normalizeVfr === true
          ? "normalize-hold" as const
          : "exact" as const
      })
    }),
    probe,
    invocation: pathFreeInvocation(
      "direct:preflight-probe",
      createProbeMediaInvocation(path).arguments,
      path
    )
  });
}

async function preflightPngSource(
  options: DirectArtifactOptions,
  inputPath: string,
  ffprobe: string
): Promise<Readonly<DirectSourcePreflight>> {
  if (options.fps === undefined) {
    throw new CompilerError("INPUT_INVALID", "PNG patterns require --fps");
  }
  if (options.frames === undefined) {
    throw new CompilerError(
      "INPUT_INVALID",
      "PNG patterns require an explicit frame selection"
    );
  }
  if (options.normalizeVfr === true) {
    throw new CompilerError(
      "INPUT_INVALID",
      "PNG sequences already use the explicit --fps grid"
    );
  }
  const sequence = await inspectPngSequence(
    dirname(inputPath),
    inputPath,
    options.frames.firstNumber,
    options.frames.frameCount,
    options.signal
  );
  const token = directPngToken(basename(sequence.pattern));
  const sequenceDirectory = dirname(sequence.pattern);
  const directoryName = basename(sequenceDirectory);
  if (directoryName === "" || sequenceDirectory === parse(sequenceDirectory).root) {
    throw new CompilerError(
      "PATH_OUTSIDE_ROOT",
      "Direct PNG sequences must be stored below a named parent directory"
    );
  }
  const probe = await probePngSequence(
    sequence.pattern,
    sequence.firstFileNumber,
    options.fps,
    ffprobe,
    options.signal,
    options.frames.frameCount,
    options.probeTimeoutMs
  );
  return Object.freeze({
    kind: "png-sequence" as const,
    root: dirname(sequenceDirectory),
    descriptor: Object.freeze({
      id: "direct",
      type: "png-sequence" as const,
      directory: directoryName,
      prefix: token.prefix,
      digits: token.digits,
      suffix: ".png" as const,
      firstNumber: options.frames.firstNumber,
      frameCount: options.frames.frameCount
    }),
    probe,
    invocation: pathFreeInvocation(
      "direct:preflight-probe",
      createProbePngSequenceInvocation(
        sequence.pattern,
        sequence.firstFileNumber,
        options.fps,
        options.frames.frameCount
      ).arguments,
      sequence.pattern
    )
  });
}

function directPngToken(fileName: string): {
  readonly prefix: string;
  readonly digits: number;
} {
  const match = /^([^%]+)%0([1-9]|1[0-2])d\.png$/u.exec(fileName);
  if (match === null) {
    throw new CompilerError(
      "INPUT_INVALID",
      "Direct PNG input must use <prefix>%0Nd.png with N from 1 through 12"
    );
  }
  return Object.freeze({ prefix: match[1]!, digits: Number(match[2]) });
}

function normalizedPlanProbe(
  probe: Readonly<MediaProbe>,
  options: DirectArtifactOptions,
  sourceKind: DirectSourcePreflight["kind"]
): Readonly<{ readonly probe: MediaProbe; readonly frameRate?: Rational }> {
  if (sourceKind === "png-sequence" || options.normalizeVfr !== true) {
    return Object.freeze({
      probe,
      ...(options.fps === undefined ? {} : { frameRate: options.fps })
    });
  }
  if (options.fps === undefined) {
    throw new CompilerError(
      "VFR_UNSUPPORTED",
      "VFR normalization requires an explicit rational --fps"
    );
  }
  const timeline = normalizeHoldTimeline(
    probe.frames,
    options.fps,
    probe.timeBase
  );
  const normalizedProbe: MediaProbe = Object.freeze({
    ...probe,
    frameRate: Object.freeze({ ...options.fps }),
    timeBase: Object.freeze({
      numerator: options.fps.denominator,
      denominator: options.fps.numerator
    }),
    frameCount: timeline.sourceFrameByOutputFrame.length,
    durationMicros: framesToRoundedMicros(
      timeline.sourceFrameByOutputFrame.length,
      options.fps
    ),
    variableFrameRate: false,
    frames: Object.freeze([])
  });
  return Object.freeze({ probe: normalizedProbe, frameRate: options.fps });
}

function directProject(input: {
  readonly options: DirectArtifactOptions;
  readonly source: SourceDescriptor;
  readonly canvas: Readonly<{ readonly width: number; readonly height: number }>;
  readonly frameRate: Rational;
  readonly plan: ReturnType<typeof buildDirectFramePlan>;
}): Readonly<SourceProject> {
  const intro = input.plan.units.find(({ kind }) => kind === "one-shot");
  const body = input.plan.units.find(({ kind }) => kind === "body");
  if (body === undefined) {
    throw new CompilerError("INPUT_INVALID", "Direct frame plan has no body unit");
  }
  const units: SourceProject["units"] = Object.freeze([
    ...(intro === undefined ? [] : [Object.freeze({
      id: intro.id,
      kind: "one-shot" as const,
      source: "direct",
      range: Object.freeze([intro.startFrame, intro.endFrame] as const)
    })]),
    Object.freeze({
      id: body.id,
      kind: "body" as const,
      source: "direct",
      range: Object.freeze([body.startFrame, body.endFrame] as const),
      playback: "loop" as const,
      ports: Object.freeze([])
    })
  ]);
  return Object.freeze({
    projectVersion: "1.0" as const,
    alpha: input.options.alpha ?? "auto",
    canvas: Object.freeze({
      width: input.canvas.width,
      height: input.canvas.height,
      fit: "contain" as const,
      pixelAspect: Object.freeze([1, 1] as const),
      colorSpace: "srgb" as const
    }),
    frameRate: Object.freeze({ ...input.frameRate }),
    sources: Object.freeze([input.source]),
    encodings: Object.freeze([directEncoding(input.options, input.canvas)]),
    units,
    initialState: "default",
    states: Object.freeze([Object.freeze({
      id: "default",
      bodyUnit: body.id,
      ...(intro === undefined ? {} : { initialUnit: intro.id })
    })]),
    edges: Object.freeze([]),
    bindings: Object.freeze([]),
    rings: Object.freeze([])
  });
}

function directEncoding(
  options: DirectArtifactOptions,
  canvas: Readonly<{ readonly width: number; readonly height: number }>
): NormalizedVideoEncoding {
  const rendition = Object.freeze({
    id: "video.main",
    width: canvas.width,
    height: canvas.height,
    crf: options.crf ?? defaultCrf(options.codec)
  });
  switch (options.codec) {
    case "h264":
      return Object.freeze({
        codec: options.codec,
        preset: options.preset ?? "medium",
        renditions: Object.freeze([rendition])
      });
    case "h265":
      return Object.freeze({
        codec: options.codec,
        preset: options.preset ?? "medium",
        threads: options.threads ?? DEFAULT_THREADS,
        renditions: Object.freeze([rendition])
      });
    case "vp9":
      return Object.freeze({
        codec: options.codec,
        deadline: options.deadline ?? "good",
        cpuUsed: options.cpuUsed ?? 0,
        threads: options.threads ?? DEFAULT_THREADS,
        renditions: Object.freeze([rendition])
      });
    case "av1":
      return Object.freeze({
        codec: options.codec,
        bitDepth: options.bitDepth ?? 8,
        cpuUsed: options.cpuUsed ?? 4,
        tiles: options.tiles ?? Object.freeze({ columns: 1, rows: 1 }),
        rowMt: options.rowMt ?? false,
        threads: options.threads ?? DEFAULT_THREADS,
        renditions: Object.freeze([rendition])
      });
  }
}

function defaultCrf(codec: DirectArtifactOptions["codec"]): number {
  switch (codec) {
    case "h264": return 20;
    case "h265": return 32;
    case "vp9": return 40;
    case "av1": return 30;
  }
}

function pathFreeInvocation(
  operation: string,
  arguments_: readonly string[],
  sourcePath: string
): Readonly<CompileInvocationDetails> {
  return Object.freeze({
    operation,
    tool: "ffprobe" as const,
    arguments: Object.freeze(arguments_.map((argument) =>
      argument.split(sourcePath).join("$SOURCE/direct")
    ))
  });
}

function framesToRoundedMicros(
  frameCount: number,
  frameRate: Rational
): number {
  const denominator = BigInt(frameRate.numerator);
  const numerator =
    BigInt(frameCount) * BigInt(frameRate.denominator) * 1_000_000n;
  const rounded = (numerator + denominator / 2n) / denominator;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CompilerError("SOURCE_LIMIT", "Normalized duration is too large");
  }
  return Number(rounded);
}
