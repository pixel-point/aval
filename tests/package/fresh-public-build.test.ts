import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { assertDistributionDerived, installVerifiedDistributions } from "../../scripts/release/fresh-public-build.mjs";
import { ensureCompilerCliExecutable } from "../../scripts/release/compiler-cli-mode.mjs";
import { ELEMENT_RELEASE_TYPESCRIPT_ROOTS, ELEMENT_RELEASE_WORKER } from "../../scripts/release/element-release-contract.mjs";
import { RELEASE_PACKAGE_SPECS, releasePackageSpecification } from "../../scripts/release/release-set-model.mjs";
import { COMPILER_WORKER_REGISTRY_ENTRY } from "../../scripts/release/worker-entry-contract.mjs";

describe("fresh public distribution provenance", () => {
  it("restores the executable mode on a freshly emitted compiler CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-cli-mode-"));
    try {
      const cli = join(root, "cli.js");
      await writeFile(cli, "#!/usr/bin/env node\nconsole.log('ok');\n");
      await chmod(cli, 0o644);
      await ensureCompilerCliExecutable(cli);
      expect((await stat(cli)).mode & 0o111).toBe(0o111);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not emit the TypeScript 7 removed baseUrl option", async () => {
    const source = await readFile("scripts/release/fresh-public-build.mjs", "utf8");
    expect(source).not.toMatch(/\bbaseUrl\s*:/u);
  });

  it("keeps the compiler worker registry in its canonical emitted form", async () => {
    await expect(readFile(
      `packages/compiler/src/${COMPILER_WORKER_REGISTRY_ENTRY.output}`,
      "utf8"
    )).resolves.toBe(COMPILER_WORKER_REGISTRY_ENTRY.contents);
  });

  it("rejects stale removed output and accepts only source-derived JS/declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-fresh-dist-"));
    try {
      const source = join(root, "src");
      const distribution = join(root, "dist");
      await mkdir(source);
      await mkdir(distribution);
      await writeFile(join(source, "index.ts"), "export const current = true;\n");
      await writeFile(join(distribution, "index.js"), "export const current = true;\n");
      await writeFile(join(distribution, "index.d.ts"), "export declare const current = true;\n");
      await writeFile(join(distribution, "element.release.tsbuildinfo"), "{}\n");
      await writeFile(join(distribution, ELEMENT_RELEASE_WORKER.output), "export {};\n");
      await writeFile(join(distribution, "stale-owner.js"), "export const stale = true;\n");
      await expect(assertDistributionDerived({ source, sourceFiles: ["index.ts"], distribution, packageName: "@pixel-point/aval-element" })).rejects.toThrow(/stale-owner\.js/u);
      await rm(join(distribution, "stale-owner.js"));
      await expect(assertDistributionDerived({ source, sourceFiles: ["index.ts"], distribution, packageName: "@pixel-point/aval-element" })).resolves.toMatchObject({
        outputs: [ELEMENT_RELEASE_WORKER.output, "element.release.tsbuildinfo", "index.d.ts", "index.js"]
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an omitted output even when a release tsconfig accidentally excludes its source", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-fresh-omission-"));
    try {
      const source = join(root, "src");
      const distribution = join(root, "dist");
      await mkdir(source);
      await mkdir(distribution);
      await writeFile(join(source, "index.ts"), "export {};\n");
      await writeFile(join(source, "excluded-by-drift.ts"), "export const required = true;\n");
      for (const path of ["index.js", "index.js.map", "index.d.ts", "index.d.ts.map", "graph.tsbuildinfo"]) await writeFile(join(distribution, path), "{}\n");
      await expect(assertDistributionDerived({ source, sourceFiles: ["excluded-by-drift.ts", "index.ts"], distribution, packageName: "@pixel-point/aval-graph" })).rejects.toThrow(/missing required.*excluded-by-drift/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts source-derived TSX output and rejects emitted TSX test output", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-fresh-tsx-"));
    try {
      const source = join(root, "src");
      const distribution = join(root, "dist");
      await mkdir(source);
      await mkdir(distribution);
      await writeFile(join(source, "component.tsx"), "export const Component = () => null;\n");
      await writeFile(join(source, "behavior.test.tsx"), "export {};\n");
      for (const path of ["component.js", "component.d.ts", "react.release.tsbuildinfo"]) await writeFile(join(distribution, path), "export {};\n");
      await expect(assertDistributionDerived({ source, sourceFiles: ["component.tsx"], distribution, packageName: "@pixel-point/aval-react" })).resolves.toMatchObject({
        outputs: ["component.d.ts", "component.js", "react.release.tsbuildinfo"]
      });
      await writeFile(join(distribution, "behavior.test.js"), "export {};\n");
      await expect(assertDistributionDerived({ source, sourceFiles: ["component.tsx"], distribution, packageName: "@pixel-point/aval-react" })).rejects.toThrow(/test output|exact release emission contract/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects emitted test output even when a similarly named source exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-fresh-test-"));
    try {
      const source = join(root, "src");
      const distribution = join(root, "dist");
      await mkdir(source);
      await mkdir(distribution);
      await writeFile(join(source, "index.ts"), "export {};\n");
      await writeFile(join(source, "behavior.test.ts"), "export {};\n");
      for (const path of ["index.js", "index.d.ts", "behavior.test.js"]) await writeFile(join(distribution, path), "export {};\n");
      await expect(assertDistributionDerived({ source, sourceFiles: ["index.ts"], distribution, packageName: "@pixel-point/aval-graph" })).rejects.toThrow(/exact release emission contract|test output/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts only the canonical compiler worker registry as JSON release source", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-fresh-registry-"));
    try {
      const source = join(root, "src");
      const distribution = join(root, "dist");
      const sourceCommands = join(source, "commands");
      const distributionCommands = join(distribution, "commands");
      await mkdir(sourceCommands, { recursive: true });
      await mkdir(distributionCommands, { recursive: true });
      await writeFile(join(source, "index.ts"), "export {};\n");
      await writeFile(
        join(source, COMPILER_WORKER_REGISTRY_ENTRY.output),
        COMPILER_WORKER_REGISTRY_ENTRY.contents
      );
      for (const path of ["index.js", "index.js.map", "index.d.ts", "index.d.ts.map", "compiler.tsbuildinfo"]) {
        await writeFile(join(distribution, path), "{}\n");
      }
      await writeFile(
        join(distribution, COMPILER_WORKER_REGISTRY_ENTRY.output),
        COMPILER_WORKER_REGISTRY_ENTRY.contents
      );
      await expect(assertDistributionDerived({
        source,
        sourceFiles: [COMPILER_WORKER_REGISTRY_ENTRY.output, "index.ts"],
        distribution,
        packageName: COMPILER_WORKER_REGISTRY_ENTRY.packageName
      })).resolves.toMatchObject({
        outputs: [
          COMPILER_WORKER_REGISTRY_ENTRY.output,
          "compiler.tsbuildinfo",
          "index.d.ts",
          "index.d.ts.map",
          "index.js",
          "index.js.map"
        ]
      });

      await writeFile(join(source, "unreviewed.json"), "{}\n");
      await expect(assertDistributionDerived({
        source,
        sourceFiles: [COMPILER_WORKER_REGISTRY_ENTRY.output, "index.ts", "unreviewed.json"],
        distribution,
        packageName: COMPILER_WORKER_REGISTRY_ENTRY.packageName
      })).rejects.toThrow(/invalid source: unreviewed\.json/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("defines the element release from public TypeScript roots plus its URL worker", async () => {
    expect(ELEMENT_RELEASE_TYPESCRIPT_ROOTS).toEqual(["index.ts", "auto.ts"]);
    expect(ELEMENT_RELEASE_WORKER).toEqual({ source: "decoder-worker.ts", output: "decoder-worker.js" });
    const config = JSON.parse(await readFile("packages/element/tsconfig.release.json", "utf8")) as {
      files?: string[];
      include?: string[];
    };
    expect(config.files).toEqual(ELEMENT_RELEASE_TYPESCRIPT_ROOTS.map((path) => `src/${path}`));
    expect(config.include).toEqual([]);
    const releaseContract = releasePackageSpecification("@pixel-point/aval-element");
    expect(releaseContract.buildConfig.source).toEqual({ kind: "files", paths: ELEMENT_RELEASE_TYPESCRIPT_ROOTS });
    expect(releaseContract.buildConfig.buildSteps).toEqual(["element-worker"]);
    expect(releasePackageSpecification(COMPILER_WORKER_REGISTRY_ENTRY.packageName).buildConfig.additionalSources).toEqual([COMPILER_WORKER_REGISTRY_ENTRY.output]);
  });

  it("restores every previous dist when a later verified atomic install fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-fresh-install-"));
    try {
      const staged = new Map<string, string>();
      for (const { name, directory: short } of RELEASE_PACKAGE_SPECS) {
        const current = join(root, "packages", short, "dist");
        const next = join(root, "staged", short);
        await mkdir(current, { recursive: true });
        await mkdir(next, { recursive: true });
        await writeFile(join(current, "identity"), `old-${short}`);
        await writeFile(join(next, "identity"), `new-${short}`);
        staged.set(name, next);
      }
      const renameEntry = async (source: string, target: string) => {
        if (source === staged.get("@pixel-point/aval-player-web")) throw new Error("injected install failure");
        await rename(source, target);
      };
      await expect(installVerifiedDistributions({ root, staged, backupRoot: join(root, "backup"), renameEntry })).rejects.toThrow(/injected install failure/u);
      for (const { directory: short } of RELEASE_PACKAGE_SPECS) expect(await readFile(join(root, "packages", short, "dist", "identity"), "utf8")).toBe(`old-${short}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
