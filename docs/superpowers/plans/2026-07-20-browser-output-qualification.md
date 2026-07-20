# Browser Output Qualification Implementation Plan

> **For agentic workers:** Implement one checked task at a time, keep the suite green between tasks, and run the named thermo-nuclear review at both architecture checkpoints. Do not stage or modify the user's existing `examples/grass-rabbit/package.json` change.

**Goal:** Make supported Android and desktop Firefox browsers render AVAL examples correctly while preserving the exact authored codec order `AV1 -> VP9 -> HEVC/H.265 -> H.264`, rejecting corrupt provisional output before readiness, and leaving fallback UI entirely to the consumer.

**Architecture:** Extract semantic color comparison into a pure typed authority, make provisional retry states a closed union owned only by startup selection, consolidate renderer lifecycle into one controller with small WebGL2 and Canvas2D backends, and add a bounded compiler-authored witness verified against the exact encoded rendition. A separate decoded-output qualifier validates that witness before publishing readiness through one shared bounded RGBA materializer. Keep exact-null WebGL2-to-Canvas2D selection inside one codec candidate and keep renderer/materializer/post-readiness failures terminal.

**Tech stack:** TypeScript, WebCodecs, WebGL2, Canvas2D, Vitest, Playwright, Vite, Cloudflare quick tunnels, BrowserStack Live real devices.

---

## Safety and invariants

- Never change authored source order or prefer H.264 because of a browser name.
- Never add UA, OS, device, or codec-name branches to color/output validation.
- Never advance to another codec for renderer-backend failure.
- Never publish `visualReady` or `interactiveReady` before semantic output qualification succeeds.
- A packed-alpha rendition without a valid witness is terminally outside the playback-qualified profile; it never advances codecs.
- Never add static/image/video fallback rendering to AVAL; terminal exhaustion raises the existing typed error once.
- Preserve legacy packed-alpha parser/inspection readability, but fail playback terminally without a witness; regenerate first-party examples into the qualified profile.
- Preserve the user's uncommitted `examples/grass-rabbit/package.json` edit.
- Commit each completed task independently after focused tests pass.

## File map

- Create `packages/format/src/video/decoder-color.ts`: DOM-independent canonical color-space classifier and named normalization reasons.
- Create `packages/format/test/decoder-color.test.ts`: table-driven exact/normalization/incompatibility contract.
- Modify `packages/element/src/decoder.ts` and `packages/element/test/decoder.test.ts`: adapt WebCodecs tuples, consume the shared classifier, and retain raw mismatch diagnostics.
- Modify `packages/player-web/src/decoder-worker/core-validation.ts` and its tests: delete the second matcher and consume the same shared classifier.
- Create `packages/element/src/provisional-candidate-outcome.ts`: closed retryable union built only by startup selection; terminal failures remain separate.
- Modify `packages/element/src/player.ts` and `packages/element/test/player-startup-source-fallback.test.ts`: consume typed outcomes, preserve source order, remove diagnostic-shape control flow, and use canonical codec parsing.
- Create `packages/element/src/renderer-controller.ts`: common queue, materializer reuse, budgets, lifecycle, opaque target identity, and snapshots; no witness semantics.
- Create `packages/element/src/renderer-backend.ts`: narrow backend interfaces and discriminated backend details.
- Create `packages/element/src/webgl2-renderer-backend.ts`: WebGL2-only resource/upload/draw operations.
- Create `packages/element/src/rgba-materializer.ts`: one bounded `copyTo` plus allowed Canvas2D readback path.
- Create `packages/element/src/decoded-output-qualifier.ts`: validate an already-decoded witness frame's identity and semantic samples, outside the renderer; provisional startup owns scheduling.
- Refactor `packages/element/src/canvas2d-renderer.ts`: Canvas2D-only resource/upload/draw operations.
- Modify `packages/element/src/renderer.ts`, `packages/element/src/renderer-diagnostics.ts`, `packages/element/src/renderer-geometry.ts`, and their focused tests.
- Modify `packages/format/src/model.ts`, header/version dispatch, `packages/format/src/manifest-rendition-schema.ts`, `packages/format/src/writer-normalize.ts`, `packages/format/src/index.ts`, and format tests: explicit `1.0` legacy / `1.1` qualified witness schemas and strict bounded validation.
- Create `packages/compiler/src/compile/packed-alpha-witness.ts` and its test: deterministic source candidates retained only after exact emitted-rendition decode verification.
- Modify `packages/compiler/src/compile/video-rendition-pipeline.ts`, `packages/compiler/src/compile/project-encoding-compiler.ts`, and tests: carry the witness into generated manifests.
- Modify `packages/element/src/asset.ts` and its tests unconditionally because it is an independent exact-key/version reader.
- Modify `docs/browser-support.md` and `docs/format/1.0.md`; create `docs/format/1.1.md`; modify `docs/element/fallback-and-reduced-motion.md`.
- Regenerate example `.avl` assets through their existing compile scripts; do not hand-edit binary assets.
- Add fresh BrowserStack evidence under `artifacts/browser-compatibility/manual-live/<commit>/<timestamp>/`.

