import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import grassRabbitCodecs from "../../../playwright.grass-rabbit-codecs.config.js";
import grassRabbitReact from "../../../playwright.grass-rabbit-react.config.js";
import grassRabbit from "../../../playwright.grass-rabbit.config.js";
import kineticOrb from "../../../playwright.kinetic-orb.config.js";
import playground from "../../../playwright.playground.config.js";

const ROOT = resolve(import.meta.dirname, "../../..");
const REQUIRED_ENGINES = ["chromium", "firefox", "webkit"];

describe("permanent-demo browser command contract", () => {
  it.each([
    ["playground", playground],
    ["grass-rabbit", grassRabbit],
    ["grass-rabbit-react", grassRabbitReact],
    ["grass-rabbit-codecs", grassRabbitCodecs],
    ["kinetic-orb", kineticOrb]
  ])("includes Chromium, Firefox, and WebKit for %s", (_name, config) => {
    const names = config.projects?.map(({ name }) => name) ?? [];
    expect(names).toEqual(expect.arrayContaining(REQUIRED_ENGINES));
  });

  it("does not narrow any permanent-demo script to selected engines", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(ROOT, "package.json"), "utf8")
    ) as Readonly<{ scripts: Readonly<Record<string, string>> }>;
    for (const name of [
      "test:playground",
      "test:grass-rabbit",
      "test:grass-rabbit-react",
      "test:grass-rabbit-codecs",
      "test:kinetic-orb:prebuilt"
    ]) {
      expect(packageJson.scripts[name], name).toContain("playwright test");
      expect(packageJson.scripts[name], name).not.toContain("--project");
    }
  });

  it("owns a fresh server for every permanent-demo verification run", () => {
    for (const config of [
      playground,
      grassRabbit,
      grassRabbitReact,
      grassRabbitCodecs,
      kineticOrb
    ]) {
      expect(config.webServer).toMatchObject({ reuseExistingServer: false });
    }
  });

  it("keeps the 60-second soak isolated to Kinetic Chromium and Firefox projects", () => {
    const soak = kineticOrb.projects?.filter(({ name }) => name.includes("soak")) ?? [];
    expect(soak).toHaveLength(2);
    expect(soak).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "chromium-soak",
        testMatch: "**/soak.spec.ts",
        timeout: 95_000
      }),
      expect.objectContaining({
        name: "firefox-soak",
        testMatch: "**/soak.spec.ts",
        timeout: 95_000
      })
    ]));
    for (const config of [
      playground,
      grassRabbit,
      grassRabbitReact,
      grassRabbitCodecs
    ]) {
      expect(config.projects?.some(({ name }) => name.includes("soak"))).toBe(false);
    }
  });
});
