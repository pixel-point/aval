import {
  RuntimeAssetCatalog,
  type CertifiedVideoRendition
} from "./asset-catalog.js";
import { RuntimePlaybackError, normalizeRuntimeFailure } from "./errors.js";
import type { RuntimeAssetSession } from "./runtime-asset-session.js";

export type IntegratedAssetSessionOwnership = "external" | "player";

export type CapturedIntegratedPlayerAssetSource =
  | Readonly<{
      kind: "bytes";
      bytes: Uint8Array;
      selectedRenditionIndex: number;
    }>
  | Readonly<{
      kind: "session";
      session: Readonly<CapturedRuntimeAssetSession>;
      ownership: IntegratedAssetSessionOwnership;
      selectedRendition: Readonly<CertifiedVideoRendition>;
    }>;

interface CapturedRuntimeAssetSession {
  readonly identity: object;
  readonly generation: number;
  readonly catalog: RuntimeAssetCatalog;
  readonly ensureRenditionUnits: RuntimeAssetSession["ensureRenditionUnits"];
  readonly evictRenditionUnits: RuntimeAssetSession["evictRenditionUnits"];
  readonly dispose: RuntimeAssetSession["dispose"];
}

interface RuntimeAssetSessionPlayerClaim {
  readonly generation: number;
  readonly release: () => void;
}

const RUNTIME_ASSET_SESSION_PLAYER_CLAIMS = new WeakMap<
  object,
  RuntimeAssetSessionPlayerClaim
>();

interface IntegratedPlayerAssetOptionView {
  readonly bytes?: unknown;
  readonly assetSession?: unknown;
  readonly assetSessionOwnership?: unknown;
  readonly selectedRendition?: unknown;
  readonly selectedRenditionIndex?: unknown;
}

/** Snapshot one exact bytes-or-session source before acquiring player owners. */
export function captureIntegratedPlayerAssetSource(
  value: Readonly<IntegratedPlayerAssetOptionView>
): Readonly<CapturedIntegratedPlayerAssetSource> {
  const hasBytes = Reflect.has(value, "bytes");
  const hasSession = Reflect.has(value, "assetSession");
  const hasOwnership = Reflect.has(value, "assetSessionOwnership");
  const hasSelectedRendition = Reflect.has(value, "selectedRendition");
  const hasSelectedRenditionIndex = Reflect.has(value, "selectedRenditionIndex");
  if (hasBytes === hasSession) {
    throw new TypeError("integrated player requires exactly one asset source");
  }
  if (hasBytes) {
    if (hasOwnership || hasSelectedRendition || !hasSelectedRenditionIndex) {
      throw new TypeError(
        "byte assets require only a selectedRenditionIndex"
      );
    }
    let bytes: unknown;
    let selectedRenditionIndex: unknown;
    try { bytes = Reflect.get(value, "bytes"); } catch {
      throw new TypeError("integrated player bytes are inaccessible");
    }
    try {
      selectedRenditionIndex = Reflect.get(value, "selectedRenditionIndex");
    } catch {
      throw new TypeError("selectedRenditionIndex is inaccessible");
    }
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("integrated player bytes must be a Uint8Array");
    }
    if (
      typeof selectedRenditionIndex !== "number" ||
      !Number.isSafeInteger(selectedRenditionIndex) ||
      selectedRenditionIndex < 0
    ) {
      throw new TypeError("selectedRenditionIndex must be a non-negative integer");
    }
    return Object.freeze({ kind: "bytes", bytes, selectedRenditionIndex });
  }
  if (!hasOwnership) {
    throw new TypeError("assetSessionOwnership is required for assetSession");
  }
  if (!hasSelectedRendition) {
    throw new TypeError("selectedRendition is required for assetSession");
  }
  if (hasSelectedRenditionIndex) {
    throw new TypeError("asset sessions cannot declare selectedRenditionIndex");
  }
  let rawSession: unknown;
  let ownership: unknown;
  let selectedRendition: unknown;
  try {
    rawSession = Reflect.get(value, "assetSession");
    ownership = Reflect.get(value, "assetSessionOwnership");
    selectedRendition = Reflect.get(value, "selectedRendition");
  } catch {
    throw new TypeError("integrated player asset session is inaccessible");
  }
  if (ownership !== "external" && ownership !== "player") {
    throw new TypeError("assetSessionOwnership must be external or player");
  }
  if (
    selectedRendition === null ||
    typeof selectedRendition !== "object" ||
    Array.isArray(selectedRendition)
  ) {
    throw new TypeError("selectedRendition must be catalog-certified");
  }
  return Object.freeze({
    kind: "session",
    session: captureRuntimeAssetSession(rawSession),
    ownership,
    selectedRendition: selectedRendition as Readonly<CertifiedVideoRendition>
  });
}

/**
 * Adapts sparse residency to the existing catalog/candidate path. It
 * never owns graph, decoder, scheduler, or presentation behavior.
 */
