# Author-Controlled Media Size Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove product-policy ceilings on authored dimensions, duration, frame counts, and media bytes without downscaling or weakening structural and device-safety validation.

**Architecture:** Change wire 0.1 in place so media-size defaults use representational bounds, sample planning is compact, PNG sizes are derived with checked arithmetic, and AVC codec level follows the encoded SPS instead of a frozen Level 3.2 literal. The compiler preserves explicit project geometry and timing, and the browser either presents those exact dimensions or returns a normalized capability/resource failure. Explicit caller policies, graph-complexity limits, backpressure limits, and actual browser/GPU constraints remain.

**Tech Stack:** TypeScript 7, Node.js 22, FFmpeg/FFprobe, libx264 Annex B AVC, WebCodecs, WebGL2, Vitest, Playwright, Markdown documentation checks.

---

## Structural rules to preserve

- All byte offsets, lengths, counts, products, and allocations must be checked safe integers before use.
- Wire fields retain their encoded ranges: PNG dimensions are unsigned 32-bit, index counts and lengths are unsigned 32-bit, reference-frame dimensions are unsigned 16-bit, and header offsets remain exactly representable in JavaScript.
- `FormatBudgets` remains a caller-lowerable denial-of-service policy. Default media budgets become representational bounds and no longer reject values merely for crossing the former product defaults.
- State, edge, unit, rendition, binding, port, chunk-count, trace, diagnostic-text, request-batch, queue-depth, and process-stderr limits remain.
- No compiler or runtime path may retry with smaller dimensions, fewer frames, a lower frame rate, or an invented rendition.

### Task 1: Make frame planning compact and lift format/graph media defaults

**Files:**
- Modify: `packages/format/src/model.ts`
- Modify: `packages/format/src/constants.ts`
- Modify: `packages/format/src/sample-plan.ts`
- Modify: `packages/format/src/manifest-unit-schema.ts`
- Modify: `packages/format/src/access-unit-index.ts`
- Modify: `packages/format/src/layout.ts`
- Modify: `packages/format/src/writer-normalize.ts`
- Modify: `packages/format/src/header.ts`
- Modify: `packages/format/src/reference-frame.ts`
- Modify: `packages/graph/src/limits.ts`
- Modify: `packages/graph/src/validate.ts`
- Test: `packages/format/test/sample-plan.test.ts`
- Test: `packages/format/test/manifest-schema.test.ts`
- Test: `packages/format/test/header.test.ts`
- Test: `packages/format/test/access-unit-index.test.ts`
- Test: `packages/format/test/reference-frame.test.ts`
- Test: `packages/format/test/writer.test.ts`
- Test: `packages/graph/test/validate.test.ts`

- [x] **Step 1: Add failing tests across the former limits**

Cover a 25-frame reversible unit, more than 900 total unit frames, a declared file end above 32 MiB, a sample above 2 MiB, and a compact sample plan above 3,600 records. Retain tests proving a caller-supplied lower budget rejects the same input and unsafe/unsigned-field overflow still fails.

- [x] **Step 2: Replace the materialized sample-slot array**

Represent the plan as immutable unit/rendition spans plus a checked scalar record count. Expose ordered iteration and indexed lookup without allocating one object for every frame/rendition pair:

```ts
export interface CanonicalSamplePlan {
  readonly recordCount: number;
  readonly spans: readonly CanonicalSampleSpan[];
  records(): IterableIterator<CanonicalSampleSlot>;
  recordAt(index: number): CanonicalSampleSlot;
}
```

Update index, layout, and writer consumers to iterate the compact plan. Reject record counts above the index's unsigned-32-bit field and use checked add/multiply for span starts and counts.

- [x] **Step 3: Change media defaults to representation bounds**

Set default file/byte/frame budgets to their safe wire/JavaScript limits, while leaving graph-complexity defaults unchanged. `resolveFormatBudgets()` must still accept only lower caller overrides. Remove `GRAPH_LIMITS.maxReversibleFrames` and its transition check; keep positive-safe-integer frame validation.

