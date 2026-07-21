import type { CandidateArtifact } from "../src/model.js";
import { PUBLIC_RELEASE_PACKAGES } from "../src/compatibility.js";

const REQUIRED: readonly (readonly [role: string, path: string, mediaType: string])[] = [
  ...PUBLIC_RELEASE_PACKAGES.map((name) => ["package", `packages/${name.slice(1).replace("/", "-")}-1.0.0.tgz`, "application/gzip"] as const),
  ["package-index", "package-index.json", "application/json"],
  ["package-inspection", "package-inspection.json", "application/json"],
  ["sbom", "sbom/workspace.spdx.json", "application/json"],
  ["sbom", "sbom/graph.spdx.json", "application/json"],
  ["sbom", "sbom/format.spdx.json", "application/json"],
  ["sbom", "sbom/player-web.spdx.json", "application/json"],
  ["sbom", "sbom/element.spdx.json", "application/json"],
  ["sbom", "sbom/compiler.spdx.json", "application/json"],
  ["api-report", "etc/api/graph.api.md", "text/markdown"],
  ["api-report", "etc/api/format.api.md", "text/markdown"],
  ["api-report", "etc/api/player-web.api.md", "text/markdown"],
  ["api-report", "etc/api/element.api.md", "text/markdown"],
  ["api-report", "etc/api/compiler.api.md", "text/markdown"],
  ["schema", "schemas/candidate-manifest.schema.json", "application/json"],
  ["fixture", "fixtures/certification/v1/av1.avl", "application/octet-stream"],
  ["documentation", "docs/quick-start.md", "text/markdown"],
  ["example", "examples/plain-html/package.json", "application/json"],
  ["browser-harness", "certification.html", "text/html"],
  ["browser-harness", "assets/public-entry-manifest.json", "application/json"],
  ["release-policy", "config/release/release-policy.json", "application/json"],
  ["release-policy", "config/release/publication-metadata.json", "application/json"],
  ["legal-review", "config/release/legal-review.json", "application/json"],
  ["license-report", "license-report.json", "application/json"],
  ["candidate-layout", "candidate-layout.json", "application/json"],
  ["project-metadata", "package-lock.json", "application/json"]
];

export function candidateArtifactFixture(): CandidateArtifact[] {
  return REQUIRED.map(([role, path, mediaType], index) => ({
    id: `artifact-${String(index + 1)}`,
    role,
    path,
    sha256: (index + 1).toString(16).padStart(64, "0"),
    byteLength: index + 1,
    mediaType
  }));
}
