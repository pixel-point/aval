#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import {
  parseCompileBundleReport,
  parseFrontIndex
} from "../../packages/format/dist/index.js";
import {
  SOURCE_CODEC_PRIORITY
} from "@pixel-point/aval-element";

const DEFAULT_REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const COMPILER_INSPECTOR = "packages/compiler/dist/cli.js";
const FOUR_CODEC_ORDER = SOURCE_CODEC_PRIORITY;

const RABBIT_UNITS = units([
  ["hover-in", "body", 67],
  ["hover-loop", "body", 96],
  ["hover-out", "body", 48],
  ["idle-loop", "body", 70],
  ["intro", "one-shot", 30]
]);

const KINETIC_ORB_UNITS = units([
  ["hover-in", "body", 12],
  ["hover-loop", "body", 24],
  ["hover-out", "body", 12],
  ["idle-loop", "body", 24],
  ["intro", "one-shot", 24]
]);

const PLAYGROUND_UNITS = units([
  ["engage.shift", "reversible", 6],
  ["engaged.body", "body", 8],
  ["idle.body", "body", 8]
]);

const BUNDLE_CONTRACTS = Object.freeze([
  Object.freeze({
    id: "grass-rabbit",
    directory: "examples/grass-rabbit/public/grass-rabbit",
    codecs: FOUR_CODEC_ORDER,
    frameRate: "24/1",
    units: RABBIT_UNITS,
    h264Codec: "avc1.42E01E",
    layout: "opaque",
    reentryMaxWaitFrames: 47,
    page: "examples/grass-rabbit/index.html",
    sourcePrefix: "%BASE_URL%grass-rabbit/"
  }),
  Object.freeze({
    id: "grass-rabbit-codecs",
    directory: "examples/grass-rabbit-codecs/public/grass-rabbit",
    codecs: FOUR_CODEC_ORDER,
    frameRate: "24/1",
    units: RABBIT_UNITS,
    h264Codec: "avc1.42E01F",
    layout: "opaque",
    reentryMaxWaitFrames: 47,
    dynamicPage: "examples/grass-rabbit-codecs/index.html",
    controller: "examples/grass-rabbit-codecs/codec-demo-controller.js",
    codecModel: "examples/grass-rabbit-codecs/codec-demo-model.js"
  }),
  Object.freeze({
    id: "kinetic-orb",
    directory: "examples/kinetic-orb/public/kinetic-orb",
    codecs: FOUR_CODEC_ORDER,
    frameRate: "24/1",
    units: KINETIC_ORB_UNITS,
    h264Codec: "avc1.42E01E",
    layout: "opaque",
    reentryMaxWaitFrames: 11,
    page: "examples/kinetic-orb/index.html",
    sourcePrefix: "%BASE_URL%kinetic-orb/"
  }),
  Object.freeze({
    id: "end-user-playground",
    directory: "examples/end-user-playground/public/favorite",
    codecs: FOUR_CODEC_ORDER,
    frameRate: "30/1",
    units: PLAYGROUND_UNITS,
    h264Codec: "avc1.42E00B",
    layout: "packed-alpha",
    page: "examples/end-user-playground/index.html",
    sourcePrefix: "/favorite/"
  })
]);

/**
 * Validate every checked-in browser demo asset against its compiler report,
 * generated page markup, authored state graph, and wire/output profile.
 *
 * The end-user Playground consumes the canonical wire-1.1 packed-alpha
 * certification bundle byte-for-byte. It is the sole current fixture
 * authority.
 */
