import { describe, expect, it, vi } from "vitest";

import type { RuntimeAssetCatalog } from "./asset-catalog.js";
import { createIntegratedTestAsset } from "./asset-test-support.js";
import { RuntimePlaybackError } from "./errors.js";
import {
  IntegratedPlayer,
  integratedStateStoreOption,
  type IntegratedCandidateAttempt,
  type IntegratedCandidateFactory,
  type IntegratedPlayerOptions,
  type IntegratedStateStore
} from "./integrated-player.js";
import {
  ManualTimers
} from "./integrated-player-preparation-test-support.js";
import {
  createIntegratedTestVideoSource
} from "./integrated-player-video-test-support.js";
import type { MotionPolicy } from "./motion-policy.js";
import type {
  RuntimeCanvasResourceHost,
  RuntimeCanvasResourceLease,
  RuntimeCanvasResourcePlan
} from "./canvas-resource-plan.js";

describe("IntegratedPlayer construction and resource admission", () => {
  it("rejects an undersized static baseline before constructing its store", () => {
    const bytes = createIntegratedTestAsset();
    const createStateStore = vi.fn(() => new MinimalStaticStore());
    const factory = new NeverCandidateFactory();
    let error: unknown;

    try {
      new IntegratedPlayer({
        bytes,
        selectedRenditionIndex: 0,
        ...integratedStateStoreOption(createStateStore),
        candidateFactory: factory,
        hostMaxRuntimeBytes: bytes.byteLength
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: "resource-rejection" });
    expect(createStateStore).not.toHaveBeenCalled();
    expect(factory.calls).toEqual([]);
  });

  it("best-effort disposes a malformed static store returned by its factory", () => {
    const dispose = vi.fn();
    const factory = new NeverCandidateFactory();

    expect(() => new IntegratedPlayer({
      ...createIntegratedTestVideoSource(createIntegratedTestAsset()),
      ...integratedStateStoreOption(() =>
        ({ dispose } as unknown as IntegratedStateStore)
      ),
      candidateFactory: factory
    })).toThrow("missing installInitial");
    expect(dispose).toHaveBeenCalledOnce();

    expect(() => new IntegratedPlayer({
      ...createIntegratedTestVideoSource(createIntegratedTestAsset()),
      ...integratedStateStoreOption(() => ({
        dispose() {
          throw new Error("injected malformed-store cleanup failure");
        }
      } as unknown as IntegratedStateStore)),
      candidateFactory: factory
    })).toThrow("missing installInitial");
  });

  it("snapshots a throwing availability getter before acquiring owned resources", () => {
    const createStateStore = vi.fn(() => new MinimalStaticStore());
    const currentCanvasBacking = vi.fn(() => Object.freeze({
      width: 1,
      height: 1
    }));
    const reserveCanvasResources = vi.fn(() => Object.freeze({
      release: vi.fn()
    }));
    let availabilityReads = 0;
    const factory: IntegratedCandidateFactory = {
      get availability() {
        availabilityReads += 1;
        if (availabilityReads === 5) {
          throw new Error("injected post-validation availability failure");
        }
        return Object.freeze({
          workerAvailable: true,
          rendererAvailable: true
        });
      },
      resourceHost: Object.freeze({
        currentCanvasBacking,
        reserveCanvasResources
      }),
      create: vi.fn(() => {
        throw new Error("candidate creation is not expected");
      })
    };

    expect(() => new IntegratedPlayer({
      ...createIntegratedTestVideoSource(createIntegratedTestAsset()),
      ...integratedStateStoreOption(createStateStore),
      candidateFactory: factory
    })).toThrow("injected post-validation availability failure");

    expect(availabilityReads).toBe(5);
    expect(createStateStore).not.toHaveBeenCalled();
    expect(currentCanvasBacking).not.toHaveBeenCalled();
    expect(reserveCanvasResources).not.toHaveBeenCalled();
  });

  it("rolls back the store, lease, and catalog after a later constructor failure", () => {
    const store = new MinimalStaticStore();
    const release = vi.fn();
    const catalogs: RuntimeAssetCatalog[] = [];
    let motionPolicyReads = 0;
    const base = {
      ...createIntegratedTestVideoSource(createIntegratedTestAsset()),
      ...integratedStateStoreOption((ownedCatalog: RuntimeAssetCatalog) => {
        catalogs.push(ownedCatalog);
        return store;
      }),
      candidateFactory: candidateFactoryWithResourceHost(
        () => Object.freeze({ release })
      ),
      get motionPolicy(): MotionPolicy {
        motionPolicyReads += 1;
        return (motionPolicyReads > 2 ? "invalid" : "auto") as MotionPolicy;
      }
    } satisfies IntegratedPlayerOptions;

    expect(() => new IntegratedPlayer(base)).toThrow("motion policy is invalid");

    expect(store.disposeCalls).toBe(1);
    expect(release).toHaveBeenCalledOnce();
    expect(catalogs).toHaveLength(1);
    expect(catalogs[0]?.disposed).toBe(true);
    expect(catalogs[0]?.ownedByteLength).toBe(0);
  });

  it.each([
    {
      name: "null",
      createLease: () => null
    },
    {
      name: "missing release",
      createLease: () => Object.freeze({})
    },
    {
      name: "throwing release getter",
      createLease: () => Object.defineProperty({}, "release", {
        get() {
          throw new Error("private lease capability failure");
        }
      })
    }
  ])("rejects a $name canvas lease as stable admission failure", ({
    createLease
  }) => {
    const createStateStore = vi.fn(() => new MinimalStaticStore());
    const reserveCanvasResources = vi.fn(() => createLease() as never);
    const factory = candidateFactoryWithResourceHost(
      reserveCanvasResources
    );
    let error: unknown;

    try {
      new IntegratedPlayer({
      ...createIntegratedTestVideoSource(createIntegratedTestAsset()),
        ...integratedStateStoreOption(createStateStore),
        candidateFactory: factory
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      code: "resource-rejection",
      failure: {
        context: { operation: "canvas-resource-admission" }
      }
    });
    expect(error).not.toHaveProperty(
      "message",
      expect.stringContaining("private lease capability failure")
    );
    expect(createStateStore).not.toHaveBeenCalled();
    expect(reserveCanvasResources).toHaveBeenCalledOnce();
  });

  it("captures a canvas lease release capability exactly once", async () => {
    let releaseReads = 0;
    const release = vi.fn();
    const lease = Object.defineProperty({}, "release", {
      get() {
        releaseReads += 1;
        if (releaseReads > 1) {
          throw new Error("injected toggling release getter");
        }
        return release;
      }
    });
    const player = new IntegratedPlayer({
      ...createIntegratedTestVideoSource(createIntegratedTestAsset()),
      ...integratedStateStoreOption(() => new MinimalStaticStore()),
      candidateFactory: candidateFactoryWithResourceHost(
        () => lease as RuntimeCanvasResourceLease
      )
    });

    expect(releaseReads).toBe(1);
    await expect(player.dispose()).resolves.toBeUndefined();
    expect(releaseReads).toBe(1);
    expect(release).toHaveBeenCalledOnce();
  });

  it("never publishes visual readiness for the wrong installed static state", async () => {
    const observedReadiness: string[] = [];
    let player: IntegratedPlayer | null = null;
    player = new IntegratedPlayer({
      ...createIntegratedTestVideoSource(createIntegratedTestAsset()),
      ...integratedStateStoreOption(() => new WrongInitialStateStore()),
      candidateFactory: new NeverCandidateFactory(),
      timers: new ManualTimers(),
      eventSink: () => {
        if (player !== null) observedReadiness.push(player.snapshot().readiness);
      }
    });

    await expect(player.prepare()).rejects.toBeInstanceOf(
      RuntimePlaybackError
    );

    expect(observedReadiness).not.toContain("visualReady");
    expect(player.snapshot().readiness).toBe("error");
  });
});

class MinimalStaticStore implements IntegratedStateStore {
  public disposeCalls = 0;
  #state: string | null = null;

  public async installInitial(options: {
    readonly state: string;
    readonly signal: AbortSignal;
  }): Promise<void> {
    this.#state = options.state;
  }

  public async validateAll(): Promise<void> {}

  public async presentState(state: string): Promise<void> {
    this.#state = state;
  }

  public currentState(): string | null {
    return this.#state;
  }


  public async settled(): Promise<void> {}

  public dispose(): void {
    this.disposeCalls += 1;
  }
}

class WrongInitialStateStore extends MinimalStaticStore {
  public override currentState(): string {
    return "hover";
  }
}

class NeverCandidateFactory implements IntegratedCandidateFactory {
  public readonly availability = Object.freeze({
    workerAvailable: true,
    rendererAvailable: true
  });
  public readonly calls: string[] = [];

  public create(): IntegratedCandidateAttempt {
    this.calls.push("create");
    throw new Error("candidate creation is not expected");
  }
}

function candidateFactoryWithResourceHost(
  reserveCanvasResources: (
    plan: Readonly<RuntimeCanvasResourcePlan>
  ) => RuntimeCanvasResourceLease
): IntegratedCandidateFactory {
  const resourceHost: RuntimeCanvasResourceHost = Object.freeze({
    currentCanvasBacking: () => Object.freeze({ width: 1, height: 1 }),
    reserveCanvasResources
  });
  return Object.freeze({
    availability: Object.freeze({
      workerAvailable: true,
      rendererAvailable: true
    }),
    resourceHost,
    create(): IntegratedCandidateAttempt {
      throw new Error("candidate creation is not expected");
    }
  });
}
