#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { validatePublishManifest } from "./publish-manifest.mjs";
import { releasePackageSpecification } from "./release-set-model.mjs";
import { COMPILER_WORKER_REGISTRY_ENTRY, RELEASE_WORKER_ENTRIES } from "./worker-entry-contract.mjs";

const TAR_BLOCK_BYTES = 512;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 128 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const FORBIDDEN_PATHS = [
  /(?:^|\/)src\//u,
  /(?:^|\/)(?:test|tests|fixtures|coverage|\.cache)(?:\/|$)/u,
  /\.(?:tsbuildinfo|map)$/u,
  /(?:^|\/)\.env(?:\.|$)/u,
  /(?:^|\/)(?:id_rsa|.*\.pem|.*\.key)$/iu,
  /(?:ffmpeg|ffprobe|libx264)(?:\.exe|\.dll|\.dylib|\.so)?$/iu
];

/** Inspect a bounded npm tarball from the exact bytes later bound into a release. */
export function inspectTarballBytes(input, options = {}) {
  const archive = Buffer.from(input);
  const label = options.label ?? "package archive";
  if (archive.byteLength < 1 || archive.byteLength > (options.maximumArchiveBytes ?? MAX_ARCHIVE_BYTES)) {
    throw new Error(`${label} compressed byte length is outside policy`);
  }
  let unpacked;
  try {
    unpacked = gunzipSync(archive, { maxOutputLength: options.maximumUnpackedBytes ?? MAX_UNPACKED_BYTES });
  } catch (error) {
    throw new Error(`${label} is not a bounded gzip archive`, { cause: error });
  }
  if (unpacked.byteLength === 0 || unpacked.byteLength % TAR_BLOCK_BYTES !== 0) throw new Error(`${label} has a truncated tar stream`);

  const entries = parseTar(unpacked, label, options.maximumEntryBytes ?? MAX_ENTRY_BYTES);
  const packageJson = entries.find((entry) => entry.path === "package/package.json" && entry.kind === "file");
  if (packageJson === undefined) throw new Error(`${label} has no package.json`);
  const manifest = parseManifest(packageJson.bytes, label);
  validatePackageContents(entries, manifest, label);

  const files = entries
    .filter((entry) => entry.kind === "file")
    .map((entry) => entry.path.slice("package/".length))
    .sort(compareText);
  const fileRecords = entries
    .filter((entry) => entry.kind === "file")
    .map((entry) => Object.freeze({
      path: entry.path.slice("package/".length),
      byteLength: entry.bytes.byteLength,
      mode: entry.mode,
      sha256: sha256(entry.bytes)
    }))
    .sort((left, right) => compareText(left.path, right.path));

  return Object.freeze({
    name: manifest.name,
    version: manifest.version,
    manifest: Object.freeze(manifest),
    files: Object.freeze(files),
    fileRecords: Object.freeze(fileRecords),
    fileListSha256: sha256(Buffer.from(`${JSON.stringify(files)}\n`)),
    tarballSha256: sha256(archive),
    registryIntegrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
    byteLength: archive.byteLength,
    unpackedSize: entries.reduce((total, entry) => total + (entry.kind === "file" ? entry.bytes.byteLength : 0), 0)
  });
}

export async function inspectTarball(path, options = {}) {
  const bytes = await readFile(resolve(path));
  return inspectTarballBytes(bytes, { ...options, label: options.label ?? basename(path) });
}

