#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";

import { assertOfficialHttpsUrl, fetchWithBoundedRedirects } from "./resolve-builds.mjs";

const execFile = promisify(execFileCallback);
const PLATFORM_RUNTIME = Object.freeze({
  "macos-arm64": {
    arch: "arm64",
    assetName: "Brave-Browser-arm64.dmg",
    os: "darwin"
  },
  "windows-x64": {
    arch: "x64",
    assetName: "BraveBrowserStandaloneSetup.exe",
    os: "win32"
  }
});
const BRAVE_MAC_SIGNER = "Developer ID Application: Brave Software, Inc.";
const BRAVE_WINDOWS_SIGNER = "Brave Software, Inc.";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export async function acquireBuilds({
  policy,
  platform,
  output,
  acquireOne = acquireOneBuild,
  acquiredAt = new Date().toISOString()
}) {
  const runtime = PLATFORM_RUNTIME[platform];
  if (runtime === undefined) throw new Error(`brave-platform-unsupported:${String(platform)}`);
  const outputRoot = assertCallerOwnedOutput(output);
  await mkdir(outputRoot, { recursive: true });
  const outputMetadata = await lstat(outputRoot);
  if (!outputMetadata.isDirectory() || outputMetadata.isSymbolicLink()) {
    throw new Error("brave-output-not-real-directory");
  }
  assertCallerOwnedOutput(await realpath(outputRoot));
  const priorEntries = await readdir(outputRoot);
  if (priorEntries.length !== 0) throw new Error("brave-output-not-empty");
  const builds = [];
  try {
    for (const role of ["current", "boundary"]) {
      const build = validateBuild(policy?.braveBuilds?.[role], role, platform);
      const roleRoot = resolve(outputRoot, role);
      await mkdir(roleRoot, { recursive: false });
      builds.push(await acquireOne({ build, outputRoot, platform, role, roleRoot }));
    }
    const manifest = Object.freeze({
      schemaVersion: 1,
      acquiredAt: new Date(acquiredAt).toISOString(),
      platform,
      builds: Object.freeze(builds)
    });
    await writeFile(
      resolve(outputRoot, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" }
    );
    return manifest;
  } catch (error) {
    await rm(outputRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyFileSha256(path, expectedSha256, expectedSize = null) {
  if (!SHA256_PATTERN.test(String(expectedSha256))) {
    throw new Error("brave-sha256-invalid");
  }
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("brave-download-not-file");
  if (expectedSize !== null && metadata.size !== expectedSize) {
    throw new Error(`brave-download-size-mismatch:${String(metadata.size)}:${String(expectedSize)}`);
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  const actual = digest.digest("hex");
  if (actual !== expectedSha256) {
    throw new Error(`brave-download-digest-mismatch:${actual}:${expectedSha256}`);
  }
  return Object.freeze({ sha256: actual, size: metadata.size });
}

export function verifyBraveVersionOutput(output, build) {
  const text = String(output).trim();
  if (text.length === 0 || text.length > 2_048 || !/\bBrave(?: Browser)?\b/u.test(text) ||
      /\bGoogle Chrome\b/u.test(text)) throw new Error("brave-binary-brand-mismatch");
  const chromiumMajor = String(build.chromiumVersion).split(".")[0];
  const combinedVersion = `${chromiumMajor}.${String(build.version)}`;
  const hasCombinedProductVersion = containsVersionToken(text, combinedVersion);
  if (!containsVersionToken(text, build.version) && !hasCombinedProductVersion) {
    throw new Error(`brave-binary-version-mismatch:${build.version}`);
  }
  if (!containsVersionToken(text, build.chromiumVersion) && !hasCombinedProductVersion) {
    throw new Error(`brave-binary-chromium-mismatch:${build.chromiumVersion}`);
  }
  return text;
}

export function verifyMacSignatureOutput(output) {
  const text = String(output);
  const authorities = [...text.matchAll(/^Authority=(.+)$/gmu)].map((match) => match[1].trim());
  const signer = authorities.find((authority) => authority.startsWith(BRAVE_MAC_SIGNER));
  if (signer === undefined || !/^TeamIdentifier=KL8N8XSYF4$/mu.test(text)) {
    throw new Error("brave-macos-signature-invalid");
  }
  return signer;
}

export function verifyWindowsSignatureRecord(record) {
  if (record === null || typeof record !== "object" || record.status !== "Valid" ||
      typeof record.subject !== "string" ||
      !new RegExp(`(?:^|,\\s*)CN="?${escapeRegExp(BRAVE_WINDOWS_SIGNER)}"?(?:,|$)`, "u")
        .test(record.subject)) {
    throw new Error("brave-windows-signature-invalid");
  }
  return record.subject;
}

async function acquireOneBuild({ build, outputRoot, platform, role, roleRoot }) {
  const asset = build.assets[platform];
  const downloadPath = resolve(roleRoot, asset.name);
  await downloadAsset(asset, downloadPath);
  const verified = await verifyFileSha256(downloadPath, asset.sha256, asset.size);
  const installed = platform === "macos-arm64"
    ? await extractMacBuild(downloadPath, roleRoot, build)
    : await extractWindowsBuild(downloadPath, roleRoot, build);
  await unlink(downloadPath);
  return Object.freeze({
    role,
    version: build.version,
    chromiumVersion: build.chromiumVersion,
    releaseDate: build.releaseDate,
    source: Object.freeze({
      name: asset.name,
      url: asset.url,
      sha256: verified.sha256,
      size: verified.size
    }),
    executablePath: portableRelative(outputRoot, installed.executablePath),
    signer: installed.signer,
    versionOutput: installed.versionOutput
  });
}

async function downloadAsset(asset, destination) {
  assertOfficialHttpsUrl(asset.url, "asset");
  const partial = `${destination}.partial`;
  const { response } = await fetchWithBoundedRedirects(asset.url, {
    maxRedirects: 3,
    purpose: "asset"
  });
  if (response.body === null) throw new Error("brave-download-body-missing");
  const declaredSize = response.headers.get("content-length");
  if (declaredSize !== null && declaredSize !== String(asset.size)) {
    throw new Error(`brave-download-content-length-mismatch:${declaredSize}:${String(asset.size)}`);
  }
  try {
    await pipeline(
      response.body,
      createExactSizeLimiter(asset.size),
      createWriteStream(partial, { flags: "wx", mode: 0o600 })
    );
    const proof = await verifyFileSha256(partial, asset.sha256, asset.size);
    if (proof.size !== asset.size) throw new Error("brave-download-size-mismatch");
    await import("node:fs/promises").then(({ rename }) => rename(partial, destination));
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

async function extractMacBuild(downloadPath, roleRoot, build) {
  assertRuntime("darwin", "arm64");
  const mountPoint = resolve(roleRoot, ".mount");
  await mkdir(mountPoint, { recursive: false });
  let mounted = false;
  try {
    await run("hdiutil", [
      "attach",
      "-nobrowse",
      "-readonly",
      "-mountpoint",
      mountPoint,
      downloadPath
    ]);
    mounted = true;
    const apps = (await readdir(mountPoint)).filter((name) => name.endsWith(".app"));
    if (apps.length !== 1) throw new Error(`brave-macos-app-count:${String(apps.length)}`);
    const sourceApp = resolve(mountPoint, apps[0]);
    const destinationApp = resolve(roleRoot, "Brave Browser.app");
    await run("ditto", [sourceApp, destinationApp]);
    await run("codesign", ["--verify", "--deep", "--strict", destinationApp]);
    const signature = await run("codesign", ["-dv", "--verbose=4", destinationApp]);
    const signer = verifyMacSignatureOutput(`${signature.stdout}\n${signature.stderr}`);
    const executablePath = resolve(
      destinationApp,
      "Contents",
      "MacOS",
      "Brave Browser"
    );
    await access(executablePath);
    const version = await run(executablePath, ["--version"]);
    const versionOutput = verifyBraveVersionOutput(
      `${version.stdout}\n${version.stderr}`,
      build
    );
    return Object.freeze({ executablePath, signer, versionOutput });
  } finally {
    if (mounted) await run("hdiutil", ["detach", mountPoint]);
    await rm(mountPoint, { recursive: true, force: true });
  }
}

async function extractWindowsBuild(downloadPath, roleRoot, build) {
  assertRuntime("win32", "x64");
  const installerSignature = await readWindowsSignature(downloadPath);
  verifyWindowsSignatureRecord(installerSignature);
  const extractedRoot = resolve(roleRoot, "Brave");
  await mkdir(extractedRoot, { recursive: false });
  await run("7z", ["x", "-y", `-o${extractedRoot}`, downloadPath]);
  await extractNestedWindowsArchives(extractedRoot);
  const candidates = (await findNamedFiles(extractedRoot, "brave.exe"))
    .filter((path) => !path.toLowerCase().includes(`${sep}temp${sep}`));
  const expectedSegment = `${sep}application${sep}${build.version}${sep}brave.exe`;
  const exact = candidates.filter((path) => path.toLowerCase().endsWith(expectedSegment));
  const selected = exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : null;
  if (selected === null) throw new Error(`brave-windows-executable-count:${String(candidates.length)}`);
  const executableSignature = await readWindowsSignature(selected);
  const signer = verifyWindowsSignatureRecord(executableSignature);
  const version = await run(selected, ["--version"]);
  const versionOutput = verifyBraveVersionOutput(
    `${version.stdout}\n${version.stderr}`,
    build
  );
  return Object.freeze({ executablePath: selected, signer, versionOutput });
}

async function extractNestedWindowsArchives(root) {
  const seen = new Set();
  for (let depth = 0; depth < 3; depth += 1) {
    if ((await findNamedFiles(root, "brave.exe")).length > 0) return;
    const archives = (await findArchiveFiles(root)).filter((path) => !seen.has(path));
    if (archives.length === 0) return;
    if (seen.size + archives.length > 16) throw new Error("brave-extraction-archive-limit");
    for (const archive of archives) {
      seen.add(archive);
      const destination = resolve(dirname(archive), `${basename(archive)}.contents`);
      await mkdir(destination, { recursive: false });
      await run("7z", ["x", "-y", `-o${destination}`, archive]);
    }
  }
  if ((await findNamedFiles(root, "brave.exe")).length > 0) return;
  if ((await findArchiveFiles(root)).some((path) => !seen.has(path))) {
    throw new Error("brave-extraction-depth-limit");
  }
}

async function findArchiveFiles(root) {
  const matches = [];
  const queue = [root];
  while (queue.length > 0) {
    const directory = queue.shift();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && /\.(?:7z|zip)$/iu.test(entry.name)) matches.push(path);
    }
    if (queue.length + matches.length > 2_048) throw new Error("brave-extraction-entry-limit");
  }
  return matches.sort();
}

async function readWindowsSignature(path) {
  const escaped = path.replaceAll("'", "''");
  const script = [
    `$signature = Get-AuthenticodeSignature -LiteralPath '${escaped}'`,
    "$record = [pscustomobject]@{ status = [string]$signature.Status; subject = [string]$signature.SignerCertificate.Subject }",
    "$record | ConvertTo-Json -Compress"
  ].join("; ");
  const result = await run("powershell", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script
  ]);
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("brave-windows-signature-output-invalid");
  }
}

async function findNamedFiles(root, expectedBasename) {
  const matches = [];
  const queue = [root];
  while (queue.length > 0) {
    const directory = queue.shift();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && entry.name.toLowerCase() === expectedBasename.toLowerCase()) {
        matches.push(path);
      }
    }
    if (queue.length + matches.length > 2_048) throw new Error("brave-extraction-entry-limit");
  }
  return matches.sort();
}

function validateBuild(build, role, platform) {
  if (build === null || typeof build !== "object" || build.role !== role ||
      build.channel !== "stable" || !/^[0-9]+(?:\.[0-9]+){2}$/u.test(build.version) ||
      !/^[0-9]+(?:\.[0-9]+){3}$/u.test(build.chromiumVersion)) {
    throw new Error(`brave-build-invalid:${role}`);
  }
  const asset = build.assets?.[platform];
  const runtime = PLATFORM_RUNTIME[platform];
  if (runtime === undefined || asset === undefined || asset.name !== runtime.assetName ||
      !SHA256_PATTERN.test(String(asset.sha256)) || !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 || asset.size > 536_870_912) {
    throw new Error(`brave-build-asset-invalid:${role}:${platform}`);
  }
  assertOfficialHttpsUrl(asset.url, "asset");
  const assetUrl = new URL(asset.url);
  const expectedPath = `/brave/brave-browser/releases/download/v${build.version}/${asset.name}`;
  if (assetUrl.hostname !== "github.com" || assetUrl.pathname !== expectedPath ||
      assetUrl.search !== "" || assetUrl.hash !== "") {
    throw new Error(`brave-build-asset-version-mismatch:${role}`);
  }
  return build;
}

function assertCallerOwnedOutput(value) {
  if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) {
    throw new Error("brave-output-must-be-absolute");
  }
  const path = resolve(value);
  const forbidden = new Set([
    resolve(sep),
    resolve(homedir()),
    resolve(tmpdir()),
    resolve(process.cwd())
  ]);
  if (forbidden.has(path) || dirname(path) === resolve(sep) || basename(path).length < 4) {
    throw new Error(`brave-output-unsafe:${path}`);
  }
  return path;
}

