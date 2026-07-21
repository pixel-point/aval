import {
  parseFrontIndex,
  parseHeader,
  parseManifestPrefix,
  validateCompleteAsset,
  type FormatHeader,
  type ParsedFrontIndex,
  type ParsedManifestPrefix
} from "@pixel-point/aval-format";

import {
  RuntimePlaybackError,
  normalizeRuntimeFailure
} from "./errors.js";
import type { RuntimeFullAssetFormatAdapter } from "./full-asset-fetch.js";

export interface RuntimeRangeAssetFormatAdapter
extends RuntimeFullAssetFormatAdapter {
  parseHeader(bytes: Uint8Array, maximumFileBytes: number): Readonly<FormatHeader>;
  parseManifestPrefix(
    bytes: Uint8Array,
    maximumFileBytes: number
  ): Readonly<ParsedManifestPrefix>;
  parseFrontIndex(
    bytes: Uint8Array,
    maximumFileBytes: number
  ): Readonly<ParsedFrontIndex>;
}

export const DEFAULT_RUNTIME_RANGE_ASSET_FORMAT_ADAPTER:
Readonly<RuntimeRangeAssetFormatAdapter> = Object.freeze({
  parseHeader(bytes: Uint8Array, maximumFileBytes: number) {
    return parseHeader(bytes, { budgets: { maxFileBytes: maximumFileBytes } });
  },
  parseManifestPrefix(bytes: Uint8Array, maximumFileBytes: number) {
    return parseManifestPrefix(bytes, {
      budgets: { maxFileBytes: maximumFileBytes }
    });
  },
  parseFrontIndex(bytes: Uint8Array, maximumFileBytes: number) {
    return parseFrontIndex(bytes, {
      budgets: { maxFileBytes: maximumFileBytes }
    });
  },
  validateCompleteAsset(bytes: Uint8Array, maximumFileBytes: number) {
    return validateCompleteAsset({
      bytes,
      options: { budgets: { maxFileBytes: maximumFileBytes } }
    });
  }
});

export function captureRuntimeRangeAssetFormatAdapter(
  value: RuntimeRangeAssetFormatAdapter
): RuntimeRangeAssetFormatAdapter {
  if (typeof value !== "object" || value === null) adapterFailure();
  let header: unknown;
  let manifest: unknown;
  let front: unknown;
  let complete: unknown;
  try {
    header = Reflect.get(value, "parseHeader");
    manifest = Reflect.get(value, "parseManifestPrefix");
    front = Reflect.get(value, "parseFrontIndex");
    complete = Reflect.get(value, "validateCompleteAsset");
  } catch {
    adapterFailure();
  }
  if (
    typeof header !== "function" ||
    typeof manifest !== "function" ||
    typeof front !== "function" ||
    typeof complete !== "function"
  ) {
    adapterFailure();
  }
  return Object.freeze({
    parseHeader: (bytes: Uint8Array, cap: number) =>
      Reflect.apply(header, value, [bytes, cap]) as Readonly<FormatHeader>,
    parseManifestPrefix: (bytes: Uint8Array, cap: number) =>
      Reflect.apply(manifest, value, [bytes, cap]) as
        Readonly<ParsedManifestPrefix>,
    parseFrontIndex: (bytes: Uint8Array, cap: number) =>
      Reflect.apply(front, value, [bytes, cap]) as Readonly<ParsedFrontIndex>,
    validateCompleteAsset: (bytes: Uint8Array, cap: number) =>
      Reflect.apply(complete, value, [bytes, cap]) as ReturnType<
        RuntimeFullAssetFormatAdapter["validateCompleteAsset"]
      >
  });
}

function adapterFailure(): never {
  throw new RuntimePlaybackError(normalizeRuntimeFailure("load-failure"));
}
