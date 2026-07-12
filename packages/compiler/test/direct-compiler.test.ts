import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseFrontIndex } from "@rendered-motion/format";

import { compileDirectInput } from "../src/compile/direct-compiler.js";
import { encodeCanonicalRgbaPng } from "../src/compile/png.js";
import {
  inspectAssetFile,
  validateAssetFile
} from "../src/commands/asset.js";

const HAS_FFMPEG = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!HAS_FFMPEG)("direct opaque compiler", () => {
  let directory = "";
  let pattern = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "rma-direct-compiler-"));
    pattern = join(directory, "loop-%04d.png");
    const values = [128, 199, 228, 199, 128, 57, 28, 57];
    await Promise.all(values.map(async (value, index) => {
      const rgba = new Uint8Array(32 * 32 * 4);
      for (let offset = 0; offset < rgba.length; offset += 4) {
        rgba.set([value, value, value, 255], offset);
      }
      await writeFile(
        join(directory, `loop-${String(index).padStart(4, "0")}.png`),
        encodeCanonicalRgbaPng({ width: 32, height: 32, rgba })
      );
    }));
  });

  afterAll(async () => {
    if (directory !== "") await rm(directory, { recursive: true, force: true });
  });

  it("compiles deterministic inspected AVC and verifies every digest", async () => {
    const firstPath = join(directory, "first.rma");
    const secondPath = join(directory, "second.rma");
    const options = {
      inputPath: pattern,
      outputPath: firstPath,
      loop: [0, 8] as const,
      fps: { numerator: 30, denominator: 1 },
      canvas: [32, 32] as const,
      frames: { firstNumber: 0, frameCount: 8 }
    };
    const first = await compileDirectInput(options);
    const second = await compileDirectInput({ ...options, outputPath: secondPath });
    expect(first.sha256).toBe(second.sha256);
    expect(await readFile(firstPath)).toEqual(await readFile(secondPath));
    expect(first.buildDetails.sources[0]).toMatchObject({
      type: "direct-png-sequence",
      inputFiles: expect.arrayContaining([
        expect.objectContaining({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) })
      ])
    });
    expect(first.buildDetails.invocations.map(({ operation }) => operation))
      .toEqual(expect.arrayContaining([
        "probe:direct",
        "alpha-audit:direct",
        "materialize-rgba:direct",
        "encode:opaque.1x:body.default"
      ]));
    expect(JSON.stringify(first.buildDetails.invocations)).not.toContain(directory);
    expect(first.buildDetails.continuity).toMatchObject([
      { kind: "loop", status: "pass" }
    ]);

    const bytes = new Uint8Array(await readFile(firstPath));
    const front = parseFrontIndex(bytes);
    expect(front.manifest.renditions[0]).toMatchObject({
      profile: "avc-annexb-opaque-v0",
      codec: "avc1.42E020"
    });
    expect(front.manifest.units).toHaveLength(1);
    expect(front.manifest.units[0]).toMatchObject({
      id: "body.default",
      frameCount: 8,
      playback: "loop"
    });
    await expect(validateAssetFile(firstPath)).resolves.toBeDefined();
    await expect(inspectAssetFile(firstPath)).resolves.toMatchObject({
      states: ["default"],
      units: [{ id: "body.default", frames: 8 }]
    });
  }, 30_000);
});
