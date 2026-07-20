# Browser Output Qualification Implementation Plan

> **For agentic workers:** Implement one checked task at a time, keep the suite green between tasks, and run the named thermo-nuclear review at both architecture checkpoints. Do not stage or modify the user's existing `examples/grass-rabbit/package.json` change.

**Goal:** Make supported Android and desktop Firefox browsers render AVAL examples correctly while preserving the exact authored codec order `AV1 -> VP9 -> HEVC/H.265 -> H.264`, rejecting corrupt provisional output before readiness, and leaving fallback UI entirely to the consumer.

**Architecture:** Extract semantic color comparison into a pure typed authority, consolidate renderer lifecycle into one controller with small WebGL2 and Canvas2D backends, and add a bounded compiler-authored packed-alpha witness that the controller validates before publishing readiness. Replace diagnostic-shape parsing with a typed startup-candidate rejection disposition. Keep exact-null WebGL2-to-Canvas2D selection inside one codec candidate and keep all post-readiness failures terminal.

**Tech stack:** TypeScript, WebCodecs, WebGL2, Canvas2D, Vitest, Playwright, Vite, Cloudflare quick tunnels, BrowserStack Live real devices.

---

## Safety and invariants

- Never change authored source order or prefer H.264 because of a browser name.
- Never add UA, OS, device, or codec-name branches to color/output validation.
- Never advance to another codec for renderer-backend failure.
- Never publish `visualReady` or `interactiveReady` before semantic output qualification succeeds.
- Never add static/image/video fallback rendering to AVAL; terminal exhaustion raises the existing typed error once.
- Preserve legacy asset readability while making regenerated packed-alpha examples certifiable.
- Preserve the user's uncommitted `examples/grass-rabbit/package.json` edit.
- Commit each completed task independently after focused tests pass.

## File map

- Create `packages/element/src/decoder-color.ts`: pure color-space classifier and named normalization reasons.
- Create `packages/element/test/decoder-color.test.ts`: table-driven exact/normalization/incompatibility contract.
- Modify `packages/element/src/decoder.ts` and `packages/element/test/decoder.test.ts`: consume the classifier and retain raw mismatch diagnostics.
- Create `packages/element/src/startup-candidate-rejection.ts`: stable internal retry/terminal disposition.
- Modify `packages/element/src/player.ts` and `packages/element/test/player-startup-source-fallback.test.ts`: consume typed rejection, preserve source order, remove diagnostic-shape control flow.
- Create `packages/element/src/renderer-controller.ts`: common queue, frame materialization, budgets, qualification, lifecycle, and snapshots.
- Create `packages/element/src/renderer-backend.ts`: narrow backend interfaces and discriminated backend details.
- Create `packages/element/src/webgl2-renderer-backend.ts`: WebGL2-only resource/upload/draw operations.
- Refactor `packages/element/src/canvas2d-renderer.ts`: Canvas2D-only resource/upload/draw operations.
- Modify `packages/element/src/renderer.ts`, `packages/element/src/renderer-diagnostics.ts`, `packages/element/src/renderer-geometry.ts`, and their focused tests.
- Modify `packages/format/src/model.ts`, `packages/format/src/manifest-rendition-schema.ts`, `packages/format/src/writer-normalize.ts`, `packages/format/src/index.ts`, and format tests: optional versioned witness model and strict bounded validation.
- Create `packages/compiler/src/compile/packed-alpha-witness.ts` and its test: deterministic witness extraction from canonical RGBA.
- Modify `packages/compiler/src/compile/video-rendition-pipeline.ts`, `packages/compiler/src/compile/project-encoding-compiler.ts`, and tests: carry the witness into generated manifests.
- Modify `packages/element/src/asset.ts` only if its private rendition shape does not already preserve the new format field.
- Modify `docs/browser-support.md`, `docs/format/1.0.md`, and `docs/element/fallback-and-reduced-motion.md`.
- Regenerate example `.avl` assets through their existing compile scripts; do not hand-edit binary assets.
- Add fresh BrowserStack evidence under `artifacts/browser-compatibility/manual-live/<commit>/<timestamp>/`.

### Task 1: Lock and implement semantic decoder color classification

**Files:**
- Create: `packages/element/src/decoder-color.ts`
- Create: `packages/element/test/decoder-color.test.ts`
- Modify: `packages/element/src/decoder.ts`
- Modify: `packages/element/test/decoder.test.ts`

- [ ] **Step 1: Write the failing pure classifier table**

Define test inputs as the four-member tuple `[primaries, transfer, matrix, fullRange]`. Assert:

