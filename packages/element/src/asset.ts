export type Codec = "h264" | "h265" | "vp9" | "av1";
export type Bitstream = "annex-b" | "frame" | "low-overhead";
export type Rect = readonly [number, number, number, number];
export type BindingSource =
  | "activate" | "engagement.off" | "engagement.on" | "focus.in" | "focus.out"
  | "hidden" | "pointer.enter" | "pointer.leave" | "visible";

export interface Source {
  readonly src: string;
  readonly type?: `application/vnd.aval; codecs="${string}"`;
  readonly codec: string;
  readonly integrity: string;
}

export interface AssetPlatform {
  readonly fetch: typeof globalThis.fetch;
  readonly crypto: Crypto;
  readonly setTimeout?: (callback: () => void, delay: number) => number;
  readonly clearTimeout?: (handle: number) => void;
}

export interface PackedAlphaWitnessSampleV1 {
  readonly x: number;
  readonly y: number;
  readonly expectedRange: readonly [minimum: number, maximum: number];
}

export interface PackedAlphaWitnessV1 {
  readonly kind: "packed-alpha-v1";
  readonly unit: string;
  readonly frame: number;
  readonly samples: readonly Readonly<PackedAlphaWitnessSampleV1>[];
}

interface RenditionBase {
  readonly id: string;
  readonly codec: string;
  readonly bitDepth: 8 | 10;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly bitrate: { readonly average: number; readonly peak: number };
}

export interface LegacyRendition extends RenditionBase {
  readonly alphaLayout:
    | { readonly type: "opaque"; readonly colorRect: Rect }
    | {
        readonly type: "stacked";
        readonly colorRect: Rect;
        readonly alphaRect: Rect;
      };
  readonly outputQualification?: never;
}

export interface OpaqueQualifiedRendition extends RenditionBase {
  readonly alphaLayout: { readonly type: "opaque"; readonly colorRect: Rect };
  readonly outputQualification?: never;
}

export interface PackedAlphaQualifiedRendition extends RenditionBase {
  readonly alphaLayout: {
    readonly type: "stacked";
    readonly colorRect: Rect;
    readonly alphaRect: Rect;
  };
  readonly outputQualification: PackedAlphaWitnessV1;
}

export type Rendition =
  | LegacyRendition
  | OpaqueQualifiedRendition
  | PackedAlphaQualifiedRendition;

export interface UnitSpan {
  readonly rendition: string;
  readonly chunkStart: number;
  readonly chunkCount: number;
  readonly frameCount: number;
  readonly sha256: string;
}

interface UnitBase {
  readonly id: string;
  readonly frameCount: number;
  readonly chunks: readonly UnitSpan[];
}

export type Unit =
  | (UnitBase & {
      readonly kind: "body";
      readonly playback: "loop" | "finite";
      readonly ports: readonly {
        readonly id: string;
        readonly entryFrame: 0;
        readonly portalFrames: readonly number[];
      }[];
    })
  | (UnitBase & { readonly kind: "bridge" | "one-shot" })
  | (UnitBase & {
      readonly kind: "reversible";
      readonly residency: {
        readonly endpoints: readonly [
          { readonly state: string; readonly port: string; readonly frames: number },
          { readonly state: string; readonly port: string; readonly frames: number }
        ];
      };
    });

interface EdgeBase {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly trigger?:
    | { readonly type: "event"; readonly name: string }
    | { readonly type: "completion" };
}

export type Edge = EdgeBase & (
  | {
      readonly start:
        | {
        readonly type: "portal";
        readonly sourcePort: string;
        readonly targetPort: string;
        readonly maxWaitFrames: number;
      }
        | {
        readonly type: "finish";
        readonly targetPort: string;
        readonly maxWaitFrames: number;
      };
      readonly transition?:
        | { readonly kind: "locked"; readonly unit: string }
        | {
        readonly kind: "reversible";
        readonly unit: string;
        readonly direction: "forward" | "reverse";
        readonly reverseOf?: string;
      };
      readonly continuity: "exact-authored" | "exact-reverse";
      readonly targetRunwayFrames?: never;
    }
  | {
      readonly start: {
        readonly type: "cut";
        readonly targetPort: string;
        readonly maxWaitFrames: 1;
      };
      readonly transition?: never;
      readonly continuity: "cut";
      readonly targetRunwayFrames: number;
    }
);

interface ManifestBase {
  readonly generator: string;
  readonly codec: Codec;
  readonly bitstream: Bitstream;
  readonly canvas: {
    readonly width: number;
    readonly height: number;
    readonly fit: "contain" | "cover" | "fill" | "none";
    readonly pixelAspect: readonly [number, number];
    readonly colorSpace: "srgb";
  };
  readonly frameRate: { readonly numerator: number; readonly denominator: number };
  readonly units: readonly Unit[];
  readonly initialState: string;
  readonly states: readonly {
    readonly id: string;
    readonly bodyUnit: string;
    readonly initialUnit?: string;
  }[];
  readonly edges: readonly Edge[];
  readonly bindings: readonly { readonly source: BindingSource; readonly event: string }[];
  readonly readiness: {
    readonly policy: "all-routes";
    readonly bootstrapUnits: readonly string[];
    readonly immediateEdges: readonly string[];
  };
  readonly limits: {
    readonly maxCompiledBytes: number;
    readonly maxRuntimeBytes: number;
    readonly decodedPixelBytes: number;
    readonly persistentCacheBytes: number;
    readonly runtimeWorkingSetBytes: number;
  };
}

export interface LegacyManifest extends ManifestBase {
  readonly formatVersion: "1.0";
  readonly layout: "opaque" | "packed-alpha";
  readonly renditions: readonly LegacyRendition[];
}

export interface OpaqueQualifiedManifest extends ManifestBase {
  readonly formatVersion: "1.1";
  readonly layout: "opaque";
  readonly renditions: readonly OpaqueQualifiedRendition[];
}

export interface PackedAlphaQualifiedManifest extends ManifestBase {
  readonly formatVersion: "1.1";
  readonly layout: "packed-alpha";
  readonly renditions: readonly PackedAlphaQualifiedRendition[];
}

export type Manifest =
  | LegacyManifest
  | OpaqueQualifiedManifest
  | PackedAlphaQualifiedManifest;

export interface AssetRecord {
  readonly offset: number;
  readonly length: number;
  readonly presentationTimestamp: number;
  readonly duration: number;
  readonly randomAccess: boolean;
  readonly displayedFrameCount: number;
}

export interface Blob {
  readonly rendition: string;
  readonly unit: string;
  readonly chunkStart: number;
  readonly chunkCount: number;
  readonly frameCount: number;
  readonly sha256: string;
  readonly offset: number;
  readonly length: number;
}

export interface AssetSnapshot {
  readonly mode: "range" | "full";
  readonly disposed: boolean;
  readonly declaredFileBytes: number;
  readonly metadataBytes: number;
  readonly verifiedBytes: number;
  readonly residentBlobBytes: number;
  readonly requestCount: number;
  readonly rangeRequestCount: number;
  readonly fullRequestCount: number;
  readonly activeTransportBodies: number;
  readonly pendingLoads: number;
  readonly interestedWaiters: number;
  readonly transportBytes: number;
  readonly blobs: {
    readonly total: number;
    readonly absent: number;
    readonly loading: number;
    readonly verified: number;
  };
}

type Obj = Record<string, unknown>;
type Header = {
  major: 1;
  minor: 0 | 1;
  declared: number;
  manifestLength: number;
  indexOffset: number;
  indexLength: number;
  frontEnd: number;
};
type Parsed = {
  header: Header;
  manifest: Manifest;
  records: readonly AssetRecord[];
  blobs: readonly Blob[];
  padding: readonly { offset: number; length: number }[];
};
type Metrics = {
  requests: number;
  ranges: number;
  full: number;
  active: number;
  bytes: number;
};
type LoadWaiter = {
  readonly signal: AbortSignal | undefined;
  readonly resolve: (value: Uint8Array<ArrayBuffer>) => void;
  readonly reject: (error: unknown) => void;
  abort: (() => void) | undefined;
  settled: boolean;
};
type Load = {
  readonly key: string;
  readonly controller: AbortController;
  readonly promise: Promise<Uint8Array<ArrayBuffer>>;
  readonly waiters: Set<LoadWaiter>;
  readonly timer: number;
};
type BodyWaiter = {
  readonly signal: AbortSignal;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly abort: () => void;
  settled: boolean;
};

