import type {
  RuntimeByteCategory,
  RuntimeByteLease,
  RuntimeReclamationRequest,
  RuntimeReclamationResult
} from "./model.js";
import { PageDecoderLeases } from "./page-decoder-leases.js";
import {
  PageReclamationCoordinator,
  type RuntimeReclamationParticipant
} from "./page-reclamation.js";
import {
  PageResourceManager,
  type RuntimeParticipantRegistration
} from "./page-resource-manager.js";
import type { RuntimePageResourcePolicy } from "./model.js";
import {
  PlayerResourceAccount,
  adoptPlayerResourceLease,
  retainPlayerReclaimableCategories,
  retirePlayerResourceGeneration
} from "./player-resource-account.js";
import { createPlayerResourceAdmission } from "./player-resource-admission.js";
import {
  createPlayerWebRuntimeResources,
  type PlayerWebRuntimeResources
} from "./player-web-runtime-resources.js";
import {
  openRuntimeAsset,
  openRuntimeAssetBytes,
  type OpenRuntimeAssetBytesOptions,
  type OpenRuntimeAssetOptions,
  type RuntimeAssetSession
} from "./runtime-asset-session.js";
import {
  RuntimeSessionLifecycle,
  type RuntimeSessionGenerationContext
} from "./runtime-session-lifecycle.js";
import type { RuntimeAssetRequest } from "./model.js";
import {
  PLAYER_ANIMATION_RECLAIMABLE_CATEGORIES,
  STATIC_RECLAIMABLE_CATEGORIES,
  captureAssetBytesOptions,
  captureAssetOptions,
  captureOwnedPlayer,
  capturePlayerReclamationCategories,
  captureReclamationHandler,
  captureStaticReclaimer,
  checkedSum,
  disposedError,
  linkGenerationSignal,
  staleError,
  unsafeReplacementError,
  type CapturedReclamationHandler
} from "./player-web-page-runtime-support.js";

export type PlayerWebOpenAssetOptions = Omit<
  OpenRuntimeAssetOptions,
  "resources" | "generation"
>;

export type PlayerWebOpenAssetBytesOptions = Omit<
  OpenRuntimeAssetBytesOptions,
  "resources" | "generation"
>;

export interface PlayerWebPageRuntimeOptions {
  readonly policy?: Readonly<RuntimePageResourcePolicy>;
}

/** The root lifecycle is the sole participant-generation authority. */
export type PlayerWebParticipantRegistration = Omit<
  RuntimeParticipantRegistration,
  "generation"
>;

export interface PlayerWebOwnedPlayer {
  dispose(): void | PromiseLike<void>;
  reclaimForPagePressure?(): boolean | PromiseLike<boolean>;
  setVisibility?(
    visibility: "hidden"
  ): void | PromiseLike<unknown>;
}

export interface PlayerWebStaticSurfaceReclaimer {
  reclaimOldest(): Readonly<{ readonly byteLength: number }> | null;
}

export interface PlayerWebReclamationParticipant
extends RuntimeReclamationParticipant {
  /** Exact closed categories this callback can make terminal on request. */
  readonly categories?: readonly RuntimeByteCategory[];
}

export interface PlayerWebPageRuntimeSnapshot {
  readonly disposed: boolean;
  readonly activeParticipants: number;
  readonly resources: ReturnType<PageResourceManager["snapshot"]>;
  readonly decoders: ReturnType<PageDecoderLeases["snapshot"]>;
  readonly reclamation: ReturnType<PageReclamationCoordinator["snapshot"]>;
}

export interface PlayerWebRuntimeParticipantSnapshot {
  readonly disposed: boolean;
  readonly generation: number | null;
  readonly account: ReturnType<PlayerResourceAccount["snapshot"]>;
  readonly lifecycle: ReturnType<RuntimeSessionLifecycle["snapshot"]>;
}

export interface PlayerWebRuntimeParticipant {
  readonly resources: Readonly<PlayerWebRuntimeResources>;
  readonly generation: number;
  readonly signal: AbortSignal;
  openAsset(
    request: Readonly<RuntimeAssetRequest>,
    options?: Readonly<PlayerWebOpenAssetOptions>
  ): Promise<RuntimeAssetSession>;
  openAssetBytes(
    bytes: Uint8Array,
    options?: Readonly<PlayerWebOpenAssetBytesOptions>
  ): Promise<RuntimeAssetSession>;
  ownPlayer(player: PlayerWebOwnedPlayer): () => void;
  registerReclamationParticipant(
    participant: PlayerWebReclamationParticipant
  ): () => void;
  registerStaticSurfaceReclaimer(
    store: PlayerWebStaticSurfaceReclaimer
  ): () => void;
  reserveWithReclamation(
    category: RuntimeByteCategory,
    bytes: number
  ): Promise<RuntimeByteLease>;
  replace(): Promise<number>;
  snapshot(): Readonly<PlayerWebRuntimeParticipantSnapshot>;
  dispose(): Promise<void>;
}

