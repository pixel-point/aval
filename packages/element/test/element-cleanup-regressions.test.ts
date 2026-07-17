import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  Player,
  PlayerInput,
  PlayerSnapshot
} from "../src/player-contract.js";
import type { AvalElement } from "../src/public-types.js";

const runtime = vi.hoisted(() => ({
  failDispose: false,
  physicalBytes: 0,
  sources: [] as string[],
  creationHold: null as Promise<void> | null,
  creationReached: null as (() => void) | null,
  disposeAttempts: 0
}));

vi.mock("../src/player.js", () => ({
  createPlayer: async (input: PlayerInput): Promise<Player> => {
    runtime.sources.push(input.sources[0]?.src ?? "");
    if (!input.decoderReady()) throw new Error("decoder lease was not granted");
    if (runtime.creationHold !== null) {
      input.onResourceBytes(runtime.physicalBytes);
      runtime.creationReached?.();
      await runtime.creationHold;
    }
    let disposed = false;
    const metadata = Object.freeze({
      initialState: "idle",
      stateNames: Object.freeze(["idle"]),
      eventNames: Object.freeze([]),
      bindings: Object.freeze([]),
      canvas: Object.freeze({
        width: 16,
        height: 16,
        pixelAspect: Object.freeze([1, 1] as const),
        fit: "contain" as const
      })
    });
    return {
      metadata,
      activate: () => {
        input.onMetadata(metadata);
        input.onResourceBytes(runtime.physicalBytes);
        input.onReadiness("interactiveReady");
      },
      prepare: async () => animatedResult(),
      setState: async () => undefined,
      canSend: () => false,
      send: () => false,
      readyFor: () => false,
      pause: () => undefined,
      resume: async () => undefined,
      setMotion: async () => undefined,
      suspend: async () => suspendedResult(),
      setVisibility: () => undefined,
      resize: () => undefined,
      snapshot: () => playerSnapshot(!disposed),
      settled: async () => undefined,
      dispose: async () => {
        runtime.disposeAttempts += 1;
        if (runtime.failDispose) throw new Error("synthetic retirement failure");
        disposed = true;
      }
    };
  }
}));

import { createAvalElementClass } from "../src/aval-element.js";

const elements: Array<AvalElement & { controls: Controls }> = [];

afterEach(async () => {
  runtime.failDispose = false;
  runtime.physicalBytes = 0;
  runtime.creationHold = null;
  runtime.creationReached = null;
  for (const element of elements.splice(0)) {
    element.controls.throwCanvasWidthReset = false;
    element.controls.throwMutationDisconnect = false;
    element.controls.throwDocumentRemove = false;
    await Promise.resolve().then(() => element.dispose()).catch(() => undefined);
  }
  runtime.sources.length = 0;
  runtime.disposeAttempts = 0;
  FakeMutationObserver.instances.length = 0;
  await settleMicrotasks();
});

