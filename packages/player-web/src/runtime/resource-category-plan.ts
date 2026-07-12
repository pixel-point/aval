import {
  RUNTIME_BYTE_CATEGORIES,
  type RuntimeByteCategory,
  type RuntimeCategoryBytesSnapshot
} from "./model.js";
import type { RuntimeResourceAllocationSnapshot } from "./resource-plan.js";

export type RuntimeResourceAllocationField = Exclude<
  keyof RuntimeResourceAllocationSnapshot,
  "totalBytes"
>;

/** Sole mapping from frozen M6 peak terms into M7's closed byte categories. */
export const RUNTIME_RESOURCE_FIELD_CATEGORIES = Object.freeze({
  ownedAssetBytes: "asset-full",
  maximumEncodedWindowBytes: "worker-transfer",
  decoderEncodedWindowBytes: "worker-transfer",
  decodedSurfaceBytes: "decoder-output",
  persistentAllocationBytes: "persistent-animation",
  streamingAllocationBytes: "streaming-texture",
  frameStagingBytes: "frame-staging",
  staticDecodePngCopyBytes: "png-copy",
  staticDecodeOwnedZlibBytes: "png-zlib",
  staticDecodeWorkingPeakBytes: "png-scratch",
  currentStaticSurfaceAllocationBytes: "current-static-surface",
  incomingStaticSurfaceAllocationBytes: "incoming-static-surface",
  animatedCanvasBackingAllocationBytes: "animated-canvas-backing",
  staticCanvasBackingAllocationBytes: "static-canvas-backing"
} as const satisfies Readonly<
  Record<RuntimeResourceAllocationField, RuntimeByteCategory>
>);

export interface RuntimeResourceCategoryPlan {
  readonly entries: readonly Readonly<RuntimeCategoryBytesSnapshot>[];
  readonly totalBytes: number;
}

/** Validate and group one exact allocation snapshot before reserving leases. */
export function createRuntimeResourceCategoryPlan(
  snapshot: Readonly<RuntimeResourceAllocationSnapshot>
): Readonly<RuntimeResourceCategoryPlan> {
  if (typeof snapshot !== "object" || snapshot === null) {
    throw new TypeError("runtime resource allocation snapshot must be an object");
  }
  const grouped = new Map<RuntimeByteCategory, number>();
  let totalBytes = 0;
  try {
    for (const [field, category] of Object.entries(
      RUNTIME_RESOURCE_FIELD_CATEGORIES
    ) as Array<[RuntimeResourceAllocationField, RuntimeByteCategory]>) {
      const bytes = snapshot[field];
      requireNonNegativeSafeInteger(bytes, `runtime allocation ${field}`);
      totalBytes = checkedAdd(totalBytes, bytes, "runtime allocation total");
      grouped.set(
        category,
        checkedAdd(
          grouped.get(category) ?? 0,
          bytes,
          `runtime allocation category ${category}`
        )
      );
    }
    requireNonNegativeSafeInteger(
      snapshot.totalBytes,
      "runtime allocation declared total"
    );
    if (snapshot.totalBytes !== totalBytes) {
      throw new RangeError("runtime allocation snapshot does not reconcile");
    }
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) throw error;
    throw new TypeError("runtime resource allocation snapshot is inaccessible");
  }

  const entries = Object.freeze(RUNTIME_BYTE_CATEGORIES.flatMap((category) => {
    const bytes = grouped.get(category) ?? 0;
    return bytes === 0 ? [] : [Object.freeze({ category, bytes })];
  }));
  return Object.freeze({ entries, totalBytes });
}

function requireNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function checkedAdd(left: number, right: number, label: string): number {
  if (left > Number.MAX_SAFE_INTEGER - right) {
    throw new RangeError(`${label} exceeds the safe-integer range`);
  }
  return left + right;
}
