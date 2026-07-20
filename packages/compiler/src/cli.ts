#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  parseCliArguments,
  type CliArguments
} from "./cli-args.js";
import {
  exitStatusForCode,
  sanitizeTerminalText,
  writeJsonDiagnostic,
  writeJsonResult,
  writeTextDiagnostic,
  writeTextResult,
  type CliIo
} from "./cli-output.js";
import {
  runCompileCommand,
  type CompileCommandDependencies
} from "./commands/compile.js";
import {
  startDevCommand,
  type DevCommandDependencies
} from "./commands/dev.js";
import { runInitCommand } from "./commands/init.js";
import { openDevServer, startDevServer } from "./commands/dev-server.js";
import { runInspectCommand } from "./commands/inspect.js";
import { runUnpackCommand } from "./commands/unpack.js";
import { runValidateCommand } from "./commands/validate.js";
import {
  CompilerError,
  diagnosticFromError,
  type CompilerDiagnostic
} from "./diagnostics.js";

export interface CliRuntime {
  readonly cwd?: string;
  readonly io?: CliIo;
  readonly signal?: AbortSignal;
  readonly compileDependencies?: CompileCommandDependencies;
  readonly devDependencies?: DevCommandDependencies;
  readonly devDebounceMs?: number;
}

const PROCESS_IO: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text)
};

/** Programmatic, captured-IO entry point used by the executable and tests. */
export async function runCli(
  argv: readonly string[],
  runtime: CliRuntime = {}
): Promise<number> {
  const io = runtime.io ?? PROCESS_IO;
  const cwd = runtime.cwd ?? process.cwd();
  let arguments_: CliArguments | undefined;
  const requestedJson = argv.includes("--json");
  try {
    arguments_ = parseCliArguments(argv);
    switch (arguments_.command) {
      case "help":
        writeTextResult(io, HELP_TEXT);
        return 0;
      case "compile": {
        const result = await runCompileCommand(arguments_, {
          cwd,
          ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
          ...(runtime.compileDependencies === undefined
            ? {}
            : { dependencies: runtime.compileDependencies })
        });
        const warnings = result.warnings.length === 0
          ? ""
          : `\n${result.warnings.map((warning) => `WARNING ${safe(warning)}`).join("\n")}`;
        const assets = result.assets.map((asset) =>
          `${asset.codec}: ${safe(asset.path)} (${String(asset.bytes)} bytes, ${asset.sha256})`
        ).join("\n");
        outputResult(
          io,
          arguments_.json,
          result,
          `Compiled bundle ${safe(result.outputPath)} (${count(result.assets.length, "codec asset")})\n${assets}\nReport ${safe(result.reportPath)}\nSources:\n${result.sourceMarkup}${warnings}`
        );
        return 0;
      }
      case "inspect": {
        const result = await runInspectCommand(arguments_, cwd, runtime.signal);
        outputResult(io, arguments_.json, result, inspectText(result));
        return 0;
      }
      case "validate": {
        const result = await runValidateCommand(arguments_, cwd, runtime.signal);
        outputResult(
          io,
          arguments_.json,
          result,
          `Valid ${safe(result.file)} (${String(result.bytes)} bytes, ${count(result.chunks, "chunk")})\nVideo ${safe(result.codec)}/${safe(result.bitstream)}/${safe(result.layout)}: ${result.videoClaim}; digests: ${result.digestClaim}`
        );
        return 0;
      }
      case "unpack": {
        const result = await runUnpackCommand(arguments_, cwd, runtime.signal);
        outputResult(
          io,
          arguments_.json,
          result,
          `Unpacked ${safe(result.source)} to ${safe(result.outputDirectory)} (${count(result.chunks, "chunk")}, ${count(result.files.length, "file")})`
        );
        return 0;
      }
      case "init": {
        const result = await runInitCommand(arguments_, cwd);
        outputResult(
          io,
          arguments_.json,
          result,
          `Created ${safe(result.project)} with ${String(result.files.length)} generated files`
        );
        return 0;
      }
      case "dev": {
        const server = await startDevServer({
          bundlePath: resolve(cwd, arguments_.output),
          port: arguments_.port ?? 4174
        });
        outputResult(io, arguments_.json, {
          command: "dev",
          event: "listening",
          url: server.url
        }, `Dev playground ${server.url}`);
        if (arguments_.open === true) openDevServer(server.url);
        let session: Awaited<ReturnType<typeof startDevCommand>> | null = null;
        try {
          session = await startDevCommand(arguments_, {
            cwd,
            ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
            ...(runtime.devDebounceMs === undefined
              ? {}
              : { debounceMs: runtime.devDebounceMs }),
            ...(runtime.devDependencies === undefined
              ? {}
              : { dependencies: runtime.devDependencies }),
            onBuild: ({ sequence, result, build }) => {
              server.publish(build);
              outputResult(
                io,
                arguments_?.command === "dev" && arguments_.json,
                {
                  command: "dev",
                  event: "build",
                  sequence,
                  outputPath: result.outputPath,
                  reportPath: result.reportPath,
                  assets: result.assets,
                  warnings: result.warnings
                },
                `Build ${String(sequence)}: ${safe(result.outputPath)} (${count(result.assets.length, "codec asset")})`
              );
            },
            onFailure: ({ error }) => {
              outputDiagnostic(
                io,
                arguments_?.command === "dev" && arguments_.json,
                diagnosticFromError(error)
              );
            }
          });
          await Promise.race([session.closed, server.closed]);
        } finally {
          await Promise.allSettled([
            session?.close() ?? Promise.resolve(),
            server.close()
          ]);
        }
        return runtime.signal?.aborted === true ? 130 : 0;
      }
    }
  } catch (error) {
    const diagnostic = diagnosticFromError(error);
    outputDiagnostic(
      io,
      arguments_ === undefined ? requestedJson : "json" in arguments_ && arguments_.json,
      diagnostic
    );
    return error instanceof CompilerError ? exitStatusForCode(error.code) : 6;
  }
}

