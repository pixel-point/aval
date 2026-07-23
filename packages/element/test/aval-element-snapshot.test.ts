import { afterEach, describe, expect, it } from "vitest";

import { createAvalElementClass } from "../src/aval-element.js";
import type { AvalElement, AvalSnapshot } from "../src/public-types.js";
import {
  createElementTestRealm,
  FakeHTMLElement,
  FakeIntersectionObserver,
  type FakeWindow
} from "./support/element-test-realm.js";

const elements: AvalElement[] = [];

afterEach(async () => {
  await Promise.allSettled(elements.splice(0).map((element) => element.dispose()));
  FakeIntersectionObserver.instances.length = 0;
  FakeIntersectionObserver.deferObservation = false;
  await Promise.resolve();
});

describe("AvalElement snapshots", () => {
  it("publishes a frozen semantic snapshot before its matching error event", async () => {
    const { element } = createElement();
    const initial = element.getSnapshot();

    expect(element.getSnapshot()).toBe(initial);
    expect(initial).toMatchObject({
      revision: 0,
      generation: 0,
      connected: false,
      readiness: "unready",
      paused: false,
      effectivelyVisible: false,
      lastError: null
    });
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial.stateNames)).toBe(true);
    expect(Object.isFrozen(initial.inputBindings)).toBe(true);

    const snapshots: Readonly<AvalSnapshot>[] = [];
    const unsubscribe = element.subscribe(() => {
      snapshots.push(element.getSnapshot());
    });

    element.pause();
    const paused = element.getSnapshot();
    expect(paused).toMatchObject({ revision: 1, paused: true });
    expect(snapshots).toEqual([paused]);

    element.pause();
    expect(element.getSnapshot()).toBe(paused);
    expect(snapshots).toEqual([paused]);

    const order: string[] = [];
    const unsubscribeError = element.subscribe(() => {
      if (element.getSnapshot().lastError !== null) order.push("snapshot");
    });
    element.addEventListener("error", (event) => {
      order.push("event");
      expect(element.getSnapshot().lastError).toEqual(event.detail);
    });

    element.attributeChangedCallback("state", null, "not valid");

    expect(order).toEqual(["snapshot", "event"]);
    expect(element.getSnapshot().lastError).toMatchObject({
      generation: 1,
      fatal: false,
      failure: {
        code: "invalid-configuration",
        operation: "state"
      }
    });
    expect(Object.isFrozen(element.getSnapshot().lastError)).toBe(true);
    expect(Object.isFrozen(element.getSnapshot().lastError?.failure)).toBe(true);

    unsubscribe();
    unsubscribe();
    unsubscribeError();
    await element.dispose();
    expect(element.getSnapshot()).toMatchObject({
      connected: false,
      readiness: "disposed"
    });
  });

  it("publishes every effective-visibility edge, including persisted pageshow", async () => {
    const { element, view } = createElement();
    element.isConnected = true;
    element.connectedCallback();

    expect(element.getSnapshot()).toMatchObject({
      connected: true,
      effectivelyVisible: false
    });

    const revisions: number[] = [];
    element.subscribe(() => { revisions.push(element.getSnapshot().revision); });
    const observer = FakeIntersectionObserver.instances.at(-1);
    expect(observer).toBeDefined();

    observer?.emit(true);
    const visible = element.getSnapshot();
    expect(visible.effectivelyVisible).toBe(true);

    observer?.emit(true);
    view.dispatchEvent(new Event("resize"));
    expect(element.getSnapshot()).toBe(visible);
    expect(revisions).toHaveLength(1);

    view.dispatchEvent(new Event("pagehide"));
    expect(element.getSnapshot().effectivelyVisible).toBe(false);

    const pageShow = new Event("pageshow");
    Object.defineProperty(pageShow, "persisted", { value: true });
    view.dispatchEvent(pageShow);
    expect(element.getSnapshot().effectivelyVisible).toBe(true);
    expect(revisions).toHaveLength(3);

    await element.dispose();
    expect(element.getSnapshot()).toMatchObject({
      connected: false,
      effectivelyVisible: false,
      readiness: "disposed"
    });
  });

  it("clears the retained error when a new source generation begins", async () => {
    const { element } = createElement();
    element.isConnected = true;
    element.connectedCallback();
    await eventually(() => element.getSnapshot().readiness === "error");

    expect(element.getSnapshot()).toMatchObject({
      generation: 1,
      readiness: "error",
      lastError: { generation: 1, fatal: true }
    });

    const snapshots: Readonly<AvalSnapshot>[] = [];
    const unsubscribe = element.subscribe(() => {
      snapshots.push(element.getSnapshot());
    });
    element.attributeChangedCallback("crossorigin", null, "use-credentials");
    await eventually(() => element.getSnapshot().generation === 2 &&
      element.getSnapshot().readiness === "error");

    expect(snapshots).toContainEqual(expect.objectContaining({
      generation: 2,
      readiness: "unready",
      lastError: null
    }));
    expect(element.getSnapshot().lastError).toMatchObject({
      generation: 2,
      fatal: true
    });
    unsubscribe();
  });

  it("publishes disconnect as one atomic connection and visibility change", async () => {
    const { element } = createElement();
    element.isConnected = true;
    element.connectedCallback();
    FakeIntersectionObserver.instances.at(-1)?.emit(true);
    expect(element.getSnapshot().effectivelyVisible).toBe(true);

    const observed: Readonly<AvalSnapshot>[] = [];
    element.subscribe(() => { observed.push(element.getSnapshot()); });
    element.isConnected = false;
    element.disconnectedCallback();
    await Promise.resolve();

    expect(observed).not.toContainEqual(expect.objectContaining({
      connected: false,
      effectivelyVisible: true
    }));
    expect(element.getSnapshot()).toMatchObject({
      connected: false,
      effectivelyVisible: false
    });
  });

  it("publishes disposal without a disconnected-visible intermediate state", async () => {
    const { element } = createElement();
    element.isConnected = true;
    element.connectedCallback();
    FakeIntersectionObserver.instances.at(-1)?.emit(true);
    expect(element.getSnapshot().effectivelyVisible).toBe(true);

    const observed: Readonly<AvalSnapshot>[] = [];
    element.subscribe(() => { observed.push(element.getSnapshot()); });
    await element.dispose();

    expect(observed).not.toContainEqual(expect.objectContaining({
      connected: false,
      effectivelyVisible: true
    }));
    expect(element.getSnapshot()).toMatchObject({
      connected: false,
      effectivelyVisible: false,
      readiness: "disposed"
    });
  });
});

function createElement(): {
  element: AvalElement & FakeHTMLElement & {
    attributeChangedCallback(
      name: string,
      previous: string | null,
      next: string | null
    ): void;
    connectedCallback(): void;
    disconnectedCallback(): void;
  };
  view: FakeWindow;
} {
  FakeIntersectionObserver.deferObservation = true;
  const { view } = createElementTestRealm();
  const Constructor = createAvalElementClass(
    FakeHTMLElement as unknown as typeof HTMLElement
  );
  const element = new Constructor() as AvalElement & FakeHTMLElement & {
    attributeChangedCallback(
      name: string,
      previous: string | null,
      next: string | null
    ): void;
    connectedCallback(): void;
    disconnectedCallback(): void;
  };
  elements.push(element);
  return { element, view };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition did not settle");
}