### Task 1: Lock and implement one shared semantic decoder color classifier

**Files:**
- Create: `packages/format/src/video/decoder-color.ts`
- Create: `packages/format/test/decoder-color.test.ts`
- Modify: `packages/format/src/index.ts`
- Modify: `packages/element/src/decoder.ts`
- Modify: `packages/element/test/decoder.test.ts`
- Modify: `packages/player-web/src/decoder-worker/core-validation.ts`
- Modify: `packages/player-web/src/decoder-worker/decoder-worker.test.ts`

- [ ] **Step 1: Write the failing pure classifier table**

Define test inputs as the four-member tuple `[primaries, transfer, matrix, fullRange]`. Assert:

```ts
expect(classifyDecoderColor(BT709_LIMITED, BT709_LIMITED)).toEqual({ kind: "exact" });
expect(classifyDecoderColor(BT709_LIMITED, ["bt709", "smpte170m", "bt709", false]))
  .toEqual({ kind: "known-normalization", normalization: "bt709-transfer-as-smpte170m" });
```

Retain the sRGB rule only for the exact tuple `["bt709", "iec61966-2-1", "bt709", false]` as `limited-bt709-srgb-transfer`; explicitly reject the same tuple with `fullRange: true`. Table every conflicting primary, matrix, range, and transfer as `incompatible` with the exact failing field. Include null members and prove they do not silently satisfy a concrete expectation.

- [ ] **Step 2: Run the new focused test and observe red**

```bash
npx vitest run --config vitest.m9.config.ts packages/format/test/decoder-color.test.ts
```

Expected: module/export missing.

- [ ] **Step 3: Implement the pure typed classifier**

Export DOM-independent immutable tuple/type definitions from
`@pixel-point/aval-format` and:

```ts
export function classifyDecoderColor(
  expected: Readonly<DecoderColorTuple>,
  actual: Readonly<DecoderColorTuple>
): Readonly<DecoderColorClassification>
```

Check exact equality first, then the two named equivalences, then return the first incompatible field in stable order. Do not inspect browser, OS, device, source, or codec.

- [ ] **Step 4: Replace `matchesColor()` in `decoder.ts`**

Build the exact tuple once from expected and `VideoFrame.colorSpace`, call the classifier, and accept `exact` or `known-normalization`. Preserve raw expected/actual tuples in `DecoderOutputFailure` for true mismatches. Delete the element's old boolean helper and the independent `matchesDecodedBt709ColorSpace()` in player-web; both use thin tuple adapters into the same authority.

- [ ] **Step 5: Add decoder integration regressions**

Use the existing fake `VideoFrame` harness to prove the captured Android tuple succeeds under the real strict player expectation. Add a true range/matrix mismatch and assert diagnostics retain both raw arrays and remain frozen.

- [ ] **Step 6: Run focused tests and typecheck**

```bash
npx vitest run --config vitest.m9.config.ts packages/format/test/decoder-color.test.ts packages/element/test/decoder.test.ts packages/player-web/src/decoder-worker/decoder-worker.test.ts
npm run typecheck -w @pixel-point/aval-element
npm run typecheck -w @pixel-point/aval-player-web
```

Expected: all pass.

### Task 2: Make the Firefox candidate feature floor explicit and deterministic

**Files:**
- Modify: `packages/element/test/player-selection.test.ts`
- Modify: `docs/browser-support.md`
- Modify: `scripts/docs/check-docs.mjs`
- Verify: `packages/element/src/player.ts`

