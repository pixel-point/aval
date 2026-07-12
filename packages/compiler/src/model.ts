import type {
  AvcRenditionInspection,
  BindingV01,
  CanvasV01,
  CompiledManifestInputV01,
  EdgeV01,
  PortV01,
  RationalV01,
  ResidencyEndpointV01
} from "@rendered-motion/format";

export type { RationalV01 };

export const COMPILER_PROJECT_VERSION = "0.1" as const;
export const MAX_SOURCE_DIMENSION = 4_096;
export const MAX_SOURCE_DURATION_SECONDS = 30;
export const MAX_SOURCE_FRAMES = 1_800;
export const MAX_PROCESS_STDERR_BYTES = 1024 * 1024;
export const MAX_PROCESS_OUTPUT_BYTES = 32 * 1024 * 1024;
export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
export const DEFAULT_MEDIA_TIMEOUT_MS = 120_000;
/** @deprecated Use the operation-specific timeout constants. */
export const DEFAULT_PROCESS_TIMEOUT_MS = DEFAULT_MEDIA_TIMEOUT_MS;

export type SourceDescriptorV01 =
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

export type SourceRangeV01 = readonly [
  startInclusive: number,
  endExclusive: number
];

interface SourceUnitBaseV01 {
  readonly id: string;
  readonly source: string;
  readonly range: SourceRangeV01;
}

export type SourceUnitV01 =
  | (SourceUnitBaseV01 & {
      readonly kind: "body";
      readonly playback: "loop" | "finite";
      readonly ports: readonly PortV01[];
    })
  | (SourceUnitBaseV01 & { readonly kind: "bridge" })
  | (SourceUnitBaseV01 & { readonly kind: "one-shot" })
  | (SourceUnitBaseV01 & {
      readonly kind: "reversible";
      readonly residency: {
        readonly endpoints: readonly [
          ResidencyEndpointV01,
          ResidencyEndpointV01
        ];
      };
    });

export interface SourceStateV01 {
  readonly id: string;
  readonly bodyUnit: string;
  readonly initialUnit?: string;
  readonly poster?: {
    readonly source: string;
    readonly frame: number;
  };
}

export interface OpaqueRenditionTargetV01 {
  readonly id: string;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly bitrate: {
    readonly average: number;
    readonly peak: number;
  };
}

export interface SourceProjectV01 {
  readonly projectVersion: "0.1";
  readonly profile: "avc-annexb-opaque-v0";
  readonly canvas: CanvasV01;
  readonly frameRate: RationalV01;
  readonly sources: readonly SourceDescriptorV01[];
  readonly renditions: readonly OpaqueRenditionTargetV01[];
  readonly units: readonly SourceUnitV01[];
  readonly initialState: string;
  readonly states: readonly SourceStateV01[];
  readonly edges: readonly EdgeV01[];
  readonly bindings: readonly BindingV01[];
}

export interface MediaProbeFrame {
  readonly index: number;
  readonly timestampTicks: number;
  readonly durationTicks: number;
}

export interface MediaProbe {
  readonly width: number;
  readonly height: number;
  readonly frameRate: RationalV01;
  readonly timeBase: RationalV01;
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

export interface CompileSourceDetails {
  readonly id: string;
  readonly type: SourceDescriptorV01["type"] | "direct-video" | "direct-png-sequence";
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  readonly frameRate: RationalV01;
  readonly durationMicros: number;
  readonly pixelFormat: string;
  readonly hasAlpha: boolean;
  readonly variableFrameRate: boolean;
  readonly timeBase: RationalV01;
  readonly frames: readonly MediaProbeFrame[];
  readonly inputFiles: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly identity: import("./file-fingerprint.js").RegularFileIdentity;
  }[];
  readonly normalization:
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
  readonly alphaAudit: "passed" | "skipped-no-alpha";
  readonly warnings: readonly string[];
}

export interface CompileRenditionDetails {
  readonly id: string;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly bitrate: {
    readonly average: number;
    readonly peak: number;
  };
  readonly encodedBytes: number;
  readonly accessUnits: number;
  readonly inspection: AvcRenditionInspection;
  readonly canonicalizations: readonly {
    readonly unitId: string;
    readonly constraintSet2Canonicalized: boolean;
  }[];
}

export interface CompileStaticDetails {
  readonly id: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly states: readonly string[];
}

export interface CompileContinuityDetails {
  readonly name: string;
  readonly kind: "loop" | "intro" | "departure" | "arrival" | "cut";
  readonly status: "pass" | "cut";
  readonly from: {
    readonly unit: string;
    readonly frame: number | null;
    readonly direction: "forward" | "reverse" | "runtime";
  };
  readonly to: {
    readonly unit: string;
    readonly frame: number;
    readonly direction: "forward" | "reverse";
  };
  readonly metrics: {
    readonly boundaryRms: number;
    readonly alphaBoundaryRms: number;
    readonly neighborP95: number;
    readonly alphaNeighborP95: number;
    readonly identicalBoundary: boolean;
    readonly repeatedEndpointPause: boolean;
  } | null;
}

export interface CompileInvocationDetails {
  readonly operation: string;
  readonly tool: "ffmpeg" | "ffprobe";
  /** Exact ordered argv with every local path replaced by a stable token. */
  readonly arguments: readonly string[];
}

/** Structured facts captured by the compiler, without machine-local paths. */
export interface CompileBuildDetails {
  readonly detailsVersion: "0.1";
  readonly mode: "project" | "direct-video" | "direct-png-sequence";
  readonly projectFile: {
    readonly bytes: number;
    readonly sha256: string;
  } | null;
  readonly manifest: CompiledManifestInputV01;
  readonly sources: readonly CompileSourceDetails[];
  readonly renditions: readonly CompileRenditionDetails[];
  readonly statics: readonly CompileStaticDetails[];
  readonly invocations: readonly CompileInvocationDetails[];
  readonly accessUnits: number;
  readonly encodedPayloadBytes: number;
  readonly staticPayloadBytes: number;
  readonly normalization: readonly string[];
  readonly continuity: readonly CompileContinuityDetails[];
}

/** A complete, validated compile product that has not touched its destination. */
export interface CompileArtifact {
  readonly assetBytes: Uint8Array;
  readonly bytes: number;
  readonly sha256: string;
  readonly provenance: ToolProvenance;
  readonly warnings: readonly string[];
  readonly buildDetails: CompileBuildDetails;
}

export interface ProcessLimits {
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
}

export interface DirectCompileOptions {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly loop: readonly [startFrame: number, endFrame: number];
  readonly fps?: RationalV01;
  readonly canvas?: readonly [width: number, height: number];
  readonly frames?: {
    readonly firstNumber: number;
    readonly frameCount: number;
  };
  readonly normalizeVfr?: boolean;
  readonly bitrate?: {
    readonly average: number;
    readonly peak: number;
  };
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  /** Lower-only override for FFprobe operations (default/max 15 seconds). */
  readonly probeTimeoutMs?: number;
  /** Lower-only override for FFmpeg decode/encode operations (default/max 120 seconds). */
  readonly mediaTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface ProjectCompileOptions {
  readonly projectPath: string;
  readonly outputPath: string;
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly probeTimeoutMs?: number;
  readonly mediaTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type DirectArtifactOptions = Omit<DirectCompileOptions, "outputPath">;
export type ProjectArtifactOptions = Omit<ProjectCompileOptions, "outputPath">;

export interface CompileResult {
  readonly outputPath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly provenance: ToolProvenance;
  readonly warnings: readonly string[];
  readonly buildDetails: CompileBuildDetails;
}
