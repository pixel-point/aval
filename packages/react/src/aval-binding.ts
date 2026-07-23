import {
  AvalNotReadyError,
  defineAvalElement,
  type AvalDiagnostics,
  type AvalElement,
  type AvalErrorDetail,
  type AvalPrepareOptions,
  type AvalRequestedStateChangeDetail,
  type AvalSnapshot,
  type AvalTransitionDetail,
  type AvalVisualStateChangeDetail,
  type RuntimeReadiness,
  type RuntimeReadinessResult
} from "@pixel-point/aval-element";

import {
  sameRenderOptions,
  type AvalCallbacks,
  type NormalizedAvalRenderOptions,
  type NormalizedUseAvalOptions
} from "./sources.js";
import type { AvalBindingTarget } from "./types.js";

export interface AvalReactStatus {
  readonly mounted: boolean;
  readonly readiness: RuntimeReadiness;
  readonly requestedState: string | null;
  readonly visualState: string | null;
  readonly isTransitioning: boolean;
  readonly paused: boolean;
  readonly effectivelyVisible: boolean;
  readonly stateNames: readonly string[];
  readonly eventNames: readonly string[];
  readonly lastError: Readonly<AvalErrorDetail> | null;
}

type StoreListener = () => void;

export interface AvalBindingNode {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export type AvalBindingElementPort = Pick<
  AvalElement,
  | "interactionTarget"
  | "prepare"
  | "setState"
  | "send"
  | "readyFor"
  | "pause"
  | "resume"
  | "getSnapshot"
  | "subscribe"
  | "getDiagnostics"
>;

export interface AvalBindingEnvironment {
  upgrade(node: AvalBindingNode): AvalBindingElementPort;
}

interface Attachment {
  readonly node: AvalBindingNode;
  readonly element: AvalBindingElementPort;
  readonly unsubscribe: () => void;
  phase: AttachmentPhase;
}

type AttachmentPhase =
  | Readonly<{ readonly kind: "pending" }>
  | Readonly<{
    readonly kind: "mounted";
    readonly target: Element | null;
    readonly snapshot: Readonly<AvalSnapshot>;
  }>;

interface Preparation {
  readonly attachment: Attachment;
  readonly sourceKey: string;
  readonly controller: AbortController;
}

const EMPTY_STRINGS: readonly string[] = Object.freeze([]);
const NOOP = (): void => undefined;

const BROWSER_ENVIRONMENT: AvalBindingEnvironment = Object.freeze({
  upgrade(node: AvalBindingNode): AvalBindingElementPort {
    defineAvalElement();
    const element = node as unknown as AvalBindingElementPort;
    if (
      typeof element.getSnapshot !== "function" ||
      typeof element.subscribe !== "function"
    ) {
      throw new TypeError(
        "Registered aval-player does not implement the required snapshot API"
      );
    }
    return element;
  }
});

function unmountedStatus(): Readonly<AvalReactStatus> {
  return Object.freeze({
    mounted: false,
    readiness: "unready",
    requestedState: null,
    visualState: null,
    isTransitioning: false,
    paused: true,
    effectivelyVisible: false,
    stateNames: EMPTY_STRINGS,
    eventNames: EMPTY_STRINGS,
    lastError: null
  });
}

export class AvalBinding {
  readonly #statusListeners = new Set<StoreListener>();
  readonly #optionsListeners = new Set<StoreListener>();
  readonly #serverStatus = unmountedStatus();
  readonly #nativeListeners: readonly (readonly [string, EventListener])[];
  readonly #environment: AvalBindingEnvironment;
  #status: Readonly<AvalReactStatus>;
  #renderOptions: Readonly<NormalizedAvalRenderOptions>;
  #callbacks: Readonly<AvalCallbacks>;
  #attachment: Attachment | null = null;
  #preparation: Preparation | null = null;

  public constructor(
    options: Readonly<NormalizedUseAvalOptions>,
    environment: AvalBindingEnvironment = BROWSER_ENVIRONMENT
  ) {
    this.#renderOptions = options.render;
    this.#callbacks = options.callbacks;
    this.#status = this.#serverStatus;
    this.#environment = environment;
    this.#nativeListeners = Object.freeze([
      Object.freeze([
        "requestedstatechange",
        this.#handleRequestedStateChange as EventListener
      ] as const),
      Object.freeze([
        "visualstatechange",
        this.#handleVisualStateChange as EventListener
      ] as const),
      Object.freeze([
        "transitionstart",
        this.#handleTransitionStart as EventListener
      ] as const),
      Object.freeze([
        "transitionend",
        this.#handleTransitionEnd as EventListener
      ] as const),
      Object.freeze(["error", this.#handleError as EventListener] as const)
    ]);
  }

