import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rmdir,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { CompilerError } from "../diagnostics.js";
import {
  sameRegularFileIdentity,
  type RegularFileIdentity
} from "../file-fingerprint.js";

export type PublicationTargetSnapshot =
  | { readonly exists: false }
  | {
      readonly exists: true;
      readonly identity: RegularFileIdentity;
      readonly mode: number;
    };

export interface PublicationWorkspace {
  readonly directory: string;
  readonly parent: string;
}

export interface StagedPublicationFile {
  readonly path: string;
  readonly identity: RegularFileIdentity;
}

/** Publish one asset without ever overwriting an existing directory entry. */
export async function writeAssetAtomic(
  path: string,
  bytes: Uint8Array,
  signal?: AbortSignal
): Promise<void> {
  const expected = await inspectPublicationTarget(path, "asset");
  if (expected.exists) {
    throw new CompilerError("IO_FAILED", "Asset path already exists", {
      path
    });
  }
  const workspace = await createPublicationWorkspace(path);
  let staged: StagedPublicationFile | undefined;
  let installed: RegularFileIdentity | undefined;
  try {
    throwIfAborted(signal);
    staged = await stagePublicationFile(workspace, "asset.rma", bytes);
    throwIfAborted(signal);
    await assertPublicationTargetUnchanged(path, expected, "asset");
    installed = await installStagedFile(path, staged, "asset");
    staged = undefined;
    await syncDirectory(workspace.parent);
  } catch (error) {
    if (installed !== undefined) {
      await unlinkIfIdentity(path, installed).catch(() => false);
      await syncDirectory(workspace.parent).catch(() => undefined);
    }
    throw asIoFailure(error, path, "Could not publish asset");
  } finally {
    if (staged !== undefined) {
      await unlinkIfIdentity(staged.path, staged.identity).catch(() => false);
    }
    await closePublicationWorkspace(workspace).catch(() => undefined);
  }
}

export async function inspectPublicationTarget(
  path: string,
  label: string
): Promise<Readonly<PublicationTargetSnapshot>> {
  const metadata = await lstat(path, { bigint: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw new CompilerError("IO_FAILED", `Cannot inspect ${label} path`, {
        path,
        cause: error
      });
    }
  );
  if (metadata === undefined) return Object.freeze({ exists: false });
  if (metadata.isSymbolicLink()) {
    throw new CompilerError("IO_FAILED", `Refusing symbolic-link ${label} path`, {
      path
    });
  }
  if (!metadata.isFile()) {
    throw new CompilerError("IO_FAILED", `${label} path must be a regular file`, {
      path
    });
  }
  return Object.freeze({
    exists: true,
    identity: identityFromStat(metadata),
    mode: Number(metadata.mode) & 0o777
  });
}

export async function assertPublicationTargetUnchanged(
  path: string,
  expected: Readonly<PublicationTargetSnapshot>,
  label: string
): Promise<void> {
  const current = await inspectPublicationTarget(path, label);
  if (
    current.exists !== expected.exists ||
    (current.exists && expected.exists &&
      !sameRegularFileIdentity(current.identity, expected.identity))
  ) {
    throw new CompilerError(
      "IO_FAILED",
      `${label} path changed while the artifact was being built`,
      { path }
    );
  }
}

export async function createPublicationWorkspace(
  targetPath: string
): Promise<Readonly<PublicationWorkspace>> {
  const parent = dirname(targetPath);
  try {
    await mkdir(parent, { recursive: true, mode: 0o755 });
    const directory = await mkdtemp(
      join(parent, `.${basename(targetPath)}.publish-`)
    );
    return Object.freeze({ directory, parent });
  } catch (error) {
    throw asIoFailure(error, targetPath, "Could not create publication workspace");
  }
}

export async function stagePublicationFile(
  workspace: Readonly<PublicationWorkspace>,
  name: string,
  bytes: Uint8Array
): Promise<Readonly<StagedPublicationFile>> {
  const path = join(workspace.directory, name);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || metadata.size !== BigInt(bytes.byteLength)) {
      throw new CompilerError("IO_FAILED", "Staged publication file is incomplete", {
        path
      });
    }
    const identity = identityFromStat(metadata);
    await handle.close();
    handle = undefined;
    await syncDirectory(workspace.directory);
    return Object.freeze({ path, identity });
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(path).catch((cleanupError: NodeJS.ErrnoException) => {
      if (cleanupError.code !== "ENOENT") {
        throw new CompilerError(
          "IO_FAILED",
          "Could not remove an incomplete publication stage",
          { path, cause: new AggregateError([error, cleanupError]) }
        );
      }
    });
    throw asIoFailure(error, path, "Could not stage publication file");
  }
}

