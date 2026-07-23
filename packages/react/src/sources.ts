import type {
  AvalCrossOrigin,
  AvalFit,
  AvalMotion,
  AvalSourceCodec
} from "@pixel-point/aval-element";
import { SOURCE_CODEC_PRIORITY } from "@pixel-point/aval-element";

import type { AvalSources, UseAvalOptions } from "./types.js";

export const REACT_SOURCE_CODEC_PRIORITY = SOURCE_CODEC_PRIORITY;

const SOURCE_CODEC_SET = new Set<string>(REACT_SOURCE_CODEC_PRIORITY);

export interface NormalizedAvalSource {
  readonly codec: AvalSourceCodec;
  readonly src: string;
}

export interface AvalCallbacks {
  readonly onReady: UseAvalOptions["onReady"];
  readonly onRequestedStateChange: UseAvalOptions["onRequestedStateChange"];
  readonly onVisualStateChange: UseAvalOptions["onVisualStateChange"];
  readonly onTransitionStart: UseAvalOptions["onTransitionStart"];
  readonly onTransitionEnd: UseAvalOptions["onTransitionEnd"];
  readonly onError: UseAvalOptions["onError"];
}

export interface NormalizedAvalRenderOptions {
  readonly sources: readonly Readonly<NormalizedAvalSource>[];
  readonly sourceKey: string;
  readonly state: string | undefined;
  readonly autoplay: boolean;
  readonly autoBind: boolean;
  readonly motion: AvalMotion | undefined;
  readonly fit: AvalFit | undefined;
  readonly crossOrigin: AvalCrossOrigin | undefined;
}

export interface NormalizedUseAvalOptions {
  readonly render: Readonly<NormalizedAvalRenderOptions>;
  readonly callbacks: Readonly<AvalCallbacks>;
}

export function normalizeSources(
  sources: AvalSources
): readonly Readonly<NormalizedAvalSource>[] {
  if (sources === null || typeof sources !== "object" || Array.isArray(sources)) {
    throw new TypeError("AVAL React sources must be a codec-keyed object");
  }
  for (const key of Reflect.ownKeys(sources)) {
    if (typeof key !== "string" || !SOURCE_CODEC_SET.has(key)) {
      throw new TypeError(
        `AVAL React source codec is unsupported: ${String(key)}`
      );
    }
  }
  const normalized: NormalizedAvalSource[] = [];
  for (const codec of REACT_SOURCE_CODEC_PRIORITY) {
    if (!Object.prototype.hasOwnProperty.call(sources, codec)) continue;
    const value = sources[codec];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(`AVAL React ${codec} source must be a non-empty URL string`);
    }
    normalized.push(Object.freeze({ codec, src: value }));
  }
  if (normalized.length === 0) {
    throw new TypeError("AVAL React sources must include at least one codec URL");
  }
  return Object.freeze(normalized);
}

export function normalizeUseAvalOptions(
  options: Readonly<UseAvalOptions>
): Readonly<NormalizedUseAvalOptions> {
  if (options === null || typeof options !== "object") {
    throw new TypeError("useAval options must be an object");
  }
  const sources = normalizeSources(options.sources);
  if (options.autoplay !== undefined && typeof options.autoplay !== "boolean") {
    throw new TypeError("useAval autoplay must be a boolean");
  }
  if (options.autoBind !== undefined && typeof options.autoBind !== "boolean") {
    throw new TypeError("useAval autoBind must be a boolean");
  }
  const render = Object.freeze({
    sources,
    sourceKey: JSON.stringify(sources.map(({ codec, src }) => [codec, src])),
    state: options.state,
    autoplay: options.autoplay ?? true,
    autoBind: options.autoBind ?? true,
    motion: options.motion,
    fit: options.fit,
    crossOrigin: options.crossOrigin
  });
  const callbacks = Object.freeze({
    onReady: options.onReady,
    onRequestedStateChange: options.onRequestedStateChange,
    onVisualStateChange: options.onVisualStateChange,
    onTransitionStart: options.onTransitionStart,
    onTransitionEnd: options.onTransitionEnd,
    onError: options.onError
  });
  return Object.freeze({ render, callbacks });
}

export function sameRenderOptions(
  left: Readonly<NormalizedAvalRenderOptions>,
  right: Readonly<NormalizedAvalRenderOptions>
): boolean {
  return left.sourceKey === right.sourceKey &&
    left.state === right.state &&
    left.autoplay === right.autoplay &&
    left.autoBind === right.autoBind &&
    left.motion === right.motion &&
    left.fit === right.fit &&
    left.crossOrigin === right.crossOrigin;
}
