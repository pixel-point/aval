import { defineConfig } from "@playwright/test";

const port = process.env.AVL_KINETIC_ORB_PORT ?? "4178";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/kinetic-orb",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    deviceScaleFactor: 1,
    trace: "off",
    screenshot: "only-on-failure",
    viewport: { width: 1280, height: 900 }
  },
  webServer: {
    command: `npm run kinetic-orb -- --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  },
  projects: [
    {
      name: "chromium",
      use: {
        headless: false
      }
    }
  ]
});