- [ ] **Step 1: Add a missing-WebCodecs regression**

Construct a normal two-source selection input with both `platform.VideoDecoder` and `platform.VideoFrame` set to `null`. Assert creation rejects with the exact callback-returned `AvalPlaybackError`, the callback sees `unsupported-profile:prepare` exactly once, only the first source opens, no decoder worker is created, and no renderer is created.

- [ ] **Step 2: Run it red or prove the existing behavior**

```bash
npx vitest run --config vitest.m9.config.ts packages/element/test/player-selection.test.ts
```

If the assertion already passes, keep it as the new boundary regression and make no runtime branch.

- [ ] **Step 3: Document the support floor**

State Firefox 130 explicitly as the candidate desktop floor pending recorded AVAL BrowserStack qualification, including that Firefox 129 is a one-release feature-floor exception to a literal 24-month promise because it predates desktop WebCodecs. State Firefox Android separately uncertified until measured. Promote 130 to certified only in Task 11 after its pixel/interaction run passes.

Add stable Firefox-floor contract tokens to `scripts/docs/check-docs.mjs` so removing or weakening this statement fails the docs gate.

- [ ] **Step 4: Verify docs and focused test**

```bash
npm run docs:check
npx vitest run --config vitest.m9.config.ts packages/element/test/player-selection.test.ts
```

### Task 3: Consolidate canonical geometry before renderer extraction

**Files:**
- Modify: `packages/element/src/renderer-geometry.ts`
- Modify: `packages/element/src/player.ts`
- Modify: `packages/element/test/renderer.test.ts`
- Modify: `packages/element/test/canvas2d-renderer.test.ts`

- [ ] **Step 1: Add parity tests against format geometry**

Test odd/even packed-alpha sizes and assert the renderer adapter produces the same color rectangle, alpha rectangle, coded storage, and gutter as `deriveVideoRenditionGeometry()` / `PACKED_ALPHA_GUTTER` from `@pixel-point/aval-format`.

- [ ] **Step 2: Run the focused tests**

```bash
npx vitest run --config vitest.m9.config.ts packages/element/test/renderer.test.ts packages/element/test/canvas2d-renderer.test.ts
```

- [ ] **Step 3: Remove duplicated gutter arithmetic**

Use format geometry/constants through one adapter. Remove literal `8` gutter definitions from renderer/player paths. Keep checked arithmetic and runtime manifest validation intact.

- [ ] **Step 4: Re-run focused tests and typecheck**

```bash
npx vitest run --config vitest.m9.config.ts packages/element/test/renderer.test.ts packages/element/test/canvas2d-renderer.test.ts packages/element/test/player.test.ts
npm run typecheck -w @pixel-point/aval-element
```

### Task 4: Introduce closed provisional candidate outcomes without changing policy

**Files:**
- Create: `packages/element/src/provisional-candidate-outcome.ts`
- Create: `packages/element/src/provisional-startup.ts`
- Create: `packages/element/test/support/provisional-startup-harness.ts`
- Modify: `packages/element/src/decoder.ts` and its protocol/error boundary only as needed to preserve typed local causes
- Modify: `packages/element/src/player.ts`
- Modify: `packages/element/test/player-startup-source-fallback.test.ts`
- Modify: `packages/element/test/player-selection.test.ts`

- [ ] **Step 1: Lock the currently allowed retry matrix**

Extract the repeated candidate/WebCodecs fakes into a reusable harness capped at 400 lines. Add focused tests proving only unsupported config, explicit configure/decode/flush NotSupported/Encoding variants, strict decoded-metadata mismatch, and decoded-output semantic mismatch can become retryable during provisional startup. Assert renderer, materializer, transport, network, integrity, malformed stream/asset, resource, timeout, abort, cleanup, policy, and post-readiness failures are terminal. Prove HEVC success leaves H.264 unopened/unprobed/unfetched/undecoded and no candidate after any winner is touched.

- [ ] **Step 2: Define invalid-state-free unions**

Create a `RetryableCandidateRejection` discriminated union with exhaustive variants: `unsupported-config`, `configure-not-supported`, `decode-not-supported`, `decode-encoding-rejected`, `flush-not-supported`, `flush-encoding-rejected`, `decoded-metadata-incompatible`, and `decoded-output-incompatible`. Add `ProvisionalCandidateOutcome<T> = selected | retryable-rejection`. Do not put renderer/materializer/terminal causes in that union. Decoder and qualifier boundaries return typed local failures; only the startup orchestrator maps the closed eligible set into retryable outcomes.

