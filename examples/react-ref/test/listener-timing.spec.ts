import { expect, test } from "@playwright/test";

test("catches an early fatal event when a pre-defined element remounts", async ({ page }) => {
  await page.goto("/listener-timing-test.html");

  await expect(page.locator("#fatal-count")).toHaveText("1");
  await expect(page.locator(".motion-fallback")).toHaveText("instance-0");

  const remount = await page.evaluate(() => window.remountStatusMotion());
  expect(remount.detachedElementHandledFatal).toBe(false);
  await expect(page.locator("#fatal-count")).toHaveText("2");
  await expect(page.locator(".motion-fallback")).toHaveText("instance-1");
});
