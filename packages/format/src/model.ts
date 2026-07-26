import type { ValidatedMotionGraph } from "@pixel-point/aval-graph";

export type Id = string;
export type Sha256Hex = string;
export type Rect = readonly [
  x: number,
  y: number,
  width: number,
  height: number
];

export type VideoCodec = "h264" | "h265" | "vp9" | "av1";
export type VideoBitstream = "annex-b" | "frame" | "low-overhead";
export type VideoLayout = "opaque" | "packed-alpha";
export type VideoBitDepth = 8 | 10;

export interface FormatBudgets {
  readonly maxFileBytes: number;
  readonly maxManifestBytes: number;
  readonly maxIndexBytes: number;
  readonly maxChunkBytes: number;
  readonly maxPngBytes: number;
  readonly maxJsonDepth: number;
  readonly maxJsonNodes: number;
  readonly maxJsonStringBytes: number;
  readonly maxStates: number;
  readonly maxEdges: number;
  readonly maxRings: number;
  readonly maxRingStates: number;
  readonly maxUnits: number;
  readonly maxRenditions: number;
  readonly maxBindings: number;
  readonly maxBlobRanges: number;
  readonly maxTotalUnitFrames: number;
  readonly maxChunkRecords: number;
  readonly maxPortsPerBody: number;
  readonly maxReversibleFrames: number;
}

export interface FormatOptions {
  readonly budgets?: Partial<FormatBudgets>;
}

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

export interface Bitrate {
  readonly average: number;
  readonly peak: number;
}

export type AlphaLayout =
  | {
      readonly type: "opaque";
      readonly colorRect: Rect;
    }
  | {
      readonly type: "stacked";
      readonly colorRect: Rect;
      readonly alphaRect: Rect;
    };

/** One quality rung in a single-codec asset. Array order is author preference. */
export interface ProductionRendition {
  readonly id: Id;
  readonly codec: string;
  readonly bitDepth: VideoBitDepth;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly alphaLayout: AlphaLayout;
  readonly bitrate: Bitrate;
}

/** One unit/rendition blob in the global decode-order chunk array. */
export interface UnitChunkSpan {
  readonly rendition: Id;
  readonly chunkStart: number;
  readonly chunkCount: number;
  readonly frameCount: number;
  readonly sha256: Sha256Hex;
}

export interface Port {
  readonly id: Id;
  readonly entryFrame: 0;
  readonly portalFrames: readonly number[];
}

export interface ResidencyEndpoint {
  readonly state: Id;
  readonly port: Id;
  readonly frames: number;
}

interface UnitBase {
  readonly id: Id;
  readonly frameCount: number;
  readonly chunks: readonly UnitChunkSpan[];
}

export type Unit =
  | (UnitBase & {
      readonly kind: "body";
      readonly playback: "loop" | "finite";
      readonly ports: readonly Port[];
    })
  | (UnitBase & { readonly kind: "bridge" })
  | (UnitBase & {
      readonly kind: "reversible";
      readonly residency: {
        readonly endpoints: readonly [ResidencyEndpoint, ResidencyEndpoint];
      };
    })
  | (UnitBase & { readonly kind: "one-shot" });

export interface State {
  readonly id: Id;
  readonly bodyUnit: Id;
  readonly initialUnit?: Id;
}

export type Trigger =
  | { readonly type: "event"; readonly name: Id }
  | { readonly type: "completion" };

export type Start =
  | {
      readonly type: "portal";
      readonly sourcePort: Id;
      readonly targetPort: Id;
      readonly maxWaitFrames: number;
    }
  | {
      readonly type: "finish";
      readonly targetPort: Id;
      readonly maxWaitFrames: number;
    }
  | {
      readonly type: "cut";
      readonly targetPort: Id;
      readonly maxWaitFrames: 1;
    };

export type Transition =
  | { readonly kind: "locked"; readonly unit: Id }
  | {
      readonly kind: "reversible";
      readonly unit: Id;
      readonly direction: "forward" | "reverse";
      readonly reverseOf?: Id;
    };

/** Ring membership carried by a turn edge: one signed step along `ring`. */
interface TurnMembership {
  readonly ring?: Id;
  readonly step?: 1 | -1;
  /** True when the compiler expanded this edge from a ring rather than authoring. */
  readonly derived?: true;
}

interface NonCutEdge extends TurnMembership {
  readonly id: Id;
  readonly from: Id;
  readonly to: Id;
  readonly trigger?: Trigger;
  readonly start: Exclude<Start, { readonly type: "cut" }>;
  readonly transition?: Transition;
  readonly continuity: "exact-authored" | "exact-reverse";
  readonly targetRunwayFrames?: never;
}

