# Recompile Stale AVAL Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore every checked-in `.avl` demo and fixture after decoder capacity changed from one 12-surface ring to two 12-surface rings, and repair the stale engagement retry uncovered by the full demo verification.

**Architecture:** Rebuild each generated bundle from its canonical `motion.json` with the current compiler, mirror the canonical conformance bundle into the source-less end-user example, refresh generated integrity metadata, and exercise both rabbit demos in real browsers. In the element input reconciler, retain a rejected engagement level only when an authored transition is actually active; stable no-route snapshots must not become latent retries.

**Tech Stack:** Node.js 22, TypeScript, AVAL compiler CLI, FFmpeg/FFprobe, Vitest, Playwright, Vite

---

### Task 1: Preserve the failing regression evidence

**Files:**
- Test: `tests/grass-rabbit/grass-rabbit.spec.ts`
- Test: `tests/grass-rabbit-codecs/rabbit-interaction.spec.ts`
- Inspect: `packages/element/src/readiness.ts`
- Inspect: `packages/element/src/decoder-capacity.ts`
- Inspect: `packages/compiler/src/compile/resource-estimate.ts`

- [x] **Step 1: Run the grass-rabbit browser regression**

Run:

```sh
npm run test:grass-rabbit
```

Expected before regeneration: the artifact contract passes, while five runtime tests fail because readiness becomes `error` instead of `interactiveReady`.

- [x] **Step 2: Compare every checked-in declaration with the current readiness calculation**

Run a read-only Node inspection using `parseFrontIndex()` and `createReadinessPlan()` over `rg --files -g '*.avl'`.

Expected before regeneration: 16 assets have `manifest.limits.runtimeWorkingSetBytes` below `plan.declaredWorkingSetBytes`; only `examples/kinetic-orb/public/kinetic-orb/h264.avl` satisfies the current calculation, and even that asset predates the latest compiler change.

### Task 2: Build the current compiler and regenerate every bundle

**Files:**
- Modify: `fixtures/conformance/v1/{av1,vp9,h265,h264}.avl`
- Modify: `fixtures/conformance/v1/build.json`
- Modify: `fixtures/conformance/v1/provenance.json`
- Modify: `fixtures/conformance/v1/README.md`
- Modify: `examples/end-user-playground/public/favorite/{av1,vp9,h265,h264}.avl`
- Modify: `examples/end-user-playground/public/favorite/build.json`
- Modify: `examples/end-user-playground/index.html`
- Modify: `examples/grass-rabbit/public/grass-rabbit/{av1,vp9,h265,h264}.avl`
- Modify: `examples/grass-rabbit/public/grass-rabbit/build.json`
- Modify: `examples/grass-rabbit/index.html`
- Modify: `examples/grass-rabbit-codecs/public/grass-rabbit/{av1,vp9,h265,h264}.avl`
- Modify: `examples/grass-rabbit-codecs/public/grass-rabbit/build.json`
- Modify: `examples/kinetic-orb/public/kinetic-orb/h264.avl`
- Modify: `examples/kinetic-orb/public/kinetic-orb/build.json`
- Modify: `examples/kinetic-orb/index.html`

- [x] **Step 1: Build all public packages once**

```sh
npm run build:public-packages
```

Expected: graph, format, player-web, element, and compiler builds succeed.

- [x] **Step 2: Rebuild the three authored example bundles**

```sh
npm run compile -w @pixel-point/aval-grass-rabbit-example
npm run compile -w @pixel-point/aval-grass-rabbit-codecs-example
npm run compile -w @pixel-point/aval-kinetic-orb-example
```

Expected: nine tracked codec assets and three `build.json` reports are regenerated.

- [x] **Step 3: Rebuild the canonical conformance bundle without replacing support files**

```sh
AVAL_FIXTURE_TMP="$(mktemp -d /tmp/aval-v1-rebuild.XXXXXX)"
node packages/compiler/dist/cli.js compile fixtures/compiler/v1/source/motion.json --out "$AVAL_FIXTURE_TMP/bundle"
cp "$AVAL_FIXTURE_TMP/bundle/av1.avl" fixtures/conformance/v1/av1.avl
cp "$AVAL_FIXTURE_TMP/bundle/vp9.avl" fixtures/conformance/v1/vp9.avl
cp "$AVAL_FIXTURE_TMP/bundle/h265.avl" fixtures/conformance/v1/h265.avl
cp "$AVAL_FIXTURE_TMP/bundle/h264.avl" fixtures/conformance/v1/h264.avl
cp "$AVAL_FIXTURE_TMP/bundle/build.json" fixtures/conformance/v1/build.json
node fixtures/conformance/v1/update-provenance.mjs
```

