import {
  COMPILE_BUNDLE_H264_PRESETS,
  COMPILE_BUNDLE_H265_PRESETS,
  COMPILE_BUNDLE_VP9_DEADLINES,
  type CompiledManifestInput,
  type VideoCodec as FormatVideoCodec
} from "@pixel-point/aval-format";

/*
 * Keep the compiler's established public names as aliases of the format-owned
 * build-report contract. This prevents the emitted and parsed preset sets from
 * drifting independently.
 */
export const H264_ENCODER_PRESETS = COMPILE_BUNDLE_H264_PRESETS;
export const H265_ENCODER_PRESETS = COMPILE_BUNDLE_H265_PRESETS;
export const VP9_DEADLINES = COMPILE_BUNDLE_VP9_DEADLINES;

export const COMPILER_PROJECT_VERSION = "1.0" as const;
export const MAX_PROCESS_STDERR_BYTES = 1024 * 1024;
export const MAX_PROCESS_OUTPUT_BYTES = Number.MAX_SAFE_INTEGER;
export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

export interface Rational {
  readonly numerator: number;
  readonly denominator: number;
}

export interface Canvas {
  readonly width: number;
  readonly height: number;
  readonly fit: "contain" | "cover" | "fill" | "none";
  readonly pixelAspect: readonly [numerator: number, denominator: number];
  readonly colorSpace: "srgb";
}

export type SourceDescriptor =
  | {
      readonly id: string;
      readonly type: "video";
      readonly path: string;
      readonly timing: {
        readonly mode: "exact" | "normalize-hold";
      };
    }
  | {
      readonly id: string;
      readonly type: "png-sequence";
      readonly directory: string;
      readonly prefix: string;
      readonly digits: number;
      readonly suffix: ".png";
      readonly firstNumber: number;
      readonly frameCount: number;
    };

export type SourceRange = readonly [
  startInclusive: number,
  endExclusive: number
];

export interface SourcePort {
  readonly id: string;
  readonly entryFrame: 0;
  readonly portalFrames: readonly number[];
}

export interface SourceResidencyEndpoint {
  readonly state: string;
  readonly port: string;
  readonly frames: number;
}

interface SourceUnitBase {
  readonly id: string;
  readonly source: string;
  readonly range: SourceRange;
}

export type SourceUnit =
  | (SourceUnitBase & {
      readonly kind: "body";
      readonly playback: "loop" | "finite";
      readonly ports: readonly SourcePort[];
    })
  | (SourceUnitBase & { readonly kind: "bridge" })
  | (SourceUnitBase & { readonly kind: "one-shot" })
  | (SourceUnitBase & {
      readonly kind: "reversible";
      readonly residency: {
        readonly endpoints: readonly [
          SourceResidencyEndpoint,
          SourceResidencyEndpoint
        ];
      };
    });

export interface SourceState {
  readonly id: string;
  readonly bodyUnit: string;
  readonly initialUnit?: string;
}

export type SourceTrigger =
  | { readonly type: "event"; readonly name: string }
  | { readonly type: "completion" };

export type SourceStart =
  | {
      readonly type: "portal";
      readonly sourcePort: string;
      readonly targetPort: string;
      readonly maxWaitFrames: number;
    }
  | {
      readonly type: "finish";
      readonly targetPort: string;
      readonly maxWaitFrames: number;
    }
  | {
      readonly type: "cut";
      readonly targetPort: string;
      readonly maxWaitFrames: 1;
    };

export type SourceTransition =
  | { readonly kind: "locked"; readonly unit: string }
  | {
      readonly kind: "reversible";
      readonly unit: string;
      readonly direction: "forward" | "reverse";
      readonly reverseOf?: string;
    };

/**
 * Ring membership of a turn edge.
 *
 * Authors write `kind: "turn"` with the ring and signed step; expansion emits the
 * same shape with `derived: true` for the edges it generated.
 */