  public readonly getStatus = (): Readonly<AvalReactStatus> => this.#status;
  public readonly getServerStatus = (): Readonly<AvalReactStatus> =>
    this.#serverStatus;
  public readonly getRenderOptions = ():
  Readonly<NormalizedAvalRenderOptions> => this.#renderOptions;

  public readonly subscribeStatus = (listener: StoreListener): (() => void) =>
    this.#subscribe(this.#statusListeners, listener);

  public readonly subscribeOptions = (listener: StoreListener): (() => void) =>
    this.#subscribe(this.#optionsListeners, listener);

  public commitOptions(options: Readonly<NormalizedUseAvalOptions>): void {
    this.#callbacks = options.callbacks;
    if (sameRenderOptions(this.#renderOptions, options.render)) return;
    if (this.#renderOptions.sourceKey !== options.render.sourceKey) {
      this.#cancelPreparation(this.#preparation);
    }
    this.#renderOptions = options.render;
    this.#notify(this.#optionsListeners);
  }

  public readonly attach = (node: AvalBindingNode | null): void => {
    const current = this.#attachment;
    if (node === current?.node) return;
    if (node === null) {
      if (current !== null) this.#closeAttachment(current);
      return;
    }
    if (current !== null) {
      throw new Error(
        "One AvalComponent returned by useAval cannot be mounted more than once"
      );
    }

    for (const [type, listener] of this.#nativeListeners) {
      node.addEventListener(type, listener);
    }
    let unsubscribe = NOOP;
    try {
      const element = this.#environment.upgrade(node);
      unsubscribe = element.subscribe(this.#syncElementSnapshot);
      this.#attachment = {
        node,
        element,
        unsubscribe,
        phase: Object.freeze({ kind: "pending" })
      };
    } catch (error) {
      unsubscribe();
      this.#removeNativeListeners(node);
      throw error;
    }
  };

  public beginReadyPreparation(): () => void {
    const attachment = this.#attachment;
    if (attachment === null) return NOOP;
    this.#cancelPreparation(this.#preparation);

    const operation: Preparation = {
      attachment,
      sourceKey: this.#renderOptions.sourceKey,
      controller: new AbortController()
    };
    this.#preparation = operation;
    void attachment.element.prepare({
      signal: operation.controller.signal
    }).then((result) => {
      if (
        this.#preparation !== operation ||
        this.#attachment !== operation.attachment ||
        this.#renderOptions.sourceKey !== operation.sourceKey ||
        operation.controller.signal.aborted
      ) return;
      this.#preparation = null;
      try { this.#callbacks.onReady?.(result); }
      catch (error) {
        queueMicrotask(() => { throw error; });
      }
    }, () => {
      if (this.#preparation === operation) this.#preparation = null;
    });

    return () => this.#cancelPreparation(operation);
  }

  public finalizeBindingTarget(target: AvalBindingTarget | undefined): void {
    const attachment = this.#attachment;
    if (attachment === null) return;
    const resolved = resolveBindingTarget(target);
    const phase = attachment.phase;
    if (phase.kind === "mounted" && phase.target === resolved) return;
    attachment.element.interactionTarget = resolved;
    if (phase.kind === "mounted") {
      attachment.phase = Object.freeze({ ...phase, target: resolved });
      return;
    }
    const snapshot = attachment.element.getSnapshot();
    attachment.phase = Object.freeze({
      kind: "mounted",
      target: resolved,
      snapshot
    });
    this.#publishStatus(statusFromElement(snapshot));
  }

  public clearBindingTarget(): void {
    const attachment = this.#attachment;
    if (
      attachment === null || attachment.phase.kind !== "mounted" ||
      attachment.phase.target === null
    ) return;
    attachment.element.interactionTarget = null;
    attachment.phase = Object.freeze({ ...attachment.phase, target: null });
  }

  public readonly prepare = (
    options?: Readonly<AvalPrepareOptions>
  ): Promise<RuntimeReadinessResult> => {
    const element = this.#attachment?.element;
    if (element === undefined) return Promise.reject(notMountedError());
    return options === undefined ? element.prepare() : element.prepare(options);
  };

  public readonly setState = (name: string): Promise<void> => {
    const element = this.#attachment?.element;
    return element === undefined
      ? Promise.reject(notMountedError())
      : element.setState(name);
  };

  public readonly send = (event: string): boolean =>
    this.#attachment?.element.send(event) ?? false;

  public readonly readyFor = (state: string): boolean =>
    this.#attachment?.element.readyFor(state) ?? false;

  public readonly play = (): Promise<void> => {
    const element = this.#attachment?.element;
    return element === undefined
      ? Promise.reject(notMountedError())
      : element.resume();
  };

  public readonly pause = (): void => {
    this.#attachment?.element.pause();
  };

  public readonly getDiagnostics = (
    options?: Readonly<{ readonly trace?: boolean }>
  ): Readonly<AvalDiagnostics> | null => {
    const element = this.#attachment?.element;
    if (element === undefined) return null;
    return options === undefined
      ? element.getDiagnostics()
      : element.getDiagnostics(options);
  };

  #subscribe(
    listeners: Set<StoreListener>,
    listener: StoreListener
  ): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("AVAL React store subscriber must be a function");
    }
    listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
    };
  }

