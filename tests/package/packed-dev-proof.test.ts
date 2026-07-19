import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("packed dev proof", () => {
  it("uses only the installed CLI/runtime graph and proves replacement in a real browser", async () => {
    const [source, localProof, ci, candidate] = await Promise.all([
      readFile("scripts/release/test-packed-dev.mjs", "utf8"),
      readFile("scripts/release/test-packed-local.mjs", "utf8"),
      readFile(".github/workflows/ci.yml", "utf8"),
      readFile(".github/workflows/release-candidate.yml", "utf8")
    ]);
    expect(source).toContain('"node_modules",\n    "@pixel-point",\n    "aval-compiler"');
    expect(source).not.toContain("packages/compiler/dist/cli.js");
    expect(source).toContain('headers: { Range: "bytes=0-31" }');
    expect(source).toContain('range.headers.get("etag")');
    expect(source).toContain('await chromium.launch({ channel: "chromium", headless: true })');
    expect(source).toContain("await viteBuild({");
    expect(source).toContain("await vitePreview({");
    expect(source).not.toContain("createServer as createViteServer");
    expect(source).toContain('waitForElementReady(starterPage, "interactiveReady")');
    expect(source).toContain('waitForElementReady(failurePage, "error")');
    expect(source).toContain("failureSnapshot.fallbackSlotCount === 0");
    expect(source).toContain("await starterFailures.assertWorkerExecuted()");
    expect(source).toContain("await browserFailures.assertWorkerExecuted()");
    expect(source).toContain("__avalWorkerEvidence");
    expect(source).toContain('new URL(`${asset.codec}.avl`, url)');
    expect(source).toContain('["av1", "vp9", "h265", "h264"]');
    expect(source).toContain('new URL("build.json", url)');
    expect(source).not.toContain('new URL("asset.avl", url)');
    expect(source).toContain("[A-Za-z0-9_-]{43}");
    expect(source).toContain("unscoped dev origin unexpectedly returned");
    expect(localProof).toContain("--test-only-packed-proof");
    expect(localProof).toContain('externalPublication: false');
    expect(source).toContain('starterPage.locator("#favorite").hover()');
    expect(source).toContain("replacementSnapshot.sourceGeneration > initialSnapshot.sourceGeneration");
    expect(source).toContain('child.kill("SIGINT")');
    expect(source).not.toContain("url.startsWith(`blob:");
    expect(source).not.toContain('url.startsWith("data:")');
    expect(source).not.toContain('url !== "about:blank"');
    expect(ci).toContain("node scripts/release/test-packed-local.mjs");
    expect(candidate).toContain("node scripts/release/test-packed-dev.mjs --packages artifacts/1.0.0/packages");
    expect(ci).toContain("node scripts/performance/measure-m8-bundles.mjs");
  });
});
