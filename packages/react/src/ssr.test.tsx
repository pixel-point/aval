import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { useAval } from "./index.js";

describe("useAval server rendering", () => {
  it("imports without DOM globals and emits deterministic inert markup", () => {
    function Fixture() {
      const { aval, AvalComponent } = useAval({
        sources: {
          h264: "/motion/h264.avl",
          av1: "/motion/av1.avl"
        },
        state: "idle",
        autoplay: false,
        autoBind: false
      });
      expect(aval.mounted).toBe(false);
      return <AvalComponent
        width={160}
        height={90}
        aria-hidden
        aria-busy={false}
      />;
    }

    expect(renderToString(<Fixture />)).toBe(
      '<aval-player aria-hidden="true" aria-busy="false" state="idle" autoplay="manual" bindings="none" width="160" height="90"><source src="/motion/av1.avl" data-codec="av1"/><source src="/motion/h264.avl" data-codec="h264"/></aval-player>'
    );
  });
});
