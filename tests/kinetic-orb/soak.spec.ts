import { expect, test, type Locator, type Page } from "@playwright/test";
import { performance } from "node:perf_hooks";

import {
  captureBrowserFailures,
  installInteractionLedger,
  openIdleOrb,
  readInteractionLedger,
  readOrbHealth,
  readOrbState,
  sampleRenderedFrame
} from "./browser-harness.js";

const OBSERVATION_MS = 60_000;
const INITIAL_IDLE_MS = 10_000;
const FINAL_IDLE_MS = 10_000;

test("sustains 60 seconds of idle, interaction, overlap, and re-entry", async ({
  page
}, testInfo) => {
  test.setTimeout(95_000);
  const failures = captureBrowserFailures(page);
  const { motion } = await openIdleOrb(page);
  await installInteractionLedger(motion);
  const bounds = await motion.boundingBox();
  if (bounds === null) throw new Error("kinetic-orb bounds are unavailable");
  const inside = Object.freeze({
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2
  });
  const started = performance.now();
  const monitor = monitorPlayback(page, motion, started);

  await waitUntil(page, started + INITIAL_IDLE_MS);
  for (let cycle = 0; cycle < 8; cycle += 1) {
    await page.mouse.move(inside.x, inside.y);
    await settledAs(motion, "hover");
    await page.mouse.move(0, 0);
    await settledAs(motion, "idle");
  }
  for (let cycle = 0; cycle < 8; cycle += 1) {
    await motion.focus();
    await settledAs(motion, "hover");
    await motion.evaluate((node) => (node as HTMLElement).blur());
    await settledAs(motion, "idle");
  }

  await pointerOverlapReentry(page, motion, inside);
  await focusOverlapReentry(motion);
  const finalIdleStart = started + OBSERVATION_MS - FINAL_IDLE_MS;
  expect(performance.now(), "interaction phase consumed the required final idle window")
    .toBeLessThanOrEqual(finalIdleStart);
  await page.mouse.move(0, 0);
  await motion.evaluate((node) => (node as HTMLElement).blur());
  await settledAs(motion, "idle");
  await waitUntil(page, finalIdleStart);

  const samples = await monitor;
  const ledger = await readInteractionLedger(motion);
  await testInfo.attach("kinetic-orb-60s-interaction-ledger", {
    body: Buffer.from(JSON.stringify({
      schemaVersion: 1,
      observationMilliseconds: OBSERVATION_MS,
      interactions: ledger,
      samples
    }, null, 2)),
    contentType: "application/json"
  });

  expect(performance.now() - started).toBeGreaterThanOrEqual(OBSERVATION_MS);
  expect(ledger.pointerEnters).toBeGreaterThanOrEqual(10);
  expect(ledger.pointerLeaves).toBeGreaterThanOrEqual(10);
  expect(ledger.focusIns).toBeGreaterThanOrEqual(10);
  expect(ledger.focusOuts).toBeGreaterThanOrEqual(10);
  expect(ledger.transitionStarts).toEqual(expect.arrayContaining([
    "idle.entering",
    "entering.hover",
    "hover.exiting",
    "exiting.entering"
  ]));
  expect(ledger.runtimeEvents).toEqual([]);
  expect(failures).toEqual({ consoleErrors: [], pageErrors: [] });
  expect(await readOrbState(motion)).toEqual({
    requestedState: "idle",
    visualState: "idle",
    isTransitioning: false
  });
});

async function monitorPlayback(
  page: Page,
  motion: Locator,
  started: number
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const samples: Readonly<Record<string, unknown>>[] = [];
  let previous = await readOrbHealth(motion);
  for (let second = 1; second <= 60; second += 1) {
    await waitUntil(page, started + second * 1_000);
    const previousRunActivity = runActivity(previous.playbackLifecycle);
    await expect.poll(async () => runActivity(
      (await readOrbHealth(motion)).playbackLifecycle
    ), {
      timeout: 950,
      intervals: [25, 50, 100]
    }).toBeGreaterThan(previousRunActivity);
    const current = await readOrbHealth(motion);
    expect(current.readiness).toBe("interactiveReady");
    expect(current.lastFailure).toBeNull();
    expect(current.underflows).toBe(0);
    expect(current.playbackLifecycle.drawsCompleted).toBeGreaterThan(
      previous.playbackLifecycle.drawsCompleted
    );
    const first = await sampleRenderedFrame(motion);
    await page.waitForTimeout(70);
    const secondFrame = await sampleRenderedFrame(motion);
    expect(secondFrame.equals(first), `rendered pixels did not change at second ${String(second)}`)
      .toBe(false);
    samples.push(Object.freeze({
      second,
      capturedAtMilliseconds: Math.round(performance.now() - started),
      readiness: current.readiness,
      requestedState: current.requestedState,
      visualState: current.visualState,
      lifecycle: current.playbackLifecycle,
      renderedPixelsChanged: true,
      underflows: current.underflows
    }));
    previous = current;
  }
  return Object.freeze(samples);
}

function runActivity(
  counters: Awaited<ReturnType<typeof readOrbHealth>>["playbackLifecycle"]
): number {
  return counters.logicalRunsCreated + counters.candidateCommits +
    counters.runsClosed;
}

async function pointerOverlapReentry(
  page: Page,
  motion: Locator,
  inside: Readonly<{ x: number; y: number }>
): Promise<void> {
  await page.mouse.move(inside.x, inside.y);
  await expect.poll(() => readOrbState(motion)).toMatchObject({
    visualState: "entering"
  });
  await page.mouse.move(0, 0);
  await settledAs(motion, "idle");
  await page.mouse.move(inside.x, inside.y);
  await settledAs(motion, "hover");
  await page.mouse.move(0, 0);
  await expect.poll(() => readOrbState(motion)).toMatchObject({
    visualState: "exiting"
  });
  await page.mouse.move(inside.x, inside.y);
  await settledAs(motion, "hover");
  await page.mouse.move(0, 0);
  await settledAs(motion, "idle");
}

async function focusOverlapReentry(motion: Locator): Promise<void> {
  await motion.focus();
  await expect.poll(() => readOrbState(motion)).toMatchObject({
    visualState: "entering"
  });
  await motion.evaluate((node) => (node as HTMLElement).blur());
  await settledAs(motion, "idle");
  await motion.focus();
  await settledAs(motion, "hover");
  await motion.evaluate((node) => (node as HTMLElement).blur());
  await expect.poll(() => readOrbState(motion)).toMatchObject({
    visualState: "exiting"
  });
  await motion.focus();
  await settledAs(motion, "hover");
  await motion.evaluate((node) => (node as HTMLElement).blur());
  await settledAs(motion, "idle");
}

async function settledAs(motion: Locator, state: "idle" | "hover"): Promise<void> {
  await expect.poll(() => readOrbState(motion), { timeout: 8_000 }).toEqual({
    requestedState: state,
    visualState: state,
    isTransitioning: false
  });
}

async function waitUntil(page: Page, deadline: number): Promise<void> {
  const remaining = deadline - performance.now();
  if (remaining > 0) await page.waitForTimeout(remaining);
}
