# M4 Minimal Compiled Format Design

**Date:** 2026-07-11

**Status:** Approved implementation slice derived from the committed web
rendered-motion format design

## 1. Objective

M4 freezes the first byte-level container contract for a rendered-motion
asset. It adds a browser-independent `@rendered-motion/format` package that can
write one canonical version-0.1 file, parse its bounded front index without
copying media payloads, validate the layout of a complete file, and convert the
compiled manifest into M3's validated motion graph.

M4 proves container determinism and hostile-input safety. It does not decode
production video, inspect H.264 dependency structure, fully validate PNGs,
fetch network ranges, or authenticate payload bytes. Those responsibilities
remain in M5, M6, and M7.

## 2. Package Boundary

Create `@rendered-motion/format` with exactly one production dependency:
`@rendered-motion/graph`. Its production TypeScript project uses
`lib: ["ES2023"]` and no ambient types. Importing DOM, WebCodecs, Node,
filesystem, network, timer, or platform cryptography APIs is a compile-time
error.

The package is split by responsibility:

- `constants.ts`: version, magic values, record sizes, identifier rules, and
  default hard budgets;
- `errors.ts`: the stable `FormatError` surface;
- `checked-integer.ts`: safe arithmetic, alignment, and bounded byte reads;
- `canonical-json.ts`: duplicate-aware parsing and canonical serialization;
- `model.ts`: immutable on-wire, parsed, range, and writer-input types;
- `manifest-schema.ts`: the one executable version-0.1 manifest schema;
- `graph-adapter.ts`: the sole manifest-to-M3 mapping;
- `header.ts`: the fixed 64-byte header codec;
- `access-unit-index.ts`: the 16-byte index header and 32-byte record codec;
- `layout.ts`: canonical range, padding, overlap, and file-end validation;
- `reference-frame.ts`: the conformance-only raw RGBA sample profile;
- `parser.ts`: front-index parsing and complete-asset validation;
- `writer.ts`: canonical fixed-point file construction; and
- `index.ts`: the only public export surface.

`format` depends on `graph`; `graph` never depends on `format`. Parsed public
values are recursively frozen. Public results contain byte ranges, never
payload copies or retained input `Uint8Array` views.

## 3. Version 0.1 File Layout

All fixed-width integers are unsigned little-endian values. A canonical file
has this exact order:

```text
64-byte header
canonical UTF-8 manifest
zero padding to an 8-byte boundary
16-byte access-unit index header
32-byte access-unit records
zero padding to an 8-byte boundary
rendition 0 / unit 0 access-unit bytes
...
rendition N / unit M access-unit bytes
zero padding before each unit blob as needed
static PNG blobs in manifest order
zero padding before each PNG as needed
end of file
```

The private prototype extension remains `.rma`. It is not a product name or a
permanent public extension.

### 3.1 Header

The header is exactly 64 bytes:

| Offset | Field | Type | Canonical 0.1 value |
|---:|---|---|---|
| 0 | magic | 8 bytes | `RMAF\r\n\x1a\n` |
| 8 | major | `uint16` | `0` |
| 10 | minor | `uint16` | `1` |
| 12 | header length | `uint32` | `64` |
| 16 | required-feature flags | `uint32` | `0` |
| 20 | reserved | `uint32` | `0` |
| 24 | declared file length | `uint64` | exact file byte length |
| 32 | manifest offset | `uint64` | `64` |
| 40 | manifest length | `uint64` | canonical JSON byte length |
| 48 | index offset | `uint64` | `align8(64 + manifestLength)` |
| 56 | index length | `uint64` | `16 + 32 * sampleCount` |

Every `uint64` is first read as `bigint`. It is converted to `number` only
after proving that it is at most `Number.MAX_SAFE_INTEGER` and within the
active budget. No `DataView` read occurs before its complete byte range has
been checked.

The parser accepts only exactly version 0.1 in M4. A major or minor mismatch is
`VERSION_UNSUPPORTED`; a nonzero required-feature bit is
`FEATURE_UNSUPPORTED`. Supporting a later compatible minor means adding a
separate schema and canonicalizer, not silently accepting unknown 0.1 fields.

### 3.2 Access-unit index

The index begins with this exact 16-byte header:

| Offset | Field | Type | Canonical 0.1 value |
|---:|---|---|---|
| 0 | magic | 4 bytes | `RMAI` |
| 4 | record size | `uint16` | `32` |
| 6 | reserved | `uint16` | `0` |
| 8 | sample count | `uint32` | number of following records |
| 12 | reserved | `uint32` | `0` |

Each following record is exactly 32 bytes:

| Offset | Field | Type | Rule |
|---:|---|---|---|
| 0 | payload offset | `uint64` | absolute safe integer |
| 8 | payload length | `uint32` | `1..maxSampleBytes` |
| 12 | unit index | `uint32` | index into canonical `units` |
| 16 | rendition index | `uint16` | index into canonical `renditions` |
| 18 | flags | `uint16` | bit 0 `key`; all other bits zero |
| 20 | frame index | `uint32` | unit-local frame index |
| 24 | reserved | 8 bytes | all zero |

Records are in rendition-major, then unit-major, then frame-major order. Every
rendition/unit pair has exactly `unit.frameCount` records numbered from zero.
The corresponding manifest sample descriptor has the exact first record
ordinal as `sampleStart` and `unit.frameCount` as `sampleCount`. Frame zero is
always marked key. The reference profile marks every frame key. M4 does not
trust or inspect an AVC key flag beyond these structural rules; Annex B and
dependency inspection begin in M5.

### 3.3 Canonical payload layout

Let `cursor = align8(indexOffset + indexLength)`. For each rendition in array
order, then each unit in array order:

1. `cursor` is aligned to eight bytes;
2. the pair's frame-zero record starts exactly at `cursor`;
3. later records begin exactly at the preceding record's end, with no padding;
4. `cursor` becomes the last record's end; and
5. any bytes skipped by the next `align8` are zero.

After all unit blobs, each static frame in array order begins exactly at
`align8(cursor)` and advances by its declared length. Its descriptor offset
must equal that computed position. Padding is zero. The last static blob ends
exactly at the header's declared length and at `bytes.byteLength` during
complete validation. Gaps, nonzero padding, overlap, aliasing, out-of-order
ranges, header/front-index overlap, and trailing bytes are rejected.

This construction includes a shared static frame once even when several states
reference it. Unreferenced payloads and descriptors are not permitted.

## 4. Canonical JSON

The manifest is UTF-8 JSON with one accepted byte representation. Parsing is
fatal UTF-8 decoding with no BOM. Before schema validation, the parser:

- tracks object keys after JSON escape decoding;
- rejects duplicate decoded keys, including `"a"` plus `"\u0061"`;
- rejects any decoded object key equal to `__proto__`, `prototype`, or
  `constructor` at any depth;
- rejects lone UTF-16 surrogates and invalid Unicode scalar values;
- accepts only integers within `Number.MIN_SAFE_INTEGER` through
  `Number.MAX_SAFE_INTEGER`; and
- enforces the JSON depth, node, string-byte, and manifest-byte budgets while
  parsing, before allocating a large result.

Canonical serialization is minified and has no leading/trailing whitespace or
terminal newline. Object keys are sorted recursively by unsigned
lexicographic comparison of their decoded UTF-8 bytes. Arrays retain their
schema-defined order. Strings use `\"` and `\\`, the short escapes
`\b`, `\t`, `\n`, `\f`, and `\r`, lowercase `\u00xx` for other C0 controls,
and literal UTF-8 for every other scalar, including `/`, U+2028, and U+2029.
Unicode normalization is not performed. Integers use shortest base-10 form;
`-0`, leading zeroes, decimal points, and exponent notation are noncanonical.

After duplicate-aware parsing, the parser serializes the value and requires an
exact byte-for-byte match with the original manifest. Thus whitespace,
noncanonical escapes, alternate number spellings, and unsorted object keys are
rejected rather than normalized on input. The writer always emits this form.

Schema identity arrays also have one order, compared by UTF-8 bytes:

- `renditions`, `units`, `staticFrames`, `states`, and `edges` by `id`;
- body `ports` by `id` and `portalFrames` numerically ascending;
- unit `samples` in canonical rendition order;
- reversible residency endpoints by `(state, port)`;
- `bindings` by `(source, event)`;
- readiness ID arrays lexicographically; and
- capability arrays lexicographically.

