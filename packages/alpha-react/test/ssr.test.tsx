import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";
import { useAvalAlpha, type UseAvalAlphaResult } from "../src/index.js";

it("renders inert, accessible canvas markup without DOM globals", () => {
  let controller: UseAvalAlphaResult["alpha"] | undefined;
  function App() {
    const { alpha, AvalAlphaComponent } = useAvalAlpha({ sources: [], autoplay: true });
    controller = alpha;
    return createElement(AvalAlphaComponent, { width: 160, height: 90, "aria-label": "Motion", "aria-hidden": true });
  }
  const html = renderToString(createElement(App));
  expect(html).toContain('<canvas aria-label="Motion" aria-hidden="true"');
  expect(html).toContain("width:160px;height:90px");
  expect(html).not.toMatch(/<video|<source|<aval-alpha/u);
  expect(controller!.status).toBe("idle");
  expect(controller!.getVideo()).toBeUndefined();
});