- [ ] **Step 3: Replace diagnostic-shape policy parsing**

First extract provisional selection/qualification into `provisional-startup.ts`, capped at 500 lines, so `player.ts` has a net line reduction. Make that orchestrator consume the typed outcome directly through an exhaustive mapping table. Diagnostics remain retained evidence, not fallback control flow. Delete the predicates that reconstruct retryability from decoder/renderer diagnostic fields. Preserve the exact public terminal error identity and authored iteration order.

- [ ] **Step 4: Use canonical codec parsing**

Replace `sourceCodecFamily()` and its unknown-to-H.264 default with `parseVideoCodecString()` from `@pixel-point/aval-format`. Reject invalid codec identity through the existing terminal profile path; never silently classify it as H.264.

- [ ] **Step 5: Run selection tests and typecheck**

```bash
npx vitest run --config vitest.m9.config.ts packages/element/test/player-startup-source-fallback.test.ts packages/element/test/player-selection.test.ts packages/element/test/player-prefetch.test.ts
npm run typecheck -w @pixel-point/aval-element
```

### Task 5: Extract one renderer controller and two small backends

**Files:**
- Create: `packages/element/src/renderer-backend.ts`
- Create: `packages/element/src/renderer-controller.ts`
- Create: `packages/element/src/webgl2-renderer-backend.ts`
- Create: `packages/element/src/rgba-materializer.ts`
- Modify: `packages/element/src/canvas2d-renderer.ts`
- Modify: `packages/element/src/renderer.ts`
- Modify: `packages/element/src/renderer-diagnostics.ts`
- Modify: `packages/element/test/renderer.test.ts`
- Modify: `packages/element/test/canvas2d-renderer.test.ts`
- Modify: `packages/element/test/renderer-selection.test.ts`
- Create: `packages/element/test/renderer-controller.test.ts`
- Create: `packages/element/test/rgba-materializer.test.ts`
- Create: `packages/element/test/webgl2-renderer-backend.test.ts`

- [ ] **Step 1: Add backend-contract tests around existing behavior**

Introduce injected backend fakes and assert the public `Renderer` owns one operation queue, opaque stream/resident handles, copy timeout, pending counters, resize scheduling, disposal, and common snapshot. Assert backends receive a validated native `VideoFrame` plus a lazy bounded RGBA reference, never authored asset identity, and cannot select codecs or publish readiness.

- [ ] **Step 2: Make snapshot backend details discriminated**

Change common snapshots to:

```ts
type RendererBackendDetails =
  | { kind: "webgl2"; uploadMode: RendererUploadMode; nativeProbeAttempts: number; probeReadbackBytes: number; nativeProbeInFlight: boolean }
  | { kind: "canvas2d" };
```

Update tests before production so Canvas2D no longer asserts artificial WebGL zero fields.

Split the existing 1,200-line renderer test rather than appending: controller fake-backend behavior, materializer behavior, and WebGL backend behavior get focused files.

- [ ] **Step 3: Run the focused tests and observe the architectural red state**

```bash
npx vitest run --config vitest.m9.config.ts packages/element/test/renderer.test.ts packages/element/test/canvas2d-renderer.test.ts packages/element/test/renderer-selection.test.ts
```

- [ ] **Step 4: Extract backend primitives without changing selection policy**

Define opaque backend target handles, the native-frame-plus-lazy-reference upload source, and an explicit backend event sink. Move WebGL context/program/texture/native-upload/probe/draw primitives to `webgl2-renderer-backend.ts`; its reference probe invokes the lazy RGBA source only when needed. Reduce `canvas2d-renderer.ts` to surfaces, CPU resources, `putImageData`, scaling, mask composition, context acquisition, and draw; it always invokes the same lazy RGBA source. Neither backend owns authored identity, generic queueing, `VideoFrame.copyTo`, timeouts, stream rotation, or common failure lifecycle.

Targets: Canvas2D backend 350–500 lines; WebGL2 backend 650–850 with a hard ceiling below 1,000. A larger file blocks the checkpoint and must be split into shader/program or pure native-probe helpers rather than accepted as a replacement giant module. Backends throw closed internal operation evidence; only the controller creates the public renderer failure.

