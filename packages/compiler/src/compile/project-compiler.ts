import { dirname, join, resolve } from "node:path";

import {
  type VideoLayout
} from "@pixel-point/aval-format";

import { readBoundedRegularFile } from "../bounded-file.js";
import { publishCompileBundleDirectory } from "../commands/compile-bundle-publication.js";
import { CompilerError } from "../diagnostics.js";
import {
  discoverFfmpeg,
  verifyFfmpegProvenance
} from "../ffmpeg/discovery.js";
import { mediaTimeout } from "../ffmpeg/encode-unit.js";
import { probeTimeout } from "../ffmpeg/probe.js";
import type {
  CompileBundleArtifact,
  CompileBundleAssetArtifact,
  CompileBundleResult,
  CompileInvocationDetails,
  DirectArtifactOptions,
  DirectCompileOptions,
  NormalizedSourceProject,
  ProjectArtifactOptions,
  ProjectCompileOptions,
  ToolProvenance
} from "../model.js";
import { parseSourceProject } from "../source-project-schema.js";
import {
  mergeCanonicalAlphaAudits,
  resolveAlphaPolicy
} from "./alpha-policy.js";
import { buildCompileBundleReport } from "./compile-bundle-report.js";
import { lowerDirectInputToProject } from "./direct-project.js";
import { sha256Hex } from "./hash.js";
import { validateProjectMedia } from "./project-continuity.js";
import { compileProjectEncoding } from "./project-encoding-compiler.js";
import {
  cleanupProjectSources,
  prepareProjectSources
} from "./project-source.js";
import { toolchainInvocations } from "./toolchain-invocations.js";
import { compileVideoEncodingRenditions } from "./video-rendition-pipeline.js";

/** Compile and atomically publish one complete codec bundle directory. */
export async function compileProjectFile(
  options: ProjectCompileOptions
): Promise<Readonly<CompileBundleResult>> {
  const outputPath = resolve(options.outputPath);
  const artifact = await buildProjectBundleArtifact(options);
  await publishCompileBundleDirectory(
    outputPath,
    publicationInput(artifact),
    {
      ...(options.force === undefined ? {} : { force: options.force }),
      ...(options.signal === undefined ? {} : { signal: options.signal })
    }
  );
  return bundleResult(outputPath, artifact);
}

/** Compile direct media by lowering it into the sole project bundle pipeline. */
export async function compileDirectInput(
  options: DirectCompileOptions
): Promise<Readonly<CompileBundleResult>> {
  const outputPath = resolve(options.outputPath);
  const artifact = await buildDirectBundleArtifact(options);
  await publishCompileBundleDirectory(
    outputPath,
    publicationInput(artifact),
    {
      ...(options.force === undefined ? {} : { force: options.force }),
      ...(options.signal === undefined ? {} : { signal: options.signal })
    }
  );
  return bundleResult(outputPath, artifact);
}

