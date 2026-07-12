import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const M6_ROOT = join(REPOSITORY_ROOT, "fixtures/conformance/m6");
const M7_ROOT = join(REPOSITORY_ROOT, "fixtures/conformance/m7");

describe("M7 transport fixture compiler provenance", () => {
  it("is byte-identical to the reviewed M6 compiler publication", async () => {
    const [source, reference, m6Text, m7Text] = await Promise.all([
      readFile(join(M6_ROOT, "packed-alpha-all-routes.rma")),
      readFile(join(M7_ROOT, "reference-packed.rma")),
      readFile(join(M6_ROOT, "provenance.json"), "utf8"),
      readFile(join(M7_ROOT, "reference-packed.provenance.json"), "utf8")
    ]);
    const m6 = JSON.parse(m6Text);
    const m7 = JSON.parse(m7Text);
    const publication = m6.assets.find(
      ({ name }: { name: string }) => name === "packed-alpha-all-routes.rma"
    );

    expect(publication).toBeDefined();
    expect(reference).toEqual(source);
    expect(reference.byteLength).toBe(publication.asset.bytes);
    expect(sha256(reference)).toBe(publication.asset.sha256);
    expect(m7.asset).toMatchObject(publication.asset);
    expect(m7.source.compilerProject).toEqual(publication.sourceProject);
    expect(m7.source.compilerManifestSha256)
      .toBe(publication.manifestSha256);
    expect(m7.toolchain).toEqual(m6.toolchain);
    for (const input of [
      m7.generatedBy,
      m7.networkScenarios,
      m7.source.provenance
    ]) {
      const inputBytes = await readFile(join(REPOSITORY_ROOT, input.path));
      expect(inputBytes.byteLength).toBe(input.bytes);
      expect(sha256(inputBytes)).toBe(input.sha256);
    }
  });
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
