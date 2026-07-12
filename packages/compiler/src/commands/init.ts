import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { serializeCanonicalJson } from "@rendered-motion/format";
import type { InitCliArguments } from "../cli-args.js";
import { encodeCanonicalRgbaPng } from "../compile/png.js";
import { CompilerError } from "../diagnostics.js";
import { validateSourceProject } from "../source-project-schema.js";

export interface InitCommandResult {
  readonly command: "init";
  readonly directory: string;
  readonly project: string;
  readonly files: readonly string[];
}

const PROJECT_FILE = "motion.json";

/** Create the deterministic, procedurally drawn M5 starter without bundled art. */
export async function runInitCommand(
  arguments_: InitCliArguments,
  cwd: string
): Promise<Readonly<InitCommandResult>> {
  const directory = resolve(cwd, arguments_.directory);
  const files = [
    PROJECT_FILE,
    "README.md",
    "ASSET-LICENSE.md",
    "frames/frame-0000.png",
    "frames/frame-0001.png"
  ] as const;
  let claimedDirectory = false;
  try {
    await mkdir(dirname(directory), { recursive: true, mode: 0o755 });
    try {
      await mkdir(directory, { mode: 0o755 });
      claimedDirectory = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new CompilerError("IO_FAILED", "Init directory already exists", {
          path: directory,
          hint: "Choose a new empty path; init never overwrites files."
        });
      }
      throw error;
    }
    await mkdir(resolve(directory, "frames"), { mode: 0o755 });
    const project = starterProject();
    validateSourceProject(project);
    await writeExclusive(
      resolve(directory, PROJECT_FILE),
      serializeCanonicalJson(project)
    );
    await writeExclusive(
      resolve(directory, "README.md"),
      new TextEncoder().encode(README)
    );
    await writeExclusive(
      resolve(directory, "ASSET-LICENSE.md"),
      new TextEncoder().encode(ASSET_LICENSE)
    );
    await writeExclusive(
      resolve(directory, "frames/frame-0000.png"),
      starterFrame(0)
    );
    await writeExclusive(
      resolve(directory, "frames/frame-0001.png"),
      starterFrame(1)
    );
  } catch (error) {
    if (claimedDirectory) {
      await cleanupClaimedInit(directory, files);
    }
    if (error instanceof CompilerError) throw error;
    throw new CompilerError("IO_FAILED", "Could not create init project", {
      path: directory,
      cause: error
    });
  }
  return Object.freeze({
    command: "init",
    directory,
    project: resolve(directory, PROJECT_FILE),
    files: Object.freeze([...files])
  });
}

async function cleanupClaimedInit(
  directory: string,
  files: readonly string[]
): Promise<void> {
  for (const file of [...files].reverse()) {
    await rm(resolve(directory, file), { force: true }).catch(() => undefined);
  }
  await rmdir(resolve(directory, "frames")).catch(() => undefined);
  await rmdir(directory).catch(() => undefined);
}

function starterProject(): Record<string, unknown> {
  return {
    projectVersion: "0.1",
    profile: "avc-annexb-opaque-v0",
    canvas: {
      width: 32,
      height: 32,
      fit: "contain",
      pixelAspect: [1, 1],
      colorSpace: "srgb"
    },
    frameRate: { numerator: 30, denominator: 1 },
    sources: [{
      id: "generated",
      type: "png-sequence",
      directory: "frames",
      prefix: "frame-",
      digits: 4,
      suffix: ".png",
      firstNumber: 0,
      frameCount: 2
    }],
    renditions: [{
      id: "opaque.1x",
      codedWidth: 32,
      codedHeight: 32,
      bitrate: { average: 300_000, peak: 600_000 }
    }],
    units: [{
      id: "body.default",
      kind: "body",
      source: "generated",
      range: [0, 2],
      playback: "loop",
      ports: [{ id: "default", entryFrame: 0, portalFrames: [1] }]
    }],
    initialState: "default",
    states: [{
      id: "default",
      bodyUnit: "body.default",
      poster: { source: "generated", frame: 0 }
    }],
    edges: [],
    bindings: []
  };
}

function starterFrame(index: 0 | 1): Uint8Array {
  const width = 32;
  const height = 32;
  const rgba = new Uint8Array(width * height * 4);
  const centerX = index === 0 ? 10 : 21;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const checker = ((x >> 3) + (y >> 3)) % 2;
      const base = checker === 0 ? 24 : 30;
      const inside = (x - centerX) ** 2 + (y - 16) ** 2 <= 36;
      rgba[offset] = inside ? 239 : base;
      rgba[offset + 1] = inside ? 111 : base + 4;
      rgba[offset + 2] = inside ? 68 : base + 12;
      rgba[offset + 3] = 255;
    }
  }
  return encodeCanonicalRgbaPng({ width, height, rgba });
}

async function writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
  await writeFile(path, bytes, { flag: "wx", mode: 0o644 });
}

const README = `# Rendered Motion starter

Compile the generated two-frame project:

\`\`\`sh
rma compile motion.json --out starter.rma
\`\`\`

Inspect and validate it:

\`\`\`sh
rma inspect starter.rma
rma validate starter.rma
\`\`\`
`;

const ASSET_LICENSE = `# Generated starter asset license

The two PNG frames in this directory are generated procedurally by the
Rendered Motion compiler. They contain no third-party artwork. To the extent
possible under law, the generator's authors waive copyright and related rights
in those generated example frames under CC0 1.0 Universal.

https://creativecommons.org/publicdomain/zero/1.0/
`;
