import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/alpha-frameworks", timeout: 30_000, workers: 1,
  outputDir: ".cache/alpha/framework-test-results",
  reporter: [["list"], ["json", { outputFile: ".cache/alpha/framework-browser-report.json" }]],
  use: { baseURL: "http://127.0.0.1:4189", headless: true },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } }
  ],
  webServer: { command: "node_modules/.bin/vite --config examples/alpha/frameworks/vite.config.ts", url: "http://127.0.0.1:4189/react", reuseExistingServer: !process.env.CI }
});
