type RgbaBytes = Uint8Array | Uint8ClampedArray;

/** True when RGBA pixels contain enough visible variation to compare meaningfully. */
export function informativeRgbaPixels(pixels: RgbaBytes): boolean {
  if (pixels.byteLength === 0 || pixels.byteLength % 4 !== 0) return false;
  let minimumRed = 255;
  let minimumGreen = 255;
  let minimumBlue = 255;
  let minimumAlpha = 255;
  let maximumRed = 0;
  let maximumGreen = 0;
  let maximumBlue = 0;
  let maximumAlpha = 0;
  let visibleSignal = false;
  for (let offset = 0; offset < pixels.byteLength; offset += 4) {
    const red = pixels[offset] ?? 0;
    const green = pixels[offset + 1] ?? 0;
    const blue = pixels[offset + 2] ?? 0;
    const alpha = pixels[offset + 3] ?? 0;
    minimumRed = Math.min(minimumRed, red);
    minimumGreen = Math.min(minimumGreen, green);
    minimumBlue = Math.min(minimumBlue, blue);
    minimumAlpha = Math.min(minimumAlpha, alpha);
    maximumRed = Math.max(maximumRed, red);
    maximumGreen = Math.max(maximumGreen, green);
    maximumBlue = Math.max(maximumBlue, blue);
    maximumAlpha = Math.max(maximumAlpha, alpha);
    const luma = (54 * red + 183 * green + 19 * blue) >> 8;
    if (alpha > 16 || luma > 16) visibleSignal = true;
  }
  return visibleSignal && (
    maximumRed - minimumRed >= 16 ||
    maximumGreen - minimumGreen >= 16 ||
    maximumBlue - minimumBlue >= 16 ||
    maximumAlpha - minimumAlpha >= 16
  );
}

/** Allows only bounded conversion rounding and ignores hidden transparent RGB. */
export function equivalentRgbaPixels(
  left: RgbaBytes,
  right: RgbaBytes
): boolean {
  if (
    left.byteLength === 0 || left.byteLength !== right.byteLength ||
    left.byteLength % 4 !== 0
  ) return false;
  for (let offset = 0; offset < left.byteLength; offset += 4) {
    const leftAlpha = left[offset + 3] ?? 0;
    const rightAlpha = right[offset + 3] ?? 0;
    if (Math.abs(leftAlpha - rightAlpha) > 1) return false;
    if (rightAlpha === 0) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      if (Math.abs(
        (left[offset + channel] ?? 0) - (right[offset + channel] ?? 0)
      ) > 3) return false;
    }
  }
  return true;
}

/** Chromium's zero-chroma copy defect yields visible, strongly green RGBA. */
export function resemblesZeroChromaGreen(pixels: RgbaBytes): boolean {
  if (pixels.byteLength === 0 || pixels.byteLength % 4 !== 0) return false;
  const pixelCount = pixels.byteLength / 4;
  const sampleCount = Math.min(pixelCount, 256);
  let visible = 0;
  let greenDominant = 0;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const offset = Math.floor(sample * pixelCount / sampleCount) * 4;
    const red = pixels[offset] ?? 0;
    const green = pixels[offset + 1] ?? 0;
    const blue = pixels[offset + 2] ?? 0;
    const alpha = pixels[offset + 3] ?? 0;
    if (alpha <= 16) continue;
    visible += 1;
    if (green >= 32 && green - red >= 48 && green - blue >= 48) {
      greenDominant += 1;
    }
  }
  return visible > 0 && greenDominant * 4 >= visible * 3;
}
