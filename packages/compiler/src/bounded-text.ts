const encoder = new TextEncoder();

/** Replace lone surrogates and truncate without splitting one UTF-8 scalar. */
export function boundedUtf8Text(value: string, maximumBytes: number): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 3) {
    throw new RangeError("maximumBytes must be a safe integer of at least three");
  }
  let normalized = "";
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0)!;
    normalized += codePoint >= 0xd800 && codePoint <= 0xdfff ? "�" : scalar;
  }
  if (encoder.encode(normalized).byteLength <= maximumBytes) return normalized;

  let result = "";
  let length = 0;
  const limit = maximumBytes - 3;
  for (const scalar of normalized) {
    const width = encoder.encode(scalar).byteLength;
    if (length + width > limit) break;
    result += scalar;
    length += width;
  }
  return `${result}…`;
}
