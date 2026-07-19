import { dirname, resolve } from "node:path";

/** Extract trusted graph models from the exact `.avl` artifacts in a validated candidate. */
export async function loadCandidateFixtureAuthority(candidate, candidateManifestPath, certification, options = {}) {
  const format = await import(resolve("packages/format/dist/index.js"));
  const candidateRoot = dirname(resolve(candidateManifestPath));
  const digests = new Set(candidate.artifacts.filter(({ path }) => path.startsWith("fixtures/")).map(({ sha256 }) => sha256));
  const fatalBoundaryFixtureDigests = new Set();
  const harnessDigests = new Set();
  const models = new Map();
  const displayPatterns = new Map();
  const maximumArtifactBytes = options.maximumArtifactBytes ?? 1024 * 1024 * 1024;
  if (!Number.isSafeInteger(maximumArtifactBytes) || maximumArtifactBytes < 1) throw new Error("candidate artifact byte limit is invalid");
  for (const artifact of candidate.artifacts) {
    if (artifact.path === "certification.html") {
      if (artifact.role !== "browser-harness") throw new Error("candidate certification.html must use the browser-harness role");
      if (artifact.mediaType !== "text/html") throw new Error("candidate certification.html must use the text/html media type");
      await readCandidateArtifact(candidateRoot, artifact, Math.min(maximumArtifactBytes, 16 * 1024 * 1024), certification, options.verificationHook);
      harnessDigests.add(artifact.sha256);
    }
    if (artifact.path === "config/release/display-pattern.json") {
      const bytes = await readCandidateArtifact(candidateRoot, artifact, Math.min(maximumArtifactBytes, 16 * 1024 * 1024), certification, options.verificationHook);
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      const model = certification.validateDisplayPattern(parsed);
      if (Buffer.compare(bytes, certification.canonicalJsonBytes(model)) !== 0) throw new Error("candidate display pattern is not canonical JSON");
      displayPatterns.set(artifact.sha256, model);
    }
    if (!artifact.path.startsWith("fixtures/") || !artifact.path.endsWith(".avl")) continue;
    const bytes = await readCandidateArtifact(candidateRoot, artifact, Math.min(maximumArtifactBytes, format.FORMAT_DEFAULT_BUDGETS.maxFileBytes), certification, options.verificationHook);
    const validated = format.validateCompleteAsset({ bytes });
    models.set(artifact.sha256, certification.runtimeFixtureModelFromManifest(validated.frontIndex.manifest));
    if (artifact.path === "fixtures/conformance/v1/h264.avl") fatalBoundaryFixtureDigests.add(artifact.sha256);
  }
  return Object.freeze({
    digests,
    models,
    displayPatterns,
    fatalBoundaryFixtureDigests,
    harnessDigests
  });
}

async function readCandidateArtifact(candidateRoot, artifact, maximumBytes, certification, testHook) {
  const verified = await certification.readVerifiedArtifactReferences(candidateRoot, [artifact], {
    maximumBytes,
    retainBytes: () => true,
    ...(testHook === undefined ? {} : { testHook })
  });
  const bytes = verified.get(artifact.id)?.bytes;
  if (bytes === null || bytes === undefined) throw new Error(`candidate artifact bytes were not retained: ${artifact.path}`);
  return bytes;
}