export async function validateExampleAssets({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT
} = {}) {
  const root = path.resolve(repositoryRoot);
  const loadedBundles = [];

  for (const contract of BUNDLE_CONTRACTS) {
    loadedBundles.push(await loadBundle(root, contract));
  }

  // Run the public, built compiler inspector for all sixteen browser-facing
  // assets before performing any in-process manifest checks. Keeping this as a
  // separate pass makes the command itself a required part of the gate.
  const inspections = new Map();
  const inspectorFailures = [];
  for (const bundle of loadedBundles) {
    for (const codec of bundle.contract.codecs) {
      const assetPath = `${codec}.avl`;
      const assetFile = path.join(root, bundle.contract.directory, assetPath);
      try {
        inspections.set(
          inspectionKey(bundle.contract.id, codec),
          inspectWithBuiltCompiler(root, assetFile)
        );
      } catch (error) {
        inspectorFailures.push(
          `${bundle.contract.id}/${assetPath}: ${errorMessage(error)}`
        );
      }
    }
  }
  if (inspectorFailures.length > 0) {
    fail(`built compiler inspection failed:\n${inspectorFailures.join("\n")}`);
  }

  let packedWitnessesValidated = 0;
  for (const bundle of loadedBundles) {
    packedWitnessesValidated += await validateBundle(root, bundle, inspections);
  }
  expectEqual(packedWitnessesValidated, 4, "packed browser asset witness count");

  return Object.freeze({
    assetsInspected: inspections.size,
    bundlesValidated: Object.freeze(
      loadedBundles.map((bundle) => bundle.contract.id)
    ),
    wireAssetsValidated: inspections.size,
    packedWitnessesValidated,
    staticSourcePagesValidated: Object.freeze([
      "grass-rabbit",
      "kinetic-orb",
      "end-user-playground"
    ]),
    dynamicSourcePagesValidated: Object.freeze(["grass-rabbit-codecs"])
  });
}

async function loadBundle(root, contract) {
  const reportFile = path.join(root, contract.directory, "build.json");
  const rawReport = await readJson(reportFile);
  let report;
  try {
    report = parseCompileBundleReport(rawReport);
  } catch (error) {
    fail(`${contract.id} build report is invalid: ${errorMessage(error)}`);
  }
  return Object.freeze({ contract, report });
}

async function validateBundle(root, bundle, inspections) {
  const { contract, report } = bundle;
  let packedWitnessesValidated = 0;
  expectDeepEqual(
    report.assets.map((asset) => asset.codec),
    contract.codecs,
    `${contract.id} asset source order`
  );
  expectDeepEqual(
    report.encodings.map((encoding) => encoding.codec),
    contract.codecs,
    `${contract.id} encoding order`
  );
  expectDeepEqual(
    report.assets.map((asset) => asset.path),
    contract.codecs.map((codec) => `${codec}.avl`),
    `${contract.id} asset paths`
  );

  for (const asset of report.assets) {
    const assetFile = path.join(root, contract.directory, asset.path);
    const bytes = new Uint8Array(await readFile(assetFile));
    const sha256 = createHash("sha256").update(bytes).digest();
    const sha256Hex = sha256.toString("hex");
    const integrity = `sha256-${sha256.toString("base64")}`;
    const expectedMime = `application/vnd.aval; codecs="${asset.codecString}"`;

    expectEqual(bytes.byteLength, asset.bytes, `${contract.id}/${asset.path} bytes`);
    expectEqual(sha256Hex, asset.sha256, `${contract.id}/${asset.path} SHA-256`);
    expectEqual(integrity, asset.integrity, `${contract.id}/${asset.path} SRI`);
    expectEqual(asset.type, expectedMime, `${contract.id}/${asset.path} MIME type`);

    const inspection = requireInspection(inspections, contract.id, asset.codec);
    expectEqual(inspection.codec, asset.codec, `${contract.id}/${asset.path} inspected codec`);
    expectEqual(inspection.bytes, asset.bytes, `${contract.id}/${asset.path} inspected bytes`);
    expectEqual(inspection.sha256, asset.sha256, `${contract.id}/${asset.path} inspected SHA-256`);
    expectEqual(
      inspection.frameRate,
      contract.frameRate,
      `${contract.id}/${asset.path} frame rate`
    );
    expectDeepEqual(
      inspection.units,
      contract.units,
      `${contract.id}/${asset.path} units`
    );
    expect(
      inspection.renditionCodecs.length > 0,
      `${contract.id}/${asset.path} inspector returned no renditions`
    );
    expect(
      inspection.renditionCodecs.every((codec) => codec === asset.codecString),
      `${contract.id}/${asset.path} inspected rendition codec strings do not match ${asset.codecString}`
    );

    if (asset.codec === "h264") {
      expectEqual(
        asset.codecString,
        contract.h264Codec,
        `${contract.id} constrained-baseline H.264 codec`
      );
    }

    const frontIndex = parseFrontIndex(bytes);
    packedWitnessesValidated += validateAssetWireProfile(
      contract,
      report,
      asset,
      frontIndex
    );

    if (contract.reentryMaxWaitFrames !== undefined) {
      validateReentryEdge(
        contract.id,
        asset.path,
        frontIndex.manifest.edges,
        contract.reentryMaxWaitFrames
      );
    }
  }

  if (contract.page !== undefined) {
    await validateStaticSourceMarkup(root, bundle);
  } else {
    await validateDynamicCodecChooser(root, bundle);
  }
  return packedWitnessesValidated;
}