/**
 * Page-wide production composition for M7 resource policy. One instance owns
 * the physical-byte authority, FIFO decoder authority, reclamation lane, and
 * every participant created through it.
 */
export class PlayerWebPageRuntime {
  readonly #manager: PageResourceManager;
  readonly #decoders: PageDecoderLeases;
  readonly #reclamation: PageReclamationCoordinator;
  readonly #participants = new Set<PlayerWebRuntimeParticipantImpl>();
  #disposed = false;
  #disposal: Promise<void> | null = null;

  public constructor(options: Readonly<PlayerWebPageRuntimeOptions> = {}) {
    if (
      options === null ||
      typeof options !== "object" ||
      Array.isArray(options)
    ) {
      throw new TypeError("page runtime options must be an object");
    }
    let keys: string[];
    let policy: Readonly<RuntimePageResourcePolicy> | undefined;
    try {
      keys = Object.keys(options);
      policy = Reflect.get(options, "policy") as
        Readonly<RuntimePageResourcePolicy> | undefined;
    } catch {
      throw new TypeError("page runtime options are inaccessible");
    }
    if (keys.some((key) => key !== "policy")) {
      throw new TypeError("page runtime options have an unknown field");
    }
    this.#manager = policy === undefined
      ? new PageResourceManager()
      : new PageResourceManager(policy);
    this.#decoders = new PageDecoderLeases(this.#manager);
    this.#reclamation = new PageReclamationCoordinator(this.#manager);
  }

