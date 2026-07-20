import { defineConfig, devices } from "@playwright/test";

const port = process.env.AVAL_REACT_REF_PORT ?? "4187";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./test",
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure"
  },
  webServer: {
    command: `npm run dev -- --config vite.listener-timing.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${baseURL}/listener-timing-test.html`,
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
