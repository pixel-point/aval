import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("workflow hardening", () => {
  it("builds the canonical format codec authority before Brave evidence imports it", async () => {
    const [workflow, matrix, assembler, validator] = await Promise.all([
      readFile(".github/workflows/brave-windows-compatibility.yml", "utf8"),
      readFile("scripts/browser-compatibility/brave/run-matrix.mjs", "utf8"),
      readFile("scripts/browser-compatibility/assemble-live-evidence.mjs", "utf8"),
      readFile("scripts/browser-compatibility/validate-evidence.mjs", "utf8")
    ]);
    const installIndex = workflow.indexOf("npm ci --ignore-scripts");
    const graphBuildIndex = workflow.indexOf(
      "npm run build -w @pixel-point/aval-graph"
    );
    const formatBuildIndex = workflow.indexOf(
      "npm run build -w @pixel-point/aval-format"
    );
    const matrixRunIndex = workflow.indexOf(
      "node scripts/browser-compatibility/brave/run-matrix.mjs"
    );
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(installIndex).toBeLessThan(graphBuildIndex);
    expect(graphBuildIndex).toBeLessThan(formatBuildIndex);
    expect(formatBuildIndex).toBeLessThan(matrixRunIndex);
    for (const source of [matrix, assembler, validator]) {
      expect(source).toContain('from "@pixel-point/aval-format"');
      expect(source).not.toContain("canonical-codec.mjs");
    }
    expect(matrix).toContain("parseVideoCodecString");
  });

  it("pins scheduled native-tool tests to the root Vitest configuration", async () => {
    const [workflow, regenerationScript, certificationPackage] = await Promise.all([
      readFile(".github/workflows/scheduled-hardening.yml", "utf8"),
      readFile("scripts/fixtures/regenerate-semantic-check.mjs", "utf8"),
      readFile("packages/certification/package.json", "utf8")
    ]);
    expect(workflow).toContain(
      "npm run fixtures:regeneration-check -- --tool-backed"
    );
    expect(regenerationScript).toMatch(
      /"vitest",\s*"run",\s*"--config",\s*resolve\(root, "vitest\.m9\.config\.ts"\)/u
    );
    expect(JSON.parse(certificationPackage).scripts.test).toBe(
      "cd ../.. && vitest run --config vitest.m9.config.ts " +
      "packages/certification/test"
    );
  });

  it("binds candidate, named reports, final release, next publication, and latest promotion as separate authorities", async () => {
    const [candidate, reports, final, publish, rollback] = await Promise.all([
      readFile(".github/workflows/release-candidate.yml", "utf8"),
      readFile(".github/workflows/release-reports.yml", "utf8"),
      readFile(".github/workflows/release-final.yml", "utf8"),
      readFile(".github/workflows/publish.yml", "utf8"),
      readFile(".github/workflows/rollback.yml", "utf8")
    ]);
    expect(candidate).toContain("environment: release-candidate");
    expect(candidate).toContain("path: artifacts/1.0.0/candidate");
    expect(candidate).not.toMatch(/path:\s*artifacts\/1\.0\.0\s*$/mu);
    expect(reports).toContain("environment: release-reports");
    expect(reports.match(/^\s+run-id:/gmu)).toHaveLength(2);
    expect(reports.match(/^\s+github-token:/gmu)).toHaveLength(2);
    expect(reports).toContain("render-report-index.mjs");
    expect(reports).toContain("verify-workflow-run.mjs");
    expect(reports).toContain(".github/workflows/release-candidate.yml");
    expect(reports).toContain("--require-passed true");
    expect(reports).toContain("--require-closed-root true");
    expect(reports).toContain("path: incoming/reports");
    expect(final.match(/^\s+run-id:/gmu)).toHaveLength(2);
    expect(final.match(/^\s+github-token:/gmu)).toHaveLength(2);
    expect(final).toContain("verify-workflow-run.mjs");
    expect(final).toContain(".github/workflows/release-reports.yml");
    expect(final).toContain("finalize-release.mjs");
    expect(final).toContain("path: artifacts/final-release");
    expect(publish).toContain("environment: npm-publish-next");
    expect(publish).toContain("environment: npm-promote-latest");
    expect(publish).toContain("needs: publish-next");
    expect(publish).toContain("NPM_SHORT_LIVED_DIST_TAG_TOKEN");
    expect(publish).not.toMatch(/release:pack|build-packages\.mjs/u);
    expect(rollback).toContain("environment: npm-rollback");
    expect(rollback).not.toContain("previous-version");
    expect(rollback).not.toContain("--previous");
    expect(rollback).toContain("never unpublishes immutable 1.0.0 bytes");
    expect(rollback.match(/^\s+run-id:/gmu)).toHaveLength(3);
    expect(rollback.match(/^\s+github-token:/gmu)).toHaveLength(3);
    for (const workflow of [candidate, reports, final, publish, rollback]) {
      const lines = workflow.split(/\r?\n/u);
      expect(lines.filter((line) => /^\s*run:/u.test(line)).some((line) => /\$\{\{\s*inputs\./u.test(line))).toBe(false);
    }
  });

  it("implements first-release withdrawal through tag removal and deprecation only", async () => {
    const [rollbackWorkflow, rollbackScript, policy] = await Promise.all([
      readFile(".github/workflows/rollback.yml", "utf8"),
      readFile("scripts/release/rollback-dist-tags.mjs", "utf8"),
      readFile("config/release/release-policy.json", "utf8")
    ]);
    expect(JSON.parse(policy)).toMatchObject({ rollback: { previousKnownGood: "none" } });
    expect(rollbackWorkflow).not.toContain("previous-version");
    expect(rollbackScript).toContain('["dist-tag", "rm", name, desiredTag]');
    expect(rollbackScript).toContain('["deprecate", `${name}@1.0.0`, notice]');
    expect(`${rollbackWorkflow}\n${rollbackScript}`).not.toMatch(/npm\s+unpublish|\["unpublish"/u);
  });
});
