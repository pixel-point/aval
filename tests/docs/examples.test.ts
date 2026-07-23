import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("executable documentation", () => {
  it("keeps links, public imports, exact versions, and generated support data consistent", async () => {
    const { stdout } = await execFileAsync(process.execPath, ["scripts/docs/check-docs.mjs"], { cwd: process.cwd(), maxBuffer: 1024 * 1024 });
    expect(JSON.parse(stdout)).toMatchObject({ status: "passed", examples: 6 });
  });
});
