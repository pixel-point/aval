import type {
  BoundedBodyByteLease,
  BoundedBodyByteResourceHost
} from "./bounded-body-reader.js";
import {
  RuntimePlaybackError,
  isRuntimePlaybackError,
  normalizeRuntimeFailure
} from "./errors.js";
import {
  createLoadOperationDeadline,
  type LoadWatchdogTimerHost,
  type RuntimeLoadOperationDeadline
} from "./load-watchdogs.js";
import type { RuntimeAssetSessionResources } from "./runtime-asset-session.js";
import {
  createPlayerBlobAssemblyResourceHost,
  createPlayerBodyResourceHost,
  createPlayerFullBodyResourceHost,
  createPlayerVerifiedBlobResourceHost
} from "./player-resource-hosts.js";
import { PlayerResourceAccount } from "./player-resource-account.js";
import type { PlayerResourceAdmission } from "./player-resource-admission.js";

/**
 * Build the four narrowly scoped resource hosts required by one asset session.
 * Whole-file sources intentionally use a different host so they remain
 * quarantined until integrity and complete-format validation both succeed.
 */
export function createPlayerRuntimeAssetSessionResources(
  account: PlayerResourceAccount,
  admission?: Readonly<PlayerResourceAdmission>
): Readonly<RuntimeAssetSessionResources> {
  if (!(account instanceof PlayerResourceAccount)) {
    throw new TypeError("runtime asset resources require a player account");
  }
  return Object.freeze({
    metadata: createPlayerBodyResourceHost(account, "asset-metadata", admission),
    response: createPlayerBodyResourceHost(account, "response-body", admission),
    full: createPlayerFullBodyResourceHost(account, admission),
    assembly: createPlayerBlobAssemblyResourceHost(account, admission),
    verified: createPlayerVerifiedBlobResourceHost(account, admission)
  });
}

/** Internal capability capture shared by full and metadata ownership. */
export async function reserveRuntimeAssetBytes(
  resources: BoundedBodyByteResourceHost,
  byteLength: number
): Promise<BoundedBodyByteLease> {
  let reserve: unknown;
  try { reserve = Reflect.get(resources, "reserve"); } catch {}
  if (typeof reserve !== "function") throw resourceError(byteLength);
  let raw: BoundedBodyByteLease;
  try {
    raw = await Promise.resolve(Reflect.apply(
      reserve,
      resources,
      [byteLength]
    ) as BoundedBodyByteLease | PromiseLike<BoundedBodyByteLease>);
  } catch (cause) {
    if (isRuntimePlaybackError(cause)) throw cause;
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw resourceError(byteLength);
  }
  let release: unknown;
  let promote: unknown;
  try {
    release = Reflect.get(raw, "release");
    promote = Reflect.get(raw, "promoteToAssetFull");
  } catch {}
  if (
    typeof release !== "function" ||
    (promote !== undefined && typeof promote !== "function")
  ) {
    if (typeof release === "function") {
      try { Reflect.apply(release, raw, []); } catch {}
    }
    throw resourceError(byteLength);
  }
  let released = false;
  let promoted = false;
  return Object.freeze({
    promoteToAssetFull(): void {
      if (released) throw resourceError(byteLength);
      if (promoted) return;
      if (typeof promote === "function") Reflect.apply(promote, raw, []);
      promoted = true;
    },
    release(): void {
      if (released) return;
      released = true;
      Reflect.apply(release, raw, []);
    }
  });
}

/** Reserve under one caller deadline and retire a reservation that arrives late. */
export async function reserveRuntimeAssetBytesWithinDeadline(
  resources: BoundedBodyByteResourceHost,
  byteLength: number,
  deadline: RuntimeLoadOperationDeadline
): Promise<BoundedBodyByteLease> {
  const pending = reserveRuntimeAssetBytes(resources, byteLength);
  try {
    return await deadline.watch(pending);
  } catch (cause) {
    void pending.then((lease) => {
      try { lease.release(); } catch {}
    }, () => {});
    throw cause;
  }
}

export function createRuntimeAssetOperationDeadline(
  timeoutMs: number,
  timers: LoadWatchdogTimerHost | undefined,
  signals: readonly AbortSignal[]
): RuntimeLoadOperationDeadline {
  return createLoadOperationDeadline({
    signals,
    ...(timers === undefined ? {} : { timers }),
    timeoutMs
  });
}

function resourceError(expectedBytes: number): RuntimePlaybackError {
  return new RuntimePlaybackError(normalizeRuntimeFailure(
    "resource-rejection",
    undefined,
    { expectedBytes }
  ));
}
