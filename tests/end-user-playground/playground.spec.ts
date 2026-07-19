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

  await expect(page.locator("#runtime-status")).toContainText("idle");
  await page.locator("#toggle-state").click();
  await expect
    .poll(() =>
      motion.evaluate(
        (node) =>
          (node as HTMLElement & { visualState: string | null }).visualState
      )
    )
    .toBe("engaged");
  await expect(page.locator("#runtime-status")).toContainText("engaged");
  await expect(page.locator("#toggle-state")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
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
