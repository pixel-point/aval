import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  Player,
  PlayerDecoderDiagnostic,
  PlayerInput,
  PlayerSnapshot
} from "../src/player-contract.js";
import type { AvalElement } from "../src/public-types.js";
import { AvalPlaybackError } from "../src/errors.js";

const harness = vi.hoisted(() => ({
  brokerMode: "immediate" as "immediate" | "queued",
  inputs: [] as unknown[],
  players: [] as unknown[],
  failNextPrepare: false,
  failNextPrepareGeneric: false,
  deferNextPrepareFailure: false,
  deferNextDispose: false,
  deferredFailures: [] as DeferredFailure[],
  deferredDisposals: [] as Array<() => void>,
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
    const failPrepare = harness.failNextPrepare;
    harness.failNextPrepare = false;
    const failPrepareGeneric = harness.failNextPrepareGeneric;
    harness.failNextPrepareGeneric = false;
    const deferPrepareFailure = harness.deferNextPrepareFailure;
    harness.deferNextPrepareFailure = false;
    let state = input.initialState ?? "idle";
    let disposed = false;
    let animationRetired = false;
    let disposal: Promise<void> | null = null;
    let decoderDiagnostics: readonly Readonly<PlayerDecoderDiagnostic>[] = Object.freeze([]);
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
      declaredFileBytes: disposed || animationRetired ? 0 : 1_024,
      metadataBytes: disposed || animationRetired ? 0 : 128,
      verifiedBytes: 0,
      residentBlobBytes: 0,
      activeTransportBodies: 0,
      pendingLoads: 0,
      interestedWaiters: 0,
      workerCount: 0,
      openFrames: 0,
      contextLossCount: 0,
      contextRecoveryCount: 0,
      decoderDiagnostics,
      presentation: Object.freeze({
        cssWidth: disposed || animationRetired ? 0 : 16,
        cssHeight: disposed || animationRetired ? 0 : 16,
        backingWidth: disposed || animationRetired ? 0 : 16,
        backingHeight: disposed || animationRetired ? 0 : 16,
        effectiveDprX: disposed || animationRetired ? 0 : 1,
        effectiveDprY: disposed || animationRetired ? 0 : 1,
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
    const player: TestPlayer = {
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
        if (failPrepare) return;
        if (granted) {
          input.onReadiness("visualReady");
          input.onReadiness("interactiveReady");
          input.onDraw();
        } else {
          input.onReadiness("staticReady", "decoder-queued");
          input.onAnimationResourcesRetired();
        }
      },
      prepare: () => {
        if (deferPrepareFailure) {
          return new Promise((_, reject) => {
            harness.deferredFailures.push({
              fail: () => {
                animationRetired = true;
                input.onAnimationResourcesRetired();
                reject(input.onPlaybackFailure(
                  "worker-decode-failure",
                  "prepare"
                ));
              }
            });
          });
        }
        if (failPrepare) {
          animationRetired = true;
          input.onAnimationResourcesRetired();
          return Promise.reject(input.onPlaybackFailure(
            "worker-decode-failure",
            "prepare"
          ));
        }
        if (failPrepareGeneric) {
          return Promise.reject(new Error("synthetic preparation failure"));
        }
        return Promise.resolve(granted ? animatedResult() : queuedResult());
      },
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
      dispose: () => {
        if (!harness.deferNextDispose) {
          disposed = true;
          return Promise.resolve();
        }
        disposal ??= new Promise<void>((resolve) => {
          harness.deferredDisposals.push(() => {
            disposed = true;
            harness.deferNextDispose = false;
            resolve();
          });
        });
        return disposal;
      },
      failActive: () => {
        const diagnostic: Readonly<PlayerDecoderDiagnostic> = Object.freeze({
          sourceIndex: 0,
          rendition: "main",
          codec: "avc1.64001E",
          unit: "idle-body",
          lane: 0,
          phase: "decode",
          code: "decoder-operation",
          run: 1,
          decodeOrdinal: 0,
          exception: Object.freeze({
            name: "Error",
            message: "synthetic decoder failure"
          }),
          firstFrame: null
        });
        decoderDiagnostics = Object.freeze([diagnostic]);
        input.onDecoderDiagnostics?.(decoderDiagnostics);
        animationRetired = true;
        input.onAnimationResourcesRetired();
        return input.onPlaybackFailure("worker-decode-failure", "playback");
      },
      disposed: () => disposed
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
  harness.failNextPrepare = false;
  harness.failNextPrepareGeneric = false;
  harness.deferNextPrepareFailure = false;
  harness.deferNextDispose = false;
  harness.deferredFailures.length = 0;
  harness.deferredDisposals.length = 0;
  harness.tickets.length = 0;
  FakeMutationObserver.instances.length = 0;
  await settleMicrotasks();
});

describe("element lifecycle regressions", () => {
  it("retains one canonical playback error until a newer source generation", async () => {
    harness.brokerMode = "immediate";
    harness.failNextPrepare = true;
    const { element, source } = createConnectedElement("broken.avl");
    const errors: Array<CustomEvent<Readonly<{
      generation: number;
      failure: Readonly<{ code: string; message: string; operation: string | null }>;
      fatal: boolean;
    }>>> = [];
    element.addEventListener("error", ((event: CustomEvent) => {
      errors.push(event as typeof errors[number]);
    }) as EventListener);

    let first!: AvalPlaybackError;
    try {
      await element.prepare();
    } catch (error) {
      expect(error).toBeInstanceOf(AvalPlaybackError);
      first = error as AvalPlaybackError;
    }

    expect(errors).toHaveLength(1);
    expect(errors[0]!.detail.fatal).toBe(true);
    expect(errors[0]!.detail.failure).toBe(first.failure);
    expect(element.readiness).toBe("error");
    expect(element.getDiagnostics().lastFailure).toBe(first.failure);
    const playerCount = harness.players.length;

    await expect(element.prepare()).rejects.toBe(first);
    expect(errors).toHaveLength(1);
    expect(harness.players).toHaveLength(playerCount);

    source.setAttribute("src", "healthy.avl");
    FakeMutationObserver.instances[0]!.enqueue(attributeMutation(source));
    await expect(element.prepare()).resolves.toMatchObject({ mode: "animated" });
    expect(harness.players).toHaveLength(playerCount + 1);
    expect(element.getDiagnostics().lastFailure).toBeNull();
  });

  it.each(["setState", "resume"] as const)(
    "rejects a %s continuation with the retained terminal error",
    async (operation) => {
      harness.brokerMode = "immediate";
      const { element } = createConnectedElement("motion.avl");
      await element.prepare();
      if (operation === "resume") element.pause();
      const events: CustomEvent[] = [];
      element.addEventListener("error", ((event: CustomEvent) => {
        events.push(event);
      }) as EventListener);

      const pending = operation === "setState"
        ? element.setState("hover")
        : element.resume();
      void pending.catch(() => undefined);
      const terminal = playerAt(0).failActive();

      await expect(pending).rejects.toBe(terminal);
      expect(events).toHaveLength(1);
      expect(events[0]!.detail).toMatchObject({ fatal: true, generation: 1 });
      expect(events[0]!.detail.failure).toBe(terminal.failure);
      await expect(element.prepare()).rejects.toBe(terminal);
      await eventually(() => playerAt(0).disposed());
      expect(element.getDiagnostics()).toMatchObject({
        readiness: "error",
        lastFailure: terminal.failure,
        outstanding: { player: 0, decoder: 0, bytes: 0 }
      });
    }
  );

  it("retires an active failed generation before publishing one retained error", async () => {
    harness.brokerMode = "immediate";
    const { element, source } = createConnectedElement("motion.avl");
    await element.prepare();
    const player = playerAt(0);
    const rejectedProbe: Readonly<PlayerDecoderDiagnostic> = Object.freeze({
      sourceIndex: 0,
      rendition: "av1",
      codec: "av01.0.08M.10",
      unit: null,
      lane: 1,
      phase: "probe",
      code: "unsupported-config",
      run: null,
      decodeOrdinal: null,
      exception: Object.freeze({
        name: "NotSupportedError",
        message: "decoder configuration is unsupported"
      }),
      firstFrame: null
    });
    inputAt(0).onDecoderDiagnostics?.(Object.freeze([rejectedProbe]));
    inputAt(0).onDecoderDiagnostics?.(Object.freeze([]));
    expect(element.getDiagnostics().runtime.decoderDiagnostics).toMatchObject([
      {
        sourceGeneration: 1,
        lane: 1,
        rendition: "av1",
        code: "unsupported-config"
      }
    ]);
    const events: CustomEvent[] = [];
    let diagnosticsAtEvent: ReturnType<AvalElement["getDiagnostics"]> | null = null;
    element.addEventListener("error", ((event: CustomEvent) => {
      events.push(event);
      diagnosticsAtEvent = element.getDiagnostics();
    }) as EventListener);

    const error = player.failActive();

    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatchObject({ fatal: true, generation: 1 });
    expect(events[0]!.detail.failure).toBe(error.failure);
    expect(diagnosticsAtEvent).toMatchObject({
      readiness: "error",
      mode: null,
      lastFailure: error.failure,
      outstanding: { decoder: 0, bytes: 0 },
      runtime: {
        declaredFileBytes: 0,
        activeLeaseCount: 0,
        pageParticipantCount: 0,
        pagePhysicalBytes: 0,
        decoderDiagnostics: [
          {
            sourceGeneration: 1,
            sourceIndex: 0,
            rendition: "main",
            codec: "avc1.64001E",
            unit: "idle-body",
            lane: 0,
            phase: "decode",
            code: "decoder-operation",
            run: 1,
            decodeOrdinal: 0,
            exception: {
              name: "Error",
              message: "synthetic decoder failure"
            },
            firstFrame: null
          },
          {
            sourceGeneration: 1,
            sourceIndex: 0,
            rendition: "av1",
            codec: "av01.0.08M.10",
            unit: null,
            lane: 1,
            phase: "probe",
            code: "unsupported-config",
            run: null,
            decodeOrdinal: null,
            exception: {
              name: "NotSupportedError",
              message: "decoder configuration is unsupported"
            },
            firstFrame: null
          }
        ]
      }
    });
    const capturedAtEvent = diagnosticsAtEvent as unknown as ReturnType<
      AvalElement["getDiagnostics"]
    >;
    const [diagnosticAtEvent, probeAtEvent] =
      capturedAtEvent.runtime.decoderDiagnostics;
    expect(Object.isFrozen(diagnosticAtEvent)).toBe(true);
    expect(Object.isFrozen(diagnosticAtEvent?.exception)).toBe(true);
    expect(Object.isFrozen(probeAtEvent)).toBe(true);
    await expect(element.prepare()).rejects.toBe(error);
    expect(events).toHaveLength(1);

    await eventually(() => player.disposed());
    expect(element.getDiagnostics().outstanding.player).toBe(0);
    expect(element.getDiagnostics().runtime.decoderDiagnostics).toEqual([
      diagnosticAtEvent,
      probeAtEvent
    ]);

    source.setAttribute("src", "replacement.avl");
    FakeMutationObserver.instances[0]!.enqueue(attributeMutation(source));
    await expect(element.prepare()).resolves.toMatchObject({ mode: "animated" });
    expect(element.getDiagnostics().lastFailure).toBeNull();
    expect(element.getDiagnostics().runtime.decoderDiagnostics).toEqual([]);
  });

  it("does not let deferred terminal retirement cancel an error-listener replacement", async () => {
    harness.brokerMode = "immediate";
    const { element, source } = createConnectedElement("motion.avl");
    await element.prepare();
    let replacement: Promise<unknown> | null = null;
    element.addEventListener("error", () => {
      source.setAttribute("src", "replacement.avl");
      FakeMutationObserver.instances[0]!.enqueue(attributeMutation(source));
      replacement = element.prepare();
    }, { once: true });

    playerAt(0).failActive();

    await eventually(() => replacement !== null);
    await expect(replacement).resolves.toMatchObject({ mode: "animated" });
    expect(harness.players).toHaveLength(2);
    expect(element.getDiagnostics()).toMatchObject({
      sourceGeneration: 2,
      readiness: "interactiveReady",
      lastFailure: null
    });
  });

  it("does not publish an old failure when cleanup is superseded", async () => {
    harness.brokerMode = "immediate";
    harness.failNextPrepareGeneric = true;
    harness.deferNextDispose = true;
    const { element, source } = createConnectedElement("old.avl");
    const errors: CustomEvent[] = [];
    element.addEventListener("error", ((event: CustomEvent) => {
      errors.push(event);
    }) as EventListener);
    const stale = element.prepare();
    void stale.catch(() => undefined);
    await eventually(() => harness.deferredDisposals.length === 1);

    source.setAttribute("src", "new.avl");
    FakeMutationObserver.instances[0]!.enqueue(attributeMutation(source));
    const replacement = element.prepare();
    harness.deferredDisposals[0]!();

    await expect(stale).rejects.toMatchObject({ name: "AbortError" });
    await expect(replacement).resolves.toMatchObject({ mode: "animated" });
    expect(errors).toHaveLength(0);
    expect(element.getDiagnostics().lastFailure).toBeNull();
  });

  it("turns a superseded deferred terminal failure into AbortError", async () => {
    harness.brokerMode = "immediate";
    harness.deferNextPrepareFailure = true;
    const { element, source } = createConnectedElement("old.avl");
    const events: CustomEvent[] = [];
    element.addEventListener("error", ((event: CustomEvent) => {
      events.push(event);
    }) as EventListener);
    const stale = element.prepare();
    void stale.catch(() => undefined);
    await eventually(() => harness.deferredFailures.length === 1);

    source.setAttribute("src", "new.avl");
    FakeMutationObserver.instances[0]!.enqueue(attributeMutation(source));
    const replacement = element.prepare();
    harness.deferredFailures[0]!.fail();

    await expect(stale).rejects.toMatchObject({ name: "AbortError" });
    await expect(replacement).resolves.toMatchObject({ mode: "animated" });
    expect(events).toHaveLength(0);
    expect(element.getDiagnostics().lastFailure).toBeNull();
  });

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

interface DeferredFailure {
  fail(): void;
}

interface TestPlayer extends Player {
  failActive(): AvalPlaybackError;
  disposed(): boolean;
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

function playerAt(index: number): TestPlayer {
  return harness.players[index] as TestPlayer;
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

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 32; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition did not settle");
}
