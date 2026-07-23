import type {
  AvalSnapshot,
  RuntimeReadinessResult
} from "@pixel-point/aval-element";
import { describe, expect, it, vi } from "vitest";

import {
  AvalBinding,
  type AvalBindingElementPort,
  type AvalBindingEnvironment,
  type AvalBindingNode
} from "./aval-binding.js";
import { normalizeUseAvalOptions } from "./sources.js";

describe("AvalBinding", () => {
  it("has stable pre-mount state and safe command behavior", async () => {
    const binding = new AvalBinding(normalizeUseAvalOptions({
      sources: { h264: "/motion.avl" }
    }));
    const status = binding.getStatus();

    expect(Object.isFrozen(status)).toBe(true);
    expect(binding.getStatus()).toBe(status);
    expect(binding.getServerStatus()).toBe(status);
    expect(status).toMatchObject({
      mounted: false,
      readiness: "unready",
      paused: true,
      effectivelyVisible: false
    });
    expect(binding.send("retry")).toBe(false);
    expect(binding.readyFor("idle")).toBe(false);
    expect(binding.getDiagnostics()).toBeNull();
    expect(() => binding.pause()).not.toThrow();
    await expect(binding.prepare()).rejects.toMatchObject({
      name: "NotReadyError"
    });
    await expect(binding.setState("idle")).rejects.toMatchObject({
      name: "NotReadyError"
    });
    await expect(binding.play()).rejects.toMatchObject({
      name: "NotReadyError"
    });
  });

  it("publishes render options only for semantic configuration changes", () => {
    const binding = new AvalBinding(normalizeUseAvalOptions({
      sources: { h264: "/motion.avl" }
    }));
    const listener = vi.fn();
    const unsubscribe = binding.subscribeOptions(listener);

    binding.commitOptions(normalizeUseAvalOptions({
      sources: { h264: "/motion.avl" },
      onError: vi.fn()
    }));
    expect(listener).not.toHaveBeenCalled();

    binding.commitOptions(normalizeUseAvalOptions({
      sources: { h264: "/motion.avl" },
      state: "loading"
    }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(binding.getRenderOptions().state).toBe("loading");

    unsubscribe();
    unsubscribe();
    binding.commitOptions(normalizeUseAvalOptions({
      sources: { h264: "/other.avl" },
      state: "loading"
    }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("closes one attachment and all of its owned resources", () => {
    const element = new TestElementPort();
    const binding = createBinding(element);
    const target = testTarget();

    binding.attach(element);
    binding.finalizeBindingTarget(target);
    const cancel = binding.beginReadyPreparation();
    const signal = element.preparationSignals[0];

    expect(binding.getStatus().mounted).toBe(true);
    expect(element.interactionTarget).toBe(target);
    expect(element.snapshotSubscriberCount).toBe(1);
    expect(element.nativeListenerCount).toBe(5);

    binding.attach(null);
    cancel();

    expect(signal?.aborted).toBe(true);
    expect(element.interactionTarget).toBeNull();
    expect(element.snapshotSubscriberCount).toBe(0);
    expect(element.nativeListenerCount).toBe(0);
    expect(binding.getStatus()).toBe(binding.getServerStatus());
  });

  it("ignores stale preparation completion by operation identity", async () => {
    const element = new TestElementPort();
    const onReady = vi.fn();
    const binding = createBinding(element, { onReady });
    binding.attach(element);
    binding.finalizeBindingTarget(undefined);

    binding.beginReadyPreparation();
    const firstSignal = element.preparationSignals[0];
    binding.commitOptions(normalizeUseAvalOptions({
      sources: { h264: "/replacement.avl" },
      onReady
    }));
    binding.beginReadyPreparation();

    expect(firstSignal?.aborted).toBe(true);
    element.resolvePreparation(0);
    await Promise.resolve();
    expect(onReady).not.toHaveBeenCalled();

    element.resolvePreparation(1);
    await Promise.resolve();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith(READY_RESULT);
  });

  it("replaces and clears one binding target without duplicating writes", () => {
    const element = new TestElementPort();
    const binding = createBinding(element);
    const first = testTarget();
    const second = testTarget();

    binding.attach(element);
    binding.finalizeBindingTarget(first);
    binding.finalizeBindingTarget(first);
    binding.finalizeBindingTarget(second);
    binding.clearBindingTarget();
    binding.clearBindingTarget();
    binding.finalizeBindingTarget(second);

    expect(element.interactionTargetWrites).toEqual([
      first,
      second,
      null,
      second
    ]);
  });

  it("does not rewrite an already-clear target while closing", () => {
    const element = new TestElementPort();
    const binding = createBinding(element);
    const target = testTarget();

    binding.attach(element);
    binding.finalizeBindingTarget(target);
    binding.clearBindingTarget();
    binding.attach(null);

    expect(element.interactionTargetWrites).toEqual([target, null]);
  });

  it("enforces one mounted host per binding", () => {
    const first = new TestElementPort();
    const second = new TestElementPort();
    const binding = createBinding(first);
    binding.attach(first);

    expect(() => binding.attach(second)).toThrow(/cannot be mounted more than once/u);
    expect(first.snapshotSubscriberCount).toBe(1);
    expect(second.snapshotSubscriberCount).toBe(0);
  });

  it("projects status only when the element snapshot identity changes", () => {
    const element = new TestElementPort();
    const binding = createBinding(element);
    binding.attach(element);
    binding.finalizeBindingTarget(undefined);
    const initialStatus = binding.getStatus();
    const listener = vi.fn();
    binding.subscribeStatus(listener);

    element.publishCurrentSnapshot();
    expect(binding.getStatus()).toBe(initialStatus);
    expect(listener).not.toHaveBeenCalled();

    element.publishNewSnapshot();
    expect(binding.getStatus()).not.toBe(initialStatus);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

const READY_RESULT: RuntimeReadinessResult = Object.freeze({
  mode: "animated",
  assurance: "best-effort",
  report: Object.freeze({
    readiness: "interactiveReady",
    selectedRendition: "h264",
    candidates: Object.freeze([])
  })
});

function createBinding(
  element: TestElementPort,
  callbacks: Readonly<{ readonly onReady?: () => void }> = {}
): AvalBinding {
  const environment: AvalBindingEnvironment = {
    upgrade(node: AvalBindingNode): AvalBindingElementPort {
      expect(node).toBe(element);
      return element;
    }
  };
  return new AvalBinding(normalizeUseAvalOptions({
    sources: { h264: "/motion.avl" },
    ...callbacks
  }), environment);
}

function testTarget(): Element {
  return Object.freeze({}) as unknown as Element;
}

function snapshot(revision: number): Readonly<AvalSnapshot> {
  return Object.freeze({
    revision,
    generation: 1,
    connected: true,
    readiness: "interactiveReady",
    mode: "animated",
    assurance: "best-effort",
    staticReason: null,
    requestedState: "idle",
    visualState: "idle",
    isTransitioning: false,
    paused: false,
    effectivelyVisible: true,
    stateNames: Object.freeze(["idle"]),
    eventNames: Object.freeze([]),
    inputBindings: Object.freeze([]),
    lastError: null
  });
}

class TestElementPort implements AvalBindingNode, AvalBindingElementPort {
  readonly #nativeListeners = new Map<string, Set<EventListener>>();
  readonly #snapshotListeners = new Set<() => void>();
  readonly #preparations: Array<(result: RuntimeReadinessResult) => void> = [];
  readonly preparationSignals: Array<AbortSignal | null> = [];
  readonly interactionTargetWrites: Array<Element | null> = [];
  #interactionTarget: Element | null = null;
  #snapshot: Readonly<AvalSnapshot> = snapshot(0);

  public get interactionTarget(): Element | null {
    return this.#interactionTarget;
  }

  public set interactionTarget(value: Element | null) {
    this.#interactionTarget = value;
    this.interactionTargetWrites.push(value);
  }

  public get nativeListenerCount(): number {
    return [...this.#nativeListeners.values()].reduce(
      (count, listeners) => count + listeners.size,
      0
    );
  }

  public get snapshotSubscriberCount(): number {
    return this.#snapshotListeners.size;
  }

  public addEventListener(type: string, listener: EventListener): void {
    const listeners = this.#nativeListeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.#nativeListeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: EventListener): void {
    this.#nativeListeners.get(type)?.delete(listener);
  }

  public prepare(
    options?: Readonly<{ readonly signal?: AbortSignal; readonly timeoutMs?: number }>
  ): Promise<RuntimeReadinessResult> {
    this.preparationSignals.push(options?.signal ?? null);
    return new Promise((resolve) => {
      this.#preparations.push(resolve);
    });
  }

  public resolvePreparation(index: number): void {
    this.#preparations[index]?.(READY_RESULT);
  }

  public async setState(): Promise<void> {}
  public send(): boolean { return false; }
  public readyFor(): boolean { return false; }
  public pause(): void {}
  public async resume(): Promise<void> {}

  public getSnapshot(): Readonly<AvalSnapshot> {
    return this.#snapshot;
  }

  public subscribe(listener: () => void): () => void {
    this.#snapshotListeners.add(listener);
    return () => this.#snapshotListeners.delete(listener);
  }

  public getDiagnostics(): never {
    throw new Error("Diagnostics are outside this binding fixture");
  }

  public publishCurrentSnapshot(): void {
    this.#notifySnapshotListeners();
  }

  public publishNewSnapshot(): void {
    this.#snapshot = snapshot(this.#snapshot.revision + 1);
    this.#notifySnapshotListeners();
  }

  #notifySnapshotListeners(): void {
    for (const listener of [...this.#snapshotListeners]) listener();
  }
}