- [x] **Step 4: Preserve checked parser and writer arithmetic**

Replace comparisons against old constants with checked safe-integer/uint32 operations. Normalize `Uint8Array` allocation failure to the existing format error category and preserve authored `manifest.limits.maxCompiledBytes` as an explicit project policy.

- [x] **Step 5: Run focused tests**

Run:

```sh
npx vitest run --config vitest.m9.config.ts \
  packages/format/test/sample-plan.test.ts \
  packages/format/test/manifest-schema.test.ts \
  packages/format/test/header.test.ts \
  packages/format/test/access-unit-index.test.ts \
  packages/format/test/reference-frame.test.ts \
  packages/format/test/writer.test.ts \
  packages/graph/test/validate.test.ts
```

Expected: all focused tests pass, including caller-lowered policy and malicious-overflow cases.

### Task 2: Derive PNG storage from IHDR with checked arithmetic

**Files:**
- Modify: `packages/format/src/png/profile.ts`
- Modify: `packages/format/src/png/chunks.ts`
- Modify: `packages/format/src/png/deflate.ts`
- Modify: `packages/format/src/png/unfilter.ts`
- Modify: `packages/format/src/png/decode.ts`
- Test: `packages/format/test/png-profile.test.ts`
- Test: `packages/format/test/png-chunks.test.ts`
- Test: `packages/format/test/deflate.test.ts`
- Test: `packages/format/test/png-unfilter.test.ts`
- Test: `packages/format/test/png-decode.test.ts`
- Test support: `packages/format/test/png-test-fixture.ts`

- [x] **Step 1: Add failing 513+ and overflow tests**

Prove a valid RGBA PNG wider than 512 and/or larger than 2 MiB decodes exactly. Add hostile IHDR/product overflow, truncated output, excessive output, and allocation-failure tests.

- [x] **Step 2: Add one checked RGBA layout calculation**

After validating IHDR width/height in `1..0xffffffff`, derive:

```ts
const rowBytes = checkedMultiply(width, 4, "PNG row bytes");
const filteredRowBytes = checkedAdd(rowBytes, 1, "PNG filtered row bytes");
const filteredBytes = checkedMultiply(height, filteredRowBytes, "PNG filtered bytes");
const rgbaBytes = checkedMultiply(height, rowBytes, "PNG RGBA bytes");
```

Pass these exact values through inflate and unfilter rather than recomputing with fixed 512-derived maxima.

- [x] **Step 3: Remove fixed compressed/output byte ceilings**

Keep PNG chunk-count and DEFLATE 32 KiB distance limits. Bound combined IDAT bytes by checked input length/uint32 structure and optional caller policy. Compute `32 * (compressedBytes + expectedBytes) + 4096` with checked arithmetic, allocate exactly `expectedBytes`, and normalize allocation failure.

- [x] **Step 4: Run focused PNG tests**

Run:

```sh
npx vitest run --config vitest.m9.config.ts packages/format/test/png-*.test.ts packages/format/test/deflate.test.ts
```

Expected: larger valid PNGs pass; malformed and unrepresentable inputs fail before unsafe allocation or writes.

### Task 3: Make canvas, rendition geometry, and AVC level author-controlled

