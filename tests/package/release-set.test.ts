import { gunzipSync, gzipSync } from "node:zlib";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { inspectTarballBytes } from "../../scripts/release/inspect-tarball.mjs";
import { packInstalledClosure } from "../../scripts/release/local-package-archives.mjs";
import { ELEMENT_RELEASE_WORKER } from "../../scripts/release/element-release-contract.mjs";
import { createPublishManifest, validatePublishManifest } from "../../scripts/release/publish-manifest.mjs";
import { COMPILER_WORKER_REGISTRY_ENTRY } from "../../scripts/release/worker-entry-contract.mjs";
import {
  PRODUCTION_PUBLIC_ENTRIES,
  RELEASE_PACKAGE_NAMES,
  RELEASE_PACKAGE_SPECS,
  loadVerifiedReleaseSet,
  releaseArchiveFilename,
  releasePackageDirectory,
  releasePackageSpecification,
  releaseSetSummary,
  topologicalPackageOrder,
  validateReleasePackageManifests
} from "../../scripts/release/release-set.mjs";

const policy = { releaseVersion: "1.0.0" as const, publicPackages: RELEASE_PACKAGE_NAMES };

describe("verified six-package release set", () => {
  it("derives the one safe publication order and rejects graph drift", () => {
    expect(RELEASE_PACKAGE_NAMES).toEqual([
      "@pixel-point/aval-graph",
      "@pixel-point/aval-format",
      "@pixel-point/aval-element",
      "@pixel-point/aval-player-web",
      "@pixel-point/aval-compiler",
      "@pixel-point/aval-react"
    ]);
    expect(RELEASE_PACKAGE_SPECS.map(({ directory }) => directory)).toEqual(["graph", "format", "player-web", "element", "compiler", "react"]);
    for (const specification of RELEASE_PACKAGE_SPECS) {
      expect(Object.isFrozen(specification)).toBe(true);
      expect(Object.isFrozen(specification.peerDependencies)).toBe(true);
      expect(Object.isFrozen(specification.exports)).toBe(true);
      expect(Object.isFrozen(specification.bin)).toBe(true);
      expect(Object.isFrozen(specification.buildConfig)).toBe(true);
      expect(Object.isFrozen(specification.buildConfig.source)).toBe(true);
      expect(Object.isFrozen(specification.productionEntries)).toBe(true);
      expect(typeof specification.buildInfo).toBe("string");
    }
    expect(releasePackageSpecification("@pixel-point/aval-compiler").productionEntries).toEqual([]);
    for (const entry of PRODUCTION_PUBLIC_ENTRIES) {
      const specification = releasePackageSpecification(entry.package);
      expect(specification.productionEntries).toContainEqual({ export: entry.export, requiredInGraph: entry.requiredInGraph });
      expect(specification.exports[entry.export]).toEqual(expect.objectContaining({ import: `./${entry.path}` }));
    }
    expect(releaseArchiveFilename("@pixel-point/aval-graph")).toBe("pixel-point-aval-graph-1.0.0.tgz");
    expect(() => releaseArchiveFilename("@pixel-point/aval-unknown")).toThrow(/unknown release package/u);
    expect(topologicalPackageOrder(RELEASE_PACKAGE_SPECS)).toEqual(RELEASE_PACKAGE_NAMES);
    expect(() => topologicalPackageOrder([
      { name: "a", dependencies: ["b"] },
      { name: "b", dependencies: ["a"] }
    ])).toThrow(/cycle/u);
    expect(() => topologicalPackageOrder([{ name: "a", dependencies: ["missing"] }])).toThrow(/unknown/u);
  });

  it("rejects duplicate, missing, unknown, and inexact internal dependencies", () => {
    const manifests = RELEASE_PACKAGE_SPECS.map(({ name, dependencies }) => packageManifest(name, dependencies));
    expect(validateReleasePackageManifests(manifests).map(({ name }) => name)).toEqual(RELEASE_PACKAGE_NAMES);
    expect(() => validateReleasePackageManifests([...manifests.slice(0, -1), manifests[0]!])).toThrow(/duplicate/u);
    expect(() => validateReleasePackageManifests(manifests.slice(0, -1))).toThrow(/exactly 6/u);
    expect(() => validateReleasePackageManifests(manifests.map((manifest) => manifest.name === "@pixel-point/aval-graph"
      ? { ...manifest, dependencies: { "@pixel-point/aval-unknown": "1.0.0" } }
      : manifest))).toThrow(/exact reviewed set/u);
    expect(() => validateReleasePackageManifests(manifests.map((manifest) => manifest.name === "@pixel-point/aval-format"
      ? { ...manifest, dependencies: { "@pixel-point/aval-graph": "^1.0.0" } }
      : manifest))).toThrow(/must be exactly/u);
  });

  it("opens and reconciles exactly six canonical archive instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-release-set-"));
    try {
      for (const { name, dependencies } of RELEASE_PACKAGE_SPECS) {
        await writeFile(join(root, filename(name)), packageArchive(packageManifest(name, dependencies)));
      }
      const first = await loadVerifiedReleaseSet({ directory: root, policy });
      expect(first.packages.map(({ name }) => name)).toEqual(RELEASE_PACKAGE_NAMES);
      const summary = releaseSetSummary(first);
      const second = await loadVerifiedReleaseSet({ directory: root, policy, packageIndex: summary });
      expect(second.releaseSetDigest).toBe(first.releaseSetDigest);
      const substituted = structuredClone(summary) as { packages: { sha256: string }[] };
      substituted.packages[0]!.sha256 = "0".repeat(64);
      await expect(loadVerifiedReleaseSet({ directory: root, policy, packageIndex: substituted })).rejects.toThrow(/does not match archive bytes/u);
      await writeFile(join(root, "extra.tgz"), Buffer.from("not a tarball"));
      await expect(loadVerifiedReleaseSet({ directory: root, policy })).rejects.toThrow(/exactly 6/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects hidden and non-tarball package-directory entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-release-hidden-"));
    try {
      for (const { name, dependencies } of RELEASE_PACKAGE_SPECS) await writeFile(join(root, filename(name)), packageArchive(packageManifest(name, dependencies)));
      await writeFile(join(root, ".swapped.tgz"), packageArchive(packageManifest("@pixel-point/aval-graph", [])));
      await expect(loadVerifiedReleaseSet({ directory: root, policy })).rejects.toThrow(/exactly 6/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked archive before parsing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-release-link-"));
    try {
      for (const { name, dependencies } of RELEASE_PACKAGE_SPECS) {
        const archive = packageArchive(packageManifest(name, dependencies));
        if (name === "@pixel-point/aval-graph") {
          await writeFile(join(root, "outside.tgz"), archive);
          await symlink("outside.tgz", join(root, filename(name)));
        } else await writeFile(join(root, filename(name)), archive);
      }
      await expect(loadVerifiedReleaseSet({ directory: root, policy })).rejects.toThrow(/non-tarball|exactly 6|symbolic/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("packs named installed dependencies and their manifest-derived closure once", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-local-closure-"));
    try {
      const modules = join(root, "node_modules");
      await mkdir(join(modules, "fixture-root"), { recursive: true });
      await mkdir(join(modules, "fixture-leaf"), { recursive: true });
      await writeFile(join(modules, "fixture-root", "package.json"), `${JSON.stringify({ name: "fixture-root", version: "1.0.0", dependencies: { "fixture-leaf": "1.0.0" } })}\n`);
      await writeFile(join(modules, "fixture-leaf", "package.json"), `${JSON.stringify({ name: "fixture-leaf", version: "1.0.0" })}\n`);
      await expect(packInstalledClosure({
        root,
        destination: join(root, "archives"),
        packages: ["fixture-root", "fixture-root"]
      })).resolves.toEqual([
        join(root, "archives", "fixture-root-1.0.0.tgz"),
        join(root, "archives", "fixture-leaf-1.0.0.tgz")
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("bounded tar inspection", () => {
  it("rejects links, special entries, duplicate/case-colliding paths, and TypeScript source", () => {
    const manifest = packageManifest("@pixel-point/aval-graph", []);
    expect(() => inspectTarballBytes(tarGzip([
      ...baseEntries(manifest),
      { path: "package/link", bytes: Buffer.alloc(0), type: "2" }
    ]))).toThrow(/link, extension, or special/u);
    expect(() => inspectTarballBytes(tarGzip([
      ...baseEntries(manifest),
      { path: "package/dist/INDEX.js", bytes: Buffer.from("export {};\n") }
    ]))).toThrow(/case-colliding/u);
    expect(() => inspectTarballBytes(tarGzip([
      ...baseEntries(manifest),
      { path: "package/dist/private.ts", bytes: Buffer.from("export {};\n") }
    ]))).toThrow(/TypeScript source/u);
  });

  it("rejects an element archive that omits its URL-referenced worker", () => {
    const manifest = packageManifest(
      "@pixel-point/aval-element",
      ["@pixel-point/aval-graph", "@pixel-point/aval-format"]
    );
    const withoutWorker = baseEntries(manifest).filter(({ path }) => path !== `package/dist/${ELEMENT_RELEASE_WORKER.output}`);
    expect(() => inspectTarballBytes(tarGzip(withoutWorker))).toThrow(new RegExp(`missing dist/${ELEMENT_RELEASE_WORKER.output.replace(".", "\\.")}`, "u"));
  });

  it("requires the exact compiler worker registry and rejects every other JSON payload", () => {
    const compiler = packageManifest("@pixel-point/aval-compiler", [
      "@pixel-point/aval-graph",
      "@pixel-point/aval-format",
      "@pixel-point/aval-element",
      "@pixel-point/aval-player-web"
    ]);
    const inspected = inspectTarballBytes(tarGzip(baseEntries(compiler)));
    expect(inspected.files).toContain(`dist/${COMPILER_WORKER_REGISTRY_ENTRY.output}`);

    const withoutRegistry = baseEntries(compiler).filter(({ path }) =>
      path !== `package/dist/${COMPILER_WORKER_REGISTRY_ENTRY.output}`
    );
    expect(() => inspectTarballBytes(tarGzip(withoutRegistry))).toThrow(
      new RegExp(`missing dist/${COMPILER_WORKER_REGISTRY_ENTRY.output.replaceAll(".", "\\.")}`, "u")
    );

    const tamperedRegistry = baseEntries(compiler).map((entry) =>
      entry.path === `package/dist/${COMPILER_WORKER_REGISTRY_ENTRY.output}`
        ? { ...entry, bytes: Buffer.from("[]\n") }
        : entry
    );
    expect(() => inspectTarballBytes(tarGzip(tamperedRegistry))).toThrow(/non-canonical compiler worker registry/u);

    expect(() => inspectTarballBytes(tarGzip([
      ...baseEntries(compiler),
      { path: "package/dist/unreviewed.json", bytes: Buffer.from("{}\n") }
    ]))).toThrow(/unreviewed distribution file type/u);
  });

  it("rejects lifecycle hooks, publish redirection, and decompression bombs", () => {
    expect(() => inspectTarballBytes(packageArchive({
      ...packageManifest("@pixel-point/aval-graph", []),
      scripts: { install: "node surprise.js" }
    }))).toThrow(/forbidden publish manifest key/u);
    expect(() => inspectTarballBytes(packageArchive({
      ...packageManifest("@pixel-point/aval-graph", []),
      publishConfig: { registry: "https://attacker.invalid/" }
    }))).toThrow(/forbidden publish manifest key/u);
    expect(() => inspectTarballBytes(packageArchive(packageManifest("@pixel-point/aval-graph", [])), { maximumUnpackedBytes: 512 })).toThrow(/bounded gzip/u);
  });

  it("rejects external dependencies, unexpected bins/exports, and native distribution payloads", () => {
    const graph = packageManifest("@pixel-point/aval-graph", []);
    const react = packageManifest("@pixel-point/aval-react", ["@pixel-point/aval-element"]);
    const publishedReact = createPublishManifest({
      ...react,
      devDependencies: { "react-dom": "19.2.7" },
      peerDependenciesMeta: { react: { optional: true } }
    });
    expect(() => validatePublishManifest({ ...graph, dependencies: { leftpad: "1.3.0" } })).toThrow(/exact reviewed set/u);
    expect(publishedReact.peerDependencies).toEqual({ react: "^18.3.0 || ^19.0.0" });
    expect(publishedReact).not.toHaveProperty("devDependencies");
    expect(publishedReact).not.toHaveProperty("peerDependenciesMeta");
    expect(validatePublishManifest(react)).toBe(react);
    expect(() => validatePublishManifest({ ...react, peerDependencies: { react: "^19.0.0" } })).toThrow(/peerDependencies/u);
    expect(() => validatePublishManifest({ ...react, peerDependencies: undefined })).toThrow(/peerDependencies/u);
    expect(() => validatePublishManifest({ ...graph, peerDependencies: { react: "^18.3.0 || ^19.0.0" } })).toThrow(/peerDependencies/u);
    expect(() => validatePublishManifest({ ...graph, bin: { surprise: "./dist/index.js" } })).toThrow(/bin map/u);
    expect(() => validatePublishManifest({ ...graph, exports: { ...graph.exports, "./private": "./dist/private.js" } })).toThrow(/reviewed public surface/u);
    expect(() => inspectTarballBytes(tarGzip([...baseEntries(graph), { path: "package/dist/native.node", bytes: Buffer.from("native") }]))).toThrow(/unreviewed distribution file type/u);
    expect(() => inspectTarballBytes(tarGzip([...baseEntries(graph), { path: "package/dist/runtime.wasm", bytes: Buffer.from("wasm") }]))).toThrow(/unreviewed distribution file type/u);
  });

  it("rejects path normalization collisions and non-zero data after the terminator", () => {
    const manifest = packageManifest("@pixel-point/aval-graph", []);
    expect(() => inspectTarballBytes(tarGzip([
      ...baseEntries(manifest),
      { path: "package/dist/caf\u00e9.js", bytes: Buffer.from("export {};\n") },
      { path: "package/dist/cafe\u0301.js", bytes: Buffer.from("export {};\n") }
    ]))).toThrow(/non-canonical|colliding/u);
    const tar = gunzip(packageArchive(manifest));
    tar[tar.byteLength - 1] = 1;
    expect(() => inspectTarballBytes(gzipSync(tar))).toThrow(/after its tar terminator/u);
  });

  it("rejects non-USTAR headers and non-zero payload padding", () => {
    const manifest = packageManifest("@pixel-point/aval-graph", []);
    const wrongDialect = gunzip(packageArchive(manifest));
    wrongDialect.write("xxxxx\0", 257, 6, "ascii");
    rewriteChecksum(wrongDialect.subarray(0, 512));
    expect(() => inspectTarballBytes(gzipSync(wrongDialect))).toThrow(/unsupported tar dialect/u);
    const badPadding = gunzip(packageArchive(manifest));
    const firstSize = Number.parseInt(badPadding.subarray(124, 135).toString("ascii"), 8);
    badPadding[512 + firstSize] = 1;
    expect(() => inspectTarballBytes(gzipSync(badPadding))).toThrow(/padding is non-zero/u);
  });
});

interface TestManifest {
  name: string;
  version: string;
  private: boolean;
  type: string;
  license: string;
  files: string[];
  sideEffects: boolean | readonly string[];
  exports: Readonly<Record<string, unknown>>;
  dependencies: Record<string, string>;
  peerDependencies?: Readonly<Record<string, string>>;
  engines: { node: string };
  repository: { type: string; url: string; directory: string };
  homepage: string;
  bugs: { url: string };
  bin?: Readonly<Record<string, string>>;
  scripts?: Record<string, string>;
  publishConfig?: Record<string, string>;
}

function packageManifest(name: string, dependencies: readonly string[]): TestManifest {
  const specification = releasePackageSpecification(name);
  return {
    name,
    version: "1.0.0",
    private: false,
    type: "module",
    license: "MIT",
    files: ["dist", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"],
    sideEffects: specification.sideEffects,
    exports: specification.exports,
    dependencies: Object.fromEntries(dependencies.map((dependency) => [dependency, "1.0.0"])),
    engines: { node: ">=22.12.0" },
    repository: { type: "git", url: "https://example.test/aval.git", directory: `packages/${releasePackageDirectory(name)}` },
    homepage: "https://example.test/aval",
    bugs: { url: "https://example.test/aval/issues" },
    ...(Object.keys(specification.bin).length === 0 ? {} : { bin: specification.bin }),
    ...(Object.keys(specification.peerDependencies).length === 0 ? {} : { peerDependencies: specification.peerDependencies })
  };
}

function packageArchive(manifest: TestManifest): Buffer {
  return tarGzip(baseEntries(manifest));
}

function baseEntries(manifest: TestManifest): TarEntry[] {
  const entries: TarEntry[] = [
    { path: "package/package.json", bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
    { path: "package/README.md", bytes: Buffer.from("# Package\n") },
    { path: "package/LICENSE", bytes: Buffer.from("MIT\n") },
    { path: "package/THIRD_PARTY_NOTICES.md", bytes: Buffer.from("None\n") },
    { path: "package/dist/index.js", bytes: Buffer.from("export {};\n") },
    { path: "package/dist/index.d.ts", bytes: Buffer.from("export {};\n") }
  ];
  if (manifest.name === "@pixel-point/aval-compiler") entries.push(
    { path: "package/dist/cli.js", bytes: Buffer.from("#!/usr/bin/env node\n"), mode: 0o755 },
    {
      path: `package/dist/${COMPILER_WORKER_REGISTRY_ENTRY.output}`,
      bytes: Buffer.from(COMPILER_WORKER_REGISTRY_ENTRY.contents)
    }
  );
  if (manifest.name === "@pixel-point/aval-player-web") entries.push({ path: "package/dist/decoder-worker/entry.js", bytes: Buffer.from("export {};\n") });
  if (manifest.name === "@pixel-point/aval-element") entries.push(
    { path: "package/dist/auto.js", bytes: Buffer.from("export {};\n") },
    { path: "package/dist/auto.d.ts", bytes: Buffer.from("export {};\n") },
    { path: `package/dist/${ELEMENT_RELEASE_WORKER.output}`, bytes: Buffer.from("export {};\n") }
  );
  return entries;
}

interface TarEntry { path: string; bytes: Buffer; mode?: number; type?: string }

function tarGzip(entries: readonly TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    writeOctal(header, 100, 8, entry.mode ?? 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.bytes.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header.write(entry.type ?? "0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (const value of header) checksum += value;
    const checksumText = checksum.toString(8).padStart(6, "0");
    header.write(checksumText, 148, 6, "ascii");
    header[154] = 32;
    header[155] = 0;
    chunks.push(header, entry.bytes, Buffer.alloc((512 - entry.bytes.byteLength % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 2, "0");
  buffer.write(text, offset, length - 2, "ascii");
  buffer[offset + length - 2] = 32;
  buffer[offset + length - 1] = 0;
}

function rewriteChecksum(header: Buffer): void {
  header.fill(32, 148, 156);
  let checksum = 0;
  for (const value of header) checksum += value;
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 32;
  header[155] = 0;
}

function gunzip(value: Buffer): Buffer {
  return Buffer.from(gunzipSync(value));
}

function filename(name: string): string {
  return releaseArchiveFilename(name);
}
