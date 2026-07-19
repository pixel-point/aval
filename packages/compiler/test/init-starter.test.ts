import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";

import { runInitCommand } from "../src/commands/init.js";
import { parseSourceProject } from "../src/source-project-schema.js";

describe("AVAL 1.0 multi-codec idle-hover starter", () => {
  let root = "";
  afterAll(async () => {
    if (root !== "") await rm(root, { recursive: true, force: true });
  });

  it("creates a provenanced arbitrary-state accessible starter", async () => {
    root = await mkdtemp(join(tmpdir(), "aval-v1-starter-"));
    const result = await runInitCommand({
      command: "init",
      directory: "starter",
      json: false
    }, root);
    expect(result.files).toHaveLength(30);
    await expectExactTree(
      result.directory,
      resolve(process.cwd(), "fixtures/starter/v1-idle-hover")
    );
    const project = parseSourceProject(new Uint8Array(await readFile(result.project)));
    expect(project).toMatchObject({
      projectVersion: "1.0",
      encodings: [
        { codec: "av1", bitDepth: 10 },
        { codec: "vp9", deadline: "good" },
        { codec: "h265", preset: "slow" },
        { codec: "h264", preset: "slow" }
      ],
      initialState: "idle",
      states: [{ id: "engaged" }, { id: "idle" }]
    });
    const bodies = project.units.filter(({ kind }) => kind === "body");
    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) =>
      body.kind === "body" &&
      body.ports.length === 1 &&
      body.ports[0]?.entryFrame === 0 &&
      body.ports[0]?.portalFrames.join(",") === "0"
    )).toBe(true);
    const idleFrames = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      readFile(join(result.directory, `frames/frame-${String(index).padStart(4, "0")}.png`))
    ));
    const engagedFrames = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      readFile(join(result.directory, `frames/frame-${String(index + 14).padStart(4, "0")}.png`))
    ));
    expect(new Set(idleFrames.map((bytes) => bytes.toString("base64"))).size).toBeGreaterThan(1);
    expect(new Set(engagedFrames.map((bytes) => bytes.toString("base64"))).size).toBeGreaterThan(1);
    const html = await readFile(join(result.directory, "index.html"), "utf8");
    expect(html).toContain("<button id=\"favorite\"");
    expect(html).toContain("interaction-for=\"favorite\"");
    expect(html).toContain('<source data-aval-codec="av1">');
    expect(html).toContain('<source data-aval-codec="vp9">');
    expect(html).toContain('<source data-aval-codec="h265">');
    expect(html).toContain('<source data-aval-codec="h264">');
    expect(html).toContain('href="./style.css"');
    expect(html).toContain('src="./main.js"');
    expect(html).not.toMatch(/<aval-player[^>]+\s(?:src|integrity)=/u);
    const main = await readFile(join(result.directory, "main.js"), "utf8");
    expect(main).toContain('fetch("./motion/build.json")');
    expect(main).toContain('source.setAttribute("type", asset.type)');
    expect(main).toContain('source.setAttribute("integrity", asset.integrity)');
    expect(main).toContain(`player.addEventListener("error", (event) => {
  const diagnostics = player.getDiagnostics();
  if (
    event.detail.fatal === true &&
    player.readiness === "error" &&
    diagnostics.lastFailure !== null &&
    event.detail.failure === diagnostics.lastFailure
  ) {
    unavailable.hidden = false;
  }
});`);
    expect(main).not.toContain("if (event.detail.fatal) unavailable.hidden = false;");
    expect(main).toContain('await import("@pixel-point/aval-element/auto")');
    const style = await readFile(join(result.directory, "style.css"), "utf8");
    expect(style).toContain("#motion-unavailable");
    expect(style).toContain("width: 48px");
    expect(html).not.toContain("tabindex");
    const packageJson = JSON.parse(await readFile(
      join(result.directory, "package.json"),
      "utf8"
    )) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    expect(packageJson.dependencies).toEqual({
      "@pixel-point/aval-element": "1.0.0"
    });
    expect(packageJson.devDependencies).toEqual({
      "@pixel-point/aval-compiler": "1.0.0",
      vite: "8.1.4"
    });
    expect(packageJson.scripts?.build).toBe(
      "avl compile motion.json --out motion --force"
    );
    expect(packageJson.scripts?.dev).toBe(
      "avl dev motion.json --out motion --force"
    );
    const combined = await Promise.all(result.files.map((file) =>
      readFile(join(result.directory, file), "utf8").catch(() => "")
    ));
    const text = combined.join("\n");
    expect(text).not.toContain(root);
    expect(text).not.toContain("password");
  });

  it("never replaces an empty directory raced in after staging", async () => {
    const raceRoot = await mkdtemp(join(tmpdir(), "aval-v1-init-race-"));
    try {
      const target = join(raceRoot, "starter");
      await expect(runInitCommand({
        command: "init",
        directory: "starter",
        json: false
      }, raceRoot, {
        beforePublish: async () => mkdir(target)
      })).rejects.toMatchObject({ code: "IO_FAILED" });
      expect(await readdir(target)).toEqual([]);
      expect((await readdir(raceRoot)).filter((name) => name.includes(".avl-init-"))).toEqual([]);
    } finally {
      await rm(raceRoot, { recursive: true, force: true });
    }
  });

  it("reports a committed project when the final parent sync is uncertain", async () => {
    const syncRoot = await mkdtemp(join(tmpdir(), "aval-v1-init-durability-"));
    try {
      let syncs = 0;
      const operation = runInitCommand({
        command: "init",
        directory: "starter",
        json: false
      }, syncRoot, {
        publicationSyncDirectory: async () => {
          syncs += 1;
          const finalSync = process.platform === "win32" ? 1 : 2;
          if (syncs === finalSync) throw new Error("injected parent sync failure");
        }
      });
      await expect(operation).rejects.toMatchObject({
        code: "IO_FAILED",
        committed: true,
        message: expect.stringContaining("was committed")
      });
      expect(await readdir(join(syncRoot, "starter"))).toContain("motion.json");
      expect((await readdir(syncRoot)).filter((name) =>
        name.includes(".avl-init-")
      )).toEqual([]);
    } finally {
      await rm(syncRoot, { recursive: true, force: true });
    }
  });
});

async function expectExactTree(actualRoot: string, expectedRoot: string): Promise<void> {
  const [actualEntries, expectedEntries] = await Promise.all([
    collectTree(actualRoot),
    collectTree(expectedRoot)
  ]);
  expect(actualEntries, "generated starter tree drifted").toEqual(expectedEntries);
  for (const entry of expectedEntries) {
    if (entry.endsWith("/")) continue;
    const [actual, expected] = await Promise.all([
      readFile(join(actualRoot, entry)),
      readFile(join(expectedRoot, entry))
    ]);
    expect(Buffer.compare(actual, expected), `generated starter byte drift: ${entry}`).toBe(0);
  }
}

async function collectTree(directory: string, prefix = ""): Promise<readonly string[]> {
  const result: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      result.push(`${relative}/`);
      result.push(...await collectTree(join(directory, entry.name), relative));
    } else if (entry.isFile()) {
      result.push(relative);
    } else {
      throw new Error(`starter tree contains unsupported entry: ${relative}`);
    }
  }
  return Object.freeze(result);
}
