import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CompilerError } from "../diagnostics.js";
import { assertDirectoryObject, requireDirectoryIdentity, removeOwnedEmptyDirectory } from "../commands/publication-fs.js";
import { prepareAlphaFrames } from "./frames.js";
import { alphaEncodeArguments, alphaEncoder } from "./encode.js";
import { mediaTool, probeVideo, codecType, type VideoProbe } from "./media.js";
import { measureAlpha } from "./metrics.js";
import { resolveAlphaOptions } from "./options.js";
import { selectAlphaCandidates } from "./candidates.js";
import type { AlphaCandidate, AlphaCompileOptions, AlphaCompileResult, AlphaSourceDescriptor } from "./types.js";

/** Compile linear RGBA media into standard-container aval-alpha sources. */
export async function compileAlpha(inputPath: string, options: AlphaCompileOptions): Promise<AlphaCompileResult> {
  const settings = resolveAlphaOptions(options);
  const input = resolve(inputPath);
  const output = resolve(settings.out);
  await mkdir(dirname(output), { recursive: true });
  try { await stat(output); throw new CompilerError("IO_FAILED", "Output already exists; choose a new directory", { path: output }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const staging = await mkdtemp(join(dirname(output), ".aval-alpha-"));
  const directory = join(staging, ".work");
  try {
    await mkdir(directory);
    const encoders = new TextDecoder().decode((await mediaTool(settings, settings.ffmpeg, ["-hide_banner", "-encoders"])).stdout);
    for (const encoding of settings.encodings) {
      const name = alphaEncoder(encoding);
      if (!new RegExp(`\\s${name}\\s`, "u").test(encoders)) throw new CompilerError("FFMPEG_UNSUPPORTED", `FFmpeg needs ${name}`);
    }
    const frames = await prepareAlphaFrames(input, directory, settings);
    const sources: AlphaSourceDescriptor[] = [];
    const candidates: AlphaCandidate[] = [];
    for (const encoding of settings.encodings) {
      const extension = encoding.codec === "vp9" ? "webm" : "mp4";
      const attempts: { path: string; probe: VideoProbe; candidate: AlphaCandidate }[] = [];
      const variants = (settings.optimize?.presets?.[encoding.codec] ?? [encoding.preset]).flatMap((preset) =>
        (settings.optimize?.crfs ?? [encoding.crf]).map((crf) => ({ ...encoding, preset, crf })));
      for (const [index, variant] of variants.entries()) {
        const path = join(directory, `${encoding.codec}-${index}.${extension}`);
        const args = alphaEncodeArguments(frames, variant, path);
        const started = performance.now();
        await mediaTool(settings, settings.ffmpeg, args);
        const encodeMs = performance.now() - started;
        const probe = await probeVideo(path, settings);
        if (probe.width !== frames.geometry.codedWidth || probe.height !== frames.geometry.codedHeight) throw new CompilerError("FFMPEG_FAILED", "Encoded dimensions changed");
        const metrics = await measureAlpha(path, frames, directory, settings);
        const candidate = { codec: encoding.codec, crf: variant.crf, preset: variant.preset, cpuUsed: variant.cpuUsed,
          selected: false, pareto: false, bytes: (await stat(path)).size, encodeMs, metrics,
          arguments: args.map((arg) => arg.replaceAll(directory, "<work>")) };
        attempts.push({ path, probe, candidate });
      }
      const selection = selectAlphaCandidates(attempts.map(({ candidate }) => candidate), settings.optimize);
      const winner = attempts[selection.winner]!;
      candidates.push(...selection.candidates);
      const filename = `${encoding.codec}.${extension}`;
      const type = codecType(encoding.codec, winner.probe, frames.fps, frames.frames, winner.candidate.bytes);
      await rename(winner.path, join(staging, filename));
      sources.push({ src: `${settings.baseUrl ?? "./"}${(settings.baseUrl && !settings.baseUrl.endsWith("/")) ? "/" : ""}${filename}`,
        type, width: frames.geometry.codedWidth, height: frames.geometry.codedHeight,
        colorRect: frames.geometry.visibleColorRect, alphaRect: frames.geometry.visibleAlphaRect! });
    }
    const markup = alphaMarkup(sources, frames.width, frames.height);
    const result: AlphaCompileResult = { version: 1, output, width: frames.width, height: frames.height, fps: frames.fps,
      frames: frames.frames, sources, candidates, markup };
    const versions = await Promise.all([settings.ffmpeg, settings.ffprobe].map(async (tool) => new TextDecoder().decode((await mediaTool(settings, tool, ["-version"])).stdout).split("\n")[0]));
    const { signal: _signal, ...reportedSettings } = settings;
    await writeFile(join(staging, "build.json"), JSON.stringify({ ...result, input, settings: reportedSettings, tools: versions }, null, 2) + "\n");
    await writeFile(join(staging, "sources.json"), JSON.stringify({ version: 1, sources }, null, 2) + "\n");
    await writeFile(join(staging, "sources.js"), `export default ${JSON.stringify(sources)};\n`);
    await writeFile(join(staging, "sources.html"), markup + "\n");
    await rm(directory, { recursive: true });
    settings.signal?.throwIfAborted();
    // Reserve the absent name, then install the complete directory in one rename.
    // Windows rename already refuses an existing destination directory.
    if (process.platform === "win32") await rename(staging, output);
    else {
      await mkdir(output);
      const reservation = await requireDirectoryIdentity(output, "alpha output reservation");
      try {
        await assertDirectoryObject(output, reservation, "alpha output reservation");
        await rename(staging, output);
      } catch (error) {
        await removeOwnedEmptyDirectory(output, reservation, "alpha output reservation");
        throw error;
      }
    }
    return result;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export function alphaMarkup(sources: readonly AlphaSourceDescriptor[], width: number, height: number): string {
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return [`<aval-alpha autoplay loop style="width:${width}px;height:${height}px">`, ...sources.map((source) =>
    `  <source src="${escape(source.src)}" type="${escape(source.type)}" data-layout="${[source.width, source.height, ...source.colorRect, ...source.alphaRect].join(" ")}">`), "</aval-alpha>"].join("\n");
}

export async function readAlphaConfig(path: string): Promise<{ input: string; options: Omit<AlphaCompileOptions, "out"> }> {
  const { input, ...options } = JSON.parse(await readFile(path, "utf8")) as { input: unknown } & Omit<AlphaCompileOptions, "out">;
  if (typeof input !== "string") throw new CompilerError("INPUT_INVALID", "Alpha configuration needs an input path");
  return { input: resolve(dirname(path), input), options };
}
