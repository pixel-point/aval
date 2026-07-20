import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  CODECS,
  CODEC_PATTERNS,
  activateFirstInteractiveCodec,
  activePlayerSnapshot,
  activeTraceUnits,
  captureBrowserFailures,
  capturePreviousPlayer,
  codecPanel,
  expectActiveCodecPlayer,
  expectNoBrowserFailures,
  expectOrderedSubsequence,
  expectPreviousPlayerCleanup,
  expectVisualState,
  openExample,
  supportSnapshot,
  traceContainsUnit
} from "./support/browser-harness.js";

test("plays the complete rabbit interaction on every runtime-playable codec", async ({
  page
}) => {
  test.setTimeout(5 * 60_000);
  const failures = captureBrowserFailures(page);
  await openExample(page);
  const support = await supportSnapshot(page);
  const supported = CODECS.filter((codec) => support[codec] === "supported");
  const playable: typeof supported = [];
  let cleanupProofs = 0;

  for (const codec of supported) {
    await page.evaluate(async (requested) => {
      await window.grassRabbitCodecs.activate(requested);
    }, codec);
    const snapshot = await activePlayerSnapshot(page);
    if (snapshot.readiness === "interactiveReady" && snapshot.lastFailure === null) {
      playable.push(codec);
      continue;
    }
    await expect(codecPanel(page, codec).locator("[data-player-stage]"))
      .toHaveAttribute("data-state", "error");
    await expect(codecPanel(page, codec).locator("aval-player")).toHaveCount(0);
  }

  for (const codec of playable) {
    await page.mouse.move(1, 1);
    const previous = await capturePreviousPlayer(page);
    await page.evaluate(async (requested) => {
      await window.grassRabbitCodecs.activate(requested);
    }, codec);
    if (await expectPreviousPlayerCleanup(page, previous, codec)) {
      cleanupProofs += 1;
    }

    await expectActiveCodecPlayer(page, codec);
    await expect.poll(() => activePlayerSnapshot(page), { timeout: 45_000 })
      .toMatchObject({
        readiness: "interactiveReady",
        selectedCodec: expect.stringMatching(CODEC_PATTERNS[codec]),
        lastFailure: null,
        underflow: 0
      });
    await expect.poll(() => traceContainsUnit(page, "intro"), { timeout: 15_000 })
      .toBe(true);
    await expectVisualState(page, "idle");

    const player = codecPanel(page, codec).locator("aval-player");
    await player.hover();
    await expectVisualState(page, "entering");
    await expectVisualState(page, "hover");
    await expect.poll(() => activePlayerSnapshot(page)).toMatchObject({
      requestedState: "hover",
      visualState: "hover",
      isTransitioning: false
    });

    await page.mouse.move(1, 1);
    await expectVisualState(page, "exiting");
    await expectVisualState(page, "idle");
    await expect.poll(() => activePlayerSnapshot(page)).toMatchObject({
      requestedState: "idle",
      visualState: "idle",
      isTransitioning: false,
      selectedCodec: expect.stringMatching(CODEC_PATTERNS[codec]),
      lastFailure: null,
      underflow: 0
    });

    const units = await activeTraceUnits(page);
    expectOrderedSubsequence(units, [
      "intro",
      "idle-loop",
      "hover-in",
      "hover-loop",
      "hover-out",
      "idle-loop"
    ]);
    expectNoBrowserFailures(failures);
  }

  if (playable.length > 0 && cleanupProofs === 0) {
    const inactiveCodec = CODECS.find((codec) => support[codec] !== "supported");
    expect(inactiveCodec).toBeDefined();
    const previous = await capturePreviousPlayer(page);
    await page.evaluate(async (requested) => {
      await window.grassRabbitCodecs.activate(requested);
    }, inactiveCodec!);
    expect(await expectPreviousPlayerCleanup(page, previous, inactiveCodec!)).toBe(true);
    cleanupProofs += 1;
  }

  if (playable.length > 0) expect(cleanupProofs).toBeGreaterThan(0);
  expectNoBrowserFailures(failures);
});

