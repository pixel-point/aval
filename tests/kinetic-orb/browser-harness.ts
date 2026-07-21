import { expect, type Locator, type Page } from "@playwright/test";
import type { AvalElement } from "@pixel-point/aval-element";

export interface BrowserFailures {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
}

export interface RenderedColorWitness {
  readonly greenDominantRatio: number;
  readonly vividGreenRatio: number;
  readonly quantizedColorCount: number;
}

export interface InteractionLedger {
  pointerEnters: number;
  pointerLeaves: number;
  focusIns: number;
  focusOuts: number;
  readonly pointerTimestamps: number[];
  readonly transitionStarts: string[];
  readonly runtimeEvents: string[];
  readonly traceStartIndex: number;
}

type InstrumentedAvalElement = AvalElement & {
  __kineticOrbLedger?: InteractionLedger;
};

interface PlaybackLifecycleSnapshot {
  readonly outputsAccepted: number;
  readonly drawsCompleted: number;
  readonly logicalRunsCreated: number;
  readonly candidateCommits: number;
  readonly runsClosed: number;
  readonly transitionStarts: number;
  readonly transitionEnds: number;
  readonly loopCrossings: number;
  readonly nativeDecoderCreatesByLane: readonly [number, number];
  readonly nativeDecoderClosesByLane: readonly [number, number];
}

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
      focusIns: 0,
      focusOuts: 0,
      pointerTimestamps: [],
      transitionStarts: [],
      runtimeEvents: [],
      traceStartIndex: element.getDiagnostics({ trace: true }).runtimeTrace?.at(-1)?.index ?? 0
    };
    element.__kineticOrbLedger = ledger;
    element.addEventListener("pointerenter", () => {
      ledger.pointerEnters += 1;
      ledger.pointerTimestamps.push(performance.now());
    });
    element.addEventListener("pointerleave", () => {
      ledger.pointerLeaves += 1;
      ledger.pointerTimestamps.push(performance.now());
    });
    element.addEventListener("focusin", () => { ledger.focusIns += 1; });
    element.addEventListener("focusout", () => { ledger.focusOuts += 1; });
    element.addEventListener("transitionstart", (event) => {
      ledger.transitionStarts.push(event.detail.edge);
    });
    for (const type of ["error", "underflow"] as const) {
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
      focusIns: ledger.focusIns,
      focusOuts: ledger.focusOuts,
      pointerTimestamps: [...ledger.pointerTimestamps],
      transitionStarts: [...ledger.transitionStarts],
      runtimeEvents: [...ledger.runtimeEvents],
      traceStartIndex: ledger.traceStartIndex
    };
  });
}

export async function readSubmissionTimes(motion: Locator): Promise<number[]> {
  return motion.evaluate((node) => {
    const element = node as InstrumentedAvalElement;
    const start = element.__kineticOrbLedger?.traceStartIndex;
    if (start === undefined) throw new Error("kinetic-orb ledger is unavailable");
    return (element.getDiagnostics({ trace: true }).runtimeTrace ?? [])
      .filter((record) => record.index > start)
      .flatMap((record) => record.canvasSubmissionCompleteMicroseconds === null
        ? []
        : [record.canvasSubmissionCompleteMicroseconds / 1_000]);
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
      playbackLifecycle: (diagnostics.runtime as unknown as Readonly<{
        playbackLifecycle: Readonly<PlaybackLifecycleSnapshot>;
      }>).playbackLifecycle
    };
  });
}

export function sampleRenderedFrame(motion: Locator): Promise<Buffer> {
  return motion.screenshot({ animations: "allow" });
}

export async function analyzeRenderedFrame(
  page: Page,
  screenshot: Buffer
): Promise<Readonly<RenderedColorWitness>> {
  const encoded = screenshot.toString("base64");
  return page.evaluate(async (base64) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d", {
        alpha: true,
        willReadFrequently: true
      });
      if (context === null) throw new Error("screenshot color witness is unavailable");
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let visible = 0;
      let greenDominant = 0;
      let vividGreen = 0;
      const colors = new Set<number>();
      for (let offset = 0; offset < pixels.byteLength; offset += 4) {
        const red = pixels[offset] ?? 0;
        const green = pixels[offset + 1] ?? 0;
        const blue = pixels[offset + 2] ?? 0;
        const alpha = pixels[offset + 3] ?? 0;
        if (alpha <= 16) continue;
        visible += 1;
        colors.add((red >> 4) << 8 | (green >> 4) << 4 | blue >> 4);
        if (green >= 32 && green - red >= 48 && green - blue >= 48) {
          greenDominant += 1;
          if (green >= 96) vividGreen += 1;
        }
      }
      if (visible === 0) throw new Error("screenshot color witness has no visible pixels");
      return Object.freeze({
        greenDominantRatio: greenDominant / visible,
        vividGreenRatio: vividGreen / visible,
        quantizedColorCount: colors.size
      });
    } finally {
      bitmap.close();
    }
  }, encoded);
}