describe("element cleanup regressions", () => {
  it("retains decoder lease and byte authority until failed retirement proves cleanup", async () => {
    runtime.failDispose = true;
    runtime.physicalBytes = 4_096;
    const { element } = createElement(true);
    connect(element);
    await element.prepare();
    expect(element.getDiagnostics().runtime).toMatchObject({
      pageActiveDecoderSlotCount: 2,
      pageParticipantCount: 1,
      pagePhysicalBytes: 4_096
    });

    let failure: unknown = null;
    let retainedRuntime: Readonly<Record<string, unknown>> = Object.freeze({});
    try {
      await element.dispose();
    } catch (error) {
      failure = error;
      retainedRuntime = element.getDiagnostics().runtime as unknown as Readonly<
        Record<string, unknown>
      >;
    }

    runtime.failDispose = false;
    await element.dispose();

    expect.soft(failure).toMatchObject({ message: "synthetic retirement failure" });
    expect.soft(retainedRuntime).toMatchObject({
      activeLeaseCount: 1,
      decoderLeaseState: "granted",
      playerTrackedBytes: 4_096,
      pagePhysicalBytes: 4_096,
      pageActiveDecoderSlotCount: 2,
      pageParticipantCount: 1
    });
    expect(element.getDiagnostics().runtime).toMatchObject({
      activeLeaseCount: 0,
      decoderLeaseState: null,
      playerTrackedBytes: 0,
      pagePhysicalBytes: 0,
      pageActiveDecoderSlotCount: 0,
      pageParticipantCount: 0
    });
  });

  it("rejects incomplete terminal presentation cleanup and retries it", async () => {
    const { element, controls } = createElement(false);
    controls.throwCanvasWidthReset = true;
    let failure: unknown = null;
    try {
      await element.dispose();
    } catch (error) {
      failure = error;
    }

    controls.throwCanvasWidthReset = false;
    await element.dispose();
    const terminal = element.getDiagnostics().terminalCleanup;

    expect.soft(failure).toMatchObject({ name: "OperationError" });
    expect.soft(terminal).toMatchObject({ completed: true });
    expect.soft(controls.canvasWidthResetAttempts).toBe(2);
  });

  it("retries failed source retirement on the next prepare without releasing authority", async () => {
    runtime.physicalBytes = 4_096;
    const { element } = createElement(true);
    const source = (element as unknown as FakeHTMLElement).childElements[0]!;
    connect(element);
    await element.prepare();

    runtime.failDispose = true;
    source.setAttribute("src", "/replacement.avl");
    FakeMutationObserver.instances.at(-1)!.enqueue({
      type: "attributes",
      target: source
    } as unknown as MutationRecord);
    await expect(element.prepare()).rejects.toThrow("synthetic retirement failure");
    expect(element.getDiagnostics()).toMatchObject({
      sourceGeneration: 1,
      runtime: {
        activeLeaseCount: 1,
        playerTrackedBytes: 4_096,
        pagePhysicalBytes: 4_096,
        pageActiveDecoderSlotCount: 2,
        pageParticipantCount: 1
      }
    });

    runtime.failDispose = false;
    await element.prepare();

    expect.soft(runtime.sources).toEqual(["/motion.avl", "/replacement.avl"]);
    expect(element.getDiagnostics()).toMatchObject({
      sourceGeneration: 2,
      runtime: {
        activeLeaseCount: 1,
        playerTrackedBytes: 4_096,
        pagePhysicalBytes: 4_096,
        pageActiveDecoderSlotCount: 2,
        pageParticipantCount: 1
      }
    });
  });

  it("retains an unpublished superseded player until terminal cleanup can prove it", async () => {
    runtime.failDispose = true;
    runtime.physicalBytes = 4_096;
    let releaseCreation!: () => void;
    let markCreationReached!: () => void;
    const creationReached = new Promise<void>((resolve) => {
      markCreationReached = resolve;
    });
    runtime.creationReached = markCreationReached;
    runtime.creationHold = new Promise<void>((resolve) => {
      releaseCreation = resolve;
    });
    const { element } = createElement(true);
    connect(element);

    const preparation = element.prepare();
    await creationReached;
    const terminal = element.dispose();
    releaseCreation();
    const attempts = await Promise.allSettled([preparation, terminal]);

    expect.soft(attempts).toHaveLength(2);
    for (const attempt of attempts) {
      expect.soft(attempt.status).toBe("rejected");
      if (attempt.status === "rejected") {
        expect.soft(attempt.reason).toMatchObject({
          message: "synthetic retirement failure"
        });
      }
    }
    expect.soft(runtime.disposeAttempts).toBe(2);
    expect(element.getDiagnostics()).toMatchObject({
      finalDisposed: false,
      cleanup: {
        completed: false,
        playerDisposed: false,
        participantDisposed: false,
        participantLogicalBytes: 4_096,
        participantActiveLeaseCount: 1
      },
      terminalCleanup: {
        completed: false,
        sourceCleanupCompleted: false
      },
      outstanding: { player: 1, decoder: 2, bytes: 4_096 },
      runtime: {
        declaredFileBytes: 1_024,
        activeLeaseCount: 1,
        playerTrackedBytes: 4_096,
        pagePhysicalBytes: 4_096,
        pageActiveDecoderSlotCount: 2,
        pageParticipantCount: 1
      }
    });

    runtime.failDispose = false;
    runtime.creationHold = null;
    runtime.creationReached = null;
    await element.dispose();

    expect.soft(runtime.disposeAttempts).toBe(3);
    expect(element.getDiagnostics()).toMatchObject({
      finalDisposed: true,
      cleanup: {
        completed: true,
        playerDisposed: true,
        participantDisposed: true,
        participantLogicalBytes: 0,
        participantActiveLeaseCount: 0
      },
      terminalCleanup: {
        completed: true,
        sourceCleanupCompleted: true
      },
      outstanding: { player: 0, decoder: 0, bytes: 0 },
      runtime: {
        declaredFileBytes: 0,
        metadataBytes: 0,
        verifiedBytes: 0,
        residentBlobBytes: 0,
        activeLeaseCount: 0,
        decoderLeaseState: null,
        playerTrackedBytes: 0,
        pagePhysicalBytes: 0,
        pageActiveDecoderSlotCount: 0,
        pageParticipantCount: 0
      }
    });
  });

  it("keeps terminal proof monotonic when adoption is reported after disposal", async () => {
    const { element } = createElement(false);
    await element.dispose();
    const before = element.getDiagnostics({ trace: true });

    (element as unknown as { adoptedCallback(): void }).adoptedCallback();
    const immediate = element.getDiagnostics({ trace: true });
    await settleMicrotasks();
    const settled = element.getDiagnostics({ trace: true });

    expect.soft(before).toMatchObject({
      finalDisposed: true,
      terminalCleanup: { completed: true },
      elementOwnership: {
        listenerCount: 0,
        observerCount: 0,
        pendingCommandCount: 0,
        completed: true
      }
    });
    expect.soft(immediate.terminalCleanup).toBe(before.terminalCleanup);
    expect.soft(settled.terminalCleanup).toBe(before.terminalCleanup);
    expect.soft(immediate.elementOwnership).toMatchObject({
      listenerCount: 0,
      observerCount: 0,
      pendingCommandCount: 0,
      completed: true
    });
    expect.soft(settled.elementOwnership).toEqual(immediate.elementOwnership);
    expect.soft(immediate.counters).toEqual(before.counters);
    expect.soft(settled.counters).toEqual(before.counters);
    expect.soft(immediate.elementTrace).toEqual(before.elementTrace);
    expect.soft(settled.elementTrace).toEqual(before.elementTrace);
  });

  it("keeps disposed-event reentrancy outside the terminal ownership proof", async () => {
    const { element } = createElement(false);
    connect(element);
    await settleMicrotasks();
    expect(element.getDiagnostics().sourceGeneration).toBe(1);

    element.addEventListener("readinesschange", (event) => {
      const detail = (event as CustomEvent<{ to: string }>).detail;
      if (detail.to !== "disposed") return;
      void element.dispose().catch(() => undefined);
      void element.resume().catch(() => undefined);
    });

    await element.dispose();
    await settleMicrotasks();
    expect(element.getDiagnostics()).toMatchObject({
      terminalCleanup: { completed: true },
      elementOwnership: { pendingCommandCount: 0, completed: true }
    });
  });

  it("rolls back a failed source-observer install and permits retry", async () => {
    const { element, controls } = createElement(false);
    controls.throwMutationObserve = true;
    expect(() => connect(element)).not.toThrow();
    const disconnectsAfterFailure = controls.mutationDisconnects;

    controls.throwMutationObserve = false;
    expect(() => element.connectedCallback()).not.toThrow();
    const observesAfterRetry = controls.mutationObserves;
    await element.dispose();

    expect.soft(disconnectsAfterFailure).toBe(1);
    expect.soft(observesAfterRetry).toBe(2);
  });

  it("rolls back an add-then-throw listener install and permits retry", async () => {
    const { element, controls } = createElement(false);
    controls.throwAfterDocumentAdd = "visibilitychange";
    expect(() => connect(element)).not.toThrow();
    const removalsAfterFailure = controls.documentRemoveAttempts
      .filter((type) => type === "visibilitychange").length;
    const disconnectsAfterFailure = controls.mutationDisconnects;

    controls.throwAfterDocumentAdd = null;
    expect(() => element.connectedCallback()).not.toThrow();
    const observesAfterRetry = controls.mutationObserves;
    await element.dispose();

    expect.soft(removalsAfterFailure).toBe(1);
    expect.soft(disconnectsAfterFailure).toBe(1);
    expect.soft(observesAfterRetry).toBe(2);
  });

  it("attempts every hostile observer/listener release and succeeds on retry", async () => {
    const { element, controls } = createElement(false);
    connect(element);
    controls.throwMutationDisconnect = true;
    controls.throwDocumentRemove = true;
    let failure: unknown = null;
    try {
      await element.dispose();
    } catch (error) {
      failure = error;
    }
    const removalAttemptsBeforeRetry = controls.documentRemoveAttempts.length;

    controls.throwMutationDisconnect = false;
    controls.throwDocumentRemove = false;
    await element.dispose();

    expect.soft(failure).toMatchObject({ name: "OperationError" });
    expect.soft(removalAttemptsBeforeRetry).toBeGreaterThan(0);
    expect.soft(element.getDiagnostics().terminalCleanup).toMatchObject({
      completed: true
    });
  });
});

