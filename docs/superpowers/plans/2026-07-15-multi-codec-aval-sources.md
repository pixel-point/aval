# Multi-codec AVAL Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compile H.264, H.265/HEVC, VP9, and AV1 codec variants into separate `.avl` files and let `<aval-player>` select the first browser-supported source before it fetches that variant's encoded payloads.

**Architecture:** One launch project schema (`1.0`) describes a logical animation as ordered codec-major encodings; each encoding emits one wire-format `1.0` asset through a strict codec-adapter boundary. The wire separates decoder submission order from presentation order so slow compression modes can use B-frames, lookahead, and hidden references inside independently seekable graph units. The web player probes exact WebCodecs configurations in its decoder worker and reuses only codec-neutral graph, scheduler, cache, indexed-range, and WebGL concepts; H.264-specific public surfaces, version dispatch, compatibility aliases, and unpublished legacy fixtures are removed.

**Tech Stack:** TypeScript 7, Node.js 22, FFmpeg/FFprobe, libx264, libx265, libvpx-vp9, libaom-av1, custom AVAL binary format, WebCodecs, Web Workers, WebGL2, Vitest, Playwright, API Extractor.

---

## Decisions and boundaries

- Replace project `0.1`, `0.2`, and `0.3` with one exact project `1.0` schema. Delete their parsers, versioned model types, compatibility normalization, examples, and version-specific tests; inputs carrying an older `projectVersion` fail as unsupported.
- Project `1.0` is codec-major: the ordered `encodings` array contains one unique entry per codec, and each encoding owns its rendition ladder and compression policy. H.264 is one peer codec, not a privileged default or baked-in fallback.
- Each encoding becomes one `.avl` containing that codec's complete rendition ladder and no other production codec family.
- `--out dist/motion` is a bundle-directory contract. It produces `dist/motion/av1.avl`, `vp9.avl`, `h265.avl`, `h264.avl`, and `build.json` for the requested encodings; there is no `{codec}` path templating.
- Publish by building a sibling staging directory, fsyncing it, and atomically swapping the complete bundle directory. `--force` replaces the directory as one unit and restores the previous directory on failure.
- Replace wire `0.1` with one exact wire `1.0` schema and delete dual-version parser/writer dispatch. Ordered `<source>` children are author-controlled alternatives, as with native media; the runtime does not impose a cross-file identity protocol.
- Retain the front-loaded, fixed-width range index concept because it enables bounded metadata and chunk requests, but redesign its record fields/width for decode and presentation timelines. Regenerate every fixture against the final `1.0` layout rather than preserving old bytes.
- Store codec elementary access units, not MP4, WebM, or IVF containers. IVF is allowed only as an FFmpeg stdout transport for VP9/AV1 and is stripped by the compiler.
- Store chunks in decoder submission order and store presentation timestamp, duration, random-access status, and displayed-frame cardinality independently. Allow H.264/H.265 B-frames, VP9 alternate-reference/lookahead frames, and AV1 hidden/show-existing/reordered frames inside one independently encoded graph unit; reject only dependencies across unit boundaries or a decoded presentation timeline that differs from the authored frames.
- Include AV1 8-bit and 10-bit output in the first delivery. `bitDepth: 10` maps to `yuv420p10le`; a canonical 16-bit RGBA working spool preserves available source precision, expands 8-bit sources exactly, and downconverts only for an 8-bit output.
- H.265 and VP9 output are 8-bit in this delivery. Their 10/12-bit profiles stay outside the `1.0` schema until separate browser-certification work defines them.
- Pack alpha in one decoded frame for all four codecs. Every codec must pass common alpha and composite decode-back gates.
- Direct-input compilation requires an explicit `--codec`, constructs the canonical one-source project model, and emits a one-codec bundle directory through the same pipeline. Multi-codec builds use a project file.
- Literal direct-child `<source>` elements are the sole source authority, including the one-file case. Remove host `src` and host `integrity` attributes instead of maintaining two configuration paths; child order is author preference.
- A source requires `src` and `type='application/vnd.aval; codecs="..."'`, with optional per-file `integrity`. `crossorigin` remains shared on `<aval-player>`.
- Run source preflight and exact support probes with `VideoDecoder.isConfigSupported()` inside the same module-worker environment used for decoding. Never use UA sniffing or `HTMLMediaElement.canPlayType()`.
- The required `type` codec hint may reject a deterministically unsupported family before network access. Otherwise, fetch only bounded front metadata, then probe each exact rendition configuration before requesting encoded payload ranges.
- Advance to the next file only for deterministic codec/configuration unsupported outcomes. Network errors, CORS/CSP failures, integrity mismatch, malformed assets, WebGL/resource rejection, or general decoder failure are terminal for that generation and reveal the host fallback; they do not silently downgrade.
- Once a source is active, do not hot-switch codecs. A child-source mutation starts a new source generation and retires all old resources first.
- Replace the current top-rendition-only shortcut. Inside each candidate file, evaluate renditions in authored quality order and select the first exact decoder configuration that also fits runtime resource limits; only advance to the next codec source when no rendition in the file is supported.
- Do not add a `preload` attribute in this slice. Current preparation uses bounded header/range requests and has semantics unlike native media preload.
- Do not expose arbitrary FFmpeg arguments, arbitrary filters, output protocols, paths, muxers, metadata, or audio controls.
- Encoding has no default wall-clock cutoff because `veryslow`, `placebo`, `deadline: best`, and AV1 `cpuUsed: 0` may legitimately run for hours. `--media-timeout-ms` remains an explicit positive opt-in bound; cancellation, child-process ownership, stdout/stderr caps, and temporary-file limits always remain active.
- Do not add a persistent compiler cache. Reuse compatible temporary pixel spools only within one multi-codec build.

## Author-facing project `1.0` shape

```json
{
  "projectVersion": "1.0",
  "alpha": "auto",
  "canvas": {
    "width": 1920,
    "height": 1080,
    "fit": "contain",
    "pixelAspect": [1, 1],
    "colorSpace": "srgb"
  },
  "frameRate": { "numerator": 30, "denominator": 1 },
  "sources": [
    {
      "id": "render",
      "type": "video",
      "path": "render.mov",
      "timing": { "mode": "exact" }
    }
  ],
  "encodings": [
    {
      "codec": "av1",
      "bitDepth": 10,
      "cpuUsed": 0,
      "tiles": { "columns": 4, "rows": 2 },
      "rowMt": true,
      "threads": 32,
      "renditions": [
        { "id": "video.1x", "width": 1920, "height": "auto", "crf": 15 }
      ]
    },
    {
      "codec": "vp9",
      "deadline": "best",
      "cpuUsed": 0,
      "threads": 8,
      "renditions": [
        { "id": "video.1x", "width": 1920, "height": "auto", "crf": 40 }
      ]
    },
    {
      "codec": "h265",
      "preset": "veryslow",
      "threads": 8,
      "renditions": [
        { "id": "video.1x", "width": 1920, "height": "auto", "crf": 32 }
      ]
    },
    {
      "codec": "h264",
      "preset": "veryslow",
      "renditions": [
        { "id": "video.1x", "width": 1920, "height": "auto", "crf": 20 }
      ]
    }
  ],
  "units": [
    {
      "id": "idle.body",
      "kind": "body",
      "source": "render",
      "range": [0, 120],
      "playback": "loop",
      "ports": []
    }
  ],
  "initialState": "idle",
  "states": [{ "id": "idle", "bodyUnit": "idle.body" }],
  "edges": [],
  "bindings": []
}
```