export interface SourceTurnMembership {
  readonly kind?: "turn";
  readonly ring?: string;
  readonly step?: 1 | -1;
  readonly derived?: true;
}

export type SourceEdge =
  | (SourceTurnMembership & {
      readonly id: string;
      readonly from: string;
      readonly to: string;
      readonly trigger?: SourceTrigger;
      readonly start: Exclude<SourceStart, { readonly type: "cut" }>;
      readonly transition?: SourceTransition;
      readonly continuity: "exact-authored" | "exact-reverse";
      readonly targetRunwayFrames?: never;
    })
  | (SourceTurnMembership & {
      readonly id: string;
      readonly from: string;
      readonly to: string;
      readonly trigger?: SourceTrigger;
      readonly start: Extract<SourceStart, { readonly type: "cut" }>;
      readonly transition?: never;
      readonly continuity: "cut";
      readonly targetRunwayFrames: number;
    });

/**
 * One authored departure from the ring default, applied to a single ordered
 * neighbour pair. An override is the only way to give a step its own bridge
 * unit, and it is rejected unless its pair is actually adjacent.
 */
export interface SourceRingOverride {
  readonly from: string;
  readonly to: string;
  readonly mode: "cut" | "unit";
  readonly unit?: string;
  readonly direction?: "forward" | "reverse";
  readonly continuity?: "exact-authored" | "exact-reverse";
}

/** How every step of a ring departs and what it plays, before overrides. */
export interface SourceRingTurn {
  readonly mode: "cut" | "unit";
  readonly start: Exclude<SourceStart, { readonly type: "cut" }>;
  readonly continuity: "exact-authored" | "exact-reverse";
}

export interface SourceRing {
  readonly id: string;
  readonly states: readonly string[];
  readonly cyclic: boolean;
  readonly tieBreak: "forward" | "backward";
  readonly turn: SourceRingTurn;
  readonly maxChainedSteps: number;
  readonly overrides: readonly SourceRingOverride[];
}

export type SourceBindingName =
  | "activate"
  | "engagement.off"
  | "engagement.on"
  | "focus.in"
  | "focus.out"
  | "hidden"
  | "pointer.enter"
  | "pointer.leave"
  | "visible";

export interface SourceBinding {
  readonly source: SourceBindingName;
  readonly event: string;
}

export type H264EncoderPreset = typeof H264_ENCODER_PRESETS[number];
export type H265EncoderPreset = typeof H265_ENCODER_PRESETS[number];
export type Vp9Deadline = typeof VP9_DEADLINES[number];

export type SourceAlphaPolicy = "auto" | "opaque" | "packed";
export type VideoCodec = FormatVideoCodec;
export type SourceRenditionDimension = number | "auto";

export interface SourceRenditionTarget {
  readonly id: string;
  readonly width: SourceRenditionDimension;
  readonly height: SourceRenditionDimension;
  readonly crf: number;
}

export interface NormalizedSourceRenditionTarget {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly crf: number;
}

export interface H264Encoding<R extends SourceRenditionTarget = SourceRenditionTarget>
{
  readonly codec: "h264";
  readonly preset: H264EncoderPreset;
  readonly renditions: readonly R[];
}

export interface H265Encoding<R extends SourceRenditionTarget = SourceRenditionTarget>
{
  readonly codec: "h265";
  readonly preset: H265EncoderPreset;
  readonly threads: number;
  readonly renditions: readonly R[];
}

export interface Vp9Encoding<R extends SourceRenditionTarget = SourceRenditionTarget>
{
  readonly codec: "vp9";
  readonly deadline: Vp9Deadline;
  readonly cpuUsed: number;
  readonly threads: number;
  readonly renditions: readonly R[];
}

export interface Av1TileLayout {
  readonly columns: number;
  readonly rows: number;
}

