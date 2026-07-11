import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ContinuousLoopDecoder,
  type ContinuousLoopDecoderMetrics
} from "./continuous-loop-decoder.js";
import { createEncodedLoopUnit } from "./encoded-loop.js";
import { LoopCanvasPlayer } from "./loop-canvas-player.js";

describe("LoopCanvasPlayer lifecycle intent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not start when pause supersedes asynchronous preparation", async () => {
    const visibility = installDocument("visible");
    const decoder = new DeferredDecoder();
    const player = createPlayer(decoder);

    const starting = player.start();
    expect(player.state).toBe("preparing");
    player.pause();
    decoder.resolvePreparation();
    await starting;

    expect(player.state).toBe("paused");
    expect(decoder.disposeCalls).toBe(0);
    visibility.set("visible");
    player.dispose();
  });

  it("stays paused while hidden and resumes only after visibility returns", async () => {
    const visibility = installDocument("hidden");
    const decoder = new DeferredDecoder();
    const player = createPlayer(decoder);

    const starting = player.start();
    decoder.resolvePreparation();
    await starting;
    expect(player.state).toBe("paused");

    visibility.set("visible");
    visibility.dispatch();
    await vi.waitFor(() => {
      expect(player.state).toBe("running");
    });

    player.dispose();
  });

  it("rejects with a concrete error when disposed during preparation", async () => {
    installDocument("visible");
    const decoder = new DeferredDecoder();
    const player = createPlayer(decoder);

    const starting = player.start();
    player.dispose();
    decoder.resolvePreparation();

    await expect(starting).rejects.toThrow(
      "disposed during preparation"
    );
    expect(player.state).toBe("disposed");
    expect(decoder.disposeCalls).toBe(1);
  });
});

function createPlayer(decoder: DeferredDecoder): LoopCanvasPlayer {
  const context = { drawImage: vi.fn() };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context
  } as unknown as HTMLCanvasElement;

  return new LoopCanvasPlayer(canvas, createUnit(), {
    decoder: decoder as unknown as ContinuousLoopDecoder,
    requestFrame: () => 1,
    cancelFrame: () => undefined,
    now: () => 100
  });
}

function createUnit() {
  return createEncodedLoopUnit({
    config: {
      codec: "vp8",
      codedWidth: 2,
      codedHeight: 2,
      displayAspectWidth: 2,
      displayAspectHeight: 2
    },
    codedWidth: 2,
    codedHeight: 2,
    displayWidth: 2,
    displayHeight: 2,
    frameRate: { numerator: 30, denominator: 1 },
    frames: [
      { type: "key", data: new Uint8Array([1]) },
      { type: "delta", data: new Uint8Array([2]) }
    ]
  });
}

function installDocument(initial: DocumentVisibilityState): {
  set(value: DocumentVisibilityState): void;
  dispatch(): void;
} {
  let visibility = initial;
  const listeners = new Set<() => void>();
  const documentStub = {
    get visibilityState(): DocumentVisibilityState {
      return visibility;
    },
    addEventListener: (name: string, listener: EventListenerOrEventListenerObject) => {
      if (name === "visibilitychange" && typeof listener === "function") {
        listeners.add(listener as () => void);
      }
    },
    removeEventListener: (
      name: string,
      listener: EventListenerOrEventListenerObject
    ) => {
      if (name === "visibilitychange" && typeof listener === "function") {
        listeners.delete(listener as () => void);
      }
    }
  };
  vi.stubGlobal("document", documentStub);

  return {
    set: (value) => {
      visibility = value;
    },
    dispatch: () => {
      for (const listener of listeners) {
        listener();
      }
    }
  };
}

class DeferredDecoder {
  readonly #preparation = deferred<void>();
  public disposeCalls = 0;

  public fillToAhead(): number {
    return 8;
  }

  public waitForFrames(): Promise<void> {
    return this.#preparation.promise;
  }

  public takeFrame(): undefined {
    return undefined;
  }

  public snapshotMetrics(): ContinuousLoopDecoderMetrics {
    return {
      configureCalls: 1,
      resetCalls: 0,
      boundaryFlushCalls: 0,
      terminalFlushCalls: 0,
      submittedChunks: 8,
      outputFrames: 0,
      closedFrames: 0,
      openFrames: 0,
      queuedFrames: 8,
      reorderBufferedFrames: 0,
      inFlightFrames: 8,
      maxQueueDepth: 8,
      errors: 0,
      decodeQueueSize: 0,
      terminalFlushCompleted: false,
      disposed: this.disposeCalls > 0
    };
  }

  public dispose(): void {
    this.disposeCalls += 1;
  }

  public resolvePreparation(): void {
    this.#preparation.resolve(undefined);
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