Each ordered encoding becomes one `.avl` and owns its rendition ladder. The `alpha` field replaces versioned AVC profile names; `auto` resolves once from the canonical source audit, while `opaque` and `packed` are explicit assertions.

## Compression control mapping

| Author field | FFmpeg mapping | Scope |
| --- | --- | --- |
| rendition `width`/`height` | compiler-owned scale/pixel spool; one dimension may be `"auto"`, equivalent to FFmpeg `-2` even rounding | all codecs |
| `crf` | `-crf` | all codecs, codec-specific bounds |
| `preset` | `-preset` | H.264/H.265, exact allowlist through `placebo` |
| `deadline` | `-deadline best|good|realtime` | VP9 |
| `cpuUsed` | `-cpu-used` | VP9 `-8..8`, AV1 `0..8` |
| `bitDepth: 8|10` | `-pix_fmt yuv420p|yuv420p10le` | AV1 |
| `tiles.columns/rows` | `-tiles <columns>x<rows>` | AV1, powers of two, product at most 64 |
| `rowMt` | `-row-mt 0|1` | AV1 |
| `threads` | `-threads` | H.265/VP9/AV1, integer `1..64` |
| CRF constant quality | compiler adds `-b:v 0` | VP9/AV1 |
| audio removal | compiler always adds `-an -sn -dn` | all codecs |
| `--media-timeout-ms` | compiler process deadline | optional positive build guard; no default encode deadline |

`-tag:v hvc1`, `-tag:v av01`, and `-movflags faststart` are MP4 muxer controls and are not exposed. The manifest still contains a validated fully qualified `hvc1...`, `vp09...`, or `av01...` WebCodecs codec string. `-strict experimental` is not a compression control and is never emitted by the supported toolchain contract.

## Browser markup

```html
<aval-player crossorigin="anonymous" width="320" height="180">
  <source
    src="/motion.av1.avl"
    type='application/vnd.aval; codecs="av01.0.08M.10"'
    integrity="sha256-..."
  >
  <source
    src="/motion.vp9.avl"
    type='application/vnd.aval; codecs="vp09.00.10.08"'
    integrity="sha256-..."
  >
  <source
    src="/motion.h265.avl"
    type='application/vnd.aval; codecs="hvc1.1.6.L93.B0"'
    integrity="sha256-..."
  >
  <source
    src="/motion.h264.avl"
    type='application/vnd.aval; codecs="avc1.42E028"'
    integrity="sha256-..."
  >
  <img slot="fallback" src="/motion.png" alt="">
</aval-player>
```

The codec strings above are illustrative. Authors copy the exact values and integrity digests from the compiler bundle report.

## Standards references

