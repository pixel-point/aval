import { lstat, mkdir, open, opendir, rm, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { serializeCanonicalJson } from "@rendered-motion/format";

import { throwIfAborted } from "../cancellation.js";
import { CompilerError } from "../diagnostics.js";
import {
  describeAccessUnits,
  readValidatedAsset,
  sha256AssetBytes
} from "./asset-validation.js";

export interface UnpackReport {
  readonly command: "unpack";
  readonly source: string;
  readonly outputDirectory: string;
  readonly sha256: string;
  readonly accessUnits: number;
  readonly files: readonly string[];
}

/** Validate first, then reconstruct every payload without overwriting a path. */
export async function unpackAssetFile(
  file: string,
  outputDirectory: string,
  signal?: AbortSignal
): Promise<Readonly<UnpackReport>> {
  throwIfAborted(signal);
  const { bytes, layout } = await readValidatedAsset(file, signal);
  throwIfAborted(signal);
  const target = resolve(outputDirectory);
  const accessUnits = describeAccessUnits(bytes, layout.frontIndex, signal);
  const sourceSha256 = sha256AssetBytes(bytes, signal);
  const prepared = await prepareUnpackDirectory(target, signal);
  const written: string[] = [];
  try {
    throwIfAborted(signal);
    await writeTracked(
      target,
      "manifest.json",
      serializeCanonicalJson(layout.frontIndex.manifest),
      written,
      signal
    );
    throwIfAborted(signal);
    await writeTracked(
      target,
      "index.json",
      serializeCanonicalJson({
        header: layout.frontIndex.header,
        records: layout.frontIndex.records
      }),
      written,
      signal
    );

    for (const blob of layout.frontIndex.unitBlobs) {
      throwIfAborted(signal);
      const prefix = `${blob.rendition}--${blob.unit}`;
      const rendition = layout.frontIndex.manifest.renditions.find(
        ({ id }) => id === blob.rendition
      );
      if (rendition === undefined) {
        throw new CompilerError("ASSET_INVALID", "Unpack rendition is missing");
      }
      await writeTracked(
        target,
        `${prefix}.${rendition.profile.startsWith("avc-annexb-") ? "h264" : "bin"}`,
        bytes.subarray(blob.offset, blob.offset + blob.length),
        written,
        signal
      );
      for (
        let ordinal = blob.sampleStart;
        ordinal < blob.sampleStart + blob.sampleCount;
        ordinal += 1
      ) {
        throwIfAborted(signal);
        const record = layout.frontIndex.records[ordinal];
        if (record === undefined) {
          throw new CompilerError("ASSET_INVALID", "Unpack record is missing");
        }
        const sample = bytes.subarray(
          record.payloadOffset,
          record.payloadOffset + record.payloadLength
        );
        await writeTracked(
          target,
          `${prefix}--${String(record.frameIndex).padStart(4, "0")}.au`,
          sample,
          written,
          signal
        );
      }
    }
    for (const blob of layout.frontIndex.staticBlobs) {
      throwIfAborted(signal);
      await writeTracked(
        target,
        `${blob.staticFrame}.png`,
        bytes.subarray(blob.offset, blob.offset + blob.length),
        written,
        signal
      );
    }
    throwIfAborted(signal);
    await writeTracked(
      target,
      "unpack-report.json",
      serializeCanonicalJson({
        reportVersion: "0.1",
        source: {
          bytes: bytes.byteLength,
          path: file,
          sha256: sourceSha256
        },
        accessUnits,
        unitBlobs: layout.frontIndex.unitBlobs,
        staticBlobs: layout.frontIndex.staticBlobs
      }),
      written,
      signal
    );
    throwIfAborted(signal);
    await rm(prepared.lockPath, { force: true }).catch((error: unknown) => {
      throwIfAborted(signal);
      throw new CompilerError("IO_FAILED", "Could not release unpack directory", {
        path: target,
        cause: error
      });
    });
    throwIfAborted(signal);
  } catch (error) {
    await cleanupUnpack(target, prepared, written);
    throwIfAborted(signal);
    if (error instanceof CompilerError) throw error;
    throw new CompilerError("IO_FAILED", "Could not unpack asset", {
      path: target,
      cause: error
    });
  }
  return Object.freeze({
    command: "unpack",
    source: file,
    outputDirectory: target,
    sha256: sourceSha256,
    accessUnits: accessUnits.length,
    files: Object.freeze([...written])
  });
}

async function prepareUnpackDirectory(
  path: string,
  signal?: AbortSignal
): Promise<{
  readonly createdDirectory: boolean;
  readonly lockPath: string;
}> {
  throwIfAborted(signal);
  await mkdir(dirname(path), { recursive: true, mode: 0o755 }).catch(
    (error: unknown) => {
      throwIfAborted(signal);
      throw new CompilerError("IO_FAILED", "Cannot create unpack parent directory", {
        path: dirname(path),
        cause: error
      });
    }
  );
  throwIfAborted(signal);
  let createdDirectory = false;
  try {
    await mkdir(path, { mode: 0o755 });
    createdDirectory = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throwIfAborted(signal);
      throw new CompilerError("IO_FAILED", "Cannot create unpack directory", {
        path,
        cause: error
      });
    }
  }
  const lockPath = join(path, ".rma-unpack.lock");
  let ownsLock = false;
  try {
    throwIfAborted(signal);
    const metadata = await lstat(path).catch((error: unknown) => {
      throw new CompilerError("IO_FAILED", "Cannot inspect unpack directory", {
        path,
        cause: error
      });
    });
    throwIfAborted(signal);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new CompilerError("IO_FAILED", "Unpack output must be a real directory", {
        path
      });
    }
    let lock: Awaited<ReturnType<typeof open>>;
    try {
      lock = await open(lockPath, "wx", 0o600);
      ownsLock = true;
    } catch (error) {
      throwIfAborted(signal);
      throw new CompilerError("IO_FAILED", "Unpack output is already in use", {
        path,
        cause: error
      });
    }
    try {
      throwIfAborted(signal);
      await lock.close();
    } catch (error) {
      await lock.close().catch(() => undefined);
      if (error instanceof CompilerError) throw error;
      throw new CompilerError("IO_FAILED", "Cannot close unpack directory lock", {
        path: lockPath,
        cause: error
      });
    }
    throwIfAborted(signal);
    const containsOnlyLock = await directoryContainsOnly(
      path,
      ".rma-unpack.lock",
      signal
    ).catch((error: unknown) => {
      if (error instanceof CompilerError) throw error;
      throw new CompilerError("IO_FAILED", "Cannot inspect unpack directory", {
        path,
        cause: error
      });
    });
    throwIfAborted(signal);
    if (!containsOnlyLock) {
      throw new CompilerError("IO_FAILED", "Unpack output directory must be empty", {
        path
      });
    }
    return Object.freeze({ createdDirectory, lockPath });
  } catch (error) {
    if (ownsLock) await rm(lockPath, { force: true }).catch(() => undefined);
    if (createdDirectory) await rmdir(path).catch(() => undefined);
    throwIfAborted(signal);
    if (error instanceof CompilerError) throw error;
    throw new CompilerError("IO_FAILED", "Cannot prepare unpack directory", {
      path,
      cause: error
    });
  }
}