interface CutEdge extends TurnMembership {
  readonly id: Id;
  readonly from: Id;
  readonly to: Id;
  readonly trigger?: Trigger;
  readonly start: Extract<Start, { readonly type: "cut" }>;
  readonly transition?: never;
  readonly continuity: "cut";
  readonly targetRunwayFrames: number;
}

export type Edge = NonCutEdge | CutEdge;

/**
 * An ordered axis of states joined by turn edges. Adjacent members are one step
 * apart; a cyclic ring also joins its last member back to its first.
 */
export interface Ring {
  readonly id: Id;
  readonly states: readonly Id[];
  readonly cyclic: boolean;
  readonly tieBreak: "forward" | "backward";
  readonly maxChainedSteps: number;
}

export type BindingSource =
  | "activate"
  | "engagement.off"
  | "engagement.on"
  | "focus.in"
  | "focus.out"
  | "hidden"
  | "pointer.enter"
  | "pointer.leave"
  | "visible";

export interface Binding {
  readonly source: BindingSource;
  readonly event: Id;
}

export interface Readiness {
  readonly policy: "all-routes";
  readonly bootstrapUnits: readonly Id[];
  readonly immediateEdges: readonly Id[];
}

export interface DeclaredLimits {
  readonly maxCompiledBytes: number;
  readonly maxRuntimeBytes: number;
  readonly decodedPixelBytes: number;
  readonly persistentCacheBytes: number;
  readonly runtimeWorkingSetBytes: number;
}

export interface CompiledManifest {
  readonly formatVersion: "1.0";
  readonly generator: string;
  readonly codec: VideoCodec;
  readonly bitstream: VideoBitstream;
  readonly layout: VideoLayout;
  readonly canvas: Canvas;
  readonly frameRate: Rational;
  readonly renditions: readonly ProductionRendition[];
  readonly units: readonly Unit[];
  readonly initialState: Id;
  readonly states: readonly State[];
  readonly edges: readonly Edge[];
  readonly bindings: readonly Binding[];
  /** Omitted entirely by assets which author no ring. */
  readonly rings?: readonly Ring[];
  readonly readiness: Readiness;
  readonly limits: DeclaredLimits;
}

export interface FormatHeader {
  readonly major: 1;
  readonly minor: 0;
  readonly headerLength: 64;
  readonly requiredFeatureFlags: 0;
  readonly declaredFileLength: number;
  readonly manifestOffset: 64;
  readonly manifestLength: number;
  readonly indexOffset: number;
  readonly indexLength: number;
}

/** Fixed-width decode-order metadata for one elementary encoded chunk. */
export interface EncodedChunkRecord {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly presentationTimestamp: number;
  readonly duration: number;
  readonly randomAccess: boolean;
  readonly displayedFrameCount: number;
}

export interface ByteRange {
  readonly offset: number;
  readonly length: number;
}

export interface UnitBlobRange extends ByteRange {
  readonly rendition: Id;
  readonly unit: Id;
  readonly chunkStart: number;
  readonly chunkCount: number;
  readonly frameCount: number;
  readonly sha256: Sha256Hex;
}

export interface ParsedFrontIndex {
  readonly header: FormatHeader;
  readonly manifest: CompiledManifest;
  readonly graph: ValidatedMotionGraph;
  readonly records: readonly EncodedChunkRecord[];
  readonly frontIndexRange: ByteRange;
  readonly unitBlobs: readonly UnitBlobRange[];
}

export interface ValidatedAssetLayout {
  readonly frontIndex: ParsedFrontIndex;
  readonly fileRange: ByteRange;
}

export interface ChunkDigestInput {
  readonly rendition: Id;
  readonly sha256: Sha256Hex;
}

type UnitInputOf<TKind extends Unit["kind"]> = Omit<
  Extract<Unit, { readonly kind: TKind }>,
  "chunks"
> & {
  readonly chunks: readonly ChunkDigestInput[];
};

export type UnitInput =
  | UnitInputOf<"body">
  | UnitInputOf<"bridge">
  | UnitInputOf<"reversible">
  | UnitInputOf<"one-shot">;

export type CompiledManifestInput = Omit<CompiledManifest, "units"> & {
  readonly units: readonly UnitInput[];
};

/** Caller-owned payload plus timeline metadata, identified within one unit. */
export interface EncodedChunkInput {
  readonly rendition: Id;
  readonly unit: Id;
  readonly decodeIndex: number;
  readonly presentationTimestamp: number;
  readonly duration: number;
  readonly randomAccess: boolean;
  readonly displayedFrameCount: number;
  readonly bytes: Uint8Array;
}

export interface CanonicalAssetInput {
  readonly manifest: CompiledManifestInput;
  readonly chunks: readonly EncodedChunkInput[];
}
