import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    passWithNoTests: true,
    coverage: {
      reporter: ["text", "html"]
    }
  }
});
