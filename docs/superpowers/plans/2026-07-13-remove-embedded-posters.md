# Remove Embedded Posters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove poster/static-image authoring, payloads, metadata, decoding, rendering, and accounting so an AVAL asset contains motion samples plus metadata only, while an optional `<img slot="fallback">` remains entirely host-owned outside the asset.

**Architecture:** Change unreleased wire format `0.1` in place. States identify only their motion body/optional intro; the byte layout ends after access-unit payloads; fallback modes retain state identity but no longer name or load an embedded image. Supported Chrome draws the initial decoded AVC frame before exposing the animated canvas. Reduced-motion or unsupported paths leave the element's external fallback slot visible instead of synthesizing a poster from the AVAL asset.

**Tech Stack:** TypeScript 7, Node.js 22, raw Annex-B AVC, WebCodecs, WebGL2, Vitest, Playwright, API Extractor, Markdown documentation checks.

---

## Decisions and invariants

- Remove, rather than deprecate, `poster`, `staticFrame`, `staticFrames`, `staticPayloads`, `staticBlobs`, static-PNG validation facts, and the manifest `fallback` declaration.
- Keep graph/runtime fallback *state* semantics only where they model a non-animated terminal/recovery mode; they must not imply an embedded surface or image.
- The element's fallback slot is application HTML and never contributes bytes to an AVAL asset.
- Animated activation must draw a decoded frame before the animated plane becomes visible; no yellow/blank internal canvas may be used as a readiness substitute.
- Compilation continues to preserve authored dimensions and frame ranges exactly. No downscale or poster extraction is allowed.
- Historical milestone evidence and superseded implementation plans remain historical records; current product docs and examples must describe the new contract.

## File responsibility map

### Wire and graph contract

- `packages/format/src/model.ts`: poster-free public wire/input/parsed-layout types.
- `packages/format/src/manifest-schema.ts`, `manifest-graph-schema.ts`, `manifest-relations.ts`, `manifest-rendition-schema.ts`: strict poster-free manifest validation.
- `packages/format/src/layout.ts`, `writer-normalize.ts`, `writer.ts`, `parser.ts`: sample-only canonical layout, writer, and complete-asset validation; standalone PNG utilities remain available only for source-authoring workflows and are not reachable from an AVAL asset.
- `packages/format/src/constants.ts`, `index.ts`, `graph-adapter.ts`: remove poster budgets/exports and adapt poster-free states.
- `packages/graph/src/model.ts`, `validate.ts`, `engine.ts`, `engine-state.ts`: remove static-frame identity while retaining state-only fallback presentation.

### Compiler and inspection

- `packages/compiler/src/model.ts`, `source-project-schema-common.ts`, `source-graph-preflight.ts`: reject/remove project poster selectors and poster report fields.
- `packages/compiler/src/compile/project-compiler.ts`, `direct-compiler.ts`, `project-continuity.ts`, `frame-plan.ts`, `alpha-policy.ts`, `rgba-spool.ts`, `resource-estimate.ts`: stop selecting, retaining, encoding, validating, and budgeting poster pixels.
- `packages/compiler/src/commands/init.ts`, `asset.ts`, `asset-validation.ts`, `unpack-asset.ts`, `cli.ts`, `cli-output.ts`: remove poster JSON, static extraction, static claims, and CLI/report output.
- Keep `packages/compiler/src/compile/png.ts` only for PNG-sequence source handling/tests; it must no longer be part of AVAL output.

### Browser runtime and element

- `packages/player-web/src/runtime/asset-catalog-index.ts`, `asset-catalog.ts`, `blob-range-plan.ts`, `runtime-asset-batch.ts`, `runtime-asset-session.ts`, `verified-blob-store.ts`: remove static blob selection/residency/profile loading.
- `packages/player-web/src/runtime/model.ts`, `integrated-player-contracts.ts`, `integrated-player.ts`, `integrated-player-static-preparation.ts`, `integrated-player-recovery.ts`, `integrated-animated-preparation.ts`: make fallback state-only and remove the static surface-store dependency.
- `packages/player-web/src/runtime/browser-presentation-planes.ts`, `browser-presentation-planes-support.ts`, `browser-presentation-options.ts`, `browser-canvas-backing-resources.ts`, `player-canvas-backing-host.ts`: use one animated canvas and reveal it only after a decoded draw.
- Delete poster-only runtime modules and their dedicated tests: `browser-static-canvas-plane*`, `static-surfaces*`, `static-surface-cache*`, `static-surface-store-resources.ts`, `static-resource-plan.ts`, `strict-static-decoder.ts`, `leased-static-png-decoder.ts`, and `runtime-static-profile*`.
- Public element runtime: remove the internal static canvas while retaining the external fallback slot.

