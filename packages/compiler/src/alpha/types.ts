export type AlphaCodec = "av1" | "vp9" | "h265" | "h264";
export interface AlphaEncoding {
  readonly codec: AlphaCodec;
  readonly crf?: number;
  readonly preset?: string;
  readonly encoder?: "libaom-av1" | "libsvtav1";
  readonly cpuUsed?: number;
  readonly deadline?: "good" | "best";
  readonly threads?: number;
  readonly bitDepth?: 8 | 10;
  /** Maximum GOP duration in seconds; default two seconds. */
  readonly gop?: number;
  /** Typed libx265 controls. Other encoders reject this object. */
  readonly x265?: {
    readonly aqMode?: 0 | 1 | 2 | 3 | 4;
    readonly aqStrength?: number;
    readonly psyRd?: number;
    readonly psyRdoq?: number;
    readonly rd?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
    readonly rdoqLevel?: 0 | 1 | 2;
    readonly lookahead?: number;
    readonly bframes?: number;
    readonly ref?: number;
    readonly sao?: boolean;
  };
}
export interface AlphaCompileOptions {
  readonly out: string;
  readonly encodings?: readonly AlphaEncoding[];
  readonly fps?: number;
  readonly width?: number;
  readonly height?: number;
  /** Auto packs portrait clips horizontally to reduce the longest decoded side. */
  readonly layout?: "auto" | "vertical" | "horizontal";
  readonly startNumber?: number;
  readonly frames?: number;
  readonly premultiplied?: boolean;
  readonly ffmpeg?: string;
  readonly ffprobe?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** URL prefix for source URLs in generated markup. Default: './'. */
  readonly baseUrl?: string;
  /** Try every CRF for every encoding and keep the smallest qualifying candidate. */
  readonly optimize?: {
    readonly crfs: readonly number[];
    readonly maxAlphaMae: number;
    readonly maxCompositeMae: number;
    /** Cross each codec's preset list with crfs; omit to retain its authored preset. */
    readonly presets?: Partial<Record<AlphaCodec, readonly string[]>>;
  };
}
export interface ResolvedAlphaOptions extends AlphaCompileOptions {
  readonly encodings: readonly Required<AlphaEncoding>[];
  readonly ffmpeg: string;
  readonly ffprobe: string;
}
export interface AlphaSourceDescriptor {
  readonly src: string;
  readonly type: string;
  readonly width: number;
  readonly height: number;
  readonly colorRect: readonly [number, number, number, number];
  readonly alphaRect: readonly [number, number, number, number];
}
export interface AlphaMetrics {
  /** Mean absolute errors on the 0–255 channel scale, over every decoded frame. */
  readonly alphaMae: number;
  readonly compositeMae: number;
  readonly alphaMaxError: number;
  readonly frames: number;
}
export interface AlphaCandidate {
  readonly codec: AlphaCodec;
  readonly crf: number;
  readonly preset: string;
  readonly cpuUsed: number;
  readonly selected: boolean;
  readonly pareto: boolean;
  readonly bytes: number;
  readonly encodeMs: number;
  readonly metrics: AlphaMetrics;
  readonly arguments: readonly string[];
}
export interface AlphaCompileResult {
  readonly version: 1;
  readonly output: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frames: number;
  readonly sources: readonly AlphaSourceDescriptor[];
  readonly candidates: readonly AlphaCandidate[];
  readonly markup: string;
}
