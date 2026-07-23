import type {
  AvalDiagnostics,
  AvalElement,
  AvalErrorDetail,
  AvalRequestedStateChangeDetail,
  AvalSnapshot,
  AvalTransitionDetail,
  AvalVisualStateChangeDetail,
  RuntimeReadinessResult
} from "@pixel-point/aval-element";

export const AVAL_TAG_NAME = "aval-player" as const;
export const SOURCE_CODEC_PRIORITY = Object.freeze([
  "av1",
  "vp9",
  "h265",
  "h264"
] as const);

type FakeAvalElementPort = Pick<
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
  | "dispose"
>;

export interface FakeAvalElementHandle extends HTMLElement {
  readonly automaticDisposeCount: number;
  readonly prepareAbortCount: number;
  readonly snapshotSubscriberCount: number;
  readonly interactionTarget: Element | null;
  preparationCountForSource(source: string): number;
  resolvePreparationsForSource(source: string): number;
}

interface PendingPreparation {
  readonly source: string | null;
  readonly resolve: (result: RuntimeReadinessResult) => void;
  settled: boolean;
}

const EMPTY_STRINGS: readonly string[] = Object.freeze([]);
const EMPTY_BINDINGS: AvalSnapshot["inputBindings"] = Object.freeze([]);
const READY_RESULT: RuntimeReadinessResult = Object.freeze({
  mode: "animated",
  assurance: "best-effort",
  report: Object.freeze({
    readiness: "interactiveReady",
    selectedRendition: null,
    candidates: Object.freeze([])
  })
});

export class AvalNotReadyError extends Error {
  public constructor(message = "aval-player is not ready") {
    super(message);
    this.name = "NotReadyError";
  }
}