function parseTar(bytes, label, maximumEntryBytes) {
  const entries = [];
  const identities = new Map();
  let offset = 0;
  let zeroBlocks = 0;
  let ended = false;
  while (offset < bytes.byteLength) {
    const header = bytes.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (header.every((value) => value === 0)) {
      zeroBlocks += 1;
      offset += TAR_BLOCK_BYTES;
      if (zeroBlocks >= 2) {
        ended = true;
        break;
      }
      continue;
    }
    if (zeroBlocks !== 0) throw new Error(`${label} has a non-zero block after its tar terminator began`);
    verifyTarChecksum(header, label, offset);
    verifySupportedUstarHeader(header, label, offset);
    const type = header[156];
    const kind = type === 0 || type === 48 ? "file" : type === 53 ? "directory" : null;
    if (kind === null) throw new Error(`${label} contains a link, extension, or special tar entry at block ${String(offset / TAR_BLOCK_BYTES)}`);
    const rawName = fieldText(header, 0, 100, `${label} entry name`);
    const rawPrefix = fieldText(header, 345, 155, `${label} entry prefix`);
    const joined = rawPrefix === "" ? rawName : `${rawPrefix}/${rawName}`;
    const path = normalizeArchivePath(joined, kind, label);
    if (path.split("/").some((part) => part.startsWith("."))) throw new Error(`${label} contains a hidden archive path: ${path}`);
    const identity = path.normalize("NFKC").toLocaleLowerCase("en-US");
    if (identities.has(identity)) throw new Error(`${label} contains a duplicate or normalized/case-colliding path: ${path}`);
    identities.set(identity, path);
    const size = canonicalTarNumber(header, 124, 12, `${label} ${path} size`);
    const mode = canonicalTarNumber(header, 100, 8, `${label} ${path} mode`);
    if (canonicalTarNumber(header, 108, 8, `${label} ${path} uid`) !== 0 || canonicalTarNumber(header, 116, 8, `${label} ${path} gid`) !== 0) throw new Error(`${label} tar ownership metadata is not canonical: ${path}`);
    canonicalTarNumber(header, 136, 12, `${label} ${path} mtime`);
    if ((kind === "directory" && mode !== 0o755) || (kind === "file" && mode !== 0o644 && mode !== 0o755)) throw new Error(`${label} tar mode is outside the supported dialect: ${path}`);
    if (kind === "directory" && size !== 0) throw new Error(`${label} directory has a payload: ${path}`);
    if (size > maximumEntryBytes) throw new Error(`${label} entry exceeds the uncompressed per-file limit: ${path}`);
    const payloadStart = offset + TAR_BLOCK_BYTES;
    const payloadEnd = payloadStart + size;
    const next = payloadStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (!Number.isSafeInteger(next) || payloadEnd > bytes.byteLength || next > bytes.byteLength) throw new Error(`${label} entry is truncated: ${path}`);
    const payload = Buffer.from(bytes.subarray(payloadStart, payloadEnd));
    if (!bytes.subarray(payloadEnd, next).every((value) => value === 0)) throw new Error(`${label} entry padding is non-zero: ${path}`);
    entries.push(Object.freeze({ path, kind, mode, bytes: payload }));
    if (entries.length > MAX_ENTRIES) throw new Error(`${label} contains too many entries`);
    offset = next;
  }
  if (!ended || zeroBlocks < 2) throw new Error(`${label} has no complete tar terminator`);
  if (!bytes.subarray(offset).every((value) => value === 0)) throw new Error(`${label} contains data after its tar terminator`);
  return entries;
}

