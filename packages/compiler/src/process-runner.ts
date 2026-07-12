import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";

import { CompilerError } from "./diagnostics.js";
import type { ProcessLimits } from "./model.js";

export interface RunProcessInput {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly limits: ProcessLimits;
  readonly stdin?: Uint8Array;
  readonly stdinFile?: {
    readonly path: string;
    readonly offset: number;
    readonly length: number;
  };
  readonly stdoutSink?: Writable;
  /** Require an exact byte count even when stdout is streamed to a sink. */
  readonly expectedStdoutBytes?: number;
  /** Run in a fresh mode-0700 directory and remove it before settling. */
  readonly privateWorkingDirectory?: true | {
    readonly root?: string;
    readonly prefix?: string;
  };
  readonly signal?: AbortSignal;
}

export interface ProcessResult {
  readonly stdout: Uint8Array;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Spawn without a shell and retain only explicitly bounded output. */
export async function runBoundedProcess(
  input: RunProcessInput
): Promise<Readonly<ProcessResult>> {
  throwIfAborted(input.signal);
  validateProcessInput(input);
  const privateDirectory = await createPrivateWorkingDirectory(input);
  try {
    throwIfAborted(input.signal);
    return await runSpawnedProcess(input, privateDirectory);
  } finally {
    if (privateDirectory !== undefined) {
      await rm(privateDirectory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50
      });
    }
  }
}

