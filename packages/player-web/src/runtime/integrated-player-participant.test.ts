import type { GraphPresentation } from "@pixel-point/aval-graph";
import { describe, expect, it } from "vitest";

import type { RuntimeAssetCatalog } from "./asset-catalog.js";
import { createIntegratedTestAsset } from "./asset-test-support.js";
import type { VideoCandidateResourceAuthority } from "./video-candidate-model.js";
import {
  IntegratedPlayer,
  integratedStateStoreOption,
  type IntegratedCandidateAttempt,
  type IntegratedCandidateAttemptContext,
  type IntegratedCandidateFactory,
  type IntegratedPlaybackSession,
  type IntegratedPreparedActivation,
  type IntegratedStateStore
} from "./integrated-player.js";
import { ManualTimers } from "./integrated-player-preparation-test-support.js";
import { selectIntegratedTestVideoRendition } from "./integrated-player-video-test-support.js";
import type { RuntimeDecoderLease, RuntimeDecoderTicket } from "./model.js";
import { PageDecoderLeases } from "./page-decoder-leases.js";
import { PageResourceManager } from "./page-resource-manager.js";
import { createRuntimePageResourcePolicy } from "./page-resource-policy.js";
import { PlayerResourceAccount } from "./player-resource-account.js";
import {
  createPlayerWebRuntimeResources,
  type PlayerWebRuntimeResources
} from "./player-web-runtime-resources.js";
import {
  openRuntimeAssetBytes,
  type RuntimeAssetSession
} from "./runtime-asset-session.js";
import type {
  RuntimeCanvasResourceHost,
  RuntimeCanvasResourceLease,
  RuntimeCanvasResourcePlan
} from "./canvas-resource-plan.js";

const VIDEO_FIXTURE = createIntegratedTestAsset();

