# `data-codec` Source Priority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace HTML codec MIME declarations with a required `data-codec` family attribute and make AVAL select sources by the fixed AV1 → VP9 → H265 → H264 policy regardless of DOM order.

**Architecture:** The element owns a small codec-family admission and ranking policy. `readSources()` validates direct-child `<source>` elements, rejects duplicate or malformed family declarations, preserves original indexes for diagnostics, and returns candidates in canonical priority order before any network request. Exact WebCodecs strings remain authoritative inside each `.avl` manifest and the runtime rejects a declared-family/manifest-family mismatch.

**Tech Stack:** TypeScript, Web Components, Vitest, Playwright, Vite, API Extractor.

---

### Task 1: Define and test the element source policy

**Files:**
- Create: `packages/element/src/source-codec-policy.ts`
- Modify: `packages/element/src/player-contract.ts`
- Modify: `packages/element/test/element-inputs.test.ts`

- [ ] **Step 1: Replace exact codec-string input cases with family declarations and add priority/duplicate tests**

Use direct children with `data-codec="h264"`, `data-codec="av1"`, `data-codec="h265"`, and `data-codec="vp9"`. Assert that `readSources()` returns `av1`, `vp9`, `h265`, `h264`, while retaining each element's original `sourceIndex`. Assert missing, empty, case-variant, unknown, and duplicate values produce `data-codec` failures and no ambiguous duplicate candidate.

- [ ] **Step 2: Run the focused test and verify it fails against the old MIME parser**

Run: `npx vitest run --config vitest.m9.config.ts packages/element/test/element-inputs.test.ts`

Expected: FAIL because the runtime still reads `type` and preserves DOM order.

- [ ] **Step 3: Add one authoritative policy module**

Implement:

```ts
import type { VideoCodec } from "@pixel-point/aval-format";

export const SOURCE_CODEC_PRIORITY = Object.freeze([
  "av1",
  "vp9",
  "h265",
  "h264"
] as const satisfies readonly VideoCodec[]);

export function sourceCodec(value: unknown): VideoCodec | undefined {
  return typeof value === "string" &&
    (SOURCE_CODEC_PRIORITY as readonly string[]).includes(value)
    ? value as VideoCodec
    : undefined;
}

export function compareSourceCodec(
  left: VideoCodec,
  right: VideoCodec
): number {
  return SOURCE_CODEC_PRIORITY.indexOf(left) -
    SOURCE_CODEC_PRIORITY.indexOf(right);
}
```

Change the internal `Source.codec` field from an arbitrary string to `VideoCodec`.

- [ ] **Step 4: Run the focused policy/input tests**

Run: `npx vitest run --config vitest.m9.config.ts packages/element/test/element-inputs.test.ts`

Expected: PASS.

### Task 2: Parse, validate, sort, and observe `data-codec`

**Files:**
- Modify: `packages/element/src/aval-element.ts`
- Modify: `packages/element/src/asset.ts`
- Modify: `packages/element/src/player.ts`
- Modify: `packages/element/test/element-inputs.test.ts`
- Modify: `packages/element/test/security.test.ts`
- Modify: `packages/element/test/element-cleanup-regressions.test.ts`
- Modify: `packages/element/test/element-lifecycle-regressions.test.ts`
- Modify: `packages/element/test/player-*.test.ts`
- Modify: `packages/element/test/support/provisional-startup-harness.ts`

- [ ] **Step 1: Change `readSources()` to the new public grammar**

Read only `data-codec`; record its failure attribute as `"data-codec"`; reject duplicate codec families; sort valid candidates with `compareSourceCodec`; and retain original `sourceIndex` values for diagnostics. Do not parse or accept the old `type='application/vnd.aval; codecs="…"'` form.

- [ ] **Step 2: Observe the new attribute**

Change the source mutation observer filter from:

```ts
["src", "type", "integrity"]
```

to:

```ts
["src", "data-codec", "integrity"]
```

- [ ] **Step 3: Consume codec families directly**

Remove exact-string parsing at the element/player boundary. `Asset.open()` receives the declared `VideoCodec`, validates the manifest prefix against it before qualification, and `selectPlayer()` compares `asset.manifest.codec` directly to `source.codec`. Exact rendition codec strings remain unchanged for `VideoDecoderConfig.codec`.

- [ ] **Step 4: Update internal test inputs mechanically**

Replace exact strings such as `avc1.42E020`, `hvc1.1.6.L93.B0`, `vp09.…`, and `av01.…` only where they populate `Source.codec`; keep exact strings in manifest renditions and decoder assertions. Use family literals for source inputs.

- [ ] **Step 5: Run all element tests and type checking**

Run: `npx vitest run --config vitest.m9.config.ts packages/element/test`

Run: `npm run typecheck`

Expected: PASS for both commands.

### Task 3: Update generated markup and compiler-owned pages

**Files:**
- Modify: `packages/format/src/compile-bundle-report.ts`
- Modify: `packages/compiler/src/commands/init.ts`
- Modify: `packages/compiler/src/commands/dev-ui-assets.ts`
- Modify: `packages/compiler/src/commands/dev-event-stream.ts`
- Modify: `packages/compiler/test/compile-bundle-report.test.ts`
- Modify: `packages/compiler/test/compile-command-bundle.test.ts`
- Modify: `packages/compiler/test/dev-command.test.ts`
- Modify: `packages/compiler/test/dev-server.test.ts`
- Modify: `packages/compiler/test/dev-ui-assets.test.ts`
- Modify: `packages/compiler/test/init-starter.test.ts`
- Modify: `packages/format/test/compile-bundle-report.test.ts`

