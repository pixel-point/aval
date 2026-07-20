import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { replaceDirectoriesTransactionally } from
  "../../scripts/fixtures/replace-fixture-directories.mjs";

describe("fixture directory transaction", () => {
  it("publishes every staged directory and removes transaction artifacts", async () => {
    const fixture = await directoryFixture("commit");
    try {
      await replaceDirectoriesTransactionally(fixture.replacements);

      await expect(contents(fixture.first.current)).resolves.toBe("new-first");
      await expect(contents(fixture.second.current)).resolves.toBe("new-second");
      await expect(readFile(fixture.first.staged)).rejects.toMatchObject({
        code: "ENOENT"
      });
      expect((await readdir(fixture.root)).sort()).toEqual([
        "first",
        "second"
      ]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("restores every original after an injected mid-transaction failure", async () => {
    const fixture = await directoryFixture("rollback");
    try {
      await expect(replaceDirectoriesTransactionally(
        fixture.replacements,
        {
          afterInstall({ index }) {
            if (index === 0) throw new Error("injected swap failure");
          }
        }
      )).rejects.toThrow("injected swap failure");

      await expect(contents(fixture.first.current)).resolves.toBe("old-first");
      await expect(contents(fixture.second.current)).resolves.toBe("old-second");
      await expect(contents(fixture.first.staged)).resolves.toBe("new-first");
      await expect(contents(fixture.second.staged)).resolves.toBe("new-second");
      expect((await readdir(fixture.root)).sort()).toEqual([
        "first",
        "first-staged",
        "second",
        "second-staged"
      ]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

async function directoryFixture(label: string): Promise<Readonly<{
  root: string;
  first: Readonly<{ current: string; staged: string }>;
  second: Readonly<{ current: string; staged: string }>;
  replacements: readonly Readonly<{ current: string; staged: string }>[];
}>> {
  const root = await mkdtemp(join(tmpdir(), `aval-fixture-transaction-${label}-`));
  const first = {
    current: join(root, "first"),
    staged: join(root, "first-staged")
  };
  const second = {
    current: join(root, "second"),
    staged: join(root, "second-staged")
  };
  await Promise.all([
    install(first.current, "old-first"),
    install(first.staged, "new-first"),
    install(second.current, "old-second"),
    install(second.staged, "new-second")
  ]);
  return Object.freeze({
    root,
    first: Object.freeze(first),
    second: Object.freeze(second),
    replacements: Object.freeze([first, second])
  });
}

async function install(directory: string, value: string): Promise<void> {
  await mkdir(directory);
  await writeFile(join(directory, "value.txt"), value);
}

async function contents(directory: string): Promise<string> {
  return readFile(join(directory, "value.txt"), "utf8");
}