export function defineAvalElement(): CustomElementConstructor {
  const existing = customElements.get(AVAL_TAG_NAME);
  if (existing !== undefined) return existing;

  const visualDetail = Object.freeze({
    generation: 0,
    from: "before-definition",
    to: "listener-installed"
  }) satisfies Readonly<AvalVisualStateChangeDetail>;
  document.querySelector(AVAL_TAG_NAME)?.dispatchEvent(
    new CustomEvent<Readonly<AvalVisualStateChangeDetail>>(
      "visualstatechange",
      { detail: visualDetail }
    )
  );

  class ListenerTimingElement extends HTMLElement
    implements FakeAvalElementPort, FakeAvalElementHandle {
    public automaticDisposeCount = 0;
    public prepareAbortCount = 0;
    public interactionTarget: Element | null = null;

    readonly #listeners = new Set<() => void>();
    readonly #preparations: PendingPreparation[] = [];
    #revision = 0;
    #preparedSource: string | null = null;
    #readiness: AvalSnapshot["readiness"] = "unready";
    #requestedState: string | null = null;
    #visualState: string | null = null;
    #paused = false;
    #lastError: Readonly<AvalErrorDetail> | null = null;
    #snapshot: Readonly<AvalSnapshot> = this.#createSnapshot(false);

    public connectedCallback(): void {
      this.#publish(true);
      queueMicrotask(() => {
        if (!this.isConnected) return;

        const errorDetail = Object.freeze({
          generation: 1,
          fatal: true,
          failure: Object.freeze({
            code: "readiness-failure",
            message: "forced early fatal",
            operation: "listener-timing"
          })
        }) satisfies Readonly<AvalErrorDetail>;
        this.#readiness = "error";
        this.#lastError = errorDetail;
        this.#publish(true);

        const requestedDetail = Object.freeze({
          generation: 1,
          from: "idle",
          to: "active",
          sequence: 1
        }) satisfies Readonly<AvalRequestedStateChangeDetail>;
        this.dispatchEvent(new CustomEvent<Readonly<AvalRequestedStateChangeDetail>>(
          "requestedstatechange",
          { detail: requestedDetail }
        ));

        const transitionDetail = Object.freeze({
          generation: 1,
          edge: "idle-to-active",
          from: "idle",
          to: "active",
          sequence: 1
        }) satisfies Readonly<AvalTransitionDetail>;
        this.dispatchEvent(new CustomEvent<Readonly<AvalTransitionDetail>>(
          "transitionstart",
          { detail: transitionDetail }
        ));
        this.dispatchEvent(new CustomEvent<Readonly<AvalTransitionDetail>>(
          "transitionend",
          { detail: transitionDetail }
        ));
        this.dispatchEvent(new CustomEvent<Readonly<AvalErrorDetail>>(
          "error",
          { detail: errorDetail }
        ));
      });
    }

    public disconnectedCallback(): void {
      this.#publish(false);
    }

    public get snapshotSubscriberCount(): number {
      return this.#listeners.size;
    }

    public getSnapshot(): Readonly<AvalSnapshot> {
      return this.#snapshot;
    }

    public subscribe(listener: () => void): () => void {
      this.#listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        this.#listeners.delete(listener);
      };
    }

    public prepare(
      options?: Readonly<{ readonly signal?: AbortSignal; readonly timeoutMs?: number }>
    ): Promise<RuntimeReadinessResult> {
      const source = this.querySelector("source")?.getAttribute("src") ?? null;
      if (this.#preparedSource !== null && source !== this.#preparedSource) {
        this.#readiness = "unready";
        this.#lastError = null;
        this.#publish(this.isConnected);
      }
      this.#preparedSource = source;

      return new Promise<RuntimeReadinessResult>((resolve) => {
        this.#preparations.push({ source, resolve, settled: false });
        options?.signal?.addEventListener("abort", () => {
          this.prepareAbortCount += 1;
        }, { once: true });
      });
    }

    public preparationCountForSource(source: string): number {
      return this.#preparations.filter((entry) => (
        entry.source === source && !entry.settled
      )).length;
    }

    public resolvePreparationsForSource(source: string): number {
      let resolved = 0;
      for (const preparation of this.#preparations) {
        if (preparation.source !== source || preparation.settled) continue;
        preparation.settled = true;
        preparation.resolve(READY_RESULT);
        resolved += 1;
      }
      return resolved;
    }

    public async setState(state: string): Promise<void> {
      this.#requestedState = state;
      this.#visualState = state;
      this.#publish(this.isConnected);
    }

    public send(): boolean { return false; }
    public readyFor(): boolean { return false; }

    public pause(): void {
      this.#paused = true;
      this.#publish(this.isConnected);
    }

    public async resume(): Promise<void> {
      this.#paused = false;
      this.#publish(this.isConnected);
    }

    public getDiagnostics(
      _options?: Readonly<{ readonly trace?: boolean }>
    ): Readonly<AvalDiagnostics> {
      throw new Error("Diagnostics are outside the listener timing fixture");
    }

    public async dispose(): Promise<void> {
      this.automaticDisposeCount += 1;
    }

    #publish(connected: boolean): void {
      this.#revision += 1;
      this.#snapshot = this.#createSnapshot(connected);
      for (const listener of [...this.#listeners]) listener();
    }

    #createSnapshot(connected: boolean): Readonly<AvalSnapshot> {
      return Object.freeze({
        revision: this.#revision,
        generation: 1,
        connected,
        readiness: this.#readiness,
        mode: null,
        assurance: null,
        staticReason: null,
        requestedState: this.#requestedState,
        visualState: this.#visualState,
        isTransitioning: false,
        paused: this.#paused,
        effectivelyVisible: connected,
        stateNames: EMPTY_STRINGS,
        eventNames: EMPTY_STRINGS,
        inputBindings: EMPTY_BINDINGS,
        lastError: this.#lastError
      });
    }
  }

  customElements.define(AVAL_TAG_NAME, ListenerTimingElement);
  return ListenerTimingElement;
}