export interface Av1Encoding<R extends SourceRenditionTarget = SourceRenditionTarget>
{
  readonly codec: "av1";
  readonly bitDepth: 8 | 10;
  readonly cpuUsed: number;
  readonly tiles: Av1TileLayout;
  readonly rowMt: boolean;
  readonly threads: number;
  readonly renditions: readonly R[];
}

export type VideoEncoding<R extends SourceRenditionTarget = SourceRenditionTarget> =
  | H264Encoding<R>
  | H265Encoding<R>
  | Vp9Encoding<R>
  | Av1Encoding<R>;

export interface SourceProject {
  readonly projectVersion: "1.0";
  readonly alpha: SourceAlphaPolicy;
  readonly canvas: Canvas;
  readonly frameRate: Rational;
  readonly sources: readonly SourceDescriptor[];
  readonly encodings: readonly VideoEncoding[];
  readonly units: readonly SourceUnit[];
  readonly initialState: string;
  readonly states: readonly SourceState[];
  readonly edges: readonly SourceEdge[];
  readonly bindings: readonly SourceBinding[];
  /** Absent in projects which author no ring. */
  readonly rings?: readonly SourceRing[];
}

export type NormalizedVideoEncoding = VideoEncoding<NormalizedSourceRenditionTarget>;

export interface NormalizedSourceProject {
  readonly projectVersion: "1.0";
  readonly alpha: SourceAlphaPolicy;
  readonly canvas: Canvas;
  readonly frameRate: Rational;
  readonly sources: readonly SourceDescriptor[];
  readonly encodings: readonly NormalizedVideoEncoding[];
  readonly units: readonly SourceUnit[];
  readonly initialState: string;
  readonly states: readonly SourceState[];
  /** Authored edges plus every step expansion derived from a ring. */
  readonly edges: readonly SourceEdge[];
  readonly bindings: readonly SourceBinding[];
  /** Absent in projects which author no ring. */
  readonly rings?: readonly SourceRing[];
  /** Author-facing notes from ring expansion, such as a shadowed step. */
  readonly ringNotes?: readonly string[];
}

export interface AlphaPixelLocation {
  readonly source: string;
  readonly frame: number;
  readonly x: number;
  readonly y: number;
  readonly alpha: number;
}

export interface AlphaAuditSummary {
  readonly uniqueReferencedFrames: number;
  readonly minimumAlpha: number;
  readonly allOpaque: boolean;
  readonly firstNonopaque: Readonly<AlphaPixelLocation> | null;
}

export interface AlphaPolicyDecision {
  readonly requested: SourceAlphaPolicy;
  readonly selected: Exclude<SourceAlphaPolicy, "auto">;
  readonly audit: Readonly<AlphaAuditSummary>;
  readonly warnings: readonly string[];
}

export interface MediaProbeFrame {
  readonly index: number;
  readonly timestampTicks: number;
  readonly durationTicks: number;
}

export interface MediaProbe {
  readonly width: number;
  readonly height: number;
  readonly frameRate: Rational;
  readonly timeBase: Rational;
  readonly frameCount: number;
  readonly durationMicros: number;
  readonly pixelFormat: string;
  readonly hasAlpha: boolean;
  readonly variableFrameRate: boolean;
  readonly frames: readonly MediaProbeFrame[];
}

export interface ToolProvenance {
  readonly executable: string;
  readonly executableSha256: string;
  readonly executableIdentity: import("./file-fingerprint.js").RegularFileIdentity;
  readonly versionLine: string;
  readonly versionOutputSha256: string;
  readonly configurationLine: string;
  readonly encodersOutputSha256: string;
  readonly calibrationSha256: string;
  readonly ffprobeExecutable: string;
  readonly ffprobeExecutableSha256: string;
  readonly ffprobeExecutableIdentity: import("./file-fingerprint.js").RegularFileIdentity;
  readonly ffprobeVersionLine: string;
  readonly ffprobeVersionOutputSha256: string;
  readonly aggregateMemoryLimit: "derived";
}

