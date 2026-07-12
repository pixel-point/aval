import {
  CompilerError,
  compileDirectInput,
  compileProjectFile,
  inspectAssetFile,
  parseCliArguments,
  runCli,
  startDevCommand,
  unpackAssetFile,
  validateAssetFile,
  validateAssetReport,
  type CliArguments,
  type CliRuntime,
  type CompileResult,
  type DevSession,
  type DirectCompileOptions,
  type ProjectCompileOptions
} from "../src/index.js";

const direct: (input: DirectCompileOptions) => Promise<Readonly<CompileResult>> =
  compileDirectInput;
const project: (input: ProjectCompileOptions) => Promise<Readonly<CompileResult>> =
  compileProjectFile;
const directTimeoutOptions: DirectCompileOptions = {
  inputPath: "input.mov",
  outputPath: "output.rma",
  loop: [0, 1],
  probeTimeoutMs: 1_000,
  mediaTimeoutMs: 5_000
};
const projectTimeoutOptions: ProjectCompileOptions = {
  projectPath: "project.json",
  outputPath: "output.rma",
  probeTimeoutMs: 1_000,
  mediaTimeoutMs: 5_000
};
const parsed: CliArguments = parseCliArguments(["inspect", "asset.rma"]);
const runtime: CliRuntime = {};
const cli: Promise<number> = runCli(["--help"], runtime);
const inspection = inspectAssetFile("asset.rma");
const controller = new AbortController();
const cancelledInspection = inspectAssetFile("asset.rma", controller.signal);
const validation = validateAssetFile("asset.rma");
const cancelledValidation = validateAssetFile("asset.rma", controller.signal);
const validationReport = validateAssetReport("asset.rma");
const cancelledValidationReport = validateAssetReport("asset.rma", controller.signal);
const unpack = unpackAssetFile("asset.rma", "output");
const cancelledUnpack = unpackAssetFile("asset.rma", "output", controller.signal);
const error: Error = new CompilerError("CLI_USAGE", "test");

void direct;
void project;
void directTimeoutOptions;
void projectTimeoutOptions;
void parsed;
void cli;
void inspection;
void cancelledInspection;
void validation;
void cancelledValidation;
void validationReport;
void cancelledValidationReport;
void unpack;
void cancelledUnpack;
void error;

// Verify the public session shape without starting a watcher.
const sessionFactory: typeof startDevCommand = startDevCommand;
type Session = Awaited<ReturnType<typeof sessionFactory>>;
const sessionAssignable = null as unknown as Session satisfies DevSession;
void sessionAssignable;
