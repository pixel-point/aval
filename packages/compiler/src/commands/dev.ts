import { watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";

import type { DevCliArguments } from "../cli-args.js";
import {
  assertPublicationTargetUnchanged,
  backupPublicationTarget,
  closePublicationWorkspace,
  createPublicationWorkspace,
  inspectPublicationTarget,
  installStagedFile,
  restorePublicationBackup,
  stagePublicationFile,
  syncDirectory,
  throwIfAborted,
  unlinkIfIdentity,
  type PublicationTargetSnapshot,
  type StagedPublicationFile
} from "../compile/output.js";
import { buildProjectArtifact } from "../compile/project-compiler.js";
import { CompilerError } from "../diagnostics.js";
import type {
  CompileArtifact,
  CompileResult,
  ProjectArtifactOptions
} from "../model.js";
import { resolveProjectWatchPaths } from "./project-input-paths.js";
import { assertDistinctDevOutput } from "./compile-collisions.js";

export interface DevBuildEvent {
  readonly sequence: number;
  readonly result: Readonly<CompileResult>;
}

export interface DevFailureEvent {
  readonly sequence: number;
  readonly error: unknown;
}

export interface WatchHandle {
  close(): void;
}

export interface DevCommandDependencies {
  readonly buildProjectArtifact: (
    options: ProjectArtifactOptions
  ) => Promise<Readonly<CompileArtifact>>;
  readonly publishArtifact?: (
    artifact: Readonly<CompileArtifact>,
    context: {
      readonly outputPath: string;
      readonly signal: AbortSignal;
    }
  ) => Promise<Readonly<CompileResult>>;
  readonly watchPath: (path: string, onChange: () => void) => WatchHandle;
}

export interface DevSession {
  /** Settles after the first non-superseded build attempt. */
  readonly firstBuild: Promise<void>;
  /** Settles after close and any active compiler operation has unwound. */
  readonly closed: Promise<void>;
  readonly watchPaths: () => readonly string[];
  close(): Promise<void>;
}

const DEFAULT_DEPENDENCIES: DevCommandDependencies = {
  buildProjectArtifact,
  watchPath: nodeWatchPath
};

/** Start one compile plus a 100 ms, aborting, single-flight local watcher. */
export async function startDevCommand(
  arguments_: DevCliArguments,
  options: {
    readonly cwd: string;
    readonly signal?: AbortSignal;
    readonly debounceMs?: number;
    readonly dependencies?: DevCommandDependencies;
    readonly onBuild?: (event: DevBuildEvent) => void;
    readonly onFailure?: (event: DevFailureEvent) => void;
  }
): Promise<DevSession> {
  if (options.signal?.aborted === true) {
    throw new CompilerError("CANCELLED", "Dev session was cancelled before it started", {
      cause: options.signal.reason
    });
  }
  const projectPath = resolve(options.cwd, arguments_.project);
  const outputPath = resolve(options.cwd, arguments_.output);
  await assertDistinctDevOutput(
    projectPath,
    outputPath,
    arguments_.ffmpegPath,
    arguments_.ffprobePath
  );
  const initialOutput = await assertInitialOutput(outputPath, arguments_.force);
  const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
  const defaultPublisher = dependencies.publishArtifact === undefined
    ? createDevPublisher(outputPath, initialOutput)
    : undefined;
  const debounceMs = options.debounceMs ?? 100;
  if (!Number.isSafeInteger(debounceMs) || debounceMs < 0 || debounceMs > 60_000) {
    throw new CompilerError("CLI_USAGE", "Dev debounce must be from 0 through 60,000 ms");
  }

  let currentPaths = await resolveProjectWatchPaths(projectPath);
  let watchers: WatchHandle[] = [];
  let requestedSequence = 1;
  let activeSequence = 0;
  let activeAbort: AbortController | undefined;
  let active: Promise<void> | undefined;
  let debounce: NodeJS.Timeout | undefined;
  let debouncedReady = true;
  let closing = false;
  let firstSettled = false;
  let resolveFirst!: () => void;
  let resolveClosed!: () => void;
  const firstBuild = new Promise<void>((resolvePromise) => {
    resolveFirst = resolvePromise;
  });
  const closed = new Promise<void>((resolvePromise) => {
    resolveClosed = resolvePromise;
  });

  const replaceWatchers = (paths: readonly string[]): void => {
    const replacements: WatchHandle[] = [];
    try {
      for (const path of paths) {
        replacements.push(dependencies.watchPath(path, requestBuild));
      }
    } catch (error) {
      for (const watcher of replacements) watcher.close();
      throw new CompilerError("IO_FAILED", "Could not watch a resolved project input", {
        cause: error
      });
    }
    for (const watcher of watchers) watcher.close();
    currentPaths = Object.freeze([...paths]);
    watchers = replacements;
  };

  const settleFirst = (): void => {
    if (firstSettled) return;
    firstSettled = true;
    resolveFirst();
  };

  const maybeResolveClosed = (): void => {
    if (closing && active === undefined) resolveClosed();
  };

  const compile = async (sequence: number, controller: AbortController): Promise<void> => {
    try {
      const artifact = await dependencies.buildProjectArtifact({
        projectPath,
        ...(arguments_.ffmpegPath === undefined
          ? {}
          : { ffmpegPath: arguments_.ffmpegPath }),
        ...(arguments_.ffprobePath === undefined
          ? {}
          : { ffprobePath: arguments_.ffprobePath }),
        signal: controller.signal
      });
      if (closing || sequence !== requestedSequence || controller.signal.aborted) {
        return;
      }
      const result = dependencies.publishArtifact === undefined
        ? await defaultPublisher!.publish(artifact, controller.signal)
        : await dependencies.publishArtifact(artifact, {
            outputPath,
            signal: controller.signal
          });
      if (!closing && sequence === requestedSequence) {
        options.onBuild?.(Object.freeze({ sequence, result }));
        try {
          const nextPaths = await resolveProjectWatchPaths(projectPath);
          if (!closing && sequence === requestedSequence) {
            replaceWatchers(nextPaths);
          }
        } catch (error) {
          if (!closing && sequence === requestedSequence) {
            options.onFailure?.(Object.freeze({ sequence, error }));
          }
        }
        settleFirst();
      }
    } catch (error) {
      if (!closing && sequence === requestedSequence) {
        options.onFailure?.(Object.freeze({ sequence, error }));
        settleFirst();
      }
    }
  };

  const maybeStart = (): void => {
    if (closing || active !== undefined || !debouncedReady) return;
    debouncedReady = false;
    activeSequence = requestedSequence;
    const controller = new AbortController();
    activeAbort = controller;
    const operation = compile(activeSequence, controller);
    active = operation;
    const finalize = (): void => {
      if (active === operation) {
        active = undefined;
        activeAbort = undefined;
      }
      if (!closing && requestedSequence > activeSequence && debounce === undefined) {
        debouncedReady = true;
      }
      maybeStart();
      maybeResolveClosed();
    };
    void operation.then(finalize, finalize);
  };

  function requestBuild(): void {
    if (closing) return;
    requestedSequence += 1;
    activeAbort?.abort(new CompilerError("CANCELLED", "Superseded by a newer source change"));
    debouncedReady = false;
    if (debounce !== undefined) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      debouncedReady = true;
      maybeStart();
    }, debounceMs);
  }

  replaceWatchers(currentPaths);
  const abortFromCaller = (): void => {
    void close();
  };
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (signalIsAborted(options.signal)) void close();

  async function close(): Promise<void> {
    if (!closing) {
      closing = true;
      options.signal?.removeEventListener("abort", abortFromCaller);
      if (debounce !== undefined) {
        clearTimeout(debounce);
        debounce = undefined;
      }
      for (const watcher of watchers) watcher.close();
      watchers = [];
      activeAbort?.abort(new CompilerError("CANCELLED", "Dev session closed"));
      settleFirst();
      maybeResolveClosed();
    }
    await closed;
  }

  maybeStart();
  return Object.freeze({
    firstBuild,
    closed,
    watchPaths: () => currentPaths,
    close
  });
}

