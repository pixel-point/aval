import { defineConfig, devices } from "@playwright/test";

// Keep the regression gate isolated from the interactive demo's default 4178.
const port = process.env.AVL_KINETIC_ORB_PORT ?? "4194";
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
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1280, height: 900 }
  },
  webServer: {
    command: `npm run dev -w @pixel-point/aval-kinetic-orb-example -- --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000
  },
  projects: [
    {
      name: "chromium",
      testIgnore: "**/soak.spec.ts",
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "firefox",
      testIgnore: "**/soak.spec.ts",
      use: { ...devices["Desktop Firefox"] }
    },
    {
      name: "webkit",
      testIgnore: "**/soak.spec.ts",
      use: { ...devices["Desktop Safari"] }
    },
    {
      name: "chromium-soak",
      testMatch: "**/soak.spec.ts",
      timeout: 95_000,
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "firefox-soak",
      testMatch: "**/soak.spec.ts",
      timeout: 95_000,
      use: { ...devices["Desktop Firefox"] }
    }
  ]
});