The parser rejects a semantically valid but differently ordered identity array.
The writer sorts trusted input into these orders before serialization.

## 5. Exact Compiled Manifest Schema

Every object below is closed: fields not listed for its selected union member
are rejected. Fields marked `?` may be omitted; JSON `null` is never a
substitute. `Id` matches `^[a-z][a-z0-9._-]{0,63}$`. `Sha256Hex` matches
exactly `^[0-9a-f]{64}$`. Tuple lengths are exact. IDs are unique within their
typed top-level namespace (`rendition`, `unit`, `static frame`, `state`, or
`edge`); reusing the same spelling in two different typed namespaces is valid.
Port IDs are unique within one body. All references state their namespace, so
no lookup falls back from one namespace to another.

```ts
type Id = string;
type Sha256Hex = string;
type Rect = readonly [x: number, y: number, width: number, height: number];

interface CompiledManifestV01 {
  readonly formatVersion: "0.1";
  readonly generator: string;
  readonly canvas: CanvasV01;
  readonly frameRate: RationalV01;
  readonly renditions: readonly RenditionV01[];
  readonly units: readonly UnitV01[];
  readonly staticFrames: readonly StaticFrameV01[];
  readonly initialState: Id;
  readonly states: readonly StateV01[];
  readonly edges: readonly EdgeV01[];
  readonly bindings: readonly BindingV01[];
  readonly readiness: ReadinessV01;
  readonly fallback: FallbackV01;
  readonly limits: DeclaredLimitsV01;
}

interface CanvasV01 {
  readonly width: number;
  readonly height: number;
  readonly fit: "contain" | "cover" | "fill" | "none";
  readonly pixelAspect: readonly [numerator: number, denominator: number];
  readonly colorSpace: "srgb";
}

interface RationalV01 {
  readonly numerator: number;
  readonly denominator: number;
}
```

`generator` is 1–128 UTF-8 bytes and contains no C0 control. Canvas width and
height are positive integers at most 512. Pixel-aspect terms are positive
integers at most 10,000. Frame-rate terms are positive safe integers, the
denominator is at most 1,001, and the exact quotient is at most 60. All units
share this one frame rate.

### 5.1 Renditions

```ts
type RenditionV01 =
  | {
      readonly id: Id;
      readonly profile: "reference-rgba-v0";
      readonly codec: "rma.reference-rgba";
      readonly codedWidth: number;
      readonly codedHeight: number;
      readonly alphaLayout: { readonly type: "straight-rgba-v0" };
      readonly capabilities: readonly [];
    }
  | {
      readonly id: Id;
      readonly profile: "avc-annexb-opaque-v0";
      readonly codec: "avc1.42E020";
      readonly codedWidth: number;
      readonly codedHeight: number;
      readonly alphaLayout: {
        readonly type: "opaque-v0";
        readonly colorRect: Rect;
      };
      readonly bitrate: BitrateV01;
      readonly capabilities: readonly ["webcodecs", "webgl2"];
    }
  | {
      readonly id: Id;
      readonly profile: "avc-annexb-packed-alpha-v0";
      readonly codec: "avc1.42E020";
      readonly codedWidth: number;
      readonly codedHeight: number;
      readonly alphaLayout: {
        readonly type: "stacked-v0";
        readonly colorRect: Rect;
        readonly alphaRect: Rect;
      };
      readonly bitrate: BitrateV01;
      readonly capabilities: readonly ["webcodecs", "webgl2"];
    };

interface BitrateV01 {
  readonly average: number;
  readonly peak: number;
}
```

There are one to four renditions. Coded dimensions are positive, at most 2,048
each, and their product is at most 1,100,000. Every rectangle has nonnegative
origin, positive dimensions, and lies inside the coded surface. AVC average
bitrate is positive, average is at most peak, and peak is at most 8,000,000.
M4 validates these structural profile relationships only. Exact packed-alpha
geometry is M6 work.

A reference rendition's coded dimensions equal the logical canvas. It is
accepted by format and conformance tools but is explicitly not a production
WebCodecs profile. A production player must route it only to the reference
test decoder and must never pass its codec string to WebCodecs.

### 5.2 Units and samples

