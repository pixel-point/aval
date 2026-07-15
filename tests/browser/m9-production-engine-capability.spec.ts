import { expect, test } from "@playwright/test";

test("built public element records an honest functional-engine capability outcome", async ({ page }, testInfo) => {
  await page.goto("/certification.html");
  await page.waitForFunction(() => customElements.get("aval-player") !== undefined);
  const result = await page.evaluate(async (session) => {
    const element = document.createElement("aval-player") as unknown as HTMLElement & {
      src: string;
      prepare(): Promise<unknown>;
      pause(): void;
      dispose(): Promise<void>;
      getDiagnostics(): {
        readiness: string;
        mode: string | null;
        staticReason: string | null;
        lastFailure: { code: string } | null;
        runtime: { selectedRendition: string | null };
        outstanding: { player: number; decoder: number; bytes: number };
      };
    };
    element.style.display = "block";
    element.style.width = "192px";
    element.style.height = "108px";
    element.src = `/__m8__/asset?session=${encodeURIComponent(session)}&fixture=user-states`;
    document.querySelector("[data-certification-stage]")!.append(element);
    await element.prepare();
    element.pause();
    const ready = element.getDiagnostics();
    let renderedPixels: null | {
      width: number;
      height: number;
      nonTransparent: number;
      nonZeroColor: number;
      visibleWidth: number;
      visibleHeight: number;
    } = null;
    if (ready.readiness === "interactiveReady") {
      const canvas = element.shadowRoot?.querySelector<HTMLCanvasElement>(
        'canvas[data-aval-layer="animated"]'
      );
      if (canvas === null || canvas === undefined) {
        throw new Error("animated presentation canvas is unavailable");
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const bitmap = await createImageBitmap(canvas);
      const snapshot = document.createElement("canvas");
      snapshot.width = bitmap.width;
      snapshot.height = bitmap.height;
      const context = snapshot.getContext("2d", { willReadFrequently: true });
      if (context === null) throw new Error("pixel evidence context is unavailable");
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = context.getImageData(0, 0, snapshot.width, snapshot.height).data;
      let nonTransparent = 0;
      let nonZeroColor = 0;
      let minimumX = snapshot.width;
      let minimumY = snapshot.height;
      let maximumX = -1;
      let maximumY = -1;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset + 3] === 0) continue;
        nonTransparent += 1;
        if (pixels[offset] !== 0 || pixels[offset + 1] !== 0 || pixels[offset + 2] !== 0) {
          nonZeroColor += 1;
        }
        const pixel = offset / 4;
        const x = pixel % snapshot.width;
        const y = Math.floor(pixel / snapshot.width);
        minimumX = Math.min(minimumX, x);
        minimumY = Math.min(minimumY, y);
        maximumX = Math.max(maximumX, x);
        maximumY = Math.max(maximumY, y);
      }
      renderedPixels = {
        width: snapshot.width,
        height: snapshot.height,
        nonTransparent,
        nonZeroColor,
        visibleWidth: maximumX < minimumX ? 0 : maximumX - minimumX + 1,
        visibleHeight: maximumY < minimumY ? 0 : maximumY - minimumY + 1
      };
    }
    element.remove();
    await element.dispose();
    return {
      ready,
      renderedPixels,
      terminal: element.getDiagnostics().outstanding
    };
  }, `m9-engine-${testInfo.project.name}`);

  const supported = result.ready.readiness === "interactiveReady";
  const animationRequired = /(?:chromium|webkit)-engine-production-probe$/u.test(
    testInfo.project.name
  );
  testInfo.annotations.push({
    type: "functional-engine-capability",
    description: supported ? "production-animation-supported" : "production-animation-unsupported"
  });
  if (animationRequired) {
    expect(result.ready).toMatchObject({
      readiness: "interactiveReady",
      mode: "animated",
      staticReason: null,
      lastFailure: null
    });
    expect(result.renderedPixels?.width).toBeGreaterThan(0);
    expect(result.renderedPixels?.height).toBeGreaterThan(0);
    expect(
      (result.renderedPixels?.width ?? 0) / (result.renderedPixels?.height ?? 1)
    ).toBeCloseTo(16 / 9, 6);
    expect(result.renderedPixels?.nonTransparent).toBeGreaterThan(100);
    expect(result.renderedPixels?.nonZeroColor).toBeGreaterThan(100);
    expect(result.renderedPixels?.visibleWidth).toBeGreaterThan(8);
    expect(result.renderedPixels?.visibleHeight).toBeGreaterThan(8);
  }
  if (supported) {
    expect(result.ready).toMatchObject({ mode: "animated", staticReason: null, lastFailure: null });
    expect(result.ready.runtime.selectedRendition).not.toBeNull();
  } else {
    expect(result.ready).toMatchObject({ readiness: "staticReady", mode: "static" });
    expect(result.ready.staticReason).not.toBeNull();
    expect(result.ready.outstanding.decoder).toBe(0);
  }
  expect(result.terminal).toEqual({ player: 0, decoder: 0, bytes: 0 });
  expect(testInfo.project.name).toMatch(/^playwright-bundled-(?:chromium|firefox|webkit)-engine-production-probe$/u);
});
