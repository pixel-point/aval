import { expect, test } from "@playwright/test";

import {
  CODECS,
  CODEC_LABELS,
  CODEC_PATTERNS,
  SUPPORT_MESSAGES,
  activePlayerSources,
  activePlayerSnapshot,
  captureBrowserFailures,
  codecPanel,
  codecTab,
  expectActiveCodecPlayer,
  expectNoBrowserFailures,
  expectSelectedPanel,
  gateBuildReport,
  installRetainedNonfatalDiagnostic,
  installStaticPreparationOutcome,
  openExample,
  requireId,
  selectedCodec,
  supportSnapshot
} from "./support/browser-harness.js";

function codecFamily(
  value: string | null
): (typeof CODECS)[number] | undefined {
  if (value === null) return undefined;
  return CODECS.find((codec) => CODEC_PATTERNS[codec].test(value));
}

test("keeps the automatic codec ladder intact while explicit tabs stay standalone", async ({
  page
}) => {
  const failures = captureBrowserFailures(page);
  await openExample(page);

  const support = await supportSnapshot(page);
  const automatic = await activePlayerSources(page);
  expect(automatic).toEqual(CODECS);

  const runtimeCodec = (await activePlayerSnapshot(page)).selectedCodec;
  const runtimeFamily = CODECS.find(
    (codec) => runtimeCodec !== null && CODEC_PATTERNS[codec].test(runtimeCodec)
  );
  expect(runtimeFamily).toBeDefined();
  expect(await selectedCodec(page)).toBe(runtimeFamily);

  const explicitCodec = CODECS.find((codec) => support[codec] === "supported");
  expect(explicitCodec).toBeDefined();
  await page.evaluate(async (codec) => {
    await window.grassRabbitCodecs.activate(codec);
  }, explicitCodec!);
  expect(await activePlayerSources(page)).toEqual([explicitCodec]);
  expectNoBrowserFailures(failures);
});

test("does not filter the automatic ladder by preflight state", async ({
  page
}) => {
  const failures = captureBrowserFailures(page);
  await page.goto(
    "/?simulateUnsupported=av1&simulateUnsupported=vp9" +
      "&simulateUnsupported=h265&simulateUnsupported=h264",
    { waitUntil: "domcontentloaded" }
  );
  await page.evaluate(() => window.grassRabbitCodecs.ready);

  expect(await supportSnapshot(page)).toEqual({
    av1: "unsupported",
    vp9: "unsupported",
    h265: "unsupported",
    h264: "unsupported"
  });
  expect(await activePlayerSources(page)).toEqual(CODECS);
  const runtime = await activePlayerSnapshot(page);
  expect(runtime).toMatchObject({
    readiness: "interactiveReady",
    lastFailure: null
  });
  const selectedFamily = codecFamily(runtime.selectedCodec);
  expect(selectedFamily).toBeDefined();
  expect(await selectedCodec(page)).toBe(selectedFamily);
  await expectActiveCodecPlayer(page, selectedFamily!);
  expectNoBrowserFailures(failures);
});

