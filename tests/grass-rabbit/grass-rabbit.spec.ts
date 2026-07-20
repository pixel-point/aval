import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";
import type { AvalElement } from "@pixel-point/aval-element";
import { parseFrontIndex } from "@pixel-point/aval-format";

const BUNDLE_PATH = resolve("examples/grass-rabbit/public/grass-rabbit");
const PROJECT_PATH = resolve("examples/grass-rabbit/motion.json");
const SOURCE_PATH = resolve(
  "examples/grass-rabbit/source/grass-test-with-intro.mp4"
);
const INDEX_PATH = resolve("examples/grass-rabbit/index.html");
const BUILD_REPORT_PATH = resolve(BUNDLE_PATH, "build.json");
const CODECS = ["av1", "vp9", "h265", "h264"] as const;

test("preserves the authored 1280x720 graph and exact frame ranges", async () => {
  const project = JSON.parse(await readFile(PROJECT_PATH, "utf8")) as {
    sources: { path: string }[];
    encodings: unknown[];
    units: { id: string; range: [number, number] }[];
  };
  const report = JSON.parse(await readFile(BUILD_REPORT_PATH, "utf8")) as {
    reportVersion: string;
    warnings: string[];
    encodings: unknown[];
    assets: {
      bytes: number;
      codec: typeof CODECS[number];
      codecString: string;
      integrity: string;
      path: string;
      sha256: string;
      type: string;
    }[];
    sourceMarkup: string;
    invocations: {
      arguments: string[];
      operation: string;
      tool: string;
    }[];
  };
  const sourceBytes = new Uint8Array(await readFile(SOURCE_PATH));
  const html = await readFile(INDEX_PATH, "utf8");
  const fronts = new Map<typeof CODECS[number], ReturnType<typeof parseFrontIndex>>();
  const assetLengths = new Map<typeof CODECS[number], number>();

  expect(report.reportVersion).toBe("1.0");
  expect(report.assets.map(({ codec, path }) => ({ codec, path }))).toEqual(
    CODECS.map((codec) => ({ codec, path: `${codec}.avl` }))
  );
  expect(report.sourceMarkup).toBe(report.assets.map((asset) =>
    `<source src="${asset.path}" type='${asset.type}' integrity="${asset.integrity}">`
  ).join("\n"));
  for (const asset of report.assets) {
    const bytes = new Uint8Array(await readFile(resolve(BUNDLE_PATH, asset.path)));
    const frontIndex = parseFrontIndex(bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const integrity = `sha256-${createHash("sha256")
      .update(bytes).digest("base64")}`;
    const sourceElement = `<source src="%BASE_URL%grass-rabbit/${asset.path}" ` +
      `type='${asset.type}' integrity="${asset.integrity}">`;

    expect(bytes.subarray(0, 4)).toEqual(new Uint8Array([65, 86, 76, 70]));
    expect(bytes.byteLength).toBe(asset.bytes);
    expect(digest).toBe(asset.sha256);
    expect(integrity).toBe(asset.integrity);
    expect(frontIndex.header.declaredFileLength).toBe(asset.bytes);
    expect(frontIndex.manifest.codec).toBe(asset.codec);
    expect(frontIndex.manifest.renditions[0]?.codec).toBe(asset.codecString);
    expect(asset.type).toBe(
      `application/vnd.aval; codecs="${asset.codecString}"`
    );
    expect(html).toContain(sourceElement);
    fronts.set(asset.codec, frontIndex);
    assetLengths.set(asset.codec, bytes.byteLength);
  }

  const front = fronts.get("h264");
  if (front === undefined) throw new Error("Missing compiled H.264 asset");
  const manifest = front.manifest;
  const units = new Map(manifest.units.map((unit) => [unit.id, unit]));
  const rendition = manifest.renditions[0];

  expect(manifest.canvas).toMatchObject({
    width: 1280,
    height: 720,
    fit: "contain"
  });
  expect(manifest.frameRate).toEqual({ numerator: 24, denominator: 1 });
  expect("staticFrames" in manifest).toBe(false);
  expect("fallback" in manifest).toBe(false);
  expect("staticBlobs" in front).toBe(false);
  expect(Math.max(...front.unitBlobs.map(({ offset, length }) =>
    offset + length
  ))).toBe(assetLengths.get("h264"));
  expect(project.sources.map(({ path }) => path)).toEqual([
    "source/grass-test-with-intro.mp4"
  ]);
  expect(sourceBytes.byteLength).toBe(7_321_326);
  expect(createHash("sha256").update(sourceBytes).digest("hex")).toBe(
    "546acee64cc36c13f8765e215a0a20fb5742026c57364c59560fa86bb68988b1"
  );
  expect(report.encodings).toEqual([
    {
      bitDepth: 8,
      codec: "av1",
      cpuUsed: 6,
      renditions: [{ crf: 36, height: 360, id: "video.1x", width: 640 }],
      rowMt: true,
      threads: 8,
      tiles: { columns: 2, rows: 2 }
    },
    {
      codec: "vp9",
      cpuUsed: 4,
      deadline: "good",
      renditions: [{ crf: 38, height: 360, id: "video.1x", width: 640 }],
      threads: 8
    },
    {
      codec: "h265",
      preset: "medium",
      renditions: [{ crf: 30, height: 360, id: "video.1x", width: 640 }],
      threads: 8
    },
    {
      codec: "h264",
      preset: "medium",
      renditions: [{ crf: 26, height: 360, id: "video.1x", width: 640 }]
    }
  ]);
  const encodeInvocations = report.invocations.filter(
    ({ operation }) => operation.startsWith("h264:video.1x:") &&
      operation.endsWith(":encode")
  );
  expect(encodeInvocations).toHaveLength(5);
  for (const invocation of encodeInvocations) {
    expect(invocation.tool).toBe("ffmpeg");
    expect(invocation.arguments).toEqual(expect.arrayContaining([
      "-preset",
      "medium",
      "-crf",
      "26"
    ]));
    expect(invocation.arguments).not.toContain("-b:v");
  }
  expect(report.warnings).toEqual([]);
  expect(project.units.map(({ id, range }) => ({ id, range }))).toEqual([
    { id: "intro", range: [0, 30] },
    { id: "idle-loop", range: [30, 100] },
    { id: "hover-in", range: [100, 167] },
    { id: "hover-loop", range: [167, 263] },
    { id: "hover-out", range: [263, 311] }
  ]);
  expect(rendition).toMatchObject({
    id: "video.1x",
    codec: "avc1.42E01E",
    bitDepth: 8,
    codedWidth: 640,
    codedHeight: 368,
    alphaLayout: { type: "opaque", colorRect: [0, 0, 640, 360] }
  });
  expect(units.get("idle-loop")).toMatchObject({
    kind: "body",
    playback: "loop",
    frameCount: 70
  });
  expect(units.get("intro")).toMatchObject({
    id: "intro",
    kind: "one-shot",
    frameCount: 30
  });
  expect(units.get("hover-in")).toMatchObject({
    kind: "body",
    playback: "finite",
    ports: [{ id: "default", entryFrame: 0, portalFrames: [66] }],
    frameCount: 67
  });
  expect(units.get("hover-loop")).toMatchObject({
    kind: "body",
    playback: "loop",
    frameCount: 96
  });
  expect(units.get("hover-out")).toMatchObject({
    kind: "body",
    playback: "finite",
    ports: [{ id: "default", entryFrame: 0, portalFrames: [47] }],
    frameCount: 48
  });
  expect(manifest.states).toEqual([
    { id: "entering", bodyUnit: "hover-in" },
    { id: "exiting", bodyUnit: "hover-out" },
    { id: "hover", bodyUnit: "hover-loop" },
    { id: "idle", bodyUnit: "idle-loop", initialUnit: "intro" }
  ]);
  expect(manifest.readiness).toEqual({
    bootstrapUnits: ["hover-in", "idle-loop", "intro"],
    immediateEdges: ["idle.entering"],
    policy: "all-routes"
  });
  expect(manifest.edges.map((edge) => ({
    id: edge.id,
    from: edge.from,
    to: edge.to,
    trigger: edge.trigger,
    start: edge.start.type
  }))).toEqual([
    {
      id: "entering.exiting",
      from: "entering",
      to: "exiting",
      trigger: { type: "event", name: "hover.leave" },
      start: "finish"
    },
    {
      id: "entering.hover",
      from: "entering",
      to: "hover",
      trigger: { type: "completion" },
      start: "finish"
    },
    {
      id: "exiting.entering",
      from: "exiting",
      to: "entering",
      trigger: { type: "event", name: "hover.enter" },
      start: "finish"
    },
    {
      id: "exiting.idle",
      from: "exiting",
      to: "idle",
      trigger: { type: "completion" },
      start: "finish"
    },
    {
      id: "hover.exiting",
      from: "hover",
      to: "exiting",
      trigger: { type: "event", name: "hover.leave" },
      start: "portal"
    },
    {
      id: "idle.entering",
      from: "idle",
      to: "entering",
      trigger: { type: "event", name: "hover.enter" },
      start: "portal"
    }
  ]);
  expect(manifest.bindings).toEqual([
    { source: "engagement.off", event: "hover.leave" },
    { source: "engagement.on", event: "hover.enter" }
  ]);
  for (const codec of CODECS) {
    const candidate = fronts.get(codec);
    if (candidate === undefined) throw new Error(`Missing compiled ${codec} asset`);
    expect(candidate.manifest.canvas).toEqual(manifest.canvas);
    expect(candidate.manifest.frameRate).toEqual(manifest.frameRate);
    expect(candidate.manifest.units.map(({ chunks: _chunks, ...unit }) => unit))
      .toEqual(manifest.units.map(({ chunks: _chunks, ...unit }) => unit));
    expect(candidate.manifest.states).toEqual(manifest.states);
    expect(candidate.manifest.edges).toEqual(manifest.edges);
    expect(candidate.manifest.bindings).toEqual(manifest.bindings);
    expect(candidate.manifest.readiness).toEqual(manifest.readiness);
    expect(candidate.graph).toEqual(front.graph);
  }
});

test("reports the authored phase that is actually displayed", async ({
  page
}) => {
  await page.goto("/");
  const motion = page.locator("#grass-rabbit");
  const stateLabel = page.locator("#rabbit-state");

  await expect
    .poll(() => motion.evaluate((node) => (
      node as AvalElement
    ).readiness), { timeout: 5_000 })
    .toBe("interactiveReady");
  await expect
    .poll(() => motion.evaluate((node) => {
      const trace = (node as AvalElement)
        .getDiagnostics({ trace: true }).runtimeTrace ?? [];
      const presentation = trace.at(-1)?.graph?.presentation as Readonly<{
        unitId?: string;
      }> | null | undefined;
      return presentation?.unitId ?? null;
    }))
    .toBe("intro");
  await expect(stateLabel).toHaveText("intro");

  await expect
    .poll(() => motion.evaluate((node) => {
      const trace = (node as AvalElement)
        .getDiagnostics({ trace: true }).runtimeTrace ?? [];
      const presentation = trace.at(-1)?.graph?.presentation as Readonly<{
        unitId?: string;
      }> | null | undefined;
      return presentation?.unitId ?? null;
    }), { timeout: 5_000 })
    .toBe("idle-loop");
  await expect(stateLabel).toHaveText("idle");
  await expect(stateLabel).not.toHaveAttribute("data-visible");

  await motion.hover();
  await expect
    .poll(() => motion.evaluate((node) => (
      node as AvalElement
    ).visualState), { timeout: 5_000 })
    .toBe("entering");
  await expect(stateLabel).toHaveText("entering");
  await expect(stateLabel).toHaveAttribute("data-visible", "");
});

test("keeps the interaction hotspot hidden until the video is rendered", async ({
  page
}) => {
  let releaseAsset!: () => void;
  const assetHeld = new Promise<void>((resolve) => {
    releaseAsset = resolve;
  });

  await page.route("**/grass-rabbit/*.avl", async (route) => {
    await assetHeld;
    await route.continue();
  });
  await page.goto("/");

  const motion = page.locator("#grass-rabbit");
  const hotspot = page.locator(".interaction-hotspot");
  await expect(hotspot).toHaveCSS("opacity", "0");

  releaseAsset();
  await expect
    .poll(() => motion.evaluate((node) => (
      node as AvalElement
    ).readiness), { timeout: 5_000 })
    .toBe("interactiveReady");
  await expect(hotspot).toHaveCSS("opacity", "1");
});

test("does not label nonfatal static policy as rendered motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const motion = page.locator("#grass-rabbit");
  const hotspot = page.locator(".interaction-hotspot");
  await expect.poll(() => motion.evaluate((node) => ({
    readiness: (node as AvalElement).readiness,
    staticReason: (node as AvalElement).staticReason
  }))).toEqual({
    readiness: "staticReady",
    staticReason: "reduced-motion"
  });
  await expect(motion).not.toHaveAttribute("data-rendered", "");
  await expect(hotspot).not.toHaveClass(/is-rendered/u);
  await expect(hotspot).toHaveCSS("opacity", "0");
});

