import { platform, arch } from "node:os";
import { basename, join } from "node:path";

import {
  serializeCanonicalJsonWithLimits,
  type CanonicalJsonValue
} from "@rendered-motion/format";

import { boundedUtf8Text } from "../bounded-text.js";
import type { CompileCliArguments } from "../cli-args.js";
import { sha256Hex } from "../compile/hash.js";
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
  type PublicationWorkspace,
  type StagedPublicationFile
} from "../compile/output.js";
import { CompilerError } from "../diagnostics.js";
import type { RegularFileIdentity } from "../file-fingerprint.js";
import { COMPILER_PROJECT_VERSION } from "../model.js";
import type { CompileArtifact } from "../model.js";

export interface PreparedCompilePublication {
  publishArtifact(
    artifact: Readonly<CompileArtifact>,
    invocation: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ): Promise<void>;
}

interface PublicationEntry {
  readonly path: string;
  readonly label: "asset" | "build report";
  readonly expected: Readonly<PublicationTargetSnapshot>;
  readonly workspace: Readonly<PublicationWorkspace>;
  readonly stageName: string;
  staged: Readonly<StagedPublicationFile> | undefined;
  backupPath: string | undefined;
  backupIdentity: RegularFileIdentity | undefined;
  installedIdentity: RegularFileIdentity | undefined;
}

/** Capture the exact output identities that a later publication may replace. */
export async function prepareCompilePublication(
  outputPath: string,
  reportPath: string,
  force: boolean
): Promise<PreparedCompilePublication> {
  const output = await inspectPublishable(outputPath, force, "asset");
  const report = await inspectPublishable(reportPath, force, "build report");
  return Object.freeze({
    publishArtifact: async (
      artifact: Readonly<CompileArtifact>,
      invocation: Readonly<Record<string, unknown>>,
      signal?: AbortSignal
    ): Promise<void> => {
      await publishPair({
        outputPath,
        reportPath,
        output,
        report,
        force,
        artifact,
        invocation,
        ...(signal === undefined ? {} : { signal })
      });
    }
  });
}

export function buildReportInvocation(
  arguments_: CompileCliArguments,
  inputPath: string,
  outputPath: string
): Readonly<Record<string, unknown>> {
  const project = inputPath.toLowerCase().endsWith(".json");
  return Object.freeze({
    mode: project
      ? "project"
      : inputPath.includes("%")
        ? "direct-png-sequence"
        : "direct-video",
    inputPath: reportText(inputPath),
    outputPath: reportText(outputPath),
    options: Object.freeze({
      ...(arguments_.loop === undefined ? {} : { loop: arguments_.loop }),
      ...(arguments_.fps === undefined ? {} : { frameRate: arguments_.fps }),
      ...(arguments_.canvas === undefined ? {} : { canvas: arguments_.canvas }),
      ...(arguments_.bitrate === undefined ? {} : { bitrate: arguments_.bitrate }),
      ...(arguments_.frames === undefined ? {} : { frames: arguments_.frames }),
      normalizeVfr:
        arguments_.normalizeVfr ||
        (arguments_.fps !== undefined && !project && !inputPath.includes("%"))
    })
  });
}