  public createParticipant(
    registration: Readonly<PlayerWebParticipantRegistration> = {}
  ): PlayerWebRuntimeParticipant {
    if (this.#disposed) throw disposedError();
    try {
      if (Reflect.has(registration, "generation")) {
        throw new TypeError(
          "page runtime participant generation is lifecycle-owned"
        );
      }
    } catch (error) {
      if (error instanceof TypeError) throw error;
      throw new TypeError("page runtime participant registration is inaccessible");
    }
    let participant!: PlayerWebRuntimeParticipantImpl;
    participant = new PlayerWebRuntimeParticipantImpl({
      manager: this.#manager,
      decoders: this.#decoders,
      reclamation: this.#reclamation,
      registration,
      onDispose: () => { this.#participants.delete(participant); }
    });
    this.#participants.add(participant);
    return participant;
  }

  public snapshot(): Readonly<PlayerWebPageRuntimeSnapshot> {
    return Object.freeze({
      disposed: this.#disposed,
      activeParticipants: this.#participants.size,
      resources: this.#manager.snapshot(),
      decoders: this.#decoders.snapshot(),
      reclamation: this.#reclamation.snapshot()
    });
  }

  public dispose(): Promise<void> {
    if (this.#disposal !== null) return this.#disposal;
    this.#disposed = true;
    this.#disposal = (async () => {
      await Promise.allSettled(
        [...this.#participants].map((participant) => participant.dispose())
      );
      this.#participants.clear();
      await this.#reclamation.dispose();
      this.#decoders.dispose();
      this.#manager.dispose();
    })();
    return this.#disposal;
  }
}

/** One replaceable asset/player generation backed by one page participant. */
class PlayerWebRuntimeParticipantImpl implements PlayerWebRuntimeParticipant {
  readonly #account: PlayerResourceAccount;
  readonly #manager: PageResourceManager;
  readonly #decoders: PageDecoderLeases;
  readonly #reclamation: PageReclamationCoordinator;
  readonly #lifecycle = new RuntimeSessionLifecycle();
  readonly #onDispose: () => void;
  #resources: Readonly<PlayerWebRuntimeResources>;
  readonly #reclamationHandlers = new Map<number, ReclamationHandlerRecord>();
  #nextReclamationHandlerId = 0;
  #reclamationRegistration: Readonly<{
    readonly generation: number;
    readonly unregister: () => void;
  }> | null = null;
  #replacementLane: Promise<void> = Promise.resolve();
  #disposed = false;
  #disposal: Promise<void> | null = null;

  public constructor(input: Readonly<{
    readonly manager: PageResourceManager;
    readonly decoders: PageDecoderLeases;
    readonly reclamation: PageReclamationCoordinator;
    readonly registration: Readonly<PlayerWebParticipantRegistration>;
    readonly onDispose: () => void;
  }>) {
    this.#account = new PlayerResourceAccount(input.manager, input.registration);
    this.#manager = input.manager;
    this.#decoders = input.decoders;
    this.#reclamation = input.reclamation;
    this.#onDispose = input.onDispose;
    this.#resources = this.#createResources(this.#current());
  }

  public get resources(): Readonly<PlayerWebRuntimeResources> {
    this.#throwIfDisposed();
    return this.#resources;
  }

  public get generation(): number {
    return this.#current().generation;
  }

  public get signal(): AbortSignal {
    return this.#current().signal;
  }

  public async openAsset(
    request: Readonly<RuntimeAssetRequest>,
    options: Readonly<PlayerWebOpenAssetOptions> = {}
  ): Promise<RuntimeAssetSession> {
    const context = this.#current();
    const signalLink = linkGenerationSignal(request, context.signal);
    let releaseReclaimer = (): void => undefined;
    try {
      const session = await context.track(openRuntimeAsset(
        signalLink.request,
        captureAssetOptions(options, this.resources, context.generation)
      ));
      try {
        if (!context.isCurrent()) throw staleError();
        releaseReclaimer = this.#registerAssetSessionReclaimer(session);
        context.registerCleanup("leases", async () => {
          releaseReclaimer();
          try { await session.dispose(); } finally { signalLink.release(); }
        });
      } catch (error) {
        releaseReclaimer();
        await session.dispose();
        signalLink.release();
        throw error;
      }
      return session;
    } catch (error) {
      signalLink.release();
      throw error;
    }
  }

  public async openAssetBytes(
    bytes: Uint8Array,
    options: Readonly<PlayerWebOpenAssetBytesOptions> = {}
  ): Promise<RuntimeAssetSession> {
    const context = this.#current();
    let releaseReclaimer = (): void => undefined;
    const session = await context.track(openRuntimeAssetBytes(
      bytes,
      captureAssetBytesOptions(options, this.resources, context.generation)
    ));
    try {
      if (!context.isCurrent()) throw staleError();
      releaseReclaimer = this.#registerAssetSessionReclaimer(session);
      context.registerCleanup("leases", async () => {
        releaseReclaimer();
        await session.dispose();
      });
    } catch (error) {
      releaseReclaimer();
      await session.dispose();
      throw error;
    }
    return session;
  }

  /** Retire player/candidate/GL ownership before statics and asset bytes. */
  public ownPlayer(player: PlayerWebOwnedPlayer): () => void {
    const capabilities = captureOwnedPlayer(player);
    const context = this.#current();
    const releaseReclaimer = capabilities.reclaim === null
      ? () => undefined
      : this.#registerReclamationHandler({
          reclaim: capabilities.reclaim
        }, 20, PLAYER_ANIMATION_RECLAIMABLE_CATEGORIES);
    let releaseDispose: () => void;
    try {
      releaseDispose = context.registerCleanup(
        "candidate-gl",
        capabilities.dispose
      );
    } catch (error) {
      releaseReclaimer();
      throw error;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      releaseDispose();
      releaseReclaimer();
    };
  }

  /** Register the page-pressure callback for this participant generation. */
  public registerReclamationParticipant(
    participant: PlayerWebReclamationParticipant
  ): () => void {
    return this.#registerReclamationHandler(
      participant,
      50,
      capturePlayerReclamationCategories(participant)
    );
  }

  #registerReclamationHandler(
    participant: RuntimeReclamationParticipant,
    priority: number,
    categories: readonly RuntimeByteCategory[]
  ): () => void {
    const context = this.#current();
    const reclaim = captureReclamationHandler(participant);
    const id = checkedSum(
      this.#nextReclamationHandlerId,
      1,
      "reclamation handler ID"
    );
    this.#nextReclamationHandlerId = id;
    this.#ensureReclamationRegistration(context);
    let releaseCategories: () => void;
    try {
      releaseCategories = retainPlayerReclaimableCategories(
        this.#account,
        categories
      );
    } catch (error) {
      this.#releaseEmptyReclamationRegistration(context.generation);
      throw error;
    }
    const record: ReclamationHandlerRecord = Object.freeze({
      id,
      generation: context.generation,
      priority,
      reclaim,
      releaseCategories
    });
    this.#reclamationHandlers.set(id, record);
    let active = true;
    const release = (): void => {
      if (!active) return;
      active = false;
      if (this.#reclamationHandlers.get(id) === record) {
        this.#reclamationHandlers.delete(id);
      }
      releaseCategories();
      this.#releaseEmptyReclamationRegistration(context.generation);
    };
    try {
      context.registerCleanup("listeners", release);
    } catch (error) {
      release();
      throw error;
    }
    return release;
  }

  /** Register deterministic LRU decoded-static eviction under page pressure. */
  public registerStaticSurfaceReclaimer(
    store: PlayerWebStaticSurfaceReclaimer
  ): () => void {
    const reclaimOldest = captureStaticReclaimer(store);
    return this.#registerReclamationHandler({
      reclaim(request) {
        if (
          request.reason !== "decoded-static" &&
          request.reason !== "policy-reduction"
        ) {
          return Promise.resolve(Object.freeze({
            token: request.token,
            releasedBytes: 0,
            covered: true
          }));
        }
        let releasedBytes = 0;
        while (releasedBytes < request.requestedBytes) {
          const eviction = reclaimOldest();
          if (eviction === null) break;
          releasedBytes = checkedSum(
            releasedBytes,
            eviction.byteLength,
            "reclaimed static bytes"
          );
        }
        return Promise.resolve(Object.freeze({
          token: request.token,
          releasedBytes,
          covered: true
        }));
      }
    }, 10, STATIC_RECLAIMABLE_CATEGORIES);
  }

  /** Reserve through the shared pressure lane and retire on generation exit. */
  public async reserveWithReclamation(
    category: RuntimeByteCategory,
    bytes: number
  ): Promise<RuntimeByteLease> {
    const context = this.#current();
    const managerLease = await context.track(
      this.#reclamation.reserveWithReclamation({
      participantId: this.#account.participantId,
      generation: context.generation,
      category,
      bytes,
      signal: context.signal
      })
    );
    const lease = adoptPlayerResourceLease(
      this.#account,
      this.#manager,
      managerLease
    );
    try {
      if (!context.isCurrent()) throw staleError();
      context.registerCleanup("leases", () => { lease.release(); });
    } catch (error) {
      lease.release();
      throw error;
    }
    return lease;
  }

  /** Abort and fully retire the old generation before publishing the next. */
  public async replace(): Promise<number> {
    this.#throwIfDisposed();
    const operation = this.#replacementLane.then(() => this.#replaceOnce());
    this.#replacementLane = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  public snapshot(): Readonly<PlayerWebRuntimeParticipantSnapshot> {
    const lifecycle = this.#lifecycle.snapshot();
    return Object.freeze({
      disposed: this.#disposed,
      generation: lifecycle.currentGeneration,
      account: this.#account.snapshot(),
      lifecycle
    });
  }

  public dispose(): Promise<void> {
    if (this.#disposal !== null) return this.#disposal;
    this.#disposed = true;
    try {
      this.#lifecycle.current().registerCleanup("participant", () => {
        this.#account.dispose();
      });
    } catch {
      this.#account.dispose();
    }
    this.#disposal = this.#lifecycle.dispose().finally(() => {
      this.#account.dispose();
      this.#onDispose();
    });
    return this.#disposal;
  }

  #current(): Readonly<RuntimeSessionGenerationContext> {
    this.#throwIfDisposed();
    return this.#lifecycle.current();
  }

  #throwIfDisposed(): void {
    if (this.#disposed) throw disposedError();
  }

  async #replaceOnce(): Promise<number> {
    this.#throwIfDisposed();
    const before = this.#lifecycle.snapshot();
    const previousGeneration = before.currentGeneration;
    if (previousGeneration === null) throw disposedError();
    const previousResources = this.#resources;
    const context = await this.#lifecycle.replace();

    let retirementFailed = false;
    try { previousResources.canvasBacking.release(); } catch {
      retirementFailed = true;
    }
    try {
      this.#decoders.removeParticipant(this.#account.participantId);
      retirePlayerResourceGeneration(this.#account);
    } catch {
      retirementFailed = true;
    }

    const afterRetirement = this.#lifecycle.snapshot();
    const activeOldDecoder = this.#decoders.snapshot().tickets.some((ticket) =>
      ticket.participantId === this.#account.participantId &&
      ticket.generation === previousGeneration &&
      ticket.state === "granted"
    );
    if (
      retirementFailed ||
      activeOldDecoder ||
      afterRetirement.cleanupFailureCount > before.cleanupFailureCount
    ) {
      await this.dispose();
      throw unsafeReplacementError();
    }

    try {
      this.#account.updateStatus({
        generation: context.generation,
        phase: "loading",
        reclaimable: []
      });
      this.#decoders.reconcileParticipant(this.#account.participantId);
      this.#resources = this.#createResources(context);
      return context.generation;
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  #createResources(
    context: Readonly<RuntimeSessionGenerationContext>
  ): Readonly<PlayerWebRuntimeResources> {
    const admission = createPlayerResourceAdmission({
      account: this.#account,
      manager: this.#manager,
      reclamation: this.#reclamation,
      generation: context.generation,
      signal: context.signal
    });
    return createPlayerWebRuntimeResources(
      this.#account,
      this.#decoders,
      admission
    );
  }

  #registerAssetSessionReclaimer(session: RuntimeAssetSession): () => void {
    const renditionIds = Object.freeze(
      session.catalog.manifest.renditions.map(({ id }) => id)
    );
    return this.#registerReclamationHandler({
      reclaim(request) {
        if (request.reason === "decoded-static") {
          return Promise.resolve(Object.freeze({
            token: request.token,
            releasedBytes: 0,
            covered: true
          }));
        }
        let releasedBytes = 0;
        for (const rendition of renditionIds) {
          releasedBytes = checkedSum(
            releasedBytes,
            session.evictRenditionUnits(rendition),
            "evicted verified unit bytes"
          );
        }
        return Promise.resolve(Object.freeze({
          token: request.token,
          releasedBytes,
          covered: true
        }));
      }
    }, 30, Object.freeze(["verified-unit"]));
  }

  #ensureReclamationRegistration(
    context: Readonly<RuntimeSessionGenerationContext>
  ): void {
    const existing = this.#reclamationRegistration;
    if (existing !== null) {
      if (existing.generation !== context.generation) throw staleError();
      return;
    }
    const unregister = this.#reclamation.registerParticipant(
      this.#account.participantId,
      Object.freeze({
        reclaim: (request: Readonly<RuntimeReclamationRequest>) =>
          this.#reclaimRegisteredHandlers(context, request)
      })
    );
    const registration = Object.freeze({
      generation: context.generation,
      unregister
    });
    this.#reclamationRegistration = registration;
    try {
      context.registerCleanup("listeners", () => {
        for (const [id, handler] of this.#reclamationHandlers) {
          if (handler.generation === context.generation) {
            this.#reclamationHandlers.delete(id);
          }
        }
        if (this.#reclamationRegistration === registration) {
          this.#reclamationRegistration = null;
          unregister();
        }
      });
    } catch (error) {
      if (this.#reclamationRegistration === registration) {
        this.#reclamationRegistration = null;
      }
      unregister();
      throw error;
    }
  }

  #releaseEmptyReclamationRegistration(generation: number): void {
    const hasGenerationHandler = [...this.#reclamationHandlers.values()]
      .some((handler) => handler.generation === generation);
    const registration = this.#reclamationRegistration;
    if (
      hasGenerationHandler ||
      registration === null ||
      registration.generation !== generation
    ) return;
    this.#reclamationRegistration = null;
    registration.unregister();
  }

  async #reclaimRegisteredHandlers(
    context: Readonly<RuntimeSessionGenerationContext>,
    request: Readonly<RuntimeReclamationRequest>
  ): Promise<Readonly<RuntimeReclamationResult>> {
    if (!context.isCurrent() || request.generation !== context.generation) {
      throw staleError();
    }
    const before = this.#account.snapshot().participant?.logicalBytes ?? 0;
    let covered = true;
    const handlers = [...this.#reclamationHandlers.values()]
      .filter(({ generation }) => generation === context.generation)
      .sort((left, right) => left.priority - right.priority || left.id - right.id);
    for (const handler of handlers) {
      const current = this.#account.snapshot().participant?.logicalBytes ?? 0;
      const released = Math.max(0, before - current);
      if (released >= request.requestedBytes) break;
      const delegated = Object.freeze({
        ...request,
        requestedBytes: request.requestedBytes - released
      });
      try {
        const result = await handler.reclaim(delegated);
        if (result.token !== request.token) {
          throw new TypeError("reclamation handler returned another token");
        }
        covered = covered && result.covered === true;
      } catch {
        covered = false;
      }
      if (!context.isCurrent()) throw staleError();
    }
    const after = this.#account.snapshot().participant?.logicalBytes ?? 0;
    return Object.freeze({
      token: request.token,
      releasedBytes: Math.max(0, before - after),
      covered
    });
  }
}

interface ReclamationHandlerRecord {
  readonly id: number;
  readonly generation: number;
  readonly priority: number;
  readonly reclaim: CapturedReclamationHandler;
  readonly releaseCategories: () => void;
}
