/** Pixel rectangle in the decoded packed video: x, y, width, height. */
export type AlphaRect = readonly [number, number, number, number];

export interface AlphaSource {
  readonly src: string;
  readonly type?: string;
  /** Decoded packed dimensions, including the mask and padding. */
  readonly width: number;
  readonly height: number;
  readonly colorRect: AlphaRect;
  readonly alphaRect: AlphaRect;
}

export type AlphaErrorCode = "invalid-source" | "unsupported-source" | "rendering" | "media" | "disposed";

export class AvalAlphaError extends Error {
  public override readonly name = "AvalAlphaError";
  public constructor(public readonly code: AlphaErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export interface AlphaOptions {
  readonly sources: readonly AlphaSource[];
  readonly autoplay?: boolean;
  readonly loop?: boolean;
  readonly crossOrigin?: "anonymous" | "use-credentials";
  /** Per-candidate startup deadline; defaults to 15 seconds. */
  readonly timeoutMs?: number;
  readonly onError?: (error: AvalAlphaError) => void;
  readonly onAutoplayBlocked?: (error: unknown) => void;
}

export interface AlphaPlayer {
  /** Resolves after the first successful transparent draw, independently of autoplay. */
  readonly ready: Promise<void>;
  readonly video: HTMLVideoElement;
  readonly source: AlphaSource | undefined;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): Promise<void>;
  destroy(): void;
}
