# Latest-Only Architecture Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove legacy wire, codec, parser, player API, fixture, and policy surfaces so the repository implements only the current project-1.0/wire-1.1 architecture used by the demos.

**Architecture:** `@pixel-point/aval-format` becomes the only owner of wire and codec validation, including a bounded staged prefix API for streaming loaders. Element keeps transport/integrity/lifecycle only, player-web keeps only production-owned paths, and the current certification bundle becomes the sole fixture authority. The AV1 -> VP9/HEVC -> H.264 ladder and libx264 C0 -> E0 normalization remain unchanged.

**Tech Stack:** TypeScript 7, ESM, Vitest, Playwright, Vite, API Extractor, Node.js 22.

---

### Task 1: Make the format contract wire 1.1 only

**Files:**
- Modify: `packages/format/src/constants.ts`
- Modify: `packages/format/src/model.ts`
- Modify: `packages/format/src/header.ts`
- Modify: `packages/format/src/manifest-schema.ts`
- Modify: `packages/format/src/manifest-rendition-schema.ts`
- Modify: `packages/format/src/writer.ts`
- Modify: `packages/format/src/index.ts`
- Modify: `packages/format/test/manifest-fixture.ts`
- Modify: `packages/format/test/writer-fixture.ts`
- Modify: `packages/format/test/header.test.ts`
- Modify: `packages/format/test/manifest-schema.test.ts`
- Modify: `packages/format/test/conformance.test.ts`
- Modify: `packages/format/test/public-api.compile.ts`
- Modify: `packages/format/test/public-api.test.ts`
- Modify: `packages/format/test/round-trip.test.ts`
- Modify: `packages/format/test/front-index.test.ts`
- Modify: `packages/format/test/asset-fixture.ts`
- Modify: `packages/format/test/fixture-generator.ts`

- [ ] **Step 1: Change focused tests to assert the latest-only boundary**

Use a wire-1.1 header and constrained-baseline manifest fixture:

```ts
const HEADER: FormatHeader = {
  major: 1,
  minor: 1,
  headerLength: 64,
  requiredFeatureFlags: 0,
  declaredFileLength: 136,
  manifestOffset: 64,
  manifestLength: 8,
  indexOffset: 72,
  indexLength: 64
};

expect(() => parseHeader(mutateMinor(encodeHeader(HEADER), 0)))
  .toThrowError(expect.objectContaining({ code: "VERSION_UNSUPPORTED" }));
```

Update `validManifest()` and writer fixtures to `formatVersion: "1.1"`, opaque layout, and `avc1.42E020`. Delete tests whose only assertion is successful wire-1.0 parsing/writing.

- [ ] **Step 2: Run the focused tests and observe the legacy-positive failures**

Run:

```sh
npx vitest run --config vitest.m9.config.ts packages/format/test/header.test.ts packages/format/test/manifest-schema.test.ts packages/format/test/conformance.test.ts packages/format/test/writer.test.ts
```

Expected: tests requiring rejection of 1.0 fail until the model/parser/writer are narrowed.

- [ ] **Step 3: Collapse public models and validation to 1.1**

Implement these exact invariants:

```ts
export type FormatVersion = "1.1";
export type ProductionRendition =
  | OpaqueProductionRenditionV1_1
  | PackedAlphaProductionRenditionV1_1;
export type CompiledManifest =
  | OpaqueCompiledManifestV1_1
  | PackedAlphaCompiledManifestV1_1;
export type FormatHeader = FormatHeaderBase & {
  readonly major: 1;
  readonly minor: 1;
};
```

Delete `ProductionRenditionV1_0`, `CompiledManifestV1_0`, and `CompiledManifestInputV1_0`. Require literal `"1.1"` in manifest validation, select rendition keys only by `layout`, emit header minor 1 unconditionally, and remove the deleted exports. Keep `VERSION_UNSUPPORTED` for every other header value.

- [ ] **Step 4: Run format type checking and focused tests**