test("keeps automatic terminal exhaustion separate from probe support", async ({
  page
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "one pinned engine is sufficient for the missing-window-codec fixture"
  );
  const failures = captureBrowserFailures(page);
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "VideoDecoder", {
      configurable: true,
      value: undefined
    });
    Object.defineProperty(globalThis, "VideoFrame", {
      configurable: true,
      value: undefined
    });
  });

  await page.goto("/?avalDiagnostics=1", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => window.grassRabbitCodecs.ready);
  const outcome = await page.evaluate(() => {
    const diagnostics = (window as Window & {
      readonly avalBrowserDiagnostics?: { report(): unknown };
    }).avalBrowserDiagnostics;
    if (diagnostics === undefined) {
      throw new Error("browser diagnostics are unavailable");
    }
    const report = diagnostics.report() as Readonly<{
      authoredSources: readonly Readonly<{ codec: string | null }>[];
      checkpoints: readonly Readonly<{
        event: Readonly<{ detail: unknown }> | null;
      }>[];
    }>;
    const fatalCodes = report.checkpoints.flatMap(({ event }) => {
      const detail = event?.detail;
      if (typeof detail !== "object" || detail === null) return [];
      if (Reflect.get(detail, "fatal") !== true) return [];
      const failure = Reflect.get(detail, "failure");
      if (typeof failure !== "object" || failure === null) return [];
      const code = Reflect.get(failure, "code");
      return typeof code === "string" ? [code] : [];
    });
    const stage = document.querySelector<HTMLElement>(
      '#codec-panel-av1 [data-player-stage]'
    );
    const message = document.querySelector<HTMLElement>(
      '#codec-panel-av1 [data-player-message]'
    );
    const tab = document.querySelector<HTMLElement>("#codec-tab-av1");
    return {
      activePlayer: window.grassRabbitCodecs.activePlayer !== null,
      authoredCodecs: report.authoredSources.map(({ codec }) => codec),
      fatalCodes,
      message: message?.textContent?.trim() ?? null,
      runtimeError: stage?.dataset.runtimeError ?? null,
      stageState: stage?.dataset.state ?? null,
      support: window.grassRabbitCodecs.supportSnapshot(),
      tabSupport: tab?.dataset.support ?? null
    };
  });

  expect(outcome.authoredCodecs.map(codecFamily)).toEqual(CODECS);
  expect(outcome.fatalCodes).toContain("unsupported-profile");
  expect(outcome.activePlayer).toBe(false);
  expect(outcome.support.av1).toBe("supported");
  expect(outcome.tabSupport).toBe("supported");
  expect(outcome.runtimeError).toBe("true");
  expect(outcome.stageState).toBe("error");
  expect(outcome.message).toBe(
    "This codec could not be played in your browser."
  );
  expectNoBrowserFailures(failures);
});

test("ready waits for the final pre-setup codec activation", async ({ page }) => {
  test.setTimeout(60_000);
  const failures = captureBrowserFailures(page);
  let releaseReport!: () => void;
  let reportRequested = false;
  const reportGate = new Promise<void>((resolve) => {
    releaseReport = resolve;
  });
  await page.route("**/grass-rabbit/build.json", async (route) => {
    reportRequested = true;
    await reportGate;
    await route.continue();
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect.poll(() => reportRequested).toBe(true);
  await expect.poll(() => page.evaluate(() =>
    window.grassRabbitCodecs !== undefined
  )).toBe(true);

  const outcomePromise = page.evaluate(async () => {
    const api = window.grassRabbitCodecs;
    void api.activate("vp9").catch(() => undefined);
    void api.activate("h264").catch(() => undefined);
    await api.ready;
    const active = api.activePlayer;
    const selected = document.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="true"]'
    )?.dataset.codec ?? null;
    const visible = [...document.querySelectorAll<HTMLElement>(
      '[role="tabpanel"][data-codec]'
    )].find((panel) => !panel.hidden)?.dataset.codec ?? null;
    return {
      selected,
      visible,
      support: api.supportSnapshot().h264,
      activeCodec: active?.closest<HTMLElement>(
        '[role="tabpanel"][data-codec]'
      )?.dataset.codec ?? null,
      activeReadiness: active?.readiness ?? null,
      vp9PlayerCount: document.querySelectorAll(
        '[role="tabpanel"][data-codec="vp9"] aval-player'
      ).length,
      h264PlayerCount: document.querySelectorAll(
        '[role="tabpanel"][data-codec="h264"] aval-player'
      ).length,
      h264Message: document.querySelector<HTMLElement>(
        '[role="tabpanel"][data-codec="h264"] [data-player-message]'
      )?.textContent?.trim() ?? null
    };
  });

  try {
    await expect.poll(() => codecTab(page, "h264").getAttribute("aria-selected"))
      .toBe("true");
  } finally {
    releaseReport();
  }
  const outcome = await outcomePromise;
  expect(outcome).toMatchObject({
    selected: "h264",
    visible: "h264",
    vp9PlayerCount: 0
  });
  if (outcome.support === "supported") {
    expect(outcome).toMatchObject({
      activeCodec: "h264",
      activeReadiness: "interactiveReady",
      h264PlayerCount: 1
    });
  } else {
    expect(outcome).toMatchObject({
      activeCodec: null,
      activeReadiness: null,
      h264PlayerCount: 0,
      h264Message: SUPPORT_MESSAGES[outcome.support]
    });
  }
  expectNoBrowserFailures(failures);
});

