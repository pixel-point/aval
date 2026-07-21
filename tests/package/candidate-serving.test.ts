import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseFrontIndex } from "@pixel-point/aval-format";

import {
  CandidateAssetNotFoundError,
  createCandidateAssetStore,
  readCandidateAsset,
  startCandidateServer
} from "../../scripts/certification/serve-candidate.mjs";
import { FATAL_BOUNDARY_FIXTURE_PATH } from "../../scripts/certification/certification-fixture-authority.mjs";

const FATAL_BOUNDARY_PATH = "/__aval_certification__/fatal-boundary-network.avl";
const CANDIDATE_RUN_CONFIG_PATH = "/__aval_certification__/run-config.json";

describe("candidate server byte authority", () => {
  it("serves only manifest-allowlisted paths and the exact manifest bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-serve-candidate-"));
    try {
      const harness = Buffer.from("<!doctype html><title>certification</title>\n");
      const manifest = Buffer.from("{}\n");
      await writeFile(join(root, "certification.html"), harness);
      await writeFile(join(root, "unmanifested.txt"), "must not escape\n");
      const store = createCandidateAssetStore({
        root,
        manifestBytes: manifest,
        manifestDigest: sha256(manifest),
        artifacts: [{ path: "certification.html", sha256: sha256(harness), byteLength: harness.byteLength, mediaType: "text/html" }]
      });
      await expect(readCandidateAsset(store, "/")).resolves.toMatchObject({ bytes: harness, sha256: sha256(harness) });
      await expect(readCandidateAsset(store, "/candidate-manifest.json")).resolves.toMatchObject({ bytes: manifest, sha256: sha256(manifest) });
      await expect(readCandidateAsset(store, "/unmanifested.txt")).rejects.toBeInstanceOf(CandidateAssetNotFoundError);
      await expect(readCandidateAsset(store, "/../unmanifested.txt")).rejects.toBeInstanceOf(CandidateAssetNotFoundError);
      await expect(readCandidateAsset(store, "/certification.html?ignored=1")).rejects.toBeInstanceOf(CandidateAssetNotFoundError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when an allowlisted file changes after startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-serve-mutated-"));
    try {
      const before = Buffer.from("before\n");
      const manifest = Buffer.from("{}\n");
      await writeFile(join(root, "certification.html"), before);
      const store = createCandidateAssetStore({
        root,
        manifestBytes: manifest,
        manifestDigest: sha256(manifest),
        artifacts: [{ path: "certification.html", sha256: sha256(before), byteLength: before.byteLength, mediaType: "text/html" }]
      });
      await writeFile(join(root, "certification.html"), "after!\n");
      await expect(readCandidateAsset(store, "/")).rejects.toThrow(/changed after verification/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a producer-declared manifest digest that does not match its bytes", () => {
    expect(() => createCandidateAssetStore({ root: ".", manifestBytes: Buffer.from("{}\n"), manifestDigest: "0".repeat(64), artifacts: [{ path: "x", sha256: "1".repeat(64), byteLength: 1 }] })).toThrow(/manifest bytes/u);
  });

  it("exposes one queryless fatal-boundary stimulus backed by the exact candidate fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-serve-boundary-"));
    let server: ReturnType<typeof startCandidateServer> | null = null;
    try {
      const harness = Buffer.from("<!doctype html><title>certification</title>\n");
      const fixture = await readFile(new URL(
        "../../fixtures/certification/v1/h264.avl",
        import.meta.url
      ));
      const front = parseFrontIndex(fixture);
      const fixturePath = FATAL_BOUNDARY_FIXTURE_PATH;
      await mkdir(join(root, dirname(fixturePath)), {
        recursive: true
      });
      await writeFile(join(root, "certification.html"), harness);
      await writeFile(join(root, fixturePath), fixture);
      const artifacts = [
        { path: "certification.html", sha256: sha256(harness), byteLength: harness.byteLength, mediaType: "text/html" },
        { path: fixturePath, sha256: sha256(fixture), byteLength: fixture.byteLength, mediaType: "application/octet-stream" }
      ];
      const manifest = Buffer.from(`${JSON.stringify({
        schemaVersion: "1.0",
        manifestKind: "candidate",
        commit: "a".repeat(40),
        tree: "b".repeat(40),
        artifacts
      })}\n`);
      const manifestDigest = sha256(manifest);
      const fixtureDigest = sha256(fixture);
      const store = createCandidateAssetStore({
        root,
        manifestBytes: manifest,
        manifestDigest,
        artifacts
      });
      server = startCandidateServer(store, { port: 0 });
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("candidate test server did not bind TCP");
      const origin = `http://127.0.0.1:${String(address.port)}`;

      const configResponse = await fetch(`${origin}${CANDIDATE_RUN_CONFIG_PATH}`);
      expect(configResponse.status).toBe(200);
      expect(configResponse.headers.get("x-aval-candidate-run-config")).toBe("1");
      expect(configResponse.headers.get("x-aval-candidate-manifest-sha256")).toBe(manifestDigest);
      expect(await configResponse.json()).toMatchObject({
        mode: "functional",
        candidateManifestDigest: manifestDigest,
        fixtureDigest,
        harnessDigest: sha256(harness),
        commit: "a".repeat(40),
        tree: "b".repeat(40),
        sourceUrl: `/${fixturePath}`
      });

      const fault = await fetch(`${origin}${FATAL_BOUNDARY_PATH}`);
      expect(fault.status).toBe(503);
      expect(fault.headers.get("x-aval-candidate-manifest-sha256")).toBe(manifestDigest);
      expect(fault.headers.get("x-aval-fault-source-sha256")).toBe(fixtureDigest);
      expect(await fault.json()).toEqual({ error: "injected-network-failure" });

      const initial = await fetch(`${origin}${FATAL_BOUNDARY_PATH}`, {
        headers: { Range: "bytes=0-63" }
      });
      expect(initial.status).toBe(206);
      expect(initial.headers.get("content-range")).toBe(
        `bytes 0-63/${String(fixture.byteLength)}`
      );
      expect(Buffer.from(await initial.arrayBuffer())).toEqual(fixture.subarray(0, 64));
      const manifestEnd = front.header.indexOffset - 1;
      const metadata = await fetch(`${origin}${FATAL_BOUNDARY_PATH}`, {
        headers: { Range: `bytes=64-${String(manifestEnd)}` }
      });
      expect(metadata.status).toBe(206);
      expect(Buffer.from(await metadata.arrayBuffer())).toEqual(
        fixture.subarray(64, front.header.indexOffset)
      );
      const indexEnd = front.frontIndexRange.length - 1;
      const index = await fetch(`${origin}${FATAL_BOUNDARY_PATH}`, {
        headers: {
          Range: `bytes=${String(front.header.indexOffset)}-${String(indexEnd)}`
        }
      });
      expect(index.status).toBe(206);
      expect(Buffer.from(await index.arrayBuffer())).toEqual(
        fixture.subarray(front.header.indexOffset, front.frontIndexRange.length)
      );
      const payload = front.records[0]!;
      expect((await fetch(`${origin}${FATAL_BOUNDARY_PATH}`, {
        headers: {
          Range: `bytes=${String(payload.byteOffset)}-${String(
            payload.byteOffset + payload.byteLength - 1
          )}`
        }
      })).status).toBe(503);

      expect((await fetch(`${origin}${FATAL_BOUNDARY_PATH}?session=forbidden`)).status).toBe(404);
      expect((await fetch(`${origin}/certification.html?ignored=1`)).status).toBe(404);
    } finally {
      if (server !== null) {
        server.close();
        await once(server, "close");
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
