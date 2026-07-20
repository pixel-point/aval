import { defineConfig, devices } from "@playwright/test";

const port = process.env.AVL_GRASS_RABBIT_CODECS_PORT ?? "4178";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/grass-rabbit-codecs",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 5 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1280, height: 900 }
  },
  webServer: {
    command:
      `npm --prefix examples/grass-rabbit-codecs run dev -- --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chromium",
        viewport: { width: 1280, height: 900 }
      }
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        viewport: { width: 1280, height: 900 }
      }
    },
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 1280, height: 900 }
      }
    }
  ]
});
