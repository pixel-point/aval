import { describe, expect, it } from "vitest";

import { ElementEventMutationGate } from "../src/element-event-mutation-gate.js";
import { ElementPublicEvents } from "../src/element-public-events.js";
import {
  bindingCurrent,
  deferAcceptedSend,
  deferAttributeEffect,
  failedGenerationCleanup,
  initialPresentation,
  interactionTarget,
  intrinsicRatio,
  motionSelectionChanged,
  needsIntersectionSample,
  persistedPageShow,
  publicFailureCode,
  queueOwnedEventFollowup,
  queueOwnedMicrotask,
  runtimeHostSupported,
  sourceMutation,
  createElementTiming,
  createRealmPlatform,
  readSources,
  rebindAdoptedStyles,
  removeInstalledListeners,
  createOwnershipSnapshot
} from "../src/aval-element.js";

const HTML = "http://www.w3.org/1999/xhtml";

describe("element inputs", () => {
  it("skips malformed source candidates without discarding valid siblings", () => {
    const host = {
      children: collection([
        source({ src: "/bad.avl", type: "video/mp4" }),
        source({
          src: "/valid.avl",
          type: 'application/vnd.aval; codecs="avc1.64001E"'
        }),
        element("div")
      ])
    } as unknown as HTMLElement;

    const read = readSources(host);
    expect(read.failures).toEqual([{ sourceIndex: 0, attribute: "type" }]);
    expect(read.sources).toEqual([{
      src: "/valid.avl",
      codec: "avc1.64001E",
      integrity: "",
      sourceIndex: 1
    }]);
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read.sources)).toBe(true);
    expect(Object.isFrozen(read.failures)).toBe(true);
  });

  it("reports exact attributes for control URLs, codecs, and noncanonical SRI", () => {
    const host = {
      children: collection([
        source({
          src: "/bad\navl",
          type: 'application/vnd.aval; codecs="avc1.64001E"'
        }),
        source({
          src: "/bad-codec.avl",
          type: 'application/vnd.aval; codecs="avc1.42E01E"'
        }),
        source({
          src: "/bad-sri.avl",
          type: 'application/vnd.aval; codecs="avc1.64001E"',
          integrity: `sha256-${"A".repeat(42)}B=`
        })
      ])
    } as unknown as HTMLElement;
    expect(readSources(host).failures).toEqual([
      { sourceIndex: 0, attribute: "src" },
      { sourceIndex: 1, attribute: "type" },
      { sourceIndex: 2, attribute: "integrity" }
    ]);
  });

  it("accepts only the supported canonical codec grammar", () => {
    const codecs = [
      ["avc1.64000A", true], ["avc1.64001E", true], ["avc1.64003E", true],
      ["hvc1.1.2.L1.90", true], ["hvc1.1.6.L93.B0", true],
      ["hvc1.1.FFFFFFFF.H255.90", true], ["vp09.00.10.08", true],
      ["vp09.00.62.08.01.01.01.01.00", true], ["av01.0.00M.08", true],
      ["av01.0.31H.10.0.113.01.01.01.0", true],
      ["avc1.42E01E", false], ["avc1.64000a", false],
      ["hvc1.1.0.L93.B0", false], ["hvc1.1.100000000.L93.B0", false],
      ["hvc1.1.2.L0.90", false], ["hvc1.1.2.L1.D0", false],
      ["hvc1.1.2.L1.90.00", false], ["vp09.00.10.10", false],
      ["vp09.01.10.08", false], ["av01.1.00M.08", false],
      ["av01.0.32M.08", false], ["av01.0.00M.12", false]
    ] as const;
    for (const [codec, valid] of codecs) {
      const host = {
        children: collection([source({
          src: "/motion.avl",
          type: `application/vnd.aval; codecs="${codec}"`
        })])
      } as unknown as HTMLElement;
      expect(readSources(host), codec).toEqual(valid
        ? {
            sources: [{ src: "/motion.avl", codec, integrity: "", sourceIndex: 0 }],
            failures: []
          }
        : {
            sources: [],
            failures: [{ sourceIndex: 0, attribute: "type" }]
          });
    }
  });

  it("preserves duplicate direct sources while ignoring nested and foreign elements", () => {
    const first = source({
      src: "/motion.avl",
      type: 'application/vnd.aval; codecs="av01.0.08M.10"'
    });
    const duplicate = source({
      src: "/motion.avl",
      type: 'application/vnd.aval; codecs="av01.0.08M.10"'
    });
    const container = element("div");
    source({
      src: "/nested.avl",
      type: 'application/vnd.aval; codecs="av01.0.08M.10"'
    }, container as unknown as HTMLElement);
    const foreign = source({
      src: "/foreign.avl",
      type: 'application/vnd.aval; codecs="av01.0.08M.10"'
    }, null, "http://www.w3.org/2000/svg");
    const read = readSources({
      children: collection([first, container, duplicate, foreign])
    } as unknown as HTMLElement);
    expect(read.sources).toEqual([
      {
        src: "/motion.avl",
        codec: "av01.0.08M.10",
        integrity: "",
        sourceIndex: 0
      },
      {
        src: "/motion.avl",
        codec: "av01.0.08M.10",
        integrity: "",
        sourceIndex: 1
      }
    ]);
    expect(read.failures).toEqual([]);
  });

  it("reloads only for direct-child source membership or attributes", () => {
    const host = {} as HTMLElement;
    const direct = source({ src: "/one.avl" }, host);
    const container = element("div");
    const nested = source({ src: "/nested.avl" }, container as unknown as HTMLElement);

    expect(sourceMutation(host, mutation({
      type: "childList",
      target: host,
      addedNodes: [direct]
    }))).toBe(true);
    expect(sourceMutation(host, mutation({
      type: "childList",
      target: host,
      addedNodes: [container]
    }))).toBe(false);
    expect(sourceMutation(host, mutation({
      type: "childList",
      target: container,
      addedNodes: [nested]
    }))).toBe(false);
    expect(sourceMutation(host, mutation({
      type: "attributes",
      target: direct
    }))).toBe(true);
    expect(sourceMutation(host, mutation({
      type: "attributes",
      target: nested
    }))).toBe(false);
  });

  it("includes pixel aspect in intrinsic ratio while explicit size wins", () => {
    const canvas = {
      width: 80,
      height: 40,
      pixelAspect: [3, 2] as const,
      fit: "contain" as const
    };
    expect(intrinsicRatio(null, null, canvas)).toBe(3);
    expect(intrinsicRatio(100, 80, canvas)).toBe(1.25);
    expect(intrinsicRatio(null, null, undefined)).toBeNull();
  });

  it("captures exact initial CSS geometry, DPR, and authored fit", () => {
    const presentation = initialPresentation(
      { width: 0.25, height: 0 },
      2.625,
      "cover"
    );
    expect(presentation).toEqual({
      width: 0.25,
      height: 0,
      dpr: 2.625,
      fit: "cover"
    });
    expect(Object.isFrozen(presentation)).toBe(true);
  });

  it("blocks runtime creation when authoritative styles or the current view are unavailable", () => {
    const view = {} as Window;
    expect(runtimeHostSupported(true, view)).toBe(true);
    expect(runtimeHostSupported(false, view)).toBe(false);
    expect(runtimeHostSupported(true, null)).toBe(false);
  });

  it("captures and binds platform capabilities from the current owner window", async () => {
    const calls: object[] = [];
    class RealmWorker {}
    const performance = {
      now(): number {
        calls.push(this);
        return 17;
      }
    };
    const view = {
      Worker: RealmWorker,
      VideoDecoder: undefined,
      VideoFrame: undefined,
      crypto: {},
      performance,
      fetch(this: object): Promise<Response> {
        calls.push(this);
        return Promise.resolve({} as Response);
      },
      requestAnimationFrame(this: object): number {
        calls.push(this);
        return 9;
      },
      cancelAnimationFrame(this: object): void { calls.push(this); },
      setTimeout(this: object): number {
        calls.push(this);
        return 11;
      },
      clearTimeout(this: object): void { calls.push(this); }
    } as unknown as Window;
    const platform = createRealmPlatform(view);
    await platform.fetch("/asset.avl");
    expect(platform.requestAnimationFrame(() => undefined)).toBe(9);
    expect(platform.now()).toBe(17);
    expect(platform.setTimeout(() => undefined, 1)).toBe(11);
    platform.cancelAnimationFrame(9);
    platform.clearTimeout(11);
    expect(calls).toEqual([view, view, performance, view, view, view]);
    expect(platform.Worker).toBe(RealmWorker);
    expect(platform.VideoDecoder).toBeNull();
    expect(platform.VideoFrame).toBeNull();
    expect(Object.isFrozen(platform)).toBe(true);
  });

  it("uses the newly adopted window for element watchdog timers and exceptions", () => {
    const calls: string[] = [];
    class RealmDOMException extends Error {
      public constructor(message: string, name: string) {
        super(message);
        this.name = name;
      }
    }
    const windowFor = (label: string): Window => ({
      DOMException: RealmDOMException,
      setTimeout: () => {
        calls.push(`${label}:set`);
        return label === "old" ? 1 : 2;
      },
      clearTimeout: (handle: number) => { calls.push(`${label}:clear:${String(handle)}`); }
    }) as unknown as Window;
    const oldTiming = createElementTiming(windowFor("old"));
    const adoptedTiming = createElementTiming(windowFor("new"));
    expect(adoptedTiming.setTimeout(() => undefined, 5)).toBe(2);
    adoptedTiming.clearTimeout(2);
    expect(adoptedTiming.timeoutError()).toBeInstanceOf(RealmDOMException);
    expect(adoptedTiming.abortError()).toMatchObject({ name: "AbortError" });
    expect(calls).toEqual(["new:set", "new:clear:2"]);
    expect(oldTiming).not.toBe(adoptedTiming);
  });

  it("removes listeners from the exact installed realm and rebinds styles to the new one", () => {
    const removed: string[] = [];
    const documentTarget = {
      removeEventListener: (type: string) => { removed.push(`document:${type}`); }
    } as unknown as Pick<Document, "removeEventListener">;
    const viewTarget = {
      removeEventListener: (type: string) => { removed.push(`view:${type}`); }
    } as unknown as Pick<Window, "removeEventListener">;
    const listener = (): void => undefined;
    const pageListener: EventListener = () => undefined;
    removeInstalledListeners(
      documentTarget,
      viewTarget,
      listener,
      listener,
      pageListener,
      pageListener
    );
    expect(removed).toEqual([
      "document:visibilitychange",
      "view:resize",
      "view:pagehide",
      "view:pageshow"
    ]);

    const adoptedDocument = {} as Document;
    let reboundTo: Document | null = null;
    expect(rebindAdoptedStyles({
      rebindStyles: (document) => {
        reboundTo = document;
        return true;
      }
    }, adoptedDocument)).toBe(true);
    expect(reboundTo).toBe(adoptedDocument);
  });

  it("rejects same-task stale focusout work after target/source replacement", async () => {
    const first = {};
    const second = {};
    expect(bindingCurrent(4, 4, first, first)).toBe(true);
    expect(bindingCurrent(4, 5, first, first)).toBe(false);
    expect(bindingCurrent(4, 4, first, second)).toBe(false);
    let epoch = 4;
    let target = first;
    let sent = false;
    queueMicrotask(() => {
      if (bindingCurrent(4, epoch, first, target)) sent = true;
    });
    epoch += 1;
    target = second;
    await Promise.resolve();
    expect(sent).toBe(false);
  });

  it("accepts interaction targets only from the current realm and root", () => {
    const root = {};
    class CurrentElement {
      public constructor(readonly nodeRoot: object) {}
      public getRootNode(): object { return this.nodeRoot; }
    }
    class OldElement {
      public constructor(readonly nodeRoot: object) {}
      public getRootNode(): object { return this.nodeRoot; }
    }
    const host = {
      ownerDocument: { defaultView: { Element: CurrentElement } },
      getRootNode: () => root
    } as unknown as HTMLElement;
    const current = new CurrentElement(root) as unknown as Element;
    expect(interactionTarget(host, current)).toBe(current);
    expect(interactionTarget(host, null)).toBeNull();
    expect(() => interactionTarget(
      host,
      new OldElement(root) as unknown as Element
    )).toThrow("current-realm Element");
    expect(() => interactionTarget(
      host,
      { nodeType: 1, getRootNode: () => root } as unknown as Element
    )).toThrow("current-realm Element");
    expect(() => interactionTarget(
      host,
      new CurrentElement({}) as unknown as Element
    )).toThrow("share the element root");
  });

  it("defers a listener-triggered accepted send until the event transaction exits", async () => {
    const events = new ElementPublicEvents({} as HTMLElement);
    const mutations = new ElementEventMutationGate(events);
    const order: string[] = ["first:start"];
    events.transaction(true);
    const accepted = deferAcceptedSend(
      () => true,
      (operation) => mutations.defer(operation),
      () => { order.push("second"); }
    );
    order.push(`listener:${String(accepted)}`);
    expect(deferAcceptedSend(
      () => false,
      (operation) => mutations.defer(operation),
      () => { order.push("unreachable"); }
    )).toBe(false);
    events.transaction(false);
    order.push("first:end");
    expect(order).toEqual(["first:start", "listener:true", "first:end"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["first:start", "listener:true", "first:end", "second"]);
  });

  it("coalesces same-event B to C attributes and applies the final reflected value", async () => {
    const events = new ElementPublicEvents({} as HTMLElement);
    const mutations = new ElementEventMutationGate(events);
    const pending = new Set<string>();
    const applied: Array<string | null> = [];
    let reflected: string | null = "B";
    events.transaction(true);
    expect(deferAttributeEffect(
      pending,
      "state",
      (operation) => mutations.defer(operation),
      () => reflected,
      (value) => { applied.push(value); }
    )).toBe(true);
    reflected = "C";
    expect(deferAttributeEffect(
      pending,
      "state",
      (operation) => mutations.defer(operation),
      () => reflected,
      (value) => { applied.push(value); }
    )).toBe(true);
    events.transaction(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(applied).toEqual(["C"]);
  });

  it("counts a queued focusout microtask until it actually runs", async () => {
    let pending = 0;
    let ran = false;
    queueOwnedMicrotask(
      (delta) => { pending += delta; },
      () => { ran = true; }
    );
    expect(createOwnershipSnapshot(true, 0, 0, pending).completed).toBe(false);
    await Promise.resolve();
    expect(ran).toBe(true);
    expect(createOwnershipSnapshot(true, 0, 0, pending).completed).toBe(true);
  });

  it("runs engagement followups after listener-accepted sends", async () => {
    const events = new ElementPublicEvents({} as HTMLElement);
    const mutations = new ElementEventMutationGate(events);
    const order: string[] = [];
    let pending = 0;
    events.transaction(true);
    expect(deferAcceptedSend(
      () => true,
      (operation) => mutations.defer(operation),
      () => { order.push("accepted-send"); }
    )).toBe(true);
    events.transaction(false);
    queueOwnedEventFollowup(
      (operation) => events.after(operation),
      (delta) => { pending += delta; },
      () => { order.push("engagement-retry"); }
    );

    expect(pending).toBe(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["accepted-send", "engagement-retry"]);
    expect(pending).toBe(0);
  });

  it("invalidates engagement followups after a listener changes targets", async () => {
    const events = new ElementPublicEvents({} as HTMLElement);
    const mutations = new ElementEventMutationGate(events);
    const first = {};
    const second = {};
    const order: string[] = [];
    let pending = 0;
    let epoch = 1;
    let target = first;
    let replayed = false;
    events.transaction(true);
    expect(mutations.defer(() => {
      epoch += 1;
      target = second;
      order.push("target-change");
    })).toBe(true);
    events.transaction(false);
    queueOwnedEventFollowup(
      (operation) => events.after(operation),
      (delta) => { pending += delta; },
      () => {
        order.push("engagement-retry");
        replayed = bindingCurrent(1, epoch, first, target);
      }
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["target-change", "engagement-retry"]);
    expect(replayed).toBe(false);
    expect(pending).toBe(0);
  });

  it("retains published-player cleanup authority when post-publication startup fails", async () => {
    let authority = true;
    let unpublishedRelease = false;
    await expect(failedGenerationCleanup(
      true,
      async () => { throw new DOMException("cleanup incomplete", "OperationError"); },
      () => { unpublishedRelease = true; }
    )).rejects.toMatchObject({ name: "OperationError" });
    expect(authority).toBe(true);
    expect(unpublishedRelease).toBe(false);

    await failedGenerationCleanup(
      true,
      async () => { authority = false; },
      () => { unpublishedRelease = true; }
    );
    expect(authority).toBe(false);
    expect(unpublishedRelease).toBe(false);
  });

  it("recognizes only persisted pageshow as a BFCache restore", () => {
    expect(persistedPageShow({ persisted: true } as unknown as Event)).toBe(true);
    expect(persistedPageShow({ persisted: false } as unknown as Event)).toBe(false);
    expect(persistedPageShow({} as Event)).toBe(false);
  });

  it("does not wait for first intersection while the document is definitely hidden", () => {
    expect(needsIntersectionSample(false, true)).toBe(true);
    expect(needsIntersectionSample(false, false)).toBe(false);
    expect(needsIntersectionSample(true, true)).toBe(false);
  });

  it("detects a motion policy change that lands while player selection is pending", () => {
    expect(motionSelectionChanged("full", false, "reduce", true)).toBe(true);
    expect(motionSelectionChanged("auto", false, "auto", true)).toBe(true);
    expect(motionSelectionChanged("reduce", true, "reduce", true)).toBe(false);
  });

  it("maps every failure input onto the documented public allowlist", () => {
    const documented = new Set([
      "invalid-asset", "load-failure", "range-response-invalid", "entity-changed",
      "integrity-mismatch", "unsupported-profile", "resource-rejection",
      "readiness-failure", "worker-decode-failure", "renderer-failure",
      "context-loss", "watchdog-timeout", "underflow", "abort", "disposed",
      "invalid-configuration", "unsupported-browser",
      "interaction-target-unavailable", "element-cleanup-incomplete"
    ]);
    const inputs = [...documented] as const;
    for (const input of inputs) {
      expect(documented.has(publicFailureCode(
        input as Parameters<typeof publicFailureCode>[0]
      ))).toBe(true);
    }
  });
});

function source(
  attributes: Readonly<Record<string, string>>,
  parentElement: HTMLElement | null = null,
  namespaceURI = HTML
): Element {
  return {
    nodeType: 1,
    localName: "source",
    namespaceURI,
    parentElement,
    getAttribute: (name: string) => attributes[name] ?? null
  } as unknown as Element;
}

function element(localName: string): Element {
  return {
    nodeType: 1,
    localName,
    namespaceURI: HTML,
    parentElement: null,
    getAttribute: () => null
  } as unknown as Element;
}

function mutation(input: Readonly<{
  type: "attributes" | "childList";
  target: object;
  addedNodes?: readonly object[];
  removedNodes?: readonly object[];
}>): MutationRecord {
  return {
    type: input.type,
    target: input.target,
    addedNodes: input.addedNodes ?? [],
    removedNodes: input.removedNodes ?? []
  } as unknown as MutationRecord;
}

function collection(elements: readonly Element[]): HTMLCollection {
  return {
    length: elements.length,
    item: (index: number) => elements[index] ?? null
  } as unknown as HTMLCollection;
}