test("implements a manual-activation, roving-tabindex codec selector", async ({
  page
}) => {
  const failures = captureBrowserFailures(page);
  await openExample(page);

  const support = await supportSnapshot(page);
  const tablist = page.locator('[role="tablist"]');
  const tabs = tablist.locator('[role="tab"][data-codec]');
  const panels = page.locator('[role="tabpanel"][data-codec]');

  await expect(tablist).toHaveCount(1);
  await expect(tablist).toHaveAccessibleName(/codec/iu);
  await expect(tabs).toHaveCount(CODECS.length);
  await expect(panels).toHaveCount(CODECS.length);
  expect(await tabs.evaluateAll((nodes) => nodes.map((node) =>
    (node as HTMLElement).dataset.codec
  ))).toEqual(CODECS);
  expect(await panels.evaluateAll((nodes) => nodes.map((node) =>
    (node as HTMLElement).dataset.codec
  ))).toEqual(CODECS);

  for (const codec of CODECS) {
    const tab = codecTab(page, codec);
    const panel = codecPanel(page, codec);
    await expect(tab).toHaveAccessibleName(CODEC_LABELS[codec]);
    await expect(tab).toHaveAttribute("aria-controls", await requireId(panel));
    await expect(panel).toHaveAttribute("aria-labelledby", await requireId(tab));

    if (support[codec] === "supported") continue;
    await expect(panel.locator("[data-player-stage]")).toHaveAttribute(
      "data-state",
      support[codec]
    );
    await expect(panel.locator("aval-player")).toHaveCount(0);
    await expect(panel.getByText(SUPPORT_MESSAGES[support[codec]], { exact: true }))
      .toHaveCount(1);
  }

  const initialCodec = await selectedCodec(page);
  const initialIndex = CODECS.indexOf(initialCodec);
  await expectSelectedPanel(page, initialCodec);
  const initialTab = codecTab(page, initialCodec);
  await initialTab.focus();
  await expect(initialTab).toBeFocused();
  const activePlayerBeforeNavigation = await page.evaluateHandle(() =>
    window.grassRabbitCodecs.activePlayer
  );

  const rightCodec = CODECS[(initialIndex + 1) % CODECS.length]!;
  await page.keyboard.press("ArrowRight");
  await expect(codecTab(page, rightCodec)).toBeFocused();
  await expectSelectedPanel(page, initialCodec, rightCodec);
  expect(await page.evaluate(
    (before) => window.grassRabbitCodecs.activePlayer === before,
    activePlayerBeforeNavigation
  )).toBe(true);

  await page.keyboard.press("ArrowLeft");
  await expect(initialTab).toBeFocused();
  await expectSelectedPanel(page, initialCodec);

  await page.keyboard.press("End");
  await expect(codecTab(page, CODECS.at(-1)!)).toBeFocused();
  await expectSelectedPanel(page, initialCodec, CODECS.at(-1)!);

  await page.keyboard.press("Home");
  await expect(codecTab(page, CODECS[0])).toBeFocused();
  await expectSelectedPanel(page, initialCodec, CODECS[0]);

  const enterCodec = initialCodec === CODECS[0] ? CODECS[1] : CODECS[0];
  if (enterCodec !== CODECS[0]) {
    await page.keyboard.press("ArrowRight");
    await expect(codecTab(page, enterCodec)).toBeFocused();
    await expectSelectedPanel(page, initialCodec, enterCodec);
  }
  await page.keyboard.press("Enter");
  await expectSelectedPanel(page, enterCodec);
  await expect(codecTab(page, enterCodec)).toBeFocused();

  const spaceCodec = CODECS[(CODECS.indexOf(enterCodec) + 1) % CODECS.length]!;
  await page.keyboard.press("ArrowRight");
  await expect(codecTab(page, spaceCodec)).toBeFocused();
  await expectSelectedPanel(page, enterCodec, spaceCodec);
  await page.keyboard.press("Space");
  await expectSelectedPanel(page, spaceCodec);
  await expect(codecTab(page, spaceCodec)).toBeFocused();

  await activePlayerBeforeNavigation.dispose();
  for (const codec of CODECS) {
    if (support[codec] === "supported") continue;
    await page.evaluate(async (requested) => {
      await window.grassRabbitCodecs.activate(requested);
    }, codec);
    await expectSelectedPanel(page, codec);
    await expect.poll(() => page.evaluate(() =>
      window.grassRabbitCodecs.activePlayer === null
    )).toBe(true);
    await expect(codecPanel(page, codec).locator("aval-player")).toHaveCount(0);
  }
  expectNoBrowserFailures(failures);
});