```ts
interface SampleSpanV01 {
  readonly rendition: Id;
  readonly sampleStart: number;
  readonly sampleCount: number;
  readonly sha256: Sha256Hex;
}

interface PortV01 {
  readonly id: Id;
  readonly entryFrame: 0;
  readonly portalFrames: readonly number[];
}

interface ResidencyEndpointV01 {
  readonly state: Id;
  readonly port: Id;
  readonly frames: number;
}

type UnitV01 =
  | {
      readonly id: Id;
      readonly kind: "body";
      readonly playback: "loop" | "finite";
      readonly frameCount: number;
      readonly ports: readonly PortV01[];
      readonly samples: readonly SampleSpanV01[];
    }
  | {
      readonly id: Id;
      readonly kind: "bridge";
      readonly frameCount: number;
      readonly samples: readonly SampleSpanV01[];
    }
  | {
      readonly id: Id;
      readonly kind: "reversible";
      readonly frameCount: number;
      readonly residency: {
        readonly endpoints: readonly [
          ResidencyEndpointV01,
          ResidencyEndpointV01
        ];
      };
      readonly samples: readonly SampleSpanV01[];
    }
  | {
      readonly id: Id;
      readonly kind: "one-shot";
      readonly frameCount: number;
      readonly samples: readonly SampleSpanV01[];
    };
```

There are one to 96 units. Every frame count is positive; a looping body has at
least two frames; a reversible unit has at most 24. The sum of all unit frame
counts is at most 900. The number of unit/rendition pairs plus static frames is
at most 128. A body has at most 16 ports. Each port has at least one sorted,
unique portal frame inside the unit, and entry frame is zero.

Every unit has exactly one sample span per rendition in rendition order. Its
`sampleCount` equals `frameCount`; its `sampleStart` and index records obey
Section 3.2. `sha256` represents SHA-256 over the exact concatenation of that
pair's access-unit payload bytes, excluding alignment padding.

A reversible unit names two distinct `(state, port)` endpoints. Each runway is
6–12 frames. Its two inverse edges must connect exactly those states; each
portal start must use the listed source endpoint, and every edge target port
must use the listed destination endpoint. A finish start may omit a source
port in graph semantics, but the corresponding residency endpoint still names
the body port whose restart runway is retained.

### 5.3 Static frames, states, and edges

```ts
interface StaticFrameV01 {
  readonly id: Id;
  readonly offset: number;
  readonly length: number;
  readonly width: number;
  readonly height: number;
  readonly sha256: Sha256Hex;
}

interface StateV01 {
  readonly id: Id;
  readonly bodyUnit: Id;
  readonly staticFrame: Id;
  readonly initialUnit?: Id;
}

type TriggerV01 =
  | { readonly type: "event"; readonly name: Id }
  | { readonly type: "completion" };

type StartV01 =
  | {
      readonly type: "portal";
      readonly sourcePort: Id;
      readonly targetPort: Id;
      readonly maxWaitFrames: number;
    }
  | {
      readonly type: "finish";
      readonly targetPort: Id;
      readonly maxWaitFrames: number;
    }
  | {
      readonly type: "cut";
      readonly targetPort: Id;
      readonly maxWaitFrames: 1;
    };

type TransitionV01 =
  | { readonly kind: "locked"; readonly unit: Id }
  | {
      readonly kind: "reversible";
      readonly unit: Id;
      readonly direction: "forward" | "reverse";
      readonly reverseOf?: Id;
    };

type EdgeV01 =
  | {
      readonly id: Id;
      readonly from: Id;
      readonly to: Id;
      readonly trigger?: TriggerV01;
      readonly start: Exclude<StartV01, { readonly type: "cut" }>;
      readonly transition?: TransitionV01;
      readonly continuity: "exact-authored" | "exact-reverse";
    }
  | {
      readonly id: Id;
      readonly from: Id;
      readonly to: Id;
      readonly trigger?: TriggerV01;
      readonly start: Extract<StartV01, { readonly type: "cut" }>;
      readonly continuity: "cut";
      readonly targetRunwayFrames: number;
    };
```

There are one to 32 static frames and states, and zero to 64 edges. Static
width and height equal the logical canvas; length is 1–2,097,152 bytes and
offset follows the canonical layout. A static digest covers the complete PNG
blob. Every state references one body unit and one static frame. A static frame
may be shared; every static descriptor is referenced. Only the initial state
may have `initialUnit`, which references a `one-shot` unit. Every body and
one-shot unit is referenced exactly once, every bridge by exactly one locked
edge, and every reversible unit by exactly two inverse edges. No unit remains
unused.

