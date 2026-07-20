import { createHash } from "node:crypto";

import { expect, test } from "@playwright/test";

test("runs the public end-user interaction", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto("/");

  const motion = page.locator("#favorite-motion");
  const unavailable = page.locator("#favorite-unavailable");
  await expect(unavailable).toHaveAttribute(
    "src",
    "/favorite.png"
  );
  await expect(unavailable).toBeHidden();
  await expect
    .poll(
      () =>
        motion.evaluate(
          (node) =>
            (node as HTMLElement & { readiness: string }).readiness
        ),
      { timeout: 20_000 }
    )
    .toBe("interactiveReady");

  await motion.evaluate((node) => {
    const element = node as HTMLElement & {
      __playgroundEvents?: Readonly<{
        type: string;
        edge: string | null;
        to: string | null;
      }>[];
    };
    const events: {
      type: string;
      edge: string | null;
      to: string | null;
    }[] = [];
    element.__playgroundEvents = events;
    for (const type of [
      "transitionstart",
      "visualstatechange",
      "transitionend"
    ]) {
      element.addEventListener(type, (event) => {
        const detail = (event as CustomEvent<{
          edge?: string;
          to?: string;
        }>).detail;
        events.push({
          type,
          edge: detail.edge ?? null,
          to: detail.to ?? null
        });
      });
    }
  });
  await expect(page.locator("#runtime-status")).toContainText("idle");
  await expect.poll(() => publicState(motion)).toEqual({
    requestedState: "idle",
    visualState: "idle",
    isTransitioning: false
  });
  const idlePixels = await sampledPixels(page, motion);
  await page.locator("#toggle-state").click();
  await expect.poll(() => publicState(motion)).toEqual({
    requestedState: "engaged",
    visualState: "engaged",
    isTransitioning: false
  });
  await expect(page.locator("#runtime-status")).toContainText("engaged");
  await expect(page.locator("#toggle-state")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  const engagedPixels = await sampledPixels(page, motion);
  await expect.poll(
    async () => (await sampledPixels(page, motion)).frameHash,
    { timeout: 2_000 }
  ).not.toBe(engagedPixels.frameHash);

  await page.locator("#toggle-state").click();
  await expect.poll(() => publicState(motion)).toEqual({
    requestedState: "idle",
    visualState: "idle",
    isTransitioning: false
  });
  await expect(page.locator("#runtime-status")).toContainText("idle");
  await expect(page.locator("#toggle-state")).toHaveAttribute(
    "aria-pressed",
    "false"
  );
  const returnedIdlePixels = await sampledPixels(page, motion);
  const events = await motion.evaluate((node) => [
    ...((node as HTMLElement & {
      __playgroundEvents?: readonly Readonly<{
        type: string;
        edge: string | null;
        to: string | null;
      }>[];
    }).__playgroundEvents ?? [])
  ]);
  expect(events.map(({ type }) => type)).toEqual([
    "transitionstart",
    "visualstatechange",
    "transitionend",
    "transitionstart",
    "visualstatechange",
    "transitionend"
  ]);
  expect(events.filter(({ type }) => type === "transitionstart")
    .map(({ edge }) => edge)).toEqual(["idle.engaged", "engaged.idle"]);
  expect(events.filter(({ type }) => type === "transitionend")
    .map(({ edge }) => edge)).toEqual(["idle.engaged", "engaged.idle"]);
  expect(events.filter(({ type }) => type === "visualstatechange")
    .map(({ to }) => to)).toEqual(["engaged", "idle"]);
  for (const witness of [idlePixels, engagedPixels, returnedIdlePixels]) {
    expect(witness.edgeSamples).toEqual(
      Array.from({ length: 6 }, () => "254,0,254,255")
    );
    expect(witness.uniqueInteriorColors).toBeGreaterThan(1);
    expect(witness.nonBlackInteriorPixels).toBeGreaterThan(0);
    expect(witness.nonBackgroundInteriorPixels).toBeGreaterThan(0);
  }
  expect(engagedPixels.samples).not.toEqual(idlePixels.samples);
  expect(engagedPixels.frameHash).not.toBe(idlePixels.frameHash);
  expect(returnedIdlePixels.frameHash).not.toBe(engagedPixels.frameHash);
  expect(consoleErrors).toEqual([]);
});

