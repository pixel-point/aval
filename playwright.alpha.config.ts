import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/alpha", testMatch: "*.spec.ts", timeout: 45_000, workers: 1,
  outputDir: ".cache/alpha/test-results", reporter: [["list"], ["json", { outputFile: ".cache/alpha/browser-report.json" }]],
  use: { baseURL: "http://127.0.0.1:4188", headless: true },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } }
  ],
  webServer: { command: "node_modules/.bin/vite --config examples/alpha/vite.config.ts", url: "http://127.0.0.1:4188", reuseExistingServer: !process.env.CI }
});
