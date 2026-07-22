import {
  parseCompileBundleReport,
  parseVideoCodecString
} from "@pixel-point/aval-format";
import { SOURCE_CODEC_PRIORITY } from "@pixel-point/aval-element";

/** AVAL's fixed runtime family priority, independent of compiler order. */
export const CODECS = SOURCE_CODEC_PRIORITY;

const CODEC_LABELS = Object.freeze({
  av1: "AV1",
  vp9: "VP9",
  h265: "H.265 / HEVC",
  h264: "H.264 / AVC"
});

export const UNSUPPORTED_MESSAGE = "This codec is not supported in your browser.";
export const UNAVAILABLE_MESSAGE = "Codec support could not be checked in your browser.";
export const PLAYBACK_FAILURE_MESSAGE = "This codec could not be played in your browser.";
export const INACTIVE_PLAYBACK_MESSAGE = "Motion is waiting for interactive playback…";
export const BT709_LIMITED = Object.freeze({
  primaries: "bt709",
  transfer: "bt709",
  matrix: "bt709",
  fullRange: false
});
export const RENDERED_READINESS = new Set([
  "visualReady",
  "interactiveReady"
]);

export function parseGrassRabbitReport(value) {
  const report = parseCompileBundleReport(value);
  const assets = new Map(report.assets.map((asset) => [asset.codec, asset]));
  const encodings = new Map(report.encodings.map((encoding) => [encoding.codec, encoding]));

  for (const codec of CODECS) {
    const asset = assets.get(codec);
    const encoding = encodings.get(codec);
    const rendition = encoding?.renditions[0];
    if (
      asset === undefined ||
      encoding === undefined ||
      encoding.renditions.length !== 1 ||
      rendition?.width !== 1280 ||
      rendition.height !== 720
    ) {
      throw new TypeError(`Grass rabbit report is missing its 1280 × 720 ${codec} rendition.`);
    }
  }

  return Object.freeze({
    ...report,
    assets,
    encodings
  });
}

export function representativeFfmpegCommands(report, codec) {
  const prefix = `${codec}:`;
  const scale = report.invocations.find((invocation) =>
    invocation.operation.startsWith(prefix) && invocation.operation.endsWith(":scale-rgba")
  );
  const encode = report.invocations.find((invocation) =>
    invocation.operation.startsWith(prefix) && invocation.operation.endsWith(":encode")
  );
  if (scale === undefined || encode === undefined) {
    throw new TypeError(`Grass rabbit report has no representative ${codec} FFmpeg pipeline.`);
  }
  return [
    `# ${scale.operation}`,
    formatInvocation(scale),
    "",
    `# ${encode.operation}`,
    formatInvocation(encode)
  ].join("\n");
}

export function codecLabel(codec) {
  const label = CODEC_LABELS[codec];
  if (label === undefined) throw new Error(`Missing codec label: ${String(codec)}.`);
  return label;
}

export function assertCodec(value) {
  if (!CODECS.includes(value)) {
    throw new TypeError("Codec must be one of av1, vp9, h265, or h264.");
  }
}

export function runtimeCodecFamily(value) {
  const parsed = typeof value === "string"
    ? parseVideoCodecString(value)
    : undefined;
  if (parsed === undefined || !CODECS.includes(parsed.family)) {
    throw new TypeError("Prepared codec must identify an authored codec family.");
  }
  return parsed.family;
}

export function supportLabel(state) {
  if (state === "supported") return "Supported";
  if (state === "unsupported") return "Unsupported";
  return "Unavailable";
}

export function formatInteger(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

export function formatMebibytes(value) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value / (1024 * 1024));
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireMapValue(map, key) {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Missing codec value: ${String(key)}.`);
  return value;
}

export function requireElement(selector, root = document) {
  const element = root.querySelector(selector);
  if (element === null) throw new Error(`Missing codec example element: ${selector}.`);
  return element;
}

function formatInvocation(invocation) {
  return [invocation.tool, ...invocation.arguments]
    .map(shellArgument)
    .join(" \\\n  ");
}

function shellArgument(value) {
  if (/^[A-Za-z0-9_./,:=+@%-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