export class IntegratedPlayerAssetBinding {
  public readonly catalog: RuntimeAssetCatalog;
  public readonly requiresEnsure: boolean;
  readonly #source: Readonly<CapturedIntegratedPlayerAssetSource>;
  readonly #releasePlayerClaim: (() => void) | null;
  #disposePromise: Promise<void> | null = null;

  public constructor(
    source: Readonly<CapturedIntegratedPlayerAssetSource>,
    catalog: RuntimeAssetCatalog
  ) {
    if (!(catalog instanceof RuntimeAssetCatalog) || catalog.disposed) {
      throw new TypeError("integrated player asset catalog is unavailable");
    }
    if (source.kind === "session" && source.session.catalog !== catalog) {
      throw new TypeError("integrated player session catalog identity diverged");
    }
    this.#releasePlayerClaim = source.kind === "session"
      ? claimRuntimeAssetSessionForPlayer(source.session)
      : null;
    this.#source = source;
    this.catalog = catalog;
    this.requiresEnsure = source.kind === "session";
  }

  public async ensureCandidate(
    rendition: string,
    signal: AbortSignal
  ): Promise<void> {
    if (this.#source.kind === "bytes") return;
    throwIfAborted(signal);
    await this.#source.session.ensureRenditionUnits(rendition, { signal });
    throwIfAborted(signal);
  }

  /** Call only after every failed-candidate sample/worker owner has retired. */
  public releaseFailedCandidate(rendition: string): number {
    return this.#source.kind === "bytes"
      ? 0
      : this.#source.session.evictRenditionUnits(rendition);
  }

  public dispose(): Promise<void> {
    if (this.#disposePromise !== null) return this.#disposePromise;
    const releaseClaim = this.#releasePlayerClaim;
    if (this.#source.kind === "bytes") {
      this.catalog.dispose();
      this.#disposePromise = Promise.resolve();
    } else if (this.#source.ownership === "external") {
      releaseClaim?.();
      this.#disposePromise = Promise.resolve();
    } else {
      this.#disposePromise = Promise.resolve(this.#source.session.dispose())
        .finally(() => { releaseClaim?.(); });
    }
    return this.#disposePromise;
  }
}

function captureRuntimeAssetSession(value: unknown): CapturedRuntimeAssetSession {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("integrated player assetSession must be an object");
  }
  let catalog: unknown;
  let disposed: unknown;
  let ensureRenditionUnits: unknown;
  let evictRenditionUnits: unknown;
  let dispose: unknown;
  try {
    catalog = Reflect.get(value, "catalog");
    disposed = Reflect.get(value, "disposed");
    ensureRenditionUnits = Reflect.get(value, "ensureRenditionUnits");
    evictRenditionUnits = Reflect.get(value, "evictRenditionUnits");
    dispose = Reflect.get(value, "dispose");
  } catch {
    throw new TypeError("integrated player assetSession is inaccessible");
  }
  if (!(catalog instanceof RuntimeAssetCatalog) || catalog.disposed || disposed !== false) {
    throw new TypeError("integrated player assetSession is disposed");
  }
  if (
    typeof ensureRenditionUnits !== "function" ||
    typeof evictRenditionUnits !== "function" ||
    typeof dispose !== "function"
  ) {
    throw new TypeError("integrated player assetSession is malformed");
  }
  const generation = catalog.residencySnapshot().generation;
  return Object.freeze({
    identity: value,
    generation,
    catalog,
    ensureRenditionUnits: (
      rendition: string,
      options?: Parameters<RuntimeAssetSession["ensureRenditionUnits"]>[1]
    ) => Reflect.apply(
      ensureRenditionUnits,
      value,
      [rendition, options]
    ) as ReturnType<RuntimeAssetSession["ensureRenditionUnits"]>,
    evictRenditionUnits: (rendition: string) => Reflect.apply(
      evictRenditionUnits,
      value,
      [rendition]
    ) as number,
    dispose: () => Reflect.apply(dispose, value, []) as Promise<void>
  });
}

function claimRuntimeAssetSessionForPlayer(
  session: Readonly<CapturedRuntimeAssetSession>
): () => void {
  if (RUNTIME_ASSET_SESSION_PLAYER_CLAIMS.has(session.identity)) {
    throw new RuntimePlaybackError(normalizeRuntimeFailure(
      "resource-rejection",
      undefined,
      {
        generation: session.generation,
        operation: "asset-session-player-claim"
      }
    ));
  }
  let released = false;
  const claim: RuntimeAssetSessionPlayerClaim = Object.freeze({
    generation: session.generation,
    release: (): void => {
      if (released) return;
      released = true;
      if (RUNTIME_ASSET_SESSION_PLAYER_CLAIMS.get(session.identity) === claim) {
        RUNTIME_ASSET_SESSION_PLAYER_CLAIMS.delete(session.identity);
      }
    }
  });
  RUNTIME_ASSET_SESSION_PLAYER_CLAIMS.set(session.identity, claim);
  return claim.release;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof DOMException
    ? signal.reason
    : new DOMException("integrated asset operation was aborted", "AbortError");
}