  #notify(listeners: ReadonlySet<StoreListener>): void {
    for (const listener of [...listeners]) {
      try { listener(); }
      catch { /* observers cannot interrupt element or React ownership */ }
    }
  }

  readonly #syncElementSnapshot = (): void => {
    const attachment = this.#attachment;
    if (attachment === null || attachment.phase.kind !== "mounted") return;
    const snapshot = attachment.element.getSnapshot();
    if (snapshot === attachment.phase.snapshot) return;
    attachment.phase = Object.freeze({ ...attachment.phase, snapshot });
    this.#publishStatus(statusFromElement(snapshot));
  };

  #publishStatus(status: Readonly<AvalReactStatus>): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#notify(this.#statusListeners);
  }

  #closeAttachment(attachment: Attachment): void {
    if (this.#attachment !== attachment) return;
    this.#attachment = null;
    if (this.#preparation?.attachment === attachment) {
      this.#cancelPreparation(this.#preparation);
    }
    attachment.unsubscribe();
    if (
      attachment.phase.kind === "mounted" &&
      attachment.phase.target !== null
    ) {
      attachment.element.interactionTarget = null;
    }
    this.#removeNativeListeners(attachment.node);
    this.#publishStatus(this.#serverStatus);
  }

  #cancelPreparation(operation: Preparation | null): void {
    if (operation === null) return;
    operation.controller.abort();
    if (this.#preparation === operation) this.#preparation = null;
  }

  #removeNativeListeners(node: AvalBindingNode): void {
    for (const [type, listener] of this.#nativeListeners) {
      node.removeEventListener(type, listener);
    }
  }

  readonly #handleRequestedStateChange = (
    event: CustomEvent<Readonly<AvalRequestedStateChangeDetail>>
  ): void => {
    this.#callbacks.onRequestedStateChange?.(event.detail);
  };

  readonly #handleVisualStateChange = (
    event: CustomEvent<Readonly<AvalVisualStateChangeDetail>>
  ): void => {
    this.#callbacks.onVisualStateChange?.(event.detail);
  };

  readonly #handleTransitionStart = (
    event: CustomEvent<Readonly<AvalTransitionDetail>>
  ): void => {
    this.#callbacks.onTransitionStart?.(event.detail);
  };

  readonly #handleTransitionEnd = (
    event: CustomEvent<Readonly<AvalTransitionDetail>>
  ): void => {
    this.#callbacks.onTransitionEnd?.(event.detail);
  };

  readonly #handleError = (
    event: CustomEvent<Readonly<AvalErrorDetail>>
  ): void => {
    this.#callbacks.onError?.(event.detail);
  };
}

function statusFromElement(
  snapshot: Readonly<AvalSnapshot>
): Readonly<AvalReactStatus> {
  return Object.freeze({
    mounted: true,
    readiness: snapshot.readiness,
    requestedState: snapshot.requestedState,
    visualState: snapshot.visualState,
    isTransitioning: snapshot.isTransitioning,
    paused: snapshot.paused,
    effectivelyVisible: snapshot.effectivelyVisible,
    stateNames: snapshot.stateNames,
    eventNames: snapshot.eventNames,
    lastError: snapshot.lastError
  });
}

function resolveBindingTarget(
  input: AvalBindingTarget | undefined
): Element | null {
  if (input === undefined || input === null) return null;
  if ("current" in input) return input.current;
  return input;
}

function notMountedError(): AvalNotReadyError {
  return new AvalNotReadyError("AvalComponent is not mounted");
}
