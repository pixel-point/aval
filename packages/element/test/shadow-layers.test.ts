import { describe, expect, it } from "vitest";

import { ShadowLayerOwner } from "../src/shadow-layers.js";

describe("ShadowLayerOwner", () => {
  it("owns only the animated canvas and never creates a consumer fallback slot", () => {
    const document = new FakeDocument();
    const host = new FakeHost(document);

    const owner = new ShadowLayerOwner(
      host as unknown as HTMLElement,
      document as unknown as Document
    );

    expect(host.root.children.map((child) => child.localName)).toEqual(["canvas"]);
    expect(owner).not.toHaveProperty("fallback");
    expect(owner.animatedCanvas).toBe(host.root.children[0]);
  });
});

class FakeHost {
  public readonly root: FakeShadowRoot;

  public constructor(public readonly ownerDocument: FakeDocument) {
    this.root = new FakeShadowRoot(ownerDocument);
  }

  public attachShadow(): ShadowRoot {
    return this.root as unknown as ShadowRoot;
  }
}

class FakeShadowRoot {
  public adoptedStyleSheets: FakeCSSStyleSheet[] = [];
  public readonly children: FakeNode[] = [];

  public constructor(public readonly ownerDocument: FakeDocument) {}

  public append(...nodes: FakeNode[]): void {
    this.children.push(...nodes);
  }
}

class FakeNode {
  public readonly dataset: Record<string, string> = {};
  public hidden = false;
  public tabIndex = 0;
  public width = 0;
  public height = 0;
  readonly #attributes = new Map<string, string>();

  public constructor(public readonly localName: string) {}

  public setAttribute(name: string, value: string): void {
    this.#attributes.set(name, value);
  }
}

class FakeCSSStyleRule {
  public readonly style = { setProperty: () => undefined };
}

class FakeCSSStyleSheet {
  public readonly cssRules = { item: () => new FakeCSSStyleRule() };
  public replaceSync(_css: string): void {}
}

class FakeDocument {
  public readonly defaultView = {
    CSSStyleSheet: FakeCSSStyleSheet,
    CSSStyleRule: FakeCSSStyleRule
  };

  public createElement(localName: string): FakeNode {
    return new FakeNode(localName);
  }
}
