import { describe, expect, it, vi } from "vitest";

import { RuntimeAssetCatalog } from "./asset-catalog.js";
import { createIntegratedOpaqueTestAsset } from "./asset-test-fixture.js";
import { RuntimePlaybackError, normalizeRuntimeFailure } from "./errors.js";
import {
  IntegratedPlayer,
  PlaybackFallbackError,
  type IntegratedCandidateAttempt,
  type IntegratedCandidateAttemptContext,
  type IntegratedCandidateFactory,
  type IntegratedStaticSurfaceStore
} from "./integrated-player.js";
import {
  Deferred,
  FakeCandidateFactory,
  ManualTimers,
  waitForCall
} from "./integrated-player-preparation-test-support.js";
import type {
  RuntimeAssetEnsureOptions,
  RuntimeAssetSession,
  RuntimeAssetSessionSnapshot
} from "./runtime-asset-session.js";
import type { RuntimeTransportMode } from "./model.js";
import type { VerifiedBlobHandle } from "./verified-blob-store.js";
import type {
  BrowserContextRecoveryEvent,
  BrowserContextRecoveryEventTarget
} from "./browser-context-recovery.js";

describe("IntegratedPlayer sparse asset-session composition", () => {
  it.each(["range", "full"] satisfies readonly RuntimeTransportMode[])(
    "uses the sole %s catalog path in strict verification order",
    async (mode) => {
      const timeline: string[] = [];
      const session = new FakeAssetSession(mode, timeline);
      const copySample = vi.spyOn(session.catalog, "copySample");
      const store = new RecordingStaticStore(timeline);
      const factory = new RecordingCandidateFactory(timeline);
      let factoryCatalog: RuntimeAssetCatalog | null = null;
      const createStaticStore = vi.fn((catalog: RuntimeAssetCatalog) => {
        expect(catalog).toBe(session.catalog);
        return store;
      });
      factory.onCreate = (context) => { factoryCatalog = context.catalog; };

      const player = new IntegratedPlayer({
        assetSession: session,
        assetSessionOwnership: "external",
        createStaticStore,
        candidateFactory: factory,
        timers: new ManualTimers()
      });
      await expect(player.prepare()).resolves.toMatchObject({
        mode: "animated",
        report: { selectedRendition: "opaque-high" }
      });

      expect(player.catalog).toBe(session.catalog);
      expect(factoryCatalog).toBe(session.catalog);
      expect(timeline.indexOf("session:static:idle-static"))
        .toBeLessThan(timeline.indexOf("store:install:idle"));
      expect(timeline.indexOf("session:all-statics"))
        .toBeLessThan(timeline.indexOf("store:validate-all"));
      expect(timeline.indexOf("session:units:opaque-high"))
        .toBeLessThan(timeline.indexOf("candidate:create:opaque-high"));
      expect(copySample).not.toHaveBeenCalled();
      expect(createStaticStore).toHaveBeenCalledOnce();

      await player.dispose();
      expect(session.disposeCalls).toBe(0);
      expect(session.catalog.disposed).toBe(false);
      expect(session.calls).toContain("evict:opaque-high");
      await session.dispose();
    }
  );

  it("gates static decode and candidate inspection on verified residency", async () => {
    const staticTimeline: string[] = [];
    const staticSession = new FakeAssetSession("range", staticTimeline, {
      rejectStatic: true
    });
    const staticStore = new RecordingStaticStore(staticTimeline);
    const staticFactory = new RecordingCandidateFactory(staticTimeline);
    const staticPlayer = new IntegratedPlayer({
      assetSession: staticSession,
      assetSessionOwnership: "external",
      createStaticStore: () => staticStore,
      candidateFactory: staticFactory,
      timers: new ManualTimers()
    });

    await expect(staticPlayer.prepare()).rejects.toBeInstanceOf(
      PlaybackFallbackError
    );
    expect(staticStore.calls).toEqual([]);
    expect(staticFactory.calls).toEqual([]);
    await staticPlayer.dispose();
    await staticSession.dispose();

    const unitTimeline: string[] = [];
    const unitSession = new FakeAssetSession("range", unitTimeline, {
      rejectedRendition: "opaque-high"
    });
    const copySample = vi.spyOn(unitSession.catalog, "copySample");
    const unitFactory = new RecordingCandidateFactory(unitTimeline);
    const unitPlayer = new IntegratedPlayer({
      assetSession: unitSession,
      assetSessionOwnership: "external",
      createStaticStore: () => new RecordingStaticStore(unitTimeline),
      candidateFactory: unitFactory,
      timers: new ManualTimers()
    });

    await expect(unitPlayer.prepare()).resolves.toMatchObject({
      mode: "animated",
      report: { selectedRendition: "opaque-low" }
    });
    expect(copySample).not.toHaveBeenCalled();
    expect(unitSession.calls).toContain("evict:opaque-high");
    expect(unitFactory.calls).not.toContain("create:opaque-high");
    await unitPlayer.dispose();
    await unitSession.dispose();
  });

  it("does not fetch animation while initially hidden and rejects stale ensures", async () => {
    const timeline: string[] = [];
    const gate = new Deferred<void>();
    const session = new FakeAssetSession("range", timeline, { unitGate: gate });
    const factory = new RecordingCandidateFactory(timeline);
    const player = new IntegratedPlayer({
      assetSession: session,
      assetSessionOwnership: "external",
      initialVisibility: "hidden",
      createStaticStore: () => new RecordingStaticStore(timeline),
      candidateFactory: factory,
      timers: new ManualTimers()
    });

    await expect(player.prepare()).resolves.toMatchObject({
      mode: "static",
      reason: "visibility-suspended"
    });
    expect(session.calls.some((call) => call.startsWith("units:"))).toBe(false);

    const showing = player.setVisibility("visible");
    await waitForCall(session.calls, "units:opaque-high");
    const hiding = player.setVisibility("hidden");
    gate.resolve(undefined);
    await showing.catch(() => undefined);
    await hiding;

    expect(factory.calls).toEqual([]);
    expect(player.visibilitySnapshot()).toMatchObject({
      visibility: "hidden",
      suspension: "suspended"
    });
    await player.dispose();
    await session.dispose();
  });

  it("disposes a player-owned session only after every player consumer", async () => {
    const timeline: string[] = [];
    const session = new FakeAssetSession("full", timeline);
    const factory = new RecordingCandidateFactory(timeline);
    const player = new IntegratedPlayer({
      assetSession: session,
      assetSessionOwnership: "player",
      createStaticStore: () => new RecordingStaticStore(timeline),
      candidateFactory: factory,
      timers: new ManualTimers()
    });
    await player.prepare();
    await player.dispose();

    expect(session.disposeCalls).toBe(1);
    expect(session.catalog.disposed).toBe(true);
    expect(timeline.indexOf("candidate:dispose:opaque-high"))
      .toBeLessThan(timeline.indexOf("session:dispose"));
    expect(timeline.indexOf("store:dispose"))
      .toBeLessThan(timeline.indexOf("session:dispose"));
  });

  it("evicts selected units only after hide and context retirement complete", async () => {
    const hideTimeline: string[] = [];
    const hideSession = new FakeAssetSession("range", hideTimeline);
    const hidePlayer = new IntegratedPlayer({
      assetSession: hideSession,
      assetSessionOwnership: "external",
      createStaticStore: () => new RecordingStaticStore(hideTimeline),
      candidateFactory: new RecordingCandidateFactory(hideTimeline),
      timers: new ManualTimers()
    });
    await hidePlayer.prepare();
    await hidePlayer.setVisibility("hidden");
    expect(hideTimeline.indexOf("candidate:dispose:opaque-high"))
      .toBeLessThan(hideTimeline.indexOf("session:evict:opaque-high"));
    await hidePlayer.dispose();
    await hideSession.dispose();

    const contextTimeline: string[] = [];
    const contextSession = new FakeAssetSession("range", contextTimeline);
    const target = new FakeContextTarget();
    const contextFactory = new RecordingCandidateFactory(
      contextTimeline,
      target
    );
    const contextPlayer = new IntegratedPlayer({
      assetSession: contextSession,
      assetSessionOwnership: "external",
      createStaticStore: () => new RecordingStaticStore(contextTimeline),
      candidateFactory: contextFactory,
      timers: new ManualTimers()
    });
    await contextPlayer.prepare();
    target.dispatch("webglcontextlost");
    await contextPlayer.settled();
    expect(contextTimeline.indexOf("candidate:dispose:opaque-high"))
      .toBeLessThan(contextTimeline.indexOf("session:evict:opaque-high"));
    await contextPlayer.dispose();
    await contextSession.dispose();
  });

  it("rejects ambiguous or implicit session ownership", () => {
    const session = new FakeAssetSession("range", []);
    const common = {
      createStaticStore: () => new RecordingStaticStore([]),
      candidateFactory: new RecordingCandidateFactory([])
    };
    expect(() => new IntegratedPlayer({
      ...common,
      assetSession: session
    } as never)).toThrow("assetSessionOwnership");
    expect(() => new IntegratedPlayer({
      ...common,
      bytes: createIntegratedOpaqueTestAsset(),
      assetSession: session,
      assetSessionOwnership: "external"
    } as never)).toThrow("exactly one asset source");
    void session.dispose();
  });

  it("grants one generation-tagged player claim and releases it on every exit", async () => {
    const session = new FakeAssetSession("range", []);
    const options = () => ({
      assetSession: session,
      assetSessionOwnership: "external" as const,
      createStaticStore: () => new RecordingStaticStore([]),
      candidateFactory: new RecordingCandidateFactory([]),
      timers: new ManualTimers()
    });
    const first = new IntegratedPlayer(options());

    expect(() => new IntegratedPlayer(options())).toThrowError(
      expect.objectContaining({
        code: "resource-rejection",
        failure: expect.objectContaining({
          context: expect.objectContaining({
            generation: session.catalog.residencySnapshot().generation,
            operation: "asset-session-player-claim"
          })
        })
      })
    );

    await first.dispose();
    const rebound = new IntegratedPlayer(options());
    await rebound.dispose();

    expect(() => new IntegratedPlayer({
      ...options(),
      createStaticStore: () => { throw new Error("constructor seam"); }
    })).toThrow("constructor seam");
    await Promise.resolve();
    const afterFailure = new IntegratedPlayer(options());
    await afterFailure.dispose();
    await session.dispose();
  });
});