const MAGIC = [0x41, 0x56, 0x4c, 0x46, 13, 10, 26, 10];
const ID = /^[a-z][a-z0-9._-]{0,63}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX = Number.MAX_SAFE_INTEGER;
const U32 = 0xffff_ffff;
const B = {
  manifest: 1024 * 1024,
  depth: 64,
  nodes: 20_000,
  string: 4096,
  states: 32,
  edges: 64,
  units: 96,
  renditions: 4,
  bindings: 32,
  blobs: 128,
  ports: 16
} as const;
const TOP = [
  "formatVersion", "generator", "codec", "bitstream", "layout", "canvas",
  "frameRate", "renditions", "units", "initialState", "states", "edges",
  "bindings", "readiness", "limits"
];
const BINDINGS = new Set([
  "activate", "engagement.off", "engagement.on", "focus.in", "focus.out",
  "hidden", "pointer.enter", "pointer.leave", "visible"
]);
const EMPTY = new Uint8Array(0);
const RESPONSE_WATCHDOGS = new WeakMap<Response, Watchdog>();
const UTF8 = new TextEncoder();
const OVERALL_MS = 5_000;
const BODY_MS = 2_000;

type Watchdog = {
  readonly controller: AbortController;
  readonly signal: AbortSignal | undefined;
  abort: (() => void) | undefined;
  readonly waits: Set<(error: unknown) => void>;
  readonly setTimeout: (callback: () => void, delay: number) => number;
  readonly clearTimeout: (handle: number) => void;
  overall: number | undefined;
  body: number | undefined;
};

function bad(): never {
  throw new Error("Invalid AVAL asset");
}

function object(value: unknown): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) bad();
  return value as Obj;
}

function shape(value: Obj, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (keys.length < required.length || keys.some((key) => !allowed.has(key))) bad();
  for (const key of required) if (!Object.hasOwn(value, key)) bad();
}

function array(value: unknown, minimum: number, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) bad();
  return value;
}

function integer(value: unknown, minimum = 0, maximum = MAX): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) bad();
  return value;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) bad();
  return value;
}

function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) bad();
  return value as T;
}

function ordered(values: readonly string[]): void {
  for (let i = 1; i < values.length; i += 1) if (values[i - 1]! >= values[i]!) bad();
}

function add(a: number, b: number, maximum = MAX): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0 || a > maximum - b) bad();
  return a + b;
}

function align8(value: number): number {
  return add(value, (8 - value % 8) % 8);
}

function zero(bytes: Uint8Array, offset: number, length: number): void {
  const end = add(offset, length, bytes.byteLength);
  for (let i = offset; i < end; i += 1) if (bytes[i] !== 0) bad();
}

function read64(view: DataView, offset: number): number {
  const value = Number(view.getBigUint64(offset, true));
  if (!Number.isSafeInteger(value)) bad();
  return value;
}

function codec(value: unknown): { family: Codec; bitDepth: 8 | 10 } {
  if (typeof value !== "string") bad();
  if (/^avc1\.(?:42E0|6400)(?:0A|0B|0C|0D|14|15|16|1E|1F|20|28|29|2A|32|33|34|3C|3D|3E)$/.test(value)) {
    return { family: "h264", bitDepth: 8 };
  }
  const h265 = /^hvc1\.1\.(0|[1-9A-F][0-9A-F]*)\.[LH](0|[1-9][0-9]*)\.((?:[0-9A-F]{2}\.){0,5}(?!00)[0-9A-F]{2})$/.exec(value);
  if (h265 !== null) {
    const flags = Number.parseInt(h265[1]!, 16);
    const level = Number(h265[2]);
    const first = Number.parseInt(h265[3]!.slice(0, 2), 16);
    if (flags <= U32 && (flags & 2) !== 0 && level >= 1 && level <= 255 &&
      (first & 0x80) !== 0 && (first & 0x40) === 0 && (first & 0x10) !== 0) {
      return { family: "h265", bitDepth: 8 };
    }
  }
  if (/^vp09\.00\.(?:10|11|20|21|30|31|40|41|50|51|52|60|61|62)\.08(?:\.01\.01\.01\.01\.00)?$/.test(value)) {
    return { family: "vp9", bitDepth: 8 };
  }
  const av1 = /^av01\.0\.(?:0[0-9]|[12][0-9]|3[01])[MH]\.(08|10)(?:\.0\.11[0-3]\.01\.01\.01\.0)?$/.exec(value);
  if (av1 !== null) return { family: "av1", bitDepth: av1[1] === "10" ? 10 : 8 };
  return bad();
}

function canonicalJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength > B.manifest) bad();
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return bad();
  }
  const state = { nodes: 0 };
  const text = canonical(value, 1, state);
  const encoded = UTF8.encode(text);
  if (encoded.byteLength !== bytes.byteLength) bad();
  for (let i = 0; i < bytes.byteLength; i += 1) if (bytes[i] !== encoded[i]) bad();
  return value;
}

