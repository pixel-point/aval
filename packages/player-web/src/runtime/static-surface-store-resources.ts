import type { StaticSurfaceCacheLease } from "./static-surface-cache.js";

export type StaticSurfaceStoreSurfaceRole =
  | "current"
  | "incoming"
  | "optional";

export interface StaticSurfaceStoreResourceLease
  extends StaticSurfaceCacheLease {
  setRole(role: StaticSurfaceStoreSurfaceRole): void;
}

export interface StaticSurfaceStoreResourceHost {
  reserveDecodedSurface(input: Readonly<{
    staticFrame: string;
    byteLength: number;
    role: "incoming";
  }>): StaticSurfaceStoreResourceLease |
    PromiseLike<StaticSurfaceStoreResourceLease>;
  nextTouchSequence(): number;
}

export interface StaticSurfaceStoreOptions {
  readonly resourceHost?: StaticSurfaceStoreResourceHost;
  readonly retainOptionalSurfaces?: boolean;
}

export interface CapturedSurfaceResourceLease extends StaticSurfaceCacheLease {
  setRole(role: StaticSurfaceStoreSurfaceRole): void;
}

export function normalizeStaticSurfaceStoreOptions(
  value: Readonly<StaticSurfaceStoreOptions>
): Readonly<{
  resourceHost: Readonly<StaticSurfaceStoreResourceHost> | null;
  retainOptionalSurfaces: boolean;
}> {
  validateObject(value, "static surface store options");
  for (const key of Object.keys(value)) {
    if (key !== "resourceHost" && key !== "retainOptionalSurfaces") {
      throw new TypeError("static surface store options contain an unknown field");
    }
  }
  if (
    value.retainOptionalSurfaces !== undefined &&
    typeof value.retainOptionalSurfaces !== "boolean"
  ) {
    throw new TypeError("optional static retention must be boolean");
  }
  const resourceHost = value.resourceHost === undefined
    ? null
    : captureSurfaceResourceHost(value.resourceHost);
  const retainOptionalSurfaces = value.retainOptionalSurfaces ??
    resourceHost !== null;
  if (retainOptionalSurfaces && resourceHost === null) {
    throw new TypeError(
      "optional static retention requires a resource and touch host"
    );
  }
  return Object.freeze({ resourceHost, retainOptionalSurfaces });
}

export function captureSurfaceResourceLease(
  value: StaticSurfaceStoreResourceLease,
  onRelease: () => void
): CapturedSurfaceResourceLease {
  validateObject(value, "static surface resource lease");
  let release: unknown;
  let setRole: unknown;
  try {
    release = Reflect.get(value, "release");
    setRole = Reflect.get(value, "setRole");
  } catch {
    bestEffortRelease(value, release);
    throw new TypeError("static surface resource lease is inaccessible");
  }
  if (typeof release !== "function" || typeof setRole !== "function") {
    bestEffortRelease(value, release);
    throw new TypeError("static surface resource lease is malformed");
  }
  let released = false;
  return Object.freeze({
    setRole(role: StaticSurfaceStoreSurfaceRole): void {
      if (released) throw new Error("static surface resource lease is released");
      if (role !== "current" && role !== "incoming" && role !== "optional") {
        throw new TypeError("static surface resource role is invalid");
      }
      Reflect.apply(setRole, value, [role]);
    },
    release(): void {
      if (released) return;
      released = true;
      try {
        Reflect.apply(release, value, []);
      } finally {
        onRelease();
      }
    }
  });
}

export function safelySetSurfaceRole(
  lease: CapturedSurfaceResourceLease,
  role: StaticSurfaceStoreSurfaceRole
): void {
  try {
    lease.setRole(role);
  } catch {
    // Cleanup continues; the owning lease is still released on eviction.
  }
}

/** Await one incoming-surface lease and retire any unselected late grant. */
export async function awaitSurfaceResourceReservation(
  value: StaticSurfaceStoreResourceLease |
    PromiseLike<StaticSurfaceStoreResourceLease>,
  signal: AbortSignal
): Promise<StaticSurfaceStoreResourceLease> {
  const pending = Promise.resolve(value);
  if (signal.aborted) {
    void pending.then(bestEffortReleaseSurfaceLease, () => undefined);
    throw surfaceReservationAbortReason(signal);
  }
  let remove = (): void => undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    const abort = (): void => reject(surfaceReservationAbortReason(signal));
    try {
      remove = () => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, { once: true });
    } catch (error) {
      reject(error);
    }
  });
  try {
    return await Promise.race([pending, stopped]);
  } catch (error) {
    // Registration may retain its listener and throw without aborting. Every
    // rejected race leaves the reservation unselected, so release a late grant.
    void pending.then(bestEffortReleaseSurfaceLease, () => undefined);
    throw error;
  } finally {
    try { remove(); } catch {}
  }
}

function bestEffortReleaseSurfaceLease(
  value: StaticSurfaceStoreResourceLease
): void {
  if (value === null || typeof value !== "object") return;
  let release: unknown;
  try { release = Reflect.get(value, "release"); } catch { return; }
  if (typeof release !== "function") return;
  try { Reflect.apply(release, value, []); } catch {}
}

function surfaceReservationAbortReason(signal: AbortSignal): DOMException {
  try {
    return signal.reason instanceof DOMException &&
      signal.reason.name === "AbortError"
      ? signal.reason
      : new DOMException("static surface operation aborted", "AbortError");
  } catch {
    return new DOMException("static surface operation aborted", "AbortError");
  }
}

function captureSurfaceResourceHost(
  value: StaticSurfaceStoreResourceHost
): Readonly<StaticSurfaceStoreResourceHost> {
  validateObject(value, "static surface resource host");
  let reserveDecodedSurface: unknown;
  let nextTouchSequence: unknown;
  try {
    reserveDecodedSurface = Reflect.get(value, "reserveDecodedSurface");
    nextTouchSequence = Reflect.get(value, "nextTouchSequence");
  } catch {
    throw new TypeError("static surface resource host is inaccessible");
  }
  if (
    typeof reserveDecodedSurface !== "function" ||
    typeof nextTouchSequence !== "function"
  ) {
    throw new TypeError("static surface resource host is malformed");
  }
  return Object.freeze({
    reserveDecodedSurface: (input: Readonly<{
      staticFrame: string;
      byteLength: number;
      role: "incoming";
    }>) => Reflect.apply(
      reserveDecodedSurface,
      value,
      [input]
    ) as StaticSurfaceStoreResourceLease |
      PromiseLike<StaticSurfaceStoreResourceLease>,
    nextTouchSequence: () => Reflect.apply(
      nextTouchSequence,
      value,
      []
    ) as number
  });
}

function bestEffortRelease(value: object, release: unknown): void {
  if (typeof release !== "function") return;
  try {
    Reflect.apply(release, value, []);
  } catch {
    // Preserve the lease contract failure.
  }
}

function validateObject(value: unknown, label: string): asserts value is object {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`${label} must be an object`);
  }
}
