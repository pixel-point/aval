import {
  maximumAvcDecodedRgbaBytes,
  type CompiledManifestV01,
  type RenditionV01
} from "@rendered-motion/format";

import type {
  RuntimeAssetCatalog,
  RuntimeCatalogAccessUnit
} from "./asset-catalog.js";
import {
  MAX_PLAYER_RUNTIME_BYTES,
  STREAMING_TEXTURE_LAYER_COUNT,
  checkedByteNumber,
  checkedByteSum,
  checkedRgbaBytes,
  roundedGpuAllocationBytes,
  validatePositiveSafeInteger
} from "./checked-runtime-bytes.js";
import type { InteractionCachePlan } from "./interaction-cache-plan.js";

export const RESOURCE_DECODE_SURFACE_COUNT = 12;
export const MIN_RESOURCE_RING_CAPACITY = 6;
export const MAX_RESOURCE_RING_CAPACITY = 12;

export interface RuntimeResourceCatalogView {
  readonly ownedByteLength: number;
  readonly manifest: Readonly<CompiledManifestV01>;
  readonly records: Pick<RuntimeAssetCatalog["records"], "require">;
}

export interface RuntimeResourcePlanInput {
  readonly catalog: RuntimeResourceCatalogView;
  readonly rendition: string;
  readonly interactionCache: Readonly<InteractionCachePlan>;
  readonly ringCapacity: number;
  readonly hostMaxRuntimeBytes?: number;
}

export interface RuntimeResourcePlan {
  readonly rendition: string;
  readonly ringCapacity: number;
  readonly outstandingFrameLimit: typeof RESOURCE_DECODE_SURFACE_COUNT;
  readonly effectiveCapBytes: number;
  readonly manifestCapBytes: number;
  readonly hostCapBytes: number;
  readonly ownedAssetBytes: number;
  readonly maximumEncodedWindowBytes: number;
  readonly decodedBytesPerSurface: number;
  readonly decodedSurfaceBytes: number;
  readonly persistentLayerBytes: number;
  readonly persistentAllocationBytes: number;
  readonly streamingLayerBytes: number;
  readonly streamingAllocationBytes: number;
  readonly stagingBytes: number;
  readonly staticSwapBytes: number;
  readonly staticSwapAllocationBytes: number;
  /** The ring leases the twelve decoded surfaces already charged above. */
  readonly ringAdditionalBytes: 0;
  readonly totalBytes: number;
}

/** Build the exact one-player steady-state plan for one selected candidate. */
export function createRuntimeResourcePlan(
  input: RuntimeResourcePlanInput
): Readonly<RuntimeResourcePlan> {
  validateObject(input, "runtime resource plan input");
  validateObject(input.catalog, "runtime resource catalog");
  validateObject(input.interactionCache, "interaction cache plan");
  validatePositiveSafeInteger(input.ringCapacity, "presentation ring capacity");
  if (
    input.ringCapacity < MIN_RESOURCE_RING_CAPACITY ||
    input.ringCapacity > MAX_RESOURCE_RING_CAPACITY
  ) {
    throw new RangeError("presentation ring capacity must be from 6 to 12");
  }

  const manifest = input.catalog.manifest;
  const rendition = requireOpaqueRendition(manifest, input.rendition);
  if (
    input.interactionCache.rendition !== rendition.id ||
    input.interactionCache.width !== rendition.codedWidth ||
    input.interactionCache.height !== rendition.codedHeight
  ) {
    throw new RangeError("interaction cache does not match the selected rendition");
  }
  const expectedPersistentBytes = checkedRgbaBytes(
    rendition.codedWidth,
    rendition.codedHeight,
    input.interactionCache.layerCount,
    "persistent layer bytes"
  );
  if (
    checkedByteNumber(expectedPersistentBytes, "persistent layer bytes") !==
    input.interactionCache.persistentBytes
  ) {
    throw new RangeError("interaction cache byte accounting is inconsistent");
  }

  validatePositiveSafeInteger(
    input.catalog.ownedByteLength,
    "owned complete asset bytes"
  );
  validatePositiveSafeInteger(
    manifest.limits.maxRuntimeBytes,
    "manifest maxRuntimeBytes"
  );
  const hostCap = input.hostMaxRuntimeBytes ?? MAX_PLAYER_RUNTIME_BYTES;
  validatePositiveSafeInteger(hostCap, "host runtime byte cap");
  const effectiveCap = Math.min(
    MAX_PLAYER_RUNTIME_BYTES,
    manifest.limits.maxRuntimeBytes,
    hostCap
  );

  const ownedAssetBytes = BigInt(input.catalog.ownedByteLength);
  const maximumEncodedWindow = BigInt(maximumActualEncodedWindowBytes(
    input.catalog,
    rendition.id,
    RESOURCE_DECODE_SURFACE_COUNT
  ));
  const decodedPerSurface = BigInt(maximumAvcDecodedRgbaBytes(
    rendition.codedWidth,
    rendition.codedHeight
  ));
  const decodedSurfaces = decodedPerSurface *
    BigInt(RESOURCE_DECODE_SURFACE_COUNT);
  const persistent = expectedPersistentBytes;
  const persistentAllocation = roundedGpuAllocationBytes(persistent);
  const codedRgba = checkedRgbaBytes(
    rendition.codedWidth,
    rendition.codedHeight,
    1,
    "coded RGBA bytes"
  );
  const streaming = codedRgba * BigInt(STREAMING_TEXTURE_LAYER_COUNT);
  const streamingAllocation = roundedGpuAllocationBytes(streaming);
  const logicalRgba = checkedRgbaBytes(
    manifest.canvas.width,
    manifest.canvas.height,
    1,
    "logical static RGBA bytes"
  );
  const staging = codedRgba > logicalRgba ? codedRgba : logicalRgba;
  const staticSwap = logicalRgba * 2n;
  const staticSwapAllocation = roundedGpuAllocationBytes(staticSwap);
  const total = checkedByteSum([
    ownedAssetBytes,
    maximumEncodedWindow,
    decodedSurfaces,
    persistentAllocation,
    streamingAllocation,
    staging,
    staticSwapAllocation
  ], "runtime resource total");
  if (total > BigInt(effectiveCap)) {
    throw new RangeError(
      `runtime resource total ${total.toString()} exceeds effective cap ${String(effectiveCap)}`
    );
  }

  return Object.freeze({
    rendition: rendition.id,
    ringCapacity: input.ringCapacity,
    outstandingFrameLimit: RESOURCE_DECODE_SURFACE_COUNT,
    effectiveCapBytes: effectiveCap,
    manifestCapBytes: manifest.limits.maxRuntimeBytes,
    hostCapBytes: hostCap,
    ownedAssetBytes: input.catalog.ownedByteLength,
    maximumEncodedWindowBytes: checkedByteNumber(
      maximumEncodedWindow,
      "maximum encoded window bytes"
    ),
    decodedBytesPerSurface: checkedByteNumber(
      decodedPerSurface,
      "decoded bytes per surface"
    ),
    decodedSurfaceBytes: checkedByteNumber(
      decodedSurfaces,
      "decoded surface bytes"
    ),
    persistentLayerBytes: input.interactionCache.persistentBytes,
    persistentAllocationBytes: checkedByteNumber(
      persistentAllocation,
      "persistent allocation bytes"
    ),
    streamingLayerBytes: checkedByteNumber(streaming, "streaming layer bytes"),
    streamingAllocationBytes: checkedByteNumber(
      streamingAllocation,
      "streaming allocation bytes"
    ),
    stagingBytes: checkedByteNumber(staging, "staging bytes"),
    staticSwapBytes: checkedByteNumber(staticSwap, "static swap bytes"),
    staticSwapAllocationBytes: checkedByteNumber(
      staticSwapAllocation,
      "static swap allocation bytes"
    ),
    ringAdditionalBytes: 0,
    totalBytes: checkedByteNumber(total, "runtime resource total")
  });
}

