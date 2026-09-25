import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { checkBrowserRuntimeBoundaries } from
  "../../scripts/architecture/check-browser-runtime-boundaries.mjs";

const roots: string[] = [];

const CANONICAL_ADAPTER_SOURCE = `export {
  createAvalAdapterConfiguration,
  type AvalAdapterCallbacks,
  type AvalAdapterConfiguration,
  type AvalAdapterOptions,
  type AvalAdapterRenderOptions,
  type AvalSources
} from "./adapter-options.js";
export {
  createAvalAdapterBinding,
  type AvalAdapterBinding,
  type AvalAdapterCommands,
  type AvalAdapterController,
  type AvalAdapterStatus
} from "./adapter-binding.js";
`;

const COMMAND_INTERFACE_SOURCE = `export interface DuplicateCommands {
  prepare(): void;
  setState(): void;
  send(): void;
  readyFor(): void;
  play(): void;
  pause(): void;
  getDiagnostics(): void;
}
`;

const COMMAND_OBJECT_SOURCE = `const duplicateCommands = {
  prepare() {},
  setState() {},
  send() {},
  readyFor() {},
  play() {},
  pause() {},
  getDiagnostics() {}
};
void duplicateCommands;
`;

const COMMAND_CLASS_SOURCE = `export class DuplicateCommands {
  prepare() {}
  setState() {}
  send() {}
  readyFor() {}
  play() {}
  pause() {}
  getDiagnostics() {}
}
`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("browser runtime architecture", () => {
  it("keeps the architecture gate decomposed into focused modules", async () => {
    const scripts = new URL(
      "../../scripts/architecture/",
      import.meta.url
    );
    const coordinator = await readFile(
      new URL("check-browser-runtime-boundaries.mjs", scripts),
      "utf8"
    );
    expect(lineCount(coordinator)).toBeLessThanOrEqual(200);

    const rules = new URL("browser-runtime-boundaries/", scripts);
    const modules = (await readdir(rules, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"));
    expect(modules.length).toBeGreaterThan(0);
    for (const module of modules) {
      const source = await readFile(new URL(module.name, rules), "utf8");
      expect(lineCount(source)).toBeLessThanOrEqual(400);
    }
  });

  it("keeps element as the interactive runtime and alpha as an independent video runtime", async () => {
    await expect(checkBrowserRuntimeBoundaries()).resolves.toMatchObject({
      status: "passed",
      canonicalRuntime: "@pixel-point/aval-element"
    });
  });

  it("rejects interactive dependencies and cross-package imports in alpha adapters", async () => {
    const root = await architectureFixture();
    await writePackageSource(root, "alpha-react", "src/invalid.ts", 'import "@pixel-point/aval-element";\nimport "../../alpha/src/player.js";\n');
    await expect(checkBrowserRuntimeBoundaries(root)).rejects.toThrow(/unexpected alpha dependency @pixel-point\/aval-element/u);
    await writePackageSource(root, "alpha-react", "src/invalid.ts", 'import "../../alpha/src/player.js";\n');
    await expect(checkBrowserRuntimeBoundaries(root)).rejects.toThrow(/alpha relative imports must stay inside/u);
  });

  it("rejects a nonexistent or malformed repository root", async () => {
    const parent = await temporaryRoot("aval-runtime-missing-");
    await expect(checkBrowserRuntimeBoundaries(join(parent, "missing")))
      .rejects.toThrow(/repository root package manifest is missing/u);

    const malformed = await temporaryRoot("aval-runtime-malformed-");
    await writeFile(join(malformed, "package.json"), "{");
    await expect(checkBrowserRuntimeBoundaries(malformed))
      .rejects.toThrow(/repository root package manifest is not valid JSON/u);
  });

  it("requires the canonical element package and runtime source sentinels", async () => {
    const root = await architectureFixture();
    await rm(join(root, "packages", "element"), {
      recursive: true,
      force: true
    });

    await expect(checkBrowserRuntimeBoundaries(root)).rejects.toThrow(
      /canonical element package manifest is missing/u
    );
  });

  it.each(["aval-element.ts", "player.ts"])(
    "requires the canonical element %s source sentinel",
    async (sourceFile) => {
      const root = await architectureFixture();
      await rm(join(root, "packages", "element", "src", sourceFile));

      await expect(checkBrowserRuntimeBoundaries(root)).rejects.toThrow(
        `canonical element runtime source is missing: packages/element/src/${sourceFile}`
      );
    }
  );

  it("requires the reviewed element adapter source", async () => {
    const root = await architectureFixture();
    await rm(join(root, "packages", "element", "src", "adapter.ts"));

    await expect(checkBrowserRuntimeBoundaries(root)).rejects.toThrow(
      "canonical element adapter source is missing: packages/element/src/adapter.ts"
    );
  });

  it.each([
    Object.freeze({
      sourceFile: "player-session.ts",
      label: "player session owner source"
    }),
    Object.freeze({
      sourceFile: "player-media-runtime.ts",
      label: "player media owner source"
    }),
    Object.freeze({
      sourceFile: "element-runtime-session.ts",
      label: "element runtime session owner source"
    })
  ])("requires the $label", async ({ sourceFile, label }) => {
    const root = await architectureFixture();
    await rm(join(root, "packages", "element", "src", sourceFile));

    await expect(checkBrowserRuntimeBoundaries(root)).rejects.toThrow(
      `${label} is missing: packages/element/src/${sourceFile}`
    );
  });

  it.each([
    Object.freeze({ sourceFile: "player.ts", lines: 201, cap: 200 }),
    Object.freeze({ sourceFile: "aval-element.ts", lines: 801, cap: 800 }),
    Object.freeze({ sourceFile: "player-session.ts", lines: 1_001, cap: 1_000 }),
    Object.freeze({ sourceFile: "player-selection.ts", lines: 501, cap: 500 }),
    Object.freeze({ sourceFile: "element-input-binding.ts", lines: 1_001, cap: 1_000 })
  ])(
    "rejects $sourceFile above its reviewed size cap",
    async ({ sourceFile, lines, cap }) => {
      const root = await architectureFixture();
      await writePackageSource(
        root,
        "element",
        `src/${sourceFile}`,
        "\n".repeat(lines)
      );

      await expect(checkBrowserRuntimeBoundaries(root)).rejects.toThrow(
        `packages/element/src/${sourceFile}: ${lines} lines exceeds reviewed cap ${cap}`
      );
    }
  );

  it.each(["PlayerContext", "ElementContext", "RuntimeContext"])(
    "rejects the generic %s owner name",
    async (name) => {
      const root = await architectureFixture();
      await writePackageSource(
        root,
        "element",
        "src/player-forbidden-owner.ts",
        `interface ${name} { readonly value: string; }\n`
      );

      await expect(checkBrowserRuntimeBoundaries(root)).rejects.toThrow(
        `forbidden generic owner declaration ${name}`
      );
    }
  );

  it.each([
    Object.freeze({
      source: "interface PlayerSessionInput { [name: string]: unknown; }\n",
      expected: "PlayerSessionInput must not use a string index signature"
    }),
    Object.freeze({
      source: "interface PlayerSessionInput { readonly services: Readonly<Record<string, unknown>>; }\n",
      expected: "PlayerSessionInput properties must not use Record<string, unknown> owner bags"
    }),
    Object.freeze({
      source: "class Owner { constructor(input: Record<string, unknown>) { void input; } }\n",
      expected: "constructor parameters must not use Record<string, unknown> owner bags"
    })
  ])("rejects a generic constructor/input bag", async ({ source, expected }) => {
    const root = await architectureFixture();
    await writePackageSource(
      root,
      "element",
      "src/player-forbidden-owner.ts",
      source
    );

    await expect(checkBrowserRuntimeBoundaries(root)).rejects.toThrow(expected);
  });

  it.each([
    Object.freeze({
      sourceFile: "player-session.ts",
      source: 'import { Asset } from "./asset.js";\nvoid Asset;\n',
      expected: "player session must use the media port instead of ./asset.js"
    }),
    Object.freeze({
      sourceFile: "player-session.ts",
      source: 'import type { PlayerInput } from "./player-contract.js";\ntype Input = PlayerInput;\n',
      expected: "player session must not depend on the full PlayerInput bag"
    }),
    Object.freeze({
      sourceFile: "player-telemetry.ts",
      source: 'import { Renderer } from "./renderer.js";\nvoid Renderer;\n',
      expected: "concrete media import ./renderer.js is restricted to player-media owners"
    }),
    Object.freeze({
      sourceFile: "player-media-runtime.ts",
      source: 'import { PlayerSession } from "./player-session.js";\nvoid PlayerSession;\n',
      expected: "owner dependency points back to ./player-session.js"
    })
  ])(
    "rejects the player ownership violation in $sourceFile",
    async ({ sourceFile, source, expected }) => {
      const root = await architectureFixture();
      await writePackageSource(root, "element", `src/${sourceFile}`, source);

      await expect(checkBrowserRuntimeBoundaries(root)).rejects.toThrow(expected);
    }
  );

  it.each(["react", "svelte"] as const)(
    "requires the %s wrapper to depend only on element",
    async (wrapper) => {
      const root = await architectureFixture();
      await writePackageManifest(root, wrapper, {
        name: `@pixel-point/aval-${wrapper}`,
        dependencies: {
          "@pixel-point/aval-element": "1.0.0",
          "@pixel-point/aval-format": "1.0.0"
        }
      });

      await expect(checkBrowserRuntimeBoundaries(root)).rejects.toThrow(
        new RegExp(`packages/${wrapper} must depend exactly on @pixel-point/aval-element`, "u")
      );
    }
  );

  it.each([
    Object.freeze({
      field: "optionalDependencies",
      value: Object.freeze({ "@pixel-point/aval-format": "1.0.0" })
    }),
    Object.freeze({
      field: "bundledDependencies",
      value: Object.freeze(["@pixel-point/aval-format"])
    }),
    Object.freeze({
      field: "bundleDependencies",
      value: Object.freeze(["@pixel-point/aval-format"])
    })
  ] as const)(
    "rejects wrapper runtime dependencies hidden in $field",
    async ({ field, value }) => {
      const root = await architectureFixture();
      await writePackageManifest(root, "react", {
        name: "@pixel-point/aval-react",
        dependencies: { "@pixel-point/aval-element": "1.0.0" },
        [field]: value
      });

      await expect(checkBrowserRuntimeBoundaries(root)).rejects.toThrow(
        "packages/react must depend exactly on @pixel-point/aval-element"
      );
    }
  );

  it.each([
    Object.freeze({
      wrapper: "react",
      sourcePath: "src/invalid-import.tsx",
      module: "@pixel-point/aval-format"
    }),
    Object.freeze({
      wrapper: "svelte",
      sourcePath: "src/InvalidImport.svelte",
      module: "@pixel-point/aval-element/auto"
    })
  ] as const)(
    "rejects $wrapper production imports from $module",
    async ({ wrapper, sourcePath, module }) => {
      const root = await architectureFixture();
      const source = sourcePath.endsWith(".svelte")
        ? `<script lang="ts">import ${JSON.stringify(module)};</script>\n`
        : `import ${JSON.stringify(module)};\n`;
      await writePackageSource(root, wrapper, sourcePath, source);

      await expect(checkBrowserRuntimeBoundaries(root)).rejects.toThrow(
        `packages/${wrapper}/${sourcePath}: production AVAL imports may only target`
      );
    }
  );

  it.each(["react", "svelte"] as const)(
    "rejects %s production relative imports into element source",
    async (wrapper) => {
      const root = await architectureFixture();
      await writePackageSource(
        root,
        wrapper,
        "src/relative-import.ts",
        `import "../../element/src/player.js";\n`
      );

      await expect(checkBrowserRuntimeBoundaries(root)).rejects.toThrow(
        `packages/${wrapper}/src/relative-import.ts: production relative imports cannot reach packages/element/src`
      );
    }
  );

  it.each([
    Object.freeze({
      label: "import()",
      source: `const moduleName = "@pixel-point/aval-element";\nvoid import(moduleName);\n`
    }),
    Object.freeze({
      label: "require()",
      source: `const moduleName = "@pixel-point/aval-element";\nvoid require(moduleName);\n`
    })
  ])(
    "rejects a computed $label module load in wrapper production",
    async ({ source }) => {
      const root = await architectureFixture();
      await writePackageSource(
        root,
        "react",
        "src/computed-module.ts",
        source
      );

      await expect(checkBrowserRuntimeBoundaries(root)).rejects.toThrow(
        "packages/react/src/computed-module.ts: production dynamic module loads must use a static string specifier"
      );
    }
  );

  it.each([
    Object.freeze({
      wrapper: "react",
      sourcePath: "src/interface-commands.tsx",
      source: COMMAND_INTERFACE_SOURCE
    }),
    Object.freeze({
      wrapper: "svelte",
      sourcePath: "src/ObjectCommands.svelte",
      source: `<script lang="ts">${COMMAND_OBJECT_SOURCE}</script>\n`
    }),
    Object.freeze({
      wrapper: "react",
      sourcePath: "src/class-commands.ts",
      source: COMMAND_CLASS_SOURCE
    })
  ] as const)(
    "rejects a command restatement in $sourcePath",
    async ({ wrapper, sourcePath, source }) => {
      const root = await architectureFixture();
      await writePackageSource(root, wrapper, sourcePath, source);

      await expect(checkBrowserRuntimeBoundaries(root)).rejects.toThrow(
        `packages/${wrapper}/src: wrapper production containers collectively restate all adapter command names`
      );
    }
  );

  it("rejects adapter command restatement split across wrapper files", async () => {
    const root = await architectureFixture();
    await Promise.all([
      writePackageSource(
        root,
        "react",
        "src/command-group-a.ts",
        `interface FirstCommands {\n  prepare(): void;\n  setState(): void;\n  send(): void;\n  readyFor(): void;\n}\n`
      ),
      writePackageSource(
        root,
        "react",
        "src/command-group-b.ts",
        `const secondCommands = {\n  play() {},\n  pause() {},\n  getDiagnostics() {}\n};\nvoid secondCommands;\n`
      )
    ]);

    await expect(checkBrowserRuntimeBoundaries(root)).rejects.toThrow(
      "packages/react/src: wrapper production containers collectively restate all adapter command names"
    );
  });

  it("does not aggregate command declarations across framework packages", async () => {
    const root = await architectureFixture();
    await Promise.all([
      writePackageSource(
        root,
        "react",
        "src/partial-commands.ts",
        `interface ReactCommands {\n  prepare(): void;\n  setState(): void;\n  send(): void;\n  readyFor(): void;\n}\n`
      ),
      writePackageSource(
        root,
        "svelte",
        "src/partial-commands.ts",
        `interface SvelteCommands {\n  play(): void;\n  pause(): void;\n  getDiagnostics(): void;\n}\n`
      )
    ]);

    await expect(checkBrowserRuntimeBoundaries(root)).resolves.toMatchObject({
      status: "passed"
    });
  });

  it("excludes compile contracts and tests from production provenance", async () => {
    const root = await architectureFixture();
    const excludedSource = `
import "@pixel-point/aval-format";
${COMMAND_OBJECT_SOURCE}
const node = <div />;
void node;
`;
    await Promise.all([
      writePackageSource(
        root,
        "react",
        "src/public-api.compile.tsx",
        excludedSource
      ),
      writePackageSource(
        root,
        "react",
        "src/ssr.test.tsx",
        excludedSource
      )
    ]);

    await expect(checkBrowserRuntimeBoundaries(root)).resolves.toMatchObject({
      status: "passed"
    });
  });

  it.each([
    Object.freeze({
      label: "an extra adapter export",
      source: `${CANONICAL_ADAPTER_SOURCE}\nexport type { AvalAdapterBindingEnvironment } from "./adapter-binding.js";\n`,
      expected: /adapter\.ts must expose exactly the reviewed adapter API/u
    }),
    Object.freeze({
      label: "a missing adapter export",
      source: CANONICAL_ADAPTER_SOURCE.replace(
        "  type AvalAdapterStatus\n",
        ""
      ),
      expected: /adapter\.ts must expose exactly the reviewed adapter API/u
    }),
    Object.freeze({
      label: "a star export",
      source: `${CANONICAL_ADAPTER_SOURCE}\nexport * from "./public-types.js";\n`,
      expected: /adapter\.ts must not use star exports/u
    }),
    Object.freeze({
      label: "a public-types reexport",
      source: `${CANONICAL_ADAPTER_SOURCE}\nexport type { AvalCrossOrigin } from "./public-types.js";\n`,
      expected: /adapter\.ts must not re-export public-types/u
    })
  ])(
    "rejects $label from the element adapter barrel",
    async ({ source, expected }) => {
      const root = await architectureFixture();
      await writePackageSource(root, "element", "src/adapter.ts", source);

      await expect(checkBrowserRuntimeBoundaries(root)).rejects.toThrow(
        expected
      );
    }
  );

  it("rejects an unreviewed parallel browser runtime package", async () => {
    const root = await architectureFixture();
    await writePackageManifest(root, "browser-runtime", {
      name: "@pixel-point/aval-browser-runtime",
      dependencies: {
        "@pixel-point/aval-format": "1.0.0",
        "@pixel-point/aval-graph": "1.0.0"
      }
    });

    await expect(checkBrowserRuntimeBoundaries(root)).rejects.toThrow(
      /packages\/browser-runtime is outside the reviewed package architecture/u
    );
  });

  it("retains the retired runtime identity scan", async () => {
    const root = await architectureFixture();
    const retiredPackage = [
      "@pixel-point/aval",
      ["player", "web"].join("-")
    ].join("-");
    await mkdir(join(root, "tools", "source"), { recursive: true });
    await writeFile(
      join(root, "tools", "source", "consumer.ts"),
      `import ${JSON.stringify(retiredPackage)};\n`
    );

    await expect(checkBrowserRuntimeBoundaries(root)).rejects.toThrow(
      /tools\/source\/consumer.ts: references the removed parallel runtime/u
    );
  });

  it("excludes only generated output and historical evidence", async () => {
    const root = await architectureFixture();
    const retiredPackage = [
      "@pixel-point/aval",
      ["player", "web"].join("-")
    ].join("-");
    await Promise.all([
      mkdir(join(root, "docs", "evidence"), { recursive: true }),
      mkdir(join(root, "output"), { recursive: true })
    ]);
    await Promise.all([
      writeFile(
        join(root, "docs", "evidence", "historical.ts"),
        `import ${JSON.stringify(retiredPackage)};\n`
      ),
      writeFile(
        join(root, "output", "generated.ts"),
        `import ${JSON.stringify(retiredPackage)};\n`
      )
    ]);

    await expect(checkBrowserRuntimeBoundaries(root)).resolves.toMatchObject({
      status: "passed"
    });
  });
});

const PACKAGE_FIXTURES = Object.freeze([
  { directory: "alpha", manifest: { name: "@pixel-point/aval-alpha" } },
  { directory: "alpha-react", manifest: { name: "@pixel-point/aval-alpha-react", dependencies: { "@pixel-point/aval-alpha": "0.1.0" } } },
  { directory: "alpha-svelte", manifest: { name: "@pixel-point/aval-alpha-svelte", dependencies: { "@pixel-point/aval-alpha": "0.1.0" } } },
  Object.freeze({
    directory: "certification",
    manifest: Object.freeze({
      name: "@pixel-point/aval-certification",
      private: true,
      dependencies: Object.freeze({ "@pixel-point/aval-format": "1.0.0" })
    })
  }),
  Object.freeze({
    directory: "compiler",
    manifest: Object.freeze({
      name: "@pixel-point/aval-compiler",
      dependencies: Object.freeze({
        "@pixel-point/aval-element": "1.0.0",
        "@pixel-point/aval-format": "1.0.0",
        "@pixel-point/aval-graph": "1.0.0"
      })
    })
  }),
  Object.freeze({
    directory: "element",
    manifest: Object.freeze({
      name: "@pixel-point/aval-element",
      dependencies: Object.freeze({
        "@pixel-point/aval-format": "1.0.0",
        "@pixel-point/aval-graph": "1.0.0"
      })
    })
  }),
  Object.freeze({
    directory: "format",
    manifest: Object.freeze({
      name: "@pixel-point/aval-format",
      dependencies: Object.freeze({ "@pixel-point/aval-graph": "1.0.0" })
    })
  }),
  Object.freeze({
    directory: "graph",
    manifest: Object.freeze({ name: "@pixel-point/aval-graph" })
  }),
  Object.freeze({
    directory: "react",
    manifest: Object.freeze({
      name: "@pixel-point/aval-react",
      dependencies: Object.freeze({ "@pixel-point/aval-element": "1.0.0" })
    })
  }),
  Object.freeze({
    directory: "svelte",
    manifest: Object.freeze({
      name: "@pixel-point/aval-svelte",
      dependencies: Object.freeze({ "@pixel-point/aval-element": "1.0.0" })
    })
  })
]);

async function architectureFixture(): Promise<string> {
  const root = await temporaryRoot("aval-runtime-architecture-");
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "aval-workspace-fixture",
    private: true,
    workspaces: ["packages/*"]
  }));
  for (const fixture of PACKAGE_FIXTURES) {
    await writePackageManifest(root, fixture.directory, fixture.manifest);
  }
  const elementSource = join(root, "packages", "element", "src");
  await mkdir(elementSource, { recursive: true });
  await Promise.all([
    writeFile(join(elementSource, "aval-element.ts"), "export {};\n"),
    writeFile(join(elementSource, "player.ts"), "export {};\n"),
    writeFile(join(elementSource, "player-session.ts"), "export {};\n"),
    writeFile(join(elementSource, "player-media-runtime.ts"), "export {};\n"),
    writeFile(join(elementSource, "element-runtime-session.ts"), "export {};\n"),
    writeFile(join(elementSource, "adapter.ts"), CANONICAL_ADAPTER_SOURCE),
    writePackageSource(
      root,
      "react",
      "src/index.ts",
      `export type { AvalCrossOrigin } from "@pixel-point/aval-element";\nexport { createAvalAdapterBinding } from "@pixel-point/aval-element/adapter";\n`
    ),
    writePackageSource(
      root,
      "svelte",
      "src/AvalComponent.svelte",
      `<script lang="ts">import { createAvalAdapterBinding } from "@pixel-point/aval-element/adapter"; void createAvalAdapterBinding;</script>\n`
    )
  ]);
  return root;
}

async function writePackageManifest(
  root: string,
  directory: string,
  manifest: Readonly<Record<string, unknown>>
): Promise<void> {
  const packageRoot = join(root, "packages", directory);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify(manifest));
}

async function writePackageSource(
  root: string,
  directory: string,
  sourcePath: string,
  source: string
): Promise<void> {
  const path = join(root, "packages", directory, sourcePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source);
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function lineCount(source: string): number {
  return source.split("\n").length - Number(source.endsWith("\n"));
}
