import type {
  DecodedStaticSurface,
  StaticSurfaceDecodeOptions,
  StaticSurfaceDecoder
} from "./static-surfaces.js";

export interface LeasedStaticPngSource {
  readonly byteLength: number;
  copy(): Uint8Array;
}

export type LeasedStaticPngDecode<TSurface extends DecodedStaticSurface> = (
  source: Readonly<LeasedStaticPngSource>,
  options: Readonly<StaticSurfaceDecodeOptions>
) => Promise<TSurface> | null;

export const LEASED_STATIC_PNG_DECODER: unique symbol = Symbol(
  "leased static PNG decoder"
);

/** @internal Captures the direct symbol capability once at store creation. */
export function captureLeasedStaticPngDecoder<
  TSurface extends DecodedStaticSurface
>(
  decoder: StaticSurfaceDecoder<TSurface>
): LeasedStaticPngDecode<TSurface> | null {
  if (decoder === null || typeof decoder !== "object") {
    throw new TypeError("leased static decoder identity is invalid");
  }
  let decode: unknown;
  try {
    decode = Reflect.get(decoder, LEASED_STATIC_PNG_DECODER);
  } catch {
    throw new TypeError("leased static decoder capability is inaccessible");
  }
  if (decode === undefined) return null;
  if (typeof decode !== "function") {
    throw new TypeError("leased static decoder capability is invalid");
  }
  return (source, options) => Reflect.apply(
    decode,
    decoder,
    [source, options]
  ) as Promise<TSurface> | null;
}
