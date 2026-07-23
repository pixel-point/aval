import { expect, test } from "@playwright/test";

test("catches one early fatal event across Strict Mode setup and remount", async ({
  page
}) => {
  await page.goto("/index.html");

  await expect(page.locator("#fatal-count")).toHaveText("1");
  await expect(page.locator(".motion-fallback")).toHaveText("instance-0");
  await expect(page.locator("aval-player")).toHaveAttribute(
    "data-mounted",
    "true"
  );
  expect(await page.evaluate(() => (
    window.avalReactHarness.callbackCounts()
  ))).toEqual({
    requested: 1,
    visual: 1,
    transitionStart: 1,
    transitionEnd: 1
  });
  await expect.poll(() => page.evaluate(() => (
    window.avalReactHarness.preparationCount("/forced-early-fatal.avl")
  ))).toBeGreaterThan(0);

  const target = await page.evaluate(() => (
    window.avalReactHarness.replaceTarget()
  ));
  expect(target).toEqual({
    initialTargetApplied: true,
    replacementTargetApplied: true,
    sameHost: true
  });

  const replacement = await page.evaluate(() => (
    window.avalReactHarness.replaceSource()
  ));
  expect(replacement.sameHost).toBe(true);
  expect(replacement.replacementSrc).toBe("/forced-replacement.avl");
  expect(replacement.resolvedOldPreparations).toBeGreaterThan(0);
  expect(replacement.staleReadyCount).toBe(0);
  await expect(page.locator(".motion-fallback")).toHaveText("instance-0");
  await expect.poll(() => page.evaluate(() => (
    window.avalReactHarness.preparationCount("/forced-replacement.avl")
  ))).toBeGreaterThan(0);

  const currentReady = await page.evaluate(() => (
    window.avalReactHarness.resolveCurrentPreparation()
  ));
  expect(currentReady.resolvedPreparations).toBe(1);
  expect(currentReady.readyCount).toBe(1);
  await expect(page.locator(".motion-fallback")).toHaveCount(0);

  const remount = await page.evaluate(() => (
    window.avalReactHarness.remount()
  ));
  expect(remount.detachedElementHandledFatal).toBe(false);
  expect(remount.automaticDisposeCount).toBe(0);
  expect(remount.snapshotSubscriberCount).toBe(0);
  expect(remount.interactionTargetCleared).toBe(true);
  await expect(page.locator("#fatal-count")).toHaveText("2");
  await expect(page.locator(".motion-fallback")).toHaveText("instance-1");
});
