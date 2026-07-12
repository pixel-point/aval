import {
  RuntimePlaybackError,
  normalizeRuntimeFailure
} from "./errors.js";

declare const strongEntityTagBrand: unique symbol;

/** Parser-produced, outer-whitespace-normalized strong HTTP entity tag. */
export type StrongEntityTag = string & {
  readonly [strongEntityTagBrand]: true;
};

/** Missing, weak, or malformed values are unavailable for initial pinning. */
export function parseStrongEntityTag(
  value: string | null | undefined
): StrongEntityTag | null {
  if (typeof value !== "string") return null;
  const normalized = trimOuterHttpWhitespace(value);
  if (
    normalized.length < 2 ||
    normalized.startsWith("W/") ||
    normalized[0] !== '"' ||
    normalized[normalized.length - 1] !== '"'
  ) {
    return null;
  }

  for (let index = 1; index < normalized.length - 1; index += 1) {
    const code = normalized.charCodeAt(index);
    if (
      code !== 0x21 &&
      !(code >= 0x23 && code <= 0x7e) &&
      !(code >= 0x80 && code <= 0xff)
    ) {
      return null;
    }
  }
  return normalized as StrongEntityTag;
}

export function strongEntityTagsEqual(
  left: StrongEntityTag,
  right: StrongEntityTag
): boolean {
  return left === right;
}

/** Require the exact pinned tag without retaining the hostile candidate. */
export function requireMatchingStrongEntityTag(
  candidate: string | null | undefined,
  pinned: StrongEntityTag
): StrongEntityTag {
  const validatedPinned = parseStrongEntityTag(pinned);
  if (validatedPinned === null || validatedPinned !== pinned) {
    throw new RangeError("pinned strong entity tag is invalid");
  }
  const parsed = parseStrongEntityTag(candidate);
  if (parsed === null || !strongEntityTagsEqual(parsed, pinned)) {
    throw new RuntimePlaybackError(normalizeRuntimeFailure("entity-changed"));
  }
  return pinned;
}

function trimOuterHttpWhitespace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isHttpWhitespace(value.charCodeAt(start))) start += 1;
  while (end > start && isHttpWhitespace(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

function isHttpWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09;
}
