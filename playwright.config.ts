import { defineConfig, devices } from "@playwright/test";

const browserPort = process.env.AVL_PLAYWRIGHT_PORT ?? "4173";
const browserBaseUrl = `http://127.0.0.1:${browserPort}`;

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  // Browser suites include cadence and decoder/GPU resource assertions.
  // Cross-file workers would benchmark unrelated proofs against each other
  // and turn host contention into false format failures. Concurrency and
  // multi-player pressure are exercised explicitly inside their own tests.
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 5_000
  },
  reporter: [["list"]],
  use: {
    baseURL: browserBaseUrl,
    trace: "retain-on-failure",
    screenshot: process.env.AVL_SCREENSHOTS === "off" ? "off" : "only-on-failure"
  },
  webServer: {
    command:
      `npm run dev -w @pixel-point/aval-playground -- --port ${browserPort} --strictPort`,
    url: browserBaseUrl,
    reuseExistingServer: false,
    timeout: 30_000
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chromium",
        launchOptions: {
          ignoreDefaultArgs: ["--disable-back-forward-cache"]
        }
      }
    }
  ]
});
