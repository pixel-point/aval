import { expect, test } from "@playwright/test";

for (const framework of ["react", "svelte"]) {
  test(`${framework}: SSR hydration, playback, reactive configuration and cleanup`, async ({ page, request }) => {
    const errors: string[] = [], requests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (["warning", "error"].includes(message.type()) && /hydration|hydrate|mismatch/i.test(message.text())) errors.push(message.text()); });
    page.on("request", (request) => requests.push(request.url()));
    const response = await request.get(`/${framework}`);
    expect(response.ok()).toBe(true);
    const html = await response.text();
    expect(html).toContain("<canvas"); expect(html).not.toContain("<video");
    await page.goto(`/${framework}`);
    const status = page.locator("#status"), video = page.locator("#stage video");
    await expect(status).toHaveText("ready");
    await expect(video).toHaveCount(1);
    expect(await page.evaluate(() => (window as unknown as { serverCanvas: HTMLCanvasElement }).serverCanvas === document.querySelector("canvas"))).toBe(true);
    await page.evaluate(() => Object.assign(window, { originalVideo: document.querySelector("video") }));
    const sameVideo = () => page.evaluate(() => (window as unknown as { originalVideo: HTMLVideoElement }).originalVideo === document.querySelector("video"));
    await page.getByRole("button", { name: "Equivalent sources", exact: true }).click();
    await expect(status).toHaveAttribute("data-renders", "1");
    await page.getByRole("button", { name: "Change callbacks", exact: true }).click();
    await page.getByRole("button", { name: "Toggle loop", exact: true }).click();
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.loop)).toBe(true);
    expect(await sameVideo()).toBe(true);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(status).toHaveAttribute("data-playing", "true");
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(status).toHaveAttribute("data-playing", "false");
    await page.getByRole("button", { name: "Seek", exact: true }).click();
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeCloseTo(0.5, 1);
    const pixels = await page.evaluate(async () => {
      const canvas = document.querySelector("canvas")!;
      const current = document.querySelector("video")!;
      current.currentTime = 0.75;
      await new Promise<void>((resolve) => current.addEventListener("seeked", () => {
        const gl = canvas.getContext("webgl")!;
        const rgba = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        Object.assign(canvas, { samples: [16, 48, 80, 112].map((x) => rgba[((canvas.height - 24) * canvas.width + x) * 4 + 3]!) });
        resolve();
      }, { once: true }));
      return (canvas as HTMLCanvasElement & { samples: number[] }).samples;
    });
    pixels.forEach((value, index) => expect(Math.abs(value - [0, 64, 128, 255][index]!)).toBeLessThanOrEqual(6));
    await page.getByRole("button", { name: "Replace source", exact: true }).click();
    await expect(status).toHaveAttribute("data-readies", "2");
    await expect(status).toHaveAttribute("data-callback", "updated");
    expect(await sameVideo()).toBe(false);
    await expect(video).toHaveCount(1);
    await page.getByRole("button", { name: "Fail", exact: true }).click();
    await expect(status).toHaveText("error");
    await expect(page.locator("#error")).toHaveText("updated:unsupported-source");
    await expect(video).toHaveCount(0);
    await page.getByRole("button", { name: "Replace source", exact: true }).click();
    await expect(status).toHaveText("ready");
    await page.getByRole("button", { name: "Unmount", exact: true }).click();
    await expect(status).toHaveText("idle");
    await expect(page.locator("#stage canvas, #stage video")).toHaveCount(0);
    await page.getByRole("button", { name: "Remount", exact: true }).click();
    await expect(status).toHaveText("ready"); await expect(video).toHaveCount(1);
    await page.getByRole("button", { name: "Remove dimensions", exact: true }).click();
    await expect.poll(() => page.locator("canvas").evaluate((node) => [node.style.width, node.style.height])).toEqual(["", ""]);
    if (framework === "svelte") {
      await page.getByRole("button", { name: "Replace controller", exact: true }).click();
      await expect(status).toHaveAttribute("data-readies", "5");
      await expect(status).toHaveText("ready"); await expect(video).toHaveCount(1);
    }
    expect(requests.filter((url) => /unsupported.mp4|unused.mp4/.test(url))).toEqual([]);
    expect(errors).toEqual([]);
  });
}
