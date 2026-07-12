import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { CompilerError } from "./diagnostics.js";

export async function resolveExistingLocalFile(
  root: string,
  candidate: string,
  confineToRoot: boolean
): Promise<string> {
  rejectNonPath(candidate);
  const resolvedRoot = await realpath(root);
  const resolvedPath = await realpath(
    isAbsolute(candidate) ? candidate : resolve(resolvedRoot, candidate)
  ).catch((error: unknown) => {
    throw new CompilerError("IO_FAILED", `Input does not exist: ${candidate}`, {
      path: candidate,
      cause: error
    });
  });
  if (confineToRoot && escapes(resolvedRoot, resolvedPath)) {
    throw new CompilerError(
      "PATH_OUTSIDE_ROOT",
      "Project input resolves outside the project directory",
      { path: candidate }
    );
  }
  const metadata = await stat(resolvedPath);
  if (!metadata.isFile()) {
    throw new CompilerError("INPUT_INVALID", "Input must be a regular file", {
      path: candidate
    });
  }
  return resolvedPath;
}

export function resolveOutputPath(root: string, candidate: string): string {
  rejectNonPath(candidate);
  return isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
}

export function assertSafeRelativePath(candidate: string): void {
  rejectNonPath(candidate);
  if (isAbsolute(candidate) || escapes("/project", resolve("/project", candidate))) {
    throw new CompilerError(
      "PATH_OUTSIDE_ROOT",
      "Path must remain relative to the project directory",
      { path: candidate }
    );
  }
}

function rejectNonPath(candidate: string): void {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.includes("\u0000") ||
    /^[a-z][a-z0-9+.-]*:\/\//iu.test(candidate) ||
    /^file:/iu.test(candidate)
  ) {
    throw new CompilerError(
      "INPUT_INVALID",
      "Only explicit local filesystem paths are accepted",
      { path: String(candidate) }
    );
  }
}

function escapes(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === ".." || path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}