function runSpawnedProcess(
  input: RunProcessInput,
  privateDirectory: string | undefined
): Promise<Readonly<ProcessResult>> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, [...input.arguments], {
      cwd: privateDirectory ?? input.cwd,
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: createProcessEnvironment(privateDirectory)
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let forcedError: CompilerError | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let inputStream: ReturnType<typeof createReadStream> | undefined;
    let streamedInputBytes = 0;
    let processClosed = false;
    let closedCode: number | null = null;
    let closedSignal: NodeJS.Signals | null = null;
    let sinkFinished = input.stdoutSink === undefined;
    let stdoutEnded = false;

    const finish = (
      operation: () => void
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (escalation !== undefined) clearTimeout(escalation);
      input.signal?.removeEventListener("abort", abort);
      inputStream?.destroy();
      operation();
    };
    const stop = (error: CompilerError): void => {
      if (settled || forcedError !== undefined) return;
      forcedError = error;
      inputStream?.destroy();
      terminateProcessTree(child.pid, "SIGTERM", child);
      escalation = setTimeout(() => {
        terminateProcessTree(child.pid, "SIGKILL", child);
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        input.stdoutSink?.destroy();
      }, 1_000);
      escalation.unref();
    };
    const abort = (): void => stop(cancelled(input.signal?.reason));
    const timeout = setTimeout(() => {
      stop(new CompilerError(
        "PROCESS_TIMEOUT",
        `Process exceeded ${String(input.limits.timeoutMs)} ms`,
        { hint: "Reduce source duration or complexity; the operation timeout is intentionally bounded." }
      ));
    }, input.limits.timeoutMs);
    timeout.unref();
    input.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (
        input.expectedStdoutBytes !== undefined &&
        stdoutBytes > input.expectedStdoutBytes
      ) {
        stop(new CompilerError(
          "FFMPEG_FAILED",
          `Process emitted extra stdout bytes; expected exactly ${String(input.expectedStdoutBytes)}`
        ));
        return;
      }
      if (stdoutBytes > input.limits.maxStdoutBytes) {
        stop(new CompilerError(
          "OUTPUT_LIMIT",
          `Process stdout exceeded ${String(input.limits.maxStdoutBytes)} bytes`
        ));
        return;
      }
      if (input.stdoutSink === undefined) stdout.push(chunk);
    });
    child.stdout.once("end", () => {
      stdoutEnded = true;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > input.limits.maxStderrBytes) {
        stop(new CompilerError(
          "OUTPUT_LIMIT",
          `Process stderr exceeded ${String(input.limits.maxStderrBytes)} bytes`
        ));
        return;
      }
      stderr.push(chunk);
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      stop(new CompilerError(
        "FFMPEG_FAILED",
        "Media tool closed stdin before consuming compiler input",
        { cause: error }
      ));
    });
    if (input.stdoutSink !== undefined) {
      input.stdoutSink.once("error", (error) => {
        stop(error instanceof CompilerError
          ? error
          : new CompilerError(
              "IO_FAILED",
              "Could not write streamed process output",
              { cause: error }
            ));
      });
      input.stdoutSink.once("finish", () => {
        sinkFinished = true;
        completeClosedProcess();
      });
      input.stdoutSink.once("close", () => {
        if (!sinkFinished && !stdoutEnded) {
          stop(new CompilerError(
            "IO_FAILED",
            "Streamed process output closed before stdout ended"
          ));
        }
        sinkFinished = true;
        completeClosedProcess();
      });
      child.stdout.pipe(input.stdoutSink);
    }
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(() => reject(new CompilerError(
        error.code === "ENOENT" ? "FFMPEG_NOT_FOUND" : "FFMPEG_FAILED",
        error.code === "ENOENT"
          ? "Configured media executable was not found"
          : "Could not launch the configured media tool",
        { cause: error }
      )));
    });
    child.once("close", (code, signal) => {
      processClosed = true;
      closedCode = code;
      closedSignal = signal;
      completeClosedProcess();
    });

    function completeClosedProcess(): void {
      if (!processClosed || !sinkFinished || settled) return;
      finish(() => {
        if (forcedError !== undefined) {
          reject(forcedError);
          return;
        }
        if (
          input.stdinFile !== undefined &&
          streamedInputBytes !== input.stdinFile.length
        ) {
          reject(new CompilerError(
            "IO_FAILED",
            "Compiler input spool ended before the requested byte range"
          ));
          return;
        }
        if (
          input.expectedStdoutBytes !== undefined &&
          stdoutBytes !== input.expectedStdoutBytes
        ) {
          reject(new CompilerError(
            "FFMPEG_FAILED",
            `Process stdout contained ${String(stdoutBytes)} bytes; expected exactly ${String(input.expectedStdoutBytes)}`
          ));
          return;
        }
        const stderrText = Buffer.concat(stderr, stderrBytes).toString("utf8");
        if (closedCode !== 0) {
          reject(new CompilerError(
            "FFMPEG_FAILED",
            `Media tool exited with ${closedCode === null ? closedSignal ?? "unknown" : String(closedCode)}`,
            {
              // Raw stderr may contain absolute paths, source-controlled text,
              // terminal escapes, environment-derived values, or HTML. It is
              // retained only in a successful internal ProcessResult and is
              // never copied into a public failure diagnostic.
              hint: "Verify the source media and recorded toolchain compatibility."
            }
          ));
          return;
        }
        resolve(Object.freeze({
          stdout: input.stdoutSink === undefined
            ? new Uint8Array(Buffer.concat(stdout, stdoutBytes))
            : new Uint8Array(0),
          stderr: stderrText,
          exitCode: 0
        }));
      });
    }

    if (input.stdinFile !== undefined) {
      const { path, offset, length } = input.stdinFile;
      inputStream = createReadStream(path, {
        start: offset,
        end: offset + length - 1,
        highWaterMark: Math.min(length, 1024 * 1024)
      });
      inputStream.on("data", (chunk: string | Buffer) => {
        streamedInputBytes += typeof chunk === "string"
          ? Buffer.byteLength(chunk)
          : chunk.byteLength;
        if (streamedInputBytes > length) {
          stop(new CompilerError(
            "IO_FAILED",
            "Compiler input spool exceeded the requested byte range"
          ));
        }
      });
      inputStream.once("error", (error) => {
        stop(new CompilerError(
          "IO_FAILED",
          "Could not read compiler input spool",
          { path, cause: error }
        ));
      });
      inputStream.once("end", () => {
        if (streamedInputBytes !== length) {
          stop(new CompilerError(
            "IO_FAILED",
            "Compiler input spool ended before the requested byte range",
            { path }
          ));
        }
      });
      inputStream.pipe(child.stdin);
    } else if (input.stdin === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(input.stdin);
    }
  });
}

