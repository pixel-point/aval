import { expect, test } from "@playwright/test";

import {
  captureBrowserFailures,
  installInteractionLedger,
  openIdleOrb,
  readInteractionLedger,
  readOrbHealth,
  readOrbState,
  sampleRenderedFrame
} from "./browser-harness.js";

const RAPID_CYCLES = 40;
const RAPID_EDGE_MS = 45;
const ROUTE_CYCLE = Object.freeze([
  "idle.entering",
  "entering.exiting",
  "exiting.idle"
]);

test("routes pointer and keyboard engagement", async ({ page }) => {
  const failures = captureBrowserFailures(page);
  const { motion, stateLabel } = await openIdleOrb(page);

  await motion.hover();
  await expect.poll(() => readOrbState(motion)).toMatchObject({ visualState: "hover" });
  await expect(stateLabel).toHaveText("hover");

  await page.mouse.move(0, 0);
  await expect.poll(() => motion.evaluate((node) => node.matches(":hover"))).toBe(false);
  await expect.poll(() => readOrbState(motion)).toEqual({
    requestedState: "idle",
    visualState: "idle",
    isTransitioning: false
  });

  await motion.focus();
  await expect.poll(() => readOrbState(motion)).toMatchObject({ visualState: "hover" });
  await motion.evaluate((node) => (node as HTMLElement).blur());
  await expect(motion).not.toBeFocused();
  await expect.poll(() => readOrbState(motion)).toEqual({
    requestedState: "idle",
    visualState: "idle",
    isTransitioning: false
  });

  expect(failures).toEqual({ consoleErrors: [], pageErrors: [] });
});

test("survives rapid pointer churn and remains reusable", async ({ page }) => {
  const failures = captureBrowserFailures(page);
  const { motion } = await openIdleOrb(page);
  await installInteractionLedger(motion);

  for (let cycle = 0; cycle < RAPID_CYCLES; cycle += 1) {
    await motion.hover();
    await page.waitForTimeout(RAPID_EDGE_MS);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(RAPID_EDGE_MS);
  }
  await expect.poll(() => readOrbState(motion), { timeout: 15_000 }).toEqual({
    requestedState: "idle",
    visualState: "idle",
    isTransitioning: false
  });

  const burst = await readInteractionLedger(motion);
  expect(burst.pointerEnters).toBe(RAPID_CYCLES);
  expect(burst.pointerLeaves).toBe(RAPID_CYCLES);
  expect(contiguousCycleCount(burst.transitionStarts, ROUTE_CYCLE))
    .toBeGreaterThanOrEqual(2);
  expect(burst.runtimeEvents).toEqual([]);
  expect(await readOrbHealth(motion)).toEqual(healthyIdle());

  // A settled idle snapshot is insufficient: prove the same player can route
  // another complete interaction after the burst.
  await motion.hover();
  await expect.poll(() => readOrbState(motion)).toMatchObject({ visualState: "hover" });
  await page.mouse.move(0, 0);
  await expect.poll(() => readOrbState(motion)).toEqual({
    requestedState: "idle",
    visualState: "idle",
    isTransitioning: false
  });

  const first = await sampleRenderedFrame(motion);
  await expect.poll(async () => (
    await sampleRenderedFrame(motion)
  ).equals(first)).toBe(false);

  expect(await readOrbHealth(motion)).toEqual(healthyIdle());
  expect((await readInteractionLedger(motion)).runtimeEvents).toEqual([]);
  expect(failures).toEqual({ consoleErrors: [], pageErrors: [] });
});

function contiguousCycleCount(
  actual: readonly string[],
  cycle: readonly string[]
): number {
  let completed = 0;
  for (let index = 0; index <= actual.length - cycle.length; index += 1) {
    if (cycle.every((value, offset) => actual[index + offset] === value)) {
      completed += 1;
      index += cycle.length - 1;
    }
  }
  return completed;
}

function healthyIdle() {
  return {
    readiness: "interactiveReady",
    mode: "animated",
    staticReason: null,
    requestedState: "idle",
    visualState: "idle",
    isTransitioning: false,
    lastFailure: null,
    underflows: 0,
    fallbacks: 0
  };
}
