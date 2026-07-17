import { expect, test, type Page } from "@playwright/test";
import { performance } from "node:perf_hooks";

import {
  captureBrowserFailures,
  installInteractionLedger,
  openIdleOrb,
  readInteractionLedger,
  readOrbHealth,
  readOrbState,
  readSubmissionTimes,
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
  const bounds = await motion.boundingBox();
  if (bounds === null) throw new Error("kinetic-orb bounds are unavailable");
  const inside = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2
  };
  const firstEdge = performance.now() + 100;

  for (let cycle = 0; cycle < RAPID_CYCLES; cycle += 1) {
    await moveAt(page, inside.x, inside.y, firstEdge + cycle * 2 * RAPID_EDGE_MS);
    await moveAt(page, 0, 0, firstEdge + (cycle * 2 + 1) * RAPID_EDGE_MS);
  }
  await expect.poll(() => readOrbState(motion), {
    timeout: 1_500,
    intervals: [25]
  }).toEqual({
    requestedState: "idle",
    visualState: "idle",
    isTransitioning: false
  });

  const burst = await readInteractionLedger(motion);
  expect(burst.pointerEnters).toBe(RAPID_CYCLES);
  expect(burst.pointerLeaves).toBe(RAPID_CYCLES);
  expect(burst.pointerTimestamps).toHaveLength(RAPID_CYCLES * 2);
  const inputIntervals = gaps(burst.pointerTimestamps);
  expect(percentile(inputIntervals, 0.5)).toBeGreaterThanOrEqual(35);
  expect(percentile(inputIntervals, 0.5)).toBeLessThanOrEqual(55);
  expect(percentile(inputIntervals, 0.95)).toBeLessThanOrEqual(70);
  expect(contiguousCycleCount(burst.transitionStarts, ROUTE_CYCLE))
    .toBeGreaterThanOrEqual(2);
  expect(burst.runtimeEvents).toEqual([]);
  expect(await readOrbHealth(motion)).toEqual(healthyIdle());
  const submissionGaps = gaps(await readSubmissionTimes(motion));
  expect(submissionGaps.length).toBeGreaterThan(20);
  expect(Math.max(...submissionGaps)).toBeLessThanOrEqual(83.5);

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

async function moveAt(
  page: Page,
  x: number,
  y: number,
  deadline: number
): Promise<void> {
  const delay = deadline - performance.now();
  if (delay > 0) await page.waitForTimeout(delay);
  await page.mouse.move(x, y);
}

function gaps(values: readonly number[]): number[] {
  return values.slice(1).map((value, index) => value - values[index]!);
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) throw new Error("timing sample is empty");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

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
