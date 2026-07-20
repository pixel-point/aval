import { expect, test, type Locator, type Page } from "@playwright/test";
import { performance } from "node:perf_hooks";
import type { AvalElement } from "@pixel-point/aval-element";

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
  "entering.exiting",
  "exiting.entering"
]);

test("does not label reduced-motion policy as rendered playback", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const motion = page.locator("#kinetic-orb");
  await expect.poll(() => motion.evaluate((node) => ({
    readiness: (node as import("@pixel-point/aval-element").AvalElement).readiness,
    staticReason: (node as import("@pixel-point/aval-element").AvalElement).staticReason
  }))).toEqual({
    readiness: "staticReady",
    staticReason: "reduced-motion"
  });
  await expect(motion).not.toHaveAttribute("data-rendered", "");
});

test("reflects live interactive and static policy transitions", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");

  const motion = page.locator("#kinetic-orb");
  await expect.poll(() => motion.evaluate((node) => (
    node as import("@pixel-point/aval-element").AvalElement
  ).readiness)).toBe("interactiveReady");
  await expect(motion).toHaveAttribute("data-rendered", "");
  await expect(page.locator("[data-codec-label]")).toHaveText(
    /^(?:AV1|VP9|HEVC|H\.264 fallback)$/u
  );
  await expect.poll(() => motion.evaluate((node) => {
    const selected = (node as AvalElement).getDiagnostics().runtime.selectedCodec;
    const visible = document.querySelector("[data-codec-label]")?.textContent;
    return selected?.startsWith("av01.") ? visible === "AV1"
      : selected?.startsWith("vp09.") ? visible === "VP9"
        : selected?.startsWith("hvc1.") ? visible === "HEVC"
          : selected?.startsWith("avc1.") ? visible === "H.264 fallback"
            : false;
  })).toBe(true);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => motion.evaluate((node) => (
    node as import("@pixel-point/aval-element").AvalElement
  ).readiness)).toBe("staticReady");
  await expect(motion).not.toHaveAttribute("data-rendered", "");

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(() => motion.evaluate((node) => (
    node as import("@pixel-point/aval-element").AvalElement
  ).readiness)).toBe("interactiveReady");
  await expect(motion).toHaveAttribute("data-rendered", "");
});

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

test("routes touch taps outside and during entering or exiting", async ({
  browser
}, testInfo) => {
  const configuredBaseUrl = testInfo.project.use.baseURL;
  if (typeof configuredBaseUrl !== "string") {
    throw new Error("kinetic-orb touch test requires a configured base URL");
  }
  const context = await browser.newContext({
    baseURL: configuredBaseUrl,
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 }
  });
  const page = await context.newPage();
  const failures = captureBrowserFailures(page);
  try {
    await page.goto("/");
    const motion = page.locator("#kinetic-orb");
    await expect.poll(() => motion.evaluate((node) => (
      node as AvalElement
    ).readiness)).toBe("interactiveReady");
    await page.waitForTimeout(1_250);
    await expect.poll(() => readOrbState(motion)).toEqual({
      requestedState: "idle",
      visualState: "idle",
      isTransitioning: false
    });
    const bounds = await motion.boundingBox();
    if (bounds === null) throw new Error("kinetic-orb touch bounds are unavailable");
    const tapPlayer = () => page.touchscreen.tap(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2
    );
    const tapOutside = () => page.touchscreen.tap(4, 4);

    await tapPlayer();
    await expect.poll(() => readOrbState(motion)).toMatchObject({
      visualState: "entering"
    });
    await tapOutside();
    await expect.poll(() => readOrbState(motion), { timeout: 15_000 }).toEqual({
      requestedState: "idle",
      visualState: "idle",
      isTransitioning: false
    });

    await tapPlayer();
    await expect.poll(() => readOrbState(motion)).toMatchObject({
      visualState: "hover"
    });
    await tapOutside();
    await expect.poll(() => readOrbState(motion)).toMatchObject({
      visualState: "exiting"
    });
    await tapPlayer();
    await expect.poll(() => readOrbState(motion), { timeout: 15_000 }).toEqual({
      requestedState: "hover",
      visualState: "hover",
      isTransitioning: false
    });
    expect(failures).toEqual({ consoleErrors: [], pageErrors: [] });
  } finally {
    await context.close();
  }
});

test("re-enters finite hover-out from early and late pointer or focus input", async ({
  page
}) => {
  test.setTimeout(2 * 60_000);
  const failures = captureBrowserFailures(page);
  const { motion } = await openIdleOrb(page);

  for (const mode of ["pointer", "focus"] as const) {
    for (const targetFrame of [2, 10] as const) {
      const witness = await exerciseFiniteReentry(
        page,
        motion,
        mode,
        targetFrame
      );
      expect(witness.observedFrame).toBe(targetFrame);
      expect(witness.inputEvents).toEqual(
        mode === "pointer"
          ? ["pointerenter", "pointerleave", "pointerenter"]
          : ["focusin", "focusout", "focusin"]
      );
      expect(witness.transitionEdges).toEqual([
        "idle.entering",
        "entering.hover",
        "hover.exiting",
        "exiting.entering",
        "entering.hover"
      ]);
      expect(witness.visualStates).toEqual([
        "entering",
        "hover",
        "exiting",
        "entering",
        "hover"
      ]);
      expect(witness.transitionEventTypes).toEqual(
        Array.from({ length: 5 }, () => [
          "transitionstart",
          "visualstatechange",
          "transitionend"
        ]).flat()
      );
      expect(witness.settled).toEqual({
        requestedState: "hover",
        visualState: "hover",
        isTransitioning: false
      });

      await disengage(motion, mode);
      await expect.poll(() => readOrbState(motion)).toEqual({
        requestedState: "idle",
        visualState: "idle",
        isTransitioning: false
      });
    }
  }

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
    timeout: 5_000,
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
  expect(await readOrbHealth(motion)).toMatchObject(healthyIdle());
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

  expect(await readOrbHealth(motion)).toMatchObject(healthyIdle());
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
    underflows: 0
  };
}

