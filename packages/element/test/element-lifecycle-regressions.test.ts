import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  Player,
  PlayerInput,
  PlayerSnapshot
} from "../src/player-contract.js";
import type { AvalElement } from "../src/public-types.js";

const harness = vi.hoisted(() => ({
  brokerMode: "immediate" as "immediate" | "queued",
  inputs: [] as unknown[],
  players: [] as unknown[],
  participants: new Set<BrokerParticipant>(),
  tickets: [] as BrokerTicket[]
}));

vi.mock("../src/page-resources.js", () => ({
  createPageDecoderParticipant: (visible = true) => {
    const participant: BrokerParticipant = {
      visible,
      disposed: false,
      bytes: 0,
      ticket: null
    };
    harness.participants.add(participant);
    return Object.freeze({
      request: () => {
        const ticket = createBrokerTicket(
          participant,
          harness.brokerMode === "immediate"
        );
        participant.ticket = ticket;
        harness.tickets.push(ticket);
        return Object.freeze({
          take: () => ticket.state === "granted" ? ticket.lease : null,
          wait: () => ticket.promise,
          cancel: () => cancelBrokerTicket(ticket),
          state: () => ticket.state
        });
      },
      setVisible: (next: boolean) => { participant.visible = next; },
      setPhysicalBytes: (bytes: number) => { participant.bytes = bytes; },
      dispose: () => {
        if (participant.disposed) return;
        participant.disposed = true;
        participant.bytes = 0;
        if (participant.ticket !== null) cancelBrokerTicket(participant.ticket);
        harness.participants.delete(participant);
      }
    });
  },
  pageResourcesSnapshot: () => Object.freeze({
    active: harness.tickets.reduce(
      (sum, { state }) => sum + (state === "granted" ? 2 : 0),
      0
    ),
    queued: harness.tickets.filter(({ state }) => state === "queued").length,
    parked: 0,
    participants: harness.participants.size,
    physicalBytes: [...harness.participants].reduce((sum, value) => sum + value.bytes, 0)
  })
}));

vi.mock("../src/player.js", () => ({
  createPlayer: async (input: PlayerInput): Promise<Player> => {
    const granted = input.decoderReady();
    let state = input.initialState ?? "idle";
    let disposed = false;
    const metadata = Object.freeze({
      initialState: "idle",
      stateNames: Object.freeze(["idle", "hover"]),
      eventNames: Object.freeze([]),
      bindings: Object.freeze([]),
      canvas: Object.freeze({
        width: 16,
        height: 16,
        pixelAspect: Object.freeze([1, 1] as const),
        fit: "contain" as const
      })
    });
    const snapshot = (): Readonly<PlayerSnapshot> => Object.freeze({
      requestedState: state,
      visualState: state,
      transitioning: false,
      selectedRendition: granted ? "main" : null,
      selectedCodec: granted ? "avc1.64001E" : null,
      selectedBitDepth: granted ? 8 : null,
      transportMode: granted ? "range" : null,
      declaredFileBytes: disposed ? 0 : 1_024,
      metadataBytes: disposed ? 0 : 128,
      verifiedBytes: 0,
      residentBlobBytes: 0,
      activeTransportBodies: 0,
      pendingLoads: 0,
      interestedWaiters: 0,
      workerCount: 0,
      openFrames: 0,
      contextLossCount: 0,
      contextRecoveryCount: 0,
      presentation: Object.freeze({
        cssWidth: disposed ? 0 : 16,
        cssHeight: disposed ? 0 : 16,
        backingWidth: disposed ? 0 : 16,
        backingHeight: disposed ? 0 : 16,
        effectiveDprX: disposed ? 0 : 1,
        effectiveDprY: disposed ? 0 : 1,
        stagingBytes: 0,
        residentBytes: 0,
        textureBytes: 0,
        runtimeBytes: 0,
        pendingOperations: 0,
        sourceCopiesInFlight: 0,
        resourceCount: 0,
        contextListenerCount: 0
      }),
      trace: Object.freeze([])
    });
    const player: Player = {
      metadata,
      activate: () => {
        input.onMetadata(metadata);
        input.onReadiness("metadataReady");
        input.onEvent("requestedstatechange", Object.freeze({
          from: state,
          to: state,
          sequence: 0,
          isTransitioning: false
        }));
        input.onEvent("visualstatechange", Object.freeze({
          from: state,
          to: state,
          isTransitioning: false
        }));
        if (granted) {
          input.onReadiness("visualReady");
          input.onReadiness("interactiveReady");
          input.onDraw();
        } else {
          input.onReadiness("staticReady", "decoder-queued");
          input.onAnimationResourcesRetired();
        }
      },
      prepare: async () => granted ? animatedResult() : queuedResult(),
      setState: async (next) => {
        const previous = state;
        state = next;
        input.onEvent("requestedstatechange", Object.freeze({
          from: previous,
          to: next,
          sequence: 1,
          isTransitioning: false
        }));
        input.onEvent("visualstatechange", Object.freeze({
          from: previous,
          to: next,
          isTransitioning: false
        }));
      },
      canSend: () => false,
      send: () => false,
      readyFor: () => true,
      pause: () => undefined,
      resume: async () => undefined,
      setMotion: async () => undefined,
      suspend: async () => suspendedResult(),
      setVisibility: () => undefined,
      resize: () => undefined,
      snapshot,
      settled: async () => undefined,
      dispose: async () => { disposed = true; }
    };
    harness.inputs.push(input);
    harness.players.push(player);
    return player;
  }
}));

