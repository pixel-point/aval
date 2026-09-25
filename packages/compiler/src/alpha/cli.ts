import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { CompilerError } from "../diagnostics.js";
import { compileAlpha, readAlphaConfig } from "./compile.js";
import type { AlphaCompileOptions, AlphaEncoding } from "./types.js";

export interface AlphaCliArguments {
  readonly command: "alpha";
  readonly input: string;
  readonly output: string;
  readonly json: boolean;
  readonly options: Omit<AlphaCompileOptions, "out" | "signal">;
}

export function parseAlphaCli(tokens: readonly string[]): AlphaCliArguments | { readonly command: "help" } {
  try {
    const { values: v, positionals } = parseArgs({ args: [...tokens], allowPositionals: true, strict: true, options: {
      out: { type: "string" }, codecs: { type: "string" }, crf: { type: "string" }, preset: { type: "string" },
      encoder: { type: "string" }, "cpu-used": { type: "string" }, deadline: { type: "string" },
      threads: { type: "string" }, "bit-depth": { type: "string" }, gop: { type: "string" }, fps: { type: "string" },
      width: { type: "string" }, height: { type: "string" }, layout: { type: "string" }, frames: { type: "string" }, "start-number": { type: "string" },
      ffmpeg: { type: "string" }, ffprobe: { type: "string" }, "media-timeout-ms": { type: "string" },
      "base-url": { type: "string" }, premultiplied: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean" }
    } });
    if (v.help) return { command: "help" };
    if (positionals.length !== 1 || !v.out) throw new Error("avl alpha requires one input and --out <directory>");
    const input = positionals[0]!;
    const keys = ["codec", "crf", "preset", "encoder", "cpuUsed", "deadline", "threads", "bitDepth", "gop"];
    const encoding: Record<string, unknown> = {};
    const options: Record<string, unknown> = {};
    const mapping: Record<string, string> = { "cpu-used": "cpuUsed", "bit-depth": "bitDepth", "start-number": "startNumber", "media-timeout-ms": "timeoutMs", "base-url": "baseUrl" };
    const numeric = new Set(["crf", "cpuUsed", "threads", "bitDepth", "gop", "fps", "width", "height", "frames", "startNumber", "timeoutMs"]);
    for (const [flag, value] of Object.entries(v)) {
      if (["out", "codecs", "json", "help"].includes(flag)) continue;
      const key = mapping[flag] ?? flag;
      (keys.includes(key) ? encoding : options)[key] = numeric.has(key) ? Number(value) : value;
    }
    if (input.endsWith(".json") && (v.codecs || Object.keys(encoding).length)) throw new Error("Put encoding options in the alpha JSON configuration");
    if (v.codecs || Object.keys(encoding).length) {
      if (!v.codecs) throw new Error("Encoding flags require --codecs");
      options.encodings = v.codecs.split(",").map((codec) => ({ ...encoding, codec }) as unknown as AlphaEncoding);
    }
    return { command: "alpha", input, output: v.out, json: v.json ?? false, options };
  } catch (cause) {
    throw new CompilerError("CLI_USAGE", cause instanceof Error ? cause.message : "Invalid alpha arguments", { cause });
  }
}

export async function runAlphaCommand(args: AlphaCliArguments, cwd: string, signal?: AbortSignal) {
  const path = resolve(cwd, args.input);
  const config = path.endsWith(".json") ? await readAlphaConfig(path) : { input: path, options: {} };
  return compileAlpha(config.input, { ...config.options, ...args.options, out: resolve(cwd, args.output), ...(signal ? { signal } : {}) });
}
