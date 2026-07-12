import type {
  AccessUnitInputV01,
  DeclaredLimitsV01
} from "@rendered-motion/format";
import { maximumAvcDecodedRgbaBytes } from "@rendered-motion/format";

import { CompilerError } from "../diagnostics.js";
import type { SourceProjectV01 } from "../model.js";

const MAX_COMPILED_BYTES = 32 * 1024 * 1024;
const MAX_RUNTIME_BYTES = 64 * 1024 * 1024;

/** Compute the conservative M5 one-rendition runtime budget from real bytes. */
export function estimateRuntimeLimits(
  project: SourceProjectV01,
  accessUnits: readonly AccessUnitInputV01[]
): DeclaredLimitsV01 {
  const decodedPixelBytes = Math.max(...project.renditions.map((rendition) =>
    maximumAvcDecodedRgbaBytes(
      rendition.codedWidth,
      rendition.codedHeight
    )
  ));
  const reversibleFrames = project.units.reduce((total, unit) =>
    checkedSum(
      total,
      unit.kind === "reversible" ? unit.range[1] - unit.range[0] : 0,
      "reversible frame count"
    ), 0);
  const runwayFrames = project.units.reduce((total, unit) => {
    if (unit.kind !== "reversible") return total;
    return unit.residency.endpoints.reduce(
      (subtotal, endpoint) =>
        checkedSum(subtotal, endpoint.frames, "residency runway frames"),
      total
    );
  }, 0);
  const cutFrames = project.edges.reduce(
    (total, edge) => checkedSum(
      total,
      edge.start.type === "cut" ? (edge.targetRunwayFrames ?? 0) : 0,
      "cut runway frames"
    ),
    0
  );
  const persistentFrames = checkedSum(
    checkedSum(reversibleFrames, runwayFrames, "persistent frame count"),
    cutFrames,
    "persistent frame count"
  );
  const persistentCacheBytes = checkedProduct(
    [persistentFrames, decodedPixelBytes],
    "persistent cache bytes"
  );

  const encodedByRendition = new Map<string, number>();
  for (const sample of accessUnits) {
    encodedByRendition.set(
      sample.rendition,
      checkedSum(
        encodedByRendition.get(sample.rendition) ?? 0,
        sample.bytes.byteLength,
        "encoded rendition bytes"
      )
    );
  }
  const largestEncodedRendition = Math.max(0, ...encodedByRendition.values());
  const canvasPixelBytes = checkedProduct(
    [project.canvas.width, project.canvas.height, 4],
    "canvas pixel bytes"
  );
  const decoderRingBytes = checkedProduct(
    [12, decodedPixelBytes],
    "decoder ring bytes"
  );
  const runtimeWorkingSetBytes = [
    persistentCacheBytes,
    decoderRingBytes,
    largestEncodedRendition,
    canvasPixelBytes
  ].reduce((total, value) =>
    checkedSum(total, value, "runtime working-set bytes"), 0);
  if (runtimeWorkingSetBytes > MAX_RUNTIME_BYTES) {
    throw new CompilerError(
      "SOURCE_LIMIT",
      "Compiled runtime estimate exceeds 64 MiB"
    );
  }
  return Object.freeze({
    maxCompiledBytes: MAX_COMPILED_BYTES,
    maxRuntimeBytes: MAX_RUNTIME_BYTES,
    decodedPixelBytes,
    persistentCacheBytes,
    runtimeWorkingSetBytes
  });
}

function checkedSum(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new CompilerError("SOURCE_LIMIT", `${label} exceeds safe arithmetic`);
  }
  return result;
}

function checkedProduct(values: readonly number[], label: string): number {
  return values.reduce((result, value) => {
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      (value !== 0 && result > Math.floor(Number.MAX_SAFE_INTEGER / value))
    ) {
      throw new CompilerError("SOURCE_LIMIT", `${label} exceeds safe arithmetic`);
    }
    return result * value;
  }, 1);
}
