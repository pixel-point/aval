import { AVAL_SHADOW_STYLE } from "./shadow-style.js";

export class ShadowLayerOwner {
  public readonly root: ShadowRoot;
  public readonly animatedCanvas: HTMLCanvasElement;

  #hostRule: CSSStyleRule | null = null;
  #stylesSupported = false;
  #intrinsic = Object.freeze({
    aspectRatio: null as number | null,
    width: null as number | null,
    height: null as number | null
  });
  #sourceGeneration = 0;
  #animatedDrawn = false;
  #disposed = false;
  #disposeComplete = false;

  public constructor(host: HTMLElement, document: Document = host.ownerDocument) {
    this.root = host.attachShadow({ mode: "open" });
    this.animatedCanvas = this.#createCanvas();
    this.animatedCanvas.hidden = true;
    this.root.append(this.animatedCanvas);
    this.rebindStyles(document);
  }

  public get stylesSupported(): boolean {
    return this.#stylesSupported;
  }

  public rebindStyles(document: Document): boolean {
    this.#hostRule = null;
    this.#stylesSupported = false;
    try { this.root.adoptedStyleSheets = []; } catch { /* feature check follows */ }
    const Constructor = document.defaultView?.CSSStyleSheet;
    if (
      Constructor === undefined ||
      !("adoptedStyleSheets" in this.root) ||
      typeof Constructor.prototype.replaceSync !== "function"
    ) return false;
    try {
      const sheet = new Constructor();
      sheet.replaceSync(AVAL_SHADOW_STYLE);
      const rule = sheet.cssRules.item(0);
      if (!(rule instanceof document.defaultView!.CSSStyleRule)) return false;
      this.root.adoptedStyleSheets = [sheet];
      this.#hostRule = rule;
      this.#stylesSupported = true;
      if (!this.#applyIntrinsicSize()) return false;
      return true;
    } catch {
      try { this.root.adoptedStyleSheets = []; } catch { /* unsupported realm */ }
      return false;
    }
  }

  public setIntrinsicSize(input: Readonly<{
    aspectRatio: number | null;
    width: number | null;
    height: number | null;
  }>): boolean {
    if (
      !validOptionalDimension(input.aspectRatio) ||
      !validOptionalDimension(input.width) ||
      !validOptionalDimension(input.height)
    ) {
      this.#disableStyles();
      return false;
    }
    this.#intrinsic = Object.freeze({ ...input });
    return this.#applyIntrinsicSize();
  }

  public resetSource(generation: number): void {
    this.#throwIfDisposed();
    this.#sourceGeneration = requireGeneration(generation);
    this.#animatedDrawn = false;
    this.animatedCanvas.hidden = true;
  }

  public markAnimatedDrawn(generation: number): void {
    this.#assertCurrent(generation);
    this.#animatedDrawn = true;
  }

  public revealAnimated(generation: number): void {
    this.#assertCurrent(generation);
    if (!this.#animatedDrawn) {
      throw new Error("animated presentation cannot be revealed before draw");
    }
    this.animatedCanvas.hidden = false;
  }

  public dispose(): boolean {
    if (this.#disposeComplete) return true;
    this.#disposed = true;
    this.#animatedDrawn = false;
    let complete = true;
    const attempt = (operation: () => void): void => {
      try { operation(); } catch { complete = false; }
    };
    attempt(() => { this.animatedCanvas.hidden = true; });
    attempt(() => { this.animatedCanvas.width = 0; });
    attempt(() => { this.animatedCanvas.height = 0; });
    this.#disposeComplete = complete;
    return complete;
  }

  #createCanvas(): HTMLCanvasElement {
    const canvas = this.root.ownerDocument.createElement("canvas");
    canvas.dataset.avalLayer = "animated";
    canvas.setAttribute("aria-hidden", "true");
    canvas.tabIndex = -1;
    return canvas;
  }

  #applyIntrinsicSize(): boolean {
    const style = this.#hostRule?.style;
    if (style === undefined) return false;
    try {
      style.setProperty(
        "aspect-ratio",
        this.#intrinsic.aspectRatio === null
          ? "auto"
          : String(this.#intrinsic.aspectRatio)
      );
      style.setProperty(
        "inline-size",
        this.#intrinsic.width === null ? "auto" : `${String(this.#intrinsic.width)}px`
      );
      style.setProperty(
        "block-size",
        this.#intrinsic.height === null ? "auto" : `${String(this.#intrinsic.height)}px`
      );
      return true;
    } catch {
      this.#disableStyles();
      return false;
    }
  }

  #disableStyles(): void {
    this.#hostRule = null;
    this.#stylesSupported = false;
    try { this.root.adoptedStyleSheets = []; } catch { /* unsupported realm */ }
  }

  #assertCurrent(generation: number): void {
    this.#throwIfDisposed();
    if (requireGeneration(generation) !== this.#sourceGeneration) {
      throw new Error("stale presentation generation");
    }
  }

  #throwIfDisposed(): void {
    if (this.#disposed) throw new Error("presentation layers are disposed");
  }
}

function validOptionalDimension(value: number | null): boolean {
  return value === null || (Number.isFinite(value) && value > 0);
}

function requireGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("presentation generation must be a positive integer");
  }
  return value;
}
