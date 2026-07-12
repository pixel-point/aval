import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  writeFile
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const generatorPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(generatorPath), "../../..");
const outputRoot = resolve(root, "fixtures/conformance/m7");
const sourcePath = resolve(
  root,
  "fixtures/conformance/m6/packed-alpha-all-routes.rma"
);
const sourceProvenancePath = resolve(
  root,
  "fixtures/conformance/m6/provenance.json"
);
const outputPath = resolve(outputRoot, "reference-packed.rma");
const provenancePath = resolve(
  outputRoot,
  "reference-packed.provenance.json"
);
const scenariosPath = resolve(outputRoot, "network-scenarios.json");
const check = process.argv.includes("--check");

const [
  sourceBytes,
  sourceProvenanceBytes,
  generatorBytes,
  scenariosBytes
] = await Promise.all([
  readFile(sourcePath),
  readFile(sourceProvenancePath),
  readFile(generatorPath),
  readFile(scenariosPath)
]);
const sourceProvenanceText = sourceProvenanceBytes.toString("utf8");
const sourceProvenance = JSON.parse(sourceProvenanceText);
const sourceEntry = sourceProvenance.assets.find(
  ({ name }) => name === "packed-alpha-all-routes.rma"
);
requireValue(sourceEntry, "M6 packed all-routes provenance entry is missing");

const assetSha256 = sha256(sourceBytes);
requireValue(
  sourceEntry.asset.bytes === sourceBytes.byteLength &&
    sourceEntry.asset.sha256 === assetSha256,
  "M6 packed all-routes bytes do not match their provenance"
);

const canonicalBlobs = [
  ...sourceEntry.units.map((blob) => ({ kind: "unit", ...blob })),
  ...sourceEntry.staticFrames.map((blob) => ({ kind: "static", ...blob }))
].sort((left, right) => left.offset - right.offset);
let cursor = sourceEntry.frontIndex.length;
const storage = canonicalBlobs.map((blob) => {
  requireValue(blob.offset >= cursor, "canonical M7 blob geometry overlaps");
  const entry = {
    ...blob,
    paddingOffset: cursor,
    paddingLength: blob.offset - cursor,
    storageOffset: cursor,
    storageLength: blob.offset + blob.length - cursor
  };
  cursor = blob.offset + blob.length;
  return entry;
});
requireValue(cursor === sourceBytes.byteLength, "M7 canonical blobs do not end at EOF");

const initialState = sourceEntry.manifest.states.find(
  ({ id }) => id === sourceEntry.manifest.initialState
);
requireValue(initialState, "M7 initial state is missing");
const selectedRendition = sourceEntry.manifest.renditions.find(
  ({ id }) => id === "packed.1x"
);
requireValue(selectedRendition, "M7 reference rendition is missing");
const selectedUnits = storage.filter(
  (blob) => blob.kind === "unit" && blob.rendition === selectedRendition.id
);
const statics = storage.filter((blob) => blob.kind === "static");
const initialStatic = statics.find(
  ({ staticFrame }) => staticFrame === initialState.staticFrame
);
requireValue(initialStatic, "M7 initial static is missing");

const provenance = {
  provenanceVersion: "0.1",
  formatVersion: "0.1",
  generatedBy: {
    path: "fixtures/conformance/m7/update-provenance.mjs",
    bytes: generatorBytes.byteLength,
    sha256: sha256(generatorBytes)
  },
  networkScenarios: {
    path: "fixtures/conformance/m7/network-scenarios.json",
    bytes: scenariosBytes.byteLength,
    sha256: sha256(scenariosBytes)
  },
  source: {
    path: "fixtures/conformance/m6/packed-alpha-all-routes.rma",
    provenance: {
      path: "fixtures/conformance/m6/provenance.json",
      bytes: sourceProvenanceBytes.byteLength,
      sha256: sha256(sourceProvenanceBytes)
    },
    compilerProject: sourceEntry.sourceProject,
    compilerManifestSha256: sourceEntry.manifestSha256
  },
  asset: {
    path: "fixtures/conformance/m7/reference-packed.rma",
    bytes: sourceBytes.byteLength,
    sha256: assetSha256,
    externalIntegrity: `sha256-${createHash("sha256")
      .update(sourceBytes)
      .digest("base64")}`,
    strongEntityTag: `"m7-${assetSha256}"`
  },
  metadata: {
    header: { offset: 0, length: 64 },
    frontIndex: sourceEntry.frontIndex,
    frontIndexTail: {
      offset: 64,
      length: sourceEntry.frontIndex.length - 64
    }
  },
  selectedRendition: {
    id: selectedRendition.id,
    payloadBytes: selectedUnits.reduce((total, blob) => total + blob.length, 0),
    storageBytes: selectedUnits.reduce(
      (total, blob) => total + blob.storageLength,
      0
    )
  },
  initialStatic: {
    staticFrame: initialStatic.staticFrame,
    offset: initialStatic.storageOffset,
    length: initialStatic.storageLength
  },
  expectedRangePlans: {
    header: [{ offset: 0, length: 64 }],
    frontIndexTail: [{
      offset: 64,
      length: sourceEntry.frontIndex.length - 64
    }],
    currentStatic: coalesce([initialStatic]),
    allStatics: coalesce(statics),
    selectedRendition: coalesce(selectedUnits),
    allPayload: [{
      offset: sourceEntry.frontIndex.length,
      length: sourceBytes.byteLength - sourceEntry.frontIndex.length
    }]
  },
  blobs: storage,
  staticFirstOrder: [
    "metadata",
    `static:${initialStatic.staticFrame}`,
    "all-statics",
    ...sourceEntry.manifest.readiness.bootstrapUnits.map(
      (unit) => `unit:${selectedRendition.id}/${unit}`
    ),
    `all-units:${selectedRendition.id}`
  ],
  toolchain: sourceProvenance.toolchain
};
assertNoAbsolutePaths(provenance);
const serialized = `${JSON.stringify(provenance, null, 2)}\n`;

if (check) {
  const [outputBytes, currentProvenance] = await Promise.all([
    readFile(outputPath),
    readFile(provenancePath, "utf8")
  ]);
  requireValue(
    Buffer.compare(sourceBytes, outputBytes) === 0,
    "M7 reference asset is stale"
  );
  requireValue(currentProvenance === serialized, "M7 provenance is stale");
} else {
  await mkdir(outputRoot, { recursive: true });
  await copyFile(sourcePath, outputPath);
  await writeFile(provenancePath, serialized);
}

function coalesce(blobs) {
  if (blobs.length === 0) return [];
  const ordered = [...blobs].sort(
    (left, right) => left.storageOffset - right.storageOffset
  );
  const result = [];
  let start = ordered[0].storageOffset;
  let end = start + ordered[0].storageLength;
  for (const blob of ordered.slice(1)) {
    if (blob.storageOffset !== end) {
      result.push({ offset: start, length: end - start });
      start = blob.storageOffset;
    }
    end = blob.storageOffset + blob.storageLength;
  }
  result.push({ offset: start, length: end - start });
  return result;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireValue(value, message) {
  if (!value) throw new Error(message);
}

function assertNoAbsolutePaths(value, path = "provenance") {
  if (typeof value === "string") {
    requireValue(!value.startsWith("/"), `${path} contains an absolute path`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoAbsolutePaths(entry, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      assertNoAbsolutePaths(entry, `${path}.${key}`);
    }
  }
}
