import { createAvalAlpha } from "./player.js";
import { sourceFromElement } from "./source.js";
import { AvalAlphaError, type AlphaPlayer, type AlphaSource } from "./types.js";

export interface AvalAlphaElement extends HTMLElement {
  readonly ready: Promise<void>;
  readonly video: HTMLVideoElement | undefined;
  sources: readonly AlphaSource[] | undefined;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): Promise<void>;
}

/** Explicit registration; importing this module is safe during SSR. */
export function defineAvalAlphaElement(registry: CustomElementRegistry = customElements): void {
  if (registry.get("aval-alpha")) return;
  registry.define("aval-alpha", class extends HTMLElement implements AvalAlphaElement {
    static observedAttributes = ["autoplay", "loop", "crossorigin"];
    #player: AlphaPlayer | undefined;
    #sources: readonly AlphaSource[] | undefined;
    #queued = false;
    #canvas: HTMLCanvasElement;
    #observer: MutationObserver;
    constructor() {
      super();
      const root = this.attachShadow({ mode: "open" });
      root.innerHTML = `<style>:host{display:inline-block;position:relative}canvas{display:block;width:100%;height:100%;object-fit:contain}</style><canvas part="canvas"></canvas>`;
      this.#canvas = root.lastChild as HTMLCanvasElement;
      this.#observer = new MutationObserver(() => this.#queue());
    }
    get sources() { return this.#sources; }
    set sources(value: readonly AlphaSource[] | undefined) { this.#sources = value; this.#queue(); }
    get video() { return this.#player?.video; }
    get ready(): Promise<void> { return this.#readyPlayer().then(() => {}); }
    async play() { await (await this.#readyPlayer()).play(); }
    pause() { this.#player?.pause(); }
    async seek(seconds: number) { await (await this.#readyPlayer()).seek(seconds); }
    async #readyPlayer() {
      // Bind the command before yielding, including DOM edits awaiting observation.
      if (this.#observer.takeRecords().length || this.#queued || !this.#player) this.#load();
      const player = this.#player;
      await player?.ready;
      if (!player || this.#player !== player) throw new AvalAlphaError("disposed", "Player was disposed");
      return player;
    }
    connectedCallback() {
      if (Object.hasOwn(this, "sources")) {
        const sources = this.sources;
        delete (this as Partial<AvalAlphaElement>).sources;
        this.sources = sources;
      }
      this.#observer.observe(this, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "type", "data-layout"] });
      this.#queue();
    }
    disconnectedCallback() { this.#queued = false; this.#observer.disconnect(); this.#player?.destroy(); this.#player = undefined; }
    attributeChangedCallback(name: string, before: string | null, after: string | null) {
      if (before === after || !this.#player) return;
      if (name === "loop") this.#player.video.loop = this.hasAttribute("loop");
      else if (name === "crossorigin") this.#queue();
      else if (this.#player.source) this.#autoplay(this.#player);
    }
    #queue() {
      if (this.#queued) return;
      this.#queued = true;
      queueMicrotask(() => {
        if (this.#queued) {
          try { this.#load(); } catch (error) { this.#event("error", error); }
        }
      });
    }
    #event(name: string, detail?: unknown) { this.dispatchEvent(new CustomEvent(name, { detail })); }
    #autoplay(player: AlphaPlayer) {
      if (this.hasAttribute("autoplay")) void player.play().catch((error: Error) => {
        if (this.#player === player) this.#event(error?.name === "NotAllowedError" ? "autoplayblocked" : "error", error);
      });
    }
    #load() {
      if (!this.isConnected) return;
      this.#queued = false;
      this.#player?.destroy();
      this.#player = undefined;
      const sources = this.#sources ?? Array.from(this.children)
        .filter((element): element is HTMLSourceElement => element.localName === "source")
        .map(sourceFromElement);
      const player = createAvalAlpha(this.#canvas, {
        sources, loop: this.hasAttribute("loop"),
        crossOrigin: this.getAttribute("crossorigin") === "use-credentials" ? "use-credentials" : "anonymous",
        onError: (error) => this.#event("error", error)
      });
      this.#player = player;
      void player.ready.then(() => {
        if (this.#player === player) { this.#event("ready"); this.#autoplay(player); }
      }, () => {});
    }
  });
}