test("reflects live interactive and static policy transitions", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");

  const motion = page.locator("#grass-rabbit");
  const hotspot = page.locator(".interaction-hotspot");
  await expect.poll(() => motion.evaluate((node) => (
    node as AvalElement
  ).readiness)).toBe("interactiveReady");
  await expect(motion).toHaveAttribute("data-rendered", "");
  await expect(hotspot).toHaveClass(/is-rendered/u);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => motion.evaluate((node) => (
    node as AvalElement
  ).readiness)).toBe("staticReady");
  await expect(motion).not.toHaveAttribute("data-rendered", "");
  await expect(hotspot).not.toHaveClass(/is-rendered/u);

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(() => motion.evaluate((node) => (
    node as AvalElement
  ).readiness)).toBe("interactiveReady");
  await expect(motion).toHaveAttribute("data-rendered", "");
  await expect(hotspot).toHaveClass(/is-rendered/u);
});

test("plays the intro once in the responsive product page", async ({
  page
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.mouse.move(0, 0);
  await page.goto("/");
  const motion = page.locator("#grass-rabbit");
  await expect
    .poll(
      () => motion.evaluate((node) => (
        node as HTMLElement & { readiness: string }
      ).readiness),
      { timeout: 5_000 }
    )
    .toBe("interactiveReady");

  const introActivation = await motion.evaluate((node) => {
    const trace = (node as AvalElement)
      .getDiagnostics({ trace: true }).runtimeTrace ?? [];
    const record = trace.find((entry) => {
      const presentation = entry.graph?.presentation as Readonly<{
        kind?: string;
        frameIndex?: number;
      }> | null | undefined;
      return presentation?.kind === "intro" &&
        presentation.frameIndex === 0;
    });
    const presentation = record?.graph?.presentation as Readonly<{
      kind?: string;
      state?: string;
      unitId?: string;
      frameIndex?: number;
    }> | null | undefined;
    return record === undefined ? null : {
      kind: presentation?.kind ?? null,
      state: presentation?.state ?? null,
      unit: presentation?.unitId ?? null,
      frame: presentation?.frameIndex ?? null,
      readbackTag: record.readbackTag
    };
  });
  expect(introActivation).toEqual({
    kind: "intro",
    state: "idle",
    unit: "intro",
    frame: 0,
    readbackTag: "intro:idle:intro:0"
  });

  const startupMs = await page.evaluate(() => performance.now());
  expect(startupMs).toBeLessThan(5_000);

  const initialLayers = await motion.evaluate((node) => {
    return {
      canvasCount: node.shadowRoot?.querySelectorAll("canvas").length ?? 0,
      hasStaticLayer: node.shadowRoot?.querySelector(
        '[data-aval-layer="static"]'
      ) !== null,
      fallbackSlotCount: node.shadowRoot?.querySelectorAll('slot[name="fallback"]')
        .length ?? 0
    };
  });
  expect(initialLayers).toEqual({
    canvasCount: 1,
    hasStaticLayer: false,
    fallbackSlotCount: 0
  });

  const interactiveSurface = await motion.evaluate((node) => {
    const animated = node.shadowRoot!.querySelector<HTMLCanvasElement>(
      'canvas[data-aval-layer="animated"]'
    );
    const diagnostics = (node as HTMLElement & {
      getDiagnostics(): {
        presentation: {
          cssWidth: number;
          cssHeight: number;
          backingWidth: number;
          backingHeight: number;
          effectiveDprX: number;
          effectiveDprY: number;
        };
      };
    }).getDiagnostics();
    return animated === null ? null : {
      width: animated.width,
      height: animated.height,
      display: getComputedStyle(animated).display,
      canvasCount: node.shadowRoot!.querySelectorAll("canvas").length,
      fallbackSlotCount: node.shadowRoot!.querySelectorAll('slot[name="fallback"]')
        .length,
      presentation: diagnostics.presentation
    };
  });
  expect(interactiveSurface).toEqual({
    width: 1280,
    height: 720,
    display: "block",
    canvasCount: 1,
    fallbackSlotCount: 0,
    presentation: expect.objectContaining({
      cssWidth: 640,
      cssHeight: 360,
      backingWidth: 1280,
      backingHeight: 720,
      effectiveDprX: 2,
      effectiveDprY: 2
    })
  });

  const screenshot = await motion.screenshot({ scale: "device" });
  const sampledFrame = await page.evaluate(async (source) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context === null) throw new Error("screenshot sampler is unavailable");
    context.drawImage(image, 0, 0);
    const colors = new Set<string>();
    for (let row = 0; row < 8; row += 1) {
      for (let column = 0; column < 8; column += 1) {
        const x = Math.min(
          canvas.width - 1,
          Math.floor((column + 0.5) * canvas.width / 8)
        );
        const y = Math.min(
          canvas.height - 1,
          Math.floor((row + 0.5) * canvas.height / 8)
        );
        colors.add(context.getImageData(x, y, 1, 1).data.join(","));
      }
    }
    return {
      width: canvas.width,
      height: canvas.height,
      uniqueSampledColors: colors.size
    };
  }, `data:image/png;base64,${screenshot.toString("base64")}`);
  expect(sampledFrame).toEqual({
    width: 1280,
    height: 720,
    uniqueSampledColors: expect.any(Number)
  });
  expect(sampledFrame.uniqueSampledColors).toBeGreaterThan(8);

  const layout = await motion.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    const bodyStyle = getComputedStyle(document.body);
    const title = document.querySelector("[data-title]");
    const description = document.querySelector("[data-description]");
    return {
      background: bodyStyle.backgroundColor,
      width: bounds.width,
      height: bounds.height,
      centerX: bounds.left + bounds.width / 2,
      viewportX: innerWidth / 2,
      title: title?.textContent?.trim() ?? null,
      description: description?.textContent?.trim() ?? null
    };
  });
  expect(layout).toMatchObject({
    background: "rgb(0, 0, 0)",
    width: 640,
    height: 360,
    viewportX: 640,
    title: "Introducing AVAL",
    description: "A new open-source format for interactive video on the web, with a built-in state machine, frame-accurate transitions, and packed-alpha transparency."
  });
  expect(Math.abs(layout.centerX - layout.viewportX)).toBeLessThanOrEqual(0.5);

  await expect
    .poll(() => motion.evaluate((node) => {
      const trace = (node as AvalElement)
        .getDiagnostics({ trace: true }).runtimeTrace ?? [];
      const presentation = trace.at(-1)?.graph?.presentation as Readonly<{
        kind?: string;
        unitId?: string;
        frameIndex?: number;
      }> | null | undefined;
      return presentation?.kind === "body" &&
        presentation.unitId === "idle-loop" &&
        typeof presentation.frameIndex === "number" &&
        presentation.frameIndex >= 2;
    }), { timeout: 10_000 })
    .toBe(true);

  const introLedger = await motion.evaluate((node) => {
    const diagnostics = (node as AvalElement)
      .getDiagnostics({ trace: true });
    const trace = diagnostics.runtimeTrace ?? [];
    const content = trace.flatMap((record) => {
      const presentation = record.graph?.presentation as Readonly<{
        kind?: string;
        unitId?: string;
        frameIndex?: number;
      }> | null | undefined;
      const media = record.media as Readonly<{
        kind?: string;
        frame?: Readonly<{ unit?: string; localFrame?: number }>;
      }> | null;
      if (record.kind !== "content-tick") return [];
      return [{
        index: record.index,
        kind: presentation?.kind ?? null,
        unit: presentation?.unitId ?? null,
        frame: presentation?.frameIndex ?? null,
        mediaKind: media?.kind ?? null,
        mediaUnit: media?.frame?.unit ?? null,
        mediaFrame: media?.frame?.localFrame ?? null
      }];
    });
    const intro = content.filter(({ kind, unit }) =>
      kind === "intro" && unit === "intro"
    );
    const firstIdle = content.find(({ kind, unit }) =>
      kind === "body" && unit === "idle-loop"
    );
    return {
      counters: diagnostics.counters,
      intro,
      firstIdle: firstIdle ?? null,
      introAfterIdle: firstIdle === undefined ? true : content.some((record) =>
        record.index > firstIdle.index && record.kind === "intro"
      )
    };
  });
  expect(introLedger.intro.map(({ frame }) => frame)).toEqual(
    Array.from({ length: 29 }, (_, index) => index + 1)
  );
  for (const record of introLedger.intro) {
    expect(record).toMatchObject({
      kind: "intro",
      unit: "intro",
      mediaKind: "frame",
      mediaUnit: "intro",
      mediaFrame: record.frame
    });
  }
  expect(introLedger.firstIdle).toMatchObject({
    kind: "body",
    unit: "idle-loop",
    frame: 0,
    mediaKind: "frame",
    mediaUnit: "idle-loop",
    mediaFrame: 0
  });
  expect(introLedger.introAfterIdle).toBe(false);
  expect(introLedger.counters.underflow).toBe(0);
  const firstIdleTraceIndex = introLedger.firstIdle!.index;

  await expect
    .poll(() => motion.evaluate((node) => (
      node as HTMLElement & { visualState: string | null }
    ).visualState))
    .toBe("idle");
  await page.mouse.move(0, 0);
  await motion.hover();
  await expect
    .poll(() => motion.evaluate((node) => (
      node as HTMLElement & { visualState: string | null }
    ).visualState), { timeout: 15_000 })
    .toBe("entering");
  await expect
    .poll(() => motion.evaluate((node) => (
      node as HTMLElement & { visualState: string | null }
    ).visualState), { timeout: 15_000 })
    .toBe("hover");
  await expect
    .poll(() => motion.evaluate((node) => (
      node as HTMLElement & { isTransitioning: boolean }
    ).isTransitioning))
    .toBe(false);

  await page.mouse.move(0, 0);
  await expect
    .poll(() => motion.evaluate((node) => (
      node as HTMLElement & { visualState: string | null }
    ).visualState), { timeout: 15_000 })
    .toBe("exiting");
  await expect
    .poll(() => motion.evaluate((node) => (
      node as HTMLElement & { visualState: string | null }
    ).visualState), { timeout: 15_000 })
    .toBe("idle");
  await expect
    .poll(() => motion.evaluate((node) => (
      node as HTMLElement & { isTransitioning: boolean }
    ).isTransitioning))
    .toBe(false);
  const finalDiagnostics = await motion.evaluate((node, firstIdleIndex) => {
    const diagnostics = (node as AvalElement)
      .getDiagnostics({ trace: true });
    return {
      counters: diagnostics.counters,
      lastFailure: diagnostics.lastFailure,
      replayedIntro: (diagnostics.runtimeTrace ?? []).some((record) => {
        const presentation = record.graph?.presentation as Readonly<{
          kind?: string;
        }> | null | undefined;
        return record.index > firstIdleIndex && presentation?.kind === "intro";
      })
    };
  }, firstIdleTraceIndex);
  expect(finalDiagnostics).toMatchObject({
    counters: {
      underflow: 0
    },
    lastFailure: null,
    replayedIntro: false
  });
  expect(consoleErrors).toEqual([]);
});