- [ ] **Step 5: Implement the common controller**

Move shared serialization, frame geometry checks, budgets, opaque target identity, resize/redraw, context-event routing, snapshots, and disposal to `renderer-controller.ts`. Put the bounded `copyTo({format:"RGBA"})` and ordinary-unsupported Canvas2D readback path in `rgba-materializer.ts`, reusable by the later qualifier. A timeout, invalid layout, tainted readback, context error, or inability to obtain CPU pixels is terminal. Keep exact-null WebGL2 selection in `renderer-selection.ts`; all other renderer/materializer failures remain terminal within the current source candidate.

Targets: controller 450–650 lines, materializer 220–320, backend contract 150–220, public `renderer.ts` 100–170, and renderer diagnostics below 300. The original `renderer.ts` plus `canvas2d-renderer.ts` combined line count must decrease, with no duplicate operation queue, timeout, or cleanup state machine.

- [ ] **Step 6: Turn `renderer.ts` into the public composition root**

Construct the selected backend, pass it to `RendererController`, and forward the stable public operations. Keep the existing public `Renderer` name/API.

Implement Steps 2–6 as independently green subcommits: snapshot/test split; shared materializer wired into the existing runtimes; backend contract + WebGL extraction; Canvas extraction; controller replacement; final composition-root deletion of both temporary orchestrators. Never move both giant classes wholesale in one step.

- [ ] **Step 7: Run focused and lifecycle suites**

```bash
npx vitest run --config vitest.m9.config.ts packages/element/test/renderer.test.ts packages/element/test/canvas2d-renderer.test.ts packages/element/test/renderer-selection.test.ts packages/element/test/player-prefetch.test.ts packages/element/test/element-cleanup-regressions.test.ts
npm run typecheck -w @pixel-point/aval-element
```

- [ ] **Step 8: Run thermo-nuclear review checkpoint 1**

Review the diff for duplicated queues/copy logic, giant files, backend leakage, conditional codec policy, and cleanup divergence. Address all P0/P1 findings before continuing.

### Task 6: Add the qualified bounded witness to the format

**Files:**
- Modify: `packages/format/src/model.ts`
- Modify: `packages/format/src/header.ts` and manifest version dispatch files discovered by `rg`
- Modify: `packages/format/src/manifest-rendition-schema.ts`
- Modify: `packages/format/src/writer-normalize.ts`
- Modify: `packages/format/src/index.ts`
- Create: `packages/format/test/packed-alpha-witness.test.ts`
- Modify: `packages/format/test/public-api.test.ts`
- Modify: `packages/format/test/writer.test.ts` or the existing canonical-writer fixture tests selected by `rg`
- Modify: `packages/element/src/asset.ts` and its tests as an unconditional independent exact-key migration target

- [ ] **Step 1: Write malformed/round-trip tests first**

Cover strict legacy `1.0` round trip/inspection, new header+manifest `1.1` round trip, `1.0` rejecting the new key, `1.1` packed-alpha missing witness, valid frozen interval witness, unknown keys/kind, invalid unit/frame, sample counts below 1 or above 8, invalid/reversed/too-wide intervals, duplicate coordinates, out-of-range logical coordinates, witness on opaque layout, and cross-reference failures against unit frame count/readiness/rendition chunks.

- [ ] **Step 2: Run the format tests red**

```bash
npx vitest run --config vitest.m9.config.ts packages/format/test/packed-alpha-witness.test.ts packages/format/test/public-api.test.ts
```

- [ ] **Step 3: Implement strict cloning and public types**

Bump the asset header minor and manifest version to `1.1` with explicit dispatch. Preserve the exact original `1.0` schema for inspection. Add `PackedAlphaWitnessV1`, inclusive interval samples, and width/delta constants. Require `outputQualification` on every `1.1` packed-alpha rendition and forbid it on opaque renditions. Validate logical coordinates, unique samples, interval bounds/width, local presentation frame bounds, bootstrap-unit membership, and selected-rendition chunk presence. Update the element's independent exact-key asset reader unconditionally. New compiler output will use `1.1`; legacy `1.0` packed-alpha playback is rejected later as unsupported-profile.

- [ ] **Step 4: Run format suite, API check, and typecheck**