**Files:**
- Modify: `packages/format/src/model.ts`
- Modify: `packages/format/src/manifest-rendition-schema.ts`
- Modify: `packages/format/src/manifest-limits-schema.ts`
- Modify: `packages/format/src/avc/types.ts`
- Modify: `packages/format/src/avc/parameter-sets.ts`
- Modify: `packages/format/src/avc/inspector.ts`
- Modify: `packages/format/src/avc/incremental-inspector.ts`
- Modify: `packages/format/src/avc/encoder-preparation.ts`
- Modify: `packages/format/src/avc/rendition-geometry.ts`
- Modify: `packages/format/src/avc/decoder-surface.ts`
- Modify: `packages/format/src/avc/canonicalize.ts`
- Modify: `packages/compiler/src/ffmpeg/encode-unit.ts`
- Modify: `packages/compiler/src/compile/avc-rendition-pipeline.ts`
- Modify: `packages/compiler/src/compile/project-compiler.ts`
- Modify: `packages/compiler/src/compile/direct-compiler.ts`
- Test: `packages/format/test/avc-rendition-geometry.test.ts`
- Test: `packages/format/test/avc-decoder-surface.test.ts`
- Test: `packages/format/test/avc-inspector.test.ts`
- Test: `packages/format/test/avc-incremental-inspector.test.ts`
- Test: `packages/format/test/avc-encoder-preparation.test.ts`
- Test: compiler encode/pipeline tests under `packages/compiler/test/`

- [x] **Step 1: Add failing geometry and codec-level tests**

Prove canvas/visible/coded geometry above 512 is preserved, formerly fixed 2,048 geometry is not silently clamped, and an SPS-valid Constrained Baseline level is reflected in the manifest codec. Keep deterministic rejection for geometry not representable by the wire or encoded SPS.

- [x] **Step 2: Replace the literal codec with validated Constrained Baseline codecs**

Use a branded/template type for `avc1.42E0xx`, derive `xx` from the canonical SPS `level_idc`, and require every unit in a rendition to use stable parameter sets and the same level. Validate macroblocks-per-frame, macroblocks-per-second, DPB, bitrate, and CPB against the H.264 table for the encoded level rather than Level 3.2 constants.

- [x] **Step 3: Let libx264 select the required level and unit-length key interval**

Remove `-level:v 3.2`, the 5,120/216,000 pre-rejection, the 64 MiB `-max_alloc`, and the fixed encoded stdout cap that recreates media policy. Derive `keyint`/`min-keyint` from each unit so a unit longer than the former 901-frame interval cannot acquire an unexpected interior IDR. Keep Baseline, no-B-frame, closed-GOP, color, deterministic-thread, and independently-decodable-unit requirements. Preserve the encoded SPS level in the prepared rendition and manifest codec.

- [x] **Step 4: Remove geometry product ceilings**

Replace 512/2,048/1,100,000 checks with positive-safe-integer and checked align/product calculations. Decoder storage calculations must be derived from coded dimensions and fail explicitly when not representable/allocatable.

- [x] **Step 5: Run focused AVC and compiler tests**

Run:

```sh
npx vitest run --config vitest.m9.config.ts packages/format/test/avc-*.test.ts packages/compiler/test/encode-unit.test.ts packages/compiler/test/avc-rendition-pipeline.test.ts
```

Expected: exact >512 geometry and dynamic level pass; profile-inconsistent or unsafe media fails with a precise error.

### Task 4: Remove compiler source-duration and output-size policies

**Files:**
- Modify: `packages/compiler/src/model.ts`
- Modify: `packages/compiler/src/source-project-schema-common.ts`
- Modify: `packages/compiler/src/source-project-v01-schema.ts`
- Modify: `packages/compiler/src/source-project-v02-schema.ts`
- Modify: `packages/compiler/src/source-graph-schema.ts`
- Modify: `packages/compiler/src/cli-args.ts`
- Modify: `packages/compiler/src/ffmpeg/discovery.ts`
- Modify: `packages/compiler/src/ffmpeg/probe.ts`
- Modify: `packages/compiler/src/process-runner.ts`
- Modify: `packages/compiler/src/input/png-sequence.ts`
- Modify: `packages/compiler/src/compile/direct-canvas.ts`
- Modify: `packages/compiler/src/compile/direct-compiler.ts`
- Modify: `packages/compiler/src/compile/frame-plan.ts`
- Modify: `packages/compiler/src/compile/normalize-timeline.ts`
- Modify: `packages/compiler/src/compile/project-compiler.ts`
- Modify: `packages/compiler/src/compile/png.ts`
- Modify: `packages/compiler/src/compile/resource-estimate.ts`
- Modify: `packages/compiler/src/compile/alpha-policy.ts`
- Modify: `packages/compiler/src/compile/alpha-quality.ts`
- Modify: `packages/compiler/src/compile/composite-quality.ts`
- Modify: `packages/compiler/src/compile/rgba-dilation.ts`
- Modify: `packages/compiler/src/compile/yuv-spool.ts`
- Modify: `packages/compiler/src/compile/rgba-spool.ts`
- Modify: `packages/compiler/src/compile/project-source.ts`
- Modify: `packages/compiler/src/ffmpeg/decode-unit.ts`
- Modify: `packages/compiler/src/commands/asset-validation.ts`
- Modify: `packages/compiler/src/commands/dev-server-model.ts`
- Modify: `packages/compiler/src/commands/compile-publication.ts`
- Modify: `packages/compiler/src/cli-output.ts`
- Test: relevant files under `packages/compiler/test/`

