import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("accessibility contract", () => {
  it("does not inject control semantics or keyboard activation", async () => {
    const root = resolve(process.cwd(), "packages/element/src");
    const source = (await Promise.all([
      "aval-element.ts",
      "shadow-layers.ts"
    ].map((file) => readFile(resolve(root, file), "utf8")))).join("\n");
    for (const prohibited of [
      "keydown",
      "keyup",
      "preventDefault",
      "stopPropagation",
      "setPointerCapture",
      ".click()",
      "setAttribute(\"role\"",
      "setAttribute(\"tabindex\""
    ]) expect(source).not.toContain(prohibited);
  });
});