test("owns the unsupported-codec state without creating a runtime player", async ({
  page
}) => {
  const failures = captureBrowserFailures(page);
  await page.goto("/?simulateUnsupported=h265", {
    waitUntil: "domcontentloaded"
  });
  await page.evaluate(() => window.grassRabbitCodecs.ready);

  expect(await supportSnapshot(page)).toMatchObject({ h265: "unsupported" });
  await page.evaluate(async () => {
    await window.grassRabbitCodecs.activate("h265");
  });

  await expectSelectedPanel(page, "h265");
  const panel = codecPanel(page, "h265");
  await expect(panel.locator("[data-player-stage]")).toHaveAttribute(
    "data-state",
    "unsupported"
  );
  await expect(panel.getByText(SUPPORT_MESSAGES.unsupported, { exact: true }))
    .toHaveCount(1);
  await expect(panel.locator("aval-player")).toHaveCount(0);
  expect(await page.evaluate(() =>
    window.grassRabbitCodecs.activePlayer === null
  )).toBe(true);
  expectNoBrowserFailures(failures);
});

test("keeps nonfatal static policy pending without claiming rendered playback", async ({
  page
}) => {
  const failures = captureBrowserFailures(page);
  const releaseReport = await gateBuildReport(page);
  await page.goto(
    "/?simulateUnsupported=av1&simulateUnsupported=vp9&simulateUnsupported=h265",
    { waitUntil: "domcontentloaded" }
  );
  await installStaticPreparationOutcome(page, {
    reason: "reduced-motion",
    failure: null
  });
  releaseReport();
  await page.evaluate(() => window.grassRabbitCodecs.ready);
  await page.evaluate(() => window.grassRabbitCodecs.activate("h264"));

  expect(await supportSnapshot(page)).toMatchObject({ h264: "supported" });
  await expectSelectedPanel(page, "h264");
  const panel = codecPanel(page, "h264");
  await expect(codecTab(page, "h264")).toHaveAttribute(
    "data-support",
    "supported"
  );
  await expect(panel.locator("[data-support-badge]")).toHaveText("Supported");
  await expect(panel.locator("[data-player-stage]")).toHaveAttribute(
    "data-state",
    "pending"
  );
  await expect(panel.locator("[data-player-message]"))
    .toHaveText("Motion is waiting for interactive playback…");
  await expect(panel.getByText(SUPPORT_MESSAGES.unsupported, { exact: true }))
    .toHaveCount(0);
  await expectActiveCodecPlayer(page, "h264");
  await expect(panel.locator("aval-player")).not.toHaveAttribute("data-rendered", "");
  await expect(panel.locator(".interaction-hotspot")).not.toHaveClass(/is-rendered/u);
  await expect(page.locator("#probe-status")).toContainText(
    "1 of 4 codecs is available"
  );
  expectNoBrowserFailures(failures);
});

test("reflects live interactive and static policy transitions", async ({ page }) => {
  const failures = captureBrowserFailures(page);
  await page.goto(
    "/?simulateUnsupported=av1&simulateUnsupported=vp9&simulateUnsupported=h265"
  );
  await page.evaluate(() => window.grassRabbitCodecs.ready);
  await page.evaluate(() => window.grassRabbitCodecs.activate("h264"));

  const panel = codecPanel(page, "h264");
  const player = panel.locator("aval-player");
  const hotspot = panel.locator(".interaction-hotspot");
  await expect.poll(() => activePlayerSnapshot(page), { timeout: 45_000 })
    .toMatchObject({ readiness: "interactiveReady", lastFailure: null });
  await expect(panel.locator("[data-player-stage]"))
    .toHaveAttribute("data-state", "ready");
  await expect(player).toHaveAttribute("data-rendered", "");
  await expect(hotspot).toHaveClass(/is-rendered/u);

  await player.evaluate((node) => {
    Object.defineProperty(node, "readiness", {
      configurable: true,
      get: () => "staticReady"
    });
    node.dispatchEvent(new CustomEvent("readinesschange"));
  });
  await expect(panel.locator("[data-player-stage]"))
    .toHaveAttribute("data-state", "pending");
  await expect(panel.locator("[data-player-message]"))
    .toHaveText("Motion is waiting for interactive playback…");
  await expect(player).not.toHaveAttribute("data-rendered", "");
  await expect(hotspot).not.toHaveClass(/is-rendered/u);

  await player.evaluate((node) => {
    delete (node as HTMLElement & { readiness?: string }).readiness;
    node.dispatchEvent(new CustomEvent("readinesschange"));
  });
  await expect.poll(() => activePlayerSnapshot(page), { timeout: 45_000 })
    .toMatchObject({ readiness: "interactiveReady", lastFailure: null });
  await expect(panel.locator("[data-player-stage]"))
    .toHaveAttribute("data-state", "ready");
  await expect(panel.locator("[data-player-message]")).toHaveText("");
  await expect(player).toHaveAttribute("data-rendered", "");
  await expect(hotspot).toHaveClass(/is-rendered/u);
  expectNoBrowserFailures(failures);
});

