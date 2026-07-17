import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import type { AvalElement } from "@pixel-point/aval-element";
import { parseFrontIndex } from "@pixel-point/aval-format";

const EXAMPLE_PATH = resolve("examples/kinetic-orb");
const PROJECT_PATH = resolve(EXAMPLE_PATH, "motion.json");
const BUILD_PATH = resolve(EXAMPLE_PATH, "public/kinetic-orb/build.json");
const ASSET_PATH = resolve(EXAMPLE_PATH, "public/kinetic-orb/h264.avl");

test("preserves the phase-locked H.264 graph", async () => {
  const project = JSON.parse(await readFile(PROJECT_PATH, "utf8")) as {
    encodings: { codec: string }[];
    units: {
      id: string;
      range: [number, number];
      ports?: { portalFrames: number[] }[];
    }[];
    edges: {
      id: string;
      start: { maxWaitFrames: number; type: string };
    }[];
  };
  const report = JSON.parse(await readFile(BUILD_PATH, "utf8")) as {
    assets: { codec: string; path: string; bytes: number }[];
  };
  const bytes = new Uint8Array(await readFile(ASSET_PATH));
  const front = parseFrontIndex(bytes);

  expect(project.encodings.map(({ codec }) => codec)).toEqual(["h264"]);
  expect(project.units.map(({ id, range }) => ({ id, range }))).toEqual([
    { id: "intro", range: [0, 24] },
    { id: "idle-loop", range: [24, 48] },
    { id: "hover-in", range: [48, 60] },
    { id: "hover-loop", range: [60, 84] },
    { id: "hover-out", range: [84, 96] }
  ]);

  const densePortals = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23];
  expect(project.units.find(({ id }) => id === "idle-loop")?.ports?.[0]?.portalFrames)
    .toEqual(densePortals);
  expect(project.units.find(({ id }) => id === "hover-loop")?.ports?.[0]?.portalFrames)
    .toEqual(densePortals);
  expect(project.edges
    .filter(({ start }) => start.type === "portal")
    .map(({ id, start }) => ({ id, wait: start.maxWaitFrames })))
    .toEqual([
      { id: "idle.entering", wait: 1 },
      { id: "hover.exiting", wait: 1 }
    ]);

  expect(report.assets).toHaveLength(1);
  expect(report.assets[0]).toMatchObject({ codec: "h264", path: "h264.avl" });
  expect(report.assets[0]?.bytes).toBe(bytes.byteLength);
  expect(front.manifest.canvas).toMatchObject({ width: 512, height: 512 });
  expect(front.manifest.frameRate).toEqual({ numerator: 24, denominator: 1 });
  expect(front.manifest.units).toHaveLength(5);
});

test("plays intro, hover, exit, and keyboard focus without runtime errors", async ({
  page
}) => {
  const failures: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(message.text());
  });
  page.on("pageerror", (error) => failures.push(error.message));

  await page.mouse.move(0, 0);
  await page.goto("/");

  const motion = page.locator("#kinetic-orb");
  const stateLabel = page.locator("[data-state-label]");
  await expect
    .poll(() => motion.evaluate((node) => (node as AvalElement).readiness))
    .toBe("interactiveReady");
  await expect(motion).toHaveAttribute("data-rendered", "");
  await expect(stateLabel).toHaveText("idle", { timeout: 5_000 });

  await motion.hover();
  await expect
    .poll(() => motion.evaluate((node) => (node as AvalElement).visualState))
    .toBe("hover");
  await expect(stateLabel).toHaveText("hover");

  await page.mouse.move(0, 0);
  await expect
    .poll(() => motion.evaluate((node) => (node as AvalElement).visualState))
    .toBe("idle");

  await motion.focus();
  await expect
    .poll(() => motion.evaluate((node) => (node as AvalElement).visualState))
    .toBe("hover");
  await motion.evaluate((node) => (node as HTMLElement).blur());
  await expect
    .poll(() => motion.evaluate((node) => (node as AvalElement).visualState))
    .toBe("idle");

  expect(failures).toEqual([]);
});