- [WebCodecs configuration support](https://www.w3.org/TR/webcodecs/#config-support)
- [WebCodecs codec registry](https://w3c.github.io/webcodecs/codec_registry.html)
- [HEVC WebCodecs registration](https://w3c.github.io/webcodecs/hevc_codec_registration.html)
- [VP9 WebCodecs registration](https://www.w3.org/TR/webcodecs-vp9-codec-registration/)
- [AV1 WebCodecs registration](https://w3c.github.io/webcodecs/av1_codec_registration.html)

## File responsibility map

### Create

- `packages/compiler/src/compile/video-encoding-policy.ts`: closed codec-specific encoding union validation and FFmpeg control lowering.
- `packages/compiler/src/compile/video-codec-adapter.ts`: compiler codec-adapter contracts and registry.
- `packages/compiler/src/compile/video-rendition-pipeline.ts`: codec-neutral unit/spool/inspection/decode-back orchestration.
- `packages/compiler/src/compile/canonical-rgba16.ts`: bit-depth-preserving canonical pixel working format and bounded conversions.
- `packages/compiler/src/ffmpeg/ivf.ts`: bounded IVF stdout parser used only by VP9/AV1 compilation.
- `packages/compiler/src/commands/compile-bundle-publication.ts`: staged bundle-directory publication.
- `packages/format/src/video/model.ts`: codec-neutral rendition, geometry, color, and inspection types.
- `packages/format/src/video/geometry.ts`: shared opaque/packed-alpha storage geometry.
- `packages/format/src/video/codec-string.ts`: codec-family dispatch and fully qualified string validation.
- `packages/format/src/h265/*`: bounded Annex-B HEVC parser, canonicalizer, inspector, POC timeline derivation, and codec-string derivation.
- `packages/format/src/vp9/*`: bounded VP9 frame-header parser, inspector, and codec-string derivation.
- `packages/format/src/av1/*`: bounded AV1 OBU/sequence/frame parser, inspector, and codec-string derivation.
- `packages/player-web/src/runtime/video-codec-adapters.ts`: runtime per-codec inspection/config adapters.
- `packages/player-web/src/runtime/video-rendition-selection.ts`: quality-ordered, resource-aware rendition selection.
- `packages/player-web/src/runtime/browser-video-candidate.ts`: codec-neutral browser worker/renderer composition.
- `packages/player-web/src/runtime/source-support-probe.ts`: module-worker support-probe owner.
- `@pixel-point/aval-element`: direct-child source snapshots, MIME/codec
  validation, identity, mutation coalescing, and ordered candidate selection.
- Focused test files beside each new module.

### Rename and consolidate

- Move `packages/format/src/avc/*` to `packages/format/src/h264/*`, preserving correct parsing algorithms but renaming public `Avc*` symbols to `H264*` and deleting aliases.
- Replace compiler `avc-*` policy/pipeline files with `codecs/h264-*` plus the shared video pipeline. Remove duplicated direct and project compiler paths.
- Replace player `avc-*`, `browser-avc-*`, `opaque-*`, and `browser-opaque-*` public layers with one `Video*` runtime surface and codec adapters.
- Replace milestone fixtures under `fixtures/conformance/m4` through `m8` and every checked-in old `.avl`; reuse source media only, then generate a canonical `v1` suite.

### Core modifications

- `packages/format/src/model.ts`, `header.ts`, `access-unit-index.ts`, `parser.ts`, `writer.ts`, `writer-normalize.ts`, manifest schemas, limits, and public exports: define one wire `1.0` decode-timeline format with unversioned names.
- `packages/compiler/src/model.ts`, project parsing/normalization, compilation, discovery, CLI, inspection, unpacking, reports, dev server, and public exports: define one project/build `1.0` contract and one compiler pipeline.
- `packages/player-web/src/decoder-worker/{protocol,core-validation,core,client}.ts`, catalog, integrated preparation, resource planning, and public exports: accept the codec union, decode-order chunks, presentation-order output, and source probing.
- `@pixel-point/aval-element`: make direct-child `<source>` elements the sole
  source authority and remove host `src`/`integrity` reflection.
- Docs, examples, starter output, API reports, release classifications, browser fixtures, and certification data are regenerated for the first release rather than migrated.

### Task 1: Replace project schemas with the canonical `1.0` codec-major contract

**Files:**
- Create: `packages/compiler/src/compile/video-encoding-policy.ts`
- Replace: `packages/compiler/test/source-project-schema.test.ts`
- Create: `packages/compiler/test/video-encoding-policy.test.ts`
- Delete: `packages/compiler/src/source-project-v01-schema.ts`
- Delete: `packages/compiler/src/source-project-v02-schema.ts`
- Delete: `packages/compiler/src/source-project-v03-schema.ts`
- Delete: `packages/compiler/test/source-project-v02-schema.test.ts`
- Delete: `packages/compiler/test/source-project-v03-schema.test.ts`
- Modify: `packages/compiler/src/model.ts`
- Modify: `packages/compiler/src/source-project-normalize.ts`
- Modify: `packages/compiler/src/source-project-schema.ts`
- Modify: `packages/compiler/src/source-project-schema-common.ts`
- Modify: `packages/compiler/src/source-graph-schema.ts`
- Modify: `packages/compiler/src/source-graph-preflight.ts`
- Modify: `packages/compiler/src/index.ts`
- Test: `packages/compiler/test/public-api.compile.ts`

- [ ] **Step 1: Write failing canonical schema tests**

Cover all four codec-major encoding shapes, `alpha: auto|opaque|packed`, unique codecs, per-codec rendition ladders, numeric/`"auto"` size resolution, CRF bounds (H.264/H.265 `0..51`, VP9/AV1 `0..63`), the complete H.264/H.265 preset allowlist through `placebo`, deadline enums, VP9 `cpuUsed -8..8`, AV1 `cpuUsed 0..8`, AV1 bit depth, tile powers/product, and thread bounds. Reject both dimensions as `"auto"`, old project versions/profile names, `tag`, `movflags`, `strict`, `vf`, raw `scale`, audio, raw arguments, and codec-specific fields on the wrong union member.

```ts
expect(parseProject(projectV1())).toMatchObject({
  projectVersion: "1.0",
  alpha: "auto",
  encodings: [
    { codec: "av1", renditions: [{ id: "video.1x" }] },
    { codec: "vp9", renditions: [{ id: "video.1x" }] },
    { codec: "h265", renditions: [{ id: "video.1x" }] },
    { codec: "h264", renditions: [{ id: "video.1x" }] }
  ]
});
```

- [ ] **Step 2: Run the schema tests and confirm red**

```sh
npx vitest run --config vitest.m9.config.ts \
  packages/compiler/test/source-project-schema.test.ts \
  packages/compiler/test/video-encoding-policy.test.ts
```

Expected: old version dispatch and codec-major encoding parsing are not yet implemented.

- [ ] **Step 3: Replace versioned and AVC-first public types**

```ts
export type VideoCodec = "h264" | "h265" | "vp9" | "av1";

export type VideoEncoding =
  | H264Encoding
  | H265Encoding
  | Vp9Encoding
  | Av1Encoding;

export interface SourceRenditionTarget {
  readonly id: string;
  readonly width: number | "auto";
  readonly height: number | "auto";
  readonly crf: number;
}

export interface SourceProject {
  readonly projectVersion: "1.0";
  readonly alpha: "auto" | "opaque" | "packed";
  readonly encodings: readonly VideoEncoding[];
}
```

Remove `SourceProjectV01/V02/V03`, `Avc*`, milestone-specific error codes, and compatibility normalization exports from the public surface. Use `H264*` only for real H.264 syntax types and `Video*` for shared behavior.

- [ ] **Step 4: Implement exact schema and normalization**

Normalize each ordered codec entry directly into one output variant. Require unique codec families and unique rendition IDs inside each encoding, preserve authored codec/rendition order, require at least one numeric size dimension, and resolve the other `"auto"` dimension with aspect-preserving even rounding equivalent to `scale=<n>:-2`. Reject every project version other than `1.0`.

- [ ] **Step 5: Verify API and commit**

```sh
npx vitest run --config vitest.m9.config.ts packages/compiler/test/source-project-schema.test.ts packages/compiler/test/video-encoding-policy.test.ts
npm run typecheck -w @pixel-point/aval-compiler
npm run api:report
git add -A packages/compiler/src packages/compiler/test etc/api/compiler.api.md
git commit -m "refactor(compiler): establish project format 1.0"
```

### Task 2: Replace wire `0.1` with the `1.0` decode-timeline format

**Files:**
- Create: `packages/format/src/video/model.ts`
- Create: `packages/format/src/video/geometry.ts`
- Create: `packages/format/src/video/codec-string.ts`
- Create: `packages/format/test/video-geometry.test.ts`
- Modify: `packages/format/src/model.ts`
- Modify: `packages/format/src/constants.ts`
- Modify: `packages/format/src/header.ts`
- Modify: `packages/format/src/access-unit-index.ts`
- Modify: `packages/format/src/manifest-schema.ts`
- Modify: `packages/format/src/manifest-rendition-schema.ts`
- Modify: `packages/format/src/manifest-unit-schema.ts`
- Modify: `packages/format/src/parser.ts`
- Modify: `packages/format/src/writer.ts`
- Modify: `packages/format/src/writer-normalize.ts`
- Modify: `packages/format/src/manifest-limits-schema.ts`
- Modify: `packages/format/src/index.ts`
- Test: `packages/format/test/header.test.ts`
- Test: `packages/format/test/round-trip.test.ts`
- Test: `packages/format/test/conformance.test.ts`

- [ ] **Step 1: Write red canonical wire and decode-timeline tests**

Prove header `1.0` accepts only manifest `formatVersion: "1.0"`, every other version fails, one asset cannot mix codec families, codec/bit-depth/bitstream fields agree, chunk records are in decode order, presentation timestamps and durations are bounded integers, and each unit starts at a random-access chunk with no dependency on another unit.

```ts
const manifest: CompiledManifestInput = {
  formatVersion: "1.0",
  codec: "av1",
  bitstream: "low-overhead",
  layout: "packed-alpha",
  renditions: [av1Rendition({ bitDepth: 10 })],
  units: [unit({ chunkStart: 0, chunkCount: 9, frameCount: 8 })]
};
```

- [ ] **Step 2: Run and confirm red**

```sh
npx vitest run --config vitest.m9.config.ts \
  packages/format/test/header.test.ts \
  packages/format/test/manifest-schema.test.ts \
  packages/format/test/video-geometry.test.ts \
  packages/format/test/round-trip.test.ts \
  packages/format/test/conformance.test.ts
```

Expected: the old wire cannot express decode/presentation order separately and the `1.0` schema is not implemented.

- [ ] **Step 3: Define unversioned production and timeline types**

```ts
export type ProductionRendition = {
  readonly id: Id;
  readonly codec: string;
  readonly bitDepth: 8 | 10;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly alphaLayout: AlphaLayout;
  readonly bitrate: Bitrate;
};

export interface EncodedChunkRecord {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly presentationTimestamp: number;
  readonly duration: number;
  readonly randomAccess: boolean;
  readonly displayedFrameCount: number;
}

export interface UnitChunkSpan {
  readonly rendition: Id;
  readonly chunkStart: number;
  readonly chunkCount: number;
  readonly frameCount: number;
}
```

The file-level manifest owns `codec: h264|h265|vp9|av1`, `bitstream: annex-b|frame|low-overhead`, and `layout: opaque|packed-alpha`. H.264/H.265/VP9 require bit depth `8`; AV1 permits `8 | 10`. Chunk array order is decoder submission order; timestamps define presentation order. A chunk may yield zero or multiple frames, so unit completion is checked against its separate frame timeline.

- [ ] **Step 4: Generalize geometry and replace versioned model names**

Move common visible color, packed alpha, gutter, padding, and decoded-byte calculations behind `deriveVideoRenditionGeometry()`. The codec adapter supplies storage alignment and decoded visible-rectangle policy. Replace `RationalV01`, `CanvasV01`, `BitrateV01`, `UnitV01`, and related names with the unversioned `1.0` model; delete reference-RGBA production renditions and profile-history suffixes.

- [ ] **Step 5: Replace parser/writer version dispatch**

Make `CompiledManifest` the only manifest type and make parser/writer accept header/manifest `1.0` only. Remove old unions and reserved compatibility normalization. Redesign the fixed chunk index as needed for the timeline fields; retain fixed-width/bounded range lookup, not the old byte shape.

- [ ] **Step 6: Verify and commit**

```sh
npx vitest run --config vitest.m9.config.ts packages/format/test
npm run typecheck -w @pixel-point/aval-format
git add packages/format/src packages/format/test
git commit -m "refactor(format): establish decode-timeline wire 1.0"
```

### Task 3: Establish the canonical pixel pipeline and codec adapters

**Files:**
- Create: `packages/compiler/src/compile/video-codec-adapter.ts`
- Create: `packages/compiler/src/compile/video-rendition-pipeline.ts`
- Create: `packages/compiler/src/compile/canonical-rgba16.ts`
- Create: `packages/compiler/test/video-codec-adapter.test.ts`
- Create: `packages/compiler/test/canonical-rgba16.test.ts`
- Rename: `packages/format/src/avc/*` to `packages/format/src/h264/*`
- Rename: `packages/format/test/avc-*` to `packages/format/test/h264-*`
- Rename: `packages/compiler/src/compile/avc-encoding-policy.ts` to `packages/compiler/src/compile/h264-encoding-policy.ts`
- Rename: `packages/compiler/test/avc-encoding-policy.test.ts` to `packages/compiler/test/h264-encoding-policy.test.ts`
- Replace: `packages/compiler/src/compile/avc-rendition-pipeline.ts`
- Replace: `packages/compiler/src/compile/avc-manifest-rendition.ts`
- Modify: `packages/compiler/src/ffmpeg/encode-unit.ts`
- Modify: `packages/compiler/src/compile/project-compiler.ts`
- Delete: `packages/compiler/src/compile/direct-compiler.ts`
- Test: `packages/compiler/test/encode-argv.test.ts`
- Test: `packages/compiler/test/project-compiler-integration.test.ts`
- Delete: `packages/compiler/test/direct-compiler.test.ts`

- [ ] **Step 1: Add cross-codec adapter and high-bit-depth pixel tests**

Test the shared adapter contract with H.264: deterministic policy lowering, independent-unit encoding, decode-order chunks, presentation timestamps, manifest agreement, decode-back, packed alpha, metadata stripping, and bounded failures. Test a canonical 16-bit RGBA spool that preserves 10-bit video samples, exactly expands 8-bit PNG samples, and deterministically converts to 8-bit or 10-bit YUV outputs.

- [ ] **Step 2: Define the compiler adapter boundary**

```ts
export interface VideoCodecAdapter<TEncoding extends NormalizedVideoEncoding> {
  readonly codec: TEncoding["codec"];
  deriveGeometry(input: VideoGeometryInput): Readonly<VideoRenditionGeometry>;
  createEncodeInvocation(input: EncodeVideoUnitInput<TEncoding>): Readonly<FfmpegInvocation>;
  parseEncoderOutput(bytes: Uint8Array, expectedFrames: number): readonly Uint8Array[];
  prepareRendition(input: PrepareVideoRenditionInput): Readonly<PreparedVideoRendition>;
  decodeBack(input: DecodeBackInput): Promise<Readonly<DecodeBackResult>>;
  buildManifestRendition(input: ManifestRenditionInput): ProductionRendition;
}
```

- [ ] **Step 3: Migrate H.264 into the adapter without compatibility wrappers**

Move the correct Annex-B, SPS/PPS, slice, codec-string, and hostile-input logic into `h264/*`; rename the symbols and tests. Remove `Avc*`/`Opaque*` aliases, legacy zero-latency flags, milestone errors, old report fields, and the separate direct compiler. Make direct input construct the canonical project model and call the same pipeline.

- [ ] **Step 4: Support compression reorder inside independent units**

Remove forced `-tune zerolatency`, `-bf 0`, single-reference policy, and one-submit/one-output assumptions. Each graph unit is encoded as a closed independently decodable sequence beginning at random access; B-frames and lookahead are permitted inside it. Extend H.264 inspection to derive presentation order and reject only dependencies that cross unit boundaries.

```text
-c:v libx264 -preset <preset> -crf <crf> -pix_fmt yuv420p
-g <unitFrames> -keyint_min <unitFrames> -sc_threshold 0
-x264-params open-gop=0:repeat-headers=1:scenecut=0:keyint=N:min-keyint=N
-an -sn -dn -f h264 pipe:1
```

- [ ] **Step 5: Verify the canonical path**

```sh
npx vitest run --config vitest.m9.config.ts \
  packages/compiler/test/video-codec-adapter.test.ts \
  packages/compiler/test/canonical-rgba16.test.ts \
  packages/compiler/test/h264-encoding-policy.test.ts \
  packages/compiler/test/encode-argv.test.ts \
  packages/compiler/test/project-compiler-integration.test.ts \
  packages/format/test/h264-*.test.ts
```

Expected: one project/compiler path emits a valid H.264 `1.0` asset with presentation-correct decode-back; no deprecated compatibility API remains.

- [ ] **Step 6: Commit**

```sh
git add -A packages/compiler packages/format/src packages/format/test
git commit -m "refactor: establish canonical video codec pipeline"
```

### Task 4: Implement the H.265/HEVC elementary profile end to end

**Files:**
- Create: `packages/format/src/h265/annex-b.ts`
- Create: `packages/format/src/h265/bit-reader.ts`
- Create: `packages/format/src/h265/parameter-sets.ts`
- Create: `packages/format/src/h265/slice-header.ts`
- Create: `packages/format/src/h265/presentation-order.ts`
- Create: `packages/format/src/h265/codec.ts`
- Create: `packages/format/src/h265/inspector.ts`
- Create: `packages/format/src/h265/index.ts`
- Create: `packages/format/test/h265-*.test.ts`
- Create: `packages/compiler/src/compile/h265-encoding-policy.ts`
- Create: `packages/compiler/src/compile/h265-codec-adapter.ts`
- Create: `packages/compiler/test/h265-encoding-policy.test.ts`
- Modify: `packages/compiler/src/ffmpeg/encode-unit.ts`
- Modify: `packages/compiler/src/ffmpeg/discovery.ts`
- Test: `packages/compiler/test/encode-argv.test.ts`
- Test: `packages/compiler/test/ffmpeg-integration.test.ts`

- [ ] **Step 1: Add malicious/truncated HEVC syntax and timeline tests**

Cover NAL escaping, VPS/SPS/PPS parsing, profile-tier-level codec strings, cropping/color, stable parameter sets, access-unit boundaries, IDR/CRA rules, POC wraparound, I/P/B slices, decode-versus-presentation order, first-chunk random access plus headers, forbidden cross-unit references, metadata canonicalization, and bounded hostile input.

- [ ] **Step 2: Implement HEVC canonicalization and inspection**

Retain only AUD, VPS, SPS, PPS, and permitted VCL NAL units. Strip SEI/filler/encoder-identifying metadata. Derive the exact `hvc1...` WebCodecs string and each access unit's presentation timestamp from inspected profile-tier-level and POC fields; reject manifest/timeline disagreement.

- [ ] **Step 3: Add exact libx265 argv generation**

```text
-c:v libx265 -preset <preset> -crf <crf> -pix_fmt yuv420p
-threads <threads> -g <unitFrames> -keyint_min <unitFrames>
-sc_threshold 0
-x265-params aud=1:open-gop=0:repeat-headers=1:scenecut=0:keyint=N:min-keyint=N
-f hevc pipe:1
```

The adapter owns conformance cropping, BT.709 limited-range signaling, metadata removal, audio removal, and raw output. B-frames/reference depth chosen by the preset are allowed inside a unit; every unit is separately encoded and post-inspected as a closed dependency group.

- [ ] **Step 4: Add requested-encoder discovery/calibration**

Discovery requires `libx265` only when an H.265 encoding is requested. Record a per-codec calibration digest keyed by the exact normalized encoding policy; build reports use the same codec-neutral provenance shape for every encoder.

- [ ] **Step 5: Add real-tool compile/decode-back tests**

Compile tiny opaque and packed-alpha projects containing B-frames, parse every stored chunk, decode with FFmpeg in submission order, buffer by presentation timestamp, assert exact authored frame timeline, and run deterministic double builds with the same executable and thread setting.

- [ ] **Step 6: Verify and commit**

```sh
npx vitest run --config vitest.m9.config.ts packages/format/test/h265-*.test.ts packages/compiler/test/h265-*.test.ts packages/compiler/test/encode-argv.test.ts packages/compiler/test/ffmpeg-integration.test.ts
npm run typecheck -w @pixel-point/aval-format
npm run typecheck -w @pixel-point/aval-compiler
git add packages/format/src/h265 packages/format/test/h265-* packages/compiler/src packages/compiler/test
git commit -m "feat: add HEVC AVAL codec profile"
```

### Task 5: Implement the VP9 elementary profile end to end

**Files:**
- Create: `packages/compiler/src/ffmpeg/ivf.ts`
- Create: `packages/compiler/test/ivf.test.ts`
- Create: `packages/format/src/vp9/bit-reader.ts`
- Create: `packages/format/src/vp9/frame-header.ts`
- Create: `packages/format/src/vp9/codec.ts`
- Create: `packages/format/src/vp9/inspector.ts`
- Create: `packages/format/src/vp9/index.ts`
- Create: `packages/format/test/vp9-*.test.ts`
- Create: `packages/compiler/src/compile/vp9-encoding-policy.ts`
- Create: `packages/compiler/src/compile/vp9-codec-adapter.ts`
- Create: `packages/compiler/test/vp9-encoding-policy.test.ts`
- Modify: `packages/compiler/src/ffmpeg/encode-unit.ts`
- Modify: `packages/compiler/src/ffmpeg/discovery.ts`

- [ ] **Step 1: Test the bounded IVF transport parser**

Require `DKIF`, VP9 fourcc, declared dimensions/time base, bounded transport timestamps/frame lengths/counts, no trailing bytes, and owned payload copies. Preserve IVF record order as decoder submission order without assuming it is presentation order. IVF headers never enter `.avl` chunks.

- [ ] **Step 2: Test and implement VP9 frame inspection**

Parse uncompressed headers and superframe indexes. Require profile 0, 8-bit 4:2:0 BT.709 limited range, stable dimensions, first-unit random access, and closed dependencies. Permit hidden alternate-reference frames, superframes, and `show_existing_frame`; derive displayed-frame counts/presentation timestamps and reject only cross-unit references or mismatch with the authored timeline. Derive a fully qualified `vp09...` string and lowest valid level from inspected geometry/rate.

- [ ] **Step 3: Add exact libvpx-vp9 argv**

```text
-c:v libvpx-vp9 -crf <crf> -b:v 0 -deadline <deadline>
-cpu-used <cpuUsed> -pix_fmt yuv420p -threads <threads>
-g <unitFrames> -keyint_min <unitFrames>
-an -sn -dn -f ivf pipe:1
```

Do not force zero lookahead or disable alternate references. Post-parse IVF and post-inspect every VP9 payload, then decode-back and reject dependency or presentation-timeline mismatches.

- [ ] **Step 4: Add requested discovery/calibration and real-tool tests**

Require `libvpx-vp9` only for VP9 builds. Test `deadline: best`, `cpuUsed: 0`, bounded threads, alternate-reference output, opaque/packed presentation-correct decode-back, deterministic repeated output, and operation timeout behavior.

- [ ] **Step 5: Verify and commit**

```sh
npx vitest run --config vitest.m9.config.ts packages/compiler/test/ivf.test.ts packages/format/test/vp9-*.test.ts packages/compiler/test/vp9-*.test.ts packages/compiler/test/encode-argv.test.ts packages/compiler/test/ffmpeg-integration.test.ts
npm run typecheck -w @pixel-point/aval-format
npm run typecheck -w @pixel-point/aval-compiler
git add packages/compiler/src packages/compiler/test packages/format/src/vp9 packages/format/test/vp9-*
git commit -m "feat: add VP9 AVAL codec profile"
```

### Task 6: Implement AV1 8/10-bit elementary profiles end to end

**Files:**
- Create: `packages/format/src/av1/leb128.ts`
- Create: `packages/format/src/av1/bit-reader.ts`
- Create: `packages/format/src/av1/obu.ts`
- Create: `packages/format/src/av1/sequence-header.ts`
- Create: `packages/format/src/av1/frame-header.ts`
- Create: `packages/format/src/av1/codec.ts`
- Create: `packages/format/src/av1/inspector.ts`
- Create: `packages/format/src/av1/index.ts`
- Create: `packages/format/test/av1-*.test.ts`
- Create: `packages/compiler/src/compile/rgba16-to-yuv420.ts`
- Create: `packages/compiler/src/compile/av1-encoding-policy.ts`
- Create: `packages/compiler/src/compile/av1-codec-adapter.ts`
- Create: `packages/compiler/test/av1-encoding-policy.test.ts`
- Create: `packages/compiler/test/rgba16-to-yuv420.test.ts`
- Modify: `packages/compiler/src/compile/yuv-spool.ts`
- Modify: `packages/compiler/src/ffmpeg/encode-unit.ts`
- Modify: `packages/compiler/src/ffmpeg/discovery.ts`

- [ ] **Step 1: Test bounded AV1 low-overhead OBU parsing**

Cover canonical LEB128 lengths, forbidden/reserved OBU bits, truncation, temporal delimiter, sequence header, frame/frame-header/tile-group relationships, metadata/padding stripping, and maximum nesting/byte bounds.

- [ ] **Step 2: Test and implement AV1 profile inspection**

Require Main profile, 4:2:0, 8 or 10 bit, BT.709 limited range, stable sequence headers/dimensions, and a key frame plus sequence header at every unit start. Permit hidden frames, `show_existing_frame`, temporal units, and reference reordering inside a closed unit; derive displayed-frame counts/presentation timestamps and reject cross-unit dependencies or authored-timeline mismatch. Derive the exact `av01...` codec string including profile, level/tier, bit depth, monochrome/subsampling, and color fields.

- [ ] **Step 3: Add precision-preserving 8/10-bit YUV conversion**

```ts
export function convertRgba16ToYuv420(
  input: Uint16Array,
  geometry: VideoRenditionGeometry,
  bitDepth: 8 | 10
): Uint8Array {
  // Integer BT.709 limited-range conversion writes yuv420p or yuv420p10le.
  return convertAndPackPlanes(input, geometry, bitDepth);
}
```

Validate exact plane sizes, even geometry, limited-range mapping, alpha packing, 8-bit expansion, preservation of 10-bit source steps, downconversion rounding, cleanup, and memory accounting.

- [ ] **Step 4: Add exact libaom-av1 argv**

```text
-c:v libaom-av1 -crf <crf> -b:v 0
-pix_fmt yuv420p|yuv420p10le -cpu-used <cpuUsed>
-tiles <columns>x<rows> -row-mt 0|1 -threads <threads>
-g <unitFrames> -keyint_min <unitFrames>
-an -sn -dn -f ivf pipe:1
```

Do not emit `-strict experimental`, `-tag:v av01`, or `-movflags faststart`, and do not disable the encoder's lookahead/reference tools. Strip IVF, validate low-overhead payloads, and verify the decoded presentation timeline.

- [ ] **Step 5: Add requested discovery/calibration and real-tool tests**

Require `libaom-av1` only for AV1 builds. Compile 8-bit and the requested CRF 15 / 10-bit / CPU 0 / 4x2 tiles / row-MT / 32-thread vector, plus a small CI vector with bounded runtime. Verify opaque and packed decode-back and deterministic repeated output for the exact policy.

- [ ] **Step 6: Verify and commit**

```sh
npx vitest run --config vitest.m9.config.ts packages/format/test/av1-*.test.ts packages/compiler/test/av1-*.test.ts packages/compiler/test/rgba16-to-yuv420.test.ts packages/compiler/test/ffmpeg-integration.test.ts
npm run typecheck -w @pixel-point/aval-format
npm run typecheck -w @pixel-point/aval-compiler
git add packages/format/src/av1 packages/format/test/av1-* packages/compiler/src packages/compiler/test
git commit -m "feat: add AV1 AVAL codec profiles"
```

### Task 7: Build and atomically publish codec bundle directories

**Files:**
- Create: `packages/compiler/src/compile/project-encoding-compiler.ts`
- Create: `packages/compiler/src/commands/compile-bundle-publication.ts`
- Create: `packages/compiler/test/project-encoding-compiler.test.ts`
- Create: `packages/compiler/test/compile-bundle-publication.test.ts`
- Modify: `packages/compiler/src/compile/project-compiler.ts`
- Modify: `packages/compiler/src/commands/compile.ts`
- Modify: `packages/compiler/src/commands/compile-collisions.ts`
- Modify: `packages/compiler/src/commands/compile-publication.ts`
- Modify: `packages/compiler/src/adoption-summary.ts`
- Modify: `packages/compiler/src/model.ts`

- [ ] **Step 1: Write red encoding grouping and bundle-directory tests**

Require one source preparation/continuity/alpha audit, one artifact per ordered encoding, fixed names `<codec>.avl`, one `build.json`, rejection of duplicate codecs, refusal to treat an existing file as a bundle directory, and no output/input/temp collisions.

- [ ] **Step 2: Build variants over shared source ownership**

Prepare project sources once. Reuse temporary scaled pixel spools only when geometry, alpha layout, unit, frame range, bit depth, and pixel-pipeline version match. Always clean all spools on success, failure, cancellation, or one-codec rejection.

- [ ] **Step 3: Produce one bundle report**

```ts
interface CompileBundleReport {
  readonly reportVersion: "1.0";
  readonly assets: readonly {
    readonly codec: VideoCodec;
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly type: string;
    readonly integrity: string;
  }[];
  readonly sourceMarkup: string;
}
```

Include per-codec tool calibration, exact normalized compression settings, measured bitrate/bytes, codec strings, invocations, quality reports, and warnings. Do not include secret source URLs in adoption markup or diagnostics.

- [ ] **Step 4: Publish through an atomic directory swap**

Build every asset/report in a sibling staging directory, verify the staged bundle, fsync files and directory, then rename it to the final path. Without `--force`, fail if the final path exists. With `--force`, rename the old directory to a backup, install the stage, fsync the parent, then remove the backup; restore it on any failed rename/cancellation/race. Test every commit position and hostile namespace change.

- [ ] **Step 5: Verify and commit**

```sh
npx vitest run --config vitest.m9.config.ts packages/compiler/test/project-encoding-compiler.test.ts packages/compiler/test/compile-bundle-publication.test.ts packages/compiler/test/commands.test.ts packages/compiler/test/project-compiler-integration.test.ts
npm run typecheck -w @pixel-point/aval-compiler
git add packages/compiler/src packages/compiler/test
git commit -m "feat(compiler): publish multi-codec asset bundles"
```

### Task 8: Generalize the WebCodecs worker and runtime candidate path

**Files:**
- Create: `packages/player-web/src/runtime/video-codec-adapters.ts`
- Create: `packages/player-web/src/runtime/video-rendition-selection.ts`
- Create: `packages/player-web/src/runtime/browser-video-candidate.ts`
- Create: `packages/player-web/src/runtime/source-support-probe.ts`
- Create: `packages/player-web/src/runtime/video-codec-adapters.test.ts`
- Modify: `packages/player-web/src/decoder-worker/protocol.ts`
- Modify: `packages/player-web/src/decoder-worker/core-validation.ts`
- Modify: `packages/player-web/src/decoder-worker/core.ts`
- Modify: `packages/player-web/src/decoder-worker/client.ts`
- Modify: `packages/player-web/src/runtime/asset-catalog.ts`
- Modify: `packages/player-web/src/runtime/verified-blob-store.ts`
- Modify: `packages/player-web/src/runtime/integrated-animated-preparation.ts`
- Modify: `packages/player-web/src/runtime/integrated-player-contracts.ts`
- Modify: `packages/player-web/src/runtime/decode-timeline.ts`
- Modify: `packages/player-web/src/runtime/worker-samples.ts`
- Modify: `packages/player-web/src/runtime/submission-horizon.ts`
- Modify: `packages/player-web/src/runtime/presentation-ring.ts`
- Modify: `packages/player-web/src/index.ts`
- Delete/replace: `packages/player-web/src/runtime/avc-*`, `browser-avc-*`, `opaque-*`, `browser-opaque-*`

- [ ] **Step 1: Write protocol and adapter tests for all codecs**

Cover closed config unions, fully qualified codec strings, bit depth, exact dimensions/color, support-probe echo validation, decode-order key/delta chunks, out-of-order decoder callbacks, presentation buffering, unit flush/drain, decoder resource accounting, and malformed structured-clone inputs for all four codecs.

- [ ] **Step 2: Define the codec-neutral worker configure contract**

```ts
export interface DecoderWorkerVideoProfile {
  readonly codecFamily: "h264" | "h265" | "vp9" | "av1";
  readonly bitDepth: 8 | 10;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly frameRate: Rational;
  readonly requireBt709LimitedRange: true;
}
```

Add an abortable `probe-config` request that is valid before decoder configuration and returns only a boolean/validated echo. Configure remains once per worker; source switching disposes the worker.

- [ ] **Step 3: Dispatch borrowed inspection and decoder setup by codec**

The catalog lends verified chunk views synchronously to the selected format inspector and retains no caller-visible bytes. The adapter returns a byte-free inspection plus exact `VideoDecoderConfig`. H.264/HEVC Annex B omit `description`; VP9/AV1 use codec frame/low-overhead payloads with no description.

- [ ] **Step 4: Decode in submission order and publish in presentation order**

Submit one independent unit's chunks in index order, buffer `VideoFrame` callbacks by timestamp, validate the expected unit timeline, and call `flush()` to drain delayed frames before marking the unit ready. Never interleave dependency groups in one decoder. Preserve generation cancellation, frame credit, cache/resource budgets, and WebGL alpha behavior only where their tests remain valid under presentation-order buffering.

- [ ] **Step 5: Select the best supported rendition and replace public APIs**

Evaluate a file's rendition ladder in authored order, filtering by canvas/resource budgets and exact worker support. Export only the canonical `VideoCandidateFactory`, `createBrowserVideoCandidateComposition`, and codec-neutral helpers; delete `AvcCandidate*`, `OpaqueCandidate*`, and overload-only aliases.

- [ ] **Step 6: Verify and commit**

```sh
npx vitest run --config vitest.m9.config.ts packages/player-web/src/decoder-worker packages/player-web/src/runtime
npm run typecheck -w @pixel-point/aval-player-web
npm run api:report
git add packages/player-web/src etc/api/player-web.api.md
git commit -m "feat(player): decode validated multi-codec assets"
```

### Task 9: Add ordered HTML-like source selection to `<aval-player>`

**Historical scope:** the public element contract, canonical source-selection
runtime, lifecycle/security tests, and the player support-probe boundary.

- [ ] **Step 1: Write the sole-source-model tests**

Test direct children only, DOM order, required nonempty `src` and exact AVAL `type`, canonical codec parsing, per-source integrity, inherited host credentials, URL/string caps, frozen snapshots, duplicate candidates, fallback subtree isolation, and no URL leakage in errors. Assert host `src` and host `integrity` are absent from the public API.

- [ ] **Step 2: Define the one declarative source descriptor**

```ts
export interface AvalSourceCandidate {
  readonly src: string;
  readonly type: `application/vnd.aval; codecs="${string}"`;
  readonly codec: string;
  readonly integrity: string;
}
```

Do not add a mutable `sources` array property. The direct-child light DOM is the only declarative authority; a single-file player contains one `<source>`.

- [ ] **Step 3: Observe source children safely**

Attach one `MutationObserver` only while connected. Observe direct-child list changes and `src`, `type`, and `integrity` attribute changes on direct `<source>` children. Microtask-coalesce changes into the configuration scheduler, compare immutable retrieval identities, and start at most one new generation per task.

- [ ] **Step 4: Implement ordered capability selection**

For each source in order:

1. Parse the required `type` codec and perform a family-level module-worker probe when it can produce a deterministic rejection.
2. Skip only a deterministic unsupported result.
3. Open the candidate's bounded front-metadata session and validate wire/manifest without fetching encoded payloads.
4. Evaluate renditions in authored order and probe every otherwise-eligible exact decoder config.
5. Advance to the next source only when the file has no supported rendition.
6. Construct/publish only the selected runtime; dispose every rejected session/probe/body reader first.

- [ ] **Step 5: Lock failure policy and generation cleanup**

Test that codec/config unsupported advances, while network, CORS/CSP, integrity, malformed asset, WebGL/resource, and general decoder failures do not. Test probes completing out of order, abort/supersession, disconnect/reconnect, cross-document adoption, source mutation, no stale metadata/events/frames, and complete cleanup receipts.

- [ ] **Step 6: Verify and commit**

```sh
npx vitest run --config vitest.m9.config.ts packages/element/test packages/player-web/src/runtime/source-support-probe.test.ts
npm run typecheck -w @pixel-point/aval-element
npm run api:report
git add packages/element/src packages/element/test packages/player-web/src/runtime/source-support-probe* etc/api/element.api.md
git commit -m "feat(element): select ordered codec sources"
```

### Task 10: Extend direct CLI, inspection, unpacking, and dev workflow

**Files:**
- Modify: `packages/compiler/src/cli-args.ts`
- Modify: `packages/compiler/src/cli.ts`
- Modify: `packages/compiler/src/compile/project-compiler.ts`
- Modify: `packages/compiler/src/process-runner.ts`
- Modify: `packages/compiler/src/ffmpeg/encode-unit.ts`
- Modify: `packages/compiler/src/commands/asset-validation.ts`
- Modify: `packages/compiler/src/commands/asset.ts`
- Modify: `packages/compiler/src/commands/unpack-asset.ts`
- Modify: `packages/compiler/src/commands/dev.ts`
- Modify: `packages/compiler/src/commands/dev-server-router.ts`
- Modify: `packages/compiler/src/commands/dev-asset-responder.ts`
- Modify: `packages/compiler/src/commands/dev-event-stream.ts`
- Modify: `packages/compiler/src/commands/dev-ui-assets.ts`
- Modify: `packages/compiler/src/model.ts`
- Test: `packages/compiler/test/cli-args.test.ts`
- Test: `packages/compiler/test/commands.test.ts`
- Test: `packages/compiler/test/dev-command.test.ts`
- Test: `packages/compiler/test/dev-server.test.ts`
- Test: `packages/compiler/test/operation-timeouts.test.ts`

- [ ] **Step 1: Add exact direct CLI grammar tests**

Add `--codec`, `--deadline`, `--cpu-used`, `--bit-depth`, `--tiles`, `--row-mt`, and `--threads`. Require `--codec` for direct media; reject wrong-codec combinations, old capped-CRF requirements, and project-level encoding overrides. Remove the deprecated generic process-timeout constant; make an omitted media timeout mean no encode deadline and retain strict positive validation when supplied.

```sh
avl compile render.mov --loop 0:120 --codec av1 \
  --crf 15 --bit-depth 10 --cpu-used 0 --tiles 4x2 \
  --row-mt --threads 32 --out dist/render
```

- [ ] **Step 2: Route direct compilation through the codec registry**

Direct compilation constructs a canonical one-source/one-unit project and emits `dist/render/av1.avl` plus `build.json`. H.264/H.265 accept CRF/preset, VP9 accepts CRF/deadline/cpu/threads, and AV1 accepts the complete vector above. There is no implicit H.264 choice or separate direct pipeline.

- [ ] **Step 3: Make validation and unpack codec-neutral**

Report only `videoClaim: "syntax-dependency-and-timeline-inspected"` with per-codec inspections. Unpack elementary chunks as `.h264`, `.h265`, `.vp9`, or `.av1`, plus a JSON decode/presentation timeline; never emit `.mp4`, `.webm`, or `.ivf`.

- [ ] **Step 4: Serve codec bundles in dev**

For project `1.0`, hold one current immutable bundle directory, route each codec URL with independent ETag/range handling, publish an SSE source array, and render ordered `<source>` markup in the dev page. A rebuild swaps the full bundle only after every encoding validates.

- [ ] **Step 5: Verify and commit**

```sh
npx vitest run --config vitest.m9.config.ts packages/compiler/test/cli-args.test.ts packages/compiler/test/commands.test.ts packages/compiler/test/dev-command.test.ts packages/compiler/test/dev-server.test.ts packages/compiler/test/operation-timeouts.test.ts
npm run typecheck -w @pixel-point/aval-compiler
git add packages/compiler/src packages/compiler/test
git commit -m "feat(compiler): expose codec CLI and bundle dev workflow"
```

### Task 11: Add fixtures and browser source-selection coverage

**Files:**
- Delete: checked-in `.avl` assets and milestone metadata under `fixtures/conformance/m4`, `m5`, `m55`, `m6`, `m7`, and `m8`
- Create: `fixtures/compiler/v1/*`
- Create: `fixtures/conformance/v1/*`
- Create: `fixtures/conformance/v1/README.md`
- Create: `fixtures/conformance/v1/provenance.json`
- Create: `tests/browser/multicodec-sources.spec.ts`
- Modify: `apps/playground/m8-http-fixture-plugin.ts` or create a focused multi-codec fixture plugin
- Modify: `scripts/fixtures/verify-all.mjs`
- Modify: fixture provenance schema if additive codec fields are required

- [ ] **Step 1: Replace milestone fixtures with one reviewed `v1` suite**

Reuse reviewed source media, but regenerate every asset in wire `1.0`. Build the same opaque and packed-alpha graphs as four separate codec files with B-frame/alternate-reference/lookahead coverage. Record exact FFmpeg/FFprobe identities, encoding policies, codec strings, byte sizes, SHA-256 digests, dependency inspections, and presentation-correct decode-back results. Delete old asset digests and milestone routing.

- [ ] **Step 2: Add deterministic mocked browser selection tests**

For every support matrix, assert author order, required-type validation, only bounded metadata requests occur before selection, only the selected payload URL receives chunk requests, deterministic type rejection receives zero requests, exact rendition fallback stays within a file, exact file unsupported advances, all unsupported reveals fallback, and forbidden failures do not advance.

- [ ] **Step 3: Add lifecycle/security browser tests**

Cover source child mutations, same-task coalescing, absence of host `src`/`integrity`, per-source integrity full-fetch behavior, Range/ETag behavior without integrity, CORS credentials, CSP worker/connect restrictions, abort during probe/fetch, adoption, BFCache, no-JS/SSR markup, React hydration, and zero leaked workers/frames/bodies/sessions after retirement.

- [ ] **Step 4: Add conditional real-engine codec tests**

Probe the exact fixture config. If supported, require playback and frame/state behavior; if unsupported, require the documented fallback. Do not infer branded browser support from Playwright engine names. Store certification evidence only for named environments that actually pass.

- [ ] **Step 5: Verify and commit**

```sh
npm run fixtures:verify
npx playwright test tests/browser/multicodec-sources.spec.ts
git add fixtures apps/playground tests/browser scripts/fixtures
git commit -m "test: certify multi-codec source selection"
```

### Task 12: Replace unpublished docs/APIs/examples and run first-release gates

**Files:**
- Create: `docs/project/1.0.md`
- Create: `docs/format/1.0.md`
- Delete: `docs/project/0.2.md`
- Delete: `docs/project/0.3.md`
- Delete: `docs/format/0.1.md`
- Delete: `docs/migration/0.x-to-1.0.md`
- Modify: `docs/releases/1.0.0.md`
- Modify: `README.md`
- Modify: `packages/compiler/README.md`
- Modify: `packages/player-web/README.md`
- Modify: `packages/element/README.md`
- Modify: `docs/compiler.md`
- Modify: `docs/compiler/authoring-video-and-states.md`
- Modify: `docs/element/attributes-and-api.md`
- Modify: `docs/element/hosting-cors-csp-integrity.md`
- Modify: `docs/browser-support.md`
- Modify: `docs/troubleshooting.md`
- Modify: `docs/versioning.md`
- Modify: `scripts/docs/check-docs.mjs`
- Modify: `config/release/api-classification.json`
- Modify: API reports under `etc/api/`
- Modify: one permanent end-user example to use generated codec sources

- [ ] **Step 1: Document the exact authoring and output contracts**

Explain project/wire/report `1.0`, bundle directories, direct CLI flags, codec-specific CRF ranges, slow settings/timeouts, precision-preserving AV1 10-bit output, one codec per file, required source types, integrity per source, rendition/source selection, failure policy, and no preload/hot-switch semantics.

- [ ] **Step 2: Explain FFmpeg command differences explicitly**

State that rendition size replaces author `-vf scale`, audio is always removed, VP9/AV1 CQ derives `-b:v 0`, and MP4/WebM options (`hvc1`/`av01` tags, `faststart`, `strict experimental`) do not belong to `.avl` elementary payloads. Include the exact generated argv in build-report examples.

- [ ] **Step 3: Replace the starter and every generated example**

Make `avl init` generate the canonical project with ordered AV1, VP9, H.265, and H.264 encodings plus the required `<source>` markup. Regenerate every checked-in example asset/report and playground route in wire `1.0`; remove old `.avl` files and the root codec-support note.

- [ ] **Step 4: Replace API and release baselines**

Generate a fresh first-release API baseline containing unversioned project/format/report types and `Video*` runtime APIs. Delete deprecated `Avc*`, `Opaque*`, `SourceProjectV0*`, host `src`/`integrity`, `legacyZeroLatency`, and `avcClaim` entries. Add a repository check that public source/API reports contain zero `@deprecated` declarations or forbidden legacy names.

- [ ] **Step 5: Run the complete release gate**

```sh
npm run typecheck
npm run test:unit
npm run build
npm run test:browser
npm run test:browser:reference
npm run api:check
npm run docs:check
npm run fixtures:verify
npm run check:generated
git diff --check
```

Expected: all commands exit `0`; every checked-in `.avl` parses as wire `1.0`; no old project/wire/API identifiers remain outside archived planning history; codec-specific real tests either pass on a reported supported config or take the explicit unsupported-fallback branch.

- [ ] **Step 6: Commit final docs/generated artifacts**

```sh
git add README.md packages docs examples scripts config etc fixtures
git commit -m "docs: publish multi-codec AVAL workflow"
```

## Implementation checkpoints

1. After Tasks 1–3: review the single public schema/wire/API surface, timeline model, and removal of compatibility branches.
2. After each of Tasks 4–6: review the codec profile, hostile-input inspector, real-tool evidence, and decode-back results before starting the next codec.
3. After Task 7: review output naming, atomic rollback, report markup, and source-set identity.
4. After Tasks 8–9: review worker support probes, exact fallback policy, lifecycle cleanup, and public element semantics.
5. After Tasks 10–12: run the complete release/certification gate and inspect generated assets/reports before merge.

## Self-review result

- Spec coverage: H.264, H.265, VP9, AV1 8/10-bit, requested slow-compression controls, compression reordering/lookahead, separate `.avl` files, HTML-like sources, capability selection, exact fallback rules, CLI/dev/inspection/docs, and certification are each assigned to a task.
- No raw FFmpeg argument or MP4/WebM passthrough surface is introduced.
- The new timeline permits delayed/reordered/hidden reference frames inside independently decodable units and publishes decoded frames by authored presentation timestamp.
- The first-release contract contains one project schema, one wire schema, one compiler path, one child-source model, and no deprecated compatibility APIs.
- Type names used by later tasks match the contracts introduced in Tasks 1–3; codec-specific implementations plug into one `VideoCodecAdapter` interface.
