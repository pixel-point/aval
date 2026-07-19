import { ElementAttributeReflection } from "./element-attribute-reflection.js";
import { AVAL_ATTRIBUTES, AVAL_UPGRADE_PROPERTIES } from "./element-attributes.js";
import { normalizeIntegrity, normalizeSource } from "./element-configuration.js";
import { ElementEventMutationGate } from "./element-event-mutation-gate.js";
import { ElementEngagementBinding } from "./element-engagement-binding.js";
import { ElementPublicEvents } from "./element-public-events.js";
import { ElementTrace } from "./element-trace.js";
import { ELEMENT_DECODER_CAPACITY } from "./decoder-capacity.js";
import type {
  Metadata,
  Player,
  PlayerDecoderDiagnostic,
  PlayerInput,
  PlayerSnapshot,
  Source
} from "./player-contract.js";
import {
  pageResourcesSnapshot,
  createPageDecoderParticipant,
  type PageDecoderLease,
  type PageDecoderParticipant,
  type PageDecoderTicket,
  type PageResourcesSnapshot
} from "./page-resources.js";
import { LifecycleLane } from "./lifecycle-lane.js";
import {
  AvalNotReadyError,
  AvalPlaybackError,
  ElementCleanupIncompleteError
} from "./errors.js";
import { ShadowLayerOwner } from "./shadow-layers.js";
import type {
  AvalAutoplay,
  AvalBindings,
  AvalCrossOrigin,
  AvalDecoderDiagnostic,
  AvalDiagnostics,
  AvalElement,
  AvalElementConstructor,
  AvalFit,
  AvalMode,
  AvalMotion,
  AvalPublicFailure,
  AvalReadinessChangeDetail,
  Binding,
  RuntimeReadiness,
  RuntimeReadinessResult,
  StaticReason
} from "./public-types.js";

let runtimeModule: Promise<typeof import("./player.js")> | null = null;
const PREPARATION_MS = 5_000;
type IntersectionGate = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
};
type FailureInput = AvalPublicFailure["code"];
type ElementTiming = Readonly<{
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (handle: number) => void;
  timeoutError: () => DOMException;
  abortError: () => DOMException;
}>;
type OwnedRelease = Readonly<{
  kind: "listener" | "observer";
  release: () => void;
}>;