Expected: four codec assets, `build.json`, and `provenance.json` describe the current compiler output while `README.md` and `update-provenance.mjs` remain present.

- [x] **Step 4: Mirror the canonical conformance output into the end-user example**

Copy `av1.avl`, `vp9.avl`, `h265.avl`, `h264.avl`, and `build.json` from the same temporary bundle to `examples/end-user-playground/public/favorite/`.

Expected: all five pairs have identical SHA-256 digests.

- [x] **Step 5: Correct the mixed-directory fixture rebuild recipe**

Update `fixtures/conformance/v1/README.md` to compile into a temporary output directory and copy only the five generated files into `fixtures/conformance/v1/`, then run the provenance updater and verifier.

Expected: following the documented recipe cannot remove support files from the mixed-content fixture directory.

- [x] **Step 6: Refresh hard-coded source integrity metadata**

Replace each affected `<source>` element in `examples/grass-rabbit/index.html`, `examples/kinetic-orb/index.html`, and `examples/end-user-playground/index.html` with the matching path, MIME type, and integrity from its regenerated `build.json`.

Expected: every hard-coded source matches its generated report exactly.

### Task 3: Verify generated contracts and both rabbit demos

**Files:**
- Test: `tests/grass-rabbit/grass-rabbit.spec.ts`
- Test: `tests/grass-rabbit-codecs/artifacts.test.ts`
- Test: `tests/grass-rabbit-codecs/rabbit-interaction.spec.ts`
- Test: `tests/fixtures/all-provenance.test.ts`

- [x] **Step 1: Prove every checked-in declaration is sufficient**

Run the same `parseFrontIndex()` and `createReadinessPlan()` inspection from Task 1.

Expected: all 17 assets report `manifest.limits.runtimeWorkingSetBytes >= plan.declaredWorkingSetBytes`.

- [x] **Step 2: Verify generated fixtures and artifact metadata**

```sh
npm run fixtures:verify
npx vitest run --config vitest.m9.config.ts tests/grass-rabbit-codecs/artifacts.test.ts tests/fixtures/all-provenance.test.ts
```

Expected: all tests pass.

- [x] **Step 3: Refresh ignored production mirrors**

```sh
npm run build -w @pixel-point/aval-grass-rabbit-example
npm run build -w @pixel-point/aval-grass-rabbit-codecs-example
npm run build -w @pixel-point/aval-kinetic-orb-example
npm run build -w @pixel-point/aval-end-user-playground
```

Expected: all 13 ignored `dist/` asset copies match their public sources.

- [x] **Step 4: Verify the standard grass-rabbit demo**

```sh
npm run test:grass-rabbit
```

Expected: all six tests pass, including intro, hover-in, hover-out, and decoder-generation coverage.

- [x] **Step 5: Verify the multi-codec rabbit demo**

```sh
npm run test:grass-rabbit-codecs
```

Expected: Chromium and WebKit suites pass for supported codecs, with no browser/runtime failures.

- [x] **Step 6: Review the generated diff**

```sh
git status --short
git diff --stat
git diff -- fixtures/conformance/v1/provenance.json
```

Expected: changes are limited to this plan, regenerated assets, reports, provenance, source-integrity markup, the stale diagnostic assertion, and the independently reproduced engagement-retry repair.

### Task 4: Repair the stable engagement retry regression

**Files:**
- Modify: `packages/element/src/element-engagement-binding.ts`
- Modify: `packages/element/src/aval-element.ts`
- Test: `packages/element/test/element-engagement-binding.test.ts`
- Test: `tests/end-user-playground/playground.spec.ts`

- [x] **Step 1: Capture the failing browser trace**

Expected before the repair: the manual transition reaches `engaged`, publishes `transitionend`, then replays the rejected startup `engagement.off` snapshot and returns to `idle`.

- [x] **Step 2: Add a focused rejected-snapshot regression**

Expected before the repair: a forced stable `engagement.off` rejection is replayed by `retry()` even though no transition was active when it was rejected.

- [x] **Step 3: Retain only transition-busy rejections**

Inject the element's current transition state into `ElementEngagementBinding` and use it to classify rejected levels. Preserve the existing retry behavior for rejections observed during a real transition.

- [x] **Step 4: Verify the public playground contract**

```sh
npm run build -w @pixel-point/aval-element
npm run test:playground
```

Expected: the explicit toggle remains in `engaged`, and the Chromium end-user test passes.
