import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { encodeCanonicalRgbaPng } from "../src/compile/png.js";

export const FRAME_RATE = Object.freeze({ numerator: 30, denominator: 1 });
const WIDTH = 32;
const HEIGHT = 32;

/** This matrix uses only deterministic procedural pixels; it has no third-party media. */
export function hasRequiredToolchain(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    const encoders = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return /\blibx264\b/u.test(encoders);
  } catch {
    return false;
  }
}

export async function writeGrayFrames(
  directory: string,
  values: readonly number[]
): Promise<void> {
  await mkdir(directory);
  await Promise.all(values.map(async (value, index) => {
    const rgba = new Uint8Array(WIDTH * HEIGHT * 4);
    for (let offset = 0; offset < rgba.length; offset += 4) {
      rgba.set([value, value, value, 255], offset);
    }
    await writeFile(
      join(directory, `frame-${String(index).padStart(4, "0")}.png`),
      encodeCanonicalRgbaPng({ width: WIDTH, height: HEIGHT, rgba })
    );
  }));
}

export function encodePngVideo(
  executable: string,
  framesDirectory: string,
  frameCount: number,
  output: string,
  variable: boolean
): void {
  execFileSync(executable, [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-framerate", "30", "-start_number", "0",
    "-i", join(framesDirectory, "frame-%04d.png"),
    "-frames:v", String(frameCount), "-an", "-sn", "-dn",
    "-vf", variable
      ? "setpts=(N+floor(N/2))/(30*TB),setsar=1,format=yuv420p"
      : "setsar=1,format=yuv420p",
    "-c:v", "libx264", "-preset", "medium", "-qp", "0",
    "-pix_fmt", "yuv420p", "-threads", "1",
    "-fps_mode", variable ? "vfr" : "cfr",
    "-video_track_timescale", "30000",
    "-movflags", "+faststart", output
  ], { stdio: ["ignore", "ignore", "pipe"] });
}

export function matrixProject(): unknown {
  const port = [{ id: "default", entryFrame: 0, portalFrames: [0] }];
  return {
    projectVersion: "0.1",
    profile: "avc-annexb-opaque-v0",
    canvas: {
      width: WIDTH,
      height: HEIGHT,
      fit: "contain",
      pixelAspect: [1, 1],
      colorSpace: "srgb"
    },
    frameRate: FRAME_RATE,
    sources: [{
      id: "frames",
      type: "png-sequence",
      directory: "project-frames",
      prefix: "frame-",
      digits: 4,
      suffix: ".png",
      firstNumber: 0,
      frameCount: 26
    }],
    renditions: [{
      id: "opaque",
      codedWidth: WIDTH,
      codedHeight: HEIGHT,
      bitrate: { average: 300_000, peak: 600_000 }
    }],
    units: [
      {
        id: "idle-body", kind: "body", source: "frames", range: [0, 1],
        playback: "finite", ports: port
      },
      {
        id: "state-change", kind: "reversible", source: "frames", range: [1, 7],
        residency: {
          endpoints: [
            { state: "idle", port: "default", frames: 6 },
            { state: "hover", port: "default", frames: 6 }
          ]
        }
      },
      {
        id: "hover-body", kind: "body", source: "frames", range: [7, 8],
        playback: "finite", ports: port
      },
      {
        id: "done-body", kind: "body", source: "frames", range: [8, 14],
        playback: "finite",
        ports: [{ id: "default", entryFrame: 0, portalFrames: [0, 5] }]
      },
      {
        id: "reset-bridge", kind: "bridge", source: "frames", range: [14, 26]
      }
    ],
    initialState: "idle",
    states: [
      { id: "idle", bodyUnit: "idle-body" },
      { id: "hover", bodyUnit: "hover-body" },
      { id: "done", bodyUnit: "done-body" }
    ],
    edges: [
      {
        id: "done-idle", from: "done", to: "idle",
        trigger: { type: "event", name: "reset" },
        start: {
          type: "portal", sourcePort: "default", targetPort: "default",
          maxWaitFrames: 4
        },
        transition: { kind: "locked", unit: "reset-bridge" },
        continuity: "exact-authored"
      },
      {
        id: "idle-hover", from: "idle", to: "hover",
        trigger: { type: "event", name: "hover-on" },
        start: {
          type: "portal", sourcePort: "default", targetPort: "default",
          maxWaitFrames: 0
        },
        transition: { kind: "reversible", unit: "state-change", direction: "forward" },
        continuity: "exact-authored"
      },
      {
        id: "hover-idle", from: "hover", to: "idle",
        trigger: { type: "event", name: "hover-off" },
        start: {
          type: "portal", sourcePort: "default", targetPort: "default",
          maxWaitFrames: 0
        },
        transition: {
          kind: "reversible", unit: "state-change", direction: "reverse",
          reverseOf: "idle-hover"
        },
        continuity: "exact-reverse"
      },
      {
        id: "hover-done", from: "hover", to: "done",
        trigger: { type: "completion" },
        start: { type: "finish", targetPort: "default", maxWaitFrames: 0 },
        continuity: "exact-authored"
      },
      {
        id: "idle-done", from: "idle", to: "done",
        trigger: { type: "event", name: "activate" },
        start: { type: "cut", targetPort: "default", maxWaitFrames: 1 },
        continuity: "cut",
        targetRunwayFrames: 6
      }
    ],
    bindings: [
      { source: "activate", event: "activate" },
      { source: "focus.out", event: "reset" },
      { source: "pointer.enter", event: "hover-on" },
      { source: "pointer.leave", event: "hover-off" }
    ]
  };
}

export function processWrapperSource(): string {
  return [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "const [ffmpeg, pidFile] = process.argv.slice(2);",
    "const child = spawn(ffmpeg, [",
    "  '-nostdin', '-hide_banner', '-loglevel', 'error', '-re',",
    "  '-f', 'lavfi', '-i', 'testsrc2=size=32x32:rate=30',",
    "  '-t', '30', '-f', 'null', '-'",
    "], { stdio: ['ignore', 'inherit', 'inherit'] });",
    "writeFileSync(pidFile, JSON.stringify([process.pid, child.pid]));",
    "child.once('exit', (code) => process.exit(code ?? 1));",
    "setInterval(() => {}, 1000);"
  ].join("\n");
}

export async function waitForPidFile(path: string): Promise<readonly number[]> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (
        Array.isArray(value) &&
        value.length === 2 &&
        value.every((pid) => Number.isSafeInteger(pid) && pid > 0)
      ) {
        return value as number[];
      }
    } catch {
      // The wrapper has not atomically published both PIDs yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("real FFmpeg wrapper did not publish its process IDs");
}

export async function waitForPidsToExit(pids: readonly number[]): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isProcessAlive(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`cancelled process tree is still alive: ${pids.join(",")}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0)
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}
