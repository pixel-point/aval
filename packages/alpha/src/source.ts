import { AvalAlphaError, type AlphaOptions, type AlphaSource } from "./types.js";

/** Shared startup validation for direct players and framework option snapshots. */
export function resolvePlaybackOptions(options: AlphaOptions) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647 || !Array.isArray(options.sources)) {
    throw new AvalAlphaError("invalid-source", "Invalid sources or startup timeout");
  }
  return { timeoutMs, sources: Array.from(options.sources, validateSource) };
}

export function validateSource(source: AlphaSource): AlphaSource {
  if (!source || typeof source.src !== "string" || !source.src.trim() ||
    source.type !== undefined && typeof source.type !== "string" ||
    !Number.isSafeInteger(source.width) || source.width < 1 ||
    !Number.isSafeInteger(source.height) || source.height < 1) throw invalid();
  for (const rect of [source.colorRect, source.alphaRect]) {
    if (!Array.isArray(rect) || rect.length !== 4 ||
      rect[2] < 1 || rect[3] < 1 || rect[0] + rect[2] > source.width ||
    rect[1] + rect[3] > source.height) throw invalid();
    for (const value of rect) if (!Number.isSafeInteger(value) || value < 0) throw invalid();
  }
  const [c, a] = [source.colorRect, source.alphaRect];
  if (c[2] !== a[2] || c[3] !== a[3] ||
    c[0] < a[0] + a[2] && a[0] < c[0] + c[2] &&
    c[1] < a[1] + a[3] && a[1] < c[1] + c[3]) throw invalid();
  return { ...source, colorRect: [...c], alphaRect: [...a] };
}

export function sourceFromElement(element: HTMLSourceElement): AlphaSource {
  const values = (element.getAttribute("data-layout") ?? "").trim().split(/\s+/u).map(Number);
  if (values.length !== 10) throw invalid();
  return validateSource({
    src: element.src, type: element.type,
    width: values[0]!, height: values[1]!,
    colorRect: [values[2]!, values[3]!, values[4]!, values[5]!],
    alphaRect: [values[6]!, values[7]!, values[8]!, values[9]!]
  });
}

function invalid(): AvalAlphaError {
  return new AvalAlphaError("invalid-source", "A source needs a URL, packed dimensions and matching, nonoverlapping color/alpha rectangles");
}
