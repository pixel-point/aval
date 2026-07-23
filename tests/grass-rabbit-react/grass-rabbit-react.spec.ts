import { expect, test } from "@playwright/test";

test("connects the React hook to the authored rabbit interaction", async ({
  page
}) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { level: 1, name: /AVAL, at home in React\./u })
  ).toBeVisible();

  const player = page.getByTestId("grass-rabbit-player");
  const readiness = page.getByTestId("rabbit-readiness");
  const visualState = page.getByTestId("rabbit-visual-state");

  await expect(player).toHaveAttribute("tabindex", "0");
  await expect(player).toHaveAttribute("role", "img");
  await expect(player).toHaveAttribute("aria-label", "Grass rabbit animation");
  await expect(player).toHaveAttribute("bindings", "auto");
  await expect(player.locator(":scope > source")).toHaveCount(4);
  expect(await player.locator(":scope > source").evaluateAll((nodes) =>
    nodes.map((node) => ({
      codec: node.getAttribute("data-codec"),
      path: new URL((node as HTMLSourceElement).src).pathname
    }))
  )).toEqual([
    { codec: "av1", path: "/grass-rabbit/av1.avl" },
    { codec: "vp9", path: "/grass-rabbit/vp9.avl" },
    { codec: "h265", path: "/grass-rabbit/h265.avl" },
    { codec: "h264", path: "/grass-rabbit/h264.avl" }
  ]);
  expect(await player.evaluate((element) => {
    const avalPlayer = element as HTMLElement & {
      readonly interactionTarget: Element | null;
    };
    return avalPlayer.interactionTarget === avalPlayer;
  })).toBe(true);
  await expect(readiness).toHaveText("Interactive");
  await expect(visualState).toHaveText("Idle");

  await player.focus();
  await expect(visualState).toHaveText("Hover");

  await page.getByRole("link", { name: "View repository" }).focus();
  await expect(visualState).toHaveText("Idle");

  await player.hover();
  await expect(visualState).toHaveText("Hover");

  await page.mouse.move(0, 0);
  await expect(visualState).toHaveText("Idle");
});

test("presents reduced motion as a static experience", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const player = page.getByTestId("grass-rabbit-player");

  await expect(page.getByTestId("rabbit-readiness")).toHaveText("Static");
  await expect(page.getByTestId("rabbit-experience-status")).toHaveText(
    "Motion inactive"
  );
  await expect(player).toHaveAttribute("tabindex", "-1");
  await expect(player).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByText("Motion is inactive.")).toBeVisible();
  await expect(page.getByText(
    "This animation is inactive under the current runtime policy."
  )).toBeVisible();
  await expect(page.locator(".rabbit-interaction-hint")).toHaveCount(0);
});
