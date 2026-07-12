import type { BigIntStats } from "node:fs";
import { open } from "node:fs/promises";

import { CompilerError } from "./diagnostics.js";
import { createSha256Accumulator } from "./compile/hash.js";

export interface RegularFileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly size: number;
  readonly mtimeNanoseconds: string;
  readonly ctimeNanoseconds: string;
}

export interface RegularFileFingerprint {
  readonly sha256: string;
  readonly identity: RegularFileIdentity;
}

/** Hash one opened regular-file identity without an unbounded allocation. */
export async function fingerprintRegularFile(
  path: string,
  maxBytes: number,
  label: string,
  signal?: AbortSignal
): Promise<Readonly<RegularFileFingerprint>> {
  throwIfAborted(signal);
  const handle = await open(path, "r").catch((error: unknown) => {
    throw new CompilerError("IO_FAILED", `Cannot open ${label}`, {
      path,
      cause: error
    });
  });
  try {
    throwIfAborted(signal);
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size < 0n ||
      before.size > BigInt(maxBytes) ||
      before.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new CompilerError(
        "SOURCE_LIMIT",
        `${label} must be a bounded regular file`,
        { path }
      );
    }
    const hash = createSha256Accumulator();
    const buffer = new Uint8Array(1024 * 1024);
    const size = Number(before.size);
    let offset = 0;
    while (offset < size) {
      throwIfAborted(signal);
      const count = Math.min(buffer.byteLength, size - offset);
      const result = await handle.read(buffer, 0, count, offset);
      throwIfAborted(signal);
      if (result.bytesRead < 1) throw changed(path, label);
      hash.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    if ((await handle.read(buffer, 0, 1, size)).bytesRead !== 0) {
      throw changed(path, label);
    }
    const after = await handle.stat({ bigint: true });
    throwIfAborted(signal);
    if (!sameStat(before, after)) throw changed(path, label);
    return Object.freeze({
      sha256: hash.digestHex(),
      identity: freezeIdentity(after)
    });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new CompilerError("CANCELLED", "Compiler operation was cancelled", {
      cause: signal.reason
    });
  }
}

export function sameRegularFileIdentity(
  left: RegularFileIdentity,
  right: RegularFileIdentity
): boolean {
  return left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeNanoseconds === right.mtimeNanoseconds &&
    left.ctimeNanoseconds === right.ctimeNanoseconds;
}

function sameStat(
  left: BigIntStats,
  right: BigIntStats
): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function freezeIdentity(stat: {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}): RegularFileIdentity {
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    size: Number(stat.size),
    mtimeNanoseconds: String(stat.mtimeNs),
    ctimeNanoseconds: String(stat.ctimeNs)
  });
}

function changed(path: string, label: string): CompilerError {
  return new CompilerError("IO_FAILED", `${label} changed while being hashed`, {
    path
  });
}