import { createAvalElementClass } from "../src/aval-element.js";

const elements: AvalElement[] = [];

afterEach(async () => {
  await Promise.allSettled(elements.splice(0).map((element) => element.dispose()));
  for (const participant of [...harness.participants]) {
    participant.disposed = true;
    if (participant.ticket !== null) cancelBrokerTicket(participant.ticket);
    harness.participants.delete(participant);
  }
  harness.inputs.length = 0;
  harness.players.length = 0;
  harness.tickets.length = 0;
  FakeMutationObserver.instances.length = 0;
  await settleMicrotasks();
});

describe("element lifecycle regressions", () => {
  it("releases a stale queued decoder grant without restarting the replaced source", async () => {
    harness.brokerMode = "queued";
    const { element, source } = createConnectedElement("first.avl");
    await element.prepare();
    const stale = harness.tickets[0]!;
    expect(stale.state).toBe("queued");
    expect(stale).not.toHaveProperty("weight");

    source.setAttribute("src", "second.avl");
    FakeMutationObserver.instances[0]!.enqueue(attributeMutation(source));
    grantBrokerTicket(stale);
    const replacement = element.prepare();

    await Promise.resolve();
    expect.soft(stale.releases, "the stale lease must be released in its grant callback").toBe(1);
    await replacement;
    expect(harness.inputs).toHaveLength(2);
    expect(inputAt(1).sources[0]?.src).toBe("second.avl");
    expect(inputAt(1).initialState).toBeNull();
  });

  it("preserves requested state across persisted BFCache restore after suspension completes", async () => {
    harness.brokerMode = "immediate";
    const { element, view } = createConnectedElement("motion.avl");
    await element.prepare();
    await element.setState("hover");
    expect(element.requestedState).toBe("hover");

    view.dispatchEvent(new Event("pagehide"));
    await settleMicrotasks();
    expect(element.staticReason).toBe("visibility-suspended");

    const restored = new Event("pageshow");
    Object.defineProperty(restored, "persisted", { value: true });
    view.dispatchEvent(restored);
    await element.prepare();

    expect(harness.inputs).toHaveLength(2);
    expect(inputAt(1).initialState).toBe("hover");
  });
});

type BrokerState = "queued" | "granted" | "cancelled" | "released";
type BrokerLease = Readonly<{ release: () => void }>;
interface BrokerParticipant {
  visible: boolean;
  disposed: boolean;
  bytes: number;
  ticket: BrokerTicket | null;
}
interface BrokerTicket {
  readonly participant: BrokerParticipant;
  state: BrokerState;
  lease: BrokerLease | null;
  readonly promise: Promise<BrokerLease>;
  resolve: ((lease: BrokerLease) => void) | null;
  reject: ((reason: unknown) => void) | null;
  releases: number;
}

