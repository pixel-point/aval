import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createLicenseReport, reconcileLicenseReport, validateLicensePolicy } from "../../scripts/security/license-model.mjs";
import { reconcileWorkspaceSbom, validateSpdxDocument } from "../../scripts/security/sbom-model.mjs";

const execFileAsync = promisify(execFile);

describe("release supply-chain policy", () => {
  it("evaluates required compound licenses atomically and fails closed on alternatives", () => {
    const policy = {
      schemaVersion: "1.0",
      allowed: ["Apache-2.0", "MIT"],
      reviewRequired: ["LGPL-3.0-or-later"],
      denied: ["AGPL-3.0-only"]
    };
    expect(() => validateLicensePolicy({
      ...policy,
      allowed: [...policy.allowed, "MIT AND AGPL-3.0-only"]
    })).toThrow(/license policy allowed is invalid/u);

    const lockWith = (license: string) => Buffer.from(JSON.stringify({
      packages: {
        "node_modules/example": {
          name: "example",
          version: "1.0.0",
          integrity: "sha512-example",
          license
        }
      }
    }));
    const policyBytes = Buffer.from(JSON.stringify(policy));

    expect(() => createLicenseReport(
      lockWith("Apache-2.0 AND LGPL-3.0-or-later"),
      policyBytes
    )).toThrow(/requires an explicit policy record/u);
    expect(() => createLicenseReport(
      lockWith("MIT AND AGPL-3.0-only"),
      policyBytes
    )).toThrow(/denied license AGPL-3\.0-only in expression/u);
    expect(() => createLicenseReport(
      lockWith("MIT OR AGPL-3.0-only"),
      policyBytes
    )).toThrow(/unsupported license expression/u);
  });

  it.each([
    "scripts/security/check-lockfile.mjs",
    "scripts/security/check-workflows.mjs"
  ])("passes %s", async (script) => {
    const { stdout } = await execFileAsync(process.execPath, [script], { cwd: process.cwd(), maxBuffer: 1024 * 1024 });
    expect(JSON.parse(stdout)).toMatchObject({ status: "passed" });
  });

  it("keeps unreviewed build dependencies fail-closed", async () => {
    const failure = await execFileAsync(
      process.execPath,
      ["scripts/security/check-licenses.mjs"],
      { cwd: process.cwd(), maxBuffer: 1024 * 1024 }
    ).then(
      () => { throw new Error("license check unexpectedly passed"); },
      (error: unknown) => error as { readonly stderr: string }
    );
    expect(failure.stderr).toContain(
      "node_modules/minimatch: license BlueOak-1.0.0 requires an explicit policy record"
    );
    expect(failure.stderr).toContain(
      "node_modules/caniuse-lite: license CC-BY-4.0 requires an explicit policy record"
    );
    expect(failure.stderr).toContain(
      "node_modules/@img/sharp-libvips-darwin-arm64: license LGPL-3.0-or-later requires an explicit policy record"
    );
  });

  it("generates and validates a bounded SPDX 2.3 inventory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aval-sbom-"));
    const output = join(directory, "workspace.spdx.json");
    const second = join(directory, "workspace-second.spdx.json");
    try {
      await execFileAsync(process.execPath, ["scripts/security/generate-sbom.mjs", "--output", output], { cwd: process.cwd() });
      await execFileAsync(process.execPath, ["scripts/security/generate-sbom.mjs", "--output", second], { cwd: process.cwd() });
      const { stdout } = await execFileAsync(process.execPath, ["scripts/security/validate-sbom.mjs", output], { cwd: process.cwd() });
      expect(JSON.parse(stdout)).toMatchObject({ status: "passed", packages: expect.any(Number) });
      expect(await readFile(second)).toEqual(await readFile(output));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects workspace SBOM and license-report substitutions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aval-supply-substitution-"));
    const output = join(directory, "workspace.spdx.json");
    try {
      await execFileAsync(process.execPath, ["scripts/security/generate-sbom.mjs", "--output", output], { cwd: process.cwd() });
      const [sbom, lockBytes, policyBytes] = await Promise.all([
        readFile(output, "utf8").then(JSON.parse),
        readFile("package-lock.json"),
        readFile("config/release/license-policy.json")
      ]);
      expect(validateSpdxDocument(sbom)).toBe(sbom);
      expect(() => validateSpdxDocument({ ...sbom, packages: [{ ...sbom.packages[0], smuggled: true }, ...sbom.packages.slice(1)] })).toThrow(/package fields/u);
      expect(() => reconcileWorkspaceSbom({ ...sbom, relationships: sbom.relationships.slice(1) }, lockBytes)).toThrow(/relationship coverage/u);
      expect(() => reconcileWorkspaceSbom({ ...sbom, documentNamespace: `${sbom.documentNamespace.slice(0, -64)}${"0".repeat(64)}` }, lockBytes)).toThrow(/lockfile digest/u);
      expect(() => reconcileWorkspaceSbom({ ...sbom, packages: [{ ...sbom.packages[0], versionInfo: "9.9.9" }, ...sbom.packages.slice(1)] }, lockBytes)).toThrow(/package mismatch/u);
      const policy = JSON.parse(policyBytes.toString("utf8"));
      const syntheticReviewedPolicy = Buffer.from(JSON.stringify({
        ...policy,
        allowed: [...policy.allowed, ...policy.reviewRequired],
        reviewRequired: []
      }));
      const report = createLicenseReport(lockBytes, syntheticReviewedPolicy);
      expect(reconcileLicenseReport(report, lockBytes, syntheticReviewedPolicy)).toBe(report);
      expect(() => reconcileLicenseReport({ ...report, packages: report.packages.slice(1) }, lockBytes, syntheticReviewedPolicy)).toThrow(/does not reconstruct/u);
      const changedPolicy = Buffer.from(JSON.stringify({ schemaVersion: "1.0", allowed: [], reviewRequired: [], denied: [] }));
      expect(() => reconcileLicenseReport(report, lockBytes, changedPolicy)).toThrow(/unapproved license|does not reconstruct/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
