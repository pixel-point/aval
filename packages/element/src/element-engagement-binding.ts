export type EngagementBindingSource = "engagement.on" | "engagement.off";
export type EngagementBindingResult = boolean | null;

/** Reconciles the current hover/focus level when its authored event is busy. */
export class ElementEngagementBinding {
  readonly #send: (source: EngagementBindingSource) => EngagementBindingResult;
  #desired: boolean | null = null;
  #pending = false;

  public constructor(
    send: (source: EngagementBindingSource) => EngagementBindingResult
  ) {
    this.#send = send;
  }

  public update(engaged: boolean, force = false): void {
    if (!force && this.#desired === engaged) return;
    this.#desired = engaged;
    this.#pending = this.#send(sourceFor(engaged)) === false;
  }

  public retry(current: boolean): void {
    if (!this.#pending || this.#desired !== current) return;
    this.#pending = this.#send(sourceFor(current)) === false;
  }

  public reset(): void {
    this.#desired = null;
    this.#pending = false;
  }
}

function sourceFor(engaged: boolean): EngagementBindingSource {
  return engaged ? "engagement.on" : "engagement.off";
}
