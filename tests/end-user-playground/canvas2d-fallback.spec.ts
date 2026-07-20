import { expect, test, type Locator } from "@playwright/test";

test("keeps a modern codec and interactive pixels when WebGL2 is unavailable", async ({
  browserName,
  page
}) => {
  test.skip(browserName !== "chromium", "The deterministic WebCodecs canary is Chromium-only");

  await page.addInitScript(() => {
    const prototype = HTMLCanvasElement.prototype;
    const original = prototype.getContext;
    prototype.getContext = function getContext(
      this: HTMLCanvasElement,
      contextId: string,
      ...options: unknown[]
    ): RenderingContext | null {
      if (contextId === "webgl2") return null;
      return Reflect.apply(original, this, [contextId, ...options]) as
        RenderingContext | null;
    } as typeof prototype.getContext;
  });

  await page.goto("/");
  const motion = page.locator("#favorite-motion");
  await expect.poll(() => readiness(motion), { timeout: 20_000 })
    .toMatch(/^(?:interactiveReady|error)$/u);

  const initial = await runtime(motion);
  expect(initial.readiness, JSON.stringify(initial, null, 2))
    .toBe("interactiveReady");
  expect(initial).toMatchObject({
    readiness: "interactiveReady",
    rendererBackend: "canvas2d",
    lastFailure: null
  });
  expect(initial.selectedCodec).toMatch(/^(?:av01\.|vp09\.|hvc1\.)/u);
  expect(initial.selectedCodec).not.toMatch(/^avc1\./u);

  const idle = await canvasPixels(motion);
  expect(idle.nonTransparent).toBeGreaterThan(8);
  expect(idle.uniqueColors).toBeGreaterThan(2);

  await page.locator("#toggle-state").click();
  await expect.poll(() => visualState(motion)).toBe("engaged");
  await expect.poll(async () => (await canvasPixels(motion)).signature)
    .not.toBe(idle.signature);

  const beforeResize = await runtime(motion);
  await motion.evaluate((node) => {
    (node as HTMLElement).style.width = "180px";
    (node as HTMLElement).style.height = "180px";
  });
  await expect.poll(async () => {
    const after = await runtime(motion);
    return after.backingWidth !== beforeResize.backingWidth ||
      after.backingHeight !== beforeResize.backingHeight;
  }).toBe(true);
  expect(await runtime(motion)).toMatchObject({
    readiness: "interactiveReady",
    rendererBackend: "canvas2d",
    lastFailure: null
  });
  expect((await canvasPixels(motion)).nonTransparent).toBeGreaterThan(8);
});

function readiness(motion: Locator): Promise<string> {
  return motion.evaluate((node) => (node as HTMLElement & {
    readonly readiness: string;
  }).readiness);
}

function visualState(motion: Locator): Promise<string | null> {
  return motion.evaluate((node) => (node as HTMLElement & {
    readonly visualState: string | null;
  }).visualState);
}

function runtime(motion: Locator): Promise<Readonly<{
  readiness: string;
  rendererBackend: "webgl2" | "canvas2d" | null;
  selectedCodec: string | null;
  lastFailure: unknown;
  rendererDiagnostics: readonly unknown[];
  backingWidth: number;
  backingHeight: number;
}>> {
  return motion.evaluate((node) => {
    const player = node as HTMLElement & {
      readonly readiness: string;
      getDiagnostics(): Readonly<{
        lastFailure: unknown;
        runtime: Readonly<{
          rendererBackend: "webgl2" | "canvas2d" | null;
          selectedCodec: string | null;
          rendererDiagnostics: readonly unknown[];
        }>;
        presentation: Readonly<{
          backingWidth: number;
          backingHeight: number;
        }>;
      }>;
    };
    const diagnostics = player.getDiagnostics();
    return {
      readiness: player.readiness,
      rendererBackend: diagnostics.runtime.rendererBackend,
      selectedCodec: diagnostics.runtime.selectedCodec,
      lastFailure: diagnostics.lastFailure,
      rendererDiagnostics: diagnostics.runtime.rendererDiagnostics,
      backingWidth: diagnostics.presentation.backingWidth,
      backingHeight: diagnostics.presentation.backingHeight
    };
  });
}

function canvasPixels(motion: Locator): Promise<Readonly<{
  nonTransparent: number;
  uniqueColors: number;
  signature: string;
}>> {
  return motion.evaluate((node) => {
    const canvas = node.shadowRoot?.querySelector<HTMLCanvasElement>(
      'canvas[data-aval-layer="animated"]'
    );
    if (canvas === null || canvas === undefined) {
      throw new Error("animated Canvas2D surface is unavailable");
    }
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context === null) throw new Error("Canvas2D pixel witness is unavailable");
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set<string>();
    const samples: string[] = [];
    let nonTransparent = 0;
    const stepX = Math.max(1, Math.floor(canvas.width / 24));
    const stepY = Math.max(1, Math.floor(canvas.height / 24));
    for (let y = Math.floor(stepY / 2); y < canvas.height; y += stepY) {
      for (let x = Math.floor(stepX / 2); x < canvas.width; x += stepX) {
        const offset = (y * canvas.width + x) * 4;
        const sample = [
          pixels[offset] ?? 0,
          pixels[offset + 1] ?? 0,
          pixels[offset + 2] ?? 0,
          pixels[offset + 3] ?? 0
        ].join(",");
        colors.add(sample);
        samples.push(sample);
        if ((pixels[offset + 3] ?? 0) > 0) nonTransparent += 1;
      }
    }
    return {
      nonTransparent,
      uniqueColors: colors.size,
      signature: samples.join("|")
    };
  });
}
