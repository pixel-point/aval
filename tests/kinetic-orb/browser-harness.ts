import { expect, type Locator, type Page } from "@playwright/test";
import type { AvalElement } from "@pixel-point/aval-element";

export interface BrowserFailures {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
}

export interface InteractionLedger {
  pointerEnters: number;
  pointerLeaves: number;
  readonly transitionStarts: string[];
  readonly runtimeEvents: string[];
}

type InstrumentedAvalElement = AvalElement & {
  __kineticOrbLedger?: InteractionLedger;
};

export function captureBrowserFailures(page: Page): BrowserFailures {
  const failures: BrowserFailures = { consoleErrors: [], pageErrors: [] };
  page.on("console", (message) => {
    if (message.type() === "error") failures.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => failures.pageErrors.push(error.message));
  return failures;
}

export async function openIdleOrb(page: Page): Promise<Readonly<{
  motion: Locator;
  stateLabel: Locator;
}>> {
  await page.mouse.move(0, 0);
  await page.goto("/");
  await page.mouse.move(0, 0);

  const motion = page.locator("#kinetic-orb");
  const stateLabel = page.locator("[data-state-label]");
  await expect.poll(() => motion.evaluate((node) => (
    node as AvalElement
  ).readiness)).toBe("interactiveReady");
  await page.mouse.move(0, 0);
  await motion.evaluate((node) => (node as HTMLElement).blur());
  await expect.poll(() => motion.evaluate((node) => node.matches(":hover"))).toBe(false);
  await expect(motion).not.toBeFocused();
  await expect(motion).toHaveAttribute("data-rendered", "");
  await expect(motion).toHaveCSS("opacity", "1");
  await expect(stateLabel).toHaveText("idle", { timeout: 5_000 });
  // The authored intro is 24 frames at 24 FPS. Wait for the public demo to
  // reach its steady idle loop without coupling this black-box test to traces.
  await page.waitForTimeout(1_250);
  await expect.poll(() => readOrbState(motion)).toEqual({
    requestedState: "idle",
    visualState: "idle",
    isTransitioning: false
  });
  return Object.freeze({ motion, stateLabel });
}

export async function installInteractionLedger(motion: Locator): Promise<void> {
  await motion.evaluate((node) => {
    const element = node as InstrumentedAvalElement;
    const ledger: InteractionLedger = {
      pointerEnters: 0,
      pointerLeaves: 0,
      transitionStarts: [],
      runtimeEvents: []
    };
    element.__kineticOrbLedger = ledger;
    element.addEventListener("pointerenter", () => { ledger.pointerEnters += 1; });
    element.addEventListener("pointerleave", () => { ledger.pointerLeaves += 1; });
    element.addEventListener("transitionstart", (event) => {
      ledger.transitionStarts.push(event.detail.edge);
    });
    for (const type of ["error", "fallback", "underflow"] as const) {
      element.addEventListener(type, () => ledger.runtimeEvents.push(type));
    }
  });
}

export async function readInteractionLedger(
  motion: Locator
): Promise<Readonly<InteractionLedger>> {
  return motion.evaluate((node) => {
    const ledger = (node as InstrumentedAvalElement).__kineticOrbLedger;
    if (ledger === undefined) throw new Error("kinetic-orb ledger is unavailable");
    return {
      pointerEnters: ledger.pointerEnters,
      pointerLeaves: ledger.pointerLeaves,
      transitionStarts: [...ledger.transitionStarts],
      runtimeEvents: [...ledger.runtimeEvents]
    };
  });
}

export async function readOrbState(motion: Locator): Promise<Readonly<{
  requestedState: string | null;
  visualState: string | null;
  isTransitioning: boolean;
}>> {
  return motion.evaluate((node) => {
    const element = node as AvalElement;
    return {
      requestedState: element.requestedState,
      visualState: element.visualState,
      isTransitioning: element.isTransitioning
    };
  });
}

export async function readOrbHealth(motion: Locator) {
  return motion.evaluate((node) => {
    const diagnostics = (node as AvalElement).getDiagnostics();
    return {
      readiness: diagnostics.readiness,
      mode: diagnostics.mode,
      staticReason: diagnostics.staticReason,
      requestedState: diagnostics.requestedState,
      visualState: diagnostics.visualState,
      isTransitioning: diagnostics.isTransitioning,
      lastFailure: diagnostics.lastFailure,
      underflows: diagnostics.counters.underflow,
      fallbacks: diagnostics.counters.fallback
    };
  });
}

export function sampleRenderedFrame(motion: Locator): Promise<Buffer> {
  return motion.screenshot({ animations: "allow" });
}