/**
 * Find the greatest exact encoded-byte sum accepted by the sequential worker.
 * A window may begin at any frame. Inside an occurrence it must advance in
 * local-frame order; only a complete unit boundary may start a new independently
 * decodable unit occurrence. This excludes impossible jumps between large
 * mid-unit samples while covering every legal M5 worker occurrence sequence.
 */
export function maximumActualEncodedWindowBytes(
  catalog: RuntimeResourceCatalogView,
  rendition: string,
  frameLimit = RESOURCE_DECODE_SURFACE_COUNT
): number {
  validatePositiveSafeInteger(frameLimit, "encoded window frame limit");
  const manifest = catalog.manifest;
  requireOpaqueRendition(manifest, rendition);
  const nodes: {
    readonly record: Readonly<RuntimeCatalogAccessUnit>;
    readonly next: number | null;
  }[] = [];
  const firstNodes: number[] = [];

  for (const unit of manifest.units) {
    const firstNode = nodes.length;
    firstNodes.push(firstNode);
    for (let localFrame = 0; localFrame < unit.frameCount; localFrame += 1) {
      const record = catalog.records.require(rendition, unit.id, localFrame);
      validatePositiveSafeInteger(
        record.range.length,
        `encoded sample ${unit.id}/${String(localFrame)} bytes`
      );
      nodes.push({
        record,
        next: localFrame + 1 < unit.frameCount ? nodes.length + 1 : null
      });
    }
  }
  if (nodes.length < 1) {
    throw new RangeError("selected rendition has no encoded samples");
  }

  let previous = nodes.map(({ record }) => BigInt(record.range.length));
  let maximum = previous.reduce(
    (largest, value) => value > largest ? value : largest,
    0n
  );
  for (let frames = 2; frames <= frameLimit; frames += 1) {
    let greatestOccurrenceStart = 0n;
    for (const first of firstNodes) {
      const value = previous[first];
      if (value !== undefined && value > greatestOccurrenceStart) {
        greatestOccurrenceStart = value;
      }
    }
    const current = nodes.map((node) => {
      const continuation = node.next === null
        ? greatestOccurrenceStart
        : previous[node.next]!;
      return BigInt(node.record.range.length) + continuation;
    });
    for (const value of current) if (value > maximum) maximum = value;
    previous = current;
  }
  return checkedByteNumber(maximum, "maximum encoded window bytes");
}

function requireOpaqueRendition(
  manifest: Readonly<CompiledManifestV01>,
  rendition: string
): Extract<RenditionV01, { readonly profile: "avc-annexb-opaque-v0" }> {
  const selected = manifest.renditions.find(({ id }) => id === rendition);
  if (selected?.profile !== "avc-annexb-opaque-v0") {
    throw new RangeError("selected resource rendition must be opaque AVC");
  }
  return selected;
}

function validateObject(value: unknown, label: string): void {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`${label} must be an object`);
  }
}