Run:

```sh
npm run typecheck -w @pixel-point/aval-format
npx vitest run --config vitest.m9.config.ts packages/format/test
```

Expected: all format tests pass and no `V1_0` symbol remains under `packages/format/src`.

- [ ] **Step 5: Commit the wire cleanup**

```sh
git add packages/format
git commit -m "refactor(format): support wire 1.1 only"
```

### Task 2: Require canonical current codec declarations

**Files:**
- Modify: `packages/format/src/video/codec-string.ts`
- Modify: `packages/format/src/h264/codec.ts`
- Modify: `packages/format/src/h264/index.ts`
- Modify: `packages/format/src/h264/types.ts`
- Modify: `packages/format/src/h264/inspector.ts`
- Modify: `packages/format/src/h264/canonicalize.ts`
- Modify: `packages/format/src/index.ts`
- Modify: `packages/format/test/video-codec-string.test.ts`
- Modify: `packages/format/test/h264-codec.test.ts`
- Modify: `packages/format/test/h264-encoder-preparation.test.ts`
- Modify: `packages/format/test/h264-inspector.test.ts`

- [ ] **Step 1: Invert legacy codec acceptance tests**

Add the old spellings to rejection tables:

```ts
for (const value of [
  "avc1.64001E",
  "vp09.00.30.08",
  "av01.0.00M.10"
]) {
  expect(parseVideoCodecString(value)).toBeUndefined();
}
```

Keep positive coverage for complete compiler-emitted VP9/AV1 strings and
constrained-baseline declarations such as `avc1.42E01E`.

- [ ] **Step 2: Run codec tests and confirm they expose current permissiveness**

Run:

```sh
npx vitest run --config vitest.m9.config.ts packages/format/test/video-codec-string.test.ts packages/format/test/h264-codec.test.ts packages/format/test/h264-encoder-preparation.test.ts
```

Expected: old High/short declarations are still accepted before implementation.

- [ ] **Step 3: Delete old public codec paths**

Remove `VP9_SHORT`, `AV1_SHORT`, `H264HighCodec`, High-profile lookup entries, High-rate scaling, and the profile-dispatch helper. The canonical public helper returns baseline:

```ts
export type H264Codec = H264ConstrainedBaselineCodec;

export function h264CodecForLevel(
  levelIdc: number
): H264ConstrainedBaselineCodec {
  const suffix = h264LevelSuffix(levelIdc);
  return `avc1.42E0${suffix}` as H264ConstrainedBaselineCodec;
}
```

High-profile SPS input must terminate as `PROFILE_INVALID`; it must not produce a public rendition inspection. Preserve encoder-candidate C0 signaling and its canonical rewrite to E0.

- [ ] **Step 4: Run all H.264 and codec tests**

Run:

```sh
npx vitest run --config vitest.m9.config.ts packages/format/test/h264-codec.test.ts packages/format/test/h264-inspector.test.ts packages/format/test/h264-encoder-preparation.test.ts packages/format/test/video-codec-string.test.ts
```

Expected: canonical declarations pass, High/short forms fail, and C0 -> E0 remains covered.

- [ ] **Step 5: Commit the codec cleanup**

```sh
git add packages/format
git commit -m "refactor(format): require canonical codec declarations"
```

### Task 3: Add a bounded canonical staged-parser API

**Files:**
- Modify: `packages/format/src/model.ts`
- Modify: `packages/format/src/parser.ts`
- Modify: `packages/format/src/index.ts`
- Modify: `packages/format/test/front-index.test.ts`
- Modify: `packages/format/test/public-api.compile.ts`
- Modify: `packages/format/test/public-api.test.ts`
- Modify: `etc/api/format.api.md` through API report generation

- [ ] **Step 1: Add tests for manifest-stage allocation guards**

Cover truncated manifest bytes, manifest/header version mismatch, declared bytes above manifest limits, and index length inconsistent with manifest chunk counts.