```ts
expect(classifyDecoderColor(BT709_LIMITED, BT709_LIMITED)).toEqual({ kind: "exact" });
expect(classifyDecoderColor(BT709_LIMITED, ["bt709", "smpte170m", "bt709", false]))
  .toEqual({ kind: "known-normalization", normalization: "bt709-transfer-as-smpte170m" });
```

Retain the current narrow sRGB rule as `limited-bt709-srgb-transfer`. Table every conflicting primary, matrix, range, and transfer as `incompatible` with the exact failing field. Include null members and prove they do not silently satisfy a concrete expectation.

- [ ] **Step 2: Run the new focused test and observe red**

```bash
npx vitest run --config vitest.m9.config.ts packages/element/test/decoder-color.test.ts
```

Expected: module/export missing.

- [ ] **Step 3: Implement the pure typed classifier**

Export immutable tuple/type definitions and:

```ts
export function classifyDecoderColor(
  expected: Readonly<DecoderColorTuple>,
  actual: Readonly<DecoderColorTuple>
): Readonly<DecoderColorClassification>
```

Check exact equality first, then the two named equivalences, then return the first incompatible field in stable order. Do not inspect browser, OS, device, source, or codec.

- [ ] **Step 4: Replace `matchesColor()` in `decoder.ts`**

Build the exact tuple once from expected and `VideoFrame.colorSpace`, call the classifier, and accept `exact` or `known-normalization`. Preserve raw expected/actual tuples in `DecoderOutputFailure` for true mismatches. Delete the old boolean helper.

- [ ] **Step 5: Add decoder integration regressions**

Use the existing fake `VideoFrame` harness to prove the captured Android tuple succeeds under the real strict player expectation. Add a true range/matrix mismatch and assert diagnostics retain both raw arrays and remain frozen.

- [ ] **Step 6: Run focused tests and typecheck**

```bash
npx vitest run --config vitest.m9.config.ts packages/element/test/decoder-color.test.ts packages/element/test/decoder.test.ts
npm run typecheck -w @pixel-point/aval-element
```

Expected: all pass.

### Task 2: Make the Firefox feature floor explicit and deterministic

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

State Firefox desktop 130+ explicitly, including that Firefox 129 is a one-release feature-floor exception to a literal 24-month promise because it predates desktop WebCodecs. State Firefox Android separately uncertified until measured.

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

### Task 4: Extract one renderer controller and two small backends

**Files:**
- Create: `packages/element/src/renderer-backend.ts`
- Create: `packages/element/src/renderer-controller.ts`
- Create: `packages/element/src/webgl2-renderer-backend.ts`
- Modify: `packages/element/src/canvas2d-renderer.ts`
- Modify: `packages/element/src/renderer.ts`
- Modify: `packages/element/src/renderer-diagnostics.ts`
- Modify: `packages/element/test/renderer.test.ts`
- Modify: `packages/element/test/canvas2d-renderer.test.ts`
- Modify: `packages/element/test/renderer-selection.test.ts`

- [ ] **Step 1: Add backend-contract tests around existing behavior**

Introduce injected backend fakes and assert the public `Renderer` owns one operation queue, stream/resident identity, copy timeout, pending counters, resize scheduling, disposal, and common snapshot. Assert backends receive already-validated/materialized inputs and cannot select codecs or publish readiness.

- [ ] **Step 2: Make snapshot backend details discriminated**

Change common snapshots to:

```ts
type RendererBackendDetails =
  | { kind: "webgl2"; uploadMode: RendererUploadMode; nativeProbeAttempts: number; probeReadbackBytes: number; nativeProbeInFlight: boolean }
  | { kind: "canvas2d" };
```

Update tests before production so Canvas2D no longer asserts artificial WebGL zero fields.

- [ ] **Step 3: Run the focused tests and observe the architectural red state**

```bash
npx vitest run --config vitest.m9.config.ts packages/element/test/renderer.test.ts packages/element/test/canvas2d-renderer.test.ts packages/element/test/renderer-selection.test.ts
```

- [ ] **Step 4: Extract backend primitives without changing selection policy**

Move WebGL context/program/texture/native-upload/probe/draw primitives to `webgl2-renderer-backend.ts`. Reduce `canvas2d-renderer.ts` to surfaces, CPU frame resources, `putImageData`, scaling, mask composition, context acquisition, and draw. Neither backend owns generic queueing, `VideoFrame.copyTo`, timeouts, stream rotation, or common failure lifecycle.

- [ ] **Step 5: Implement the common controller**

Move shared serialization, frame geometry checks, RGBA materialization, copy timeouts, budgets, resident identity, resize/redraw, context-change routing, snapshots, and disposal to `renderer-controller.ts`. Keep exact-null WebGL2 selection in `renderer-selection.ts`; all other renderer failures remain terminal within the current source candidate.

- [ ] **Step 6: Turn `renderer.ts` into the public composition root**

