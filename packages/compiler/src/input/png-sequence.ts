import { opendir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import { CompilerError } from "../diagnostics.js";
import { MAX_SOURCE_FRAMES } from "../model.js";

export interface PngSequencePlan {
  readonly pattern: string;
  readonly firstFileNumber: number;
  readonly frameCount: number;
  readonly files: readonly string[];
}

/** Resolve one printf-style PNG pattern and reject gaps/traversal up front. */
export async function inspectPngSequence(
  root: string,
  candidatePattern: string,
  firstFileNumber = 0,
  expectedFrameCount?: number,
  signal?: AbortSignal
): Promise<Readonly<PngSequencePlan>> {
  throwIfAborted(signal);
  if (!Number.isSafeInteger(firstFileNumber) || firstFileNumber < 0) {
    throw new CompilerError(
      "INPUT_INVALID",
      "PNG firstFileNumber must be a nonnegative safe integer"
    );
  }
  if (
    candidatePattern.includes("\u0000") ||
    /^[a-z][a-z0-9+.-]*:\/\//iu.test(candidatePattern)
  ) {
    throw new CompilerError("INPUT_INVALID", "PNG source must be a local path pattern");
  }
  const absolutePattern = isAbsolute(candidatePattern)
    ? candidatePattern
    : resolve(root, candidatePattern);
  const resolvedRoot = await realpath(root);
  throwIfAborted(signal);
  const directory = await realpath(dirname(absolutePattern)).catch((error: unknown) => {
    throw new CompilerError("IO_FAILED", "PNG sequence directory does not exist", {
      path: dirname(absolutePattern),
      cause: error
    });
  });
  throwIfAborted(signal);
  const fromRoot = relative(resolvedRoot, directory);
  if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new CompilerError(
      "PATH_OUTSIDE_ROOT",
      "PNG sequence directory resolves outside the project root",
      { path: candidatePattern }
    );
  }
  const token = parsePattern(basename(absolutePattern));
  if (
    expectedFrameCount !== undefined &&
    (
      !Number.isSafeInteger(expectedFrameCount) ||
      expectedFrameCount < 1 ||
      expectedFrameCount > MAX_SOURCE_FRAMES ||
      firstFileNumber + expectedFrameCount - 1 >= 10 ** token.width
    )
  ) {
    throw new CompilerError(
      "INPUT_INVALID",
      "PNG frame selection does not fit its %0Nd numbering width"
    );
  }
  const matcher = new RegExp(
    `^${escapeRegex(token.prefix)}(\\d{${String(token.width)}})${escapeRegex(token.suffix)}$`,
    "u"
  );
  const selectionEnd = expectedFrameCount === undefined
    ? Number.POSITIVE_INFINITY
    : firstFileNumber + expectedFrameCount;
  const selected: { readonly number: number; readonly path: string }[] = [];
  const handle = await opendir(directory).catch((error: unknown) => {
    throw new CompilerError("IO_FAILED", "Cannot inspect PNG sequence directory", {
      path: directory,
      cause: error
    });
  });
  let entryCount = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const entry = await handle.read();
      throwIfAborted(signal);
      if (entry === null) break;
      entryCount += 1;
      if (entryCount > MAX_SOURCE_FRAMES * 4) {
        throw new CompilerError(
          "SOURCE_LIMIT",
          "PNG sequence directory contains too many entries"
        );
      }
      if (!entry.isFile()) continue;
      const match = matcher.exec(entry.name);
      if (match === null) continue;
      const number = Number(match[1]);
      if (
        Number.isSafeInteger(number) &&
        number >= firstFileNumber &&
        number < selectionEnd
      ) {
        selected.push({ number, path: resolve(directory, entry.name) });
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  selected.sort((left, right) => left.number - right.number);
  if (selected.length < 1) {
    throw new CompilerError(
      "INPUT_INVALID",
      `PNG sequence has no frame ${String(firstFileNumber)}`,
      { path: candidatePattern }
    );
  }
  if (selected.length > MAX_SOURCE_FRAMES) {
    throw new CompilerError(
      "SOURCE_LIMIT",
      `PNG sequence exceeds ${String(MAX_SOURCE_FRAMES)} frames`
    );
  }
  if (
    expectedFrameCount !== undefined &&
    selected.length !== expectedFrameCount
  ) {
    throw new CompilerError(
      "INPUT_INVALID",
      `PNG sequence selection requires exactly ${String(expectedFrameCount)} frames`,
      { path: candidatePattern }
    );
  }
  for (let index = 0; index < selected.length; index += 1) {
    const expected = firstFileNumber + index;
    if (selected[index]!.number !== expected) {
      throw new CompilerError(
        "INPUT_INVALID",
        `PNG sequence is missing frame file number ${String(expected)}`,
        { path: candidatePattern }
      );
    }
  }
  const pattern = resolve(directory, basename(absolutePattern));
  return Object.freeze({
    pattern,
    firstFileNumber,
    frameCount: selected.length,
    files: Object.freeze(selected.map(({ path }) => path))
  });
}

function parsePattern(fileName: string): {
  readonly prefix: string;
  readonly suffix: string;
  readonly width: number;
} {
  const matches = [...fileName.matchAll(/%(?:0(\d+))?d/gu)];
  if (matches.length !== 1) {
    throw new CompilerError(
      "INPUT_INVALID",
      "PNG sequence path must contain exactly one %0Nd frame token"
    );
  }
  const match = matches[0]!;
  const width = match[1] === undefined ? 1 : Number(match[1]);
  if (!Number.isSafeInteger(width) || width < 1 || width > 12) {
    throw new CompilerError("INPUT_INVALID", "PNG frame-number width must be 1 to 12");
  }
  return {
    prefix: fileName.slice(0, match.index),
    suffix: fileName.slice(match.index + match[0].length),
    width
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new CompilerError("CANCELLED", "Compiler operation was cancelled", {
      cause: signal.reason
    });
  }
}