```ts
const prefix = parseManifestPrefix(bytes.subarray(0, front.header.indexOffset));
expect(prefix.frontIndexRange).toEqual({
  offset: 0,
  length: front.header.indexOffset + front.header.indexLength
});
```

- [ ] **Step 2: Run the focused parser test and confirm the API is missing**

Run:

```sh
npx vitest run --config vitest.m9.config.ts packages/format/test/front-index.test.ts
```

Expected: compile/test failure because `parseManifestPrefix` is not exported.

- [ ] **Step 3: Implement and reuse the staged parser**

Add:

```ts
export interface ParsedManifestPrefix {
  readonly header: FormatHeader;
  readonly manifest: CompiledManifest;
  readonly frontIndexRange: ByteRange;
}

export function parseManifestPrefix(
  bytesFromFileStart: Uint8Array,
  options?: FormatOptions
): Readonly<ParsedManifestPrefix>;
```

The implementation parses the header, requires bytes through `indexOffset`, validates canonical JSON and zero manifest padding, checks `declaredFileLength <= manifest.limits.maxCompiledBytes`, derives the exact expected index length from manifest chunk counts, and returns the bounded front-index range. Refactor `parseFrontIndex()` to call it so there is one manifest-stage authority.

- [ ] **Step 4: Run format tests and type checking**

Run:

```sh
npm run typecheck -w @pixel-point/aval-format
npx vitest run --config vitest.m9.config.ts packages/format/test/front-index.test.ts packages/format/test/manifest-hostile.test.ts packages/format/test/mutation-fuzz.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit the staged parser**

```sh
git add packages/format
git commit -m "refactor(format): expose bounded manifest prefix parsing"
```

### Task 4: Remove element's parallel wire parser

**Files:**
- Modify: `packages/element/src/asset.ts`
- Modify: `packages/element/src/graph.ts`
- Modify: `packages/element/src/readiness.ts`
- Modify: `packages/element/src/route-prefetch.ts`
- Modify: `packages/element/src/player.ts`
- Modify: `packages/element/src/provisional-startup.ts`
- Modify: `packages/element/src/decoded-output-qualifier.ts`
- Modify: `packages/element/test/asset.test.ts`
- Modify: `packages/element/test/support/provisional-output-harness.ts`
- Modify: `packages/element/test/support/provisional-startup-harness.ts`
- Modify: element tests importing legacy types or High/short codec strings

- [ ] **Step 1: Change element tests to current fixtures and canonical parser parity**

Make all helper assets wire 1.1 and all H.264 source types constrained baseline. Delete successful legacy inspection and legacy packed-alpha profile tests. Retain hostile-allocation, range fallback, digest, cancellation, and watchdog tests.

- [ ] **Step 2: Run focused element tests to establish the expected failures**

Run:

```sh
npx vitest run --config vitest.m9.config.ts packages/element/test/asset.test.ts packages/element/test/provisional-startup.test.ts packages/element/test/element-inputs.test.ts
```

- [ ] **Step 3: Replace schema logic with canonical format adapters**

Import `parseHeader`, `parseManifestPrefix`, `parseFrontIndex`, `validateCompleteAsset`, `parseVideoCodecString`, and current format types. Delete the local magic, budget, canonical JSON, schema, relation, header, index, codec, and layout block.

Use the staged sequence in unknown-length full responses:

```ts
// 64 bytes
const header = parseHeader(prefix);
// bytes through header.indexOffset
const admission = parseManifestPrefix(prefix);
requireFamily(admission.manifest, expectedFamily);
// bytes through admission.frontIndexRange.length
const front = parseFrontIndex(prefix);
// after the complete body arrives
validateCompleteAsset({ bytes: output, frontIndex: front });
```

Use `ParsedFrontIndex.records` directly and update record consumers to `byteOffset`/`byteLength`; use `unitBlobs` directly. At the element boundary, map any canonical format error to the existing `Error("Invalid AVAL asset")`. Keep all HTTP, ETag, range/full fallback, integrity, queue, cache, and disposal code unchanged.

- [ ] **Step 4: Remove the legacy qualification branch**

`outputWitness()` now handles only current layouts:

```ts
if (manifest.layout === "opaque") return requireRendition(manifest, renditionId), null;
return requirePackedRendition(manifest, renditionId).outputQualification;
```

Keep `UnsupportedPlaybackProfileError` only for genuine runtime codec/renderer unsupported outcomes, not wire-version compatibility.

- [ ] **Step 5: Run element tests and type checking**

Run:

```sh
npm run typecheck -w @pixel-point/aval-element
npx vitest run --config vitest.m9.config.ts packages/element/test
```

Expected: all pass, `asset.ts` is primarily a transport owner, and no duplicate codec/manifest regex remains.

- [ ] **Step 6: Commit the element consolidation**

```sh
git add packages/element
git commit -m "refactor(element): use the canonical format parser"
```

### Task 5: Remove frozen wire-1.0 fixture authority

**Files:**
- Delete: `fixtures/conformance/v1/`
- Modify: `scripts/fixtures/verify-all.mjs`
- Modify: `scripts/browser-compatibility/validate-example-assets.mjs`
- Modify: `apps/playground/fixture-routes.ts`
- Modify: `apps/playground/http-fixture-plugin.ts`
- Modify: `tests/browser/fixture-authorities.spec.ts`
- Modify: `tests/package/candidate-fixture-authority.test.ts`
- Modify: provenance/source-tree tests enumerating the legacy fixture
- Modify: `fixtures/certification/v1/README.md`

- [ ] **Step 1: Update fixture tests to require one current authority**

Remove the legacy route and typed wire-1.0 playback case. Keep the qualified identity assertion:

```ts
expect(asset.frontIndex.header).toMatchObject({ major: 1, minor: 1 });
expect(asset.frontIndex.manifest.formatVersion).toBe("1.1");
```

- [ ] **Step 2: Delete the legacy fixture bundle and plumbing**

Remove `fixtures/conformance/v1` as one resolved directory, remove it from generator/bundle checks and provenance enumerations, and make the playground plugin serve only `QUALIFIED_FIXTURE_PREFIX` plus the fatal-boundary route.

- [ ] **Step 3: Run fixture and authority tests**

Run:

```sh
npm run fixtures:verify
npx vitest run --config vitest.m9.config.ts tests/package/candidate-fixture-authority.test.ts packages/certification/test/all-provenance.test.ts
npx playwright test tests/browser/fixture-authorities.spec.ts
```

Expected: only wire-1.1 certification fixtures are discovered and served.

- [ ] **Step 4: Commit fixture deletion**

```sh
git add -A fixtures/conformance apps/playground scripts/fixtures scripts/browser-compatibility tests
git commit -m "refactor(fixtures): remove the wire 1.0 authority"
```

### Task 6: Delete player-web compatibility-only APIs

**Files:**
- Modify: `packages/player-web/src/runtime/frame-renderer.ts`
- Modify: `packages/player-web/src/runtime/frame-renderer.test.ts`
- Modify: `packages/player-web/src/runtime/cut-presentation-contracts.ts`
- Modify: `packages/player-web/src/runtime/cut-presentation-coordinator.ts`
- Modify: `packages/player-web/src/runtime/path-scheduler.ts`
- Modify: `packages/player-web/src/runtime/path-scheduler-model.ts`
- Modify: `packages/player-web/src/runtime/path-scheduler-resident-runway.ts`
- Modify: `packages/player-web/src/runtime/interaction-cache-plan.ts`
- Modify: `packages/player-web/src/runtime/presentation-geometry.ts`
- Modify: `packages/player-web/src/runtime/browser-presentation-options.ts`
- Modify: `packages/player-web/src/runtime/browser-presentation-planes.ts`
- Modify: `packages/player-web/src/runtime/runtime-asset-session.ts`
- Modify: `packages/player-web/src/runtime/integrated-player-asset-session.ts`
- Modify: `packages/player-web/src/decoder-worker/protocol.ts`
- Modify: `packages/player-web/src/decoder-worker/core-validation.ts`
- Modify: `packages/player-web/src/index.ts`
- Modify: `packages/player-web/src/runtime/runtime-asset-session.test.ts`
- Modify: `packages/player-web/src/runtime/runtime-asset-eviction.test.ts`
- Modify: `packages/player-web/src/runtime/integrated-player-asset-session.test.ts`
- Modify: `packages/player-web/src/runtime/frame-renderer.test.ts`
- Modify: `packages/player-web/src/runtime/integrated-player-cut.test.ts`
- Modify: `packages/player-web/src/runtime/path-scheduler.test.ts`
- Modify: `packages/player-web/src/runtime/interaction-cache-plan.test.ts`
- Modify: `packages/player-web/src/runtime/presentation-geometry.test.ts`
- Modify: `packages/player-web/src/decoder-worker/decoder-color-validation.test.ts`

- [ ] **Step 1: Point production at canonical method names**

Change integrated session capture and use from `ensureAllUnits` to `ensureRenditionUnits`, including reflective validation and parameter types. Then delete the alias from `RuntimeAssetSession` and its implementation.

- [ ] **Step 2: Remove M2 renderer restoration**

Delete `contextLossPolicy`, `markContextLost()`, `restore()`, the `lost` state, and restorable-only tests. Context loss remains terminal for the candidate; browser recovery rebuilds through `browser-context-recovery.ts`.

- [ ] **Step 3: Remove cut/scheduler compatibility shortcuts**

Delete `CutPresentationCoordinator.activateCut()`, require `enqueueMediaOperation`, delete its standalone queue, delete `PathScheduler.startResidentRunway()`, and require the production draw-barrier path to pass:

```ts
{ alreadyPresented: 1 }
```

- [ ] **Step 4: Remove no-op cache/presentation APIs**

Delete public infinite cap constants and `allowMixedRenditions`. Keep the
representation frame bound as a private constant. Make the semantic-sequence
assembly helper private and have tests enter through `createInteractionCachePlan`
with current manifests. Delete `PresentationClampReason`, `desiredBacking`,
`resolutionScale`, `clampReasons`, and `onClamp`; current geometry throws on a
limit violation and cannot produce a clamped result.

- [ ] **Step 5: Require current decoder output expectations**

Make `DecoderWorkerOutputExpectation.colorSpace` non-null and simplify validation to classify against that exact expectation. Production already supplies BT.709 limited-range metadata.

- [ ] **Step 6: Run player-web tests and type checking**

Run:

```sh
npm run typecheck -w @pixel-point/aval-player-web
npx vitest run --config vitest.m9.config.ts packages/player-web/src
```

Expected: all tests pass and searches find none of the deleted alias/options/comments.

- [ ] **Step 7: Commit the player cleanup**

```sh
git add packages/player-web
git commit -m "refactor(player-web): remove compatibility-only APIs"
```

### Task 7: Align examples, docs, and release policy

**Files:**
- Modify: legacy H.264 `<source>` declarations under `examples/`
- Modify: `docs/quick-start.md`
- Modify: `docs/element/getting-started.md`
- Modify: `docs/compiler.md`
- Modify: `docs/project/1.0.md`
- Delete: `docs/format/1.0.md`
- Modify: `docs/format/1.1.md`
- Modify: `docs/versioning.md`
- Modify: `packages/format/README.md`
- Modify: `packages/compiler/README.md`
- Modify: `config/release/release-policy.json`
- Modify: `config/release/api-classification.json`
- Modify: `config/release/api-changes.json`
- Modify: `scripts/release/check-api-classification.mjs`
- Modify: release-policy tests

- [ ] **Step 1: Replace old source declarations with current generated markup**

Every active example uses full canonical codec strings and preference order:

```html
<source src="./av1.avl" type='application/vnd.aval; codecs="av01.0.00M.10.0.110.01.01.01.0"'>
<source src="./vp9.avl" type='application/vnd.aval; codecs="vp09.00.10.08.01.01.01.01.00"'>
<source src="./h265.avl" type='application/vnd.aval; codecs="hvc1.1.6.L30.90"'>
<source src="./h264.avl" type='application/vnd.aval; codecs="avc1.42E00B"'>
```

Take exact values from each example's checked-in `build.json`; do not hand-invent codec levels.

- [ ] **Step 2: Make current documentation self-consistent**

State project schema 1.0, wire 1.1 only, build-report schema 1.0, and application-owned terminal fallback. Remove live links to format 1.0. Onboarding must demonstrate the full generated ladder rather than H.264-only markup.

- [ ] **Step 3: Mark the release as technical preview**

Set release policy versions to:

```json
{
  "wireFormatVersion": "1.1",
  "projectSchemaVersion": "1.0"
}
```

Set the API default classification to `experimental`, change the API-change description away from `initial-stable-release`, and update the checker to require the technical-preview declaration. Keep synchronized package version 1.0.0 in this cleanup to avoid conflating API pruning with publication identity migration.

- [ ] **Step 4: Remove browser-matrix drift**

Replace hand-maintained release expectations with a derived/current mapping from `config/release/browser-certification-policy.json`, or add a parity gate that fails whenever release-required slots omit a required 24-month playback case. Update `release-policy.test.ts` so Android 16/17 and the current Firefox set cannot silently disappear.

- [ ] **Step 5: Run docs, examples, release, and API gates**

Run:

```sh
npm run test:examples
npm run docs:check
node scripts/release/check-api-classification.mjs
npx vitest run --config vitest.m9.config.ts packages/certification/test/release-policy.test.ts packages/certification/test/compatibility.test.ts
npm run api:report
```

Expected: all pass and generated API reports contain no deleted legacy exports.

- [ ] **Step 6: Commit policy and documentation**

```sh
git add examples docs packages/*/README.md config/release scripts/release packages/certification etc/api
git commit -m "docs: align the preview repository with wire 1.1"
```

### Task 8: Full verification and strict cleanup review

**Files:**
- Modify only files required by failing verification or strict-review findings

- [ ] **Step 1: Prove no legacy implementation remains**

Run:

```sh
rg -n 'CompiledManifestV1_0|ProductionRenditionV1_0|LegacyManifest|LegacyRendition|avc1\.6400|VP9_SHORT|AV1_SHORT|allowMixedRenditions|ensureAllUnits|contextLossPolicy|wire.?1\.0|project.?0\.2' packages apps examples fixtures scripts config docs --glob '!docs/superpowers/**' --glob '!docs/evidence/**' --glob '!**/temp/**'
```

Expected: no active-code hit; any retained historical record is explicitly historical.

- [ ] **Step 2: Run the complete local gates**

Run:

```sh
git diff --check
npm run check:generated
npm run typecheck
npm run test:unit
npm run build
npm run fixtures:verify
npm run docs:check
npm run api:check
```

Expected: every command exits 0.

- [ ] **Step 3: Run browser-facing demo verification**

Run:

```sh
npm run test:browser
npm run test:grass-rabbit
npm run test:grass-rabbit-codecs
npm run test:kinetic-orb
```

Expected: current demos prepare, render, interact, and dispose successfully through their full codec ladder.

- [ ] **Step 4: Apply the thermo-nuclear review**

Review the complete diff for moved-not-deleted compatibility, duplicate validation, files over 1,000 lines, optional compatibility flags, and aliases. Fix every high-confidence finding, rerun the affected focused tests, then rerun `git diff --check`, type checking, unit tests, and builds.

- [ ] **Step 5: Commit final verification fixes**

```sh
git add -A
git commit -m "test: verify the latest-only architecture"
```
