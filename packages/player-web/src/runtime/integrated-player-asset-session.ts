import { RuntimeAssetCatalog } from "./asset-catalog.js";
import { RuntimePlaybackError, normalizeRuntimeFailure } from "./errors.js";
import type { RuntimeAssetSession } from "./runtime-asset-session.js";

export type IntegratedAssetSessionOwnership = "external" | "player";

export type CapturedIntegratedPlayerAssetSource =
  | Readonly<{
      kind: "bytes";
      bytes: Uint8Array;
    }>
  | Readonly<{
      kind: "session";
      session: Readonly<CapturedRuntimeAssetSession>;
      ownership: IntegratedAssetSessionOwnership;
    }>;

interface CapturedRuntimeAssetSession {
  readonly identity: object;
  readonly generation: number;
  readonly catalog: RuntimeAssetCatalog;
  readonly ensureStatic: RuntimeAssetSession["ensureStatic"];
  readonly ensureAllStatics: RuntimeAssetSession["ensureAllStatics"];
  readonly ensureAllUnits: RuntimeAssetSession["ensureAllUnits"];
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
}

/** Snapshot one exact bytes-or-session source before acquiring player owners. */
export function captureIntegratedPlayerAssetSource(
  value: Readonly<IntegratedPlayerAssetOptionView>
): Readonly<CapturedIntegratedPlayerAssetSource> {
  const hasBytes = Reflect.has(value, "bytes");
  const hasSession = Reflect.has(value, "assetSession");
  const hasOwnership = Reflect.has(value, "assetSessionOwnership");
  if (hasBytes === hasSession) {
    throw new TypeError("integrated player requires exactly one asset source");
  }
  if (hasBytes) {
    if (hasOwnership) {
      throw new TypeError("byte assets cannot declare assetSessionOwnership");
    }
    let bytes: unknown;
    try { bytes = Reflect.get(value, "bytes"); } catch {
      throw new TypeError("integrated player bytes are inaccessible");
    }
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("integrated player bytes must be a Uint8Array");
    }
    return Object.freeze({ kind: "bytes", bytes });
  }
  if (!hasOwnership) {
    throw new TypeError("assetSessionOwnership is required for assetSession");
  }
  let rawSession: unknown;
  let ownership: unknown;
  try {
    rawSession = Reflect.get(value, "assetSession");
    ownership = Reflect.get(value, "assetSessionOwnership");
  } catch {
    throw new TypeError("integrated player asset session is inaccessible");
  }
  if (ownership !== "external" && ownership !== "player") {
    throw new TypeError("assetSessionOwnership must be external or player");
  }
  return Object.freeze({
    kind: "session",
    session: captureRuntimeAssetSession(rawSession),
    ownership
  });
}

/**
 * Adapts sparse residency to the existing catalog/static/candidate path. It
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

  public async ensureStaticState(
    state: string,
    signal: AbortSignal
  ): Promise<void> {
    if (this.#source.kind === "bytes") return;
    throwIfAborted(signal);
    const staticFrame = this.catalog.states.require(state).staticFrame;
    await this.#source.session.ensureStatic(staticFrame, { signal });
    throwIfAborted(signal);
  }

  public async ensureAllStatics(signal: AbortSignal): Promise<void> {
    if (this.#source.kind === "bytes") return;
    throwIfAborted(signal);
    await this.#source.session.ensureAllStatics({ signal });
    throwIfAborted(signal);
  }

  public async ensureCandidate(
    rendition: string,
    signal: AbortSignal
  ): Promise<void> {
    if (this.#source.kind === "bytes") return;
    throwIfAborted(signal);
    await this.#source.session.ensureAllUnits(rendition, { signal });
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
  let ensureStatic: unknown;
  let ensureAllStatics: unknown;
  let ensureAllUnits: unknown;
  let evictRenditionUnits: unknown;
  let dispose: unknown;
  try {
    catalog = Reflect.get(value, "catalog");
    disposed = Reflect.get(value, "disposed");
    ensureStatic = Reflect.get(value, "ensureStatic");
    ensureAllStatics = Reflect.get(value, "ensureAllStatics");
    ensureAllUnits = Reflect.get(value, "ensureAllUnits");
    evictRenditionUnits = Reflect.get(value, "evictRenditionUnits");
    dispose = Reflect.get(value, "dispose");
  } catch {
    throw new TypeError("integrated player assetSession is inaccessible");
  }
  if (!(catalog instanceof RuntimeAssetCatalog) || catalog.disposed || disposed !== false) {
    throw new TypeError("integrated player assetSession is disposed");
  }
  if (
    typeof ensureStatic !== "function" ||
    typeof ensureAllStatics !== "function" ||
    typeof ensureAllUnits !== "function" ||
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
    ensureStatic: (
      staticFrame: string,
      options?: Parameters<RuntimeAssetSession["ensureStatic"]>[1]
    ) => Reflect.apply(
      ensureStatic,
      value,
      [staticFrame, options]
    ) as ReturnType<RuntimeAssetSession["ensureStatic"]>,
    ensureAllStatics: (
      options?: Parameters<RuntimeAssetSession["ensureAllStatics"]>[0]
    ) => Reflect.apply(
      ensureAllStatics,
      value,
      [options]
    ) as ReturnType<RuntimeAssetSession["ensureAllStatics"]>,
    ensureAllUnits: (
      rendition: string,
      options?: Parameters<RuntimeAssetSession["ensureAllUnits"]>[1]
    ) => Reflect.apply(
      ensureAllUnits,
      value,
      [rendition, options]
    ) as ReturnType<RuntimeAssetSession["ensureAllUnits"]>,
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