interface Controls {
  throwMutationObserve: boolean;
  throwMutationDisconnect: boolean;
  throwAfterDocumentAdd: string | null;
  throwDocumentRemove: boolean;
  throwCanvasWidthReset: boolean;
  mutationObserves: number;
  mutationDisconnects: number;
  documentRemoveAttempts: string[];
  canvasWidthResetAttempts: number;
}

let currentDocument: FakeDocument;
let currentControls: Controls;

function createElement(withSource: boolean): Readonly<{
  element: AvalElement & {
    controls: Controls;
    isConnected: boolean;
    connectedCallback(): void;
  };
  controls: Controls;
}> {
  const controls: Controls = {
    throwMutationObserve: false,
    throwMutationDisconnect: false,
    throwAfterDocumentAdd: null,
    throwDocumentRemove: false,
    throwCanvasWidthReset: false,
    mutationObserves: 0,
    mutationDisconnects: 0,
    documentRemoveAttempts: [],
    canvasWidthResetAttempts: 0
  };
  currentControls = controls;
  const view = new FakeWindow();
  currentDocument = new FakeDocument(view, controls);
  view.document = currentDocument;
  const Constructor = createAvalElementClass(
    FakeHTMLElement as unknown as typeof HTMLElement
  );
  const element = new Constructor() as AvalElement & FakeHTMLElement & {
    controls: Controls;
    connectedCallback(): void;
  };
  Object.defineProperty(element, "controls", { value: controls });
  element.setAttribute("bindings", "none");
  if (withSource) {
    const source = new FakeElement("source", currentDocument, controls);
    source.parentElement = element;
    source.setAttribute("src", "/motion.avl");
    source.setAttribute("type", 'application/vnd.aval; codecs="avc1.64001E"');
    element.childElements.push(source);
  }
  elements.push(element);
  return { element, controls };
}

