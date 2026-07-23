import { defineConfig, devices } from "@playwright/test";

const port = process.env.AVL_GRASS_RABBIT_REACT_PORT ?? "4195";
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./tests/grass-rabbit-react",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1280, height: 900 }
  },
  webServer: {
    command: `npm run grass-rabbit-react -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] }
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] }
    }
  ]
});
