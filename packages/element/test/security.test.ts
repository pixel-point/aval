import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
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
        "data-codec": "mpeg2",
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
      { sourceIndex: 0, attribute: "data-codec" },
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
    const files = await productionTypescriptFiles(root);
    const source = (await Promise.all(files.map((file) =>
      readFile(file, "utf8")
    ))).join("\n");
    expect(files.length).toBeGreaterThan(50);
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

async function productionTypescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionTypescriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  }));
  return files.flat().sort();
}