- [ ] **Step 1: Add failing generated-markup tests**

Require each generated line to be exactly:

```html
<source src="av1.avl" data-codec="av1" integrity="sha256-…">
```

with the corresponding family, without an HTML `type` attribute. Assert starter and dev UI code install `data-codec` and never translate it back into `type`.

- [ ] **Step 2: Generate family markup**

Change `createCompileBundleSourceMarkup()` to serialize `asset.codec` into `data-codec`. Keep build-report `codecString` and transport MIME metadata available for validation and HTTP responses; they no longer define HTML source admission.

- [ ] **Step 3: Update dynamic source installation**

The starter, dev UI, and event-stream payload must carry the codec family and apply it using:

```ts
source.setAttribute("data-codec", asset.codec);
```

Do not set a source element `type` attribute.

- [ ] **Step 4: Run format and compiler tests**

Run: `npx vitest run --config vitest.m9.config.ts packages/format/test/compile-bundle-report.test.ts packages/compiler/test/compile-bundle-report.test.ts packages/compiler/test/compile-command-bundle.test.ts packages/compiler/test/dev-command.test.ts packages/compiler/test/dev-server.test.ts packages/compiler/test/dev-ui-assets.test.ts packages/compiler/test/init-starter.test.ts`

Expected: PASS.

### Task 4: Migrate every maintained app, demo, and browser harness

**Files:**
- Modify: `apps/playground/index.html`
- Modify: `apps/playground/src/main.ts`
- Modify: `apps/playground/src/certification/functional-fixture.ts`
- Modify: `apps/playground/src/certification/public-element-host.ts`
- Modify: `examples/*/index.html`
- Modify: `examples/grass-rabbit-codecs/codec-demo-controller.js`
- Modify: `examples/react-ref/src/StatusMotion.tsx`
- Modify: `examples/react-ref/src/main.tsx`
- Modify: `examples/react-ref/src/type-contract.tsx`
- Modify: `tests/browser/multicodec-sources.spec.ts`
- Modify: `tests/end-user-playground/diagnostics.spec.ts`
- Modify: `tests/grass-rabbit*/**`
- Modify: `tests/kinetic-orb/**`
- Modify: `tests/support/browser-diagnostic-capture.ts`
- Modify: `scripts/browser-compatibility/**`
- Modify: `scripts/fixtures/verify-all.mjs`
- Modify: `scripts/release/test-packed-dev.mjs`

- [ ] **Step 1: Migrate static markup**

Use `data-codec="av1|vp9|h265|h264"` on every AVAL source and remove source-element `type` declarations. Rename the existing temporary `data-aval-codec` placeholders to `data-codec`.

- [ ] **Step 2: Migrate dynamic DOM construction and React source models**

Represent the family explicitly and render it as `data-codec`; preserve `integrity`. Update tests to inspect `source.dataset.codec`/`getAttribute("data-codec")` instead of `source.type`.

- [ ] **Step 3: Verify no legacy HTML admission remains**

Run: `rg -n 'application/vnd\.aval; codecs|data-aval-codec|setAttribute\("type"|\.type = asset\.type' README.md docs apps examples packages/element packages/compiler tests scripts`

Expected: no source-element legacy parser or markup matches; MIME/report-only occurrences must be individually justified.

### Task 5: Update the public contract documentation and API reports

**Files:**
- Modify: `README.md`
- Modify: `packages/element/README.md`
- Modify: `docs/quick-start.md`
- Modify: `docs/element-api.md`
- Modify: `docs/element/*.md`
- Modify: `docs/compiler/authoring-video-and-states.md`
- Modify: `examples/plain-html/README.md`
- Modify: `etc/api/element.api.md`
- Modify: `etc/api/format.api.md` if generated types change

- [ ] **Step 1: Document the new grammar and priority semantics**

State that `data-codec` is required, accepts only the four lowercase families, DOM order is ignored, duplicate families are invalid, and selection always runs AV1 → VP9 → H265 → H264. Explain that the `.avl` manifest still supplies the exact decoder codec string and a declaration mismatch is an asset/configuration error.

- [ ] **Step 2: Remove obsolete guidance**

Remove instructions to preserve source order or paste exact MIME codec strings into HTML. Keep `application/vnd.aval` only where discussing HTTP response MIME types, not element admission.

- [ ] **Step 3: Regenerate API reports and validate docs**

Run: `npm run api:report`

Run: `npm run docs:check`

Run: `npm run test:examples`

Expected: PASS.

### Task 6: Full regression and demo verification

**Files:**
- Verify only; fix the narrowest source-of-truth file for any failure.

- [ ] **Step 1: Run repository static and unit gates**

Run: `npm run build`

Run: `npm run typecheck`

Run: `npm run test:unit`

Run: `npm run check:generated`

Expected: PASS.

- [ ] **Step 2: Run browser and every maintained demo suite**

Run: `npm run test:browser`

Run: `npm run test:playground`

Run: `npm run test:grass-rabbit`

Run: `npm run test:grass-rabbit-codecs`

Run: `npm run test:kinetic-orb`

Expected: PASS with each demo reaching its existing interactive playback assertions.

- [ ] **Step 3: Review the final diff**

Confirm that codec priority has one authority, old HTML MIME parsing is absent, source indexes remain diagnostic-only, exact manifest codec strings still reach WebCodecs, and no generated asset was accidentally re-encoded.