```bash
npx vitest run --config vitest.m9.config.ts packages/format/test
npm run build -w @pixel-point/aval-format
npm run typecheck -w @pixel-point/aval-format
```

### Task 7: Generate and verify a deterministic compiler witness

**Files:**
- Create: `packages/compiler/src/compile/packed-alpha-witness.ts`
- Create: `packages/compiler/src/compile/verify-packed-alpha-witness.ts`
- Create: `packages/compiler/test/packed-alpha-witness.test.ts`
- Modify: `packages/compiler/src/compile/video-rendition-pipeline.ts`
- Modify: `packages/compiler/src/compile/project-encoding-compiler.ts`
- Modify: `packages/compiler/test/video-rendition-pipeline.test.ts`
- Modify: `packages/compiler/test/project-encoding-compiler.test.ts`

- [ ] **Step 1: Write deterministic selection tests**

Build tiny canonical RGBA16 frames covering transparent, opaque, uniform mid-alpha, single-class, and high-dynamic-range alpha. Assert candidate selection is deterministic by readiness unit/local frame, low local gradient, then row-major coordinate; bounded to 1–8 unique local visible-alpha coordinates; and does not mutate input. Feed simulated canonical `c` and emitted `e` samples, require `abs(c-e) <= 32`, and assert the exact inclusive interval endpoints are `[max(0,min(c,e)-32), min(255,max(c,e)+32)]`, including clipped 0/255 cases. Require two non-overlapping intervals only when the chosen frame has canonical values separated by at least 128. Valid uniform/single-class content must remain compilable.

- [ ] **Step 2: Run the focused compiler tests red**

```bash
npx vitest run --config vitest.m9.config.ts packages/compiler/test/packed-alpha-witness.test.ts packages/compiler/test/video-rendition-pipeline.test.ts packages/compiler/test/project-encoding-compiler.test.ts
```

- [ ] **Step 3: Implement one bounded extraction pass**

Extract source candidates while canonical RGBA frames are already available. Choose a zero-based local presentation frame from `readiness.bootstrapUnits`, preferring low-gradient pixels without requiring particular alpha classes. After encoding, decode that exact emitted unit/rendition through the existing bounded compiler toolchain, sample its packed-alpha pane, and retain candidates whose emitted value differs from canonical by at most 32. Apply the exact min/max-plus-32 interval formula from Step 1; emit 1–8 immutable unique samples, with separated coverage when authored dynamic range permits. If no meaningful candidate survives, fail compilation with an actionable error. Carry the qualified witness through `PreparedEncodingRendition` into a `1.1` manifest and record the bounded verification invocation in compile diagnostics.

- [ ] **Step 4: Run compiler/format tests and typecheck**

```bash
npx vitest run --config vitest.m9.config.ts packages/compiler/test/packed-alpha-witness.test.ts packages/compiler/test/video-rendition-pipeline.test.ts packages/compiler/test/project-encoding-compiler.test.ts
npm run typecheck -w @pixel-point/aval-compiler
```

### Task 8: Qualify decoded packed-alpha output before readiness

**Files:**
- Create: `packages/element/src/decoded-output-qualifier.ts`
- Modify: `packages/element/src/provisional-startup.ts`
- Modify: `packages/element/src/rgba-materializer.ts`
- Modify: `packages/element/src/renderer-controller.ts`
- Modify: `packages/element/src/renderer.ts`
- Modify: `packages/element/src/player.ts`
- Modify: `packages/element/src/player-contract.ts` only if internal constructor input needs the witness
- Modify: `packages/element/test/renderer.test.ts`
- Create: `packages/element/test/decoded-output-qualifier.test.ts`
- Create: `packages/element/test/provisional-startup.test.ts`
- Modify: `packages/element/test/player-startup-source-fallback.test.ts` only to delete migrated scenarios and shrink the giant file
- Modify: `scripts/browser-compatibility/validate-evidence.mjs`

- [ ] **Step 1: Write witness qualification tests**

