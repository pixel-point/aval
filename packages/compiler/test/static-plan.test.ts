import { describe, expect, it } from "vitest";

import {
  buildPosters
} from "../src/compile/project-compiler.js";
import type { SourceProjectV01 } from "../src/model.js";

describe("static poster planning", () => {
  it("deduplicates byte-identical pixels under the lexicographically first state", () => {
    const rgba = new Uint8Array(16 * 16 * 4);
    rgba.fill(255);
    const project = {
      canvas: { width: 16, height: 16 },
      states: [
        { id: "zeta", bodyUnit: "body-z", poster: { source: "a", frame: 8 } },
        { id: "alpha", bodyUnit: "body-a", poster: { source: "b", frame: 3 } }
      ]
    } as unknown as SourceProjectV01;
    const plan = buildPosters(project, new Map([
      ["alpha", rgba.slice()],
      ["zeta", rgba.slice()]
    ]));

    expect(plan.frames.map(({ id }) => id)).toEqual(["static.00"]);
    expect(plan.staticIdByState.get("alpha")).toBe("static.00");
    expect(plan.staticIdByState.get("zeta")).toBe("static.00");
  });
});
