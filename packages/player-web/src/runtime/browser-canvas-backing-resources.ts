import {
  checkedByteNumber,
  roundedGpuAllocationBytes
} from "./checked-runtime-bytes.js";
import type { PresentationGeometry } from "./presentation-geometry.js";
import type { RuntimeCanvasResourcePlan } from "./static-resource-plan.js";

export interface BrowserCanvasBackingResourceInput {
  readonly animatedAllocationBytes: number;
  readonly staticAllocationBytes: number;
}

export interface BrowserCanvasBackingResourceTransition {
  /** Optional freshness proof used by asynchronous production admission. */
  readonly assertActive?: () => void;
  commit(): void;
  rollback(): void;
}

/** Synchronous transaction owner used before either canvas backing mutates. */
export interface BrowserCanvasBackingResourceHost {
  /** True when growth may await page-pressure reclamation. */
  readonly asynchronous?: boolean;
  /** Primed constructors are sync once; every later growth is async. */
  readonly asynchronousAfterInitial?: boolean;
  beginTransition(
    input: Readonly<BrowserCanvasBackingResourceInput>
  ): BrowserCanvasBackingResourceTransition |
    PromiseLike<BrowserCanvasBackingResourceTransition>;
  release(): void;
}

export interface PresentationResourceReservation {
  readonly effectiveCapBytes: number;
  readonly nonCanvasBytes: number;
  readonly maximumRawBackingBytes: number;
}

export function createPresentationResourceReservation(
  plan: Readonly<RuntimeCanvasResourcePlan>
): Readonly<PresentationResourceReservation> {
  if (plan === null || typeof plan !== "object") {
    throw new TypeError("canvas resource plan must be an object");
  }
  const effectiveCapBytes = plan.effectiveCapBytes;
  const totalBytes = plan.totalBytes;
  const animatedCanvasBackingAllocationBytes =
    plan.animatedCanvasBackingAllocationBytes;
  const staticCanvasBackingAllocationBytes =
    plan.staticCanvasBackingAllocationBytes;
  for (const value of [
    effectiveCapBytes,
    totalBytes,
    animatedCanvasBackingAllocationBytes,
    staticCanvasBackingAllocationBytes
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("canvas resource plan bytes are invalid");
    }
  }
  const nonCanvasBytes = totalBytes -
    animatedCanvasBackingAllocationBytes -
    staticCanvasBackingAllocationBytes;
  const combinedAllocationBudget = effectiveCapBytes - nonCanvasBytes;
  if (nonCanvasBytes < 0 || combinedAllocationBudget < 2) {
    throw new RangeError("canvas resource plan has no backing allocation budget");
  }
  // Each equal plane is charged ceil(raw * 5 / 4). Invert that frozen
  // rounding exactly, then return the combined raw cap used by geometry.
  const perPlaneAllocation = Math.floor(combinedAllocationBudget / 2);
  const rawPerPlane = Math.floor(perPlaneAllocation * 4 / 5);
  const combinedRaw = rawPerPlane * 2;
  if (!Number.isSafeInteger(combinedRaw) || combinedRaw < 8) {
    throw new RangeError("canvas resource plan cannot hold two backing pixels");
  }
  return Object.freeze({
    effectiveCapBytes,
    nonCanvasBytes,
    maximumRawBackingBytes: combinedRaw
  });
}

export function assertResourceReservations(
  reservations: Iterable<Readonly<PresentationResourceReservation>>,
  geometry: Readonly<PresentationGeometry>
): void {
  for (const reservation of reservations) {
    if (
      liveResourceTotal(reservation, geometry.byteTerms.bytesPerPlane) >
      reservation.effectiveCapBytes
    ) {
      throw new RangeError("presentation resize exceeds an admitted resource cap");
    }
  }
}

export function liveResourceTotal(
  reservation: Readonly<PresentationResourceReservation>,
  rawBytesPerPlane: number
): number {
  const allocation = checkedByteNumber(
    roundedGpuAllocationBytes(rawBytesPerPlane),
    "presentation backing allocation"
  );
  const total = reservation.nonCanvasBytes + allocation * 2;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RangeError("live presentation resource total is unsafe");
  }
  return total;
}

export function canvasBackingAllocationBytes(
  geometry: Readonly<PresentationGeometry>
): number {
  return checkedByteNumber(
    roundedGpuAllocationBytes(geometry.byteTerms.bytesPerPlane),
    "presentation canvas backing allocation"
  );
}

export function safelyRollbackBackingTransition(
  transition: BrowserCanvasBackingResourceTransition | null
): void {
  if (transition === null) return;
  try {
    transition.rollback();
  } catch {
    // Canvas rollback/disposal remains authoritative over accounting cleanup.
  }
}

export function safelyReleaseBackingResources(
  resources: Readonly<BrowserCanvasBackingResourceHost> | null
): void {
  if (resources === null) return;
  try {
    resources.release();
  } catch {
    // Terminal canvas cleanup continues across a hostile accounting host.
  }
}
