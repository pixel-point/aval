import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { CompileCliArguments } from "../cli-args.js";
import { CompilerError } from "../diagnostics.js";
import { resolveProjectWatchPaths } from "./project-input-paths.js";

/** Prevent --force from replacing the project, source media, or explicit tools. */
export async function assertDistinctCompileOutputs(
  arguments_: CompileCliArguments,
  inputPath: string,
  outputPath: string,
  reportPath: string
): Promise<void> {
  const protectedPaths = inputPath.toLowerCase().endsWith(".json")
    ? await projectInputPaths(inputPath)
    : await directInputPaths(arguments_, inputPath);
  const toolPaths = [arguments_.ffmpegPath, arguments_.ffprobePath]
    .filter((path): path is string => path !== undefined);
  const protectedCanonical = new Set<string>();
  for (const path of [...protectedPaths, ...toolPaths]) {
    protectedCanonical.add(await canonicalPath(path));
  }
  for (const [label, path] of [
    ["asset", outputPath],
    ["build report", reportPath]
  ] as const) {
    if (protectedCanonical.has(await canonicalPath(path))) {
      throw new CompilerError(
        "INPUT_INVALID",
        `${label} path collides with a project input or compiler tool`,
        { path }
      );
    }
  }
}

/** Apply compile's protected-input collision rule to the dev output. */
export async function assertDistinctDevOutput(
  projectPath: string,
  outputPath: string,
  ffmpegPath?: string,
  ffprobePath?: string
): Promise<void> {
  const protectedPaths = await projectInputPaths(projectPath);
  const protectedCanonical = new Set<string>();
  for (const path of [
    ...protectedPaths,
    ...(ffmpegPath === undefined ? [] : [ffmpegPath]),
    ...(ffprobePath === undefined ? [] : [ffprobePath])
  ]) {
    protectedCanonical.add(await canonicalPath(path));
  }
  if (protectedCanonical.has(await canonicalPath(outputPath))) {
    throw new CompilerError(
      "INPUT_INVALID",
      "Dev output collides with the project, a source input, or compiler tool",
      { path: outputPath }
    );
  }
}

async function projectInputPaths(projectPath: string): Promise<readonly string[]> {
  try {
    return await resolveProjectWatchPaths(projectPath);
  } catch {
    // The project compiler remains the diagnostic owner for a missing or
    // malformed project. Its path is still protected from output collision.
    return Object.freeze([projectPath]);
  }
}

async function directInputPaths(
  arguments_: CompileCliArguments,
  inputPath: string
): Promise<readonly string[]> {
  if (!inputPath.includes("%")) return Object.freeze([inputPath]);
  if (arguments_.frames === undefined) {
    throw new CompilerError("CLI_USAGE", "PNG input requires --frames");
  }
  const match = /%0([1-9])d/u.exec(basename(inputPath));
  if (match === null) {
    throw new CompilerError("CLI_USAGE", "PNG input has an invalid frame token");
  }
  const width = Number(match[1]);
  const paths: string[] = [];
  for (let index = 0; index < arguments_.frames.frameCount; index += 1) {
    const frameNumber = arguments_.frames.firstNumber + index;
    paths.push(resolve(
      dirname(inputPath),
      basename(inputPath).replace(match[0], String(frameNumber).padStart(width, "0"))
    ));
  }
  return Object.freeze(paths);
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    try {
      return join(await realpath(dirname(path)), basename(path));
    } catch {
      return resolve(path);
    }
  }
}