async function publishPair(input: {
  readonly outputPath: string;
  readonly reportPath: string;
  readonly output: Readonly<PublicationTargetSnapshot>;
  readonly report: Readonly<PublicationTargetSnapshot>;
  readonly force: boolean;
  readonly artifact: Readonly<CompileArtifact>;
  readonly invocation: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const reportBytes = buildReportBytes(
    input.reportPath,
    input.outputPath,
    input.artifact,
    input.invocation
  );
  const assetWorkspace = await createPublicationWorkspace(input.outputPath);
  let reportWorkspace: Readonly<PublicationWorkspace> | undefined;
  const entries: PublicationEntry[] = [];
  let committed = false;
  try {
    throwIfAborted(input.signal);
    reportWorkspace = await createPublicationWorkspace(input.reportPath);
    const asset: PublicationEntry = {
      path: input.outputPath,
      label: "asset",
      expected: input.output,
      workspace: assetWorkspace,
      stageName: "asset.rma",
      staged: undefined,
      backupPath: undefined,
      backupIdentity: undefined,
      installedIdentity: undefined
    };
    const report: PublicationEntry = {
      path: input.reportPath,
      label: "build report",
      expected: input.report,
      workspace: reportWorkspace,
      stageName: "report.json",
      staged: undefined,
      backupPath: undefined,
      backupIdentity: undefined,
      installedIdentity: undefined
    };
    entries.push(asset, report);
    asset.staged = await stagePublicationFile(
      asset.workspace,
      asset.stageName,
      input.artifact.assetBytes
    );
    report.staged = await stagePublicationFile(
      report.workspace,
      report.stageName,
      reportBytes
    );
    throwIfAborted(input.signal);

    for (const entry of entries) {
      await assertPublicationTargetUnchanged(
        entry.path,
        entry.expected,
        entry.label
      );
    }
    if (input.force) {
      for (const entry of entries) {
        if (!entry.expected.exists) continue;
        entry.backupPath = join(
          entry.workspace.directory,
          `${basename(entry.path)}.previous`
        );
        entry.backupIdentity = await backupPublicationTarget(
          entry.path,
          entry.expected,
          entry.backupPath,
          entry.label
        );
      }
      await syncParents(entries);
      throwIfAborted(input.signal);
    }

    // The report commits first. Until the asset link succeeds it is harmless,
    // and a failed asset commit removes only this transaction's report inode.
    for (const entry of [report, asset]) {
      throwIfAborted(input.signal);
      if (entry.staged === undefined) {
        throw new CompilerError("IO_FAILED", "Publication stage was lost", {
          path: entry.path
        });
      }
      entry.installedIdentity = await installStagedFile(
        entry.path,
        entry.staged,
        entry.label
      );
      entry.staged = undefined;
    }
    throwIfAborted(input.signal);
    await syncParents(entries);
    throwIfAborted(input.signal);
    committed = true;

    for (const entry of entries) {
      if (entry.backupPath !== undefined && entry.backupIdentity !== undefined) {
        await unlinkIfIdentity(entry.backupPath, entry.backupIdentity);
        entry.backupPath = undefined;
        entry.backupIdentity = undefined;
      }
    }
    await syncParents(entries);
  } catch (error) {
    if (!committed) {
      const rollbackFailures = await rollbackEntries(entries);
      if (rollbackFailures.length > 0) {
        throw new CompilerError(
          "IO_FAILED",
          "Publication failed and the previous output pair could not be restored",
          {
            path: input.outputPath,
            cause: new AggregateError([error, ...rollbackFailures])
          }
        );
      }
    }
    if (error instanceof CompilerError) throw error;
    throw new CompilerError("IO_FAILED", "Could not publish compile outputs", {
      path: input.outputPath,
      cause: error
    });
  } finally {
    await cleanupEntries(entries);
    if (reportWorkspace !== undefined) {
      await closePublicationWorkspace(reportWorkspace).catch(() => undefined);
    }
    await closePublicationWorkspace(assetWorkspace).catch(() => undefined);
  }
}

async function rollbackEntries(entries: readonly PublicationEntry[]): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const entry of [...entries].reverse()) {
    try {
      if (entry.installedIdentity !== undefined) {
        await unlinkIfIdentity(entry.path, entry.installedIdentity);
        entry.installedIdentity = undefined;
      }
    } catch (error) {
      failures.push(error);
    }
  }
  for (const entry of entries) {
    if (entry.backupPath === undefined || entry.backupIdentity === undefined) continue;
    try {
      await restorePublicationBackup(
        entry.path,
        entry.backupPath,
        entry.backupIdentity,
        entry.label
      );
      entry.backupPath = undefined;
      entry.backupIdentity = undefined;
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await syncParents(entries);
  } catch (error) {
    failures.push(error);
  }
  return failures;
}