async function directoryContainsOnly(
  path: string,
  allowedName: string,
  signal?: AbortSignal
): Promise<boolean> {
  throwIfAborted(signal);
  const directory = await opendir(path);
  let sawAllowedEntry = false;
  try {
    while (true) {
      throwIfAborted(signal);
      const entry = await directory.read();
      throwIfAborted(signal);
      if (entry === null) return sawAllowedEntry;
      if (entry.name !== allowedName || sawAllowedEntry) return false;
      sawAllowedEntry = true;
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
}

async function writeTracked(
  directory: string,
  name: string,
  bytes: Uint8Array,
  written: string[],
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  const path = join(directory, name);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let ownsPath = false;
  try {
    handle = await open(path, "wx", 0o644);
    ownsPath = true;
    throwIfAborted(signal);
    const chunkBytes = 1024 * 1024;
    let offset = 0;
    while (offset < bytes.byteLength) {
      throwIfAborted(signal);
      const length = Math.min(chunkBytes, bytes.byteLength - offset);
      const result = await handle.write(bytes, offset, length, offset);
      throwIfAborted(signal);
      if (result.bytesWritten < 1) {
        throw new CompilerError("IO_FAILED", "Could not write unpacked file", {
          path
        });
      }
      offset += result.bytesWritten;
    }
    await handle.close();
    handle = undefined;
    throwIfAborted(signal);
    written.push(name);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (ownsPath) await rm(path, { force: true }).catch(() => undefined);
    throwIfAborted(signal);
    if (error instanceof CompilerError) throw error;
    throw new CompilerError("IO_FAILED", "Could not write unpacked file", {
      path,
      cause: error
    });
  }
}

async function cleanupUnpack(
  target: string,
  prepared: { readonly createdDirectory: boolean; readonly lockPath: string },
  written: readonly string[]
): Promise<void> {
  for (const name of written) {
    await rm(join(target, name), { force: true }).catch(() => undefined);
  }
  await rm(prepared.lockPath, { force: true }).catch(() => undefined);
  if (prepared.createdDirectory) await rmdir(target).catch(() => undefined);
}
