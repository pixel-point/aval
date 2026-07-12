import type {
  VerifiedBlobPersistentLease,
  VerifiedBlobResourceCategory,
  VerifiedBlobResourceHost
} from "./verified-blob-store.js";

export const MARK_VERIFIED_BLOB_RECLAIMABLE: unique symbol = Symbol(
  "mark verified blob reclaimable"
);

export interface CapturedVerifiedBlobPersistentLease
extends VerifiedBlobPersistentLease {
  markReclaimable(): void;
}

export interface CapturedVerifiedBlobResourceHost {
  readonly reserve: (
    category: VerifiedBlobResourceCategory,
    byteLength: number
  ) => VerifiedBlobPersistentLease | PromiseLike<VerifiedBlobPersistentLease>;
}

export function captureVerifiedBlobResourceHost(
  value: VerifiedBlobResourceHost
): Readonly<CapturedVerifiedBlobResourceHost> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("verified blob resource host must be an object");
  }
  let reserve: unknown;
  try { reserve = Reflect.get(value, "reserve"); } catch {
    throw new TypeError("verified blob resource capability is inaccessible");
  }
  if (typeof reserve !== "function") {
    throw new TypeError("verified blob resource host must provide reserve()");
  }
  return Object.freeze({
    reserve: (
      category: VerifiedBlobResourceCategory,
      byteLength: number
    ) => Reflect.apply(
      reserve,
      value,
      [category, byteLength]
    ) as VerifiedBlobPersistentLease | PromiseLike<VerifiedBlobPersistentLease>
  });
}

export function captureVerifiedBlobPersistentLease(
  value: VerifiedBlobPersistentLease
): CapturedVerifiedBlobPersistentLease {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("verified blob lease must be an object");
  }
  let release: unknown;
  let markReclaimable: unknown;
  try { release = Reflect.get(value, "release"); } catch {
    bestEffortRelease(value, release);
    throw new TypeError("verified blob lease release is inaccessible");
  }
  if (typeof release !== "function") {
    bestEffortRelease(value, release);
    throw new TypeError("verified blob lease must provide release()");
  }
  try {
    markReclaimable = Reflect.get(value, MARK_VERIFIED_BLOB_RECLAIMABLE);
  } catch {
    bestEffortRelease(value, release);
    throw new TypeError("verified blob lease publication is inaccessible");
  }
  if (markReclaimable !== undefined && typeof markReclaimable !== "function") {
    bestEffortRelease(value, release);
    throw new TypeError("verified blob lease publication is malformed");
  }
  let released = false;
  let published = false;
  return Object.freeze({
    markReclaimable(): void {
      if (released) throw new Error("verified blob lease is released");
      if (published) return;
      if (typeof markReclaimable === "function") {
        Reflect.apply(markReclaimable, value, []);
      }
      published = true;
    },
    release(): void {
      if (released) return;
      released = true;
      Reflect.apply(release, value, []);
    }
  });
}

function bestEffortRelease(value: object, release: unknown): void {
  if (typeof release !== "function") return;
  try { Reflect.apply(release, value, []); } catch {}
}