function createBrokerTicket(
  participant: BrokerParticipant,
  immediate: boolean
): BrokerTicket {
  let resolve!: (lease: BrokerLease) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<BrokerLease>((accepted, rejected) => {
    resolve = accepted;
    reject = rejected;
  });
  const ticket: BrokerTicket = {
    participant,
    state: "queued",
    lease: null,
    promise,
    resolve,
    reject,
    releases: 0
  };
  if (immediate) grantBrokerTicket(ticket);
  return ticket;
}

function grantBrokerTicket(ticket: BrokerTicket): void {
  if (ticket.state !== "queued") throw new Error("ticket is not queued");
  ticket.state = "granted";
  let released = false;
  const lease = Object.freeze({
    release: () => {
      if (released) return;
      released = true;
      ticket.releases += 1;
      ticket.state = "released";
      ticket.lease = null;
      if (ticket.participant.ticket === ticket) ticket.participant.ticket = null;
    }
  });
  ticket.lease = lease;
  ticket.resolve?.(lease);
  ticket.resolve = null;
  ticket.reject = null;
}

function cancelBrokerTicket(ticket: BrokerTicket): void {
  if (ticket.state === "granted") {
    ticket.lease?.release();
    return;
  }
  if (ticket.state !== "queued") return;
  ticket.state = "cancelled";
  ticket.reject?.(new DOMException("Decoder request cancelled", "AbortError"));
  ticket.resolve = null;
  ticket.reject = null;
  if (ticket.participant.ticket === ticket) ticket.participant.ticket = null;
}

function inputAt(index: number): Readonly<PlayerInput> {
  return harness.inputs[index] as Readonly<PlayerInput>;
}

function animatedResult() {
  return Object.freeze({
    mode: "animated" as const,
    assurance: "best-effort" as const,
    report: Object.freeze({
      readiness: "interactiveReady" as const,
      selectedRendition: "main",
      candidates: Object.freeze([])
    })
  });
}

function queuedResult() {
  return Object.freeze({
    mode: "static" as const,
    reason: "decoder-queued" as const,
    report: Object.freeze({
      readiness: "staticReady" as const,
      selectedRendition: null,
      candidates: Object.freeze([])
    })
  });
}

function suspendedResult() {
  return Object.freeze({
    mode: "static" as const,
    reason: "visibility-suspended" as const,
    report: Object.freeze({
      readiness: "staticReady" as const,
      selectedRendition: null,
      candidates: Object.freeze([])
    })
  });
}

const HTML = "http://www.w3.org/1999/xhtml";
let currentDocument: FakeDocument;

function createConnectedElement(src: string): {
  element: AvalElement;
  source: FakeElement;
  view: FakeWindow;
} {
  const view = new FakeWindow();
  currentDocument = new FakeDocument(view);
  view.document = currentDocument;
  const Constructor = createAvalElementClass(
    FakeHTMLElement as unknown as typeof HTMLElement
  );
  const element = new Constructor() as AvalElement & FakeHTMLElement & {
    connectedCallback(): void;
  };
  const source = new FakeElement("source", currentDocument);
  source.parentElement = element as unknown as FakeHTMLElement;
  source.setAttribute("src", src);
  source.setAttribute("type", 'application/vnd.aval; codecs="avc1.64001E"');
  element.childElements.push(source);
  element.isConnected = true;
  element.connectedCallback();
  elements.push(element);
  return { element, source, view };
}

class FakeHTMLElement extends EventTarget {
  public readonly ownerDocument = currentDocument;
  public readonly childElements: FakeElement[] = [];
  public readonly attributes = new Map<string, string>();
  public readonly localName = "aval-player";
  public readonly namespaceURI = HTML;
  public readonly nodeType = 1;
  public isConnected = false;
  readonly #root = new FakeShadowRoot(this.ownerDocument);

  public get children(): HTMLCollection {
    return {
      length: this.childElements.length,
      item: (index: number) => this.childElements[index] ?? null
    } as unknown as HTMLCollection;
  }