export function createAvalElementClass(
  Base: typeof HTMLElement
): AvalElementConstructor {
  class AvalElementImpl extends Base implements AvalElement {
    public static get observedAttributes(): readonly string[] {
      return AVAL_ATTRIBUTES;
    }

    readonly #attributes: ElementAttributeReflection;
    readonly #layers: ShadowLayerOwner;
    readonly #lifecycle = new LifecycleLane();
    readonly #events: ElementPublicEvents;
    readonly #eventMutations: ElementEventMutationGate;
    readonly #engagementBinding: ElementEngagementBinding;
    readonly #trace = new ElementTrace();
    readonly #counters = {
      prepare: 0,
      sourceReplacement: 0,
      pause: 0,
      resume: 0,
      underflow: 0,
      contextRecovery: 0,
      cleanup: 0
    };
    #sourceObserver: MutationObserver;
    #sourceObserving = false;
    #observersInstalled = false;
    #resizeObserver: ResizeObserver | null = null;
    #intersectionObserver: IntersectionObserver | null = null;
    #intersectionKnown = false;
    #intersectionGate: IntersectionGate | null = null;
    #media: MediaQueryList | null = null;
    #installedRoot: Node | null = null;
    #installedDocument: Document | null = null;
    #installedView: Window | null = null;
    #mediaListener: ((event: MediaQueryListEvent) => void) | null = null;
    #documentListener: (() => void) | null = null;
    #windowListener: (() => void) | null = null;
    #pageHideListener: EventListener | null = null;
    #pageShowListener: EventListener | null = null;
    #pageHidden = false;
    #observerEpoch = 0;
    #adoptionEpoch = 0;
    #sourceRequestEpoch = 0;
    #failedReleases: OwnedRelease[] = [];
    readonly #deferredAttributes = new Set<string>();
    #deferredCommandCount = 0;
    #inputListeners: Array<{
      target: EventTarget;
      type: string;
      listener: EventListener;
    }> = [];
    #boundInputTarget: Element | null = null;
    #bindingEpoch = 0;
    #player: Player | null = null;
    #retiringPlayer: Player | null = null;
    #retiringDeclaredFileBytes = 0;
    #visibilityPlayer: Player | null = null;
    #pageParticipant: PageDecoderParticipant | null = null;
    #pageRealm: object | null = null;
    #decoderTicket: PageDecoderTicket | null = null;
    #decoderLease: PageDecoderLease | null = null;
    #resourceBytes = 0;
    #preparingPlayer: Player | null = null;
    #suspendingPlayer: Player | null = null;
    #suspension: Promise<RuntimeReadinessResult> | null = null;
    #suspendedPlayer: Player | null = null;
    #restartPlayer: Player | null = null;
    #restartState: string | null = null;
    #restartInitialBody = false;
    #restartVisibleOnly = false;
    #load: Promise<RuntimeReadinessResult> | null = null;
    #controller: AbortController | null = null;
    #metadata: Readonly<Metadata> | null = null;
    #explicitTarget: Element | null = null;
    #connected = false;
    #finalDisposed = false;
    #disposePromise: Promise<void> | null = null;
    #reloadQueued = false;
    #reloadReplace = false;
    #timerCount = 0;
    #stalePublicationCount = 0;
    #elementGeneration = 1;
    #sourceGeneration = 0;
    #inputGeneration = 0;
    #motionGeneration = 0;
    #visibilityGeneration = 0;
    #resizeGeneration = 0;
    #readiness: RuntimeReadiness = "unready";
    #mode: AvalMode = null;
    #staticReason: StaticReason | null = null;
    #requestedState: string | null = null;
    #visualState: string | null = null;
    #transitioning = false;
    #lastFailure: Readonly<AvalPublicFailure> | null = null;
    #terminalError: AvalPlaybackError | null = null;
    #cleanupFailureCount = 0;
    #decoderDiagnostics: readonly Readonly<AvalDecoderDiagnostic>[] =
      Object.freeze([]);
    #cleanup: Readonly<Record<string, unknown>> | null = null;
    #terminalCleanup: Readonly<Record<string, unknown>> | null = null;
    #intersecting = false;
    #lastVisibility: boolean | null = null;
    #positiveBox = false;
    #manualPlaying = false;
    #playSequence = 0;
    #hovered = false;
    #focused = false;

    public constructor() {
      super();
      this.#attributes = new ElementAttributeReflection(this);
      this.#layers = new ShadowLayerOwner(this);
      this.#events = new ElementPublicEvents(this);
      this.#eventMutations = new ElementEventMutationGate(this.#events);
      this.#engagementBinding = new ElementEngagementBinding(
        (source) => this.#sendBinding(source),
        () => this.#transitioning
      );
      this.#sourceObserver = this.#createSourceObserver();
      this.#attributes.upgrade(AVAL_UPGRADE_PROPERTIES);
      this.#manualPlaying = this.autoplay === "visible";
      this.#applyIntrinsic();
    }

    public connectedCallback(): void {
      if (this.#finalDisposed) return;
      const wasConnected = this.#connected;
      const rootChanged = this.#installedRoot !== null &&
        this.#installedRoot !== this.getRootNode();
      if (rootChanged) {
        if (this.#explicitTarget !== null) {
          try { interactionTarget(this, this.#explicitTarget); }
          catch { this.#explicitTarget = null; }
        }
        this.#removeObservers();
      }
      this.#connected = true;
      if (!wasConnected) {
        this.#trace.record("connect", Math.max(1, this.#sourceGeneration));
      }
      if (!this.#installObservers()) return;
      if (rootChanged) this.#bindInputs();
      if (!wasConnected || this.#load === null && this.#player === null &&
        this.#retiringPlayer === null) this.#scheduleReload(false);
    }

    public disconnectedCallback(): void {
      queueMicrotask(() => {
        if (this.isConnected || this.#finalDisposed) return;
        this.#connected = false;
        this.#trace.record("disconnect", Math.max(1, this.#sourceGeneration));
        this.#load = null;
        this.#removeObservers();
        const retirement = this.#queueRetirement(false);
        const finish = (): void => {
          if (!this.#connected && !this.#finalDisposed) {
            this.#mode = null;
            this.#staticReason = null;
            this.#setReadiness("unready");
          }
        };
        void retirement.then(finish, finish);
      });
    }

    public adoptedCallback(): void {
      if (this.#finalDisposed) return;
      const epoch = ++this.#adoptionEpoch;
      this.#connected = this.isConnected;
      this.#trace.record("adopt", Math.max(1, this.#sourceGeneration));
      this.#load = null;
      if (this.#explicitTarget !== null) {
        try { interactionTarget(this, this.#explicitTarget); }
        catch { this.#explicitTarget = null; }
      }
      this.#removeObservers();
      this.#sourceObserver = this.#createSourceObserver();
      rebindAdoptedStyles(this.#layers, this.ownerDocument);
      const retirement = this.#queueRetirement(false);
      const finish = (): void => {
        if (
          epoch === this.#adoptionEpoch && this.#connected &&
          this.isConnected && !this.#finalDisposed && this.#installObservers()
        ) {
          this.#scheduleReload(false);
        }
      };
      void retirement.then(finish, finish);
    }

    public attributeChangedCallback(
      name: string,
      previous: string | null,
      next: string | null
    ): void {
      if (previous === next || this.#finalDisposed) return;
      if (this.#events.active) {
        deferAttributeEffect(
          this.#deferredAttributes,
          name,
          (operation) => this.#deferPublicMutation(operation),
          () => this.getAttribute(name),
          (current) => {
            if (!this.#finalDisposed) this.#applyAttributeChange(name, current);
          }
        );
        return;
      }
      this.#applyAttributeChange(name, next);
    }

    #applyAttributeChange(name: string, next: string | null): void {
      if (name === "crossorigin") {
        this.#scheduleReload();
      } else if (name === "motion") {
        this.#motionGeneration += 1;
        this.#applyMotion();
      } else if (name === "state") {
        if (next !== null && !/^[a-z][a-z0-9._-]{0,63}$/u.test(next)) {
          this.#publishFailure(
            "invalid-configuration",
            "state",
            false,
            Math.max(1, this.#sourceGeneration)
          );
        } else if (next !== null && this.#connected) {
          this.#applyDeclarativeState(next);
        }
      } else if (name === "fit" || name === "width" || name === "height") {
        this.#applyIntrinsic();
        this.#resize();
      } else if (name === "bindings" || name === "interaction-for") {
        this.#bindInputs();
      } else if (name === "autoplay") {
        this.#manualPlaying = this.autoplay === "visible";
        this.#playSequence += 1;
        this.#updatePlayback();
      }
    }

    #deferPublicMutation(operation: () => void): boolean {
      if (!this.#events.active) return false;
      this.#deferredCommandCount += 1;
      const deferred = this.#eventMutations.defer(() => {
        this.#deferredCommandCount -= 1;
        operation();
      });
      if (!deferred) this.#deferredCommandCount -= 1;
      return deferred;
    }

    #deferPublicMutationPromise<T>(
      operation: () => Promise<T>
    ): Promise<T> | null {
      if (!this.#events.active) return null;
      this.#deferredCommandCount += 1;
      const deferred = this.#eventMutations.deferPromise(() => {
        this.#deferredCommandCount -= 1;
        return operation();
      });
      if (deferred === null) this.#deferredCommandCount -= 1;
      return deferred;
    }

    #queueOwnedMicrotask(operation: () => void): void {
      queueOwnedMicrotask(
        (delta) => { this.#deferredCommandCount += delta; },
        operation
      );
    }

    public get crossOrigin(): AvalCrossOrigin { return this.#attributes.crossOrigin; }
    public set crossOrigin(value: AvalCrossOrigin) { this.#attributes.crossOrigin = value; }
    public get motion(): AvalMotion { return this.#attributes.motion; }
    public set motion(value: AvalMotion) { this.#attributes.motion = value; }
    public get autoplay(): AvalAutoplay { return this.#attributes.autoplay; }
    public set autoplay(value: AvalAutoplay) { this.#attributes.autoplay = value; }
    public get fit(): AvalFit | null { return this.#attributes.fit; }
    public set fit(value: AvalFit | null) { this.#attributes.fit = value; }
    public get bindings(): AvalBindings { return this.#attributes.bindings; }
    public set bindings(value: AvalBindings) { this.#attributes.bindings = value; }
    public get state(): string | null { return this.#attributes.state; }
    public set state(value: string | null) { this.#attributes.state = value; }
    public get interactionFor(): string { return this.#attributes.interactionFor; }
    public set interactionFor(value: string) { this.#attributes.interactionFor = value; }
    public get interactionTarget(): Element | null {
      return this.#explicitTarget ?? this.#resolveInteractionTarget();
    }
    public set interactionTarget(value: Element | null) {
      if (this.#finalDisposed) return;
      const target = interactionTarget(this, value);
      if (this.#deferPublicMutation(() => { this.interactionTarget = target; })) return;
      this.#explicitTarget = target;
      this.#bindInputs();
    }
    public get width(): number | null { return this.#attributes.width; }
    public set width(value: number | null) { this.#attributes.width = value; }
    public get height(): number | null { return this.#attributes.height; }
    public set height(value: number | null) { this.#attributes.height = value; }

    public get readiness(): RuntimeReadiness { return this.#readiness; }
    public get mode(): AvalMode { return this.#mode; }
    public get assurance(): "best-effort" | null {
      return this.#mode === "animated" ? "best-effort" : null;
    }
    public get staticReason(): StaticReason | null { return this.#staticReason; }
    public get requestedState(): string | null { return this.#requestedState; }
    public get visualState(): string | null { return this.#visualState; }
    public get isTransitioning(): boolean { return this.#transitioning; }
    public get paused(): boolean { return !this.#manualPlaying; }
    public get effectivelyVisible(): boolean {
      return this.#documentVisible() && this.#intersecting && this.#positiveBox;
    }
    public get stateNames(): readonly string[] {
      return this.#metadata?.stateNames ?? Object.freeze([]);
    }
    public get eventNames(): readonly string[] {
      return this.#metadata?.eventNames ?? Object.freeze([]);
    }
    public get inputBindings(): readonly Readonly<Binding>[] {
      return this.#metadata?.bindings ?? Object.freeze([]);
    }

    public prepare(
      options: Readonly<{ signal?: AbortSignal; timeoutMs?: number }> = {}
    ): Promise<RuntimeReadinessResult> {
      if (
        options.timeoutMs !== undefined &&
        (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
      ) return Promise.reject(new RangeError("timeoutMs must be a positive integer"));
      if (options.signal?.aborted) return Promise.reject(options.signal.reason);
      if (this.#finalDisposed) return Promise.reject(abortError());
      const deferred = this.#deferPublicMutationPromise(() => this.prepare(options));
      if (deferred !== null) return deferred;
      const view = this.ownerDocument.defaultView;
      if (view === null) {
        return Promise.reject(new AvalNotReadyError("AVAL owner window is unavailable"));
      }
      this.#flushSourceMutations();
      this.#counters.prepare += 1;
      const operation = this.#ensure();
      return withLimits(
        operation,
        options.signal,
        options.timeoutMs,
        (delta) => { this.#timerCount += delta; },
        createElementTiming(view)
      );
    }

    public async setState(name: string): Promise<void> {
      if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(name)) {
        throw new TypeError("state must be an authored identifier");
      }
      if (this.#finalDisposed) throw abortError();
      const deferred = this.#deferPublicMutationPromise(() => this.setState(name));
      if (deferred !== null) return deferred;
      this.#flushSourceMutations();
      await this.#ensure();
      const preparedTerminal = this.#retainedTerminalError();
      if (preparedTerminal !== null) throw preparedTerminal;
      const player = this.#player;
      if (player === null) throw new AvalNotReadyError();
      try {
        await player.setState(name);
      } catch (error) {
        throw this.#retainedTerminalError() ?? error;
      }
      const settledTerminal = this.#retainedTerminalError();
      if (settledTerminal !== null) throw settledTerminal;
    }

    #applyDeclarativeState(name: string): void {
      void this.setState(name).catch((error) => {
        if (isAbort(error) || this.#finalDisposed || !this.#connected) return;
        this.#publishFailure(
          "invalid-configuration",
          "state",
          false,
          Math.max(1, this.#sourceGeneration)
        );
      });
    }

    #applyDeclarativeStateToPlayer(
      player: Player,
      name: string,
      generation: number,
      token: number
    ): void {
      void player.setState(name).catch((error) => {
        if (
          isAbort(error) || player !== this.#player ||
          !this.#current(generation, token)
        ) return;
        this.#publishFailure(
          "invalid-configuration",
          "state",
          false,
          generation
        );
      });
    }

    public send(event: string): boolean {
      if (this.#finalDisposed) return false;
      try {
        const player = this.#player;
        if (this.#events.active) {
          return player !== null && deferAcceptedSend(
            () => player.canSend(event),
            (operation) => this.#deferPublicMutation(operation),
            () => {
              if (
                this.#player === player && !this.#finalDisposed &&
                !this.#flushSourceMutations()
              ) player.send(event);
            }
          );
        }
        if (this.#flushSourceMutations()) return false;
        return player?.send(event) ?? false;
      } catch { return false; }
    }

    public readyFor(state: string): boolean {
      if (this.#finalDisposed) return false;
      if (this.#events.active) return this.#player?.readyFor(state) ?? false;
      if (this.#flushSourceMutations()) return false;
      return this.#player?.readyFor(state) ?? false;
    }

    public pause(): void {
      if (this.#finalDisposed) return;
      if (this.#deferPublicMutation(() => this.pause())) return;
      this.#flushSourceMutations();
      this.#manualPlaying = false;
      this.#playSequence += 1;
      this.#counters.pause += 1;
      this.#player?.pause();
    }

    public async resume(): Promise<void> {
      if (this.#finalDisposed) throw abortError();
      const deferred = this.#deferPublicMutationPromise(() => this.resume());
      if (deferred !== null) return deferred;
      this.#flushSourceMutations();
      const previous = this.#manualPlaying;
      this.#manualPlaying = true;
      const sequence = ++this.#playSequence;
      let attempted: Player | null = null;
      this.#counters.resume += 1;
      try {
        await this.#ensure();
        const preparedTerminal = this.#retainedTerminalError();
        if (preparedTerminal !== null) throw preparedTerminal;
        if (sequence !== this.#playSequence || !this.#manualPlaying) {
          throw abortError();
        }
        const player = this.#player;
        if (player === null) throw new AvalNotReadyError();
        if (
          this.effectivelyVisible &&
          player !== this.#suspendedPlayer && player !== this.#suspendingPlayer
        ) {
          attempted = player;
          await player.resume();
          const resumedTerminal = this.#retainedTerminalError();
          if (resumedTerminal !== null) throw resumedTerminal;
          if (!resumeCurrent(
            sequence,
            this.#playSequence,
            this.#manualPlaying,
            this.effectivelyVisible,
            player,
            this.#player,
            this.#suspendedPlayer,
            this.#suspendingPlayer
          )) throw abortError();
          attempted = null;
        }
      } catch (error) {
        if (
          attempted !== null && (
            sequence === this.#playSequence ||
            attempted !== this.#player || !this.#manualPlaying ||
            !this.effectivelyVisible || attempted === this.#suspendedPlayer ||
            attempted === this.#suspendingPlayer
          )
        ) attempted.pause();
        if (sequence === this.#playSequence) this.#manualPlaying = previous;
        throw this.#retainedTerminalError() ?? error;
      }
    }

    public getDiagnostics(
      options: Readonly<{ trace?: boolean }> = {}
    ): Readonly<AvalDiagnostics> {
      if (!this.#events.active) this.#flushSourceMutations();
      return this.#diagnostics(options.trace === true);
    }

    public dispose(): Promise<void> {
      if (this.#disposePromise !== null) return this.#disposePromise;
      const deferred = this.#deferPublicMutationPromise(() => this.dispose());
      if (deferred !== null) return deferred;
      if (!this.#finalDisposed) {
        this.#finalDisposed = true;
        this.#trace.record("dispose", Math.max(1, this.#sourceGeneration));
      }
      this.#connected = false;
      this.#load = null;
      this.#removeObservers();
      const finish = (retirementCompleted: boolean): void => {
        const presentationCleanupCompleted = this.#layers.dispose();
        this.#setReadiness("disposed");
        const ownership = this.#ownershipSnapshot(true);
        const sourceCleanupCompleted = retirementCompleted &&
          this.#player === null && this.#retiringPlayer === null &&
          this.#controller === null && this.#pageParticipant === null &&
          this.#resourceBytes === 0 && this.#decoderState() === null &&
          this.#cleanup?.completed !== false;
        this.#terminalCleanup = Object.freeze({
          completed: sourceCleanupCompleted && presentationCleanupCompleted &&
            ownership.completed === true,
          sourceCleanupCompleted,
          presentationCleanupCompleted,
          elementOwnership: ownership
        });
        if (this.#terminalCleanup.completed !== true) {
          throw new ElementCleanupIncompleteError();
        }
      };
      const operation = this.#queueRetirement(true).then(
        () => finish(true),
        (error) => {
          try { finish(false); } catch { /* preserve the retirement failure */ }
          throw error;
        }
      );
      this.#disposePromise = operation;
      void operation.catch(() => {
        if (this.#disposePromise === operation) this.#disposePromise = null;
      });
      return operation;
    }

    #scheduleReload(replace = true, resetRestart = true): void {
      if (!this.#connected || this.#finalDisposed) return;
      if (resetRestart) {
        this.#clearRestart();
        if (replace) this.#invalidateSourceRequest();
      }
      this.#reloadReplace ||= replace;
      if (this.#reloadQueued) return;
      this.#reloadQueued = true;
      queueMicrotask(() => {
        this.#reloadQueued = false;
        const shouldReplace = this.#reloadReplace;
        this.#reloadReplace = false;
        if (!this.#connected || this.#finalDisposed) return;
        if (this.#restartVisibleOnly && !this.effectivelyVisible) {
          this.#restartPlayer = null;
          return;
        }
        if (!shouldReplace && this.#load !== null) return;
        this.#trackLoad(this.#queueGeneration());
      });
    }

    #flushSourceMutations(): boolean {
      const changed = this.#sourceObserver.takeRecords().some((record) =>
        sourceMutation(this, record)
      );
      if (changed) {
        this.#clearRestart();
        this.#invalidateSourceRequest();
        this.#reloadReplace = true;
      }
      if (!changed && !this.#reloadQueued) return false;
      this.#reloadQueued = false;
      const replace = this.#reloadReplace;
      this.#reloadReplace = false;
      if (replace && this.#connected && !this.#finalDisposed) {
        this.#trackLoad(this.#queueGeneration());
      }
      return replace;
    }

    #scheduleRestart(player: Player, state: string): void {
      if (this.#finalDisposed || !this.#connected || player !== this.#player) return;
      if (this.#restartPlayer === player) {
        this.#restartState = state;
        return;
      }
      this.#restartPlayer = player;
      this.#restartState = state;
      this.#restartInitialBody = true;
      this.#restartVisibleOnly = true;
      this.#scheduleReload(true, false);
    }

    #clearRestart(): void {
      this.#restartPlayer = null;
      this.#restartState = null;
      this.#restartInitialBody = false;
      this.#restartVisibleOnly = false;
    }

    #captureRestart(visibleOnly: boolean): void {
      const player = this.#player;
      let state = this.#requestedState ?? this.#metadata?.initialState ?? this.state;
      try { state = player?.snapshot(false).requestedState ?? state; }
      catch { /* retain the last published intent */ }
      if (state === null || state === undefined) return;
      this.#restartPlayer = player;
      this.#restartState = state;
      this.#restartInitialBody = true;
      this.#restartVisibleOnly = visibleOnly;
    }

    #ensure(): Promise<RuntimeReadinessResult> {
      if (this.#finalDisposed) return Promise.reject(abortError());
      if (this.#load === null) {
        if (!this.#connected) return Promise.reject(new AvalNotReadyError());
        const operation = this.#queueGeneration();
        this.#trackLoad(operation);
        return operation;
      }
      return this.#load;
    }

    #trackLoad(operation: Promise<RuntimeReadinessResult>): void {
      this.#load = operation;
      void operation.catch((error: unknown) => {
        if (
          this.#load === operation && !this.#finalDisposed &&
          error !== this.#terminalError
        ) this.#load = null;
      });
    }

    #queueGeneration(): Promise<RuntimeReadinessResult> {
      return this.#lifecycle.generation(
        () => this.#controller?.abort(),
        (token) => this.#startGeneration(token)
      );
    }

    #queueRetirement(terminal: boolean): Promise<void> {
      this.#invalidateSourceRequest();
      return this.#lifecycle.retirement(
        () => this.#controller?.abort(),
        () => this.#retireGeneration(terminal)
      );
    }

    async #startGeneration(token: number): Promise<RuntimeReadinessResult> {
      let restartState = this.#restartState;
      if (this.#restartPlayer !== null && this.#restartPlayer === this.#player) {
        restartState = this.#restartPlayer.snapshot(false).requestedState ??
          restartState;
      }
      const initialBody = this.#restartInitialBody;
      await this.#retireGeneration(false);
      if (
        !this.#lifecycle.current(token) ||
        !this.#connected || this.#finalDisposed
      ) throw abortError();
      this.#clearRestart();
      const generation = ++this.#sourceGeneration;
      this.#trace.record("source-start", generation);
      if (generation > 1) this.#counters.sourceReplacement += 1;
      this.#controller = new AbortController();
      this.#metadata = null;
      this.#requestedState = null;
      this.#visualState = null;
      this.#transitioning = false;
      this.#lastFailure = null;
      this.#terminalError = null;
      this.#cleanupFailureCount = 0;
      this.#decoderDiagnostics = Object.freeze([]);
      this.#mode = null;
      this.#staticReason = null;
      this.#layers.resetSource(generation);
      this.#setReadiness("unready");
      const document = this.ownerDocument;
      const sourceRead = readSources(this);
      for (const failure of sourceRead.failures) {
        this.#publishFailure(
          "invalid-configuration",
          `source[${String(failure.sourceIndex)}].${failure.attribute}`,
          false,
          generation
        );
      }
      const sources = sourceRead.sources;
      if (sources.length === 0) return this.#configurationFailure(generation);
      const view = document.defaultView;
      if (!runtimeHostSupported(this.#layers.stylesSupported, view)) {
        throw this.#publishTerminalFailure(
          "unsupported-browser",
          "configure",
          generation
        );
      }
      const clock = view.performance;
      const timing = createElementTiming(view);
      const deadline = clock.now() + PREPARATION_MS;
      try {
        if (needsIntersectionSample(
          this.#intersectionKnown,
          this.#documentVisible()
        )) {
          await withLimits(
            this.#ensureIntersectionGate().promise,
            this.#controller.signal,
            remainingPreparationMs(deadline, clock, timing),
            (delta) => { this.#timerCount += delta; },
            timing
          );
        }
        runtimeModule ??= import("./player.js");
        const module = await withLimits(
          runtimeModule,
          this.#controller.signal,
          remainingPreparationMs(deadline, clock, timing),
          (delta) => { this.#timerCount += delta; },
          timing
        );
        const preparationTimeoutMs = remainingPreparationMs(deadline, clock, timing);
        const initialRect = this.getBoundingClientRect();
        const selectedMotion = this.motion;
        const selectedReduced = this.#motionReduced(selectedMotion);
        const platform = createRealmPlatform(view);
        this.#ensurePageParticipant();
        const player = await module.createPlayer({
          canvas: this.#layers.animatedCanvas,
          platform,
          initialPresentation: initialPresentation(
            initialRect,
            view.devicePixelRatio,
            this.fit
          ),
          baseUrl: document.baseURI,
          sources,
          credentials: this.crossOrigin === "use-credentials"
            ? "include" : "same-origin",
          signal: this.#controller.signal,
          preparationTimeoutMs,
          motion: selectedMotion,
          reduced: selectedReduced,
          initialState: restartState,
          initialBody,
          visible: this.effectivelyVisible,
          decoderReady: () => this.#claimDecoder(generation, token),
          onResourceBytes: (bytes) => {
            if (!this.#publicationCurrent(generation, token)) return;
            this.#setResourceBytes(bytes);
          },
          onMetadata: (metadata) => {
            if (!this.#publicationCurrent(generation, token)) return;
            this.#metadata = metadata;
            this.#applyIntrinsic();
            this.#bindInputs();
            this.#resize();
          },
          onReadiness: (value, reason) => {
            if (!this.#publicationCurrent(generation, token)) return;
            if (value === "staticReady") {
              this.#mode = "static";
              this.#staticReason = reason as StaticReason;
            } else if (value === "interactiveReady" || value === "visualReady") {
              this.#mode = "animated";
            }
            this.#setReadiness(value as RuntimeReadiness, reason as StaticReason);
          },
          onAnimationResourcesRetired: () => {
            if (!this.#publicationCurrent(generation, token)) return;
            this.#releaseDecoderLease();
            if (this.#staticReason !== "decoder-queued") this.#cancelDecoderTicket();
          },
          onDraw: () => {
            if (!this.#publicationCurrent(generation, token)) return;
            this.#layers.markAnimatedDrawn(generation);
            this.#layers.revealAnimated(generation);
          },
          onRestart: (state) => {
            if (!this.#publicationCurrent(generation, token)) return;
            const current = this.#player;
            if (current !== null) this.#scheduleRestart(current, state);
          },
          onEvent: (type, detail) => {
            if (!this.#publicationCurrent(generation, token)) return;
            this.#runtimeEvent(type, detail, generation);
          },
          onFailure: (code, operation, fatal) => {
            if (!this.#publicationCurrent(generation, token)) return;
            this.#publishFailure(code, operation, fatal, generation);
          },
          onPlaybackFailure: (code, operation) => {
            if (!this.#publicationCurrent(generation, token)) {
              return this.#createPlaybackError(code, operation, generation);
            }
            const activePlayer = this.#player;
            const preparing = activePlayer !== null &&
              this.#preparingPlayer === activePlayer;
            this.#releasePageResources(true);
            const error = this.#publishTerminalFailure(
              code,
              operation,
              generation
            );
            if (activePlayer !== null && !preparing) {
              queueMicrotask(() => {
                if (
                  this.#terminalError !== error ||
                  this.#player !== activePlayer ||
                  !this.#generationCurrent(generation, token) ||
                  this.#finalDisposed
                ) return;
                void this.#queueRetirement(false).catch(() => undefined);
              });
            }
            return error;
          },
          onDecoderDiagnostics: (diagnostics) => {
            if (!this.#publicationCurrent(generation, token)) return;
            this.#retainDecoderDiagnostics(diagnostics, generation);
          }
        });
        if (!this.#current(generation, token)) {
          this.#retiringPlayer = player;
          await this.#retireGeneration(false);
          throw abortError();
        }
        this.#player = player;
        this.#preparingPlayer = player;
        player.activate();
        await this.#reconcileSelectionMotion(
          player,
          selectedMotion,
          selectedReduced,
          generation,
          token
        );
        if (!this.#current(generation, token)) throw abortError();
        this.#bindInputs();
        this.#resize();
        this.#updatePlayback();
        let result: RuntimeReadinessResult;
        try {
          result = this.#suspendingPlayer === player && this.#suspension !== null
            ? await this.#suspension
            : await player.prepare();
        }
        finally {
          if (this.#preparingPlayer === player) this.#preparingPlayer = null;
        }
        if (!this.#current(generation, token)) throw abortError();
        if (!this.effectivelyVisible) {
          if (result.mode === "static" && result.reason === "visibility-suspended") {
            this.#completeVisibilitySuspension(player, result);
          } else {
            result = await this.#suspendForVisibility(player);
          }
        }
        if (!this.#current(generation, token)) throw abortError();
        if (restartState === null) {
          const declarative = this.state;
          if (declarative !== null) {
            this.#applyDeclarativeStateToPlayer(
              player,
              declarative,
              generation,
              token
            );
          }
        }
        return result;
      } catch (error) {
        if (!this.#current(generation, token)) throw abortError();
        if (isAbort(error)) throw error;
        const playbackError = error instanceof AvalPlaybackError
          ? error : null;
        const timedOut = isPreparationTimeout(error);
        try {
          await failedGenerationCleanup(
            this.#player !== null,
            () => this.#retireGeneration(false),
            () => this.#releasePageResources(true)
          );
        } catch (cleanupError) {
          if (!this.#generationCurrent(generation, token)) throw abortError();
          if (playbackError !== null) throw playbackError;
          if (timedOut) {
            throw this.#publishTerminalFailure(
              "watchdog-timeout",
              "prepare",
              generation
            );
          }
          throw this.#publishTerminalFailure(
            "element-cleanup-incomplete",
            "prepare-cleanup",
            generation
          );
        }
        if (!this.#generationCurrent(generation, token)) throw abortError();
        if (playbackError !== null) throw playbackError;
        if (timedOut) {
          throw this.#publishTerminalFailure(
            "watchdog-timeout",
            "prepare",
            generation
          );
        }
        throw this.#publishTerminalFailure(
          "readiness-failure",
          "prepare",
          generation
        );
      }
    }

    #configurationFailure(generation: number): Promise<RuntimeReadinessResult> {
      return Promise.reject(this.#publishTerminalFailure(
        "invalid-configuration",
        "configure",
        generation
      ));
    }

    async #retireGeneration(terminal: boolean): Promise<void> {
      const controller = this.#controller;
      const player = this.#player ?? this.#retiringPlayer;
      const suspension = this.#suspendingPlayer === player
        ? this.#suspension : null;
      this.#controller = null;
      this.#player = null;
      if (this.#visibilityPlayer === player) this.#visibilityPlayer = null;
      controller?.abort();
      this.#unbindInputs();
      if (player === null) {
        this.#releasePageResources(true);
        return;
      }
      const retry = this.#retiringPlayer === player;
      this.#retiringPlayer = player;
      let failed = false;
      let caught = false;
      let failure: unknown;
      if (!retry || this.#retiringDeclaredFileBytes === 0) {
        this.#retiringDeclaredFileBytes = 0;
        try {
          const retired = player.snapshot(false);
          this.#captureCleanupFailures(retired);
          this.#retainDecoderDiagnostics(
            retired.decoderDiagnostics,
            this.#sourceGeneration
          );
          this.#retiringDeclaredFileBytes = retired.declaredFileBytes;
          this.#counters.contextRecovery += retired.contextRecoveryCount;
        } catch {
          failed = true;
        }
      }
      let disposed = false;
      try {
        if (suspension !== null) await Promise.allSettled([suspension]);
        await player.dispose();
        await player.settled();
        disposed = true;
      } catch (error) {
        failed = true;
        caught = true;
        failure = error;
      }
      if (this.#preparingPlayer === player) this.#preparingPlayer = null;
      if (this.#suspendingPlayer === player) {
        this.#suspendingPlayer = null;
        this.#suspension = null;
      }
      if (this.#suspendedPlayer === player) this.#suspendedPlayer = null;
      if (this.#restartPlayer === player) this.#restartPlayer = null;
      let snapshot: Readonly<PlayerSnapshot> | null = null;
      try { snapshot = player.snapshot(false); }
      catch (error) {
        failed = true;
        if (!caught) {
          caught = true;
          failure = error;
        }
      }
      this.#captureCleanupFailures(snapshot);
      this.#retainDecoderDiagnostics(
        snapshot?.decoderDiagnostics ?? Object.freeze([]),
        this.#sourceGeneration
      );
      if (disposed && !failed && playerSnapshotDisposed(snapshot)) {
        try {
          this.#setResourceBytes(0);
          this.#releasePageResources();
        } catch (error) {
          failed = true;
          if (!caught) {
            caught = true;
            failure = error;
          }
        }
      }
      this.#cleanup = createCleanupReceipt(
        this.#elementGeneration,
        this.#sourceGeneration,
        snapshot,
        this.#pageSnapshot(),
        this.#retiringDeclaredFileBytes,
        failed,
        this.#pageParticipant === null,
        this.#resourceBytes,
        this.#decoderState(),
        terminal,
        this.#stalePublicationCount
      );
      this.#counters.cleanup += 1;
      try {
        if (proveRetirement(disposed, this.#cleanup)) {
          this.#retiringPlayer = null;
          this.#retiringDeclaredFileBytes = 0;
          this.#pageRealm = null;
          return;
        }
      } catch (error) {
        if (!caught) {
          caught = true;
          failure = error;
        }
      }
      if (caught) throw failure;
      throw new ElementCleanupIncompleteError();
    }

    #runtimeEvent(
      type: string,
      detail: Readonly<Record<string, unknown>>,
      generation: number
    ): void {
      if (type === "requestedstatechange") {
        this.#requestedState = String(detail.to);
        this.#inputGeneration += 1;
      } else if (type === "visualstatechange") {
        this.#visualState = String(detail.to);
      } else if (type === "underflow") {
        this.#counters.underflow += 1;
      }
      this.#transitioning = transitioningState(
        this.#transitioning,
        type,
        detail
      );
      this.#dispatch(type, detail, generation);
      if (type === "transitionend") this.#queueEngagementRetry();
    }

    #publishFailure(
      code: FailureInput,
      operation: string,
      fatal: boolean,
      generation: number
    ): void {
      if (fatal) {
        this.#publishTerminalFailure(code, operation, generation);
        return;
      }
      if (this.#terminalError?.generation === generation) return;
      const publicCode = publicFailureCode(code);
      const failure = Object.freeze({
        code: publicCode,
        message: `AVAL operation failed (${publicCode})`,
        operation
      }) as Readonly<AvalPublicFailure>;
      this.#lastFailure = failure;
      this.#dispatch("error", { failure, fatal }, generation);
    }

    #publishTerminalFailure(
      code: FailureInput,
      operation: string,
      generation: number
    ): AvalPlaybackError {
      if (this.#terminalError?.generation === generation) {
        return this.#terminalError;
      }
      const error = this.#createPlaybackError(code, operation, generation);
      this.#terminalError = error;
      const retainedLoad = Promise.reject(error);
      void retainedLoad.catch(() => undefined);
      this.#load = retainedLoad;
      this.#lastFailure = error.failure;
      this.#mode = null;
      this.#staticReason = null;
      this.#setReadiness("error");
      this.#dispatch("error", { failure: error.failure, fatal: true }, generation);
      return error;
    }

    #createPlaybackError(
      code: FailureInput,
      operation: string,
      generation: number
    ): AvalPlaybackError {
      const publicCode = publicFailureCode(code);
      return new AvalPlaybackError(Object.freeze({
        code: publicCode,
        message: `AVAL operation failed (${publicCode})`,
        operation
      }), generation);
    }

    #setReadiness(value: RuntimeReadiness, reason?: StaticReason): void {
      const from = this.#readiness;
      if (from === value) return;
      this.#readiness = value;
      this.#dispatch("readinesschange", {
        from,
        to: value,
        ...(reason === undefined ? {} : { reason })
      } satisfies Omit<AvalReadinessChangeDetail, "generation">,
      this.#sourceGeneration);
    }

    #dispatch(
      type: string,
      detail: Readonly<Record<string, unknown>>,
      generation = this.#sourceGeneration
    ): void {
      if (generation < 1) return;
      this.#trace.record(`publish-${type}`, generation);
      try {
        this.#events.dispatch(this.#events.create(
          type,
          Object.freeze({ generation, ...detail })
        ));
      } catch { /* public observers cannot break runtime authority */ }
    }

    #installObservers(): boolean {
      const document = this.ownerDocument;
      const view = document.defaultView;
      const root = this.getRootNode();
      if (
        this.#observersInstalled && this.#installedDocument === document &&
        this.#installedRoot === root
      ) return true;
      if (this.#installedDocument !== null || this.#sourceObserving) {
        this.#removeObservers();
      }
      this.#retryFailedReleases();
      const epoch = ++this.#observerEpoch;
      this.#installedRoot = root;
      this.#installedDocument = document;
      this.#installedView = view;
      try {
        this.#sourceObserving = true;
        this.#sourceObserver.observe(this, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["src", "type", "integrity"]
        });
        if (typeof view?.ResizeObserver === "function") {
          const observer = new view.ResizeObserver(() => {
            if (epoch === this.#observerEpoch) this.#resize();
          });
          this.#resizeObserver = observer;
          observer.observe(this);
        }
        if (typeof view?.IntersectionObserver === "function") {
          const observer = new view.IntersectionObserver((entries) => {
            if (epoch !== this.#observerEpoch) return;
            const entry = entries.at(-1);
            if (entry === undefined) return;
            this.#intersecting = entry.isIntersecting && entry.intersectionRatio > 0;
            this.#intersectionKnown = true;
            this.#visibilityChanged();
            const gate = this.#intersectionGate;
            this.#intersectionGate = null;
            gate?.resolve();
          });
          this.#intersectionObserver = observer;
          observer.observe(this);
        } else {
          this.#intersecting = false;
          this.#intersectionKnown = true;
        }
        this.#documentListener = () => {
          if (epoch !== this.#observerEpoch) return;
          if (!this.#documentVisible()) this.#resolveIntersectionGate();
          this.#visibilityChanged();
        };
        document.addEventListener("visibilitychange", this.#documentListener);
        this.#media = typeof view?.matchMedia === "function"
          ? view.matchMedia("(prefers-reduced-motion: reduce)") : null;
        this.#mediaListener = () => {
          if (epoch !== this.#observerEpoch) return;
          this.#motionGeneration += 1;
          this.#applyMotion();
        };
        this.#media?.addEventListener("change", this.#mediaListener);
        this.#windowListener = () => {
          if (epoch === this.#observerEpoch) this.#resize();
        };
        view?.addEventListener("resize", this.#windowListener);
        this.#pageHideListener = () => {
          if (epoch !== this.#observerEpoch) return;
          this.#pageHidden = true;
          this.#trace.record("pagehide", Math.max(1, this.#sourceGeneration));
          this.#resolveIntersectionGate();
          this.#visibilityChanged();
        };
        view?.addEventListener("pagehide", this.#pageHideListener);
        this.#pageShowListener = (event) => {
          if (epoch !== this.#observerEpoch) return;
          this.#pageHidden = false;
          if (persistedPageShow(event)) {
            this.#trace.record("bfcache-restore", Math.max(1, this.#sourceGeneration));
            this.#pageParticipant?.setVisible(this.effectivelyVisible);
            this.#invalidateSourceRequest();
            this.#captureRestart(false);
            this.#scheduleReload(true, false);
            return;
          }
          this.#visibilityChanged();
        };
        view?.addEventListener("pageshow", this.#pageShowListener);
        this.#observersInstalled = true;
        this.#resize();
        return true;
      } catch {
        this.#removeObservers();
        return false;
      }
    }

    #createSourceObserver(): MutationObserver {
      const Observer = this.ownerDocument.defaultView?.MutationObserver ?? MutationObserver;
      let observer!: MutationObserver;
      observer = new Observer((records) => {
        if (observer !== this.#sourceObserver || !this.#sourceObserving) return;
        if (records.some((record) => sourceMutation(this, record))) {
          this.#scheduleReload();
        }
      });
      return observer;
    }

    #removeObservers(): void {
      this.#retryFailedReleases();
      this.#observersInstalled = false;
      this.#observerEpoch += 1;
      const sourceObserver = this.#sourceObserver;
      const sourceObserving = this.#sourceObserving;
      this.#sourceObserving = false;
      if (sourceObserving) {
        this.#attemptRelease("observer", () => sourceObserver.disconnect());
      }
      const resizeObserver = this.#resizeObserver;
      const intersectionObserver = this.#intersectionObserver;
      this.#resizeObserver = null;
      this.#intersectionObserver = null;
      if (resizeObserver !== null) {
        this.#attemptRelease("observer", () => resizeObserver.disconnect());
      }
      if (intersectionObserver !== null) {
        this.#attemptRelease("observer", () => intersectionObserver.disconnect());
      }
      const documentTarget = this.#installedDocument;
      const viewTarget = this.#installedView;
      const documentListener = this.#documentListener;
      const windowListener = this.#windowListener;
      const pageHideListener = this.#pageHideListener;
      const pageShowListener = this.#pageShowListener;
      const media = this.#media;
      const mediaListener = this.#mediaListener;
      this.#installedRoot = null;
      this.#installedDocument = null;
      this.#installedView = null;
      this.#documentListener = null;
      this.#mediaListener = null;
      this.#windowListener = null;
      this.#pageHideListener = null;
      this.#pageShowListener = null;
      if (documentListener !== null) this.#attemptRelease(
        "listener",
        () => documentTarget?.removeEventListener("visibilitychange", documentListener)
      );
      if (windowListener !== null) this.#attemptRelease(
        "listener",
        () => viewTarget?.removeEventListener("resize", windowListener)
      );
      if (pageHideListener !== null) this.#attemptRelease(
        "listener",
        () => viewTarget?.removeEventListener("pagehide", pageHideListener)
      );
      if (pageShowListener !== null) this.#attemptRelease(
        "listener",
        () => viewTarget?.removeEventListener("pageshow", pageShowListener)
      );
      if (mediaListener !== null) this.#attemptRelease(
        "listener",
        () => media?.removeEventListener("change", mediaListener)
      );
      this.#pageHidden = false;
      this.#media = null;
      this.#intersecting = false;
      this.#intersectionKnown = false;
      this.#lastVisibility = null;
      const gate = this.#intersectionGate;
      this.#intersectionGate = null;
      gate?.reject(abortError());
      this.#unbindInputs();
    }

    #attemptRelease(kind: OwnedRelease["kind"], release: () => void): void {
      try { release(); }
      catch { this.#failedReleases.push({ kind, release }); }
    }

    #retryFailedReleases(): void {
      const pending = this.#failedReleases;
      this.#failedReleases = [];
      for (const owner of pending) this.#attemptRelease(owner.kind, owner.release);
    }

    #ensureIntersectionGate(): IntersectionGate {
      if (this.#intersectionGate !== null) return this.#intersectionGate;
      let resolve!: () => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<void>((accepted, rejected) => {
        resolve = accepted;
        reject = rejected;
      });
      return this.#intersectionGate = { promise, resolve, reject };
    }

    #resolveIntersectionGate(): void {
      const gate = this.#intersectionGate;
      this.#intersectionGate = null;
      gate?.resolve();
    }

    #resize(): void {
      const rect = this.getBoundingClientRect();
      this.#positiveBox = rect.width > 0 && rect.height > 0;
      this.#resizeGeneration += 1;
      const fit = this.fit ?? this.#metadata?.canvas.fit ?? "contain";
      this.#player?.resize(
        Math.max(1, rect.width),
        Math.max(1, rect.height),
        this.ownerDocument.defaultView?.devicePixelRatio ?? 1,
        fit
      );
      this.#visibilityChanged();
    }

    #applyIntrinsic(): void {
      const width = this.width;
      const height = this.height;
      const canvas = this.#metadata?.canvas;
      const ratio = intrinsicRatio(width, height, canvas);
      this.#layers.setIntrinsicSize({ aspectRatio: ratio, width, height });
    }

    #visibilityChanged(): void {
      if (!this.#intersectionKnown && !this.#pageHidden) return;
      const visible = this.effectivelyVisible;
      const player = this.#player;
      const edge = visible !== this.#lastVisibility;
      const playerChanged = player !== this.#visibilityPlayer;
      if (!edge && !playerChanged) return;
      if (edge) {
        this.#lastVisibility = visible;
        this.#visibilityGeneration += 1;
        this.#pageParticipant?.setVisible(visible);
      }
      this.#visibilityPlayer = player;
      if (player === null) return;
      player.setVisibility(visible);
      this.#updatePlayback();
      const source = visible ? "visible" : "hidden";
      this.#sendBinding(source);
      if (!visible) {
        if (
          this.#suspendedPlayer !== player &&
          this.#suspendingPlayer !== player
        ) {
          const suspension = this.#suspendForVisibility(player);
          this.#load = suspension;
          void suspension.catch(() => undefined);
        }
        return;
      }
      if (this.#suspendedPlayer === player) {
        const state = this.#restartState ??
          player.snapshot(false).requestedState ??
          this.#requestedState ?? this.#metadata?.initialState;
        if (state !== undefined && state !== null) {
          this.#scheduleRestart(player, state);
        }
      }
    }

    #playIntent(): boolean {
      return this.#manualPlaying;
    }

    #applyMotion(): void {
      const player = this.#player;
      if (player === null) return;
      const generation = this.#sourceGeneration;
      const reduced = this.#motionReduced(this.motion);
      if (reduced) this.#cancelDecoderTicket();
      void player.setMotion(this.motion, reduced).then(() => {
        if (player === this.#player) this.#updatePlayback();
      }, (error) => {
        if (player === this.#player && !isAbort(error)) {
          this.#publishFailure("readiness-failure", "motion", false, generation);
        }
      });
    }

    async #reconcileSelectionMotion(
      player: Player,
      selectedMotion: AvalMotion,
      selectedReduced: boolean,
      generation: number,
      token: number
    ): Promise<void> {
      let appliedMotion = selectedMotion;
      let appliedReduced = selectedReduced;
      while (this.#current(generation, token) && player === this.#player) {
        const motion = this.motion;
        const reduced = this.#motionReduced(motion);
        if (!motionSelectionChanged(
          appliedMotion,
          appliedReduced,
          motion,
          reduced
        )) return;
        await player.setMotion(motion, reduced);
        appliedMotion = motion;
        appliedReduced = reduced;
      }
    }

    #motionReduced(policy: AvalMotion): boolean {
      return policy === "reduce" ||
        policy === "auto" && this.#media?.matches === true;
    }

    #updatePlayback(): void {
      const player = this.#player;
      if (player === null) return;
      if (!this.#playIntent() || !this.effectivelyVisible) {
        player.pause();
      } else if (
        player !== this.#suspendedPlayer &&
        player !== this.#suspendingPlayer
      ) {
        void player.resume().catch(() => undefined);
      }
    }

    #suspendForVisibility(player: Player): Promise<RuntimeReadinessResult> {
      if (this.#suspendingPlayer === player && this.#suspension !== null) {
        return this.#suspension;
      }
      const operation = player.suspend("visibility-suspended");
      this.#suspendingPlayer = player;
      const tracked = operation.then((result) => {
        this.#completeVisibilitySuspension(player, result);
        return result;
      }, (error) => {
        if (this.#suspendingPlayer === player) {
          this.#suspendingPlayer = null;
          this.#suspension = null;
        }
        throw error;
      });
      this.#suspension = tracked;
      return tracked;
    }

    #completeVisibilitySuspension(
      player: Player,
      result: RuntimeReadinessResult
    ): void {
      if (result.mode !== "static" || result.reason !== "visibility-suspended") {
        throw new Error("Invalid AVAL visibility suspension result");
      }
      if (this.#suspendingPlayer === player) {
        this.#suspendingPlayer = null;
        this.#suspension = null;
      }
      if (player !== this.#player) return;
      this.#suspendedPlayer = player;
      this.#mode = "static";
      this.#staticReason = "visibility-suspended";
      this.#setReadiness("staticReady", "visibility-suspended");
      this.#releasePageResources();
      if (!this.effectivelyVisible) return;
      const state = this.#restartState ?? player.snapshot(false).requestedState ??
        this.#requestedState ?? this.#metadata?.initialState;
      if (state !== undefined && state !== null) this.#scheduleRestart(player, state);
    }

    #bindInputs(): void {
      this.#unbindInputs();
      if (this.bindings === "none" || this.#metadata === null || this.#player === null) return;
      const target = this.interactionTarget;
      if (target === null) {
        if (this.interactionFor !== "") {
          this.#publishFailure(
            "interaction-target-unavailable",
            "bind-inputs",
            false,
            Math.max(1, this.#sourceGeneration)
          );
        }
        return;
      }
      const bindingEpoch = this.#bindingEpoch;
      this.#boundInputTarget = target;
      const current = (): boolean => bindingCurrent(
        bindingEpoch,
        this.#bindingEpoch,
        target,
        this.interactionTarget
      );
      const bind = (type: string, operation: () => void): void => {
        const listener = (): void => {
          if (current()) operation();
        };
        this.#inputListeners.push({ target, type, listener });
        target.addEventListener(type, listener);
      };
      try {
        bind("pointerenter", () => {
          this.#hovered = true;
          this.#sendBinding("pointer.enter");
          this.#engagement();
        });
        bind("pointerleave", () => {
          this.#hovered = false;
          this.#sendBinding("pointer.leave");
          this.#engagement();
        });
        bind("focusin", () => {
          this.#focused = true;
          this.#sendBinding("focus.in");
          this.#engagement();
        });
        bind("focusout", () => this.#queueOwnedMicrotask(() => {
          if (!current()) return;
          this.#focused = target.contains(this.ownerDocument.activeElement);
          if (!this.#focused) this.#sendBinding("focus.out");
          this.#engagement();
        }));
        bind("click", () => this.#sendBinding("activate"));
        this.#hovered = target.matches(":hover");
        this.#focused = target.contains(this.ownerDocument.activeElement);
        this.#sendBinding(this.#hovered ? "pointer.enter" : "pointer.leave");
        this.#sendBinding(this.#focused ? "focus.in" : "focus.out");
        this.#engagement(true);
      } catch {
        this.#unbindInputs();
      }
    }

    #unbindInputs(): void {
      this.#bindingEpoch += 1;
      const listeners = this.#inputListeners;
      this.#inputListeners = [];
      this.#boundInputTarget = null;
      for (const { target, type, listener } of listeners) this.#attemptRelease(
        "listener",
        () => target.removeEventListener(type, listener)
      );
      this.#hovered = false;
      this.#focused = false;
      this.#engagementBinding.reset();
    }

    #engagement(force = false): void {
      const engaged = this.#hovered || this.#focused;
      this.#engagementBinding.update(engaged, force);
    }

    #queueEngagementRetry(): void {
      const bindingEpoch = this.#bindingEpoch;
      const target = this.#boundInputTarget;
      queueOwnedEventFollowup(
        (operation) => this.#events.after(operation),
        (delta) => { this.#deferredCommandCount += delta; },
        () => {
          if (
            target === null ||
            !bindingCurrent(
              bindingEpoch,
              this.#bindingEpoch,
              target,
              this.#boundInputTarget
            ) ||
            target !== this.interactionTarget
          ) return;
          this.#engagementBinding.retry(this.#hovered || this.#focused);
        }
      );
    }

    #sendBinding(source: string): boolean | null {
      if (this.bindings === "none") return null;
      this.#trace.record(
        `input-${source.replaceAll(".", "-")}`,
        Math.max(1, this.#sourceGeneration)
      );
      let result: boolean | null = null;
      for (const binding of this.#metadata?.bindings ?? []) {
        if (binding.source !== source) continue;
        const accepted = this.send(binding.event);
        result = result === null ? accepted : result || accepted;
      }
      return result;
    }

    #resolveInteractionTarget(): Element | null {
      const id = this.interactionFor;
      if (id === "") return this;
      const root = this.getRootNode();
      if ("getElementById" in root && typeof root.getElementById === "function") {
        return root.getElementById(id);
      }
      return null;
    }

    #current(generation: number, token: number): boolean {
      return this.#generationCurrent(generation, token) &&
        this.#controller?.signal.aborted === false;
    }

    #retainedTerminalError(): AvalPlaybackError | null {
      const error = this.#terminalError;
      return error?.generation === this.#sourceGeneration ? error : null;
    }

    #generationCurrent(generation: number, token: number): boolean {
      return !this.#finalDisposed &&
        this.#lifecycle.current(token) &&
        generation === this.#sourceGeneration;
    }

    #publicationCurrent(generation: number, token: number): boolean {
      if (this.#current(generation, token)) return true;
      this.#stalePublicationCount += 1;
      return false;
    }

    #documentVisible(): boolean {
      return !this.#pageHidden && this.ownerDocument.visibilityState !== "hidden";
    }

    #ensurePageParticipant(): PageDecoderParticipant {
      if (this.#pageParticipant !== null) return this.#pageParticipant;
      const realm = this.ownerDocument.defaultView ?? globalThis;
      this.#pageRealm = realm;
      return this.#pageParticipant = createPageDecoderParticipant(
        this.effectivelyVisible,
        realm
      );
    }

    #setResourceBytes(bytes: number): void {
      const participant = this.#pageParticipant;
      if (participant === null) {
        if (bytes !== 0) throw new Error("AVAL page participant is unavailable");
        this.#resourceBytes = 0;
        return;
      }
      participant.setPhysicalBytes(bytes);
      this.#resourceBytes = bytes;
    }

    #claimDecoder(generation: number, token: number): boolean {
      if (!this.#current(generation, token)) return false;
      if (this.#decoderLease !== null) return true;
      if (this.#decoderTicket !== null) return false;
      const epoch = this.#sourceRequestEpoch;
      const ticket = this.#ensurePageParticipant().request();
      const lease = ticket.take();
      if (lease !== null) {
        this.#decoderLease = lease;
        return true;
      }
      this.#decoderTicket = ticket;
      void ticket.wait().then((granted) => {
        if (
          this.#decoderTicket !== ticket || this.#finalDisposed ||
          !this.#connected || epoch !== this.#sourceRequestEpoch ||
          !this.#current(generation, token)
        ) {
          granted.release();
          return;
        }
        this.#decoderTicket = null;
        this.#decoderLease = granted;
        const player = this.#player;
        if (player !== null && !this.#reloadQueued) {
          const state = player.snapshot(false).requestedState ??
            this.#requestedState ?? this.#metadata?.initialState;
          if (state !== undefined && state !== null) {
            this.#scheduleRestart(player, state);
          }
        }
      }, () => {
        if (this.#decoderTicket === ticket) this.#decoderTicket = null;
      });
      return false;
    }

    #invalidateSourceRequest(): void {
      this.#sourceRequestEpoch += 1;
      this.#cancelDecoderTicket();
    }

    #releaseDecoder(): void {
      this.#cancelDecoderTicket();
      this.#releaseDecoderLease();
    }

    #cancelDecoderTicket(): void {
      this.#decoderTicket?.cancel();
      this.#decoderTicket = null;
    }

    #releaseDecoderLease(): void {
      this.#decoderLease?.release();
      this.#decoderLease = null;
    }

    #releasePageResources(forgetRealm = false): void {
      this.#releaseDecoder();
      this.#pageParticipant?.dispose();
      this.#pageParticipant = null;
      this.#resourceBytes = 0;
      if (forgetRealm) this.#pageRealm = null;
    }

    #captureCleanupFailures(snapshot: Readonly<PlayerSnapshot> | null): void {
      this.#cleanupFailureCount = Math.max(
        this.#cleanupFailureCount,
        snapshot?.cleanupFailureCount ?? 0
      );
    }

    #retainDecoderDiagnostics(
      diagnostics: readonly Readonly<PlayerDecoderDiagnostic>[],
      generation: number
    ): void {
      if (generation !== this.#sourceGeneration || diagnostics.length === 0) return;
      const byLane = new Map(
        this.#decoderDiagnostics.map((diagnostic) => [
          diagnostic.lane,
          diagnostic
        ] as const)
      );
      for (const diagnostic of diagnostics.slice(0, 2)) {
        byLane.set(
          diagnostic.lane,
          freezeAvalDecoderDiagnostic(diagnostic, generation)
        );
      }
      this.#decoderDiagnostics = Object.freeze(
        [...byLane.values()]
          .sort((left, right) => left.lane - right.lane)
          .slice(0, 2)
      );
    }

    #pageSnapshot(): Readonly<PageResourcesSnapshot> {
      return pageResourcesSnapshot(
        this.#pageRealm ?? this.ownerDocument.defaultView ?? globalThis
      );
    }

    #decoderState(): string | null {
      if (this.#decoderLease !== null) return "granted";
      return this.#decoderTicket?.state() ?? null;
    }

    #ownershipSnapshot(terminal: boolean): Readonly<Record<string, unknown>> {
      const failedListeners = this.#failedReleases.filter(
        (owner) => owner.kind === "listener"
      ).length;
      const failedObservers = this.#failedReleases.length - failedListeners;
      const listenerCount = this.#inputListeners.length +
        Number(this.#documentListener !== null) +
        Number(this.#media !== null && this.#mediaListener !== null) +
        Number(this.#windowListener !== null) +
        Number(this.#pageHideListener !== null) +
        Number(this.#pageShowListener !== null) + failedListeners;
      const observerCount = Number(this.#sourceObserving) +
        Number(this.#resizeObserver !== null) +
        Number(this.#intersectionObserver !== null) + failedObservers;
      const pendingCommandCount = this.#lifecycle.pending +
        Number(this.#reloadQueued) + Number(this.#suspension !== null) +
        Number(this.#restartPlayer !== null) + this.#deferredCommandCount;
      return createOwnershipSnapshot(
        terminal,
        listenerCount,
        observerCount,
        pendingCommandCount,
        this.#timerCount,
        this.#failedReleases.length
      );
    }

    #diagnostics(trace: boolean): Readonly<AvalDiagnostics> {
      const runtimePlayer = this.#player ?? this.#retiringPlayer;
      const runtime = runtimePlayer?.snapshot(trace) ?? emptyRuntime();
      if (runtime.decoderDiagnostics.length > 0) {
        this.#retainDecoderDiagnostics(
          runtime.decoderDiagnostics,
          this.#sourceGeneration
        );
      }
      const ownership = this.#ownershipSnapshot(this.#finalDisposed);
      const page = this.#pageSnapshot();
      const reduced = this.motion === "reduce" ||
        this.motion === "auto" && this.#media?.matches === true;
      const diagnostics = {
        elementGeneration: this.#elementGeneration,
        sourceGeneration: this.#sourceGeneration,
        inputGeneration: this.#inputGeneration,
        motionGeneration: this.#motionGeneration,
        visibilityGeneration: this.#visibilityGeneration,
        resizeGeneration: this.#resizeGeneration,
        connected: this.#connected,
        finalDisposed: this.#terminalCleanup?.completed === true,
        readiness: this.#readiness,
        mode: this.#mode,
        assurance: this.assurance,
        staticReason: this.#staticReason,
        requestedState: this.#requestedState,
        visualState: this.#visualState,
        isTransitioning: this.#transitioning,
        paused: this.paused,
        effectivelyVisible: this.effectivelyVisible,
        stateNames: Object.freeze([...this.stateNames]),
        eventNames: Object.freeze([...this.eventNames]),
        inputBindings: Object.freeze(this.inputBindings.map((binding) =>
          Object.freeze({ ...binding })
        )),
        configuredMotion: this.motion,
        hostReducedMotion: this.#media?.matches ?? null,
        autoplay: this.autoplay,
        fit: this.fit,
        lastFailure: this.#lastFailure,
        counters: Object.freeze({
          ...this.#counters,
          contextRecovery: contextRecoveryCount(
            this.#counters.contextRecovery,
            this.#player === runtimePlayer ? runtime.contextRecoveryCount : 0
          )
        }),
        cleanup: this.#cleanup,
        elementOwnership: ownership,
        terminalCleanup: this.#terminalCleanup,
        outstanding: Object.freeze({
          player: runtimePlayer === null ? 0 : 1,
          decoder: outstandingDecoder(
            runtime.workerCount,
            this.#decoderState()
          ),
          bytes: this.#resourceBytes
        }),
        runtime: Object.freeze({
          selectedRendition: runtime.selectedRendition,
          selectedCodec: runtime.selectedCodec,
          selectedBitDepth: runtime.selectedBitDepth,
          transportMode: runtime.transportMode,
          declaredFileBytes: runtime.declaredFileBytes,
          metadataBytes: runtime.metadataBytes,
          verifiedBytes: runtime.verifiedBytes,
          residentBlobBytes: runtime.residentBlobBytes,
          activeTransportBodies: runtime.activeTransportBodies,
          pendingLoads: runtime.pendingLoads,
          interestedWaiters: runtime.interestedWaiters,
          stalePublicationCount: this.#stalePublicationCount,
          playerTrackedBytes: this.#resourceBytes,
          pagePhysicalBytes: page.physicalBytes,
          activeLeaseCount: Number(this.#decoderLease !== null),
          decoderLeaseState: this.#decoderState(),
          pageActiveDecoderSlotCount: page.active,
          pageQueuedDecoderTicketCount: page.queued,
          pageParkedDecoderTicketCount: page.parked,
          pageParticipantCount: page.participants,
          reclamationCount: 0,
          contextLossCount: runtime.contextLossCount,
          contextRecoveryCount: runtime.contextRecoveryCount,
          cleanupFailureCount: Math.max(
            this.#cleanupFailureCount,
            runtime.cleanupFailureCount ?? 0
          ),
          decoderDiagnostics: this.#decoderDiagnostics
        }),
        motion: Object.freeze({
          configured: this.motion,
          hostReducedMotion: this.#media?.matches ?? null,
          effective: reduced ? "reduce" : "full",
          actual: this.#mode
        }),
        playIntent: Object.freeze({
          autoplay: this.autoplay,
          manualPlaying: this.#manualPlaying,
          paused: this.paused
        }),
        visibility: Object.freeze({
          documentVisible: this.#documentVisible(),
          intersecting: this.#intersecting,
          positiveBox: this.#positiveBox,
          effectivelyVisible: this.effectivelyVisible,
          observerSupported: this.#intersectionObserver !== null,
          runtimeVisibility: runtimeVisibility(
            runtimePlayer !== null,
            this.effectivelyVisible
          ),
          runtimeSuspension: runtimeSuspension(
            runtimePlayer !== null,
            this.#suspendingPlayer !== null,
            this.#suspendedPlayer !== null
          ),
          rebuildPending: this.#reloadQueued || this.#restartPlayer !== null
        }),
        presentation: Object.freeze({
          fit: this.fit ?? this.#metadata?.canvas.fit ?? null,
          ...runtime.presentation,
          resolutionScale: resolutionScale(
            runtime.presentation.backingWidth,
            runtime.presentation.backingHeight
          ),
          clampReasons: Object.freeze([])
        }),
        ...(trace
          ? {
              elementTrace: this.#trace.snapshot(),
              runtimeTrace: runtime.trace
            }
          : {})
      };
      return Object.freeze(diagnostics) as unknown as Readonly<AvalDiagnostics>;
    }
  }

  return AvalElementImpl as unknown as AvalElementConstructor;
}

export function removeInstalledListeners(
  documentTarget: Pick<Document, "removeEventListener"> | null,
  viewTarget: Pick<Window, "removeEventListener"> | null,
  documentListener: (() => void) | null,
  windowListener: (() => void) | null,
  pageHideListener: EventListener | null = null,
  pageShowListener: EventListener | null = null
): boolean {
  let complete = true;
  const attempt = (operation: () => void): void => {
    try { operation(); } catch { complete = false; }
  };
  if (documentListener !== null) {
    attempt(() => documentTarget?.removeEventListener("visibilitychange", documentListener));
  }
  if (windowListener !== null) {
    attempt(() => viewTarget?.removeEventListener("resize", windowListener));
  }
  if (pageHideListener !== null) {
    attempt(() => viewTarget?.removeEventListener("pagehide", pageHideListener));
  }
  if (pageShowListener !== null) {
    attempt(() => viewTarget?.removeEventListener("pageshow", pageShowListener));
  }
  return complete;
}

export function persistedPageShow(event: Event): boolean {
  return "persisted" in event && event.persisted === true;
}

export function runtimeHostSupported(
  stylesSupported: boolean,
  view: Window | null
): view is Window {
  return stylesSupported && view !== null;
}

export function createRealmPlatform(
  view: Window
): Readonly<PlayerInput["platform"]> {
  const realm = view as Window & Partial<Pick<
    typeof globalThis,
    "Worker" | "VideoDecoder" | "VideoFrame"
  >>;
  return Object.freeze({
    fetch: view.fetch.bind(view),
    Worker: typeof realm.Worker === "function" ? realm.Worker : null,
    VideoDecoder: typeof realm.VideoDecoder === "function" ? realm.VideoDecoder : null,
    VideoFrame: typeof realm.VideoFrame === "function" ? realm.VideoFrame : null,
    requestAnimationFrame: view.requestAnimationFrame.bind(view),
    cancelAnimationFrame: view.cancelAnimationFrame.bind(view),
    now: view.performance.now.bind(view.performance),
    setTimeout: (callback, delay) => view.setTimeout(callback, delay),
    clearTimeout: (handle) => view.clearTimeout(handle),
    crypto: view.crypto
  });
}

export function createElementTiming(
  view: Window
): ElementTiming {
  const realm = view as Window & Pick<typeof globalThis, "DOMException">;
  return Object.freeze({
    setTimeout: (callback, delay) => view.setTimeout(callback, delay),
    clearTimeout: (handle) => view.clearTimeout(handle),
    timeoutError: () => new realm.DOMException(
      "AVAL preparation timed out",
      "TimeoutError"
    ),
    abortError: () => new realm.DOMException(
      "AVAL operation was aborted",
      "AbortError"
    )
  });
}

export function needsIntersectionSample(
  intersectionKnown: boolean,
  documentVisible: boolean
): boolean {
  return !intersectionKnown && documentVisible;
}

export function deferAcceptedSend(
  canSend: () => boolean,
  defer: (operation: () => void) => boolean,
  send: () => void
): boolean {
  if (!canSend()) return false;
  if (!defer(send)) return false;
  return true;
}

export function deferAttributeEffect(
  pending: Set<string>,
  name: string,
  defer: (operation: () => void) => boolean,
  read: () => string | null,
  apply: (value: string | null) => void
): boolean {
  if (pending.has(name)) return true;
  pending.add(name);
  const accepted = defer(() => {
    pending.delete(name);
    apply(read());
  });
  if (!accepted) pending.delete(name);
  return accepted;
}

export function queueOwnedMicrotask(
  pending: (delta: 1 | -1) => void,
  operation: () => void
): void {
  pending(1);
  queueMicrotask(() => {
    pending(-1);
    operation();
  });
}

/** Runs after listener-deferred public work while retaining cleanup ownership. */
export function queueOwnedEventFollowup(
  after: (operation: () => void) => Promise<void>,
  pending: (delta: 1 | -1) => void,
  operation: () => void
): void {
  pending(1);
  void after(() => {
    pending(-1);
    operation();
  });
}

export async function failedGenerationCleanup(
  published: boolean,
  retirePublished: () => Promise<void>,
  releaseUnpublished: () => void
): Promise<void> {
  if (published) await retirePublished();
  else releaseUnpublished();
}

export function rebindAdoptedStyles(
  layers: Pick<ShadowLayerOwner, "rebindStyles">,
  document: Document
): boolean {
  return layers.rebindStyles(document);
}

export function initialPresentation(
  rect: Readonly<Pick<DOMRectReadOnly, "width" | "height">>,
  dpr: number,
  fit: AvalFit | null
): Readonly<{
  width: number;
  height: number;
  dpr: number;
  fit: AvalFit | null;
}> {
  return Object.freeze({ width: rect.width, height: rect.height, dpr, fit });
}

export function motionSelectionChanged(
  selectedPolicy: AvalMotion,
  selectedReduced: boolean,
  currentPolicy: AvalMotion,
  currentReduced: boolean
): boolean {
  return selectedPolicy !== currentPolicy || selectedReduced !== currentReduced;
}

export function bindingCurrent(
  expectedEpoch: number,
  currentEpoch: number,
  expectedTarget: object,
  currentTarget: object | null
): boolean {
  return expectedEpoch === currentEpoch && expectedTarget === currentTarget;
}

export function interactionTarget(
  host: HTMLElement,
  value: Element | null
): Element | null {
  const Constructor = host.ownerDocument.defaultView?.Element;
  if (value !== null && (Constructor === undefined || !(value instanceof Constructor))) {
    throw new TypeError("interactionTarget must be a current-realm Element or null");
  }
  if (value !== null && value.getRootNode() !== host.getRootNode()) {
    throw new TypeError("interactionTarget must share the element root");
  }
  return value;
}

export function publicFailureCode(
  code: FailureInput
): AvalPublicFailure["code"] {
  return code;
}

export function outstandingDecoder(
  workerCount: number,
  ticketState: string | null
): number {
  return Math.max(
    workerCount,
    ticketState === null ? 0 : ELEMENT_DECODER_CAPACITY.workerCount
  );
}

export function contextRecoveryCount(
  retiredCount: number,
  liveCount: number
): number {
  return retiredCount + liveCount;
}

export function resolutionScale(
  backingWidth: number,
  backingHeight: number
): 0 | 1 {
  return backingWidth > 0 && backingHeight > 0 ? 1 : 0;
}

export function runtimeVisibility(
  hasRuntime: boolean,
  effectivelyVisible: boolean
): "visible" | "hidden" | null {
  return hasRuntime ? effectivelyVisible ? "visible" : "hidden" : null;
}

export function runtimeSuspension(
  hasRuntime: boolean,
  suspending: boolean,
  suspended: boolean
): "active" | "suspending" | "suspended" | null {
  if (!hasRuntime) return null;
  return suspending ? "suspending" : suspended ? "suspended" : "active";
}

export interface SourceRead {
  readonly sources: readonly Readonly<Source>[];
  readonly failures: readonly Readonly<{
    sourceIndex: number;
    attribute: "src" | "type" | "integrity";
  }>[];
}

export function readSources(host: HTMLElement): Readonly<SourceRead> {
  const sources: Readonly<Source>[] = [];
  const failures: Array<Readonly<{
    sourceIndex: number;
    attribute: "src" | "type" | "integrity";
  }>> = [];
  const children = host.children;
  let sourceIndex = 0;
  for (let index = 0; index < children.length; index += 1) {
    const element = children.item(index);
    if (element?.localName !== "source" ||
      element.namespaceURI !== "http://www.w3.org/1999/xhtml") continue;
    let src = "";
    let codec = "";
    let integrity = "";
    let valid = true;
    try { src = normalizeSource(element.getAttribute("src") ?? ""); }
    catch {
      valid = false;
      failures.push(Object.freeze({ sourceIndex, attribute: "src" }));
    }
    try {
      const type = element.getAttribute("type");
      const prefix = 'application/vnd.aval; codecs="';
      if (typeof type !== "string" || type.length > 256 || !type.startsWith(prefix) ||
        !type.endsWith('"')) throw new TypeError();
      codec = type.slice(prefix.length, -1);
      if (codec.length < 1 || codec.length > 128 || !sourceCodec(codec)) {
        throw new TypeError();
      }
    } catch {
      valid = false;
      failures.push(Object.freeze({ sourceIndex, attribute: "type" }));
    }
    try {
      const value = element.getAttribute("integrity");
      integrity = value === null ? "" : normalizeIntegrity(value);
    } catch {
      valid = false;
      failures.push(Object.freeze({ sourceIndex, attribute: "integrity" }));
    }
    if (valid) {
      sources.push(Object.freeze({ src, codec, integrity, sourceIndex }));
    }
    sourceIndex += 1;
  }
  return Object.freeze({
    sources: Object.freeze(sources),
    failures: Object.freeze(failures)
  });
}

function sourceCodec(value: string): boolean {
  if (/^avc1\.6400(?:0A|0B|0C|0D|14|15|16|1E|1F|20|28|29|2A|32|33|34|3C|3D|3E)$/u.test(value) ||
    /^vp09\.00\.(?:10|11|20|21|30|31|40|41|50|51|52|60|61|62)\.08(?:\.01\.01\.01\.01\.00)?$/u.test(value) ||
    /^av01\.0\.(?:0[0-9]|[12][0-9]|3[01])[MH]\.(?:08|10)(?:\.0\.11[0-3]\.01\.01\.01\.0)?$/u.test(value)) return true;
  const h265 = /^hvc1\.1\.(0|[1-9A-F][0-9A-F]*)\.[LH](0|[1-9][0-9]*)\.((?:[0-9A-F]{2}\.){0,5}(?!00)[0-9A-F]{2})$/u.exec(value);
  if (h265 === null) return false;
  const flags = Number.parseInt(h265[1]!, 16);
  const level = Number(h265[2]);
  const first = Number.parseInt(h265[3]!.slice(0, 2), 16);
  return flags <= 0xffff_ffff && (flags & 2) !== 0 && level >= 1 && level <= 255 &&
    (first & 0x80) !== 0 && (first & 0x40) === 0 && (first & 0x10) !== 0;
}

export function sourceMutation(
  host: HTMLElement,
  record: MutationRecord
): boolean {
  if (record.type === "childList") {
    return record.target === host &&
      [...record.addedNodes, ...record.removedNodes].some((node) =>
        node.nodeType === 1 &&
        (node as Element).localName === "source" &&
        (node as Element).namespaceURI === "http://www.w3.org/1999/xhtml"
      );
  }
  const target = record.target as Element;
  return target.localName === "source" &&
    target.namespaceURI === "http://www.w3.org/1999/xhtml" &&
    target.parentElement === host;
}

export function createCleanupReceipt(
  elementGeneration: number,
  sourceGeneration: number,
  runtime: Readonly<PlayerSnapshot> | null,
  page: Readonly<PageResourcesSnapshot>,
  retiredDeclaredFileBytes: number,
  operationFailed: boolean,
  participantDisposed: boolean,
  participantLogicalBytes: number,
  participantDecoderState: string | null,
  terminal: boolean,
  stalePublicationCount = 0
): Readonly<Record<string, unknown>> {
  const workerCount = runtime?.workerCount ?? 0;
  const openFrames = runtime?.openFrames ?? 0;
  const activeTransportBodies = runtime?.activeTransportBodies ?? 0;
  const pendingLoads = runtime?.pendingLoads ?? 0;
  const interestedWaiters = runtime?.interestedWaiters ?? 0;
  const pendingRuntimeOperations = runtime?.presentation.pendingOperations ?? 0;
  const sourceCopiesInFlight = runtime?.presentation.sourceCopiesInFlight ?? 0;
  const rendererStagingBytes = runtime?.presentation.stagingBytes ?? 0;
  const rendererResidentBytes = runtime?.presentation.residentBytes ?? 0;
  const rendererTextureBytes = runtime?.presentation.textureBytes ?? 0;
  const rendererRuntimeBytes = runtime?.presentation.runtimeBytes ?? 0;
  const rendererBackingBytes = runtime === null ? 0
    : runtime.presentation.backingWidth * runtime.presentation.backingHeight;
  const observedRendererCategories = [
    rendererBackingBytes,
    rendererStagingBytes,
    rendererResidentBytes,
    rendererTextureBytes,
    rendererRuntimeBytes
  ].filter((bytes) => bytes !== 0).length;
  const rendererResourceCount = runtime?.presentation.resourceCount ??
    (observedRendererCategories === 0 ? 0 : 1);
  const contextListenerCount = runtime?.presentation.contextListenerCount ??
    (rendererResourceCount === 0 ? 0 : 1);
  const playerDisposed = playerSnapshotDisposed(runtime);
  const participantRegistered = !participantDisposed;
  const participantActiveLeaseCount = participantDecoderState === "granted" ? 1 : 0;
  const participantDecoderTicketCount = participantDecoderState === null ? 0 : 1;
  const failureCount = [
    operationFailed,
    runtime === null,
    !playerDisposed,
    !participantDisposed,
    participantRegistered,
    participantLogicalBytes !== 0,
    participantActiveLeaseCount !== 0,
    participantDecoderTicketCount !== 0
  ].filter(Boolean).length;
  return Object.freeze({
    elementGeneration,
    sourceGeneration,
    completed: failureCount === 0,
    failureCount,
    playerDisposed,
    participantDisposed,
    participantRegistered,
    participantLogicalBytes,
    participantActiveLeaseCount,
    participantRegisteredCleanupCount: 0,
    participantTrackedWorkCount: 0,
    participantPendingWaitCount: 0,
    participantDecoderTicketCount,
    participantDecoderState,
    workerCount,
    openFrames,
    pendingRuntimeOperations,
    sourceCopiesInFlight,
    rendererStagingBytes,
    pendingLoads,
    activeTransportBodies,
    interestedWaiters,
    rendererResourceCount,
    contextListenerCount,
    stalePublicationCount,
    pagePhysicalBytes: page.physicalBytes,
    pageParticipantCount: page.participants,
    pageActiveDecoderSlotCount: page.active,
    pageQueuedDecoderTicketCount: page.queued,
    pageParkedDecoderTicketCount: page.parked,
    terminal,
    retiredDeclaredFileBytes
  });
}

export function playerSnapshotDisposed(
  runtime: Readonly<PlayerSnapshot> | null
): boolean {
  if (runtime === null) return false;
  const presentation = runtime.presentation;
  const staging = presentation.stagingBytes ?? 0;
  const resident = presentation.residentBytes ?? 0;
  const texture = presentation.textureBytes ?? 0;
  const renderer = presentation.runtimeBytes ?? 0;
  const observed = [
    presentation.backingWidth * presentation.backingHeight,
    staging,
    resident,
    texture,
    renderer
  ].some((bytes) => bytes !== 0);
  const resources = presentation.resourceCount ?? (observed ? 1 : 0);
  const listeners = presentation.contextListenerCount ?? (resources === 0 ? 0 : 1);
  return runtime.workerCount === 0 && runtime.openFrames === 0 &&
    runtime.declaredFileBytes === 0 && runtime.metadataBytes === 0 &&
    runtime.verifiedBytes === 0 && runtime.residentBlobBytes === 0 &&
    runtime.activeTransportBodies === 0 && runtime.pendingLoads === 0 &&
    runtime.interestedWaiters === 0 && (presentation.pendingOperations ?? 0) === 0 &&
    (presentation.sourceCopiesInFlight ?? 0) === 0 && presentation.backingWidth === 0 &&
    presentation.backingHeight === 0 && staging === 0 && resident === 0 &&
    texture === 0 && renderer === 0 && resources === 0 && listeners === 0;
}

export function createOwnershipSnapshot(
  terminal: boolean,
  listenerCount: number,
  observerCount: number,
  pendingCommandCount: number,
  timerCount = 0,
  failedReleaseCount = 0
): Readonly<Record<string, unknown>> {
  const completed = terminal && listenerCount === 0 && observerCount === 0 &&
    pendingCommandCount === 0 && timerCount === 0 && failedReleaseCount === 0;
  return Object.freeze({
    listenerCount,
    observerCount,
    brokerSubscriptionCount: 0,
    timerCount,
    pendingCommandCount,
    failedReleaseCount,
    retainedRetryCount: failedReleaseCount,
    releaseFailureCount: failedReleaseCount,
    completed
  });
}

export function proveRetirement(
  disposed: boolean,
  receipt: Readonly<Record<string, unknown>>
): boolean {
  if (!disposed) return false;
  if (receipt.completed !== true) throw new ElementCleanupIncompleteError();
  return true;
}

export function resumeCurrent(
  expectedSequence: number,
  currentSequence: number,
  manualPlaying: boolean,
  effectivelyVisible: boolean,
  expectedPlayer: object,
  currentPlayer: object | null,
  suspendedPlayer: object | null,
  suspendingPlayer: object | null
): boolean {
  return expectedSequence === currentSequence && manualPlaying &&
    effectivelyVisible && expectedPlayer === currentPlayer &&
    expectedPlayer !== suspendedPlayer && expectedPlayer !== suspendingPlayer;
}

export function transitioningState(
  current: boolean,
  type: string,
  detail: Readonly<Record<string, unknown>>
): boolean {
  if (typeof detail.isTransitioning === "boolean") return detail.isTransitioning;
  if (type === "transitionstart") return true;
  if (type === "transitionend") return false;
  return current;
}

export function intrinsicRatio(
  width: number | null,
  height: number | null,
  canvas: Readonly<Metadata["canvas"]> | undefined
): number | null {
  if (width !== null && height !== null) return width / height;
  if (canvas === undefined) return null;
  return canvas.width * canvas.pixelAspect[0] /
    canvas.pixelAspect[1] / canvas.height;
}

function freezeAvalDecoderDiagnostic(
  diagnostic: Readonly<PlayerDecoderDiagnostic>,
  sourceGeneration: number
): Readonly<AvalDecoderDiagnostic> {
  const firstFrame = diagnostic.firstFrame === null
    ? null
    : Object.freeze({
        ...diagnostic.firstFrame,
        visibleRect: diagnostic.firstFrame.visibleRect === null
          ? null
          : Object.freeze({ ...diagnostic.firstFrame.visibleRect }),
        colorSpace: diagnostic.firstFrame.colorSpace === null
          ? null
          : Object.freeze([...diagnostic.firstFrame.colorSpace]) as readonly [
              string | null,
              string | null,
              string | null,
              boolean | null
            ]
      });
  return Object.freeze({
    ...diagnostic,
    sourceGeneration,
    exception: diagnostic.exception === null
      ? null
      : Object.freeze({ ...diagnostic.exception }),
    firstFrame
  }) satisfies Readonly<AvalDecoderDiagnostic>;
}

function emptyRuntime(): PlayerSnapshot {
  return Object.freeze({
    requestedState: null,
    visualState: null,
    transitioning: false,
    selectedRendition: null,
    selectedCodec: null,
    selectedBitDepth: null,
    transportMode: null,
    declaredFileBytes: 0,
    metadataBytes: 0,
    verifiedBytes: 0,
    residentBlobBytes: 0,
    activeTransportBodies: 0,
    pendingLoads: 0,
    interestedWaiters: 0,
    workerCount: 0,
    openFrames: 0,
    contextLossCount: 0,
    contextRecoveryCount: 0,
    cleanupFailureCount: 0,
    decoderDiagnostics: Object.freeze([]),
    presentation: Object.freeze({
      cssWidth: 0,
      cssHeight: 0,
      backingWidth: 0,
      backingHeight: 0,
      effectiveDprX: 0,
      effectiveDprY: 0
    }),
    trace: Object.freeze([])
  });
}

function remainingPreparationMs(
  deadline: number,
  clock: Performance,
  timing: ElementTiming
): number {
  const remaining = Math.floor(deadline - clock.now());
  if (remaining < 1) throw timing.timeoutError();
  return remaining;
}

function withLimits<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  timeoutMs?: number,
  timerChanged?: (delta: 1 | -1) => void,
  timing?: ElementTiming
): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) {
    return Promise.reject(new RangeError("timeoutMs must be a positive integer"));
  }
  if (signal === undefined && timeoutMs === undefined) return operation;
  if (timing === undefined && timeoutMs !== undefined) {
    return Promise.reject(new AvalNotReadyError("AVAL owner window is unavailable"));
  }
  return new Promise<T>((resolve, reject) => {
    let timer: number | null = null;
    let settled = false;
    const cleanup = (): void => {
      signal?.removeEventListener("abort", abort);
      if (timer !== null) {
        timing!.clearTimeout(timer);
        timer = null;
        timerChanged?.(-1);
      }
    };
    const resolveOnce = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (reason: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(reason);
    };
    const abort = (): void => rejectOnce(
      signal?.reason ?? timing?.abortError() ?? abortError()
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (timeoutMs !== undefined) {
      timer = timing!.setTimeout(() => rejectOnce(timing!.timeoutError()), timeoutMs);
      timerChanged?.(1);
    }
    operation.then(resolveOnce, rejectOnce);
  });
}

function abortError(): Error {
  return new DOMException("AVAL operation was aborted", "AbortError");
}

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "name" in error && error.name === "AbortError";
}

function isPreparationTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "name" in error && error.name === "TimeoutError";
}