test("finishes hover-in before hover-out when engagement ends early", async ({
  page
}) => {
  test.setTimeout(2 * 60_000);
  const failures = captureBrowserFailures(page);
  await openExample(page);
  const support = await supportSnapshot(page);
  const codec = await activateFirstInteractiveCodec(page, support);
  test.skip(codec === undefined, "this browser exposes no interactive codec fixture");

  await expectActiveCodecPlayer(page, codec!);
  await expect.poll(() => activePlayerSnapshot(page), { timeout: 45_000 })
    .toMatchObject({ readiness: "interactiveReady", lastFailure: null, underflow: 0 });
  await expectVisualState(page, "idle");
  await page.mouse.move(1, 1);

  const traceStart = await page.evaluate(() => {
    const trace = window.grassRabbitCodecs.activePlayer
      ?.getDiagnostics({ trace: true }).runtimeTrace ?? [];
    return trace.at(-1)?.index ?? -1;
  });
  await codecPanel(page, codec!).locator("aval-player").hover();
  await expect.poll(() => page.evaluate(() => {
    const trace = window.grassRabbitCodecs.activePlayer
      ?.getDiagnostics({ trace: true }).runtimeTrace ?? [];
    const presentation = trace.at(-1)?.graph?.presentation;
    return presentation?.unitId === "hover-in" &&
      typeof presentation.frameIndex === "number" &&
      presentation.frameIndex >= 8 && presentation.frameIndex < 50;
  }), { timeout: 15_000 }).toBe(true);

  await page.mouse.move(1, 1);
  await expect.poll(() => activePlayerSnapshot(page)).toMatchObject({
    requestedState: "exiting"
  });
  await expectVisualState(page, "idle");

  const routeFrames = await page.evaluate((startIndex) => {
    const trace = window.grassRabbitCodecs.activePlayer
      ?.getDiagnostics({ trace: true }).runtimeTrace ?? [];
    return trace.flatMap((record) => {
      if (record.index <= startIndex) return [];
      const media = record.media;
      if (
        media?.kind !== "frame" ||
        typeof media.frame?.unit !== "string" ||
        typeof media.frame.localFrame !== "number" ||
        !["hover-in", "hover-loop", "hover-out"].includes(media.frame.unit)
      ) return [];
      return [{ unit: media.frame.unit, frame: media.frame.localFrame }];
    });
  }, traceStart);
  expect(routeFrames.length).toBeLessThanOrEqual(128);
  const framesFor = (unit: string): number[] => routeFrames
    .filter((record) => record.unit === unit)
    .map((record) => record.frame);
  expect(framesFor("hover-in")).toEqual(
    Array.from({ length: 67 }, (_, frame) => frame)
  );
  expect(framesFor("hover-loop")).toEqual([]);
  expect(framesFor("hover-out")).toEqual(
    Array.from({ length: 48 }, (_, frame) => frame)
  );
  await expect.poll(() => activePlayerSnapshot(page)).toMatchObject({
    requestedState: "idle",
    visualState: "idle",
    isTransitioning: false,
    lastFailure: null,
    underflow: 0
  });
  expectNoBrowserFailures(failures);
});

test("routes touch taps outside and during entering or exiting", async ({
  browser
}, testInfo) => {
  test.setTimeout(2 * 60_000);
  const configuredBaseUrl = testInfo.project.use.baseURL;
  if (typeof configuredBaseUrl !== "string") {
    throw new Error("grass-rabbit codec touch test requires a configured base URL");
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
    await openExample(page);
    const support = await supportSnapshot(page);
    const codec = await activateFirstInteractiveCodec(page, support);
    test.skip(codec === undefined, "this browser exposes no interactive codec fixture");
    await expectActiveCodecPlayer(page, codec!);
    const player = codecPanel(page, codec!).locator("aval-player");
    await expect.poll(() => codecRabbitState(player), { timeout: 15_000 })
      .toEqual({
        requestedState: "idle",
        visualState: "idle",
        isTransitioning: false
      });
    const bounds = await player.boundingBox();
    if (bounds === null) {
      throw new Error("grass-rabbit codec touch bounds are unavailable");
    }
    const tapPlayer = () => page.touchscreen.tap(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2
    );
    const tapOutside = () => page.touchscreen.tap(4, 4);

    await tapPlayer();
    await expect.poll(() => codecRabbitState(player)).toMatchObject({
      visualState: "entering"
    });
    await tapOutside();
    await expect.poll(() => codecRabbitState(player), { timeout: 15_000 })
      .toEqual({
        requestedState: "idle",
        visualState: "idle",
        isTransitioning: false
      });

    await tapPlayer();
    await expect.poll(() => codecRabbitState(player), { timeout: 15_000 })
      .toMatchObject({ visualState: "hover" });
    await tapOutside();
    await expect.poll(() => codecRabbitState(player)).toMatchObject({
      visualState: "exiting"
    });
    await tapPlayer();
    await expect.poll(() => codecRabbitState(player), { timeout: 15_000 })
      .toEqual({
        requestedState: "hover",
        visualState: "hover",
        isTransitioning: false
      });
    expectNoBrowserFailures(failures);
  } finally {
    await context.close();
  }
});