async function cleanupEntries(entries: readonly PublicationEntry[]): Promise<void> {
  for (const entry of entries) {
    if (entry.staged !== undefined) {
      await unlinkIfIdentity(entry.staged.path, entry.staged.identity).catch(() => false);
      entry.staged = undefined;
    }
    // A backup is user data. If restoration could not prove it was safe, leave
    // it in the private workspace instead of recursively deleting anything.
  }
}

async function syncParents(entries: readonly PublicationEntry[]): Promise<void> {
  const parents = new Set(entries.map(({ workspace }) => workspace.parent));
  for (const parent of [...parents].sort()) await syncDirectory(parent);
}

async function inspectPublishable(
  path: string,
  force: boolean,
  label: "asset" | "build report"
): Promise<Readonly<PublicationTargetSnapshot>> {
  const snapshot = await inspectPublicationTarget(path, label);
  if (snapshot.exists && !force) {
    throw new CompilerError("IO_FAILED", `${label} path already exists`, {
      path,
      hint: "Pass --force only when replacing this exact local output is intended."
    });
  }
  return snapshot;
}

function buildReportBytes(
  reportPath: string,
  outputPath: string,
  artifact: Readonly<CompileArtifact>,
  invocation: Readonly<Record<string, unknown>>
): Uint8Array {
  try {
    return serializeCanonicalJsonWithLimits(canonicalReportValue({
      reportVersion: "0.1",
      compiler: {
        package: "@rendered-motion/compiler",
        packageVersion: "0.0.0",
        projectVersion: COMPILER_PROJECT_VERSION,
        nodeMajor: Number(process.versions.node.split(".")[0]),
        platform: platform(),
        architecture: arch()
      },
      invocation,
      asset: {
        bytes: artifact.bytes,
        path: reportText(outputPath),
        sha256: artifact.sha256
      },
      toolchain: {
        ffmpeg: {
          executable: reportText(artifact.provenance.executable),
          executableSha256: artifact.provenance.executableSha256,
          executableIdentity: artifact.provenance.executableIdentity,
          version: artifact.provenance.versionLine,
          versionOutputSha256: artifact.provenance.versionOutputSha256,
          configuration: artifact.provenance.configurationLine,
          configurationSha256: sha256Hex(
            new TextEncoder().encode(artifact.provenance.configurationLine)
          ),
          libx264Enabled: true,
          encodersOutputSha256: artifact.provenance.encodersOutputSha256,
          calibrationSha256: artifact.provenance.calibrationSha256
        },
        ffprobe: {
          executable: reportText(artifact.provenance.ffprobeExecutable),
          executableSha256: artifact.provenance.ffprobeExecutableSha256,
          executableIdentity: artifact.provenance.ffprobeExecutableIdentity,
          version: artifact.provenance.ffprobeVersionLine,
          versionOutputSha256: artifact.provenance.ffprobeVersionOutputSha256
        },
        aggregateMemoryLimit: artifact.provenance.aggregateMemoryLimit
      },
      buildDetails: artifact.buildDetails,
      warnings: artifact.warnings.map(reportText)
    }), {
      maxBytes: 32 * 1024 * 1024,
      maxDepth: 128,
      maxNodes: 1_000_000,
      maxStringBytes: 32 * 1024 * 1024
    });
  } catch (error) {
    throw new CompilerError("OUTPUT_LIMIT", "Could not serialize build report", {
      path: reportPath,
      cause: error
    });
  }
}

/** Normalize report-only floating metrics and omit absent optional fields. */
function canonicalReportValue(value: unknown): CanonicalJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CompilerError("ASSET_INVALID", "Build report number is not finite");
    }
    if (Number.isSafeInteger(value)) return value;
    return value.toFixed(9).replace(
      /(?:\.0+|(?<fraction>\.\d+?)0+)$/u,
      "$<fraction>"
    );
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map(canonicalReportValue));
  }
  if (typeof value === "object") {
    const result: Record<string, CanonicalJsonValue> = Object.create(null);
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) result[key] = canonicalReportValue(child);
    }
    return Object.freeze(result);
  }
  throw new CompilerError("ASSET_INVALID", "Build report contains unsupported data");
}

function reportText(value: string): string {
  return boundedUtf8Text(value, 4_096);
}