Construct the selected backend, pass it to `RendererController`, and forward the stable public operations. Keep the existing public `Renderer` name/API.

- [ ] **Step 7: Run focused and lifecycle suites**

```bash
npx vitest run --config vitest.m9.config.ts packages/element/test/renderer.test.ts packages/element/test/canvas2d-renderer.test.ts packages/element/test/renderer-selection.test.ts packages/element/test/player-prefetch.test.ts packages/element/test/element-cleanup-regressions.test.ts
npm run typecheck -w @pixel-point/aval-element
```

- [ ] **Step 8: Run thermo-nuclear review checkpoint 1**

Review the diff for duplicated queues/copy logic, giant files, backend leakage, conditional codec policy, and cleanup divergence. Address all P0/P1 findings before continuing.

### Task 5: Add the optional bounded witness to the format

**Files:**
- Modify: `packages/format/src/model.ts`
- Modify: `packages/format/src/manifest-rendition-schema.ts`
- Modify: `packages/format/src/writer-normalize.ts`
- Modify: `packages/format/src/index.ts`
- Create: `packages/format/test/packed-alpha-witness.test.ts`
- Modify: `packages/format/test/public-api.test.ts`
- Modify: `packages/format/test/writer.test.ts` or the existing canonical-writer fixture tests selected by `rg`

- [ ] **Step 1: Write malformed/round-trip tests first**

Cover missing witness (legacy valid), valid frozen round trip, unknown keys/kind, invalid unit/frame, sample counts below 2 or above 8, missing transparent/opaque class, duplicate coordinates, out-of-range logical coordinates, and witness on opaque layout.

- [ ] **Step 2: Run the format tests red**

```bash
npx vitest run --config vitest.m9.config.ts packages/format/test/packed-alpha-witness.test.ts packages/format/test/public-api.test.ts
```

- [ ] **Step 3: Implement strict cloning and public types**

Add `PackedAlphaWitnessV1`, sample, kind, and thresholds/constants. Add optional `outputQualification` only to packed-alpha `ProductionRendition`. Validate against logical color-pane dimensions and exact bounded keys. Preserve legacy files without the field.

- [ ] **Step 4: Run format suite, API check, and typecheck**

```bash
npx vitest run --config vitest.m9.config.ts packages/format/test
npm run build -w @pixel-point/aval-format
npm run typecheck -w @pixel-point/aval-format
```

### Task 6: Generate a deterministic compiler witness from canonical alpha

**Files:**
- Create: `packages/compiler/src/compile/packed-alpha-witness.ts`
- Create: `packages/compiler/test/packed-alpha-witness.test.ts`
- Modify: `packages/compiler/src/compile/video-rendition-pipeline.ts`
- Modify: `packages/compiler/src/compile/project-encoding-compiler.ts`
- Modify: `packages/compiler/test/video-rendition-pipeline.test.ts`
- Modify: `packages/compiler/test/project-encoding-compiler.test.ts`

- [ ] **Step 1: Write deterministic selection tests**

Build tiny canonical RGBA16 frames containing stable 3x3 transparent and opaque neighborhoods. Assert exactly 2–8 row-major deterministic samples, at least one of each class, logical coordinates, canonical thresholds `<= 8` / `>= 247`, and no mutation. Assert uncertain/ringing-only frames produce no witness.

- [ ] **Step 2: Run the focused compiler tests red**

```bash
npx vitest run --config vitest.m9.config.ts packages/compiler/test/packed-alpha-witness.test.ts packages/compiler/test/video-rendition-pipeline.test.ts packages/compiler/test/project-encoding-compiler.test.ts
```

- [ ] **Step 3: Implement one bounded extraction pass**

Extract candidates while canonical RGBA frames are already available; do not reread media or invoke ffmpeg again. Choose only initial-readiness unit/frame content, require robust neighborhoods, store at most eight immutable samples, and carry the optional witness through `PreparedEncodingRendition` into the manifest.

- [ ] **Step 4: Run compiler/format tests and typecheck**

```bash
npx vitest run --config vitest.m9.config.ts packages/compiler/test/packed-alpha-witness.test.ts packages/compiler/test/video-rendition-pipeline.test.ts packages/compiler/test/project-encoding-compiler.test.ts
npm run typecheck -w @pixel-point/aval-compiler
```

### Task 7: Qualify decoded packed-alpha output and type candidate rejection

**Files:**
- Create: `packages/element/src/startup-candidate-rejection.ts`
- Modify: `packages/element/src/renderer-controller.ts`
- Modify: `packages/element/src/renderer.ts`
- Modify: `packages/element/src/player.ts`
- Modify: `packages/element/src/player-contract.ts` only if internal constructor input needs the witness
- Modify: `packages/element/test/renderer.test.ts`
- Modify: `packages/element/test/player-startup-source-fallback.test.ts`
- Modify: `scripts/browser-compatibility/validate-evidence.mjs`

