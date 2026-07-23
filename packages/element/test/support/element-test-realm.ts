const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
let currentDocument: FakeDocument;

export function createElementTestRealm(): Readonly<{
  document: FakeDocument;
  view: FakeWindow;
}> {
  const view = new FakeWindow();
  const document = new FakeDocument(view);
  currentDocument = document;
  view.document = document;
  return Object.freeze({ document, view });
}

export class FakeHTMLElement extends EventTarget {
  public readonly ownerDocument = currentDocument;
  public readonly childElements: FakeElement[] = [];
  public readonly attributes = new Map<string, string>();
  public readonly localName = "aval-player";
  public readonly namespaceURI = HTML_NAMESPACE;
  public readonly nodeType = 1;
  public isConnected = false;
  readonly #root = new FakeShadowRoot(this.ownerDocument);

  public get children(): HTMLCollection {
    return {
      length: this.childElements.length,
      item: (index: number) => this.childElements[index] ?? null
    } as unknown as HTMLCollection;
  }

  public attachShadow(): ShadowRoot {
    return this.#root as unknown as ShadowRoot;
  }
  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  public removeAttribute(name: string): void { this.attributes.delete(name); }
  public getBoundingClientRect(): DOMRect {
    return { width: 16, height: 16 } as DOMRect;
  }
  public matches(_selector: string): boolean { return false; }
  public contains(node: unknown): boolean { return node === this; }
  public getRootNode(): Document {
    return this.ownerDocument as unknown as Document;
  }
  public blur(): void {
    if (this.ownerDocument.activeElement !== this as unknown as Element) return;
    this.ownerDocument.activeElement = null;
    this.dispatchEvent(new Event("focusout"));
  }
}

export class FakeElement extends EventTarget {
  public readonly nodeType = 1;
  public readonly namespaceURI = HTML_NAMESPACE;
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

  public getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null;
  }
  public setAttribute(name: string, value: string): void {
    this.#attributes.set(name, value);
  }
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

export class FakeMutationObserver {
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

export class FakeIntersectionObserver {
  public static readonly instances: FakeIntersectionObserver[] = [];
  public static deferObservation = false;
  #target: Element | null = null;
  public constructor(readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }
  public observe(target: Element): void {
    this.#target = target;
    if (FakeIntersectionObserver.deferObservation) return;
    this.emit();
  }
  public emit(isIntersecting = true): void {
    const target = this.#target;
    if (target === null) return;
    this.callback([{
      target,
      isIntersecting,
      intersectionRatio: isIntersecting ? 1 : 0
    } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  public disconnect(): void {}
}

export class FakeWindow extends EventTarget {
  public document!: FakeDocument;
  public readonly MutationObserver = FakeMutationObserver;
  public readonly IntersectionObserver = FakeIntersectionObserver;
  public readonly CSSStyleSheet = FakeCSSStyleSheet;
  public readonly CSSStyleRule = FakeCSSStyleRule;
  public readonly CustomEvent = FakeCustomEvent;
  public readonly DOMException = globalThis.DOMException;
  public readonly Element = FakeHTMLElement;
  public readonly Worker = class {};
  public readonly VideoDecoder = class {};
  public readonly VideoFrame = class {};
  public readonly isSecureContext = true;
  public readonly crypto = {
    subtle: { digest: () => Promise.resolve(new ArrayBuffer(32)) }
  } as unknown as Crypto;
  public readonly performance = globalThis.performance;
  public readonly devicePixelRatio = 1;
  public readonly fetch = async (): Promise<Response> => ({} as Response);
  public readonly requestAnimationFrame = (_callback: FrameRequestCallback): number => 1;
  public readonly cancelAnimationFrame = (_handle: number): void => undefined;
  public readonly setTimeout = (callback: () => void, delay: number): number =>
    globalThis.setTimeout(callback, delay) as unknown as number;
  public readonly clearTimeout = (handle: number): void => {
    globalThis.clearTimeout(handle);
  };
  public readonly media = new FakeMediaQueryList();
  public readonly matchMedia = (): MediaQueryList => this.media as MediaQueryList;
}

class FakeMediaQueryList extends EventTarget {
  public matches = false;
  public readonly media = "(prefers-reduced-motion: reduce)";
  public onchange: (
    (this: MediaQueryList, event: MediaQueryListEvent) => unknown
  ) | null = null;
  public addListener(): void {}
  public removeListener(): void {}
  public dispatch(value: boolean): void {
    this.matches = value;
    this.dispatchEvent(new Event("change"));
  }
}

export class FakeDocument extends EventTarget {
  public visibilityState: DocumentVisibilityState = "visible";
  public activeElement: Element | null = null;
  public readonly baseURI = "https://example.test/";
  public readonly inputListenerOperations: string[] = [];
  public constructor(public readonly defaultView: FakeWindow) { super(); }
  public override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ): void {
    if (type === "pointerdown" || type === "pointerup") {
      this.inputListenerOperations.push(`add:${type}:${String(capture(options))}`);
    }
    super.addEventListener(type, callback, options);
  }
  public override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions
  ): void {
    if (type === "pointerdown" || type === "pointerup") {
      this.inputListenerOperations.push(`remove:${type}:${String(capture(options))}`);
    }
    super.removeEventListener(type, callback, options);
  }
  public createElement(localName: string): FakeElement {
    return new FakeElement(localName, this);
  }
}

function capture(options?: boolean | EventListenerOptions): boolean {
  return typeof options === "boolean" ? options : options?.capture === true;
}
