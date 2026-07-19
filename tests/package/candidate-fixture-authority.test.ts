import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import * as certification from "../../packages/certification/src/index.js";
import { loadCandidateFixtureAuthority } from "../../scripts/certification/candidate-fixtures.mjs";

const fixtureSource = resolve("fixtures/conformance/v1/h264.avl");

describe("candidate fixture authority stable reads", () => {
  it("separately binds the exact fatal-boundary source and certification harness", async () => {
    const root = await temporaryRoot("fatal-boundary");
    try {
      const fixture = await readFile(fixtureSource);
      const harness = new TextEncoder().encode("<!doctype html><title>certification</title>");
      const fixturePath = "fixtures/conformance/v1/h264.avl";
      await mkdir(join(root, "fixtures", "conformance", "v1"), { recursive: true });
      await copyFile(fixtureSource, join(root, fixturePath));
      await writeFile(join(root, "certification.html"), harness);
      const fixtureEntry = { ...artifact(fixture), path: fixturePath };
      const harnessEntry = harnessArtifact(harness);
      const authority = await loadCandidateFixtureAuthority(
        { artifacts: [fixtureEntry, harnessEntry] },
        join(root, "candidate-manifest.json"),
        certification,
        { maximumArtifactBytes: 1024 * 1024 * 1024 }
      );
      expect(authority.fatalBoundaryFixtureDigests).toEqual(new Set([fixtureEntry.sha256]));
      expect(authority.harnessDigests).toEqual(new Set([harnessEntry.sha256]));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects a manifest-listed certification harness that is missing", async () => {
    const root = await temporaryRoot("missing-harness");
    try {
      const fixture = await readFile(fixtureSource);
      const fixturePath = "fixtures/conformance/v1/h264.avl";
      await mkdir(join(root, "fixtures", "conformance", "v1"), { recursive: true });
      await copyFile(fixtureSource, join(root, fixturePath));
      const harness = new TextEncoder().encode("<!doctype html><title>missing</title>");
      await expect(loadCandidateFixtureAuthority(
        { artifacts: [{ ...artifact(fixture), path: fixturePath }, harnessArtifact(harness)] },
        join(root, "candidate-manifest.json"),
        certification
      )).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects mutated certification harness bytes", async () => {
    const root = await temporaryRoot("mutated-harness");
    try {
      const fixture = await readFile(fixtureSource);
      const fixturePath = "fixtures/conformance/v1/h264.avl";
      const before = new TextEncoder().encode("<!doctype html><title>before</title>");
      await mkdir(join(root, "fixtures", "conformance", "v1"), { recursive: true });
      await copyFile(fixtureSource, join(root, fixturePath));
      await writeFile(join(root, "certification.html"), "<!doctype html><title>after!</title>");
      await expect(loadCandidateFixtureAuthority(
        { artifacts: [{ ...artifact(fixture), path: fixturePath }, harnessArtifact(before)] },
        join(root, "candidate-manifest.json"),
        certification
      )).rejects.toThrow(/byteLength|digest|expected/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects a certification harness path substitution after secure open", async () => {
    const root = await temporaryRoot("harness-race");
    try {
      const fixture = await readFile(fixtureSource);
      const fixturePath = "fixtures/conformance/v1/h264.avl";
      const harness = new TextEncoder().encode("<!doctype html><title>certification</title>");
      const harnessPath = join(root, "certification.html");
      await mkdir(join(root, "fixtures", "conformance", "v1"), { recursive: true });
      await copyFile(fixtureSource, join(root, fixturePath));
      await writeFile(harnessPath, harness);
      await expect(loadCandidateFixtureAuthority(
        { artifacts: [{ ...artifact(fixture), path: fixturePath }, harnessArtifact(harness)] },
        join(root, "candidate-manifest.json"),
        certification,
        {
          verificationHook: async (phase, reference) => {
            if (phase !== "after-open" || reference.path !== "certification.html") return;
            await rename(harnessPath, join(root, "retired-certification.html"));
            await writeFile(harnessPath, harness);
          }
        }
      )).rejects.toThrow(/changed while being verified/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("requires the canonical harness role and media type", async () => {
    const root = await temporaryRoot("harness-classification");
    try {
      const fixture = await readFile(fixtureSource);
      const fixturePath = "fixtures/conformance/v1/h264.avl";
      const harness = new TextEncoder().encode("<!doctype html><title>certification</title>");
      await mkdir(join(root, "fixtures", "conformance", "v1"), { recursive: true });
      await copyFile(fixtureSource, join(root, fixturePath));
      await writeFile(join(root, "certification.html"), harness);
      const fixtureEntry = { ...artifact(fixture), path: fixturePath };
      await expect(loadCandidateFixtureAuthority(
        { artifacts: [fixtureEntry, harnessArtifact(harness, { role: "documentation" })] },
        join(root, "candidate-manifest.json"),
        certification
      )).rejects.toThrow(/browser-harness/u);
      await expect(loadCandidateFixtureAuthority(
        { artifacts: [fixtureEntry, harnessArtifact(harness, { mediaType: "text/plain" })] },
        join(root, "candidate-manifest.json"),
        certification
      )).rejects.toThrow(/text\/html/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects a symlink even when its target bytes match the manifest", async () => {
    const root = await temporaryRoot("symlink");
    try {
      const bytes = await readFile(fixtureSource);
      await symlink(fixtureSource, join(root, "fixtures", "motion.avl"));
      await expect(load(root, artifact(bytes))).rejects.toThrow(/symbolic links/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects candidate-policy-oversize declarations before reading or allocating", async () => {
    const root = await temporaryRoot("oversize");
    try {
      const declared = { ...artifact(new Uint8Array(0)), byteLength: 1024 * 1024 * 1024 + 1 };
      await expect(load(root, declared)).rejects.toThrow(/exceeds policy limit/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects a path substitution after the fixture handle is open", async () => {
    const root = await temporaryRoot("race");
    try {
      const bytes = await readFile(fixtureSource);
      const path = join(root, "fixtures", "motion.avl");
      await copyFile(fixtureSource, path);
      await expect(load(root, artifact(bytes), async (phase) => {
        if (phase !== "after-open") return;
        await rename(path, join(root, "fixtures", "retired.avl"));
        await writeFile(path, bytes);
      })).rejects.toThrow(/changed while being verified/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `aval-candidate-fixture-${label}-`));
  await mkdir(join(root, "fixtures"));
  return root;
}

function artifact(bytes: Uint8Array) {
  return {
    id: "fixture-motion",
    path: "fixtures/motion.avl",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    mediaType: "application/octet-stream",
    role: "fixture"
  };
}

function harnessArtifact(
  bytes: Uint8Array,
  overrides: Readonly<{ role?: string; mediaType?: string }> = {}
) {
  return {
    id: "certification-harness",
    path: "certification.html",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    mediaType: overrides.mediaType ?? "text/html",
    role: overrides.role ?? "browser-harness"
  };
}

async function load(root: string, entry: ReturnType<typeof artifact>, verificationHook?: (phase: "after-open" | "after-read") => Promise<void>) {
  return loadCandidateFixtureAuthority(
    { artifacts: [entry] },
    join(root, "candidate-manifest.json"),
    certification,
    { maximumArtifactBytes: 1024 * 1024 * 1024, ...(verificationHook === undefined ? {} : { verificationHook }) }
  );
}