Start-policy, ambiguity, completion, inverse, and portal-geometry constraints
are those of M3. A cut has no transition, has continuity `cut`, and declares a
6–12-frame target runway. Non-cut edges cannot declare
`targetRunwayFrames`. A locked transition references a bridge. A reversible
transition references a reversible unit. Its primary edge has direction
`forward`, no `reverseOf`, and continuity `exact-authored`. Its inverse has
direction `reverse`, names the primary in `reverseOf`, and has continuity
`exact-reverse`. Locked and transitionless non-cut edges use
`exact-authored`.

### 5.4 Bindings, readiness, fallback, and declared limits

```ts
type BindingSourceV01 =
  | "activate"
  | "engagement.off"
  | "engagement.on"
  | "focus.in"
  | "focus.out"
  | "hidden"
  | "pointer.enter"
  | "pointer.leave"
  | "visible";

interface BindingV01 {
  readonly source: BindingSourceV01;
  readonly event: Id;
}

interface ReadinessV01 {
  readonly policy: "all-routes";
  readonly bootstrapUnits: readonly Id[];
  readonly immediateEdges: readonly Id[];
}

interface FallbackV01 {
  readonly unsupported: "per-state-static";
  readonly reducedMotion: "per-state-static";
}

interface DeclaredLimitsV01 {
  readonly maxCompiledBytes: number;
  readonly maxRuntimeBytes: number;
  readonly decodedPixelBytes: number;
  readonly persistentCacheBytes: number;
  readonly runtimeWorkingSetBytes: number;
}
```

There are at most 32 bindings and one binding per source. Every bound event is
used by at least one event-triggered edge. `bootstrapUnits` contains the
initial body's unit, the optional initial unit, and the transition and target
body units required by every `immediateEdges` entry. `immediateEdges` is
exactly the sorted set of edges originating at `initialState`. Extra valid
bootstrap units are allowed; duplicate or unreferenced IDs are not.

`maxCompiledBytes` is positive and no greater than 32 MiB; the declared file
length may not exceed it. `maxRuntimeBytes` is positive and no greater than
64 MiB. The three nonnegative estimates are at most `maxRuntimeBytes`,
`runtimeWorkingSetBytes` is at least the other two, and
`decodedPixelBytes` is at least the largest `codedWidth * codedHeight * 4`.
These values are advisory and never authorize allocation; M5.5/M7 recompute
the real working set independently.

## 6. Digest Representation and Scope

Internal digests are raw lowercase hexadecimal SHA-256 strings with 64 ASCII
characters and no `sha256-` prefix. Unit digests exclude padding and hash the
ordered concatenation of their sample bytes. Static digests hash the complete
PNG blob. The manifest itself and index have no embedded digest in 0.1.

M4 validates digest syntax but deliberately does not recompute a digest. The
canonical writer receives already computed digests and preserves them. M7 will
add streaming digest calculation and verification before persistent caching.
These internal values detect inconsistency only; publisher authenticity still
requires a host-trusted whole-file integrity value outside the asset.

## 7. Reference-frame Conformance Profile

`reference-rgba-v0` is a deterministic test payload, not a production codec.
Each access unit is independently decodable and has this exact 24-byte header:

| Offset | Field | Type | Value/rule |
|---:|---|---|---|
| 0 | magic | 4 bytes | `RMRF` |
| 4 | major | `uint8` | `0` |
| 5 | minor | `uint8` | `1` |
| 6 | header length | `uint16` | `24` |
| 8 | flags | `uint32` | `0` |
| 12 | width | `uint16` | rendition coded width |
| 14 | height | `uint16` | rendition coded height |
| 16 | frame index | `uint32` | record frame index |
| 20 | RGBA length | `uint32` | `width * height * 4` |

Exactly `RGBA length` bytes follow. Pixels are unpremultiplied 8-bit sRGB RGBA
in top-to-bottom row-major order with no row padding. The access-unit payload
ends after the final alpha byte. Every reference record has the key bit set.
Dimensions equal the logical canvas, multiplication is checked before reading,
and total payload length must be exactly `24 + width * height * 4` and within
the sample budget.