/** Build direct media through the canonical one-source project compiler. */
export async function buildDirectBundleArtifact(
  options: DirectArtifactOptions
): Promise<Readonly<CompileBundleArtifact>> {
  const lowered = await lowerDirectInputToProject(options);
  return buildNormalizedProjectBundleArtifact({
    project: lowered.project,
    sourceRoot: lowered.sourceRoot,
    provenance: lowered.provenance,
    invocations: lowered.invocations,
    warnings: lowered.warnings,
    ...(options.probeTimeoutMs === undefined
      ? {}
      : { probeTimeoutMs: options.probeTimeoutMs }),
    ...(options.mediaTimeoutMs === undefined
      ? {}
      : { mediaTimeoutMs: options.mediaTimeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
}

/** Build every requested codec variant while owning canonical sources once. */
export async function buildProjectBundleArtifact(
  options: ProjectArtifactOptions
): Promise<Readonly<CompileBundleArtifact>> {
  probeTimeout(options.probeTimeoutMs);
  mediaTimeout(options.mediaTimeoutMs);
  const projectPath = resolve(options.projectPath);
  const projectFile = await readProject(projectPath, options.signal);
  return buildNormalizedProjectBundleArtifact({
    project: projectFile.project,
    sourceRoot: dirname(projectPath),
    ...(options.ffmpegPath === undefined
      ? {}
      : { ffmpegPath: options.ffmpegPath }),
    ...(options.ffprobePath === undefined
      ? {}
      : { ffprobePath: options.ffprobePath }),
    ...(options.probeTimeoutMs === undefined
      ? {}
      : { probeTimeoutMs: options.probeTimeoutMs }),
    ...(options.mediaTimeoutMs === undefined
      ? {}
      : { mediaTimeoutMs: options.mediaTimeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
}

export interface NormalizedProjectBundleArtifactOptions {
  readonly project: Readonly<NormalizedSourceProject>;
  readonly sourceRoot: string;
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly probeTimeoutMs?: number;
  readonly mediaTimeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Reuse a discovery snapshot when the caller needed FFprobe for lowering. */
  readonly provenance?: Readonly<ToolProvenance>;
  /** Path-free invocations performed while lowering an in-memory project. */
  readonly invocations?: readonly Readonly<CompileInvocationDetails>[];
  readonly warnings?: readonly string[];
}

/** Build an already-normalized project through the sole codec bundle pipeline. */
export async function buildNormalizedProjectBundleArtifact(
  options: Readonly<NormalizedProjectBundleArtifactOptions>
): Promise<Readonly<CompileBundleArtifact>> {
  probeTimeout(options.probeTimeoutMs);
  mediaTimeout(options.mediaTimeoutMs);
  const project = options.project;
  const provenance = options.provenance ?? await discoverFfmpeg(
    options.ffmpegPath,
    options.signal,
    options.ffprobePath,
    project.encodings.map(({ codec }) => codec)
  );
  const sources = await prepareProjectSources({
    root: resolve(options.sourceRoot),
    sources: project.sources,
    canvas: project.canvas,
    frameRate: project.frameRate,
    sourceFrameReferences: collectSourceFrameReferences(project),
    ffmpeg: provenance.executable,
    ffprobe: provenance.ffprobeExecutable,
    ...(options.probeTimeoutMs === undefined
      ? {}
      : { probeTimeoutMs: options.probeTimeoutMs }),
    ...(options.mediaTimeoutMs === undefined
      ? {}
      : { mediaTimeoutMs: options.mediaTimeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  try {
    const alphaPolicy = resolveAlphaPolicy(
      project.alpha,
      mergeCanonicalAlphaAudits(
        [...sources.values()].map(({ alphaAudit }) => alphaAudit)
      )
    );
    const layout: VideoLayout = alphaPolicy.selected === "packed"
      ? "packed-alpha"
      : "opaque";
    const continuity = await validateProjectMedia({
      project,
      sources,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    });
    const assets: CompileBundleAssetArtifact[] = [];
    const allInvocations: CompileInvocationDetails[] = [
      ...toolchainInvocations("discover"),
      ...(options.invocations ?? []),
      ...[...sources.values()].flatMap(({ invocations }) => invocations)
    ];
    for (const encoding of project.encodings) {
      const compiled = await compileVideoEncodingRenditions({
        project,
        encoding,
        layout,
        sources,
        executable: provenance.executable,
        ...(options.mediaTimeoutMs === undefined
          ? {}
          : { timeoutMs: options.mediaTimeoutMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal })
      });
      allInvocations.push(...compiled.invocations);
      const assembled = compileProjectEncoding({
        project,
        encoding,
        layout,
        renditions: compiled.renditions
      });
      assets.push(Object.freeze({
        codec: encoding.codec,
        filename: `${encoding.codec}.avl`,
        assetBytes: assembled.assetBytes,
        bytes: assembled.bytes,
        sha256: assembled.sha256,
        manifest: assembled.manifest,
        invocations: compiled.invocations
      }));
    }
    await verifyFfmpegProvenance(provenance, options.signal);
    allInvocations.push(...toolchainInvocations("verify"));
    const warnings = Object.freeze([...new Set([
      ...(options.warnings ?? []),
      ...alphaPolicy.warnings,
      ...continuity.warnings,
      ...[...sources.values()].flatMap(({ warnings }) => warnings)
    ])]);
    const builtReport = buildCompileBundleReport({
      assets: assets.map((asset) => {
        const rendition = asset.manifest.renditions[0];
        if (rendition === undefined) {
          throw new CompilerError("ASSET_INVALID", `${asset.codec} asset has no rendition`);
        }
        return Object.freeze({
          codec: asset.codec,
          bytes: asset.bytes,
          sha256: asset.sha256,
          codecString: rendition.codec
        });
      }),
      encodings: project.encodings,
      invocations: allInvocations,
      provenance,
      warnings
    });
    return Object.freeze({
      assets: Object.freeze(assets),
      buildReport: builtReport.report,
      buildReportBytes: builtReport.bytes,
      provenance,
      warnings
    });
  } finally {
    await cleanupProjectSources(sources);
  }
}

function collectSourceFrameReferences(
  project: Readonly<NormalizedSourceProject>
): ReadonlyMap<string, readonly number[]> {
  const references = new Map<string, Set<number>>(
    project.sources.map(({ id }) => [id, new Set<number>()])
  );
  for (const unit of project.units) {
    const frames = references.get(unit.source);
    if (frames === undefined) {
      throw new CompilerError("INPUT_INVALID", `Unit ${unit.id} references an unknown source`);
    }
    for (let frame = unit.range[0]; frame < unit.range[1]; frame += 1) {
      frames.add(frame);
    }
  }
  return new Map([...references].map(([source, frames]) => [
    source,
    Object.freeze([...frames].sort((left, right) => left - right))
  ]));
}

function publicationInput(artifact: Readonly<CompileBundleArtifact>) {
  return Object.freeze({
    assets: Object.freeze(artifact.assets.map(({ codec, assetBytes }) =>
      Object.freeze({ codec, bytes: assetBytes })
    )),
    buildReportBytes: artifact.buildReportBytes
  });
}

function bundleResult(
  outputPath: string,
  artifact: Readonly<CompileBundleArtifact>
): Readonly<CompileBundleResult> {
  return Object.freeze({
    outputPath,
    reportPath: join(outputPath, "build.json"),
    assets: Object.freeze(artifact.buildReport.assets.map((asset) =>
      Object.freeze({ ...asset, path: join(outputPath, asset.path) })
    )),
    provenance: artifact.provenance,
    warnings: artifact.warnings,
    sourceMarkup: artifact.buildReport.sourceMarkup
  });
}

async function readProject(
  path: string,
  signal?: AbortSignal
): Promise<Readonly<{
  readonly project: NormalizedSourceProject;
  readonly bytes: number;
  readonly sha256: string;
}>> {
  const bytes = await readBoundedRegularFile({
    path,
    maxBytes: 1024 * 1024,
    label: "project JSON",
    limitCode: "SOURCE_LIMIT",
    ...(signal === undefined ? {} : { signal })
  });
  return Object.freeze({
    project: parseSourceProject(bytes),
    bytes: bytes.byteLength,
    sha256: sha256Hex(bytes)
  });
}