function validateAssetWireProfile(contract, report, asset, frontIndex) {
  const label = `${contract.id}/${asset.path}`;
  expectEqual(frontIndex.header.major, 1, `${label} wire major`);
  expectEqual(frontIndex.header.minor, 1, `${label} wire minor`);
  expectEqual(frontIndex.manifest.formatVersion, "1.1", `${label} manifest version`);
  expectEqual(frontIndex.manifest.layout, contract.layout, `${label} video layout`);
  expectEqual(frontIndex.manifest.renditions.length, 1, `${label} rendition count`);

  const rendition = frontIndex.manifest.renditions[0];
  expect(rendition !== undefined, `${label} has no rendition`);
  const codecVerificationInvocations = report.invocations.filter(({ operation }) =>
    operation.startsWith(`${asset.codec}:`) &&
    operation.endsWith(":verify-packed-alpha")
  );

  if (contract.layout === "opaque") {
    expectEqual(rendition.alphaLayout.type, "opaque", `${label} alpha layout`);
    expect(
      !("outputQualification" in rendition),
      `${label} opaque rendition unexpectedly carries output qualification`
    );
    expectEqual(
      codecVerificationInvocations.length,
      0,
      `${label} packed-alpha verification invocation count`
    );
    return 0;
  }

  expectEqual(rendition.alphaLayout.type, "stacked", `${label} alpha layout`);
  const witness = rendition.outputQualification;
  expect(witness !== undefined, `${label} packed rendition has no output qualification`);
  const expectedOperation =
    `${asset.codec}:${rendition.id}:${witness.unit}:verify-packed-alpha`;
  expectEqual(
    codecVerificationInvocations.length,
    1,
    `${label} packed-alpha verification invocation count`
  );
  const invocation = codecVerificationInvocations[0];
  expect(invocation !== undefined, `${label} packed-alpha verification invocation is missing`);
  expectEqual(invocation.operation, expectedOperation, `${label} verification operation`);
  expectEqual(invocation.tool, "ffmpeg", `${label} verification tool`);
  expectArgumentPair(
    invocation.arguments,
    "-f",
    verificationInputFormat(asset.codec),
    `${label} verification input format`
  );
  expectArgumentPair(
    invocation.arguments,
    "-vf",
    `select=eq(n\\,${String(witness.frame)}),format=rgba`,
    `${label} verification frame`
  );
  expectArgumentPair(
    invocation.arguments,
    "-pix_fmt",
    "rgba",
    `${label} verification output format`
  );
  return 1;
}

function verificationInputFormat(codec) {
  if (codec === "av1" || codec === "vp9") return "ivf";
  if (codec === "h265") return "hevc";
  return "h264";
}

