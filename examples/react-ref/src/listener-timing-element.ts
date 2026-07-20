const TAG_NAME = "aval-player";

export function defineAvalElement(): CustomElementConstructor {
  const existing = customElements.get(TAG_NAME);
  if (existing !== undefined) return existing;

  class ListenerTimingElement extends HTMLElement {
    public readiness = "unready";

    public connectedCallback(): void {
      queueMicrotask(() => {
        if (!this.isConnected) return;
        this.readiness = "error";
        this.dispatchEvent(new CustomEvent("error", {
          detail: {
            fatal: true,
            failure: { code: "forced-early-fatal" }
          }
        }));
      });
    }
  }

  customElements.define(TAG_NAME, ListenerTimingElement);
  return ListenerTimingElement;
}
