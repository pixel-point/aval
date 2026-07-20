import { expect, test, type Locator } from "@playwright/test";

test("activates the public favorite control by touch", async ({
  browser,
  browserName
}, testInfo) => {
  test.skip(
    browserName === "firefox",
    "Playwright's desktop Firefox touch emulation does not synthesize click"
  );
  test.setTimeout(60_000);
  const configuredBaseUrl = testInfo.project.use.baseURL;
  if (typeof configuredBaseUrl !== "string") {
    throw new Error("playground touch test requires a configured base URL");
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
    const motion = page.locator("#favorite-motion");
    const control = page.locator("#favorite-control");
    await expect.poll(() => motion.evaluate((node) => (
      node as HTMLElement & { readonly readiness: string }
    ).readiness), { timeout: 20_000 }).toBe("interactiveReady");
    const bounds = await control.boundingBox();
    if (bounds === null) {
      throw new Error("favorite touch control bounds are unavailable");
    }
    const tapControl = () => page.touchscreen.tap(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2
    );

    await tapControl();
    await expect.poll(() => publicState(motion)).toEqual({
      requestedState: "engaged",
      visualState: "engaged",
      isTransitioning: false
    });
    await expect(control).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#runtime-status")).toContainText("engaged");

    await tapControl();
    await expect.poll(() => publicState(motion)).toEqual({
      requestedState: "idle",
      visualState: "idle",
      isTransitioning: false
    });
    await expect(control).toHaveAttribute("aria-pressed", "false");
    expect(failures).toEqual({ consoleErrors: [], pageErrors: [] });
  } finally {
    await context.close();
  }
});

function publicState(motion: Locator): Promise<Readonly<{
  requestedState: string | null;
  visualState: string | null;
  isTransitioning: boolean;
}>> {
  return motion.evaluate((node) => {
    const element = node as HTMLElement & {
      readonly requestedState: string | null;
      readonly visualState: string | null;
      readonly isTransitioning: boolean;
    };
    return {
      requestedState: element.requestedState,
      visualState: element.visualState,
      isTransitioning: element.isTransitioning
    };
  });
}