  public attachShadow(): ShadowRoot { return this.#root as unknown as ShadowRoot; }
  public getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  public setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  public removeAttribute(name: string): void { this.attributes.delete(name); }
  public getBoundingClientRect(): DOMRect {
    return { width: 16, height: 16 } as DOMRect;
  }
  public matches(_selector: string): boolean { return false; }
  public contains(node: unknown): boolean { return node === this; }
  public getRootNode(): Document { return this.ownerDocument as unknown as Document; }
}

class FakeElement extends EventTarget {
  public readonly nodeType = 1;
  public readonly namespaceURI = HTML;
  public readonly dataset: Record<string, string> = {};
  public parentElement: FakeHTMLElement | null = null;
  public hidden = false;
  public name = "";
  public width = 0;
  public height = 0;
  public tabIndex = 0;
  readonly #attributes = new Map<string, string>();

  public constructor(
    public readonly localName: string,
    public readonly ownerDocument: FakeDocument
  ) { super(); }

  public getAttribute(name: string): string | null { return this.#attributes.get(name) ?? null; }
  public setAttribute(name: string, value: string): void { this.#attributes.set(name, value); }
}

class FakeShadowRoot {
  public adoptedStyleSheets: FakeCSSStyleSheet[] = [];
  public constructor(public readonly ownerDocument: FakeDocument) {}
  public append(..._nodes: unknown[]): void {}
}

class FakeCSSStyleRule {
  public readonly style = { setProperty: () => undefined };
}

class FakeCSSStyleSheet {
  public readonly cssRules = { item: () => new FakeCSSStyleRule() };
  public replaceSync(_css: string): void {}
}

class FakeCustomEvent<T> extends Event {
  public readonly detail: T;
  public constructor(type: string, init: CustomEventInit<T>) {
    super(type, init);
    this.detail = init.detail as T;
  }
}

class FakeMutationObserver {
  public static readonly instances: FakeMutationObserver[] = [];
  readonly #records: MutationRecord[] = [];
  public constructor(readonly callback: MutationCallback) {
    FakeMutationObserver.instances.push(this);
  }
  public observe(): void {}
  public disconnect(): void { this.#records.length = 0; }
  public takeRecords(): MutationRecord[] { return this.#records.splice(0); }
  public enqueue(record: MutationRecord): void { this.#records.push(record); }
}

class FakeIntersectionObserver {
  public constructor(readonly callback: IntersectionObserverCallback) {}
  public observe(target: Element): void {
    this.callback([{
      target,
      isIntersecting: true,
      intersectionRatio: 1
    } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  public disconnect(): void {}
}

class FakeWindow extends EventTarget {
  public document!: FakeDocument;
  public readonly MutationObserver = FakeMutationObserver;
  public readonly IntersectionObserver = FakeIntersectionObserver;
  public readonly CSSStyleSheet = FakeCSSStyleSheet;
  public readonly CSSStyleRule = FakeCSSStyleRule;
  public readonly CustomEvent = FakeCustomEvent;
  public readonly Element = FakeHTMLElement;
  public readonly Worker = class {};
  public readonly VideoDecoder = class {};
  public readonly VideoFrame = class {};
  public readonly crypto = {} as Crypto;
  public readonly performance = globalThis.performance;
  public readonly devicePixelRatio = 1;
  public readonly fetch = async (): Promise<Response> => ({} as Response);
  public readonly requestAnimationFrame = (_callback: FrameRequestCallback): number => 1;
  public readonly cancelAnimationFrame = (_handle: number): void => undefined;
  public readonly setTimeout = (callback: () => void, delay: number): number =>
    globalThis.setTimeout(callback, delay) as unknown as number;
  public readonly clearTimeout = (handle: number): void => globalThis.clearTimeout(handle);
  public readonly matchMedia = (): MediaQueryList => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }) as unknown as MediaQueryList;
}

class FakeDocument extends EventTarget {
  public visibilityState: DocumentVisibilityState = "visible";
  public activeElement: Element | null = null;
  public readonly baseURI = "https://example.test/";
  public constructor(public readonly defaultView: FakeWindow) { super(); }
  public createElement(localName: string): FakeElement {
    return new FakeElement(localName, this);
  }
}

function attributeMutation(target: FakeElement): MutationRecord {
  return {
    type: "attributes",
    target,
    addedNodes: [],
    removedNodes: []
  } as unknown as MutationRecord;
}

async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