test("re-enters finite hover-out at early and late pointer or focus frames", async ({
  page
}) => {
  test.setTimeout(4 * 60_000);
  const failures = captureBrowserFailures(page);
  await openExample(page);
  const support = await supportSnapshot(page);
  const codec = await activateFirstInteractiveCodec(page, support);
  test.skip(codec === undefined, "this browser exposes no interactive codec fixture");

  await expectActiveCodecPlayer(page, codec!);
  await expect.poll(() => activePlayerSnapshot(page), { timeout: 45_000 })
    .toMatchObject({ readiness: "interactiveReady", lastFailure: null, underflow: 0 });
  const player = codecPanel(page, codec!).locator("aval-player");
  await normalizeCodecRabbitIdle(page, player);

  for (const mode of ["pointer", "focus"] as const) {
    for (const targetFrame of [2, 46] as const) {
      const witness = await exerciseCodecRabbitReentry(
        page,
        player,
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
      await disengageCodecRabbit(player, mode);
      await expect.poll(() => codecRabbitState(player), { timeout: 15_000 })
        .toEqual({
          requestedState: "idle",
          visualState: "idle",
          isTransitioning: false
        });
    }
  }

  expectNoBrowserFailures(failures);
});

type CodecRabbitReentryMode = "pointer" | "focus";

interface CodecRabbitReentryEvent {
  readonly type: string;
  readonly edge: string | null;
  readonly to: string | null;
}

type CodecRabbitReentryElement = HTMLElement & {
  readonly requestedState: string | null;
  readonly visualState: string | null;
  readonly isTransitioning: boolean;
  getDiagnostics(options?: Readonly<{ trace?: boolean }>): Readonly<{
    runtimeTrace?: readonly Readonly<{
      graph?: Readonly<{
        presentation?: Readonly<{
          unitId?: string;
          frameIndex?: number;
        }> | null;
      }> | null;
    }>[];
  }>;
  __codecRabbitReentryEvents?: CodecRabbitReentryEvent[];
  __codecRabbitReentryInputs?: string[];
  __codecRabbitReentryInstalled?: boolean;
};

async function normalizeCodecRabbitIdle(
  page: Page,
  player: Locator
): Promise<void> {
  await page.mouse.move(1, 1);
  await player.evaluate((node) => {
    const element = node as HTMLElement;
    element.blur();
    element.dispatchEvent(new PointerEvent("pointerleave", {
      pointerType: "mouse"
    }));
  });
  await expect.poll(() => codecRabbitState(player), { timeout: 15_000 })
    .toEqual({
      requestedState: "idle",
      visualState: "idle",
      isTransitioning: false
    });
}

async function exerciseCodecRabbitReentry(
  page: Page,
  player: Locator,
  mode: CodecRabbitReentryMode,
  targetFrame: number
) {
  await normalizeCodecRabbitIdle(page, player);
  await player.evaluate((node) => {
    const element = node as CodecRabbitReentryElement;
    if (element.__codecRabbitReentryInstalled !== true) {
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
          element.__codecRabbitReentryEvents?.push({
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
          element.__codecRabbitReentryInputs?.push(type);
        });
      }
      element.__codecRabbitReentryInstalled = true;
    }
    element.__codecRabbitReentryEvents = [];
    element.__codecRabbitReentryInputs = [];
  });
  await engageCodecRabbit(player, mode);
  await expect.poll(() => codecRabbitState(player), { timeout: 15_000 })
    .toEqual({
      requestedState: "hover",
      visualState: "hover",
      isTransitioning: false
    });

  const observedFrame = await player.evaluate(async (
    node,
    input: Readonly<{
      mode: CodecRabbitReentryMode;
      targetFrame: number;
    }>
  ) => {
    const element = node as CodecRabbitReentryElement;
    const deadline = performance.now() + 15_000;
    return new Promise<number>((resolveFrame, rejectFrame) => {
      const observe = (): void => {
        const trace = element.getDiagnostics({ trace: true }).runtimeTrace ?? [];
        const presentation = trace.at(-1)?.graph?.presentation;
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
          resolveFrame(presentation.frameIndex);
          return;
        }
        if (
          presentation?.unitId === "hover-out" &&
          typeof presentation.frameIndex === "number" &&
          presentation.frameIndex > input.targetFrame
        ) {
          rejectFrame(new Error(
            `hover-out advanced past frame ${input.targetFrame}`
          ));
          return;
        }
        if (performance.now() >= deadline) {
          rejectFrame(new Error(
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

  await expect.poll(() => codecRabbitState(player), { timeout: 15_000 })
    .toEqual({
      requestedState: "hover",
      visualState: "hover",
      isTransitioning: false
    });
  return player.evaluate((node, frame) => {
    const element = node as CodecRabbitReentryElement;
    const events = element.__codecRabbitReentryEvents ?? [];
    return {
      observedFrame: frame,
      inputEvents: [...(element.__codecRabbitReentryInputs ?? [])],
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

function engageCodecRabbit(
  player: Locator,
  mode: CodecRabbitReentryMode
): Promise<void> {
  return player.evaluate((node, requestedMode) => {
    if (requestedMode === "pointer") {
      node.dispatchEvent(new PointerEvent("pointerenter", {
        pointerType: "mouse"
      }));
    } else {
      (node as HTMLElement).focus();
    }
  }, mode);
}

function disengageCodecRabbit(
  player: Locator,
  mode: CodecRabbitReentryMode
): Promise<void> {
  return player.evaluate((node, requestedMode) => {
    if (requestedMode === "pointer") {
      node.dispatchEvent(new PointerEvent("pointerleave", {
        pointerType: "mouse"
      }));
    } else {
      (node as HTMLElement).blur();
    }
  }, mode);
}

function codecRabbitState(player: Locator): Promise<Readonly<{
  requestedState: string | null;
  visualState: string | null;
  isTransitioning: boolean;
}>> {
  return player.evaluate((node) => {
    const element = node as CodecRabbitReentryElement;
    return {
      requestedState: element.requestedState,
      visualState: element.visualState,
      isTransitioning: element.isTransitioning
    };
  });
}