describe("IntegratedPlayer page participant composition", () => {
  it.each([
    ["throwing", (): boolean => {
      throw new Error("injected grant callback failure");
    }],
    ["disposed", (): boolean => false]
  ] as const)("releases a queued grant rejected by a %s callback", async (
    _label,
    onDecoderGrant
  ) => {
    const manager = new PageResourceManager(createRuntimePageResourcePolicy({
      maximumDecoderLeases: 1
    }));
    const decoders = new PageDecoderLeases(manager);
    const blockerAccount = new PlayerResourceAccount(manager);
    const waitingAccount = new PlayerResourceAccount(manager);
    const resources = createPlayerWebRuntimeResources(waitingAccount, decoders);
    const connection = resources.participant.attach({ onDecoderGrant });
    const blocker = decoders.request(
      blockerAccount.participantId,
      blockerAccount.snapshot().participant!.generation
    );
    const blockerLease = await blocker.wait();
    const queued = resources.candidate.requestDecoder();
    await expect(queued.wait()).rejects.toMatchObject({
      failure: { context: { operation: "decoder-queued" } }
    });

    blockerLease.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(decoders.snapshot().activeLeaseCount).toBe(0);
    expect(connection.snapshot().decoderPending).toBe(false);

    connection.dispose();
    blockerAccount.dispose();
    waitingAccount.dispose();
    decoders.dispose();
    manager.dispose();
  });

  it("releases a granted-but-unconsumed rebuild lease on reduced or detach", async () => {
    const manager = new PageResourceManager(createRuntimePageResourcePolicy({
      maximumDecoderLeases: 1
    }));
    const decoders = new PageDecoderLeases(manager);
    const blockerAccount = new PlayerResourceAccount(manager);
    const waitingAccount = new PlayerResourceAccount(manager);
    const resources = createPlayerWebRuntimeResources(waitingAccount, decoders);
    let grants = 0;
    const connection = resources.participant.attach({
      onDecoderGrant: () => { grants += 1; }
    });
    connection.update({ visibility: "visible", phase: "preparing" });
    const blocker = decoders.request(
      blockerAccount.participantId,
      blockerAccount.snapshot().participant!.generation
    );
    const blockerLease = await blocker.wait();
    const queued = resources.candidate.requestDecoder();
    await expect(queued.wait()).rejects.toMatchObject({
      code: "resource-rejection",
      failure: { context: { operation: "decoder-queued" } }
    });

    blockerLease.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(grants).toBe(1);
    expect(connection.snapshot().decoderGrantedForRebuild).toBe(true);
    expect(decoders.snapshot().activeLeaseCount).toBe(1);

    connection.update({ eligible: false, phase: "static" });
    expect(decoders.snapshot().activeLeaseCount).toBe(0);
    expect(connection.snapshot().decoderPending).toBe(false);

    connection.update({ eligible: true, phase: "preparing" });
    const secondBlocker = decoders.request(
      blockerAccount.participantId,
      blockerAccount.snapshot().participant!.generation
    );
    const secondBlockerLease = await secondBlocker.wait();
    const secondQueued = resources.candidate.requestDecoder();
    await expect(secondQueued.wait()).rejects.toMatchObject({
      failure: { context: { operation: "decoder-queued" } }
    });
    secondBlockerLease.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(connection.snapshot().decoderGrantedForRebuild).toBe(true);
    connection.dispose();
    expect(decoders.snapshot().activeLeaseCount).toBe(0);
    blockerAccount.dispose();
    waitingAccount.dispose();
    decoders.dispose();
    manager.dispose();
  });

  it("settles a third player decoder-queued and rebuilds exactly once on grant", async () => {
    const page = await createThreePlayerPage();
    try {
      const firstResult = await page.players[0]!.prepare();
      expect(firstResult.mode, JSON.stringify(firstResult)).toBe("animated");
      await expect(page.players[1]!.prepare()).resolves.toMatchObject({
        mode: "animated"
      });
      await expect(page.players[2]!.prepare()).resolves.toMatchObject({
        mode: "static",
        reason: "decoder-queued"
      });

      const queuedSession = page.sessions[2]!.snapshot();
      expect(queuedSession).toMatchObject({
        unitBlobs: { verified: 0, verifiedBytes: 0 }
      });
      expect(queuedSession).not.toHaveProperty("staticBlobs");
      expect(page.decoders.snapshot()).toMatchObject({
        activeLeaseCount: 2,
        queuedTicketCount: 1
      });
      expect(page.players[2]!.participantSnapshot()).toMatchObject({
        visibility: "visible",
        phase: "static",
        decoderPending: true
      });

      await page.players[0]!.dispose();
      await waitFor(() =>
        page.players[2]!.snapshot().readiness === "interactiveReady"
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(page.factories[2]!.createCalls).toBe(2);
      expect(page.factories[2]!.maximumLiveAttempts).toBe(1);
      expect(page.decoders.snapshot()).toMatchObject({
        activeLeaseCount: 2,
        queuedTicketCount: 0
      });
      expect(page.players[2]!.participantSnapshot()).toMatchObject({
        phase: "animated",
        decoderPending: false
      });
    } finally {
      await page.dispose();
    }
  });

  it("cancels a hidden queued ticket and requests a fresh lease only on show", async () => {
    const page = await createThreePlayerPage();
    try {
      await page.players[0]!.prepare();
      await page.players[1]!.prepare();
      await page.players[2]!.prepare();
      expect(page.decoders.snapshot().queuedTicketCount).toBe(1);

      await page.players[2]!.setVisibility("hidden");
      expect(page.decoders.snapshot()).toMatchObject({
        activeLeaseCount: 2,
        queuedTicketCount: 0,
        parkedTicketCount: 0
      });
      expect(page.accounts[2]!.snapshot().participant).toMatchObject({
        visibility: "hidden",
        phase: "suspended"
      });

      await page.players[0]!.dispose();
      await Promise.resolve();
      await Promise.resolve();
      expect(page.factories[2]!.createCalls).toBe(1);
      expect(page.players[2]!.snapshot().readiness).toBe("staticReady");

      await page.players[2]!.setVisibility("visible");
      await waitFor(() =>
        page.players[2]!.snapshot().readiness === "interactiveReady"
      );
      expect(page.factories[2]!.createCalls).toBe(2);
      expect(page.accounts[2]!.snapshot().participant).toMatchObject({
        visibility: "visible",
        phase: "animated"
      });
    } finally {
      await page.dispose();
    }
  });

  it("opens a real sparse session with unit-only payload residency", async () => {
    const manager = new PageResourceManager();
    const decoders = new PageDecoderLeases(manager);
    const account = new PlayerResourceAccount(manager);
    const resources = createPlayerWebRuntimeResources(account, decoders);
    const session = await openRuntimeAssetBytes(
      VIDEO_FIXTURE,
      { resources: resources.assetSession }
    );
    const snapshot = session.snapshot();
    expect(snapshot).toMatchObject({
      verifiedPayloadBytes: 0,
      unitBlobs: { verified: 0 }
    });
    expect(snapshot).not.toHaveProperty("staticBlobs");
    const store = new VerifiedCatalogStaticStore(session.catalog);
    let reservationCount = 0;
    let releaseCount = 0;
    const factory = new LeaseCandidateFactory(
      resources.candidate,
      Object.freeze({
        currentCanvasBacking: () => Object.freeze({ width: 1, height: 1 }),
        reserveCanvasResources: (
          _plan: Readonly<RuntimeCanvasResourcePlan>
        ): RuntimeCanvasResourceLease => {
          reservationCount += 1;
          let released = false;
          return Object.freeze({
            release(): void {
              if (released) return;
              released = true;
              releaseCount += 1;
            }
          });
        }
      })
    );
    const player = new IntegratedPlayer({
      assetSession: session,
      assetSessionOwnership: "external",
      selectedRendition: selectIntegratedTestVideoRendition(session.catalog),
      participantBinding: resources.participant,
      ...integratedStateStoreOption(() => store),
      candidateFactory: factory,
      timers: new ManualTimers()
    });

    expect(session.snapshot().verifiedPayloadBytes).toBe(0);
    expect(reservationCount).toBe(1);
    await expect(player.prepare()).resolves.toMatchObject({ mode: "animated" });
    expect(store.stateUpdates).toBeGreaterThan(0);
    expect(session.snapshot().unitBlobs.verified).toBeGreaterThan(0);

    await player.dispose();
    expect(releaseCount).toBe(1);
    expect(session.disposed).toBe(false);
    expect(account.snapshot().participant).toMatchObject({
      visibility: "hidden",
      phase: "suspended"
    });
    await session.dispose();
    account.dispose();
    decoders.dispose();
    manager.dispose();
  });
});

interface ThreePlayerPage {
  readonly manager: PageResourceManager;
  readonly decoders: PageDecoderLeases;
  readonly accounts: readonly PlayerResourceAccount[];
  readonly resources: readonly Readonly<PlayerWebRuntimeResources>[];
  readonly sessions: readonly RuntimeAssetSession[];
  readonly factories: readonly LeaseCandidateFactory[];
  readonly players: readonly IntegratedPlayer[];
  dispose(): Promise<void>;
}

async function createThreePlayerPage(): Promise<ThreePlayerPage> {
  const manager = new PageResourceManager();
  const decoders = new PageDecoderLeases(manager);
  const accounts = Array.from({ length: 3 }, () =>
    new PlayerResourceAccount(manager)
  );
  const resources = accounts.map((account) =>
    createPlayerWebRuntimeResources(account, decoders)
  );
  const sessions = await Promise.all(resources.map((resource) =>
    openRuntimeAssetBytes(VIDEO_FIXTURE, {
      resources: resource.assetSession
    })
  ));
  const factories = resources.map((resource) =>
    new LeaseCandidateFactory(resource.candidate)
  );
  const players = sessions.map((session, index) => new IntegratedPlayer({
    assetSession: session,
    assetSessionOwnership: "player",
    selectedRendition: selectIntegratedTestVideoRendition(session.catalog),
    participantBinding: resources[index]!.participant,
    ...integratedStateStoreOption((catalog) =>
      new VerifiedCatalogStaticStore(catalog)
    ),
    candidateFactory: factories[index]!,
    timers: new ManualTimers()
  }));
  return {
    manager,
    decoders,
    accounts,
    resources,
    sessions,
    factories,
    players,
    async dispose(): Promise<void> {
      await Promise.allSettled(players.map((player) => player.dispose()));
      for (const account of accounts) account.dispose();
      decoders.dispose();
      manager.dispose();
    }
  };
}

class VerifiedCatalogStaticStore implements IntegratedStateStore {
  public stateUpdates = 0;
  readonly #catalog: RuntimeAssetCatalog;
  #state: string | null = null;
  public constructor(catalog: RuntimeAssetCatalog) { this.#catalog = catalog; }
  public async installInitial(options: {
    readonly state: string;
    readonly signal: AbortSignal;
  }): Promise<void> {
    throwIfAborted(options.signal);
    this.#catalog.states.require(options.state);
    this.stateUpdates += 1;
    this.#state = options.state;
  }
  public async validateAll(options: { readonly signal: AbortSignal }): Promise<void> {
    throwIfAborted(options.signal);
  }
  public async presentState(state: string, options: {
    readonly signal: AbortSignal;
    readonly cover?: boolean;
  }): Promise<void> {
    throwIfAborted(options.signal);
    this.#catalog.states.require(state);
    this.stateUpdates += 1;
    this.#state = state;
  }
  public currentState(): string | null { return this.#state; }
  public async settled(): Promise<void> {}
  public dispose(): void {}
}

class LeaseCandidateFactory implements IntegratedCandidateFactory {
  public readonly availability = Object.freeze({
    workerAvailable: true,
    rendererAvailable: true
  });
  public createCalls = 0;
  public liveAttempts = 0;
  public maximumLiveAttempts = 0;
  public readonly resourceHost?: RuntimeCanvasResourceHost;
  readonly #authority: Readonly<VideoCandidateResourceAuthority>;
  public constructor(
    authority: Readonly<VideoCandidateResourceAuthority>,
    resourceHost?: RuntimeCanvasResourceHost
  ) {
    this.#authority = authority;
    if (resourceHost !== undefined) this.resourceHost = resourceHost;
  }
  public create(
    _context: Readonly<IntegratedCandidateAttemptContext>
  ): IntegratedCandidateAttempt {
    this.createCalls += 1;
    this.liveAttempts += 1;
    this.maximumLiveAttempts = Math.max(
      this.maximumLiveAttempts,
      this.liveAttempts
    );
    let ticket: RuntimeDecoderTicket | null = null;
    let lease: RuntimeDecoderLease | null = null;
    let disposed = false;
    return {
      playback: PLAYBACK,
      prepare: async ({ signal }) => {
        throwIfAborted(signal);
        const requestedTicket = this.#authority.requestDecoder();
        ticket = requestedTicket;
        try {
          lease = await requestedTicket.wait();
        } catch (error) {
          requestedTicket.cancel();
          throw error;
        }
        throwIfAborted(signal);
      },
      prepareActivation: async ({ expectedPresentation }) =>
        Object.freeze({ expectedPresentation }),
      drawInitial: () => undefined,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        ticket?.cancel();
        lease?.release();
        this.liveAttempts -= 1;
      }
    };
  }
}

const PLAYBACK: IntegratedPlaybackSession = Object.freeze({
  prepareContentTick: () => null,
  drawContentTick: () => null,
  synchronizeGraph: () => undefined,
  traceState: () => Object.freeze({
    scheduler: Object.freeze({
      generation: null,
      activePath: null,
      sourceCursor: null,
      submittedCursor: null,
      decodedCursor: null,
      displayedCursor: null,
      ringSize: 0,
      ringCapacity: 6,
      smoothSession: true
    }),
    submitted: Object.freeze([]),
    selectedBoundary: null,
    decodeLeadFrames: null
  })
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  }
  throw new Error("timed out waiting for integrated participant state");
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof DOMException
    ? signal.reason
    : new DOMException("participant test operation aborted", "AbortError");
}