export interface CompileInvocationDetails {
  readonly operation: string;
  readonly tool: "ffmpeg" | "ffprobe";
  /** Exact ordered argv with every local path replaced by a stable token. */
  readonly arguments: readonly string[];
}

/** One validated codec asset in an unpublished bundle transaction. */
export interface CompileBundleAssetArtifact {
  readonly codec: VideoCodec;
  readonly filename: `${VideoCodec}.avl`;
  readonly assetBytes: Uint8Array;
  readonly bytes: number;
  readonly sha256: string;
  readonly manifest: CompiledManifestInput;
  readonly invocations: readonly CompileInvocationDetails[];
}

/** All bytes required for one atomic bundle-directory publication. */
export interface CompileBundleArtifact {
  readonly assets: readonly Readonly<CompileBundleAssetArtifact>[];
  readonly buildReport: Readonly<CompileBundleBuildReport>;
  readonly buildReportBytes: Uint8Array;
  readonly provenance: ToolProvenance;
  readonly warnings: readonly string[];
}

export interface CompileBundleBuildReport {
  readonly reportVersion: "1.0";
  readonly assets: readonly Readonly<CompileBundleAssetResult>[];
  readonly sourceMarkup: string;
}

export interface CompileBundleAssetResult {
  readonly codec: VideoCodec;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly type: string;
  readonly integrity: string;
}

export interface CompileBundleResult {
  readonly outputPath: string;
  readonly reportPath: string;
  readonly assets: readonly Readonly<CompileBundleAssetResult>[];
  readonly provenance: ToolProvenance;
  readonly warnings: readonly string[];
  readonly sourceMarkup: string;
}

export interface ProcessLimits {
  readonly timeoutMs?: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
}

interface DirectCompileBaseOptions {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly loop: readonly [startFrame: number, endFrame: number];
  readonly fps?: Rational;
  readonly canvas?: readonly [width: number, height: number];
  readonly frames?: {
    readonly firstNumber: number;
    readonly frameCount: number;
  };
  readonly normalizeVfr?: boolean;
  /** Atomically replace an existing bundle directory. */
  readonly force?: boolean;
  /** Asset-wide alpha selection. Direct input defaults to `auto`. */
  readonly alpha?: SourceAlphaPolicy;
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  /** Lower-only override for FFprobe operations (default/max 15 seconds). */
  readonly probeTimeoutMs?: number;
  /** Optional positive per-FFmpeg-operation timeout in milliseconds. */
  readonly mediaTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type DirectCodecOptions =
  | {
      readonly codec: "h264";
      readonly crf?: number;
      readonly preset?: H264EncoderPreset;
    }
  | {
      readonly codec: "h265";
      readonly crf?: number;
      readonly preset?: H265EncoderPreset;
      readonly threads?: number;
    }
  | {
      readonly codec: "vp9";
      readonly crf?: number;
      readonly deadline?: Vp9Deadline;
      readonly cpuUsed?: number;
      readonly threads?: number;
    }
  | {
      readonly codec: "av1";
      readonly crf?: number;
      readonly bitDepth?: 8 | 10;
      readonly cpuUsed?: number;
      readonly tiles?: Readonly<Av1TileLayout>;
      readonly rowMt?: boolean;
      readonly threads?: number;
    };

/** Direct media lowered into the same canonical one-encoding project pipeline. */
export type DirectCompileOptions = DirectCompileBaseOptions & DirectCodecOptions;

export interface ProjectCompileOptions {
  readonly projectPath: string;
  readonly outputPath: string;
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly probeTimeoutMs?: number;
  readonly mediaTimeoutMs?: number;
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}

export type DirectArtifactOptions =
  Omit<DirectCompileBaseOptions, "outputPath" | "force"> & DirectCodecOptions;
export type ProjectArtifactOptions = Omit<ProjectCompileOptions, "outputPath">;