- [x] **Step 1: Add failing source/project tests**

Cover source dimensions above 4,096, duration above 30 seconds, source frames above 1,800, unit ranges above 900/1,800, canvas/rendition above 512, and encoded output above 32 MiB. Assert the project values remain exact and no inferred/downscaled rendition appears.

- [x] **Step 2: Replace source and schema maxima with representation checks**

Delete duration/frame/dimension policy constants and validate positive/nonnegative safe integers, rational timing, half-open ranges, source-to-canvas aspect rules, and wire field ranges. Compare aspect ratios with checked `BigInt` products. Direct compile must use the explicitly requested canvas; if none is supplied, use native source geometry exactly rather than choosing a smaller canvas. Permit authors to raise probe/media subprocess timeouts while retaining finite defaults, abort handling, and bounded stderr.

- [x] **Step 3: Stream FFprobe frame timing output**

Run one bounded metadata probe without `frame=` JSON. For timing records use FFprobe line output and a `Writable` line parser/private spool so stdout is not retained as one large JSON buffer. Generate CFR timing from validated metadata/counts; process normalize-hold timing records incrementally. Always clean private spool files on success, abort, timeout, and failure.

- [x] **Step 4: Remove fixed media stdout/scratch/materialization/publication caps**

Use checked derived expected byte counts for RGBA/YUV/encoded operations, source input, compiler spools, validation reads, dev serving, and build reports. Stream to private files where supported, remove the 1/2 GiB scratch ceilings and 32 MiB CLI/report ceilings when they are driven by media size, and normalize allocation/tool failures with the operation and requested byte count. Keep subprocess timeout, stderr, abort, disk-space checks, and atomic-output behavior.

- [x] **Step 5: Run compiler tests**

Run:

```sh
npx vitest run --config vitest.m9.config.ts packages/compiler/test
```

Expected: new formerly-over-limit cases pass, ordinary fixtures remain stable, and failure cleanup/atomicity tests pass.

### Task 5: Remove runtime media admission and presentation downscaling

**Files:**
- Modify: `packages/player-web/src/runtime/asset-fetch-contracts.ts`
- Modify: `packages/player-web/src/runtime/runtime-asset-session.ts`
- Modify: `packages/player-web/src/runtime/asset-catalog.ts`
- Modify: `packages/player-web/src/runtime/verified-blob-store.ts`
- Modify: `packages/player-web/src/runtime/sha256-verifier.ts`
- Modify: `packages/player-web/src/runtime/checked-runtime-bytes.ts`
- Modify: `packages/player-web/src/runtime/integrated-player-resource-admission.ts`
- Modify: `packages/player-web/src/runtime/static-resource-plan.ts`
- Modify: `packages/player-web/src/runtime/resource-plan.ts`
- Modify: `packages/player-web/src/runtime/page-resource-policy.ts`
- Modify: `packages/player-web/src/runtime/interaction-cache-plan.ts`
- Modify: `packages/player-web/src/experimental/resident-frame-plan.ts`
- Modify: `packages/player-web/src/runtime/presentation-geometry.ts`
- Modify: `packages/player-web/src/runtime/browser-presentation-options.ts`
- Modify: `packages/player-web/src/runtime/browser-static-canvas-plane.ts`
- Modify: `packages/player-web/src/runtime/frame-renderer-browser.ts`
- Modify: `packages/player-web/src/runtime/browser-presentation-planes.ts`
- Verify: the public element's exact-geometry presentation and fallback behavior
- Test: corresponding `*.test.ts` files in `packages/player-web/src/runtime/` and `packages/player-web/src/experimental/`

