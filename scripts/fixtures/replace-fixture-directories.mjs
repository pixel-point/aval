import { lstat, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Replace same-filesystem directories as one recoverable transaction. A
 * failed swap restores every original directory and leaves staged replacements
 * available to the caller for inspection or cleanup.
 */
export async function replaceDirectoriesTransactionally(
  replacements,
  options = {}
) {
  const entries = await prepareEntries(replacements);
  try {
    for (const [index, entry] of entries.entries()) {
      await rename(entry.current, entry.backup);
      entry.originalMoved = true;
      await rename(entry.staged, entry.current);
      entry.replacementInstalled = true;
      await options.afterInstall?.(Object.freeze({
        current: entry.current,
        index
      }));
    }
  } catch (reason) {
    const rollbackErrors = await rollback(entries);
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [reason, ...rollbackErrors],
        "fixture directory transaction and rollback failed"
      );
    }
    throw reason;
  }
  const cleanup = await Promise.allSettled(entries.map(({ backup }) =>
    rm(backup, { recursive: true, force: true })
  ));
  const cleanupErrors = cleanup.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "fixture directory transaction committed with backup cleanup failures"
    );
  }
}

async function prepareEntries(replacements) {
  if (!Array.isArray(replacements) || replacements.length === 0) {
    throw new TypeError("at least one directory replacement is required");
  }
  const seen = new Set();
  const entries = [];
  for (const replacement of replacements) {
    const current = resolve(replacement.current);
    const staged = resolve(replacement.staged);
    if (current === staged || dirname(current) !== dirname(staged)) {
      throw new TypeError("replacement directories must be distinct siblings");
    }
    if (seen.has(current) || seen.has(staged)) {
      throw new TypeError("replacement directory paths must be unique");
    }
    seen.add(current);
    seen.add(staged);
    await requireDirectory(current, "current");
    await requireDirectory(staged, "staged");
    entries.push({
      current,
      staged,
      backup: join(
        dirname(current),
        `.${basename(current)}.backup-${randomUUID()}`
      ),
      originalMoved: false,
      replacementInstalled: false
    });
  }
  return entries;
}

async function requireDirectory(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TypeError(`${label} replacement path is not a regular directory`);
  }
}

async function rollback(entries) {
  const errors = [];
  for (const entry of [...entries].reverse()) {
    if (entry.replacementInstalled) {
      try {
        await rename(entry.current, entry.staged);
        entry.replacementInstalled = false;
      } catch (error) {
        errors.push(error);
      }
    }
    if (!entry.replacementInstalled && entry.originalMoved) {
      try {
        await rename(entry.backup, entry.current);
        entry.originalMoved = false;
      } catch (error) {
        errors.push(error);
      }
    }
  }
  return errors;
}