/** Link a fully synced stage into place. `link` is the no-clobber commit point. */
export async function installStagedFile(
  targetPath: string,
  staged: Readonly<StagedPublicationFile>,
  label: string
): Promise<RegularFileIdentity> {
  try {
    await link(staged.path, targetPath);
  } catch (error) {
    throw new CompilerError("IO_FAILED", `${label} path changed before publication`, {
      path: targetPath,
      cause: error
    });
  }
  try {
    await unlink(staged.path);
    const installed = await inspectPublicationTarget(targetPath, label);
    if (!installed.exists || !sameFileObject(installed.identity, staged.identity)) {
      throw new CompilerError("IO_FAILED", `Published ${label} identity is invalid`, {
        path: targetPath
      });
    }
    return installed.identity;
  } catch (error) {
    const current = await inspectPublicationTarget(targetPath, label).catch(() => undefined);
    if (current?.exists === true && sameFileObject(current.identity, staged.identity)) {
      await unlink(targetPath).catch(() => undefined);
    }
    const stagedCurrent = await inspectPublicationTarget(
      staged.path,
      "staged publication file"
    ).catch(() => undefined);
    if (
      stagedCurrent?.exists === true &&
      sameFileObject(stagedCurrent.identity, staged.identity)
    ) {
      await unlink(staged.path).catch(() => undefined);
    }
    throw error;
  }
}

/** Move an expected file into an owned directory without trusting its old path. */
export async function backupPublicationTarget(
  targetPath: string,
  expected: Extract<PublicationTargetSnapshot, { readonly exists: true }>,
  backupPath: string,
  label: string
): Promise<RegularFileIdentity> {
  await assertPublicationTargetUnchanged(targetPath, expected, label);
  try {
    await rename(targetPath, backupPath);
  } catch (error) {
    throw new CompilerError("IO_FAILED", `Could not secure the previous ${label}`, {
      path: targetPath,
      cause: error
    });
  }
  const backup = await inspectPublicationTarget(backupPath, `${label} backup`);
  if (!backup.exists || !sameFileObject(backup.identity, expected.identity)) {
    throw new CompilerError("IO_FAILED", `${label} changed during replacement`, {
      path: targetPath
    });
  }
  return backup.identity;
}

/** Restore by no-clobber link; a raced target is never removed. */
export async function restorePublicationBackup(
  targetPath: string,
  backupPath: string,
  backupIdentity: RegularFileIdentity,
  label: string
): Promise<void> {
  const backup = await inspectPublicationTarget(backupPath, `${label} backup`);
  if (!backup.exists || !sameRegularFileIdentity(backup.identity, backupIdentity)) {
    throw new CompilerError("IO_FAILED", `${label} backup identity changed`, {
      path: backupPath
    });
  }
  const target = await inspectPublicationTarget(targetPath, label);
  if (target.exists) {
    throw new CompilerError("IO_FAILED", `Cannot restore ${label}; its path was raced`, {
      path: targetPath
    });
  }
  await link(backupPath, targetPath);
  await unlink(backupPath);
}

export async function unlinkIfIdentity(
  path: string,
  identity: RegularFileIdentity
): Promise<boolean> {
  const current = await inspectPublicationTarget(
    path,
    "owned publication file"
  ).catch(() => undefined);
  if (current === undefined || !current.exists) return false;
  if (!sameRegularFileIdentity(current.identity, identity)) return false;
  await unlink(path);
  return true;
}

export async function closePublicationWorkspace(
  workspace: Readonly<PublicationWorkspace>
): Promise<void> {
  await rmdir(workspace.directory);
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function identityFromStat(stat: {
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

function sameFileObject(
  left: RegularFileIdentity,
  right: RegularFileIdentity
): boolean {
  return left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size;
}

function asIoFailure(error: unknown, path: string, message: string): CompilerError {
  if (error instanceof CompilerError) return error;
  return new CompilerError("IO_FAILED", message, { path, cause: error });
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new CompilerError("CANCELLED", "Compiler operation was cancelled", {
      cause: signal.reason
    });
  }
}

export function ffmpegGenerator(): string {
  return "rendered-motion-compiler/0.1";
}