test("settles the active panel when playback becomes ready after a caller timeout", async ({
  page
}) => {
  const failures = captureBrowserFailures(page);
  let releaseAsset!: () => void;
  let assetRequested = false;
  const assetGate = new Promise<void>((resolve) => {
    releaseAsset = resolve;
  });
  await page.route("**/grass-rabbit/h264.avl", async (route) => {
    assetRequested = true;
    await assetGate;
    await route.continue();
  });
  const releaseReport = await gateBuildReport(page);
  await page.goto(
    "/?simulateUnsupported=av1&simulateUnsupported=vp9&simulateUnsupported=h265",
    { waitUntil: "domcontentloaded" }
  );
  const releasePreparation = await page.evaluateHandle(async () => {
    await customElements.whenDefined("aval-player");
    const constructor = customElements.get("aval-player");
    if (constructor === undefined) throw new Error("aval-player is undefined");
    const prototype = constructor.prototype;
    const originalPrepare = prototype.prepare as (
      this: HTMLElement,
      options?: Readonly<{ timeoutMs?: number }>
    ) => Promise<unknown>;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    Object.defineProperty(prototype, "prepare", {
      configurable: true,
      value(this: HTMLElement, options?: Readonly<{ timeoutMs?: number }>) {
        void gate.then(() => originalPrepare.call(this, options))
          .catch(() => undefined);
        return Promise.reject(new DOMException(
          "synthetic caller-local preparation timeout",
          "TimeoutError"
        ));
      }
    });
    return release;
  });
  await page.evaluate(() => {
    void window.grassRabbitCodecs.activate("h264").catch(() => undefined);
  });
  releaseReport();

  const readyOutcome = await page.evaluate(async () => {
    try {
      await window.grassRabbitCodecs.ready;
      return "fulfilled";
    } catch (error) {
      return error instanceof DOMException ? error.name : "unknown";
    }
  });
  const panel = codecPanel(page, "h264");
  await expectActiveCodecPlayer(page, "h264");
  expect(readyOutcome).toBe("fulfilled");
  await expect(panel.locator("[data-player-stage]"))
    .not.toHaveAttribute("aria-busy", "true");
  try {
    await expect(panel.locator("[data-player-stage]"))
      .toHaveAttribute("data-state", "pending");
    await expect(panel.locator("[data-player-message]"))
      .toHaveText("Preparation is continuing in the background…");
    await expect.poll(() => assetRequested).toBe(true);
  } finally {
    await page.evaluate((release) => release(), releasePreparation);
    releaseAsset();
    await releasePreparation.dispose();
  }
  await expect.poll(() => activePlayerSnapshot(page), { timeout: 45_000 })
    .toMatchObject({ readiness: "interactiveReady", lastFailure: null });
  await expect(panel.locator("[data-player-stage]"))
    .toHaveAttribute("data-state", "ready");
  await expect(panel.locator("[data-player-message]")).toHaveText("");
  expectNoBrowserFailures(failures);
});

test("ignores retained nonfatal diagnostics after successful preparation", async ({
  page
}) => {
  const failures = captureBrowserFailures(page);
  const releaseReport = await gateBuildReport(page);
  await page.goto(
    "/?simulateUnsupported=av1&simulateUnsupported=vp9&simulateUnsupported=h265",
    { waitUntil: "domcontentloaded" }
  );
  await installRetainedNonfatalDiagnostic(page, Object.freeze({
    code: "readiness-failure",
    message: "AVAL operation failed (readiness-failure)",
    operation: "motion-policy-enter-full"
  }));
  releaseReport();
  await page.evaluate(() => window.grassRabbitCodecs.ready);
  await page.evaluate(() => window.grassRabbitCodecs.activate("h264"));

  expect(await supportSnapshot(page)).toMatchObject({ h264: "supported" });
  await expectSelectedPanel(page, "h264");
  const panel = codecPanel(page, "h264");
  await expect(codecTab(page, "h264")).toHaveAttribute(
    "data-support",
    "supported"
  );
  await expect(panel.locator("[data-player-stage]")).toHaveAttribute(
    "data-state",
    "ready"
  );
  await expect(panel.getByText(
    "This codec could not be played in your browser.",
    { exact: true }
  )).toHaveCount(0);
  await expect(panel.getByText(SUPPORT_MESSAGES.unsupported, { exact: true }))
    .toHaveCount(0);
  await expectActiveCodecPlayer(page, "h264");
  expectNoBrowserFailures(failures);
});