function canonical(value: unknown, depth: number, state: { nodes: number }): string {
  if (depth > B.depth || ++state.nodes > B.nodes) bad();
  if (value === null || typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) bad();
    return String(value);
  }
  if (typeof value === "string") {
    validString(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item, depth + 1, state)).join(",")}]`;
  }
  const input = object(value);
  const keys = Object.keys(input).map((key) => [key, stringBytes(key)] as const);
  if (keys.some(([key]) => key === "__proto__" || key === "prototype" || key === "constructor")) bad();
  keys.sort((a, b) => {
    const x = a[1];
    const y = b[1];
    for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
      if (x[i] !== y[i]) return x[i]! - y[i]!;
    }
    return x.length - y.length;
  });
  return `{${keys.map(([key]) => {
    return `${JSON.stringify(key)}:${canonical(input[key], depth + 1, state)}`;
  }).join(",")}}`;
}

function validString(value: string): void {
  stringBytes(value);
}

function stringBytes(value: string): Uint8Array {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (next < 0xdc00 || next > 0xdfff) bad();
    } else if (code >= 0xdc00 && code <= 0xdfff) bad();
  }
  const bytes = UTF8.encode(value);
  if (bytes.byteLength > B.string) bad();
  return bytes;
}

function validateManifest(value: unknown): Manifest {
  const m = object(value);
  shape(m, TOP);
  const formatVersion = choice(m.formatVersion, ["1.0", "1.1"] as const);
  if (typeof m.generator !== "string") bad();
  const generatorBytes = UTF8.encode(m.generator).byteLength;
  if (generatorBytes < 1 || generatorBytes > 128 || /[\u0000-\u001f]/.test(m.generator)) bad();
  const family = choice(m.codec, ["h264", "h265", "vp9", "av1"] as const);
  const bitstream = choice(m.bitstream, ["annex-b", "frame", "low-overhead"] as const);
  if (bitstream !== ({ h264: "annex-b", h265: "annex-b", vp9: "frame", av1: "low-overhead" } as const)[family]) bad();
  const layout = choice(m.layout, ["opaque", "packed-alpha"] as const);

  const canvas = object(m.canvas);
  shape(canvas, ["width", "height", "fit", "pixelAspect", "colorSpace"]);
  const width = integer(canvas.width, 1, U32);
  const height = integer(canvas.height, 1, U32);
  choice(canvas.fit, ["contain", "cover", "fill", "none"] as const);
  const aspect = array(canvas.pixelAspect, 2, 2);
  integer(aspect[0], 1, 10_000);
  integer(aspect[1], 1, 10_000);
  if (canvas.colorSpace !== "srgb") bad();
  const rate = object(m.frameRate);
  shape(rate, ["numerator", "denominator"]);
  const denominator = integer(rate.denominator, 1, 1001);
  if (integer(rate.numerator, 1) > denominator * 60) bad();

  const renditionValues = array(m.renditions, 1, B.renditions);
  const renditionIds = new Set<string>();
  for (const value of renditionValues) {
    const rendition = object(value);
    const renditionKeys = [
      "id", "codec", "bitDepth", "codedWidth", "codedHeight", "alphaLayout", "bitrate"
    ];
    if (formatVersion === "1.1" && layout === "packed-alpha") {
      shape(rendition, [...renditionKeys, "outputQualification"]);
    } else {
      shape(rendition, renditionKeys);
    }
    const rid = identifier(rendition.id);
    if (renditionIds.has(rid)) bad();
    renditionIds.add(rid);
    const depth = integer(rendition.bitDepth, 8, 10);
    if (depth !== 8 && depth !== 10 || family !== "av1" && depth !== 8) bad();
    const syntax = codec(rendition.codec);
    if (syntax.family !== family || syntax.bitDepth !== depth) bad();
    const codedWidth = integer(rendition.codedWidth, 1, U32);
    const codedHeight = integer(rendition.codedHeight, 1, U32);
    if (codedWidth % 2 !== 0 || codedHeight % 2 !== 0) bad();
    const alphaRect = validateAlpha(
      rendition.alphaLayout,
      layout,
      width,
      height,
      codedWidth,
      codedHeight
    );
    if (formatVersion === "1.1" && layout === "packed-alpha") {
      if (alphaRect === null) bad();
      validatePackedAlphaWitness(rendition.outputQualification, alphaRect);
    }
    const bitrate = object(rendition.bitrate);
    shape(bitrate, ["average", "peak"]);
    if (integer(bitrate.average, 1) > integer(bitrate.peak, 1)) bad();
  }

  const unitValues = array(m.units, 1, B.units);
  if (unitValues.length * renditionValues.length > B.blobs) bad();
  let totalFrames = 0;
  for (const value of unitValues) {
    const unit = object(value);
    const kind = choice(unit.kind, ["body", "bridge", "reversible", "one-shot"] as const);
    if (kind === "body") shape(unit, ["id", "kind", "playback", "frameCount", "ports", "chunks"]);
    else if (kind === "reversible") shape(unit, ["id", "kind", "frameCount", "residency", "chunks"]);
    else shape(unit, ["id", "kind", "frameCount", "chunks"]);
    identifier(unit.id);
    const frameCount = integer(unit.frameCount, 1, U32);
    totalFrames = add(totalFrames, frameCount, U32);
    if (kind === "body") {
      const playback = choice(unit.playback, ["loop", "finite"] as const);
      if (playback === "loop" && frameCount < 2) bad();
      const ports = array(unit.ports, 0, B.ports);
      const portIds: string[] = [];
      for (const value of ports) {
        const port = object(value);
        shape(port, ["id", "entryFrame", "portalFrames"]);
        portIds.push(identifier(port.id));
        if (port.entryFrame !== 0) bad();
        const frames = array(port.portalFrames, 1, frameCount).map((frame) => integer(frame, 0, frameCount - 1));
        for (let i = 1; i < frames.length; i += 1) if (frames[i - 1]! >= frames[i]!) bad();
      }
      ordered(portIds);
    } else if (kind === "reversible") {
      const residency = object(unit.residency);
      shape(residency, ["endpoints"]);
      const endpoints = array(residency.endpoints, 2, 2);
      const ids: string[] = [];
      for (const value of endpoints) {
        const endpoint = object(value);
        shape(endpoint, ["state", "port", "frames"]);
        ids.push(`${identifier(endpoint.state)}\0${identifier(endpoint.port)}`);
        integer(endpoint.frames, 6, 12);
      }
      ordered(ids);
    }
    const spans = array(unit.chunks, renditionValues.length, renditionValues.length);
    for (let i = 0; i < spans.length; i += 1) {
      const span = object(spans[i]);
      shape(span, ["rendition", "chunkStart", "chunkCount", "frameCount", "sha256"]);
      if (identifier(span.rendition) !== identifier(object(renditionValues[i]).id)) bad();
      integer(span.chunkStart);
      integer(span.chunkCount, 1);
      if (integer(span.frameCount, 1) !== frameCount || typeof span.sha256 !== "string" || !DIGEST.test(span.sha256)) bad();
    }
  }
  ordered(unitValues.map((value) => identifier(object(value).id)));
  let ordinal = 0;
  for (let r = 0; r < renditionValues.length; r += 1) {
    for (const value of unitValues) {
      const span = object(array(object(value).chunks, renditionValues.length, renditionValues.length)[r]);
      if (span.chunkStart !== ordinal) bad();
      ordinal = add(ordinal, integer(span.chunkCount, 1), U32);
    }
  }

  identifier(m.initialState);
  const states = array(m.states, 1, B.states);
  for (const value of states) {
    const state = object(value);
    shape(state, ["id", "bodyUnit"], ["initialUnit"]);
    identifier(state.id);
    identifier(state.bodyUnit);
    if (Object.hasOwn(state, "initialUnit")) identifier(state.initialUnit);
  }
  ordered(states.map((value) => identifier(object(value).id)));
  const edges = array(m.edges, 0, B.edges);
  for (const value of edges) validateEdge(value);
  ordered(edges.map((value) => identifier(object(value).id)));
  const bindings = array(m.bindings, 0, B.bindings);
  let previousBinding = "";
  const sources = new Set<string>();
  for (const value of bindings) {
    const binding = object(value);
    shape(binding, ["source", "event"]);
    if (typeof binding.source !== "string" || !BINDINGS.has(binding.source)) bad();
    const key = `${binding.source}\0${identifier(binding.event)}`;
    if (key <= previousBinding || sources.has(binding.source)) bad();
    previousBinding = key;
    sources.add(binding.source);
  }
  const readiness = object(m.readiness);
  shape(readiness, ["policy", "bootstrapUnits", "immediateEdges"]);
  if (readiness.policy !== "all-routes") bad();
  for (const field of ["bootstrapUnits", "immediateEdges"] as const) {
    const values = array(readiness[field], 0, field === "bootstrapUnits" ? B.units : B.edges).map(identifier);
    ordered(values);
  }
  const limits = object(m.limits);
  shape(limits, ["maxCompiledBytes", "maxRuntimeBytes", "decodedPixelBytes", "persistentCacheBytes", "runtimeWorkingSetBytes"]);
  integer(limits.maxCompiledBytes, 1);
  const runtime = integer(limits.maxRuntimeBytes, 1);
  const decoded = integer(limits.decodedPixelBytes, 0, runtime);
  const persistent = integer(limits.persistentCacheBytes, 0, runtime);
  const working = integer(limits.runtimeWorkingSetBytes, 0, runtime);
  if (working < decoded || working < persistent) bad();
  let minimumDecoded = 0;
  for (const value of renditionValues) {
    const rendition = object(value);
    const pixels = BigInt(integer(rendition.codedWidth, 1)) * BigInt(integer(rendition.codedHeight, 1)) * 4n;
    if (pixels > BigInt(MAX)) bad();
    minimumDecoded = Math.max(minimumDecoded, Number(pixels));
  }
  if (decoded < minimumDecoded) bad();
  validateRelations(m as unknown as Manifest);
  deepFreeze(m);
  return m as unknown as Manifest;
}

function validateAlpha(value: unknown, layout: string, canvasWidth: number, canvasHeight: number,
  codedWidth: number, codedHeight: number): Rect | null {
  const alpha = object(value);
  if (layout === "opaque") {
    shape(alpha, ["type", "colorRect"]);
    if (alpha.type !== "opaque") bad();
  } else {
    shape(alpha, ["type", "colorRect", "alphaRect"]);
    if (alpha.type !== "stacked") bad();
  }
  const color = rect(alpha.colorRect, codedWidth, codedHeight);
  if (color[0] !== 0 || color[1] !== 0 || color[2]! > canvasWidth || color[3]! > canvasHeight ||
    BigInt(color[2]!) * BigInt(canvasHeight) !== BigInt(color[3]!) * BigInt(canvasWidth)) bad();
  if (layout !== "opaque") {
    const a = rect(alpha.alphaRect, codedWidth, codedHeight);
    const expectedY = color[3]! + color[3]! % 2 + 8;
    if (a[0] !== 0 || a[1] !== expectedY || a[2] !== color[2] || a[3] !== color[3]) bad();
    return a;
  }
  return null;
}

function validatePackedAlphaWitness(value: unknown, alphaRect: Rect): void {
  const witness = object(value);
  shape(witness, ["kind", "unit", "frame", "samples"]);
  if (witness.kind !== "packed-alpha-v1") bad();
  identifier(witness.unit);
  integer(witness.frame);
  const samples = array(witness.samples, 1, 8);
  const coordinates = new Set<string>();
  for (const value of samples) {
    const sample = object(value);
    shape(sample, ["x", "y", "expectedRange"]);
    const x = integer(sample.x, 0, alphaRect[2] - 1);
    const y = integer(sample.y, 0, alphaRect[3] - 1);
    const coordinate = `${String(x)}\0${String(y)}`;
    if (coordinates.has(coordinate)) bad();
    coordinates.add(coordinate);
    const expectedRange = array(sample.expectedRange, 2, 2);
    const minimum = integer(expectedRange[0], 0, 255);
    const maximum = integer(expectedRange[1], 0, 255);
    if (minimum > maximum || maximum - minimum > 96) bad();
  }
}

function rect(value: unknown, width: number, height: number): Rect {
  const values = array(value, 4, 4);
  const x = integer(values[0]);
  const y = integer(values[1]);
  const w = integer(values[2], 1);
  const h = integer(values[3], 1);
  if (x > width - w || y > height - h) bad();
  return values as unknown as Rect;
}

function validateEdge(value: unknown): void {
  const edge = object(value);
  const start = object(edge.start);
  const cut = start.type === "cut";
  shape(edge,
    cut ? ["id", "from", "to", "start", "continuity", "targetRunwayFrames"]
      : ["id", "from", "to", "start", "continuity"],
    cut ? ["trigger"] : ["trigger", "transition"]);
  identifier(edge.id);
  if (identifier(edge.from) === identifier(edge.to)) bad();
  if (Object.hasOwn(edge, "trigger")) {
    const trigger = object(edge.trigger);
    if (trigger.type === "completion") shape(trigger, ["type"]);
    else {
      shape(trigger, ["type", "name"]);
      if (trigger.type !== "event") bad();
      identifier(trigger.name);
    }
  }
  if (start.type === "portal") {
    shape(start, ["type", "sourcePort", "targetPort", "maxWaitFrames"]);
    identifier(start.sourcePort);
  } else if (start.type === "finish" || start.type === "cut") {
    shape(start, ["type", "targetPort", "maxWaitFrames"]);
  } else bad();
  identifier(start.targetPort);
  const wait = integer(start.maxWaitFrames);
  if (start.type === "cut" && wait !== 1) bad();
  if (cut) {
    if (edge.continuity !== "cut") bad();
    integer(edge.targetRunwayFrames, 6, 12);
  } else {
    choice(edge.continuity, ["exact-authored", "exact-reverse"] as const);
    if (Object.hasOwn(edge, "transition")) {
      const transition = object(edge.transition);
      if (transition.kind === "locked") {
        shape(transition, ["kind", "unit"]);
      } else {
        shape(transition, ["kind", "unit", "direction"], ["reverseOf"]);
        if (transition.kind !== "reversible") bad();
        choice(transition.direction, ["forward", "reverse"] as const);
        if (Object.hasOwn(transition, "reverseOf")) identifier(transition.reverseOf);
      }
      identifier(transition.unit);
    }
  }
}

function validateRelations(manifest: Manifest): void {
  const units = new Map(manifest.units.map((unit) => [unit.id, unit]));
  const states = new Map(manifest.states.map((state) => [state.id, state]));
  const edges = new Map(manifest.edges.map((edge) => [edge.id, edge]));
  if (!states.has(manifest.initialState)) bad();
  const uses = new Map(manifest.units.map((unit) => [unit.id, 0]));
  const use = (id: string): void => { uses.set(id, (uses.get(id) ?? 0) + 1); };
  for (const state of manifest.states) {
    const body = units.get(state.bodyUnit);
    if (body?.kind !== "body") bad();
    use(body.id);
    if (state.initialUnit !== undefined) {
      if (state.id !== manifest.initialState || units.get(state.initialUnit)?.kind !== "one-shot") bad();
      use(state.initialUnit);
    }
  }
  const reversible = new Map<string, Edge[]>();
  const eventNames = new Set<string>();
  const direct = new Set<string>();
  const eventRoutes = new Set<string>();
  const completion = new Map<string, Edge>();
  for (const edge of manifest.edges) {
    const sourceState = states.get(edge.from);
    const targetState = states.get(edge.to);
    if (sourceState === undefined || targetState === undefined) bad();
    const source = units.get(sourceState.bodyUnit);
    const target = units.get(targetState.bodyUnit);
    if (source?.kind !== "body" || target?.kind !== "body" ||
      !target.ports.some((port) => port.id === edge.start.targetPort)) bad();
    const directKey = `${edge.from}\0${edge.to}`;
    if (direct.has(directKey)) bad();
    direct.add(directKey);
    if (edge.trigger?.type === "event") {
      const key = `${edge.from}\0${edge.trigger.name}`;
      if (eventRoutes.has(key)) bad();
      eventRoutes.add(key);
      eventNames.add(edge.trigger.name);
    } else if (edge.trigger?.type === "completion") {
      if (source.playback === "loop" || completion.has(edge.from)) bad();
      completion.set(edge.from, edge);
    }
    if (edge.start.type === "portal") {
      const start = edge.start;
      const port = source.ports.find((candidate) => candidate.id === start.sourcePort);
      if (port === undefined || source.playback === "finite" && port.portalFrames.at(-1) !== source.frameCount - 1 ||
        start.maxWaitFrames < greatestPortalWait(source, port.portalFrames)) bad();
    } else if (edge.start.type === "finish") {
      if (source.playback === "loop" || edge.start.maxWaitFrames < source.frameCount - 1) bad();
    }
    if (edge.transition?.kind === "locked") {
      if (units.get(edge.transition.unit)?.kind !== "bridge" || edge.continuity !== "exact-authored") bad();
      use(edge.transition.unit);
    } else if (edge.transition?.kind === "reversible") {
      if (units.get(edge.transition.unit)?.kind !== "reversible") bad();
      use(edge.transition.unit);
      const group = reversible.get(edge.transition.unit) ?? [];
      group.push(edge);
      reversible.set(edge.transition.unit, group);
    } else if (edge.start.type !== "cut" && edge.continuity !== "exact-authored") bad();
  }
  for (const [id, group] of reversible) {
    if (group.length !== 2) bad();
    const forward = group.find((edge) => edge.transition?.kind === "reversible" && edge.transition.direction === "forward");
    const reverse = group.find((edge) => edge.transition?.kind === "reversible" && edge.transition.direction === "reverse");
    if (forward === undefined || reverse === undefined || forward.from !== reverse.to || forward.to !== reverse.from ||
      forward.continuity !== "exact-authored" || reverse.continuity !== "exact-reverse" ||
      forward.transition?.kind !== "reversible" || reverse.transition?.kind !== "reversible" ||
      forward.transition.reverseOf !== undefined || reverse.transition.reverseOf !== forward.id) bad();
    const unit = units.get(id);
    if (unit?.kind !== "reversible") bad();
    for (const edge of group) {
      const source = unit.residency.endpoints.find((endpoint) => endpoint.state === edge.from);
      const target = unit.residency.endpoints.find((endpoint) => endpoint.state === edge.to);
      if (source === undefined || target === undefined || source === target ||
        edge.start.type === "portal" && edge.start.sourcePort !== source.port || edge.start.targetPort !== target.port) bad();
    }
  }
  for (const unit of manifest.units) if ((uses.get(unit.id) ?? 0) !== (unit.kind === "reversible" ? 2 : 1)) bad();
  for (const binding of manifest.bindings) if (!eventNames.has(binding.event)) bad();
  for (const start of completion.keys()) {
    const path = new Set<string>();
    let state: string | undefined = start;
    while (state !== undefined) {
      if (path.has(state)) bad();
      path.add(state);
      const body = units.get(states.get(state)?.bodyUnit ?? "");
      const edge = completion.get(state);
      state = body?.kind === "body" && body.playback === "finite" && body.frameCount === 1 &&
        edge !== undefined && edge.transition === undefined ? edge.to : undefined;
    }
  }
  const immediate = manifest.edges.filter((edge) => edge.from === manifest.initialState).map((edge) => edge.id).sort();
  if (immediate.length !== manifest.readiness.immediateEdges.length ||
    immediate.some((id, i) => id !== manifest.readiness.immediateEdges[i])) bad();
  const bootstrap = new Set(manifest.readiness.bootstrapUnits);
  for (const id of bootstrap) if (!units.has(id)) bad();
  const initial = states.get(manifest.initialState)!;
  const required = new Set([initial.bodyUnit]);
  if (initial.initialUnit !== undefined) required.add(initial.initialUnit);
  for (const id of immediate) {
    const edge = edges.get(id)!;
    required.add(states.get(edge.to)!.bodyUnit);
    if (edge.transition !== undefined) required.add(edge.transition.unit);
  }
  for (const id of required) if (!bootstrap.has(id)) bad();
  for (const rendition of manifest.renditions) {
    const witness = rendition.outputQualification;
    if (witness === undefined) continue;
    const unit = units.get(witness.unit);
    if (unit === undefined || !bootstrap.has(unit.id) || witness.frame >= unit.frameCount ||
      !unit.chunks.some((span) => span.rendition === rendition.id)) bad();
  }
}

function greatestPortalWait(unit: Extract<Unit, { kind: "body" }>, portals: readonly number[]): number {
  if (unit.playback !== "loop") {
    let greatest = portals[0]!;
    for (let i = 1; i < portals.length; i += 1) greatest = Math.max(greatest, portals[i]! - portals[i - 1]! - 1);
    return greatest;
  }
  let greatest = 0;
  for (let i = 0; i < portals.length; i += 1) {
    const previous = portals[i]!;
    const next = portals[(i + 1) % portals.length]!;
    greatest = Math.max(greatest, (i === portals.length - 1 ? unit.frameCount - previous + next : next - previous) - 1);
  }
  return greatest;
}

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}

function parseHeader(bytes: Uint8Array): Header {
  if (bytes.byteLength < 64) bad();
  for (let i = 0; i < MAGIC.length; i += 1) if (bytes[i] !== MAGIC[i]) bad();
  const view = new DataView(bytes.buffer, bytes.byteOffset, 64);
  const major = view.getUint16(8, true);
  const minor = view.getUint16(10, true);
  if (major !== 1 || (minor !== 0 && minor !== 1) ||
    view.getUint32(12, true) !== 64 || view.getUint32(16, true) !== 0 || view.getUint32(20, true) !== 0) bad();
  const declared = read64(view, 24);
  if (read64(view, 32) !== 64) bad();
  const manifestLength = read64(view, 40);
  if (manifestLength < 1 || manifestLength > B.manifest) bad();
  const indexOffset = read64(view, 48);
  if (indexOffset !== align8(add(64, manifestLength))) bad();
  const indexLength = read64(view, 56);
  if (indexLength < 16 || (indexLength - 16) % 48 !== 0 || (indexLength - 16) / 48 > U32) bad();
  const frontEnd = add(indexOffset, indexLength);
  if (frontEnd > declared) bad();
  return {
    major: 1,
    minor: minor as 0 | 1,
    declared,
    manifestLength,
    indexOffset,
    indexLength,
    frontEnd
  };
}

function parseManifest(
  bytes: Uint8Array,
  header: Readonly<Header>,
  expectedFamily: Codec
): Manifest {
  if (bytes.byteLength < header.indexOffset) bad();
  const manifestEnd = add(64, header.manifestLength);
  const manifest = validateManifest(canonicalJson(bytes.subarray(64, manifestEnd)));
  if (manifest.formatVersion !== `${String(header.major)}.${String(header.minor)}`) bad();
  if (manifest.codec !== expectedFamily) bad();
  zero(bytes, manifestEnd, header.indexOffset - manifestEnd);
  return manifest;
}

function parseFront(
  bytes: Uint8Array,
  expectedFamily: Codec,
  admission?: Readonly<{ header: Header; manifest: Manifest }>
): Parsed {
  const header = admission?.header ?? parseHeader(bytes);
  if (bytes.byteLength < header.frontEnd) bad();
  const manifest = admission?.manifest ?? parseManifest(bytes, header, expectedFamily);
  if (manifest.formatVersion !== `${String(header.major)}.${String(header.minor)}`) bad();
  const manifestEnd = add(64, header.manifestLength);
  const index = bytes.subarray(header.indexOffset, header.frontEnd);
  if (index[0] !== 0x41 || index[1] !== 0x56 || index[2] !== 0x4c || index[3] !== 0x49) bad();
  const view = new DataView(index.buffer, index.byteOffset, index.byteLength);
  if (view.getUint16(4, true) !== 48 || view.getUint16(6, true) !== 0 || view.getUint32(12, true) !== 0) bad();
  const count = view.getUint32(8, true);
  if (index.byteLength !== 16 + count * 48) bad();
  if (index.byteLength !== expectedIndexLength(manifest)) bad();
  const records: AssetRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = 16 + i * 48;
    const flags = view.getUint32(at + 32, true);
    if ((flags & ~1) !== 0) bad();
    for (let j = at + 36; j < at + 48; j += 1) if (index[j] !== 0) bad();
    const length = view.getUint32(at + 8, true);
    const displayedFrameCount = view.getUint32(at + 12, true);
    const presentationTimestamp = read64(view, at + 16);
    const duration = read64(view, at + 24);
    if (length < 1 || displayedFrameCount > 0 && duration === 0 ||
      BigInt(presentationTimestamp) + BigInt(duration) * BigInt(Math.max(0, displayedFrameCount - 1)) > BigInt(MAX)) bad();
    records.push(Object.freeze({
      offset: read64(view, at), length, presentationTimestamp, duration,
      randomAccess: (flags & 1) !== 0, displayedFrameCount
    }));
  }
  const blobs: Blob[] = [];
  const padding: { offset: number; length: number }[] = [];
  if (header.indexOffset > manifestEnd) padding.push({ offset: manifestEnd, length: header.indexOffset - manifestEnd });
  let cursor = header.frontEnd;
  for (let r = 0; r < manifest.renditions.length; r += 1) {
    for (const unit of manifest.units) {
      const span = unit.chunks[r]!;
      const aligned = align8(cursor);
      if (aligned > cursor) padding.push({ offset: cursor, length: aligned - cursor });
      cursor = aligned;
      const blobOffset = cursor;
      let displayed = 0;
      for (let i = 0; i < span.chunkCount; i += 1) {
        const record = records[span.chunkStart + i];
        if (record === undefined || record.offset !== cursor || i === 0 && !record.randomAccess) bad();
        displayed = add(displayed, record.displayedFrameCount, U32);
        cursor = add(cursor, record.length);
      }
      if (displayed !== span.frameCount) bad();
      blobs.push(Object.freeze({
        rendition: span.rendition, unit: unit.id, chunkStart: span.chunkStart,
        chunkCount: span.chunkCount, frameCount: span.frameCount, sha256: span.sha256,
        offset: blobOffset, length: cursor - blobOffset
      }));
    }
  }
  if (cursor !== header.declared || cursor > manifest.limits.maxCompiledBytes) bad();
  return Object.freeze({
    header: Object.freeze(header), manifest, records: Object.freeze(records),
    blobs: Object.freeze(blobs),
    padding: Object.freeze(padding.map((range) => Object.freeze(range)))
  });
}

function expectedIndexLength(manifest: Readonly<Manifest>): number {
  let count = 0;
  for (let r = 0; r < manifest.renditions.length; r += 1) {
    for (const unit of manifest.units) {
      count = add(count, unit.chunks[r]!.chunkCount, U32);
    }
  }
  return 16 + count * 48;
}

function sourceInput(source: Readonly<Source>, documentBase: string): {
  url: string; integrity: string; family: Codec;
} {
  let src: unknown;
  let sourceCodec: unknown;
  let integrity: unknown;
  let type: unknown;
  try {
    src = source.src;
    sourceCodec = source.codec;
    integrity = source.integrity;
    type = source.type;
  } catch {
    return bad();
  }
  if (typeof src !== "string" || src.length < 1 || src.length > 4096 || /[\u0000-\u001f\u007f]/.test(src)) bad();
  const parsedCodec = codec(sourceCodec);
  if (type !== undefined && type !== `application/vnd.aval; codecs="${String(sourceCodec)}"`) bad();
  if (typeof integrity !== "string") bad();
  if (integrity !== "") {
    const match = /^sha256-([A-Za-z0-9+/]{43})=$/.exec(integrity);
    const last = match === null
      ? -1
      : "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(match[1]!.at(-1)!);
    if (match === null || last < 0 || (last & 3) !== 0) bad();
  }
  let url: URL;
  try { url = new URL(src, documentBase); } catch { return bad(); }
  if (url.protocol !== "http:" && url.protocol !== "https:") bad();
  return { url: url.href, integrity, family: parsedCodec.family };
}

function strong(value: string | null): string | null {
  if (value === null) return null;
  const match = /^[\t ]*(.*?)[\t ]*$/.exec(value);
  if (match === null) return null;
  const tag = match[1]!;
  if (tag.length < 2 || tag.startsWith("W/") || tag[0] !== '"' || tag.at(-1) !== '"') return null;
  for (let i = 1; i < tag.length - 1; i += 1) {
    const code = tag.charCodeAt(i);
    if (code !== 0x21 && !(code >= 0x23 && code <= 0x7e) && !(code >= 0x80 && code <= 0xff)) return null;
  }
  return tag;
}

function responseUrl(response: Response, pinned?: string): string {
  if (!["basic", "cors", "default"].includes(response.type) || !response.url) bad();
  for (let i = 0; i < response.url.length; i += 1) {
    const code = response.url.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) bad();
  }
  let url: URL;
  try { url = new URL(response.url); } catch { return bad(); }
  if (url.protocol !== "http:" && url.protocol !== "https:" || pinned !== undefined && url.href !== pinned) bad();
  return url.href;
}

function partialMetadata(response: Response, start: number, end: number, knownTotal?: number,
  pinnedUrl?: string, pinnedTag?: string): { url: string; total: number; tag: string | null } {
  if (response.status !== 206) bad();
  const url = responseUrl(response, pinnedUrl);
  const encoding = response.headers.get("Content-Encoding");
  if (encoding !== null && !/^[\t ]*identity[\t ]*$/i.test(encoding)) bad();
  const length = end - start + 1;
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null) {
    const parsedLength = /^[\t ]*((?:0|[1-9][0-9]*))[\t ]*$/.exec(contentLength);
    if (parsedLength === null || !Number.isSafeInteger(Number(parsedLength[1])) || Number(parsedLength[1]) !== length) bad();
  }
  const match = /^[\t ]*bytes ([0-9]+)-([0-9]+)\/([0-9]+)[\t ]*$/i.exec(response.headers.get("Content-Range") ?? "");
  if (match === null || [match[1], match[2], match[3]].some((part) => !/^(?:0|[1-9][0-9]*)$/.test(part!))) bad();
  const values = match.slice(1).map(Number);
  if (values.some((value) => !Number.isSafeInteger(value)) || values[0] !== start || values[1] !== end ||
    values[2]! <= end || knownTotal !== undefined && values[2] !== knownTotal) bad();
  const tag = strong(response.headers.get("ETag"));
  if (pinnedTag !== undefined && tag !== pinnedTag) bad();
  return { url, total: values[2]!, tag };
}

async function request(
  platform: Readonly<AssetPlatform>,
  metrics: Metrics,
  url: string,
  init: RequestInit,
  range: boolean
): Promise<Response> {
  metrics.requests += 1;
  if (range) metrics.ranges += 1;
  else metrics.full += 1;
  metrics.active += 1;
  const watchdog = createWatchdog(init.signal ?? undefined, platform);
  const pending = Promise.resolve().then(() =>
    platform.fetch(url, { ...init, signal: watchdog.controller.signal })
  );
  try {
    const response = await watched(watchdog, pending);
    RESPONSE_WATCHDOGS.set(response, watchdog);
    armBody(watchdog);
    return response;
  } catch (error) {
    void pending.then((late) => late.body?.cancel(), () => undefined).catch(() => undefined);
    completeWatchdog(watchdog);
    metrics.active -= 1;
    throw error;
  }
}

async function bytes(
  metrics: Metrics,
  response: Response,
  expected: number
): Promise<Uint8Array<ArrayBuffer>>;
async function bytes(
  metrics: Metrics,
  response: Response,
  expected: undefined,
  family: Codec
): Promise<Readonly<{ bytes: Uint8Array<ArrayBuffer>; parsed: Parsed }>>;
async function bytes(
  metrics: Metrics,
  response: Response,
  expected: number | undefined,
  family?: Codec
): Promise<Uint8Array<ArrayBuffer> | Readonly<{
  bytes: Uint8Array<ArrayBuffer>;
  parsed: Parsed;
}>> {
  const watchdog = RESPONSE_WATCHDOGS.get(response);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let failed = true;
  try {
    if (watchdog === undefined || response.body === null) bad();
    if (expected === undefined && family === undefined) bad();
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0 || expected > MAX)) bad();
    let contentLength = canonicalLength(response.headers.get("Content-Length"));
    if (contentLength !== null && contentLength > MAX) bad();
    if (expected !== undefined && contentLength !== null && contentLength !== expected) bad();
    if (expected === undefined) {
      const encoding = response.headers.get("Content-Encoding");
      if (encoding !== null && !/^[\t ]*identity[\t ]*$/i.test(encoding)) contentLength = null;
    }
    reader = response.body.getReader();
    let prefix = expected === undefined ? new Uint8Array(64) : null;
    let output = expected === undefined ? null : new Uint8Array(expected);
    let header: Header | undefined;
    let manifest: Manifest | undefined;
    let parsed: Parsed | undefined;
    let offset = 0;
    let prefixOffset = 0;
    while (true) {
      const step = await watched(watchdog, Promise.resolve(reader.read()));
      if (typeof step !== "object" || step === null || typeof step.done !== "boolean") bad();
      if (step.done) {
        if (output === null || offset !== output.byteLength) bad();
        if (expected === undefined) {
          if (parsed === undefined) bad();
          for (const range of parsed.padding) zero(output, range.offset, range.length);
        }
        metrics.bytes = add(metrics.bytes, offset);
        failed = false;
        return expected === undefined ? { bytes: output, parsed: parsed! } : output;
      }
      const received = step.value;
      if (!isUint8Array(received)) bad();
      const chunk = new Uint8Array(received.byteLength);
      chunk.set(received);
      if (chunk.byteLength === 0) continue;
      armBody(watchdog);
      if (chunk.byteLength > MAX - offset) bad();
      let start = 0;
      while (start < chunk.byteLength) {
        if (output !== null) {
          const length = chunk.byteLength - start;
          if (length > output.byteLength - offset) bad();
          output.set(chunk.subarray(start), offset);
          offset += length;
          break;
        }
        const target = prefix!;
        const length = Math.min(target.byteLength - prefixOffset, chunk.byteLength - start);
        target.set(chunk.subarray(start, start + length), prefixOffset);
        prefixOffset += length;
        offset += length;
        start += length;
        if (prefixOffset !== target.byteLength) continue;
        if (header === undefined) {
          header = parseHeader(target);
          if (contentLength !== null && contentLength !== header.declared) bad();
          prefix = new Uint8Array(header.indexOffset);
          prefix.set(target);
          continue;
        }
        if (manifest === undefined) {
          manifest = parseManifest(target, header, family!);
          if (header.declared > manifest.limits.maxCompiledBytes) bad();
          if (header.indexLength !== expectedIndexLength(manifest)) bad();
          prefix = new Uint8Array(header.frontEnd);
          prefix.set(target);
          continue;
        }
        parsed = parseFront(target, family!, { header, manifest });
        output = new Uint8Array(header.declared);
        output.set(target);
        prefix = null;
      }
    }
  } finally {
    if (failed && reader !== null) {
      try { void reader.cancel().catch(() => undefined); } catch { /* Body retirement is best effort. */ }
    }
    try { reader?.releaseLock(); } catch { /* A hostile pending read may retain its lock until abort settles. */ }
    releaseResponse(metrics, response);
  }
}

function isUint8Array(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) &&
    Object.prototype.toString.call(value) === "[object Uint8Array]";
}

async function retire(metrics: Metrics, response: Response): Promise<void> {
  try { void response.body?.cancel().catch(() => undefined); } catch { /* Fetch ownership is already retired. */ }
  releaseResponse(metrics, response);
}

function releaseResponse(metrics: Metrics, response: Response): void {
  const watchdog = RESPONSE_WATCHDOGS.get(response);
  if (watchdog !== undefined) {
    RESPONSE_WATCHDOGS.delete(response);
    completeWatchdog(watchdog);
    metrics.active -= 1;
  }
}

function canonicalLength(value: string | null): number | null {
  if (value === null) return null;
  const match = /^[\t ]*((?:0|[1-9][0-9]*))[\t ]*$/.exec(value);
  const parsed = match === null ? -1 : Number(match[1]);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== match![1]) bad();
  return parsed;
}

function createWatchdog(
  signal: AbortSignal | null | undefined,
  platform: Readonly<AssetPlatform>
): Watchdog {
  const controller = new AbortController();
  const schedule = platform.setTimeout ?? ((callback: () => void, delay: number) =>
    globalThis.setTimeout(callback, delay) as unknown as number);
  const cancel = platform.clearTimeout ?? ((handle: number) => globalThis.clearTimeout(handle));
  const watchdog: Watchdog = {
    controller,
    signal: signal ?? undefined,
    abort: undefined,
    waits: new Set(),
    setTimeout: schedule,
    clearTimeout: cancel,
    overall: undefined,
    body: undefined
  };
  if (signal?.aborted) terminateWatchdog(watchdog, signal.reason);
  else if (signal !== null && signal !== undefined) {
    const abort = (): void => terminateWatchdog(watchdog, signal.reason);
    watchdog.abort = abort;
    signal.addEventListener("abort", abort, { once: true });
  }
  if (!controller.signal.aborted) {
    watchdog.overall = schedule(() => timeoutWatchdog(watchdog), OVERALL_MS);
  }
  return watchdog;
}

function watched<T>(watchdog: Watchdog, operation: Promise<T>): Promise<T> {
  if (watchdog.controller.signal.aborted) return Promise.reject(watchdog.controller.signal.reason);
  return new Promise<T>((resolve, reject) => {
    let active = true;
    const stop = (error: unknown): void => {
      if (!active) return;
      active = false;
      watchdog.waits.delete(stop);
      reject(error);
    };
    watchdog.waits.add(stop);
    operation.then((value) => {
      if (!active) return;
      active = false;
      watchdog.waits.delete(stop);
      resolve(value);
    }, stop);
  });
}

function armBody(watchdog: Watchdog): void {
  if (watchdog.controller.signal.aborted) return;
  if (watchdog.body !== undefined) watchdog.clearTimeout(watchdog.body);
  watchdog.body = watchdog.setTimeout(() => timeoutWatchdog(watchdog), BODY_MS);
}

function timeoutWatchdog(watchdog: Watchdog): void {
  terminateWatchdog(watchdog, new DOMException("AVAL asset load timed out", "TimeoutError"));
}

function terminateWatchdog(watchdog: Watchdog, error: unknown): void {
  if (watchdog.controller.signal.aborted) return;
  watchdog.controller.abort(error);
  for (const reject of watchdog.waits) reject(error);
  watchdog.waits.clear();
}

function completeWatchdog(watchdog: Watchdog): void {
  if (watchdog.overall !== undefined) watchdog.clearTimeout(watchdog.overall);
  if (watchdog.body !== undefined) watchdog.clearTimeout(watchdog.body);
  watchdog.overall = undefined;
  watchdog.body = undefined;
  if (watchdog.signal !== undefined && watchdog.abort !== undefined) {
    watchdog.signal.removeEventListener("abort", watchdog.abort);
  }
}

async function fullResponse(metrics: Metrics, response: Response, family: Codec,
  pinnedUrl?: string, pinnedTag?: string): Promise<{ parsed: Parsed; bytes: Uint8Array<ArrayBuffer>; url: string; tag: string | null }> {
  try {
    if (response.status !== 200) bad();
    const url = responseUrl(response, pinnedUrl);
    const tag = strong(response.headers.get("ETag"));
    if (pinnedTag !== undefined && tag !== pinnedTag) bad();
    const value = await bytes(metrics, response, undefined, family);
    return { ...value, url, tag };
  } catch (error) {
    await retire(metrics, response);
    throw error;
  }
}

export class Asset {
  readonly manifest: Readonly<Manifest>;
  readonly records: readonly Readonly<AssetRecord>[];
  readonly blobs: readonly Readonly<Blob>[];
  readonly #family: Codec;
  readonly #credentials: RequestCredentials;
  readonly #requestUrl: string;
  readonly #controller: AbortController;
  readonly #metrics: Metrics;
  readonly #caller: AbortSignal;
  readonly #abortListener: () => void;
  readonly #platform: Readonly<AssetPlatform>;
  readonly #cache = new Map<string, Uint8Array<ArrayBuffer>>();
  readonly #loads = new Map<string, Load>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #bodyQueue: BodyWaiter[] = [];
  #bodyActive = 0;
  #mode: "range" | "full";
  #url: string;
  #etag: string | null;
  #front: Uint8Array<ArrayBuffer>;
  #file: Uint8Array<ArrayBuffer> | null;
  #disposed = false;
  #disposePromise: Promise<void> | null = null;

  private constructor(parsed: Parsed, mode: "range" | "full", requestUrl: string,
    url: string, etag: string | null,
    front: Uint8Array<ArrayBuffer>, file: Uint8Array<ArrayBuffer> | null, family: Codec,
    credentials: RequestCredentials,
    controller: AbortController, caller: AbortSignal, abortListener: () => void,
    metrics: Metrics, platform: Readonly<AssetPlatform>) {
    this.manifest = parsed.manifest;
    this.records = parsed.records;
    this.blobs = parsed.blobs;
    this.#mode = mode;
    this.#requestUrl = requestUrl;
    this.#url = url;
    this.#etag = etag;
    this.#front = front;
    this.#file = file;
    this.#family = family;
    this.#credentials = credentials;
    this.#controller = controller;
    this.#caller = caller;
    this.#abortListener = abortListener;
    this.#metrics = metrics;
    this.#platform = platform;
  }

  static async open(source: Readonly<Source>, documentBase: string,
    credentials: RequestCredentials, signal: AbortSignal,
    platform: Readonly<AssetPlatform> = {
      fetch: globalThis.fetch.bind(globalThis),
      crypto: globalThis.crypto
    }): Promise<Asset> {
    if (!["omit", "same-origin", "include"].includes(credentials) ||
      typeof signal !== "object" || signal === null) bad();
    signal.throwIfAborted();
    const input = sourceInput(source, documentBase);
    const controller = new AbortController();
    const metrics: Metrics = { requests: 0, ranges: 0, full: 0, active: 0, bytes: 0 };
    let asset: Asset | null = null;
    const abortListener = (): void => {
      controller.abort(signal.reason);
      if (asset !== null) void asset.dispose();
    };
    signal.addEventListener("abort", abortListener, { once: true });
    try {
      if (input.integrity !== "") {
        const response = await request(platform, metrics, input.url, {
          credentials, signal: controller.signal, integrity: input.integrity
        }, false);
        const full = await fullResponse(metrics, response, input.family);
        asset = new Asset(full.parsed, "full", input.url, full.url, full.tag,
          full.bytes.subarray(0, full.parsed.header.frontEnd), full.bytes, input.family,
          credentials, controller, signal, abortListener, metrics, platform);
        return asset;
      }
      let response = await request(platform, metrics, input.url, {
        credentials, signal: controller.signal, headers: { Range: "bytes=0-63" }
      }, true);
      if (response.status === 200) {
        const full = await fullResponse(metrics, response, input.family);
        asset = new Asset(full.parsed, "full", input.url, full.url, full.tag,
          full.bytes.subarray(0, full.parsed.header.frontEnd), full.bytes, input.family,
          credentials, controller, signal, abortListener, metrics, platform);
        return asset;
      }
      let initial: ReturnType<typeof partialMetadata>;
      try { initial = partialMetadata(response, 0, 63); }
      catch (error) { await retire(metrics, response); throw error; }
      if (initial.tag === null) {
        await retire(metrics, response);
        response = await request(
          platform,
          metrics,
          input.url,
          { credentials, signal: controller.signal },
          false
        );
        const full = await fullResponse(metrics, response, input.family, initial.url);
        asset = new Asset(full.parsed, "full", input.url, full.url, full.tag,
          full.bytes.subarray(0, full.parsed.header.frontEnd), full.bytes, input.family,
          credentials, controller, signal, abortListener, metrics, platform);
        return asset;
      }
      let headerBytes: Uint8Array<ArrayBuffer>;
      try { headerBytes = await bytes(metrics, response, 64); }
      catch (error) { await retire(metrics, response); throw error; }
      const header = parseHeader(headerBytes);
      if (header.declared !== initial.total) bad();
      const end = header.frontEnd - 1;
      response = await request(platform, metrics, input.url, {
        credentials, signal: controller.signal,
        headers: { Range: `bytes=64-${String(end)}`, "If-Range": initial.tag }
      }, true);
      if (response.status === 200) {
        const full = await fullResponse(metrics, response, input.family, initial.url, initial.tag);
        asset = new Asset(full.parsed, "full", input.url, full.url, full.tag,
          full.bytes.subarray(0, full.parsed.header.frontEnd), full.bytes, input.family,
          credentials, controller, signal, abortListener, metrics, platform);
        return asset;
      }
      try { partialMetadata(response, 64, end, initial.total, initial.url, initial.tag); }
      catch (error) { await retire(metrics, response); throw error; }
      let tail: Uint8Array<ArrayBuffer>;
      try { tail = await bytes(metrics, response, header.frontEnd - 64); }
      catch (error) { await retire(metrics, response); throw error; }
      const front = new Uint8Array(header.frontEnd);
      front.set(headerBytes);
      front.set(tail, 64);
      const parsed = parseFront(front, input.family);
      asset = new Asset(parsed, "range", input.url, initial.url, initial.tag, front, null,
        input.family, credentials, controller, signal, abortListener, metrics, platform);
      return asset;
    } catch (error) {
      controller.abort();
      signal.removeEventListener("abort", abortListener);
      throw error;
    }
  }

  get mode(): "range" | "full" { return this.#mode; }
  get url(): string { return this.#url; }
  get etag(): string | null { return this.#etag; }
  get frontIndexBytes(): Uint8Array<ArrayBuffer> { return this.#front; }
  get fileBytes(): Uint8Array<ArrayBuffer> | null { return this.#file; }
  get disposed(): boolean { return this.#disposed; }

  unitBytes(rendition: string, unit: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    if (this.#disposed) return Promise.reject(new Error("Disposed AVAL asset"));
    const blob = this.blobs.find((value) => value.rendition === rendition && value.unit === unit);
    if (blob === undefined) return Promise.reject(new Error("Unknown AVAL unit"));
    const key = `${rendition}\0${unit}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined) return signal === undefined ? Promise.resolve(cached) : wait(Promise.resolve(cached), signal);
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    let load = this.#loads.get(key);
    if (load === undefined) {
      const controller = new AbortController();
      const waiters = new Set<LoadWaiter>();
      const schedule = this.#platform.setTimeout ?? (
        (callback: () => void, delay: number) =>
          globalThis.setTimeout(callback, delay) as unknown as number
      );
      const cancel = this.#platform.clearTimeout ?? (
        (handle: number) => globalThis.clearTimeout(handle)
      );
      const timer = schedule(() => controller.abort(timeoutError()), OVERALL_MS);
      let owned!: Load;
      const promise = Promise.resolve().then(() => this.#load(blob, controller.signal)).then(async (value) => {
        if (!await verify(value, blob.sha256, this.#platform.crypto)) bad();
        controller.signal.throwIfAborted();
        if (this.#disposed) throw new Error("Disposed AVAL asset");
        this.#cache.set(key, value);
        return value;
      }).finally(() => {
        cancel(timer);
        if (this.#loads.get(key) === owned) this.#loads.delete(key);
      });
      load = owned = { key, controller, promise, waiters, timer };
      this.#loads.set(key, load);
      const tracked = promise.then(() => undefined, () => undefined)
        .finally(() => { this.#pending.delete(tracked); });
      this.#pending.add(tracked);
    }
    return this.#attach(load, signal);
  }

  chunkBytes(rendition: string, unit: string, decodeIndex: number): ArrayBuffer {
    const blob = this.blobs.find((value) => value.rendition === rendition && value.unit === unit);
    const cached = this.#cache.get(`${rendition}\0${unit}`);
    if (blob === undefined || cached === undefined || !Number.isSafeInteger(decodeIndex) ||
      decodeIndex < 0 || decodeIndex >= blob.chunkCount) bad();
    const record = this.records[blob.chunkStart + decodeIndex];
    if (record === undefined) bad();
    const offset = record.offset - blob.offset;
    if (offset < 0 || offset + record.length > cached.byteLength) bad();
    const output = new Uint8Array(record.length);
    output.set(cached.subarray(offset, offset + record.length));
    return output.buffer;
  }

  snapshot(): Readonly<AssetSnapshot> {
    let verifiedBytes = 0;
    for (const value of this.#cache.values()) verifiedBytes = add(verifiedBytes, value.byteLength);
    const loading = this.#loads.size;
    const verified = this.#cache.size;
    let interestedWaiters = 0;
    for (const load of this.#loads.values()) interestedWaiters += load.waiters.size;
    return Object.freeze({
      mode: this.#mode,
      disposed: this.#disposed,
      declaredFileBytes: this.#disposed ? 0 : this.#parsedFileLength(),
      metadataBytes: this.#disposed ? 0 : this.#front.byteLength,
      verifiedBytes: this.#disposed ? 0 : verifiedBytes,
      residentBlobBytes: this.#disposed ? 0 : this.#file === null ? verifiedBytes : this.#file.byteLength - this.#front.byteLength,
      requestCount: this.#metrics.requests,
      rangeRequestCount: this.#metrics.ranges,
      fullRequestCount: this.#metrics.full,
      activeTransportBodies: this.#metrics.active,
      pendingLoads: this.#pending.size,
      interestedWaiters,
      transportBytes: this.#metrics.bytes,
      blobs: Object.freeze({
        total: this.blobs.length,
        absent: Math.max(0, this.blobs.length - loading - verified),
        loading,
        verified
      })
    });
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== null) return this.#disposePromise;
    this.#disposed = true;
    this.#controller.abort();
    for (const load of this.#loads.values()) load.controller.abort(abortError());
    this.#caller.removeEventListener("abort", this.#abortListener);
    this.#disposePromise = Promise.allSettled([...this.#pending]).then(() => {
      this.#cache.clear();
      this.#loads.clear();
      this.#front = EMPTY;
      this.#file = null;
    });
    return this.#disposePromise;
  }

  async #load(blob: Readonly<Blob>, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    if (this.#file !== null) return this.#file.subarray(blob.offset, blob.offset + blob.length);
    const index = this.blobs.indexOf(blob);
    const preceding = index < 1
      ? this.#front.byteLength
      : this.blobs[index - 1]!.offset + this.blobs[index - 1]!.length;
    const padding = blob.offset - preceding;
    if (index < 0 || padding < 0 || padding > 7) bad();
    const output = new Uint8Array(blob.length);
    let offset = 0;
    const transferLength = padding + blob.length;
    while (offset < transferLength) {
      signal.throwIfAborted();
      const resident = this.#file as Uint8Array<ArrayBuffer> | null;
      if (resident !== null) return resident.subarray(blob.offset, blob.offset + blob.length);
      const length = Math.min(4 * 1024 * 1024, transferLength - offset);
      const start = preceding + offset;
      const end = start + length - 1;
      const result = await this.#body(signal, async () => {
        const response = await request(this.#platform, this.#metrics, this.#requestUrl, {
          credentials: this.#credentials,
          signal,
          headers: { Range: `bytes=${String(start)}-${String(end)}`, "If-Range": this.#etag! }
        }, true);
        if (response.status === 200) {
          return { full: await fullResponse(this.#metrics, response, this.#family, this.#url, this.#etag!) };
        }
        try { partialMetadata(response, start, end, this.#parsedFileLength(), this.#url, this.#etag!); }
        catch (error) { await retire(this.#metrics, response); throw error; }
        try { return { part: await bytes(this.#metrics, response, length) }; }
        catch (error) { await retire(this.#metrics, response); throw error; }
      });
      if ("full" in result) {
        const full = result.full;
        const front = full.bytes.subarray(0, full.parsed.header.frontEnd);
        if (!sameBytes(front, this.#front)) bad();
        const installed = this.#file as Uint8Array<ArrayBuffer> | null;
        if (installed !== null) return installed.subarray(blob.offset, blob.offset + blob.length);
        this.#mode = "full";
        this.#file = full.bytes;
        this.#cache.clear();
        return this.#file.subarray(blob.offset, blob.offset + blob.length);
      }
      const installed = this.#file as Uint8Array<ArrayBuffer> | null;
      if (installed !== null) return installed.subarray(blob.offset, blob.offset + blob.length);
      const part = result.part;
      const dataStart = Math.max(start, blob.offset);
      if (dataStart > start) zero(part, 0, dataStart - start);
      output.set(part.subarray(dataStart - start), dataStart - blob.offset);
      offset += length;
    }
    return output;
  }

  #attach(load: Load, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    return new Promise((resolve, reject) => {
      const waiter: LoadWaiter = { signal, resolve, reject, abort: undefined, settled: false };
      const settle = (error: unknown | null, value?: Uint8Array<ArrayBuffer>): void => {
        if (waiter.settled) return;
        waiter.settled = true;
        load.waiters.delete(waiter);
        if (signal !== undefined && waiter.abort !== undefined) signal.removeEventListener("abort", waiter.abort);
        if (error === null && value !== undefined) resolve(value);
        else reject(error);
      };
      waiter.abort = signal === undefined ? undefined : () => {
        settle(abortReason(signal));
        if (load.waiters.size === 0 && this.#loads.get(load.key) === load) {
          this.#loads.delete(load.key);
          load.controller.abort(abortError());
        }
      };
      load.waiters.add(waiter);
      if (signal !== undefined) {
        signal.addEventListener("abort", waiter.abort!, { once: true });
        if (signal.aborted) waiter.abort!();
      }
      load.promise.then((value) => settle(null, value), (error) => settle(error));
    });
  }

  async #body<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    await this.#acquireBody(signal);
    try {
      signal.throwIfAborted();
      return await operation();
    } finally {
      this.#releaseBody();
    }
  }

  #acquireBody(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    if (this.#bodyActive < 4) {
      this.#bodyActive += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let waiter!: BodyWaiter;
      const abort = (): void => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = this.#bodyQueue.indexOf(waiter);
        if (index >= 0) this.#bodyQueue.splice(index, 1);
        reject(abortReason(signal));
      };
      waiter = { signal, resolve, reject, abort, settled: false };
      this.#bodyQueue.push(waiter);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  #releaseBody(): void {
    this.#bodyActive -= 1;
    while (this.#bodyQueue.length > 0) {
      const waiter = this.#bodyQueue.shift()!;
      if (waiter.settled) continue;
      waiter.settled = true;
      waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.signal.aborted) {
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      this.#bodyActive += 1;
      waiter.resolve();
      return;
    }
  }

  #parsedFileLength(): number {
    const last = this.blobs.at(-1);
    return last === undefined ? this.#front.byteLength : last.offset + last.length;
  }
}

async function verify(
  bytes: Uint8Array<ArrayBuffer>,
  expected: string,
  crypto: Crypto
): Promise<boolean> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  for (let i = 0; i < 32; i += 1) if (digest[i] !== Number.parseInt(expected.slice(i * 2, i * 2 + 2), 16)) return false;
  return true;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function abortError(): DOMException {
  return new DOMException("AVAL asset load was aborted", "AbortError");
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? abortError();
}

function timeoutError(): DOMException {
  return new DOMException("AVAL asset load timed out", "TimeoutError");
}
