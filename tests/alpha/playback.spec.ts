import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";

let server: Server;
let port: number;
test.beforeAll(async () => {
  const bytes = await readFile(".cache/alpha/media/vp9.webm");
  server = createServer((request, response) => {
    const name = request.url ?? "";
    if (!name.includes("cors-denied")) response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Content-Type", "video/webm");
    const send = () => response.end(name.includes("truncated") ? bytes.subarray(0, 64) : bytes);
    if (name.includes("slow")) setTimeout(send, 2500); else send();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  port = (server.address() as { port: number }).port;
});
test.afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

for (const legacy of [false, true]) {
  test(`transparent playback, sources and lifecycle${legacy ? " without WebCodecs or video frame callbacks" : ""}`, async ({ page }, testInfo) => {
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    if (legacy) await page.addInitScript(() => {
      delete (window as unknown as Record<string, unknown>).VideoDecoder;
      delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>).requestVideoFrameCallback;
      delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>).cancelVideoFrameCallback;
    });
    await page.goto(`/?network-checks=${port}`);
    await expect(page.locator("#status")).toContainText("Playing");
    await page.getByRole("button", { name: "Run checks", exact: true }).click();
    await expect(page.locator("#results")).toHaveAttribute("data-complete", "true", { timeout: 35_000 });
    const report = JSON.parse(await page.locator("#results").innerText()) as { results: { name: string; passed: boolean; skipped?: boolean }[] };
    await testInfo.attach("alpha-browser-results", { body: JSON.stringify({ ...report, requests }, null, 2), contentType: "application/json" });
    expect(report.results.filter((result) => !result.passed)).toEqual([]);
    expect(report.results.some((result) => result.name.startsWith("Decode") && result.passed && !result.skipped)).toBe(true);
    expect(requests.some((url) => url.includes("/unused-"))).toBe(false);
  });
}
