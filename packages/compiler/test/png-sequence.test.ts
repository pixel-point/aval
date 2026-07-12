import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CompilerError } from "../src/diagnostics.js";
import { inspectPngSequence } from "../src/input/png-sequence.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function fixture(numbers: readonly number[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rma-png-sequence-"));
  directories.push(directory);
  await Promise.all(numbers.map((number) =>
    writeFile(join(directory, `frame-${String(number).padStart(4, "0")}.png`), "png")
  ));
  return directory;
}

describe("PNG sequence inspection", () => {
  it("returns one bounded contiguous deterministic plan", async () => {
    const directory = await fixture([3, 4, 5]);
    const plan = await inspectPngSequence(
      directory,
      "frame-%04d.png",
      3
    );
    expect(plan.frameCount).toBe(3);
    expect(plan.firstFileNumber).toBe(3);
    expect(plan.files.map((file) => file.split("/").at(-1))).toEqual([
      "frame-0003.png",
      "frame-0004.png",
      "frame-0005.png"
    ]);
    expect(Object.isFrozen(plan.files)).toBe(true);
  });

  it("rejects gaps, missing tokens, URL input, and missing first frames", async () => {
    const directory = await fixture([0, 2]);
    await expect(inspectPngSequence(directory, "frame-%04d.png"))
      .rejects.toBeInstanceOf(CompilerError);
    await expect(inspectPngSequence(directory, "frame.png"))
      .rejects.toBeInstanceOf(CompilerError);
    await expect(inspectPngSequence(directory, "https://example/frame-%04d.png"))
      .rejects.toBeInstanceOf(CompilerError);
    await expect(inspectPngSequence(directory, "frame-%04d.png", 3))
      .rejects.toBeInstanceOf(CompilerError);
  });

  it("honors cancellation before directory enumeration", async () => {
    const directory = await fixture([0]);
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(inspectPngSequence(
      directory,
      "frame-%04d.png",
      0,
      undefined,
      controller.signal
    )).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