function outputResult(
  io: CliIo,
  json: boolean,
  value: unknown,
  text: string
): void {
  if (json) writeJsonResult(io, value);
  else writeTextResult(io, text);
}

function outputDiagnostic(
  io: CliIo,
  json: boolean,
  diagnostic: CompilerDiagnostic
): void {
  if (json) writeJsonDiagnostic(io, diagnostic);
  else writeTextDiagnostic(io, diagnostic);
}

function inspectText(result: Awaited<ReturnType<typeof runInspectCommand>>): string {
  const lines = [
    `${safe(result.file)}: AVAL ${result.formatVersion}, ${safe(result.codec)}/${safe(result.bitstream)}, ${String(result.bytes)} bytes`,
    `Canvas ${String(result.canvas.width)}x${String(result.canvas.height)} at ${result.frameRate} fps, layout ${safe(result.layout)}`,
    `Initial state ${safe(result.initialState)}; states ${result.states.map(safe).join(", ")}`,
    `SHA-256 ${result.sha256}`,
    ...result.renditions.map((rendition) =>
      `Rendition ${safe(rendition.id)}: ${safe(rendition.codec)}, ${String(rendition.bitDepth)}-bit, coded ${safe(rendition.coded)}, alpha ${safe(rendition.alphaLayout.type)}`
    ),
    ...result.units.map((unit) =>
      `Unit ${safe(unit.id)}: ${safe(unit.kind)}, frames ${String(unit.startFrame)}:${String(unit.endFrame)}, time ${safe(unit.startTime)}:${safe(unit.endTime)}`
    ),
    ...result.video.map(({ codec, rendition, codecString, inspection }) =>
      `Video ${safe(codec)} ${safe(rendition)}: ${safe(codecString)}, ${String(inspection.units.length)} units inspected`
    ),
    ...result.chunkRanges.map((chunk) =>
      `Chunk ${safe(chunk.rendition)}/${safe(chunk.unit)}/${String(chunk.decodeIndex)}: pts=${String(chunk.presentationTimestamp)}, duration=${String(chunk.duration)}, ${chunk.randomAccess ? "random-access" : "dependent"}, displayed=${String(chunk.displayedFrameCount)}, offset=${String(chunk.byteOffset)}, length=${String(chunk.byteLength)}, sha256=${chunk.sha256}`
    ),
    `Video: ${result.videoClaim}; digests: ${result.digestClaim}`
  ];
  return lines.join("\n");
}

function safe(value: string): string {
  return sanitizeTerminalText(value);
}

function count(value: number, noun: string): string {
  return `${String(value)} ${noun}${value === 1 ? "" : "s"}`;
}

export const HELP_TEXT = `Usage:
  avl compile <project.json> --out <bundle-directory>
  avl compile <input.mov|input.mp4|input.m4v> --codec <h264|h265|vp9|av1> --loop <start:end> [codec options] [--alpha auto|opaque|packed] --out <bundle-directory>
  avl compile <prefix%0Nd.png> --codec <h264|h265|vp9|av1> --frames <first:count> --fps <n/d> --loop <start:end> [codec options] [--canvas <wxh>] [--alpha auto|opaque|packed] --out <bundle-directory>
  avl inspect <asset.avl> [--json]
  avl validate <asset.avl> [--json]
  avl unpack <asset.avl> --out <empty-directory> [--json]
  avl init <directory> [--json]
  avl dev <project.json> --out <bundle-directory> [--media-timeout-ms <integer>] [--port <0-65535>] [--open] [--force] [--json]

Direct encoding options:
  --crf <integer>                constant quality (H.264 1..51; H.265 0..51; VP9/AV1 0..63)
  --preset <name>                H.264/H.265 preset, ultrafast through placebo
  --deadline <mode>              VP9 best, good, or realtime deadline
  --cpu-used <integer>           VP9 -8..8 or AV1 0..8 speed/quality control
  --bit-depth <8|10>             AV1 output bit depth
  --tiles <columns>x<rows>       AV1 power-of-two tile layout, product at most 64
  --row-mt                       enable AV1 row multithreading
  --threads <1..64>              H.265, VP9, or AV1 encoder threads

Operational options:
  --media-timeout-ms <integer>   per FFmpeg operation for slow/large encodes

Project files own their ordered codec-major rendition and compression policy.
Muxer tags, faststart, arbitrary filters, audio, and raw FFmpeg arguments are unavailable.

Common compile options: --ffmpeg <absolute-path> --ffprobe <absolute-path> --force --json`;

async function main(): Promise<void> {
  const controller = new AbortController();
  const cancel = (): void => controller.abort(new CompilerError("CANCELLED", "Interrupted"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    process.exitCode = await runCli(process.argv.slice(2), {
      signal: controller.signal
    });
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && isInvokedModule(invokedPath)) {
  await main();
}

function isInvokedModule(invokedPath: string): boolean {
  try {
    return realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