- [x] **Step 1: Add failing runtime policy tests**

Prove a valid >32 MiB asset, >64 MiB derived working set, >24-frame reversible unit, and >512 presentation are accepted when representable and explicitly permitted. Preserve tests for caller-configured lower limits and checked overflow.

- [x] **Step 2: Remove implicit asset/runtime caps**

Default file/runtime/page policies to representational/accounting bounds instead of 32/64/192 MiB. Preserve explicit host limits and authored `manifest.limits`; remove the opt-in requirement for configuring a higher host policy. Keep page accounting transactional.

- [x] **Step 3: Present exact geometry or fail**

Remove the 512 and 2,048 clamps. Compute the exact requested backing size, compare it with explicit host limits and queried `MAX_TEXTURE_SIZE`/`MAX_ARRAY_TEXTURE_LAYERS`, and return the existing normalized capability/resource failure instead of a smaller geometry. Do not mutate authored canvas/rendition/frame timing.

- [x] **Step 4: Remove fixed reversible media caps**

Remove 24-frame, 24/48 MiB, and fixed media-layer validity checks; retain checked byte/layer calculations and actual WebGL array-layer/device checks. Keep runway and queue-depth bounds that describe scheduling/backpressure rather than total media duration.

- [x] **Step 5: Run focused runtime tests**

Run:

```sh
npx vitest run --config vitest.m9.config.ts \
  packages/player-web/src/runtime/presentation-geometry.test.ts \
  packages/player-web/src/runtime/browser-static-canvas-plane.test.ts \
  packages/player-web/src/runtime/browser-presentation-planes.test.ts \
  packages/player-web/src/runtime/interaction-cache-plan.test.ts \
  packages/player-web/src/runtime/resource-plan.test.ts \
  packages/player-web/src/runtime/page-resource-policy.test.ts \
  packages/player-web/src/runtime/runtime-asset-session.test.ts \
  packages/player-web/src/experimental/resident-frame-plan.test.ts
```

Expected: exact larger geometry succeeds on capable fakes; smaller explicit device/host caps produce failure without scaling.

### Task 6: Make decoder limits derived and codec-aware

**Files:**
- Modify: `packages/player-web/src/decoder-worker/protocol.ts`
- Modify: `packages/player-web/src/decoder-worker/client-support.ts`
- Modify: `packages/player-web/src/decoder-worker/core-validation.ts`
- Modify: `packages/player-web/src/runtime/worker-samples.ts`
- Modify: `packages/player-web/src/runtime/avc-candidate-factory-config.ts`
- Modify: `packages/player-web/src/runtime/avc-rendition-selection.ts`
- Test: `packages/player-web/src/decoder-worker/decoder-worker.test.ts`
- Test: `packages/player-web/src/runtime/worker-samples.test.ts`
- Test: AVC candidate/selection tests under `packages/player-web/src/runtime/`

- [x] **Step 1: Add failing dynamic codec/byte tests**

Prove a valid Constrained Baseline codec above Level 3.2 and derived decoded storage above 64 MiB pass protocol validation, while an unsupported browser configuration follows the deterministic capability-fallback path.

- [x] **Step 2: Carry manifest codec through the worker protocol**

Validate the same `avc1.42E0xx` contract as the format package. Derive sample and decoded byte requirements from the checked asset index/profile and configured host policy instead of fixed 2/64 MiB constants. Keep pending-sample, queued-chunk, and outstanding-frame backpressure counts.

