import type {
  IntegratedPlayerParticipantBinding,
  IntegratedPlayerParticipantConnection,
  IntegratedPlayerParticipantSnapshot,
  IntegratedPlayerParticipantStatusUpdate
} from "./integrated-player-participant.js";
import type {
  RuntimeParticipantPhase,
  RuntimeReadinessResult,
  RuntimeVisibilityState
} from "./model.js";

interface CapturedParticipantConnection {
  readonly update: (
    status: Readonly<IntegratedPlayerParticipantStatusUpdate>
  ) => Readonly<IntegratedPlayerParticipantSnapshot>;
  readonly touch: () => void;
  readonly snapshot: () => Readonly<IntegratedPlayerParticipantSnapshot>;
  readonly dispose: () => void;
}

/** Player-side status adapter; the page account remains externally owned. */
export class IntegratedPlayerParticipantController {
  readonly #connection: CapturedParticipantConnection | null;
  #visibility: RuntimeVisibilityState;
  #phase: RuntimeParticipantPhase = "loading";
  #eligible = true;

  public constructor(options: Readonly<{
    readonly binding?: IntegratedPlayerParticipantBinding;
    readonly initialVisibility: RuntimeVisibilityState;
    readonly onDecoderGrant: () => boolean | void;
  }>) {
    this.#visibility = options.initialVisibility;
    this.#connection = options.binding === undefined
      ? null
      : captureConnection(options.binding, options.onDecoderGrant);
    try {
      this.#publish();
    } catch (error) {
      try { this.#connection?.dispose(); } catch {}
      throw error;
    }
  }

  public markLoading(): void { this.#setPhase("loading"); }
  public markPreparing(): void { this.#setPhase("preparing"); }
  public markAnimated(): void { this.#setPhase("animated"); }

  public markReady(result: Readonly<RuntimeReadinessResult>): void {
    this.#setPhase(result.mode === "animated"
      ? "animated"
      : this.#visibility === "hidden" ||
        result.reason === "visibility-suspended"
      ? "suspended"
      : "static");
  }

  public setVisibility(visibility: RuntimeVisibilityState): void {
    this.#visibility = visibility;
    if (visibility === "visible" && this.#phase === "suspended") {
      this.#phase = "static";
    }
    this.#publish();
  }

  public setEligible(eligible: boolean): void {
    this.#eligible = eligible;
    this.#publish();
  }

  public touch(): void { this.#connection?.touch(); }
  public snapshot(): Readonly<IntegratedPlayerParticipantSnapshot> | null {
    return this.#connection?.snapshot() ?? null;
  }
  public dispose(): void { this.#connection?.dispose(); }

  #setPhase(phase: RuntimeParticipantPhase): void {
    this.#phase = phase;
    this.#publish();
  }

  #publish(): void {
    this.#connection?.update({
      visibility: this.#visibility,
      phase: this.#phase,
      eligible: this.#eligible
    });
  }
}

function captureConnection(
  binding: IntegratedPlayerParticipantBinding,
  onDecoderGrant: () => boolean | void
): CapturedParticipantConnection {
  if (binding === null || typeof binding !== "object") {
    throw new TypeError("integrated participant binding must be an object");
  }
  let attach: unknown;
  try { attach = Reflect.get(binding, "attach"); } catch {
    throw new TypeError("integrated participant binding is inaccessible");
  }
  if (typeof attach !== "function") {
    throw new TypeError("integrated participant binding is malformed");
  }
  const raw = Reflect.apply(attach, binding, [{ onDecoderGrant }]) as
    IntegratedPlayerParticipantConnection;
  if (raw === null || typeof raw !== "object") {
    throw new TypeError("integrated participant connection is unavailable");
  }
  let update: unknown;
  let touch: unknown;
  let snapshot: unknown;
  let dispose: unknown;
  try {
    update = Reflect.get(raw, "update");
    touch = Reflect.get(raw, "touch");
    snapshot = Reflect.get(raw, "snapshot");
    dispose = Reflect.get(raw, "dispose");
  } catch {
    throw new TypeError("integrated participant connection is inaccessible");
  }
  if (
    typeof update !== "function" || typeof touch !== "function" ||
    typeof snapshot !== "function" || typeof dispose !== "function"
  ) {
    throw new TypeError("integrated participant connection is malformed");
  }
  return Object.freeze({
    update: (status: Readonly<IntegratedPlayerParticipantStatusUpdate>) =>
      Reflect.apply(update, raw, [status]) as
        Readonly<IntegratedPlayerParticipantSnapshot>,
    touch: () => { Reflect.apply(touch, raw, []); },
    snapshot: () => Reflect.apply(snapshot, raw, []) as
      Readonly<IntegratedPlayerParticipantSnapshot>,
    dispose: () => { Reflect.apply(dispose, raw, []); }
  });
}
