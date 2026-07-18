import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  publicFailureCode,
  readSources
} from "../src/aval-element.js";

describe("element trust boundary", () => {
  it("never copies secret transport data into source failures", () => {
    const secret = "https://user:password@example.test/private.avl?token=SECRET";
    const source = {
      nodeType: 1,
      localName: "source",
      namespaceURI: "http://www.w3.org/1999/xhtml",
      parentElement: null,
      getAttribute: (name: string) => ({
        src: secret,
        type: "video/mp4",
        integrity: "sha256-secret"
      })[name] ?? null
    } as unknown as Element;
    const read = readSources({
      children: {
        length: 1,
        item: () => source
      } as unknown as HTMLCollection
    } as HTMLElement);
    expect(read.sources).toEqual([]);
    expect(read.failures).toEqual([
      { sourceIndex: 0, attribute: "type" },
      { sourceIndex: 0, attribute: "integrity" }
    ]);
    expect(JSON.stringify(read.failures)).not.toContain("SECRET");
    expect(JSON.stringify(read.failures)).not.toContain("password");
    expect(Object.isFrozen(read.failures)).toBe(true);
  });

  it("publishes only documented public failure codes", () => {
    expect(publicFailureCode("load-failure")).toBe("load-failure");
    expect(publicFailureCode("worker-decode-failure")).toBe("worker-decode-failure");
    expect(publicFailureCode("renderer-failure")).toBe("renderer-failure");
  });

  it("does not use generated markup, dynamic code, video seeking, or console hooks", async () => {
    const root = resolve(process.cwd(), "packages/element/src");
    const files = [
      "aval-element.ts",
      "player.ts",
      "decoder.ts",
      "decoder-worker.ts",
      "renderer.ts",
      "shadow-layers.ts",
      "shadow-style.ts"
    ];
    const source = (await Promise.all(files.map((file) =>
      readFile(resolve(root, file), "utf8")
    ))).join("\n");
    for (const prohibited of [
      "innerHTML",
      "insertAdjacentHTML",
      "eval(",
      "new Function",
      "new Blob",
      "console.",
      "currentTime",
      "HTMLVideoElement"
    ]) expect(source).not.toContain(prohibited);
  });
});