- [x] **Step 3: Use actual WebCodecs support as the boundary**

Pass the exact codec/coded dimensions to `VideoDecoder.isConfigSupported()` and `configure()`. Normalize rejection and allocation failures; never retry with a smaller configuration.

- [x] **Step 4: Run worker/runtime codec tests**

Run:

```sh
npx vitest run --config vitest.m9.config.ts packages/player-web/src/decoder-worker packages/player-web/src/runtime/worker-samples.test.ts packages/player-web/src/runtime/*avc*.test.ts
```

Expected: dynamic codec levels work end to end and unsupported configurations fail without adaptation.

### Task 7: Add the public media-preparation and state-authoring guide

**Files:**
- Create: `docs/compiler/authoring-video-and-states.md`
- Modify: `README.md`
- Modify: `docs/compiler.md`
- Modify: `docs/compiler/user-defined-states.md`
- Modify: `docs/project/0.2.md`
- Modify: `docs/format/0.1.md`
- Modify: `docs/performance-and-budgets.md`
- Modify: `docs/browser-support.md`
- Modify: `docs/security.md`
- Modify: `packages/compiler/README.md`
- Modify: `packages/format/README.md`
- Modify: `packages/player-web/README.md`
- Modify: `scripts/docs/check-docs.mjs`
- Test: `tests/docs/examples.test.ts`

- [x] **Step 1: Write one complete, copyable authoring example**

Document accepted `.mov`, `.mp4`, `.m4v`, and numbered RGBA PNG sequences; progressive/square-pixel/zero-rotation requirements; CFR exact vs normalize-hold timing; transparent-source guidance; canvas/rendition ownership; and half-open frame ranges. Include a complete project with at least two sources/units/states, an edge, posters, ports, and bindings.

- [x] **Step 2: Document the end-user flow and commands**

Include exact commands for:

```sh
npm run avl -- compile motion.json --out public/motion.avl
npm run avl -- dev motion.json
npm run avl -- inspect public/motion.avl
npm run avl -- validate public/motion.avl
```

Explain that the `.avl` contains the compiled video/media, consumers import `@pixel-point/aval-element` once, and framework code controls public element state. Link the permanent end-user playground.

- [x] **Step 3: State the size contract consistently**

Remove “bounded source,” 512/900/24/32 MiB policy claims from current public documentation. Explain exact author-controlled dimensions, no automatic downscale, representational validation, optional host policy, and platform-dependent codec/GPU/allocation failure.

- [x] **Step 4: Extend and run documentation checks**

Run:

```sh
npm run docs:check
npm run test:examples
```

Expected: the guide is required by the docs gate and every documented CLI/example remains valid.

### Task 8: Verify the complete author-to-browser flow

**Files:**
- Add or modify: browser spec under `tests/browser/`
- Add or modify: compiler-backed fixture under `fixtures/`

- [x] **Step 1: Add a compiler-backed >512 fixture**

Compile an authored asset whose logical/presentation dimension crosses 512 and assert the inspected manifest, decoded frame, canvas backing, and digest retain the exact dimensions.

- [x] **Step 2: Add deterministic device-limit coverage**

Use a controlled WebGL/WebCodecs capability below the authored requirement. Assert the player emits the normalized fallback/error and never submits a smaller backing or alternate rendition.

- [x] **Step 3: Run full verification**

Run:

```sh
npm run typecheck
npm run build:public-packages
npm run test:unit
npm run test:browser
npm run test:playground
npm run fixtures:verify
npm run docs:check
```

Expected: all repository gates pass. If the local FFmpeg version differs from the reviewed fixture toolchain, record that environment-specific fixture result separately; do not weaken byte/digest expectations.

- [x] **Step 4: Audit the removed-policy vocabulary**

Run targeted `rg` searches for the former constants/messages in active source and public docs. Classify every remaining match as a fixture value, historical design/evidence, trace/backpressure limit, explicit host policy, or structural/device constraint. No active product-policy rejection may remain.
