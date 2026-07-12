import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwd, execPath } from "node:process";
import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { CompilerError } from "../src/diagnostics.js";
import {
  createProcessEnvironment,
  runBoundedProcess
} from "../src/process-runner.js";

const LIMITS = {
  timeoutMs: 2_000,
  maxStdoutBytes: 1_024,
  maxStderrBytes: 1_024
} as const;

describe("bounded process runner", () => {
  it("owns the exact proxy-free private child environment", () => {
    const environment = Object.fromEntries(Object.entries(
      createProcessEnvironment("/private/rma-operation")
    ).filter((entry): entry is [string, string] => entry[1] !== undefined).map(
      ([key, value]) => [
        key,
        key === "PATH" || key === "SYSTEMROOT" ? `<${key}>` : value
      ]
    ));
    expect(environment).toEqual({
      PATH: "<PATH>",
      ...(process.platform === "win32" ? { SYSTEMROOT: "<SYSTEMROOT>" } : {}),
      LC_ALL: "C",
      LANG: "C",
      HOME: "/private/rma-operation",
      TMPDIR: "/private/rma-operation",
      TMP: "/private/rma-operation",
      TEMP: "/private/rma-operation"
    });
  });

  it("captures bounded stdout/stderr without a shell", async () => {
    const result = await runBoundedProcess({
      executable: execPath,
      arguments: [
        "-e",
        "process.stdout.write('out'); process.stderr.write('err')"
      ],
      cwd: cwd(),
      limits: LIMITS
    });
    expect(new TextDecoder().decode(result.stdout)).toBe("out");
    expect(result.stderr).toBe("err");
    expect(result.exitCode).toBe(0);
  });

  it("kills output overflow before retaining excess bytes", async () => {
    await expect(runBoundedProcess({
      executable: execPath,
      arguments: ["-e", "process.stdout.write('x'.repeat(2048))"],
      cwd: cwd(),
      limits: { ...LIMITS, maxStdoutBytes: 16 }
    })).rejects.toMatchObject({ code: "OUTPUT_LIMIT" } satisfies Partial<CompilerError>);
  });

  it("supports timeouts, cancellation, missing tools, and nonzero exits", async () => {
    await expect(runBoundedProcess({
      executable: execPath,
      arguments: ["-e", "setInterval(() => {}, 1000)"],
      cwd: cwd(),
      limits: { ...LIMITS, timeoutMs: 20 }
    })).rejects.toMatchObject({ code: "PROCESS_TIMEOUT" } satisfies Partial<CompilerError>);

    const controller = new AbortController();
    controller.abort("test");
    await expect(runBoundedProcess({
      executable: execPath,
      arguments: ["-e", "process.exit(0)"],
      cwd: cwd(),
      limits: LIMITS,
      signal: controller.signal
    })).rejects.toMatchObject({ code: "CANCELLED" } satisfies Partial<CompilerError>);

    await expect(runBoundedProcess({
      executable: "definitely-not-a-real-rma-tool",
      arguments: [],
      cwd: cwd(),
      limits: LIMITS
    })).rejects.toMatchObject({ code: "FFMPEG_NOT_FOUND" } satisfies Partial<CompilerError>);

    await expect(runBoundedProcess({
      executable: execPath,
      arguments: ["-e", "process.exit(7)"],
      cwd: cwd(),
      limits: LIMITS
    })).rejects.toMatchObject({ code: "FFMPEG_FAILED" } satisfies Partial<CompilerError>);
  });

  it("never exposes hostile media-tool stderr or executable paths", async () => {
    const secretPath = "/private/project/source.mov";
    const hostile = `\u001b[31m${secretPath}<script>SECRET_TOKEN\u0007`;
    let error: unknown;
    try {
      await runBoundedProcess({
        executable: execPath,
        arguments: [
          "-e",
          `process.stderr.write(${JSON.stringify(hostile)}); process.exit(7)`
        ],
        cwd: cwd(),
        limits: LIMITS
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: "FFMPEG_FAILED",
      message: "Media tool exited with 7",
      hint: "Verify the source media and recorded toolchain compatibility."
    });
    const publicText = JSON.stringify(error);
    for (const forbidden of [
      secretPath,
      "SECRET_TOKEN",
      "<script>",
      "\u001b",
      "\u0007",
      execPath
    ]) {
      expect(publicText).not.toContain(forbidden);
    }
  });

  it("terminates descendants that retain the process pipes", async () => {
    const started = Date.now();
    await expect(runBoundedProcess({
      executable: execPath,
      arguments: [
        "-e",
        [
          "const {spawn}=require('node:child_process')",
          "spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']})",
          "setInterval(()=>{},1000)"
        ].join(";")
      ],
      cwd: cwd(),
      limits: { ...LIMITS, timeoutMs: 20 }
    })).rejects.toMatchObject({ code: "PROCESS_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("rejects an early stdin close without an unhandled EPIPE", async () => {
    await expect(runBoundedProcess({
      executable: execPath,
      arguments: ["-e", "process.exit(0)"],
      cwd: cwd(),
      limits: LIMITS,
      stdin: new Uint8Array(8 * 1024 * 1024)
    })).rejects.toMatchObject({ code: "FFMPEG_FAILED" });
  });

  it("enforces exact streamed stdout for short and extra output", async () => {
    const sink = (): Writable => new Writable({
      write(_chunk, _encoding, callback): void {
        callback();
      }
    });
    await expect(runBoundedProcess({
      executable: execPath,
      arguments: ["-e", "process.stdout.write('ab')"],
      cwd: cwd(),
      limits: LIMITS,
      stdoutSink: sink(),
      expectedStdoutBytes: 3
    })).rejects.toMatchObject({
      code: "FFMPEG_FAILED",
      message: expect.stringContaining("2 bytes")
    });
    await expect(runBoundedProcess({
      executable: execPath,
      arguments: ["-e", "process.stdout.write('abcd')"],
      cwd: cwd(),
      limits: LIMITS,
      stdoutSink: sink(),
      expectedStdoutBytes: 3
    })).rejects.toMatchObject({
      code: "FFMPEG_FAILED",
      message: expect.stringContaining("extra stdout")
    });
  });

  it("propagates streamed sink errors and detects an early sink close", async () => {
    const failingSink = new Writable({
      write(_chunk, _encoding, callback): void {
        callback(new Error("disk full"));
      }
    });
    await expect(runBoundedProcess({
      executable: execPath,
      arguments: ["-e", "process.stdout.write('payload')"],
      cwd: cwd(),
      limits: LIMITS,
      stdoutSink: failingSink
    })).rejects.toMatchObject({ code: "IO_FAILED" });

    const closingSink = new Writable({
      write(_chunk, _encoding, callback): void {
        callback();
        this.destroy();
      }
    });
    await expect(runBoundedProcess({
      executable: execPath,
      arguments: [
        "-e",
        "process.stdout.write('a'); setTimeout(() => process.stdout.write('b'), 50)"
      ],
      cwd: cwd(),
      limits: LIMITS,
      stdoutSink: closingSink
    })).rejects.toMatchObject({
      code: "IO_FAILED",
      message: expect.stringContaining("closed before stdout ended")
    });
  });

  it("cancels an active process and removes its private working directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "rma-runner-cancel-"));
    const controller = new AbortController();
    const operation = runBoundedProcess({
      executable: execPath,
      arguments: ["-e", "setInterval(() => {}, 1000)"],
      cwd: cwd(),
      limits: LIMITS,
      privateWorkingDirectory: { root, prefix: "operation-" },
      signal: controller.signal
    });
    setTimeout(() => controller.abort("test cancellation"), 20);
    await expect(operation).rejects.toMatchObject({ code: "CANCELLED" });
    expect(await readdir(root)).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  it("removes its private working directory after process failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "rma-runner-failure-"));
    try {
      await expect(runBoundedProcess({
        executable: execPath,
        arguments: ["-e", "process.exit(7)"],
        cwd: cwd(),
        limits: LIMITS,
        privateWorkingDirectory: { root, prefix: "operation-" }
      })).rejects.toMatchObject({ code: "FFMPEG_FAILED" });
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses a mode-0700 proxy-free environment and cleans it after success", async () => {
    const root = await mkdtemp(join(tmpdir(), "rma-runner-private-"));
    try {
      const result = await runBoundedProcess({
        executable: execPath,
        arguments: [
          "-e",
          [
            "const fs=require('node:fs')",
            "const out={cwd:process.cwd(),mode:fs.statSync('.').mode&0o777,env:process.env}",
            "process.stdout.write(JSON.stringify(out))"
          ].join(";")
        ],
        cwd: cwd(),
        limits: { ...LIMITS, maxStdoutBytes: 8 * 1024 },
        privateWorkingDirectory: { root, prefix: "operation-" }
      });
      const output = JSON.parse(new TextDecoder().decode(result.stdout)) as {
        readonly cwd: string;
        readonly mode: number;
        readonly env: Readonly<Record<string, string>>;
      };
      expect(output.mode).toBe(0o700);
      const canonicalPath = (value: string): string =>
        value.replace(/^\/private(?=\/var\/)/u, "");
      expect(output.env).toMatchObject({
        LC_ALL: "C",
        LANG: "C"
      });
      expect(canonicalPath(output.env.HOME!)).toBe(canonicalPath(output.cwd));
      expect(canonicalPath(output.env.TMPDIR!)).toBe(canonicalPath(output.cwd));
      expect(canonicalPath(output.env.TMP!)).toBe(canonicalPath(output.cwd));
      expect(canonicalPath(output.env.TEMP!)).toBe(canonicalPath(output.cwd));
      expect(Object.keys(output.env).filter(
        (key) => key !== "__CF_USER_TEXT_ENCODING"
      ).sort()).toEqual([
        "HOME", "LANG", "LC_ALL", "PATH", "TEMP", "TMP", "TMPDIR"
      ]);
      expect(Object.keys(output.env).filter((key) => /proxy/iu.test(key))).toEqual([]);
      await expect(stat(output.cwd)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