function connect(element: AvalElement & {
  isConnected: boolean;
  connectedCallback(): void;
}): void {
  element.isConnected = true;
  element.connectedCallback();
}

class FakeHTMLElement extends EventTarget {
  public readonly ownerDocument = currentDocument;
  public readonly childElements: FakeElement[] = [];
  public readonly attributes = new Map<string, string>();
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
  public getBoundingClientRect(): DOMRect { return { width: 16, height: 16 } as DOMRect; }
  public getRootNode(): Document { return this.ownerDocument as unknown as Document; }
  public matches(): boolean { return false; }
  public contains(value: Node | null): boolean {
    return value === (this as unknown as Node);
  }
}

class FakeElement extends EventTarget {
  public readonly nodeType = 1;
  public readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  public readonly dataset: Record<string, string> = {};
  public parentElement: FakeHTMLElement | null = null;
  public hidden = false;
  public name = "";
  public tabIndex = 0;
  readonly #attributes = new Map<string, string>();
  #width = 16;
  #height = 16;

  public constructor(
    public readonly localName: string,
    public readonly ownerDocument: FakeDocument,
    readonly controls: Controls
  ) { super(); }
  public getAttribute(name: string): string | null { return this.#attributes.get(name) ?? null; }
  public setAttribute(name: string, value: string): void { this.#attributes.set(name, value); }
  public matches(): boolean { return false; }
  public contains(): boolean { return false; }
  public get width(): number { return this.#width; }
  public set width(value: number) {
    if (this.localName === "canvas" && value === 0) {
      this.controls.canvasWidthResetAttempts += 1;
      if (this.controls.throwCanvasWidthReset) {
        throw new Error("synthetic canvas reset failure");
      }
    }
    this.#width = value;
  }
  public get height(): number { return this.#height; }
  public set height(value: number) { this.#height = value; }
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
  readonly #rule = new FakeCSSStyleRule();
  public readonly cssRules = { item: () => this.#rule };
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
  readonly #controls = currentControls;
  readonly #records: MutationRecord[] = [];
  public constructor(_callback: MutationCallback) {
    FakeMutationObserver.instances.push(this);
  }
  public enqueue(record: MutationRecord): void { this.#records.push(record); }
  public observe(): void {
    this.#controls.mutationObserves += 1;
    if (this.#controls.throwMutationObserve) {
      throw new Error("synthetic observe failure");
    }
  }
  public disconnect(): void {
    this.#controls.mutationDisconnects += 1;
    if (this.#controls.throwMutationDisconnect) {
      throw new Error("synthetic disconnect failure");
    }
  }
  public takeRecords(): MutationRecord[] { return this.#records.splice(0); }
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

class FakeIntersectionObserver {
  readonly #callback: IntersectionObserverCallback;
  public constructor(callback: IntersectionObserverCallback) {
    this.#callback = callback;
  }
  public observe(target: Element): void {
    this.#callback([{
      target,
      isIntersecting: true,
      intersectionRatio: 1
    } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  public disconnect(): void {}
  public takeRecords(): IntersectionObserverEntry[] { return []; }
  public unobserve(_target: Element): void {}
  public readonly root = null;
  public readonly rootMargin = "0px";
  public readonly thresholds = Object.freeze([0]);
}

class FakeDocument extends EventTarget {
  public visibilityState: DocumentVisibilityState = "visible";
  public readonly baseURI = "https://example.test/";
  public readonly activeElement: Element | null = null;
  public constructor(
    public readonly defaultView: FakeWindow,
    readonly controls: Controls
  ) { super(); }
  public createElement(localName: string): FakeElement {
    return new FakeElement(localName, this, this.controls);
  }
  public getElementById(): Element | null { return null; }
  public override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ): void {
    super.addEventListener(type, callback, options);
    if (this.controls.throwAfterDocumentAdd === type) {
      throw new Error("synthetic add failure");
    }
  }
  public override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions
  ): void {
    this.controls.documentRemoveAttempts.push(type);
    if (this.controls.throwDocumentRemove) {
      throw new Error("synthetic remove failure");
    }
    super.removeEventListener(type, callback, options);
  }
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

function playerSnapshot(live: boolean): Readonly<PlayerSnapshot> {
  return Object.freeze({
    requestedState: "idle",
    visualState: "idle",
    transitioning: false,
    selectedRendition: live ? "main" : null,
    selectedCodec: live ? "avc1.64001E" : null,
    selectedBitDepth: live ? 8 : null,
    transportMode: live ? "full" : null,
    declaredFileBytes: live ? 1_024 : 0,
    metadataBytes: live ? 128 : 0,
    verifiedBytes: live ? 1_024 : 0,
    residentBlobBytes: live ? 1_024 : 0,
    activeTransportBodies: 0,
    pendingLoads: 0,
    interestedWaiters: 0,
    workerCount: live ? 2 : 0,
    openFrames: live ? 2 : 0,
    contextLossCount: 0,
    contextRecoveryCount: 0,
    presentation: Object.freeze({
      cssWidth: 16,
      cssHeight: 16,
      backingWidth: live ? 16 : 0,
      backingHeight: live ? 16 : 0,
      effectiveDprX: live ? 1 : 0,
      effectiveDprY: live ? 1 : 0,
      stagingBytes: 0,
      residentBytes: 0,
      textureBytes: live ? 1_024 : 0,
      runtimeBytes: live ? 1_024 : 0,
      pendingOperations: 0,
      sourceCopiesInFlight: 0,
      resourceCount: live ? 1 : 0,
      contextListenerCount: live ? 1 : 0
    }),
    trace: Object.freeze([])
  });
}

async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}