function expectArgumentPair(arguments_, flag, value, label) {
  const found = arguments_.some((argument, index) =>
    argument === flag && arguments_[index + 1] === value
  );
  expect(found, `${label}: expected ${format(flag)} followed by ${format(value)}`);
}

function inspectWithBuiltCompiler(root, assetFile) {
  const command = spawnSync(
    process.execPath,
    [path.join(root, COMPILER_INSPECTOR), "inspect", assetFile, "--json"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024
    }
  );
  if (command.error !== undefined) throw command.error;
  if (command.status !== 0) {
    const detail = command.stderr.trim() || command.stdout.trim() || "no diagnostic output";
    fail(`inspector exited with status ${String(command.status)}: ${detail}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(command.stdout);
  } catch (error) {
    fail(`inspector did not emit JSON: ${errorMessage(error)}`);
  }
  expectObject(parsed, `${assetFile} inspector result`);
  expect(Array.isArray(parsed.units), `${assetFile} inspector units are missing`);
  expect(Array.isArray(parsed.renditions), `${assetFile} inspector renditions are missing`);

  return Object.freeze({
    bytes: parsed.bytes,
    codec: parsed.codec,
    frameRate: parsed.frameRate,
    sha256: parsed.sha256,
    units: parsed.units.map((unit) => Object.freeze({
      id: unit.id,
      kind: unit.kind,
      frames: unit.frames,
      startFrame: unit.startFrame,
      endFrame: unit.endFrame
    })),
    renditionCodecs: Object.freeze(
      parsed.renditions.map((rendition) => rendition.codec)
    )
  });
}

function validateReentryEdge(bundleId, assetPath, edges, maxWaitFrames) {
  const matchingEdges = edges.filter((edge) => edge.id === "exiting.entering");
  expectEqual(
    matchingEdges.length,
    1,
    `${bundleId}/${assetPath} exiting.entering edge count`
  );
  expectDeepEqual(
    matchingEdges[0],
    {
      id: "exiting.entering",
      from: "exiting",
      to: "entering",
      start: {
        type: "finish",
        targetPort: "default",
        maxWaitFrames
      },
      continuity: "exact-authored",
      trigger: {
        type: "event",
        name: "hover.enter"
      }
    },
    `${bundleId}/${assetPath} exiting.entering edge`
  );
}

async function validateStaticSourceMarkup(root, bundle) {
  const { contract, report } = bundle;
  const page = await readFile(path.join(root, contract.page), "utf8");
  const actual = extractSourceElements(page, contract.page);
  const generated = extractSourceElements(
    report.sourceMarkup,
    `${contract.directory}/build.json#sourceMarkup`
  );
  const expected = generated.map((source) => Object.freeze({
    ...source,
    src: `${contract.sourcePrefix}${source.src}`
  }));
  expectDeepEqual(actual, expected, `${contract.id} checked-in source markup`);
}

async function validateDynamicCodecChooser(root, bundle) {
  const { contract, report } = bundle;
  const page = await readFile(path.join(root, contract.dynamicPage), "utf8");
  expectEqual(
    extractSourceElements(page, contract.dynamicPage).length,
    0,
    `${contract.id} static source count`
  );

  const controller = await readFile(path.join(root, contract.controller), "utf8");
  const model = await import(pathToFileURL(path.join(root, contract.codecModel)).href);
  expectDeepEqual(
    model.CODECS,
    report.assets.map(({ codec }) => codec),
    `${contract.id} automatic codec order`
  );
  const creations = controller.match(
    /document\.createElement\(\s*["']source["']\s*\)/gu
  ) ?? [];
  expectEqual(creations.length, 1, `${contract.id} dynamic source creation count`);
  expectMatch(
    controller,
    /const\s+AUTOMATIC_ACTIVATION\s*=\s*Object\.freeze\(/u,
    `${contract.id} automatic activation declaration`
  );
  expectMatch(
    controller,
    /sourceCodecs\s*:\s*CODECS\s*[,}]/u,
    `${contract.id} exact automatic source ladder`
  );
  expectMatch(
    controller,
    /const\s+player\s*=\s*createPlayer\(\s*activation\.sourceCodecs\s*\)\s*;/u,
    `${contract.id} activation source attachment`
  );
  expectMatch(
    controller,
    /for\s*\(\s*const\s+codec\s+of\s+codecs\s*\)/u,
    `${contract.id} ordered source loop`
  );
  expectMatch(
    controller,
    /const\s+asset\s*=\s*requireMapValue\(\s*report\.assets\s*,\s*codec\s*\)\s*;/u,
    `${contract.id} report asset lookup`
  );
  expectMatch(
    controller,
    /source\.src\s*=\s*new URL\(\s*`grass-rabbit\/\$\{asset\.path\}`\s*,\s*publicBaseUrl\s*\)\.href\s*;/u,
    `${contract.id} dynamic source path`
  );
  expectMatch(
    controller,
    /source\.setAttribute\(\s*["']data-codec["']\s*,\s*codec\s*\)\s*;/u,
    `${contract.id} dynamic source codec family`
  );
  expectMatch(
    controller,
    /source\.setAttribute\(\s*["']integrity["']\s*,\s*asset\.integrity\s*\)\s*;/u,
    `${contract.id} dynamic source integrity`
  );
  expectMatch(
    controller,
    /player\.append\(\s*source\s*\)\s*;/u,
    `${contract.id} dynamic source attachment`
  );
}

function extractSourceElements(markup, label) {
  const tags = markup.match(/<source\b[^>]*>/giu) ?? [];
  return tags.map((tag, index) => {
    const attributes = {};
    const body = tag.replace(/^<source\b/iu, "").replace(/>$/u, "");
    const pattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
    for (const match of body.matchAll(pattern)) {
      attributes[match[1].toLowerCase()] = match[2] ?? match[3];
    }
    expectEqual(
      Object.keys(attributes).sort().join(","),
      "data-codec,integrity,src",
      `${label} source ${String(index)} attributes`
    );
    return Object.freeze({
      src: attributes.src,
      codec: attributes["data-codec"],
      integrity: attributes.integrity
    });
  });
}

function units(entries) {
  let startFrame = 0;
  return Object.freeze(entries.map(([id, kind, frames]) => {
    const unit = Object.freeze({
      id,
      kind,
      frames,
      startFrame,
      endFrame: startFrame + frames
    });
    startFrame = unit.endFrame;
    return unit;
  }));
}

async function readJson(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    fail(`${file} could not be read: ${errorMessage(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${file} is not JSON: ${errorMessage(error)}`);
  }
}

function requireInspection(inspections, bundleId, codec) {
  const inspection = inspections.get(inspectionKey(bundleId, codec));
  expect(inspection !== undefined, `missing compiler inspection for ${bundleId}/${codec}`);
  return inspection;
}

function inspectionKey(bundleId, codec) {
  return `${bundleId}:${codec}`;
}

function expectObject(value, label) {
  expect(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`
  );
}

function expectMatch(value, pattern, label) {
  expect(pattern.test(value), `${label} does not match the generated-asset contract`);
}

function expectEqual(actual, expected, label) {
  if (!Object.is(actual, expected)) {
    fail(`${label}: expected ${format(expected)}, received ${format(actual)}`);
  }
}

function expectDeepEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    fail(`${label} differs\nexpected: ${format(expected)}\nreceived: ${format(actual)}`);
  }
}

function expect(condition, message) {
  if (!condition) fail(message);
}

function format(value) {
  return typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value, null, 2);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(message) {
  throw new Error(message);
}

async function runFromCommandLine() {
  try {
    const result = await validateExampleAssets();
    console.log(
      `Validated ${String(result.assetsInspected)} assets across ` +
      `${String(result.bundlesValidated.length)} browser example bundles.`
    );
  } catch (error) {
    console.error(`Example asset validation failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await runFromCommandLine();
}