In `decoded-output-qualifier.test.ts`, use packed frames whose alpha-pane red samples lie below, inside, and above exact inclusive expected intervals. In `provisional-startup.test.ts`, assert startup schedules prerequisite chunks and the exact witness unit/zero-based local presentation frame; the separate qualifier validates the identity of that already-decoded frame, offsets local coordinates through `alphaRect`, and materializes once before readiness. Assert Canvas2D's first upload and WebGL2's RGBA reference probe reuse cached bytes while WebGL2 primary upload remains native. Assert malformed `1.1` witness is terminal invalid-asset and legacy `1.0` packed-alpha playback is terminal unsupported-profile; neither advances codecs. Do not append these cases to the giant fallback test.

- [ ] **Step 2: Write typed fallback tests**

Make AV1 decode a witness mismatch, VP9 succeed, and assert exact authored order, full AV1 resource retirement, and no provisional publication. Repeat AV1+VP9+HEVC mismatch then H.264 success. Exhaust all four and assert one terminal typed error with no AVAL fallback. Assert RGBA materializer and renderer failure remain terminal and do not advance codecs. Assert HEVC success leaves H.264 unopened, unprobed, unfetched, and undecoded.

- [ ] **Step 3: Run focused tests red**

```bash
npx vitest run --config vitest.m9.config.ts packages/element/test/renderer.test.ts packages/element/test/player-startup-source-fallback.test.ts
```

- [ ] **Step 4: Implement the bounded runtime proof**

Have `provisional-startup.ts` explicitly decode prerequisite chunks through the witness unit/local presentation frame before readiness, then pass the identified target frame to the qualifier. Keep the qualifier below 350 lines. Use the shared exact timed RGBA materializer and its bounded ordinary-unsupported Canvas2D readback path. Sample alpha-pane red through canonical rendition geometry and require every value inside its inclusive interval. Return the typed local `decoded-output-incompatible` failure on semantic mismatch only; do not retain media bytes in diagnostics. The original fallback test must end smaller than its pre-task line count.

- [ ] **Step 5: Map the qualifier-local mismatch through the closed outcome union**

Only provisional startup maps `decoded-output-incompatible` to the Task 4 retryable output variant. Missing/malformed witness, materializer failure, renderer failure, cleanup failure, and post-publication mismatch cannot inhabit that union. Keep detailed diagnostics only as evidence.

- [ ] **Step 6: Update evidence validation to read the stable typed outcome**

The validator may assert diagnostics, but it must not duplicate the player's policy predicate. Add witness success/failure fields to diagnostic capture only if they remain bounded and non-media-bearing.

- [ ] **Step 7: Run element selection/lifecycle tests**

```bash
npx vitest run --config vitest.m9.config.ts packages/element/test/renderer.test.ts packages/element/test/player-startup-source-fallback.test.ts packages/element/test/player-selection.test.ts packages/element/test/element-lifecycle-regressions.test.ts packages/element/test/element-cleanup-regressions.test.ts
npm run typecheck -w @pixel-point/aval-element
```

### Task 9: Regenerate and validate all example assets

**Files:**
- Regenerate through scripts owned by `examples/end-user-playground`, `examples/grass-rabbit`, `examples/grass-rabbit-codecs`, and `examples/kinetic-orb`
- Modify: `scripts/browser-compatibility/validate-example-assets.mjs`
- Modify: example tests only where witness certification assertions belong

- [ ] **Step 1: Add certification assertions first**

Require every regenerated packed-alpha rendition to contain a valid emitted-rendition-verified witness. Verify every shipped source array is exactly AV1, VP9, HEVC/H.265, H.264 in that order. Do not sort arbitrary consumer arrays at runtime. Add example-level assertions that HEVC success never touches H.264 and H.264 is reached only after recorded retryable failures for all three predecessors.

- [ ] **Step 2: Rebuild public packages and regenerate**

Use each example's existing compile command. Never hand-edit `.avl` bytes and never overwrite the user's `examples/grass-rabbit/package.json` change.

```bash
npm run build:public-packages
npm run compile:grass-rabbit
npm run compile:grass-rabbit-codecs
npm run compile:kinetic-orb
```

Run the end-user Playground's repository-provided compile command discovered from its package scripts.

- [ ] **Step 3: Validate deterministic assets**

```bash
node scripts/browser-compatibility/validate-example-assets.mjs
npm run fixtures:regeneration-check
```

### Task 10: Complete local verification and final maintainability gate

**Files:**
- Modify only regressions revealed by verification
- Update: `docs/format/1.0.md`
- Create: `docs/format/1.1.md`
- Update: `docs/element/fallback-and-reduced-motion.md`

