import { defineConfig, devices } from "@playwright/test";

const port = process.env.AVAL_REACT_BROWSER_PORT ?? "4187";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: ".",
  testMatch: "listener-timing.spec.ts",
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure"
  },
  webServer: {
    command: `vite --config vite.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${baseURL}/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  },
  projects: [{
    name: "chromium",
    use: {
      ...devices["Desktop Chrome"],
      channel: "chromium"
    }
  }]
});