async function assertInitialOutput(
  path: string,
  force: boolean
): Promise<Readonly<PublicationTargetSnapshot>> {
  const snapshot = await inspectPublicationTarget(path, "dev output");
  if (snapshot.exists && !force) {
    throw new CompilerError("IO_FAILED", "Dev output already exists", {
      path,
      hint: "Pass --force to replace this exact local output during development."
    });
  }
  return snapshot;
}

function createDevPublisher(
  outputPath: string,
  initial: Readonly<PublicationTargetSnapshot>
): {
  publish(
    artifact: Readonly<CompileArtifact>,
    signal: AbortSignal
  ): Promise<Readonly<CompileResult>>;
} {
  let expected = initial;
  return Object.freeze({
    publish: async (artifact, signal) => {
      const workspace = await createPublicationWorkspace(outputPath);
      let staged: Readonly<StagedPublicationFile> | undefined;
      let backupPath: string | undefined;
      let backupIdentity: Awaited<ReturnType<typeof backupPublicationTarget>> | undefined;
      let installedIdentity: Awaited<ReturnType<typeof installStagedFile>> | undefined;
      let committed = false;
      try {
        staged = await stagePublicationFile(
          workspace,
          "asset.rma",
          artifact.assetBytes
        );
        await assertPublicationTargetUnchanged(outputPath, expected, "dev output");
        throwIfAborted(signal);
        if (expected.exists) {
          backupPath = join(workspace.directory, "asset.previous");
          backupIdentity = await backupPublicationTarget(
            outputPath,
            expected,
            backupPath,
            "dev output"
          );
          throwIfAborted(signal);
        }
        installedIdentity = await installStagedFile(
          outputPath,
          staged,
          "dev output"
        );
        staged = undefined;
        await syncDirectory(workspace.parent);
        committed = true;
        expected = Object.freeze({
          exists: true as const,
          identity: installedIdentity,
          mode: 0o600
        });
        if (backupPath !== undefined && backupIdentity !== undefined) {
          await unlinkIfIdentity(backupPath, backupIdentity);
          backupPath = undefined;
          backupIdentity = undefined;
        }
        await syncDirectory(workspace.parent);
        return Object.freeze({
          outputPath,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          provenance: artifact.provenance,
          warnings: artifact.warnings,
          buildDetails: artifact.buildDetails
        });
      } catch (error) {
        const rollbackFailures: unknown[] = [];
        if (!committed && installedIdentity !== undefined) {
          await unlinkIfIdentity(outputPath, installedIdentity).catch((failure) => {
            rollbackFailures.push(failure);
            return false;
          });
        }
        if (!committed && backupPath !== undefined && backupIdentity !== undefined) {
          await restorePublicationBackup(
            outputPath,
            backupPath,
            backupIdentity,
            "dev output"
          ).catch((failure) => rollbackFailures.push(failure));
        }
        if (rollbackFailures.length > 0) {
          throw new CompilerError(
            "IO_FAILED",
            "Dev publication failed and its previous output could not be restored",
            {
              path: outputPath,
              cause: new AggregateError([error, ...rollbackFailures])
            }
          );
        }
        if (error instanceof CompilerError) throw error;
        throw new CompilerError("IO_FAILED", "Could not publish dev artifact", {
          path: outputPath,
          cause: error
        });
      } finally {
        if (staged !== undefined) {
          await unlinkIfIdentity(staged.path, staged.identity).catch(() => false);
        }
        await closePublicationWorkspace(workspace).catch(() => undefined);
      }
    }
  });
}

function nodeWatchPath(path: string, onChange: () => void): FSWatcher {
  const watcher = watch(path, { persistent: true }, () => onChange());
  watcher.on("error", () => onChange());
  return watcher;
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export { resolveProjectWatchPaths } from "./project-input-paths.js";