- [ ] **Step 1: Document witness and consumer-owned fallback**

Document exact `1.0` legacy semantics, the `1.1` header/manifest version and required packed-alpha witness, compiler emitted-rendition verification, interval bounds, local frame identity, legacy inspection/playback distinction, typed exhaustion, and the fact that AVAL never renders a fallback.

- [ ] **Step 2: Run the complete local gate**

```bash
npm run typecheck
npm run build
npm run test:unit
npm run test:playground
npm run test:grass-rabbit
npm run test:grass-rabbit-codecs
npm run test:kinetic-orb
node scripts/browser-compatibility/validate-example-assets.mjs
npm run docs:check
```

- [ ] **Step 3: Run thermo-nuclear review checkpoint 2**

Review the entire implementation diff. Block completion on new giant files, duplicated lifecycle/copy/timeout logic, nested codec/browser conditionals, duplicated geometry, diagnostic parsing as policy, fake backend snapshot fields, or incomplete cleanup. Address all P0/P1 findings and rerun affected tests.

### Task 11: Rebuild an immutable tunnel snapshot and certify BrowserStack

**Files:**
- Create: `artifacts/browser-compatibility/manual-live/<commit>/<timestamp>/REPORT.md`
- Create: platform/demo screenshots and diagnostic JSON beneath that directory

- [ ] **Step 1: Serve one immutable post-build snapshot**

```bash
node scripts/browser-compatibility/serve-built-examples.mjs --host 127.0.0.1 --port 4179
cloudflared tunnel --url http://127.0.0.1:4179 --no-autoupdate
```

Record commit, tunnel URL, build timestamp, BrowserStack device/browser labels, and capability diagnostics. Stop both exact processes after the matrix.

- [ ] **Step 2: Android positive matrix**

Galaxy S24 / Android 14 and Pixel 9 / Android 15: run all four demos plus direct AV1, VP9, HEVC, and H.264 controls. Capture correct-pixel screenshots and JSON proving the Android `smpte170m` normalization was accepted. For Playground, prove corrupt AV1 is rejected before readiness and the next valid modern codec wins; H.264 may win only after AV1, VP9, and HEVC evidence exists. Interact and soak for 60 seconds.

Save per-attempt source/codec/outcome diagnostics beside every winner screenshot so codec order is observed rather than inferred.

- [ ] **Step 3: Firefox matrix**

Windows 11 Firefox 152, 151, 150, and 130: all four demos, correct pixels, interactions, full ladder, and forced-H.264 control. Firefox 129 and 128: all four demos must produce exactly one `unsupported-profile`, no hang, no nonterminal blank canvas, and no AVAL-owned fallback. Save missing-WebCodecs capability JSON.

Only after Firefox 130 passes the AVAL pixel/interaction run, change `docs/browser-support.md` from candidate floor to certified floor and rerun `npm run docs:check`. If it fails, retain the candidate wording and report the product failure.

- [ ] **Step 4: Windows Chrome matrix**

Run current, previous, previous-two, and 24-month sentinel on Windows 11. Prove both WebGL2 and exact-null Canvas2D paths as available in BrowserStack, correct packed alpha, interaction, and soak.

- [ ] **Step 5: Windows Brave matrix**

Attempt branded Brave current, previous, and previous-two builds on Windows 11. Run all four demos where provider inventory permits. If BrowserStack does not expose those branded versions, save inventory/provider evidence and report the slot as unavailable; never infer Brave compatibility from Chrome.

- [ ] **Step 6: iPhone Safari matrix**

Attempt iOS 26.5, 26.4, and 26.3 plus the iOS 18.0 boundary on real iPhones. Save provider provisioning failures as evidence rather than silently dropping a slot. Prove automatic order prefers HEVC/H.265 before H.264 when AV1/VP9 are unavailable, prove H.264 was untouched after HEVC success, then capture direct codec controls, correct alpha, interactions, and per-attempt diagnostics.

- [ ] **Step 7: Validate evidence and write the report**

Report every platform/demo as pass, expected typed negative, provider-unavailable, or fail. Do not infer Brave from Chrome or Firefox Android from desktop. Link the exact screenshots/JSON, note the Firefox 130 feature floor, and list any remaining provider coverage gaps separately from product failures.
