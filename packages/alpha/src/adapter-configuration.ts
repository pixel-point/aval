import { resolvePlaybackOptions } from "./source.js";
import type { AlphaAdapterOptions, AlphaConfiguration } from "./adapter-types.js";

/** Pure render-time snapshot; commit it only after the framework commits. */
export function createAlphaConfiguration(options: AlphaAdapterOptions): AlphaConfiguration {
  const validated = resolvePlaybackOptions(options);
  const sources = validated.sources.map((source) => {
    return Object.freeze({
      src: source.src, type: source.type ?? "", width: source.width, height: source.height,
      colorRect: Object.freeze(source.colorRect), alphaRect: Object.freeze(source.alphaRect)
    });
  });
  const snapshot = Object.freeze({
    ...options, sources: Object.freeze(sources), timeoutMs: validated.timeoutMs,
    crossOrigin: options.crossOrigin ?? "anonymous"
  });
  return Object.freeze({ options: snapshot, key: JSON.stringify([sources, snapshot.crossOrigin, snapshot.timeoutMs]) });
}