The exact helper API is:

```ts
encodeReferenceFrame(input: {
  readonly width: number;
  readonly height: number;
  readonly frameIndex: number;
  readonly rgba: Uint8Array;
}): Uint8Array;

parseReferenceFrameHeader(
  sample: Uint8Array,
  options?: FormatOptions
): ReferenceFrameHeader;

validateReferenceFrame(input: {
  readonly sample: Uint8Array;
  readonly expectedWidth: number;
  readonly expectedHeight: number;
  readonly expectedFrameIndex: number;
  readonly options?: FormatOptions;
}): ReferenceFrameDescriptor;
```

The header result contains width, height, frame index, and RGBA length. The
validated descriptor additionally contains `rgbaRange: { offset: 24, length }`
relative to the supplied sample. Neither helper result retains the input or
returns a copied pixel array; only the encoder returns new bytes. This profile
lets any implementation test header, manifest, graph, sample order, loop
scheduling, and later alpha compositing without relying on installed H.264
support. It must never be advertised as compressed or passed to WebCodecs.

## 8. Graph Adapter

`adaptManifestToMotionGraph(manifest)` is the only mapping from format fields
to M3. It resolves all IDs through `Map`, constructs a fresh
`MotionGraphDefinition`, and calls `validateMotionGraphDefinition()` before
returning `ValidatedMotionGraph`. A graph validation failure is wrapped as
`FormatError` with code `GRAPH_INVALID`.

The mapping is exact:

| Manifest | M3 graph |
|---|---|
| `initialState` | `initialState` |
| state `id` | state `id` |
| state `staticFrame` | `staticFrameId` |
| state `bodyUnit` | body `unitId` |
| body `playback: loop` | body `kind: loop` |
| finite body with one frame | body `kind: held` |
| other finite body | body `kind: finite` |
| body `frameCount`, `ports` | copied unchanged |
| state `initialUnit` | initial `unitId` plus looked-up `frameCount` |
| edge identity/endpoints/trigger/start/continuity | copied unchanged |
| locked transition `unit` | `kind: locked`, `unitId`, looked-up `frameCount` |
| reversible transition | same direction/reverse ID plus looked-up frame count |

Media-only fields, readiness hints, residency runways, bindings, and digests do
not enter M3. They are still validated by the manifest schema and reference
checks. The adapter performs no second interpretation of graph behavior.

## 9. Parser and Writer APIs

The public read API is synchronous and byte-owned by the caller:

```ts
interface ByteRange {
  readonly offset: number;
  readonly length: number;
}

interface UnitBlobRange extends ByteRange {
  readonly rendition: Id;
  readonly unit: Id;
  readonly sampleStart: number;
  readonly sampleCount: number;
  readonly sha256: Sha256Hex;
}

interface StaticBlobRange extends ByteRange {
  readonly staticFrame: Id;
  readonly sha256: Sha256Hex;
}

interface ParsedFrontIndex {
  readonly header: FormatHeader;
  readonly manifest: CompiledManifestV01;
  readonly graph: ValidatedMotionGraph;
  readonly records: readonly AccessUnitRecord[];
  readonly frontIndexRange: ByteRange;
  readonly unitBlobs: readonly UnitBlobRange[];
  readonly staticBlobs: readonly StaticBlobRange[];
}

interface ValidatedAssetLayout {
  readonly frontIndex: ParsedFrontIndex;
  readonly fileRange: ByteRange;
}

parseHeader(bytes: Uint8Array, options?: FormatOptions): FormatHeader;

parseFrontIndex(
  bytesFromFileStart: Uint8Array,
  options?: FormatOptions
): ParsedFrontIndex;

validateCompleteAsset(input: {
  readonly bytes: Uint8Array;
  readonly frontIndex?: ParsedFrontIndex;
  readonly options?: FormatOptions;
}): ValidatedAssetLayout;
```

`parseFrontIndex` requires bytes from file offset zero through
`indexOffset + indexLength`; it may receive more and ignores payload bytes. It
validates the header, manifest, zero manifest-to-index padding, exact index,
graph adapter, all descriptor references, and all numeric ranges visible from
the front index. Its result contains the frozen header, frozen manifest,
validated graph, sample records, unit/static numeric ranges, and
`frontIndexRange`. It retains neither the input buffer nor sample/static
`Uint8Array` views.