async function createPrivateWorkingDirectory(
  input: RunProcessInput
): Promise<string | undefined> {
  if (input.privateWorkingDirectory === undefined) return undefined;
  const configuration = input.privateWorkingDirectory === true
    ? {}
    : input.privateWorkingDirectory;
  const root = configuration.root ?? tmpdir();
  const prefix = configuration.prefix ?? "rma-process-";
  try {
    const directory = await mkdtemp(join(root, prefix));
    await chmod(directory, 0o700);
    return directory;
  } catch (error) {
    throw new CompilerError(
      "IO_FAILED",
      "Could not create a private process working directory",
      { path: root, cause: error }
    );
  }
}

function terminateProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
  child: ReturnType<typeof spawn>
): void {
  try {
    if (process.platform !== "win32" && pid !== undefined) {
      process.kill(-pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      // The close/error event remains the sole promise settlement owner.
    }
  }
}

function validateProcessInput(input: RunProcessInput): void {
  if (input.executable.length === 0 || input.executable.includes("\u0000")) {
    throw new CompilerError("INPUT_INVALID", "Executable path is invalid");
  }
  if (input.arguments.some((argument) => argument.includes("\u0000"))) {
    throw new CompilerError("INPUT_INVALID", "Process argument contains NUL");
  }
  if (input.cwd.length === 0 || input.cwd.includes("\u0000")) {
    throw new CompilerError("INPUT_INVALID", "Process working directory is invalid");
  }
  if (input.stdin !== undefined && input.stdinFile !== undefined) {
    throw new CompilerError(
      "INPUT_INVALID",
      "Process input must use either bytes or a spool range, not both"
    );
  }
  if (input.stdinFile !== undefined) {
    const { path, offset, length } = input.stdinFile;
    if (
      path.length === 0 ||
      path.includes("\u0000") ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      offset > Number.MAX_SAFE_INTEGER - length
    ) {
      throw new CompilerError("INPUT_INVALID", "Process spool range is invalid");
    }
  }
  for (const [name, value] of Object.entries(input.limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new CompilerError(
        "INPUT_INVALID",
        `${name} must be a positive safe integer`
      );
    }
  }
  if (
    input.expectedStdoutBytes !== undefined &&
    (
      !Number.isSafeInteger(input.expectedStdoutBytes) ||
      input.expectedStdoutBytes < 0 ||
      input.expectedStdoutBytes > input.limits.maxStdoutBytes
    )
  ) {
    throw new CompilerError(
      "INPUT_INVALID",
      "expectedStdoutBytes must fit the stdout byte limit"
    );
  }
  if (
    input.privateWorkingDirectory !== undefined &&
    input.privateWorkingDirectory !== true
  ) {
    const { root, prefix } = input.privateWorkingDirectory;
    if (root !== undefined && (root.length === 0 || root.includes("\u0000"))) {
      throw new CompilerError("INPUT_INVALID", "Temporary root is invalid");
    }
    if (
      prefix !== undefined &&
      (!/^[A-Za-z0-9._-]{1,64}$/u.test(prefix) || prefix === "." || prefix === "..")
    ) {
      throw new CompilerError("INPUT_INVALID", "Temporary directory prefix is invalid");
    }
  }
}

/** Construct the intentionally tiny, proxy-free child environment. */
export function createProcessEnvironment(
  privateDirectory?: string
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    LC_ALL: "C",
    LANG: "C"
  };
  if (privateDirectory === undefined) {
    environment.HOME = process.env.HOME;
    environment.TMPDIR = process.env.TMPDIR;
  } else {
    environment.HOME = privateDirectory;
    environment.TMPDIR = privateDirectory;
    environment.TMP = privateDirectory;
    environment.TEMP = privateDirectory;
  }
  return environment;
}

function cancelled(reason: unknown): CompilerError {
  return new CompilerError("CANCELLED", "Compiler operation was cancelled", {
    cause: reason
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw cancelled(signal.reason);
}
