import { RuntimeAssetCatalog } from "./asset-catalog.js";

/** Internal logical state ledger. It never owns or controls presentation UI. */
export interface IntegratedStateStore {
  installInitial(options: {
    readonly state: string;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  validateAll(options: { readonly signal: AbortSignal }): Promise<unknown>;
  presentState(
    state: string,
    options: { readonly signal: AbortSignal }
  ): Promise<unknown>;
  currentState(): string | null;
  /** Resolves after every aborted logical-state callback has retired. */
  settled(): Promise<void>;
  dispose(): void;
}

/** @internal Test-only constructor seam; intentionally absent from package exports. */
export const INTEGRATED_STATE_STORE_FACTORY: unique symbol = Symbol(
  "aval.integrated-state-store-factory"
);

interface IntegratedStateStoreFactoryOptions {
  readonly [INTEGRATED_STATE_STORE_FACTORY]?: (
    catalog: RuntimeAssetCatalog
  ) => IntegratedStateStore;
}

/** @internal Test-only option adapter; intentionally absent from package exports. */
export function integratedStateStoreOption(
  factory: (catalog: RuntimeAssetCatalog) => IntegratedStateStore
): IntegratedStateStoreFactoryOptions {
  return Object.freeze({ [INTEGRATED_STATE_STORE_FACTORY]: factory });
}

/**
 * Tracks only the logical state identity used by motion scheduling. Static or
 * alternate presentation remains entirely consumer-owned.
 */
export class StateStore implements IntegratedStateStore {
  readonly #catalog: RuntimeAssetCatalog;
  #state: string | null = null;
  #disposed = false;

  public constructor(catalog: RuntimeAssetCatalog) {
    if (!(catalog instanceof RuntimeAssetCatalog) || catalog.disposed) {
      throw new TypeError("state store requires an active catalog");
    }
    this.#catalog = catalog;
  }

  public async installInitial(options: Readonly<{
    readonly state: string;
    readonly signal: AbortSignal;
  }>): Promise<void> {
    this.#assertActive();
    throwIfAborted(options.signal);
    this.#catalog.states.require(options.state);
    this.#state = options.state;
    throwIfAborted(options.signal);
  }

  public async validateAll(options: Readonly<{
    readonly signal: AbortSignal;
  }>): Promise<void> {
    this.#assertActive();
    throwIfAborted(options.signal);
  }

  public async presentState(
    state: string,
    options: Readonly<{ readonly signal: AbortSignal }>
  ): Promise<void> {
    this.#assertActive();
    throwIfAborted(options.signal);
    this.#catalog.states.require(state);
    this.#state = state;
    throwIfAborted(options.signal);
  }

  public currentState(): string | null {
    return this.#state;
  }

  public settled(): Promise<void> {
    return Promise.resolve();
  }

  public dispose(): void {
    this.#disposed = true;
    this.#state = null;
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new DOMException("state store is disposed", "AbortError");
    }
  }
}

export function createIntegratedStateStore(
  catalog: RuntimeAssetCatalog,
  options: object
): IntegratedStateStore {
  const factory = (options as IntegratedStateStoreFactoryOptions)[
    INTEGRATED_STATE_STORE_FACTORY
  ];
  return factory === undefined ? new StateStore(catalog) : factory(catalog);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof DOMException
    ? signal.reason
    : new DOMException("state operation was aborted", "AbortError");
}
