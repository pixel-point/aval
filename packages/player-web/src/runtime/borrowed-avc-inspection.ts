import {
  inspectAvcAnnexBRendition,
  type AvcConstrainedBaselineProfile,
  type AvcRenditionInspection
} from "@rendered-motion/format";

import type { RuntimeAssetCatalog } from "./asset-catalog.js";

export const RUNTIME_CATALOG_AVC_INSPECTION: unique symbol = Symbol(
  "runtime catalog AVC inspection"
);

export interface BorrowedAvcAccessUnitPlan {
  readonly blobKey: string;
  readonly relativeOffset: number;
  readonly byteLength: number;
  readonly key: boolean;
}

export interface BorrowedAvcUnitPlan {
  readonly id: string;
  readonly accessUnits: readonly Readonly<BorrowedAvcAccessUnitPlan>[];
}

export interface BorrowedAvcRenditionPlan {
  readonly profile: Readonly<AvcConstrainedBaselineProfile>;
  readonly units: readonly Readonly<BorrowedAvcUnitPlan>[];
}

type BorrowVerifiedRange = (
  key: string,
  relativeOffset: number,
  byteLength: number
) => Uint8Array;

/** @internal Returns only a byte-free immutable inspection result. */
export function inspectRuntimeCatalogAvcRendition(
  catalog: RuntimeAssetCatalog,
  rendition: string,
  profile: Readonly<AvcConstrainedBaselineProfile>
): Readonly<AvcRenditionInspection> {
  return catalog[RUNTIME_CATALOG_AVC_INSPECTION](rendition, profile);
}

/**
 * @internal The trusted format inspector consumes borrowed views synchronously
 * and returns a byte-free scalar summary. The borrow function never escapes.
 */
export function inspectBorrowedAvcRendition(
  plan: Readonly<BorrowedAvcRenditionPlan>,
  borrow: BorrowVerifiedRange
): Readonly<AvcRenditionInspection> {
  if (plan === null || typeof plan !== "object" || !Array.isArray(plan.units)) {
    throw new TypeError("borrowed AVC inspection plan is malformed");
  }
  if (typeof borrow !== "function") {
    throw new TypeError("borrowed AVC byte authority is unavailable");
  }
  const units = plan.units.map(
    (unit: Readonly<BorrowedAvcUnitPlan>) => Object.freeze({
      id: unit.id,
      accessUnits: Object.freeze(unit.accessUnits.map((
        accessUnit: Readonly<BorrowedAvcAccessUnitPlan>
      ) => {
        const bytes = borrow(
          accessUnit.blobKey,
          accessUnit.relativeOffset,
          accessUnit.byteLength
        );
        if (
          !(bytes instanceof Uint8Array) ||
          bytes.byteLength !== accessUnit.byteLength
        ) {
          throw new TypeError("borrowed AVC access unit is malformed");
        }
        return Object.freeze({ bytes, key: accessUnit.key });
      }))
    })
  );
  return inspectAvcAnnexBRendition(Object.freeze({
    profile: plan.profile,
    units: Object.freeze(units)
  }));
}
