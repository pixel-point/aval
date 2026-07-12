import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileDirectInput } from "../src/compile/direct-compiler.js";
import { compileProjectFile } from "../src/compile/project-compiler.js";
import { encodeAvcUnit } from "../src/ffmpeg/encode-unit.js";
import { probeMedia } from "../src/ffmpeg/probe.js";
import {
  DEFAULT_MEDIA_TIMEOUT_MS,
  DEFAULT_PROBE_TIMEOUT_MS
} from "../src/model.js";

describe("lowerable operation timeouts", () => {
  let directory = "";
  let hangingTool = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "rma-timeout-tool-"));
    hangingTool = join(directory, "hang");
    await writeFile(
      hangingTool,
      "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n",
      { mode: 0o700 }
    );
    await chmod(hangingTool, 0o700);
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("lowers the 15-second probe default", async () => {
    await expect(probeMedia(
      "/input/clip.mov",
      hangingTool,
      undefined,
      20
    )).rejects.toMatchObject({ code: "PROCESS_TIMEOUT" });
  });

  it("lowers the 120-second media default", async () => {
    await expect(encodeAvcUnit({
      source: { type: "video", path: "/input/clip.mov" },
      startFrame: 0,
      endFrame: 1,
      frameRate: { numerator: 30, denominator: 1 },
      codedWidth: 32,
      codedHeight: 32,
      bitrate: { average: 100_000, peak: 200_000 },
      executable: hangingTool,
      timeoutMs: 20
    })).rejects.toMatchObject({ code: "PROCESS_TIMEOUT" });
  });

  it("threads lower-only timeout options through both public compiler entries", async () => {
    await expect(compileDirectInput({
      inputPath: "/input/never-opened.mov",
      outputPath: "/output/never-written.rma",
      loop: [0, 1],
      probeTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS + 1,
      mediaTimeoutMs: 20
    })).rejects.toMatchObject({
      code: "INPUT_INVALID",
      message: expect.stringContaining("Probe timeout")
    });

    await expect(compileProjectFile({
      projectPath: "/input/never-opened.json",
      outputPath: "/output/never-written.rma",
      probeTimeoutMs: 20,
      mediaTimeoutMs: DEFAULT_MEDIA_TIMEOUT_MS + 1
    })).rejects.toMatchObject({
      code: "INPUT_INVALID",
      message: expect.stringContaining("Media timeout")
    });
  });
});