function validatePackageContents(entries, manifest, label) {
  const specification = releasePackageSpecification(manifest.name);
  const filePaths = new Set(entries.filter(({ kind }) => kind === "file").map(({ path }) => path));
  const compilerRegistryPath = `dist/${COMPILER_WORKER_REGISTRY_ENTRY.output}`;
  const additionalSourcePaths = new Set(specification.buildConfig.additionalSources.map((path) => `dist/${path}`));
  const executablePaths = new Set(Object.values(specification.bin).map((target) => target.slice(2)));
  for (const entry of entries) {
    if (!entry.path.startsWith("package/")) throw new Error(`${label} contains a path outside the package root: ${entry.path}`);
    if (entry.kind !== "file") continue;
    const relative = entry.path.slice("package/".length);
    if (relative === "" || FORBIDDEN_PATHS.some((pattern) => pattern.test(relative))) throw new Error(`${label} contains forbidden package content: ${relative}`);
    if (relative.split("/").some((part) => part.startsWith("."))) throw new Error(`${label} contains a hidden package path: ${relative}`);
    if (/\.ts$/u.test(relative) && !/\.d\.ts$/u.test(relative)) throw new Error(`${label} contains TypeScript source: ${relative}`);
    if (!new Set(["package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]).has(relative) && !relative.startsWith("dist/")) {
      throw new Error(`${label} contains an undeclared package-root file: ${relative}`);
    }
    const isReviewedAdditionalSource = additionalSourcePaths.has(relative);
    if (relative.startsWith("dist/") && !/\.(?:js|d\.ts)$/u.test(relative) && !isReviewedAdditionalSource) {
      throw new Error(`${label} contains an unreviewed distribution file type: ${relative}`);
    }
    const executable = (entry.mode & 0o111) !== 0;
    const allowedExecutable = executablePaths.has(relative);
    if (executable !== allowedExecutable) throw new Error(`${label} has an unexpected executable mode: ${relative}`);
  }
  for (const required of ["package/package.json", "package/README.md", "package/LICENSE", "package/THIRD_PARTY_NOTICES.md", "package/dist/index.js", "package/dist/index.d.ts"]) {
    if (!filePaths.has(required)) throw new Error(`${label} is missing ${required.slice("package/".length)}`);
  }
  const specialEntries = [
    ...[...additionalSourcePaths].map((path) => `package/${path}`),
    ...RELEASE_WORKER_ENTRIES
      .filter(({ packageName }) => packageName === manifest.name)
      .map(({ output }) => `package/dist/${output}`)
  ];
  for (const specialEntry of specialEntries) {
    if (!filePaths.has(specialEntry)) throw new Error(`${label} is missing ${specialEntry.slice("package/".length)}`);
  }
  if (additionalSourcePaths.has(compilerRegistryPath)) {
    const registry = entries.find(({ kind, path }) =>
      kind === "file" && path === `package/${compilerRegistryPath}`
    );
    if (
      registry === undefined ||
      Buffer.compare(registry.bytes, Buffer.from(COMPILER_WORKER_REGISTRY_ENTRY.contents)) !== 0
    ) {
      throw new Error(`${label} contains a non-canonical compiler worker registry`);
    }
  }
  validateTargets(manifest.exports, "exports", filePaths, manifest.name);
  validateTargets(manifest.bin, "bin", filePaths, manifest.name);
}

function parseManifest(bytes, label) {
  let manifest;
  try {
    manifest = JSON.parse(UTF8.decode(bytes));
  } catch (error) {
    throw new Error(`${label} package.json is not strict UTF-8 JSON`, { cause: error });
  }
  validatePublishManifest(manifest);
  return manifest;
}

function validateTargets(value, path, files, packageName) {
  if (value === undefined) return;
  if (typeof value === "string") {
    if (!value.startsWith("./") || value.includes("..") || value.includes("\\") || value.includes("/src/")) throw new Error(`${packageName} has an unsafe ${path} target: ${value}`);
    if (!files.has(`package/${value.slice(2)}`)) throw new Error(`${packageName} ${path} target is missing: ${value}`);
    return;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${packageName} has an invalid ${path} map`);
  for (const [key, target] of Object.entries(value)) {
    if (key === "source") throw new Error(`${packageName} exposes a source condition`);
    validateTargets(target, `${path}.${key}`, files, packageName);
  }
}

function normalizeArchivePath(value, kind, label) {
  let path = value;
  if (kind === "directory" && path.endsWith("/")) path = path.slice(0, -1);
  if (path === "" || path !== path.normalize("NFC") || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.includes("//")) {
    throw new Error(`${label} contains a non-canonical archive path: ${JSON.stringify(value)}`);
  }
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error(`${label} contains an unsafe archive path: ${path}`);
  return path;
}

function verifyTarChecksum(header, label, offset) {
  const field = Buffer.from(header.subarray(148, 156)).toString("ascii");
  // POSIX readers accept both historical NUL-space and npm/tar's space-NUL
  // terminator. The six-digit octal payload remains exact in either dialect.
  if (!/^[0-7]{6}(?:\0 | \0)$/u.test(field)) {
    throw new Error(`${label} has an unsupported tar checksum field`);
  }
  const expected = tarNumber(header, 148, 8, `${label} tar checksum`);
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) actual += index >= 148 && index < 156 ? 32 : header[index];
  if (actual !== expected) throw new Error(`${label} has an invalid tar header checksum at block ${String(offset / TAR_BLOCK_BYTES)}`);
}

function verifySupportedUstarHeader(header, label, offset) {
  if (Buffer.compare(Buffer.from(header.subarray(257, 263)), Buffer.from("ustar\0", "ascii")) !== 0 || Buffer.from(header.subarray(263, 265)).toString("ascii") !== "00") throw new Error(`${label} uses an unsupported tar dialect at block ${String(offset / TAR_BLOCK_BYTES)}`);
  if (fieldText(header, 157, 100, `${label} link name`) !== "" || fieldText(header, 265, 32, `${label} owner name`) !== "" || fieldText(header, 297, 32, `${label} group name`) !== "") throw new Error(`${label} tar identity metadata is not canonical`);
  for (const [start, length] of [[329, 8], [337, 8]]) {
    const field = header.subarray(start, start + length);
    if (!field.every((value) => value === 0) && canonicalTarNumber(header, start, length, `${label} device metadata`) !== 0) throw new Error(`${label} tar device metadata is not canonical`);
  }
  if (!header.subarray(500, 512).every((value) => value === 0)) throw new Error(`${label} tar header extension bytes are non-zero`);
}

function canonicalTarNumber(bytes, offset, length, label) {
  const text = Buffer.from(bytes.subarray(offset, offset + length)).toString("ascii");
  const allNulZero = text === "\0".repeat(length);
  const posixNul = new RegExp(`^[0-7]{${String(length - 1)}}\\0$`, "u").test(text);
  const npmSpaceNul = new RegExp(
    `^[0-7]{${String(length - 2)}} \\0$`,
    "u"
  ).test(text);
  if (!allNulZero && !posixNul && !npmSpaceNul) {
    throw new Error(`${label} is not a supported canonical octal field`);
  }
  if (allNulZero) return 0;
  return tarNumber(bytes, offset, length, label);
}

function tarNumber(bytes, offset, length, label) {
  const field = bytes.subarray(offset, offset + length);
  if ((field[0] & 0x80) !== 0) throw new Error(`${label} uses a forbidden base-256 tar number`);
  const text = Buffer.from(field).toString("ascii").replace(/\0.*$/u, "").trim();
  if (!/^[0-7]+$/u.test(text)) throw new Error(`${label} is not canonical octal`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is outside safe integer bounds`);
  return value;
}

function fieldText(bytes, offset, length, label) {
  const field = bytes.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  const end = nul < 0 ? field.length : nul;
  if (nul >= 0 && !field.subarray(nul).every((value) => value === 0)) throw new Error(`${label} has non-zero bytes after NUL`);
  try {
    return UTF8.decode(field.subarray(0, end));
  } catch (error) {
    throw new Error(`${label} is not UTF-8`, { cause: error });
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length < 3) throw new Error("usage: inspect-tarball.mjs <package.tgz> [...]");
  const packages = [];
  for (const path of process.argv.slice(2)) packages.push({ path, ...await inspectTarball(path) });
  process.stdout.write(`${JSON.stringify({ status: "passed", packages }, null, 2)}\n`);
}
