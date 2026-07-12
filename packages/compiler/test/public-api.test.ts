import { describe, expect, it } from "vitest";

import * as api from "../src/index.js";

describe("compiler public API", () => {
  it("exposes the supported compile, CLI, validation, and dev boundaries", () => {
    expect(Object.keys(api).sort()).toEqual([
      "COMPILER_PROJECT_VERSION",
      "CompilerError",
      "DEFAULT_MEDIA_TIMEOUT_MS",
      "DEFAULT_PROBE_TIMEOUT_MS",
      "DEFAULT_PROCESS_TIMEOUT_MS",
      "HELP_TEXT",
      "MAX_PROCESS_OUTPUT_BYTES",
      "MAX_PROCESS_STDERR_BYTES",
      "MAX_SOURCE_DIMENSION",
      "MAX_SOURCE_DURATION_SECONDS",
      "MAX_SOURCE_FRAMES",
      "compileDirectInput",
      "compileProjectFile",
      "diagnosticFromError",
      "formatDiagnostic",
      "inspectAssetFile",
      "parseCliArguments",
      "runCli",
      "startDevCommand",
      "unpackAssetFile",
      "validateAssetFile",
      "validateAssetReport"
    ].sort());
  });
});