`validateCompleteAsset` requires exactly the declared number of bytes. If a
front index is supplied, the function reparses the prefix and compares every
header field, canonical manifest byte serialization, and access-unit record
field before using it; otherwise it uses the newly parsed prefix. It validates
canonical layout and zero padding, all reference-frame samples, and a shallow
PNG envelope: signature, first `IHDR` length/type, descriptor dimensions, bit
depth 8, color type 6, compression/filter method zero, and non-interlaced
mode. CRCs, chunk ordering after `IHDR`, IDAT inflation, and IEND validation
are M6. AVC payload bytes and all digest bytes remain uninspected in M4.

The writer API is:

```ts
writeCanonicalAsset(
  input: CanonicalAssetInputV01,
  options?: FormatOptions
): Uint8Array;
```

`CanonicalAssetInputV01` contains the semantic manifest fields, but unit sample
spans omit derived `sampleStart`/`sampleCount`, static descriptors omit derived
`offset`/`length`, and payloads are supplied separately as:

```ts
interface SampleDigestInputV01 {
  readonly rendition: Id;
  readonly sha256: Sha256Hex;
}

type UnitInputV01 =
  | (Omit<Extract<UnitV01, { readonly kind: "body" }>, "samples"> & {
      readonly samples: readonly SampleDigestInputV01[];
    })
  | (Omit<Extract<UnitV01, { readonly kind: "bridge" }>, "samples"> & {
      readonly samples: readonly SampleDigestInputV01[];
    })
  | (Omit<Extract<UnitV01, { readonly kind: "reversible" }>, "samples"> & {
      readonly samples: readonly SampleDigestInputV01[];
    })
  | (Omit<Extract<UnitV01, { readonly kind: "one-shot" }>, "samples"> & {
      readonly samples: readonly SampleDigestInputV01[];
    });

interface StaticFrameInputV01 {
  readonly id: Id;
  readonly width: number;
  readonly height: number;
  readonly sha256: Sha256Hex;
}

type CompiledManifestInputV01 = Omit<
  CompiledManifestV01,
  "units" | "staticFrames"
> & {
  readonly units: readonly UnitInputV01[];
  readonly staticFrames: readonly StaticFrameInputV01[];
};

interface AccessUnitInputV01 {
  readonly rendition: Id;
  readonly unit: Id;
  readonly frameIndex: number;
  readonly key: boolean;
  readonly bytes: Uint8Array;
}

interface StaticPayloadInputV01 {
  readonly staticFrame: Id;
  readonly bytes: Uint8Array;
}

interface CanonicalAssetInputV01 {
  readonly manifest: CompiledManifestInputV01;
  readonly accessUnits: readonly AccessUnitInputV01[];
  readonly staticPayloads: readonly StaticPayloadInputV01[];
}
```

Unit and static digests, dimensions, and every other semantic field remain in
the input manifest. The writer clones and validates metadata, sorts identity
arrays, derives spans and lengths, validates one payload for every required
record/blob, performs the fixed-point layout, allocates exactly one final file,
copies each payload once into it, and then parses and completely validates its
own result before returning. It never mutates caller objects.

### 9.1 Fixed-point layout

PNG offsets are absolute numbers inside the manifest. Changing their decimal
digit count can change manifest length, which moves the index and payloads.
The writer therefore uses this bounded deterministic algorithm:

1. normalize and validate semantic input, and set every derived static offset
   to zero while retaining known payload lengths;
2. serialize canonical JSON;
3. calculate the aligned index, all access-unit offsets, and all static
   offsets using checked arithmetic;
4. inject the derived values and serialize again;
5. repeat steps 3–4 until both the complete manifest bytes and every derived
   offset are unchanged; and
6. fail with `WRITER_NONCONVERGENT` after 32 iterations.

Starting from zero makes manifest length and offsets monotonic for files under
the 32 MiB cap. The 32-iteration bound is defensive. After convergence, the
writer recomputes layout once, requires an exact fixed point, writes the header
and index, and validates the finished file. It never reserves a guessed
manifest region or emits noncanonical slack.

## 10. Budgets and Checked Allocation

The immutable defaults are:

| Budget | Default |
|---|---:|
| file bytes | 32 MiB |
| manifest bytes | 1 MiB |
| index bytes | 4 MiB |
| sample bytes | 2 MiB |
| static PNG bytes | 2 MiB |
| JSON depth | 64 |
| JSON nodes | 20,000 |
| one JSON string | 4,096 UTF-8 bytes |
| states | 32 |
| edges | 64 |
| units | 96 |
| renditions | 4 |
| static frames | 32 |
| bindings | 32 |
| unit/rendition blobs plus static blobs | 128 |
| summed unit frames | 900 |
| sample records | 3,600 |
| ports per body | 16 |
| reversible frames | 24 |

`FormatOptions` may provide `budgets: Partial<FormatBudgets>`. Each override is
a nonnegative safe integer no greater than its default. Overrides only lower
limits; callers cannot opt an asset into the reference profile by raising a
budget. All count and byte budgets are enforced before constructing the
corresponding array or output buffer.

`checkedAdd`, `checkedMultiply`, `align8`, and range-end calculation reject
negative, fractional, unsafe, or over-budget results. Parser and writer code
must not use unchecked `offset + length`, `count * size`, or implicit bigint to
number conversion.

## 11. Errors and Immutability

All rejection paths exposed by this package throw `FormatError`, never a raw
`SyntaxError`, `RangeError`, `TypeError`, graph error, or allocation error.
`FormatError` has frozen `name`, `code`, and optional `path` and `offset`
properties. Its stable code union is:

```text
INPUT_INVALID
BUDGET_EXCEEDED
INTEGER_UNSAFE
HEADER_INVALID
VERSION_UNSUPPORTED
FEATURE_UNSUPPORTED
JSON_INVALID
JSON_DUPLICATE_KEY
JSON_DANGEROUS_KEY
JSON_NONCANONICAL
MANIFEST_INVALID
GRAPH_INVALID
INDEX_INVALID
LAYOUT_INVALID
PROFILE_INVALID
REFERENCE_FRAME_INVALID
PNG_ENVELOPE_INVALID
WRITER_INVALID
WRITER_NONCONVERGENT
```

Messages may become clearer without a version bump; codes and property meaning
do not. Paths use manifest notation such as `units[2].samples[0].sha256`.
Offsets are absolute file offsets. Internal built-in failures are caught at
the package boundary and mapped to the most specific stable code.

Decoded JSON objects use null prototypes internally. Public arrays, objects,
records, range descriptors, and result envelopes are recursively frozen.
Caller mutation after parsing cannot change layout or graph behavior.

## 12. Verification Gate

M4 passes only when browser-independent tests prove:

- exact header and index golden bytes on little-endian and unaligned views;
- canonical JSON key ordering, escaping, integers, fatal UTF-8, duplicate keys
  after escape decoding, dangerous keys, depth, node, and string limits;
- every closed manifest union, reference, count, canonical array order, profile
  relationship, graph mapping, and M3 rejection path;
- writer fixed-point convergence at every decimal offset-width boundary;
- byte-identical output for semantically identical inputs in different input
  orders and repeated writer runs;
- front-only parsing from the minimum prefix with no retained payload views;
- exact rendition/unit/frame record order and span mapping;
- zero padding, alignment, no gaps, no overlap/alias, and no trailing bytes;
- exact reference RGBA header/payload validation and every-frame key flags;
- shallow PNG-envelope validation without claiming full PNG conformance;
- lowercase digest syntax and exact digest coverage definitions;
- structurally valid but intentionally wrong digest values remain accepted in
  M4, proving that no integrity claim is made before M7;
- lowering each budget rejects before the corresponding large allocation;
- truncated input at every byte boundary produces a stable `FormatError`;
- targeted hostile fixtures cover unsafe `uint64`, extreme counts, integer
  overflow, duplicate and escaped keys, invalid profiles, bad sample flags,
  false ranges, nonzero padding, malformed reference frames, and PNG mismatch;
- seeded byte mutation and structure fuzzing either returns an immutable valid
  result or throws one stable `FormatError`, never another exception; and
- graph, player-web, browser, build, and audit regressions remain green.

M4 does not claim that an AVC key bit is true, that H.264 is independently
decodable, that a PNG CRC or deflate stream is valid, that a digest matches
payload bytes, or that a network response carries one entity. Those are
explicit M5–M7 gates.
