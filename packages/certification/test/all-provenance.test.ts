import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("repository fixture provenance composition", () => {
  it("verifies every recorded byte reference without requiring FFmpeg", async () => {
    const { stdout } = await execFileAsync(process.execPath, ["scripts/fixtures/verify-provenance.mjs"], {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024
    });
    const result = JSON.parse(stdout) as {
      status: string;
      files: readonly { path: string; references: number }[];
    };
    expect(result.status).toBe("passed");
    expect(result.files.map(({ path }) => path)).toEqual([
      "fixtures/certification/v1/provenance.json",
      "fixtures/compiler/v1/provenance.json",
      "fixtures/conformance/v1/provenance.json",
      "fixtures/starter/v1-idle-hover/provenance.json"
    ]);
    expect(result.files.every(({ references }) => references > 0)).toBe(true);
  }, 30_000);
});