- [ ] **Step 1: Write witness qualification tests**

Use a packed frame whose alpha-pane red samples match, mismatch, and sit on the runtime thresholds (`<=32`, `>=223`). Assert materialization happens once before readiness and the same bytes feed first upload for both backends. Assert legacy/no-witness behavior remains readable but is not counted as certified evidence.

- [ ] **Step 2: Write typed fallback tests**

Make AV1 decode a witness mismatch, VP9 succeed, and assert exact authored order and no provisional publication. Repeat AV1+VP9+HEVC mismatch then H.264 success. Exhaust all four and assert one terminal typed error with no AVAL fallback. Assert renderer failure remains terminal and does not advance codecs.

- [ ] **Step 3: Run focused tests red**

```bash
npx vitest run --config vitest.m9.config.ts packages/element/test/renderer.test.ts packages/element/test/player-startup-source-fallback.test.ts
```

- [ ] **Step 4: Implement the bounded runtime proof**

On the witness frame, use the controller's existing exact timed RGBA materialization. Sample alpha-pane red via canonical rendition geometry. Reject before readiness on any mismatch; do not retain media bytes in diagnostics.

- [ ] **Step 5: Introduce and consume `StartupCandidateRejection`**

Use `disposition: "retry-next-candidate" | "terminal"`, stable stage, and stable cause. Have decoder/output/renderer ownership boundaries create it. Make `createPlayer()` consume disposition directly. Delete `retryableStartupEvidence()`, `retryableRendererStartupDiagnostic()`, and other diagnostic-shape parsing used as control flow. Keep detailed diagnostics only as evidence.

- [ ] **Step 6: Update evidence validation to read the stable typed outcome**

The validator may assert diagnostics, but it must not duplicate the player's policy predicate. Add witness success/failure fields to diagnostic capture only if they remain bounded and non-media-bearing.

- [ ] **Step 7: Run element selection/lifecycle tests**

```bash
npx vitest run --config vitest.m9.config.ts packages/element/test/renderer.test.ts packages/element/test/player-startup-source-fallback.test.ts packages/element/test/player-selection.test.ts packages/element/test/element-lifecycle-regressions.test.ts packages/element/test/element-cleanup-regressions.test.ts
npm run typecheck -w @pixel-point/aval-element
```

### Task 8: Regenerate and validate all example assets

**Files:**
- Regenerate through scripts owned by `examples/end-user-playground`, `examples/grass-rabbit`, `examples/grass-rabbit-codecs`, and `examples/kinetic-orb`
- Modify: `scripts/browser-compatibility/validate-example-assets.mjs`
- Modify: example tests only where witness certification assertions belong

- [ ] **Step 1: Add certification assertions first**

Require every regenerated packed-alpha rendition to contain a valid witness. Verify source arrays retain exact codec order and H.264 stays last.

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

### Task 9: Complete local verification and final maintainability gate

**Files:**
- Modify only regressions revealed by verification
- Update: `docs/format/1.0.md`
- Update: `docs/element/fallback-and-reduced-motion.md`

- [ ] **Step 1: Document witness and consumer-owned fallback**

Document the optional wire field, compiler emission, runtime thresholds, legacy-readability/certification distinction, typed exhaustion, and the fact that AVAL never renders a fallback.

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

### Task 10: Rebuild an immutable tunnel snapshot and certify BrowserStack

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

- [ ] **Step 3: Firefox matrix**

Windows 11 Firefox 152, 151, 150, and 130: all four demos, correct pixels, interactions, full ladder, and forced-H.264 control. Firefox 129 and 128: all four demos must produce exactly one `unsupported-profile`, no hang, no nonterminal blank canvas, and no AVAL-owned fallback. Save missing-WebCodecs capability JSON.

- [ ] **Step 4: Windows Chrome matrix**

Run current, previous, previous-two, and 24-month sentinel on Windows 11. Prove both WebGL2 and exact-null Canvas2D paths as available in BrowserStack, correct packed alpha, interaction, and soak.

- [ ] **Step 5: iPhone Safari matrix**

Run current provider versions and the iOS 18 boundary on real iPhones. Prove automatic order prefers HEVC/H.265 before H.264 when AV1/VP9 are unavailable, then capture direct codec controls and correct alpha/interactions.

- [ ] **Step 6: Validate evidence and write the report**

Report every platform/demo as pass, expected typed negative, provider-unavailable, or fail. Do not infer Brave from Chrome or Firefox Android from desktop. Link the exact screenshots/JSON, note the Firefox 130 feature floor, and list any remaining provider coverage gaps separately from product failures.