### Examples, docs, fixtures, and API reports

- `examples/grass-rabbit/motion.json`, generated `.avl`/build report, and `tests/grass-rabbit/grass-rabbit.spec.ts`: poster-free project and Chrome size/visual/interaction regression.
- `examples/end-user-playground/*`: external fallback wording only; no claim that it is embedded.
- `README.md`, `packages/{compiler,format,player-web}/README.md`, `docs/format/0.1.md`, `docs/compiler.md`, `docs/compiler/authoring-video-and-states.md`, `docs/compiler/user-defined-states.md`, `docs/browser-support.md`, `docs/element/attributes-and-api.md`, `docs/performance-and-budgets.md`, and `docs/security.md`: current poster-free contract.
- Format/compiler/player test fixtures, conformance snapshots, package compile tests, and `etc/api/*.api.md`: regenerate from the new public model.

### Task 1: Remove posters from the wire and graph

- [x] Add/adjust tests proving manifests reject all former poster/static keys, the canonical file ends after the final access unit, and parsed layouts expose no static ranges.
- [x] Remove poster types, budgets, schema branches, relations, offsets, payload loops, and every AVAL-facing PNG/static export.
- [x] Remove `staticFrameId` from graph states and static presentations; update engine fixtures to assert state-only fallback.
- [x] Run focused format/graph tests and TypeScript checks.

### Task 2: Remove poster work from the compiler

- [x] Add schema tests proving `states[].poster` is an unknown field in every project version.
- [x] Delete poster frame collection/deduplication/PNG encoding and static report accounting from project/direct compilation.
- [x] Simplify continuity and alpha audits to referenced motion frames only; remove static asset inspection/unpack output.
- [x] Run focused compiler schema, direct, project integration, command, and tool-backed tests.

### Task 3: Remove static-image loading and presentation from the runtime

- [x] Add catalog/session tests proving only unit blobs are planned, fetched, verified, and reported.
- [x] Remove PNG/static resource categories, stores, leases, canvas backing, and public APIs.
- [x] Keep fallback graph results state-only; make external-fallback ownership explicit at the element boundary.
- [x] Add/adjust activation tests proving the animated canvas is revealed only after `drawInitial` succeeds.
- [x] Run player-web and element unit/type tests.

### Task 4: Rebuild examples, fixtures, docs, and API reports

- [x] Remove poster selectors from example project JSON and starter output.
- [x] Rebuild the end-user `favorite.avl` from 34,073 bytes to a 14,938-byte
  sample-only asset while keeping its PNG exclusively in the host fallback slot.
- [x] Rebuild the rabbit `.avl`; assert it contains 281 access units, no static metadata/payload, exact 1280x720 canvas, and is near encoded-payload size rather than the former 15.6 MB.
- [x] Update current docs to distinguish optional host fallback markup from AVAL contents.
- [x] Regenerate deterministic fixtures and API reports; remove obsolete poster-only fixtures/tests.

### Task 5: Verify the complete Chrome flow

- [x] Run public package builds, API extraction, docs checks, fixture verification, unit tests, and `git diff --check`.
- [x] Run the grass-rabbit headed Chromium regression at DPR 2. Verify a non-placeholder decoded frame is visible at 640 CSS pixels, hover enters/loops/exits through the authored ranges, and there are no console/page errors.
- [x] Inspect the rebuilt file/report byte totals and confirm zero embedded poster bytes.

## Verification commands

```sh
npm run build:public-packages
npm run api:report
npm run docs:check
npm run fixtures:verify
npm run test:unit
npm run compile:grass-rabbit
npm run test:grass-rabbit
git diff --check
```

## Self-review

- Spec coverage: format bytes, author schema, compiler work, runtime loading/rendering, reduced-motion/unsupported ownership, examples, documentation, generated artifacts, and Chrome behavior are covered.
- Placeholder audit: no compatibility shim, empty embedded image, synthetic one-pixel poster, or optional legacy field is allowed.
- Type consistency: public format, graph, compiler report, player catalog/session, and element factory types remove the same concepts in dependency order.
- Verification: the full unit command completed with 2,153/2,153 passing tests.
  Local FFmpeg 7.1.1/x264 r3108 safely rejects the two packed-alpha cases that
  exceed the preserved 2/255 quality gate; the tests assert that rejection. M6
  retains the reviewed FFmpeg 8.1.2 samples in a poster-free, deduplicated
  17,207-byte pack and reassembles every checked container tool-free.