test("keeps the product control usable without claiming reduced-motion pixels", async ({
  page
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const motion = page.locator("#favorite-motion");
  await expect.poll(() => motion.evaluate((node) => ({
    readiness: (node as HTMLElement & { readiness: string }).readiness,
    staticReason: (node as HTMLElement & { staticReason: string | null }).staticReason
  }))).toEqual({
    readiness: "staticReady",
    staticReason: "reduced-motion"
  });

  await expect(page.locator("#favorite-unavailable")).toBeHidden();
  await expect(page.locator("#runtime-status")).toHaveText(
    "Motion inactive · reduced motion"
  );
  const toggle = page.locator("#toggle-state");
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#runtime-status")).toHaveText(
    "Motion inactive · reduced motion"
  );
  await expect(motion).not.toHaveAttribute("data-rendered", "");
});

function publicState(motion: import("@playwright/test").Locator) {
  return motion.evaluate((node) => {
    const element = node as HTMLElement & {
      requestedState: string | null;
      visualState: string | null;
      isTransitioning: boolean;
    };
    return {
      requestedState: element.requestedState,
      visualState: element.visualState,
      isTransitioning: element.isTransitioning
    };
  });
}

async function sampledPixels(
  page: import("@playwright/test").Page,
  motion: import("@playwright/test").Locator
) {
  const previousBackground = await motion.evaluate((node) => {
    const oldValue = (node as HTMLElement).style.backgroundColor;
    (node as HTMLElement).style.backgroundColor = "rgb(254, 0, 254)";
    return oldValue;
  });
  let screenshot: Buffer;
  try {
    screenshot = await motion.screenshot({ animations: "allow" });
  } finally {
    await motion.evaluate((node, oldValue) => {
      (node as HTMLElement).style.backgroundColor = oldValue;
    }, previousBackground);
  }
  const pixels = await page.evaluate(async (source) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context === null) throw new Error("pixel witness context is unavailable");
    context.drawImage(image, 0, 0);
    const sample = (x: number, y: number): string => context.getImageData(
      Math.min(canvas.width - 1, Math.max(0, Math.round(x))),
      Math.min(canvas.height - 1, Math.max(0, Math.round(y))),
      1,
      1
    ).data.join(",");
    const samples: string[] = [];
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
        samples.push(sample(x, y));
      }
    }
    const edgeSamples = [
      [0.1, 0.04], [0.5, 0.04], [0.9, 0.04],
      [0.1, 0.96], [0.5, 0.96], [0.9, 0.96]
    ].map(([x, y]) => sample(
      (x ?? 0) * (canvas.width - 1),
      (y ?? 0) * (canvas.height - 1)
    ));
    const interiorSamples = [0.2, 0.35, 0.5, 0.65, 0.8].flatMap((x) =>
      [0.35, 0.5, 0.65].map((y) => sample(
        x * (canvas.width - 1),
        y * (canvas.height - 1)
      )));
    const isBlack = (value: string): boolean => value.split(",")
      .slice(0, 3)
      .every((channel) => Number(channel) <= 16);
    return {
      samples,
      edgeSamples,
      uniqueInteriorColors: new Set(interiorSamples).size,
      nonBlackInteriorPixels: interiorSamples.filter((value) =>
        !isBlack(value)).length,
      nonBackgroundInteriorPixels: interiorSamples.filter((value) =>
        value !== "254,0,254,255").length
    };
  }, `data:image/png;base64,${screenshot.toString("base64")}`);
  return {
    ...pixels,
    frameHash: createHash("sha256").update(screenshot).digest("hex")
  };
}
