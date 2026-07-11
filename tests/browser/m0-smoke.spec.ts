import { expect, test } from "@playwright/test";

test("loads the scheduling playground without a browser error", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });

  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Continuous rendered motion" })
  ).toBeVisible();
  expect(errors).toEqual([]);
});
