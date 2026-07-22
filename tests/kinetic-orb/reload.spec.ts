import { expect, test, type Locator } from "@playwright/test";
import type { AvalElement } from "@pixel-point/aval-element";

import {
  captureBrowserFailures,
  sampleRenderedFrame
} from "./browser-harness.js";

const RELOAD_COUNT = 5;
const SUPPORTED_CODEC = /^(?:av01\.|vp09\.|hvc1\.|avc1\.)/u;

test("survives five full document reloads", async ({ page }) => {
  test.setTimeout(RELOAD_COUNT * 30_000);
  const failures = captureBrowserFailures(page);
  await page.goto("/");
  const motion = page.locator("#kinetic-orb");

  await expect.poll(() => readReloadHealth(motion), {
    message: "kinetic orb did not become animated before the reload sequence"
  }).toMatchObject({
    readiness: "interactiveReady",
    mode: "animated",
    lastFailure: null
  });

  for (let reload = 1; reload <= RELOAD_COUNT; reload += 1) {
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect.poll(() => readReloadHealth(motion), {
      message: `kinetic orb did not become animated after reload ${String(reload)}`
    }).toMatchObject({
      readiness: "interactiveReady",
      mode: "animated",
      lastFailure: null
    });
    await expect(motion).toHaveAttribute("data-rendered", "");
    await expect.poll(() => readSelectedCodec(motion), {
      message: `kinetic orb did not select a supported codec after reload ${String(reload)}`
    }).toMatch(SUPPORTED_CODEC);

    // data-rendered starts a CSS opacity transition. Waiting for the element to
    // become fully opaque keeps that transition from masquerading as playback.
    await expect(motion).toHaveCSS("opacity", "1");
    await expectRenderedPixelsToAdvance(motion, reload);
  }

  expect(failures).toEqual({ consoleErrors: [], pageErrors: [] });
});

async function readReloadHealth(motion: Locator): Promise<Readonly<{
  readiness: string;
  mode: string | null;
  lastFailure: unknown;
}>> {
  return motion.evaluate((node) => {
    const diagnostics = (node as AvalElement).getDiagnostics();
    return {
      readiness: diagnostics.readiness,
      mode: diagnostics.mode,
      lastFailure: diagnostics.lastFailure
    };
  });
}

async function readSelectedCodec(motion: Locator): Promise<string | null> {
  return motion.evaluate((node) => (
    node as AvalElement
  ).getDiagnostics().runtime.selectedCodec);
}

async function expectRenderedPixelsToAdvance(
  motion: Locator,
  reload: number
): Promise<void> {
  let previous = await sampleRenderedFrame(motion);
  await expect.poll(async () => {
    const current = await sampleRenderedFrame(motion);
    const advanced = !current.equals(previous);
    previous = current;
    return advanced;
  }, {
    timeout: 5_000,
    intervals: [50, 100, 200],
    message: `rendered pixels did not advance after reload ${String(reload)}`
  }).toBe(true);
}