type ReentryMode = "pointer" | "focus";

interface ReentryEvent {
  readonly type: string;
  readonly edge: string | null;
  readonly to: string | null;
}

type ReentryElement = AvalElement & {
  __kineticReentryEvents?: ReentryEvent[];
  __kineticReentryInputs?: string[];
  __kineticReentryInstalled?: boolean;
};

async function exerciseFiniteReentry(
  page: Page,
  motion: Locator,
  mode: ReentryMode,
  targetFrame: number
) {
  await page.mouse.move(0, 0);
  await motion.evaluate((node) => {
    const element = node as ReentryElement;
    if (element.__kineticReentryInstalled !== true) {
      for (const type of [
        "transitionstart",
        "visualstatechange",
        "transitionend"
      ]) {
        element.addEventListener(type, (event) => {
          if (!(event instanceof CustomEvent) || event.target !== element) return;
          const detail = (event as CustomEvent<{
            edge?: string;
            to?: string;
          }>).detail;
          if (detail === null || typeof detail !== "object") return;
          element.__kineticReentryEvents?.push({
            type,
            edge: detail.edge ?? null,
            to: detail.to ?? null
          });
        });
      }
      for (const type of [
        "pointerenter",
        "pointerleave",
        "focusin",
        "focusout"
      ]) {
        element.addEventListener(type, () => {
          element.__kineticReentryInputs?.push(type);
        });
      }
      element.__kineticReentryInstalled = true;
    }
    element.__kineticReentryEvents = [];
    element.__kineticReentryInputs = [];
    element.blur();
    element.dispatchEvent(new PointerEvent("pointerleave", {
      pointerType: "mouse"
    }));
  });
  await expect.poll(() => readOrbState(motion)).toEqual({
    requestedState: "idle",
    visualState: "idle",
    isTransitioning: false
  });
  await motion.evaluate((node) => {
    const element = node as ReentryElement;
    element.__kineticReentryEvents = [];
    element.__kineticReentryInputs = [];
  });
  await motion.evaluate((node, requestedMode) => {
    if (requestedMode === "pointer") {
      node.dispatchEvent(new PointerEvent("pointerenter", {
        pointerType: "mouse"
      }));
    } else {
      (node as HTMLElement).focus();
    }
  }, mode);
  await expect.poll(() => readOrbState(motion)).toMatchObject({
    requestedState: "hover",
    visualState: "hover",
    isTransitioning: false
  });

  const observedFrame = await motion.evaluate(async (
    node,
    input: Readonly<{ mode: ReentryMode; targetFrame: number }>
  ) => {
    const element = node as AvalElement;
    const deadline = performance.now() + 5_000;
    return new Promise<number>((resolve, reject) => {
      const observe = (): void => {
        const trace = element.getDiagnostics({ trace: true }).runtimeTrace ?? [];
        const presentation = trace.at(-1)?.graph?.presentation as Readonly<{
          unitId?: string;
          frameIndex?: number;
        }> | null | undefined;
        if (
          presentation?.unitId === "hover-out" &&
          presentation.frameIndex === input.targetFrame
        ) {
          if (input.mode === "pointer") {
            node.dispatchEvent(new PointerEvent("pointerenter", {
              pointerType: "mouse"
            }));
          } else {
            (node as HTMLElement).focus();
          }
          resolve(presentation.frameIndex);
          return;
        }
        if (
          presentation?.unitId === "hover-out" &&
          typeof presentation.frameIndex === "number" &&
          presentation.frameIndex > input.targetFrame
        ) {
          reject(new Error(
            `hover-out advanced past frame ${input.targetFrame}`
          ));
          return;
        }
        if (performance.now() >= deadline) {
          reject(new Error(
            `hover-out frame ${input.targetFrame} was not presented`
          ));
          return;
        }
        requestAnimationFrame(observe);
      };
      if (input.mode === "pointer") {
        node.dispatchEvent(new PointerEvent("pointerleave", {
          pointerType: "mouse"
        }));
      } else {
        (node as HTMLElement).blur();
      }
      observe();
    });
  }, { mode, targetFrame });

  await expect.poll(() => readOrbState(motion), { timeout: 15_000 }).toEqual({
    requestedState: "hover",
    visualState: "hover",
    isTransitioning: false
  });
  return motion.evaluate((node, frame) => {
    const element = node as ReentryElement;
    const events = element.__kineticReentryEvents ?? [];
    return {
      observedFrame: frame,
      inputEvents: [...(element.__kineticReentryInputs ?? [])],
      transitionEdges: events.flatMap((event) =>
        event.type === "transitionstart" && event.edge !== null
          ? [event.edge]
          : []
      ),
      visualStates: events.flatMap((event) =>
        event.type === "visualstatechange" && event.to !== null
          ? [event.to]
          : []
      ),
      transitionEventTypes: events.map((event) => event.type),
      settled: {
        requestedState: element.requestedState,
        visualState: element.visualState,
        isTransitioning: element.isTransitioning
      }
    };
  }, observedFrame);
}

async function disengage(motion: Locator, mode: ReentryMode): Promise<void> {
  await motion.evaluate((node, requestedMode) => {
    if (requestedMode === "pointer") {
      node.dispatchEvent(new PointerEvent("pointerleave", {
        pointerType: "mouse"
      }));
    } else {
      (node as HTMLElement).blur();
    }
  }, mode);
}
