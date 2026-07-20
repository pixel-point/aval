import { defineConfig, devices } from "@playwright/test";

const port = process.env.AVL_GRASS_RABBIT_PORT ?? "4176";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/grass-rabbit",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    deviceScaleFactor: 2,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1280, height: 720 }
  },
  webServer: {
    command: `npm run grass-rabbit -- --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        deviceScaleFactor: 2,
        viewport: { width: 1280, height: 720 }
      }
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        deviceScaleFactor: 2,
        viewport: { width: 1280, height: 720 }
      }
    },
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        deviceScaleFactor: 2,
        viewport: { width: 1280, height: 720 }
      }
    }
  ]
});