test("ignores nonfatal diagnostics and persists fatal unsupported playback across tab retirement", async ({
  page
}) => {
  const failures = captureBrowserFailures(page);
  await openExample(page);
  const support = await supportSnapshot(page);
  const supported = CODECS.filter((codec) => support[codec] === "supported");
  const playable: typeof supported = [];
  for (const codec of supported) {
    await codecTab(page, codec).click();
    await codecPanel(page, codec).scrollIntoViewIfNeeded();
    await page.evaluate(async (requested) => {
      await window.grassRabbitCodecs.activate(requested);
    }, codec);
    const snapshot = await activePlayerSnapshot(page);
    if (snapshot.readiness === "interactiveReady" && snapshot.lastFailure === null) {
      playable.push(codec);
    }
  }
  test.skip(playable.length < 2, "this browser exposes fewer than two playable codecs");
  const failedCodec = playable[0]!;
  const nextCodec = playable[1]!;

  await page.evaluate(async (codec) => {
    await window.grassRabbitCodecs.activate(codec);
  }, failedCodec);
  await expectActiveCodecPlayer(page, failedCodec);
  await expect.poll(() => activePlayerSnapshot(page), { timeout: 45_000 })
    .toMatchObject({ readiness: "interactiveReady", lastFailure: null });

  await page.evaluate(() => {
    const player = window.grassRabbitCodecs.activePlayer;
    if (player === null) throw new Error("active player is unavailable");
    player.dispatchEvent(new CustomEvent("error", {
      detail: Object.freeze({
        generation: 1,
        failure: Object.freeze({
          code: "worker-decode-failure",
          message: "nonfatal candidate diagnostic",
          operation: "test-nonfatal"
        }),
        fatal: false
      })
    }));
  });
  await expect(codecPanel(page, failedCodec).locator("[data-player-stage]"))
    .toHaveAttribute("data-state", "ready");
  await expect(codecPanel(page, failedCodec).locator("[data-player-message]"))
    .toHaveText("");
  await expectActiveCodecPlayer(page, failedCodec);

  const releaseDispose = await page.evaluateHandle(() => {
    const player = window.grassRabbitCodecs.activePlayer;
    if (player === null) throw new Error("active player is unavailable");
    const originalDispose = player.dispose.bind(player);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    Object.defineProperty(player, "dispose", {
      configurable: true,
      value: async () => {
        await gate;
        return originalDispose();
      }
    });
    return release;
  });

  await page.evaluate(() => {
    const player = window.grassRabbitCodecs.activePlayer;
    if (player === null) throw new Error("active player is unavailable");
    player.dispatchEvent(new CustomEvent("error", {
      detail: Object.freeze({
        generation: 1,
        failure: Object.freeze({
          code: "unsupported-profile",
          message: "fatal unsupported profile",
          operation: "test-fatal"
        }),
        fatal: true
      })
    }));
  });
  await page.evaluate((codec) => {
    void window.grassRabbitCodecs.activate(codec).catch(() => undefined);
  }, nextCodec);

  await expectSelectedPanel(page, nextCodec);
  await expect.poll(() => supportSnapshot(page)).toMatchObject({
    [failedCodec]: "unsupported"
  });
  await expect(codecTab(page, failedCodec)).toHaveAttribute(
    "data-support",
    "unsupported"
  );

  await page.evaluate((release) => release(), releaseDispose);
  await releaseDispose.dispose();
  await expectActiveCodecPlayer(page, nextCodec);
  await expect.poll(() => activePlayerSnapshot(page), { timeout: 45_000 })
    .toMatchObject({ readiness: "interactiveReady", lastFailure: null });
  expectNoBrowserFailures(failures);
});