class RecordingStaticStore implements IntegratedStaticSurfaceStore {
  public readonly calls: string[] = [];
  readonly #timeline: string[];
  #state: string | null = null;

  public constructor(timeline: string[]) { this.#timeline = timeline; }
  public async installInitial(options: {
    readonly state: string;
    readonly signal: AbortSignal;
  }): Promise<void> {
    throwIfAborted(options.signal);
    this.calls.push(`install:${options.state}`);
    this.#timeline.push(`store:install:${options.state}`);
    this.#state = options.state;
  }
  public async validateAll(options: { readonly signal: AbortSignal }): Promise<void> {
    throwIfAborted(options.signal);
    this.calls.push("validate-all");
    this.#timeline.push("store:validate-all");
  }
  public async presentState(state: string, options: {
    readonly signal: AbortSignal;
    readonly cover?: boolean;
  }): Promise<void> {
    throwIfAborted(options.signal);
    this.calls.push(`present:${state}`);
    this.#timeline.push(`store:present:${state}`);
    this.#state = state;
  }
  public currentState(): string | null { return this.#state; }
  public coverCurrent(): void { this.#timeline.push("store:cover"); }
  public revealAnimated(): void { this.#timeline.push("store:reveal"); }
  public async settled(): Promise<void> {}
  public dispose(): void {
    this.calls.push("dispose");
    this.#timeline.push("store:dispose");
  }
}

class RecordingCandidateFactory extends FakeCandidateFactory {
  public onCreate: ((context: Readonly<IntegratedCandidateAttemptContext>) => void) |
    null = null;
  readonly #timeline: string[];
  public constructor(
    timeline: string[],
    contextTarget?: BrowserContextRecoveryEventTarget
  ) {
    super(
      [{ kind: "success" }, { kind: "success" }],
      undefined,
      timeline,
      contextTarget
    );
    this.#timeline = timeline;
  }
  public override create(
    context: Readonly<IntegratedCandidateAttemptContext>
  ): IntegratedCandidateAttempt {
    this.onCreate?.(context);
    this.#timeline.push(`candidate:create:${context.candidate.rendition.id}`);
    return super.create(context);
  }
}

class FakeContextTarget implements BrowserContextRecoveryEventTarget {
  readonly #listeners = new Map<string, Set<(event: BrowserContextRecoveryEvent) => void>>();
  public addEventListener(
    type: "webglcontextlost" | "webglcontextrestored",
    listener: (event: BrowserContextRecoveryEvent) => void
  ): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }
  public removeEventListener(
    type: "webglcontextlost" | "webglcontextrestored",
    listener: (event: BrowserContextRecoveryEvent) => void
  ): void {
    this.#listeners.get(type)?.delete(listener);
  }
  public dispatch(type: "webglcontextlost" | "webglcontextrestored"): void {
    const event = Object.freeze({ preventDefault(): void {} });
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

interface FakeAssetSessionBehavior {
  readonly rejectStatic?: boolean;
  readonly rejectedRendition?: string;
  readonly unitGate?: Deferred<void>;
}

class FakeAssetSession implements RuntimeAssetSession {
  public readonly catalog = new RuntimeAssetCatalog(
    createIntegratedOpaqueTestAsset()
  );
  public readonly calls: string[] = [];
  public disposeCalls = 0;
  #disposed = false;
  readonly #timeline: string[];
  readonly #behavior: Readonly<FakeAssetSessionBehavior>;

  public constructor(
    public readonly mode: RuntimeTransportMode,
    timeline: string[],
    behavior: Readonly<FakeAssetSessionBehavior> = {}
  ) {
    this.#timeline = timeline;
    this.#behavior = behavior;
  }
  public get disposed(): boolean { return this.#disposed; }
  public async ensureStatic(
    staticFrame: string,
    options: Readonly<RuntimeAssetEnsureOptions> = {}
  ): Promise<Readonly<VerifiedBlobHandle>> {
    this.#record(`static:${staticFrame}`);
    throwIfAborted(options.signal);
    if (this.#behavior.rejectStatic === true) throw integrityError();
    return handle("static", staticFrame);
  }
  public async ensureAllStatics(
    options: Readonly<RuntimeAssetEnsureOptions> = {}
  ): Promise<readonly Readonly<VerifiedBlobHandle>[]> {
    this.#record("all-statics");
    throwIfAborted(options.signal);
    return Object.freeze([]);
  }
  public async ensureUnit(
    rendition: string,
    unit: string,
    options: Readonly<RuntimeAssetEnsureOptions> = {}
  ): Promise<Readonly<VerifiedBlobHandle>> {
    throwIfAborted(options.signal);
    return handle("unit", `${rendition}:${unit}`);
  }
  public async ensureRenditionUnits(
    rendition: string,
    options: Readonly<RuntimeAssetEnsureOptions> = {}
  ): Promise<readonly Readonly<VerifiedBlobHandle>[]> {
    return this.ensureAllUnits(rendition, options);
  }
  public async ensureAllUnits(
    rendition: string,
    options: Readonly<RuntimeAssetEnsureOptions> = {}
  ): Promise<readonly Readonly<VerifiedBlobHandle>[]> {
    this.#record(`units:${rendition}`);
    if (this.#behavior.unitGate !== undefined) {
      await this.#behavior.unitGate.promise;
    }
    throwIfAborted(options.signal);
    if (this.#behavior.rejectedRendition === rendition) throw integrityError();
    return Object.freeze([]);
  }
  public evictRenditionUnits(rendition: string): number {
    this.#record(`evict:${rendition}`);
    return 0;
  }
  public snapshot(): Readonly<RuntimeAssetSessionSnapshot> {
    return Object.freeze({
      ...this.catalog.residencySnapshot(),
      disposed: this.#disposed,
      activeTransportBodies: 0,
      pendingLoads: 0,
      interestedWaiters: 0
    });
  }
  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.disposeCalls += 1;
    this.#record("dispose");
    this.catalog.dispose();
  }
  #record(value: string): void {
    this.calls.push(value);
    this.#timeline.push(`session:${value}`);
  }
}

function handle(
  kind: "unit" | "static",
  key: string
): Readonly<VerifiedBlobHandle> {
  return Object.freeze({ key, kind, byteLength: 1, generation: 0 });
}

function integrityError(): RuntimePlaybackError {
  return new RuntimePlaybackError(normalizeRuntimeFailure(
    "integrity-mismatch"
  ));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof DOMException
    ? signal.reason
    : new DOMException("test operation aborted", "AbortError");
}