test("plays hover-out directly after hover-in when the pointer leaves early", async ({
  page
}) => {
  let releaseAsset!: () => void;
  const assetGate = new Promise<void>((resolveGate) => {
    releaseAsset = resolveGate;
  });
  await page.route("**/grass-rabbit/*.avl", async (route) => {
    await assetGate;
    await route.continue();
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const motion = page.locator("#grass-rabbit");
  await motion.hover();
  releaseAsset();
  await expect
    .poll(() => motion.evaluate((node) => (
      node as AvalElement
    ).readiness), { timeout: 5_000 })
    .toBe("interactiveReady");

  const startupPresentation = await motion.evaluate((node) => {
    const trace = (node as AvalElement)
      .getDiagnostics({ trace: true }).runtimeTrace ?? [];
    const record = trace.find((entry) => {
      const presentation = entry.graph?.presentation as Readonly<{
        kind?: string;
        frameIndex?: number;
      }> | null | undefined;
      return presentation?.kind === "intro" &&
        presentation.frameIndex === 0;
    });
    return record?.graph?.presentation ?? null;
  });
  expect(startupPresentation).toMatchObject({
    kind: "intro",
    state: "idle",
    unitId: "intro",
    frameIndex: 0
  });

  const traceStart = await motion.evaluate((node) => {
    const trace = (node as AvalElement)
      .getDiagnostics({ trace: true }).runtimeTrace ?? [];
    return trace.at(-1)?.index ?? -1;
  });
  await expect
    .poll(() => motion.evaluate((node) => {
      const trace = (node as AvalElement)
        .getDiagnostics({ trace: true }).runtimeTrace ?? [];
      const presentation = trace.at(-1)?.graph?.presentation as Readonly<{
        kind?: string;
        unitId?: string;
        frameIndex?: number;
      }> | null | undefined;
      return (presentation?.kind === "locked" || presentation?.kind === "body") &&
        presentation.unitId === "hover-in" &&
        typeof presentation.frameIndex === "number" &&
        presentation.frameIndex >= 8 && presentation.frameIndex < 66;
    }), { timeout: 10_000 })
    .toBe(true);

  const requestedBeforeLeave = await motion.evaluate((node) => (
    node as AvalElement
  ).requestedState);
  expect(requestedBeforeLeave).toBe("entering");
  await page.locator("body").hover({ position: { x: 8, y: 8 } });
  await expect
    .poll(() => motion.evaluate((node) => {
      const element = node as AvalElement;
      return !node.matches(":hover") &&
        element.requestedState === "exiting";
    }))
    .toBe(true);
  await expect
    .poll(() => motion.evaluate((node) => {
      const element = node as AvalElement;
      return element.requestedState === "idle" &&
        element.visualState === "idle" && !element.isTransitioning;
    }), { timeout: 15_000 })
    .toBe(true);

  const routeFrames = await motion.evaluate((node, startIndex) => {
    const trace = (node as AvalElement)
      .getDiagnostics({ trace: true }).runtimeTrace ?? [];
    return trace.flatMap((record) => {
      if (record.index <= startIndex) return [];
      const media = record.media as Readonly<{
        kind?: string;
        frame?: Readonly<{ unit?: string; localFrame?: number }>;
      }> | null;
      if (
        media?.kind !== "frame" ||
        typeof media.frame?.unit !== "string" ||
        typeof media.frame.localFrame !== "number" ||
        !["hover-in", "hover-loop", "hover-out"].includes(media.frame.unit)
      ) return [];
      return [{ unit: media.frame.unit, frame: media.frame.localFrame }];
    });
  }, traceStart);
  const framesFor = (unit: string): number[] => routeFrames
    .filter((frame) => frame.unit === unit)
    .map((frame) => frame.frame);

  expect(framesFor("hover-in")).toEqual(
    Array.from({ length: 67 }, (_, frame) => frame)
  );
  expect(framesFor("hover-loop")).toEqual([]);
  expect(framesFor("hover-out")).toEqual(
    Array.from({ length: 48 }, (_, frame) => frame)
  );
});

test("routes touch taps outside and during entering or exiting", async ({
  browser
}, testInfo) => {
  test.setTimeout(2 * 60_000);
  const configuredBaseUrl = testInfo.project.use.baseURL;
  if (typeof configuredBaseUrl !== "string") {
    throw new Error("grass-rabbit touch test requires a configured base URL");
  }
  const context = await browser.newContext({
    baseURL: configuredBaseUrl,
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 }
  });
  const page = await context.newPage();
  const failures = { consoleErrors: [] as string[], pageErrors: [] as string[] };
  page.on("console", (message) => {
    if (message.type() === "error") failures.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => failures.pageErrors.push(error.message));
  try {
    await page.goto("/");
    const motion = page.locator("#grass-rabbit");
    await expect.poll(() => motion.evaluate((node) => (
      node as AvalElement
    ).readiness), { timeout: 20_000 }).toBe("interactiveReady");
    await expect.poll(() => motion.evaluate((node) => {
      const trace = (node as AvalElement)
        .getDiagnostics({ trace: true }).runtimeTrace ?? [];
      return trace.at(-1)?.graph?.presentation?.unitId ?? null;
    }), { timeout: 15_000 }).toBe("idle-loop");
    const bounds = await motion.boundingBox();
    if (bounds === null) throw new Error("grass-rabbit touch bounds are unavailable");
    const tapPlayer = () => page.touchscreen.tap(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2
    );
    const tapOutside = () => page.touchscreen.tap(4, 4);

    await tapPlayer();
    await expect.poll(() => rabbitState(motion)).toMatchObject({
      visualState: "entering"
    });
    await tapOutside();
    await expect.poll(() => rabbitState(motion), { timeout: 15_000 }).toEqual({
      requestedState: "idle",
      visualState: "idle",
      isTransitioning: false
    });

    await tapPlayer();
    await expect.poll(() => rabbitState(motion), { timeout: 15_000 })
      .toMatchObject({ visualState: "hover" });
    await tapOutside();
    await expect.poll(() => rabbitState(motion)).toMatchObject({
      visualState: "exiting"
    });
    await tapPlayer();
    await expect.poll(() => rabbitState(motion), { timeout: 15_000 }).toEqual({
      requestedState: "hover",
      visualState: "hover",
      isTransitioning: false
    });
    expect(failures).toEqual({ consoleErrors: [], pageErrors: [] });
  } finally {
    await context.close();
  }
});

test("re-enters finite hover-out at early and late pointer or focus frames", async ({
  page
}) => {
  test.setTimeout(4 * 60_000);
  const failures = { consoleErrors: [] as string[], pageErrors: [] as string[] };
  page.on("console", (message) => {
    if (message.type() === "error") failures.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => failures.pageErrors.push(error.message));
  await page.mouse.move(0, 0);
  await page.goto("/");
  const motion = page.locator("#grass-rabbit");
  await expect.poll(() => motion.evaluate((node) => (
    node as AvalElement
  ).readiness), { timeout: 20_000 }).toBe("interactiveReady");
  await normalizeRabbitIdle(page, motion);

  for (const mode of ["pointer", "focus"] as const) {
    for (const targetFrame of [2, 46] as const) {
      const witness = await exerciseRabbitReentry(
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
      await disengageRabbit(motion, mode);
      await expect.poll(() => rabbitState(motion), { timeout: 15_000 }).toEqual({
        requestedState: "idle",
        visualState: "idle",
        isTransitioning: false
      });
    }
  }

  expect(failures).toEqual({ consoleErrors: [], pageErrors: [] });
});

test("keeps finite hover bodies on one forward decoder generation", async ({
  page
}) => {
  await page.goto("/");
  const motion = page.locator("#grass-rabbit");
  await expect
    .poll(() => motion.evaluate((node) => (
      node as AvalElement
    ).readiness), { timeout: 5_000 })
    .toBe("interactiveReady");

  await page.mouse.move(0, 0);
  const baseline = await motion.evaluate((node) => {
    const diagnostics = (node as AvalElement)
      .getDiagnostics({ trace: true });
    return {
      traceIndex: diagnostics.runtimeTrace?.at(-1)?.index ?? -1,
      underflows: diagnostics.counters.underflow
    };
  });
  await motion.hover();
  await expect
    .poll(() => motion.evaluate((node) => {
      const trace = (node as AvalElement)
        .getDiagnostics({ trace: true }).runtimeTrace ?? [];
      const presentation = trace.at(-1)?.graph?.presentation as Readonly<{
        unitId?: string;
        frameIndex?: number;
      }> | null | undefined;
      return presentation?.unitId === "hover-in" &&
        typeof presentation.frameIndex === "number" &&
        presentation.frameIndex >= 30;
    }), { timeout: 15_000 })
    .toBe(true);

  const evidence = await motion.evaluate((node, traceIndex) => {
    const element = node as AvalElement;
    const diagnostics = element.getDiagnostics({ trace: true });
    const frames = (diagnostics.runtimeTrace ?? []).filter((record) => {
      if (record.index <= traceIndex) return false;
      const presentation = record.graph?.presentation as Readonly<{
        unitId?: string;
        frameIndex?: number;
      }> | null | undefined;
      return presentation?.unitId === "hover-in" &&
        typeof presentation.frameIndex === "number" &&
        presentation.frameIndex <= 30;
    });
    const canvas = node.shadowRoot?.querySelector<HTMLCanvasElement>(
      'canvas[data-aval-layer="animated"]'
    );
    const generations = [...new Set(frames.flatMap((record) =>
      typeof record.scheduler.generation === "number"
        ? [record.scheduler.generation]
        : []
    ))];
    const displayedFrames = frames.flatMap((record) => {
      const frame = record.scheduler.displayedCursor?.localFrame;
      return typeof frame === "number"
        ? [frame]
        : [];
    });
    return {
      readiness: diagnostics.readiness,
      lastFailure: diagnostics.lastFailure,
      underflows: diagnostics.counters.underflow,
      generations,
      minimumRingSize: Math.min(...frames.map((record) =>
        record.scheduler.ringSize
      )),
      displayedFrames,
      canvasHidden: canvas?.hidden ?? true
    };
  }, baseline.traceIndex);

  expect(evidence).toMatchObject({
    readiness: "interactiveReady",
    lastFailure: null,
    underflows: baseline.underflows,
    generations: [expect.any(Number)],
    canvasHidden: false
  });
  expect(evidence.minimumRingSize).toBeGreaterThan(0);
  expect(evidence.displayedFrames).toEqual(
    Array.from({ length: 31 }, (_, frame) => frame)
  );
});

type RabbitReentryMode = "pointer" | "focus";

interface RabbitReentryEvent {
  readonly type: string;
  readonly edge: string | null;
  readonly to: string | null;
}

type RabbitReentryElement = AvalElement & {
  __rabbitReentryEvents?: RabbitReentryEvent[];
  __rabbitReentryInputs?: string[];
  __rabbitReentryInstalled?: boolean;
};

async function normalizeRabbitIdle(page: Page, motion: Locator): Promise<void> {
  await page.mouse.move(0, 0);
  await motion.evaluate((node) => {
    const element = node as HTMLElement;
    element.blur();
    element.dispatchEvent(new PointerEvent("pointerleave", {
      pointerType: "mouse"
    }));
  });
  await expect.poll(() => rabbitState(motion), { timeout: 15_000 }).toEqual({
    requestedState: "idle",
    visualState: "idle",
    isTransitioning: false
  });
}

async function exerciseRabbitReentry(
  page: Page,
  motion: Locator,
  mode: RabbitReentryMode,
  targetFrame: number
) {
  await normalizeRabbitIdle(page, motion);
  await motion.evaluate((node) => {
    const element = node as RabbitReentryElement;
    if (element.__rabbitReentryInstalled !== true) {
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
          element.__rabbitReentryEvents?.push({
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
          element.__rabbitReentryInputs?.push(type);
        });
      }
      element.__rabbitReentryInstalled = true;
    }
    element.__rabbitReentryEvents = [];
    element.__rabbitReentryInputs = [];
  });
  await engageRabbit(motion, mode);
  await expect.poll(() => rabbitState(motion), { timeout: 15_000 }).toEqual({
    requestedState: "hover",
    visualState: "hover",
    isTransitioning: false
  });

  const observedFrame = await motion.evaluate(async (
    node,
    input: Readonly<{ mode: RabbitReentryMode; targetFrame: number }>
  ) => {
    const element = node as AvalElement;
    const deadline = performance.now() + 15_000;
    return new Promise<number>((resolveFrame, rejectFrame) => {
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

  await expect.poll(() => rabbitState(motion), { timeout: 15_000 }).toEqual({
    requestedState: "hover",
    visualState: "hover",
    isTransitioning: false
  });
  return motion.evaluate((node, frame) => {
    const element = node as RabbitReentryElement;
    const events = element.__rabbitReentryEvents ?? [];
    return {
      observedFrame: frame,
      inputEvents: [...(element.__rabbitReentryInputs ?? [])],
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

function engageRabbit(motion: Locator, mode: RabbitReentryMode): Promise<void> {
  return motion.evaluate((node, requestedMode) => {
    if (requestedMode === "pointer") {
      node.dispatchEvent(new PointerEvent("pointerenter", {
        pointerType: "mouse"
      }));
    } else {
      (node as HTMLElement).focus();
    }
  }, mode);
}

function disengageRabbit(motion: Locator, mode: RabbitReentryMode): Promise<void> {
  return motion.evaluate((node, requestedMode) => {
    if (requestedMode === "pointer") {
      node.dispatchEvent(new PointerEvent("pointerleave", {
        pointerType: "mouse"
      }));
    } else {
      (node as HTMLElement).blur();
    }
  }, mode);
}

function rabbitState(motion: Locator): Promise<Readonly<{
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