function assertRuntime(os, arch) {
  if (process.platform !== os || process.arch !== arch) {
    throw new Error(`brave-runtime-mismatch:${process.platform}-${process.arch}:${os}-${arch}`);
  }
}

function containsVersionToken(text, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[^0-9.])${escaped}(?:$|[^0-9.])`, "u").test(text);
}

function createExactSizeLimiter(expectedSize) {
  let received = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > expectedSize) {
        callback(new Error(`brave-download-size-exceeded:${String(received)}:${String(expectedSize)}`));
        return;
      }
      callback(null, chunk);
    },
    flush(callback) {
      if (received !== expectedSize) {
        callback(new Error(`brave-download-size-mismatch:${String(received)}:${String(expectedSize)}`));
        return;
      }
      callback();
    }
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function portableRelative(root, path) {
  const value = relative(root, path).split(sep).join("/");
  if (value === "" || value.startsWith("../") || value === "..") {
    throw new Error("brave-executable-outside-install-root");
  }
  return value;
}

async function run(command, args) {
  try {
    return await execFile(command, args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1_024) : String(error);
    throw new Error(`brave-command-failed:${basename(command)}:${message}`);
  }
}

function parseArguments(values) {
  const parsed = { output: null, platform: null, policy: null };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--output") parsed.output = values[++index] ?? null;
    else if (value === "--platform") parsed.platform = values[++index] ?? null;
    else if (value === "--policy") parsed.policy = values[++index] ?? null;
    else throw new Error(`unknown argument: ${String(value)}`);
  }
  if (parsed.output === null || parsed.platform === null || parsed.policy === null) {
    throw new Error("usage: acquire-builds.mjs --policy FILE --platform macos-arm64|windows-x64 --output ABSOLUTE_DIRECTORY");
  }
  return parsed;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const policy = JSON.parse(await readFile(resolve(args.policy), "utf8"));
  const manifest = await acquireBuilds({
    policy,
    platform: args.platform,
    output: args.output
  });
  process.stdout.write(`${JSON.stringify({
    builds: manifest.builds.map(({ role, version }) => ({ role, version })),
    output: resolve(args.output),
    status: "acquired"
  })}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
