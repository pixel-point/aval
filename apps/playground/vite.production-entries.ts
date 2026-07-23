import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { Plugin } from "vite";
import { PRODUCTION_PUBLIC_ENTRIES } from "../../scripts/release/release-set-model.mjs";

const ENTRY_MANIFEST_PATH = "assets/public-entry-manifest.json";
const RESOLUTION_IMPORTER = fileURLToPath(new URL("./src/certification/app.ts", import.meta.url));
const PACKAGES_ROOT = fileURLToPath(new URL("../../packages", import.meta.url));
const PRODUCTION_SOURCE_DIRECTORIES = new Set(PRODUCTION_PUBLIC_ENTRIES.map(({ directory }) => directory));

export interface ProductionPublicEntryRecord {
  readonly package: string;
  readonly export: string;
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface ProductionPublicEntryManifest {
  readonly schemaVersion: "1.0";
  readonly manifestKind: "production-public-entry-identity";
  readonly entries: readonly ProductionPublicEntryRecord[];
}

/**
 * Makes a release build fail closed unless public imports resolve to the exact
 * freshly-built distribution entries. The emitted manifest is staged with the
 * harness and reconciled against the candidate tarball inspection.
 */
export function productionPublicEntriesPlugin(): Plugin {
  let expectedPaths = new Set<string>();
  let canonicalPackagesRoot = PACKAGES_ROOT;
  return {
    name: "aval-production-public-entries",
    enforce: "post",
    apply: "build",
    async buildStart() {
      const records: ProductionPublicEntryRecord[] = [];
      expectedPaths = new Set<string>();
      canonicalPackagesRoot = await realpath(PACKAGES_ROOT);
      for (const definition of PRODUCTION_PUBLIC_ENTRIES) {
        const expected = await realpath(resolve(PACKAGES_ROOT, definition.directory, definition.path));
        const resolved = await this.resolve(definition.specifier, RESOLUTION_IMPORTER, { skipSelf: true });
        if (resolved === null || resolved.external === true) {
          this.error(`release import ${definition.specifier} did not resolve to a bundled distribution entry`);
        }
        const actual = await canonicalFilePath(resolved.id);
        if (actual !== expected) {
          this.error(`release import ${definition.specifier} resolved to ${actual}, expected ${expected}`);
        }
        const bytes = await readStableRegularFile(expected);
        if (definition.requiredInGraph) expectedPaths.add(expected);
        records.push(Object.freeze({
          package: definition.package,
          export: definition.export,
          path: definition.path,
          byteLength: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex")
        }));
      }
      const manifest: ProductionPublicEntryManifest = Object.freeze({
        schemaVersion: "1.0",
        manifestKind: "production-public-entry-identity",
        entries: Object.freeze(records)
      });
      this.emitFile({
        type: "asset",
        fileName: ENTRY_MANIFEST_PATH,
        source: `${JSON.stringify(manifest, null, 2)}\n`
      });
    },
    async generateBundle() {
      const included = new Set<string>();
      for (const id of this.getModuleIds()) {
        const path = await canonicalFilePath(id, false);
        if (path === null) continue;
        const packageRelative = relative(canonicalPackagesRoot, path).split(sep).join("/");
        const [packageDirectory, sourceDirectory] = packageRelative.split("/");
        if (sourceDirectory === "src" && packageDirectory !== undefined && PRODUCTION_SOURCE_DIRECTORIES.has(packageDirectory)) {
          this.error(`release playground bundled a workspace source module: ${packageRelative}`);
        }
        if (expectedPaths.has(path)) included.add(path);
      }
      for (const expected of expectedPaths) {
        if (!included.has(expected)) this.error(`release playground omitted verified public entry ${expected}`);
      }
    }
  };
}

async function canonicalFilePath(id: string, required = true): Promise<string | null> {
  const clean = id.startsWith("\0") ? "" : id.split("?", 1)[0] ?? "";
  if (clean === "" || !isAbsolute(clean)) {
    if (required) throw new Error(`release import resolved to a non-file module: ${id}`);
    return null;
  }
  try {
    return await realpath(clean);
  } catch (error) {
    if (!required) return null;
    throw error;
  }
}

async function readStableRegularFile(path: string): Promise<Buffer> {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > 8n * 1024n * 1024n) {
      throw new Error(`release public entry is not a bounded regular file: ${path}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs || BigInt(bytes.byteLength) !== before.size
    ) throw new Error(`release public entry changed while being read: ${path}`);
    return bytes;
  } finally {
    await handle.close();
  }
}
