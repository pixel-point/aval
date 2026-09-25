import { render } from "svelte/server";
import { expect, it } from "vitest";
import { AvalAlphaComponent, createAvalAlpha } from "../src/index.js";

it("renders inert canvas markup and exposes a readable idle controller during SSR", () => {
  const alpha = createAvalAlpha(() => ({ sources: [], autoplay: true }));
  let status: string | undefined;
  const unsubscribe = alpha.subscribe((value) => { status = value.status; });
  const { body } = render(AvalAlphaComponent, { props: { alpha, width: 160, height: 90, "aria-label": "Motion" } });
  expect(body).toContain('<canvas aria-label="Motion"');
  expect(body).toContain("width:160px;height:90px");
  expect(body).not.toMatch(/<video|<source|<aval-alpha/u);
  expect(status).toBe("idle"); expect(alpha.getVideo()).toBeUndefined(); unsubscribe();
});

it("rejects controllers made elsewhere", () => {
  expect(() => render(AvalAlphaComponent, { props: { alpha: {} as never } }).body).toThrow(/created by createAvalAlpha/u);
  expect(() => createAvalAlpha({} as never)).toThrow(/option getter/u);
});
