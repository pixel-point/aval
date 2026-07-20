# Browser Compatibility Diagnostics and Error Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace AVAL-owned fallback behavior with one deterministic, consumer-owned playback error boundary and preserve enough bounded decoder evidence to identify the real Safari, Chrome, and Android failure boundaries in the next BrowserStack run.

**Architecture:** The element is the generation-scoped authority for the public `AvalPlaybackError`; the player returns that canonical error from its terminal failure callback and races a terminal deferred against every pending preparation. Worker failures cross an exact, byte-free structured protocol and are retained through decoder, pool, player, and element teardown. A query-gated example harness captures this public and diagnostic state without allocating a second decoder or renderer. Browser-specific compatibility changes are deliberately excluded until the new evidence identifies the failing component.

**Tech Stack:** TypeScript 7, Web Components, WebCodecs workers, Vitest 4, Playwright 1.61, Vite examples, BrowserStack real devices.

---

## Contract decisions used by every task

- Terminal capability, resource, decoder, renderer, context-recovery, and
  preparation-timeout failures end the current source generation in `error`.
  They do not produce `staticReady` and do not reveal alternate content.
- `reduced-motion` and `visibility-suspended` remain nonfatal policy states.
  Their `staticReady` result only describes inactive animated resources; it does
  not imply that AVAL supplied a static visual.
- `AbortError` remains the result for source supersession and caller abort.
- The element creates one `AvalPlaybackError` per terminal generation. Its
  frozen `failure` value is also `event.detail.failure` and
  `getDiagnostics().lastFailure`. Repeated `prepare()` calls reject with the
  retained error without starting another generation or dispatching another
  event.
- A cleanup error cannot replace or duplicate an already-published playback
  failure. It remains in cleanup diagnostics. If cleanup is the only failure,
  the existing cleanup contract applies.
- Decoder evidence is limited to one terminal record per physical lane and is
  cleared only when a newer source generation starts. It never contains URLs,
  encoded bytes, decoder configuration, stack traces, or frame objects.

## Task 1: Add the public playback error contract

**Files:**

- Create: `packages/element/test/playback-error.test.ts`
- Modify: `packages/element/src/errors.ts`
- Modify: `packages/element/src/public-types.ts`
- Modify: `packages/element/src/index.ts`
- Modify: `packages/element/test/public-api.compile.ts`
- Modify: `packages/element/test/public-api.test.ts`

- [ ] Add red tests for a stable exported error and frozen failure identity.

  ```ts
  const failure = Object.freeze({
    code: "worker-decode-failure" as const,
    message: "Playback could not continue.",
    operation: "prepare"
  });
  const error = new AvalPlaybackError(failure, 7);

  expect(error.name).toBe("AvalPlaybackError");
  expect(error.failure).toBe(failure);
  expect(error.generation).toBe(7);
  expect(Object.isFrozen(error.failure)).toBe(true);
  ```

- [ ] Run the focused tests and confirm the import/export assertions fail.

  Run: `npx vitest run --config vitest.m9.config.ts packages/element/test/playback-error.test.ts packages/element/test/public-api.test.ts`

  Expected: FAIL because `AvalPlaybackError` does not exist.

- [ ] Implement `AvalPlaybackError` in `errors.ts` with readonly `failure` and
  `generation`, a stable `name`, a bounded stable message, and a constructor
  that freezes a defensive `AvalPublicFailure` copy when the input is not
  already frozen. Do not expose `cause`, browser text, or a stack-derived code
  as the stable contract.

- [ ] Export the class from `index.ts`. Keep `AvalPublicFailure` as the small
  stable value consumed by events and diagnostics.

- [ ] Add compile-only assertions that `failure`, `generation`, `code`, and
  `operation` are readonly and that callers narrow a rejected value with
  `instanceof AvalPlaybackError` before branching on `error.failure.code`.

- [ ] Run focused unit tests and element typechecking.

  Run: `npx vitest run --config vitest.m9.config.ts packages/element/test/playback-error.test.ts packages/element/test/public-api.test.ts`

  Run: `npm run typecheck -w @pixel-point/aval-element`

  Expected: PASS.

- [ ] Commit.

  ```bash
  git add packages/element/src/errors.ts packages/element/src/public-types.ts packages/element/src/index.ts packages/element/test/playback-error.test.ts packages/element/test/public-api.compile.ts packages/element/test/public-api.test.ts
  git commit -m "feat(element): add playback error contract"
  ```

## Task 2: Remove AVAL-owned fallback presentation and API surface

**Files:**

- Create: `packages/element/test/shadow-layers.test.ts`
- Modify: `packages/element/src/shadow-layers.ts`
- Modify: `packages/element/src/shadow-style.ts`
- Modify: `packages/element/src/public-types.ts`
- Modify: `packages/element/src/aval-element.ts`
- Modify: `packages/element/test/element-lifecycle-regressions.test.ts`
- Modify: `packages/element/test/diagnostics.test.ts`
- Modify: `packages/element/test/public-api.compile.ts`

- [ ] Add red shadow-layer tests proving the private shadow root contains the
  owned canvas but no `<slot name="fallback">`, and that policy suspension and
  terminal retirement manipulate only the canvas/runtime, never light DOM.

- [ ] Add red public API assertions that `AvalFallbackDetail`, the `fallback`
  event, fallback counters, and fallback trace kind are absent. Keep
  `StaticReason` only for `reduced-motion` and `visibility-suspended`; remove
  no-rendition, queued-decoder, codec/worker/renderer/resource/readiness/
  timeout/animation/fallback reasons from successful static readiness.

- [ ] Run the focused tests and confirm they fail against the legacy slot and
  fallback event.

  Run: `npx vitest run --config vitest.m9.config.ts packages/element/test/shadow-layers.test.ts packages/element/test/element-lifecycle-regressions.test.ts packages/element/test/diagnostics.test.ts`

  Expected: FAIL because the slot and fallback API still exist.

- [ ] Reduce `ShadowLayerOwner` to canvas ownership. Remove
  `showBestFallback()`, `coverFallback()`, `showFallbackAfterFatal()`, fallback
  visibility state, slot creation, and the related shadow CSS. Preserve canvas
  reset/disposal and style ownership.

- [ ] Remove fallback event dispatch, counters, and trace records from
  `aval-element.ts`. For `staticReady`, record policy readiness/mode only and do
  not reveal or hide consumer DOM. Do not implement a replacement placeholder.

- [ ] Update all in-package fixtures for the narrower `StaticReason`, event map,
  diagnostics counters, and trace union. Do not update archived specifications
  or historical implementation plans.

- [ ] Run focused tests and element typechecking.

  Run: `npx vitest run --config vitest.m9.config.ts packages/element/test/shadow-layers.test.ts packages/element/test/element-lifecycle-regressions.test.ts packages/element/test/diagnostics.test.ts`

  Run: `npm run typecheck -w @pixel-point/aval-element`

  Expected: PASS.

- [ ] Commit.

  ```bash
  git add packages/element/src packages/element/test
  git commit -m "refactor(element): remove managed fallback presentation"
  ```

## Task 3: Make player failure terminal while preserving policy suspension

**Files:**

- Modify: `packages/element/src/player-contract.ts`
- Modify: `packages/element/src/player.ts`
- Modify: `packages/element/test/player-prefetch.test.ts`
- Modify: `packages/element/test/player-selection.test.ts`
- Modify: `packages/element/test/element-cleanup-regressions.test.ts`

- [ ] Add a distinct internal terminal callback that returns the canonical
  error. Keep any genuinely nonfatal operational callback separate:

  ```ts
  readonly onPlaybackFailure: (
    code: RuntimeFailureCode,
    operation: string
  ) => AvalPlaybackError;
  ```

  Operational cleanup reporting stays separate. Reduced motion, visibility,
  decoder admission waiting, and supersession must not call this callback.

- [ ] Add red tests for foreground and candidate decoder failures. Assert that
  pending `prepare()`/state work rejects with the returned canonical error,
  resources retire to zero, the callback runs exactly once with `fatal: true`,
  and no static readiness result or fallback event is manufactured.

- [ ] Retain the existing reduced-motion and visibility tests, strengthened to
  assert successful `staticReady` policy results and zero fatal callbacks.

- [ ] Run the focused tests and confirm terminal failures still recover static.

  Run: `npx vitest run --config vitest.m9.config.ts packages/element/test/player-prefetch.test.ts packages/element/test/player-selection.test.ts packages/element/test/element-cleanup-regressions.test.ts`

  Expected: FAIL because `#fail()` currently calls static recovery.

- [ ] Add one terminal deferred/promise per player and race it with preparation
  and pending operations. On the first playback failure: mark terminal, cancel
  scheduling/prefetch, settle or reject owned state work, retire decoder/frame/
  renderer/resource ownership, call `onPlaybackFailure`, and reject with its
  exact returned error. First terminal cause wins.

- [ ] Remove the `animation-failure` static recovery path,
  `PlaybackFallbackError`, and `graph.failStatic(...)` from terminal playback.
  Change `#prepareBounded()` so resource/readiness/decoder/renderer failures and
  preparation timeout reach the terminal path. Do not weaken integrity, frame,
  timing, color, geometry, or resource validation.

- [ ] Preserve `#recoverStatic()` only for reduced-motion and visibility policy.
  Treat context-loss recovery exhaustion and resize resource rejection as
  terminal renderer/resource failures. Keep cleanup failures diagnostic when a
  playback error already won.

- [ ] Run focused tests, player tests, and typechecking.

  Run: `npx vitest run --config vitest.m9.config.ts packages/element/test/player-prefetch.test.ts packages/element/test/player-selection.test.ts packages/element/test/element-cleanup-regressions.test.ts`

  Run: `npx vitest run --config vitest.m9.config.ts packages/element/test/player*.test.ts`

  Run: `npm run typecheck -w @pixel-point/aval-element`

  Expected: PASS.

- [ ] Commit.

  ```bash
  git add packages/element/src/player-contract.ts packages/element/src/player.ts packages/element/test/player-prefetch.test.ts packages/element/test/player-selection.test.ts packages/element/test/element-cleanup-regressions.test.ts
  git commit -m "fix(element): terminate failed playback generations"
  ```

## Task 4: Publish one generation-scoped error from the element

**Files:**

- Modify: `packages/element/src/aval-element.ts`
- Modify: `packages/element/test/element-lifecycle-regressions.test.ts`
- Modify: `packages/element/test/diagnostics.test.ts`
- Modify: `packages/element/test/element-cleanup-regressions.test.ts`

- [ ] Add a deferred mocked-player regression asserting all of the following:

  ```ts
  expect(caught).toBeInstanceOf(AvalPlaybackError);
  expect(errorEvents).toHaveLength(1);
  expect(errorEvents[0].detail.fatal).toBe(true);
  expect(errorEvents[0].detail.failure).toBe(caught.failure);
  expect(element.getDiagnostics().lastFailure).toBe(caught.failure);
  expect(element.getDiagnostics().readiness).toBe("error");
  ```

  A repeated `prepare()` must reject with `caught` itself, keep one event, and
  not create a player. Replacing `src`/sources must clear the retained error and
  allow the next generation.

- [ ] Run the lifecycle regression and confirm duplicate publication and/or
  static resolution fails the new assertions.

  Run: `npx vitest run --config vitest.m9.config.ts packages/element/test/element-lifecycle-regressions.test.ts packages/element/test/element-cleanup-regressions.test.ts packages/element/test/diagnostics.test.ts`

  Expected: FAIL.

- [ ] Add generation-scoped `#terminalError`. The fatal publication method must
  freeze one public failure, create one `AvalPlaybackError`, retain it, set
  readiness `error`, dispatch one fatal error event, and return that same error
  to the player callback.

- [ ] Retain the rejected generation load. `#trackLoad()` must not clear it after
  a terminal rejection, because that would let repeated `prepare()` silently
  start a new generation. Clear it only for AbortError/supersession or explicit
  source mutation.

- [ ] In `#startGeneration()` catches, recognize the retained
  `AvalPlaybackError`, finish cleanup, and rethrow it without publishing a
  second generic readiness failure. Unsupported environment and preparation
  timeout must use the same fatal boundary. Source supersession remains
  `AbortError`.

- [ ] Ensure the fatal event is dispatched only after animated ownership is
  retired, or after a bounded cleanup attempt whose failure is reflected in
  cleanup diagnostics. Never reveal alternate content.

- [ ] Run focused tests, all lifecycle tests, and typechecking.

  Run: `npx vitest run --config vitest.m9.config.ts packages/element/test/*lifecycle*.test.ts packages/element/test/*cleanup*.test.ts packages/element/test/diagnostics.test.ts`

  Run: `npm run typecheck -w @pixel-point/aval-element`

  Expected: PASS.

- [ ] Commit.

  ```bash
  git add packages/element/src/aval-element.ts packages/element/test/element-lifecycle-regressions.test.ts packages/element/test/element-cleanup-regressions.test.ts packages/element/test/diagnostics.test.ts
  git commit -m "fix(element): publish one terminal error per source"
  ```

## Task 5: Preserve structured worker failure evidence

**Files:**

- Create: `packages/element/src/decoder-diagnostics.ts`
- Modify: `packages/element/src/decoder-protocol.ts`
- Modify: `packages/element/src/decoder-worker.ts`
- Modify: `packages/element/test/decoder-worker.test.ts`

- [ ] Define a closed worker diagnostic model:

  ```ts
  export type DecoderDiagnosticPhase =
    | "probe"
    | "configure"
    | "decode"
    | "flush"
    | "output-validation"
    | "frame-transfer";

  export interface DecoderFailureDiagnostic {
    readonly phase: DecoderDiagnosticPhase;
    readonly code: "unsupported-config" | "decoder-operation" |
      "invalid-output" | "transport" | "watchdog-timeout";
    readonly run: number | null;
    readonly decodeOrdinal: number | null;
    readonly exception: Readonly<{ name: string; message: string }> | null;
    readonly firstFrame: Readonly<DecoderFrameMetadata> | null;
  }
  ```

  Frame metadata contains timestamp, nullable duration, coded/display sizes,
  nullable visible rect, and an explicit nullable color-space tuple.

- [ ] Add red tests for exact validation and sanitization: reject the old bare
  `{t:"error"}`, extra keys, unsafe numbers, over-limit strings, stacks, byte
  arrays, config objects, and frames. Normalize control characters, redact
  URL-like substrings, cap name at 64 characters and message at 512, and deeply
  freeze accepted records.

- [ ] Add red worker tests for `isConfigSupported()` rejection (`probe`),
  configuration failure, decoder callback after a first frame (`decode`), flush
  rejection, and failed frame transfer (`frame-transfer`). Transfer failure must
  close the frame and send its structured error through a non-transfer post.

- [ ] Run the worker tests and confirm the empty error protocol fails.

  Run: `npx vitest run --config vitest.m9.config.ts packages/element/test/decoder-worker.test.ts`

  Expected: FAIL.

- [ ] Implement pure sanitization, capture, exact validation, and deep-freeze
  helpers in `decoder-diagnostics.ts`. The helpers must not read/copy encoded
  data, URLs, stack/cause, decoder configs, or complete frame objects.

- [ ] Change the protocol terminal event to
  `{ t: "error", diagnostic: DecoderFailureDiagnostic }`. In the worker, replace
  parameterless `fail()` with first-failure-wins `fail(phase, code, reason, run,
  decodeOrdinal)`, thread every catch/rejection/callback cause into it, and retain
  only first-frame metadata plus the current ordinal.

- [ ] Run worker tests and typechecking.

  Run: `npx vitest run --config vitest.m9.config.ts packages/element/test/decoder-worker.test.ts`

  Run: `npm run typecheck -w @pixel-point/aval-element`

  Expected: PASS.

- [ ] Commit.

  ```bash
  git add packages/element/src/decoder-diagnostics.ts packages/element/src/decoder-protocol.ts packages/element/src/decoder-worker.ts packages/element/test/decoder-worker.test.ts
  git commit -m "feat(element): preserve decoder worker failures"
  ```

## Task 6: Retain decoder evidence through every ownership boundary

**Files:**

- Modify: `packages/element/src/decoder.ts`
- Modify: `packages/element/src/decoder-pool.ts`
- Modify: `packages/element/src/player-contract.ts`
- Modify: `packages/element/src/player.ts`
- Modify: `packages/element/src/public-types.ts`
- Modify: `packages/element/src/aval-element.ts`
- Modify: `packages/element/src/index.ts`
- Modify: `packages/element/test/decoder.test.ts`
- Modify: `packages/element/test/decoder-pool.test.ts`
- Modify: `packages/element/test/player-selection.test.ts`
- Modify: `packages/element/test/element-lifecycle-regressions.test.ts`
- Modify: `packages/element/test/diagnostics.test.ts`
- Modify: `packages/element/test/public-api.compile.ts`

- [ ] Add red decoder tests asserting a structured worker error rejects
  `failure()` and remains in `decoder.snapshot().diagnostic`. Local contradictory
  color/geometry/timing validation failures must synthesize
  `output-validation` evidence with readable first-frame metadata. Add
  first-failure-wins, redaction, truncation, watchdog, and `messageerror` cases.

- [ ] Add red pool tests proving each record is tagged with its physical lane,
  one lane cannot overwrite the other, and the maximum retained length is two
  after either side wins the failure race.

- [ ] Add red player and element tests proving the evidence retains rendition,
  codec, unit/generation where known, phase, code, ordinal, exception, and frame
  metadata after pool/player retirement. It must be deeply frozen, available
  without `{trace:true}`, and cleared only by a newer source generation.

- [ ] Run the focused tests and confirm diagnostics disappear on retirement.

  Run: `npx vitest run --config vitest.m9.config.ts packages/element/test/decoder.test.ts packages/element/test/decoder-pool.test.ts packages/element/test/player-selection.test.ts packages/element/test/element-lifecycle-regressions.test.ts packages/element/test/diagnostics.test.ts`

  Expected: FAIL.

- [ ] Extend decoder snapshots with one retained diagnostic. Structured worker
  events are revalidated and frozen on receipt. Local validation and watchdog
  errors synthesize the same shape before failing.

- [ ] Extend `DecoderPoolSnapshot` with at most two lane-tagged records. Extend
  `PlayerSnapshot` with live-or-retained records enriched by the player's
  rendition/codec/unit context; copy them immediately before every pool disposal
  or reference clear.

- [ ] Add and export readonly `AvalDecoderDiagnostic`. Expose
  `runtime.decoderDiagnostics` in `AvalDiagnostics` even when empty. In the
  element, copy player evidence before retirement, add the current source
  generation, and clear only where a new generation already clears
  `lastFailure`.

- [ ] Update all hand-built `PlayerSnapshot` and empty-runtime fixtures with an
  empty readonly diagnostics array.

- [ ] Run focused tests, all decoder tests, public API compile checks, and
  element typechecking.

  Run: `npx vitest run --config vitest.m9.config.ts packages/element/test/decoder*.test.ts packages/element/test/player-selection.test.ts packages/element/test/element-lifecycle-regressions.test.ts packages/element/test/diagnostics.test.ts`

  Run: `npm run typecheck -w @pixel-point/aval-element`

  Expected: PASS.

- [ ] Commit.

  ```bash
  git add packages/element/src packages/element/test
  git commit -m "feat(element): retain bounded decoder diagnostics"
  ```

## Task 7: Add a query-gated BrowserStack capture harness

**Files:**

- Create: `examples/support/aval-browser-diagnostics.js`
- Create: `tests/support/browser-diagnostic-capture.ts`
- Modify: `examples/end-user-playground/main.js`
- Modify: `examples/grass-rabbit/main.js`
- Modify: `examples/kinetic-orb/main.js`
- Modify: `examples/grass-rabbit-codecs/main.js`
- Modify: `examples/grass-rabbit-codecs/codec-demo-controller.js`
- Modify: `tests/end-user-playground/end-user-playground.spec.ts`
- Modify: `tests/grass-rabbit/grass-rabbit.spec.ts`
- Modify: `tests/kinetic-orb/kinetic-orb.spec.ts`
- Modify: `tests/grass-rabbit-codecs/grass-rabbit-codecs.spec.ts`

- [ ] Add red browser tests that open each example with
  `?avalDiagnostics=1`, validate the report schema, and capture explicit
  before-action, after-action, error, and timeout checkpoints. A stuck capture
  times out after 10 seconds and still returns the latest bounded report.

- [ ] Implement `window.avalBrowserDiagnostics` only when the query flag is
  present, with `attach(player, context)`, `checkpoint(label, player?)`,
  `report()`, and `clear()`. Capture synchronous snapshots in
  `readinesschange`, transition, underflow, and fatal error handlers. Do not
  listen for or recreate a fallback event.

- [ ] Bound checkpoints to 32, runtime trace records to 64, and element trace
  records to 32. Capture environment once: UA/UAData, secure context, viewport,
  DPR, reduced motion, visibility, WebCodecs/VideoFrame/OffscreenCanvas/WebGL2/
  WebGPU presence, and authored source MIME/codec. Do not allocate a decoder,
  GPU device, or renderer for probing.

- [ ] Add a collapsed query-only overlay with Capture, Copy JSON, and Clear. It
  is a test affordance, not runtime fallback UI, and must be absent without the
  query flag.

- [ ] Attach before `prepare()` and before codec-demo controller operations so
  early failures are retained. The test helper validates and exports JSON plus
  a screenshot; UI appearance alone never determines pass/fail.

- [ ] Run all four example suites.

  Run: `npm run test:playground`

  Run: `npm run test:grass-rabbit`

  Run: `npm run test:grass-rabbit-codecs`

  Run: `npm run test:kinetic-orb`

  Expected: PASS with no diagnostics UI in normal URLs and a valid bounded
  report for diagnostic URLs.

- [ ] Commit.

  ```bash
  git add examples tests
  git commit -m "test(examples): capture bounded browser diagnostics"
  ```

## Task 8: Migrate current documentation and examples to consumer-owned fallback

**Files:**

- Modify: `README.md`
- Modify: `packages/element/README.md`
- Modify: current files under `docs/element/`
- Modify: `docs/element-api.md`
- Modify: current fallback-using examples and fixtures under `examples/`
- Modify: `scripts/docs/check-docs.mjs`
- Modify: `scripts/docs/test-examples.mjs`
- Modify: release/API fixtures reported by `docs:check`, `test:examples`, and
  `api:check`

- [ ] Use `rg -n 'slot=.*fallback|fallback event|static fallback|AvalFallback'`
  to enumerate current documentation/examples. Exclude
  `docs/superpowers/specs/` and `docs/superpowers/plans/` because they are
  historical records.

- [ ] Change examples from a slotted child to consumer-owned sibling UI. The
  consumer catches `AvalPlaybackError` and/or listens for the fatal `error`
  event, then decides whether to reveal its own content. Explain that
  reduced-motion and visibility suspension are policy readiness, not playback
  failures.

- [ ] Add docs checks that reject new `slot="fallback"`, `fallback` event, or
  claims that AVAL generates/reveals a poster. Document H.264 as the required
  compatibility rendition and optional codecs as qualified optimizations.

- [ ] Update the public API report/classification for the intentional breaking
  removal and new exports. Keep archived milestone artifacts unchanged.

- [ ] Run documentation, example, consumer, API, and generated checks.

  Run: `npm run docs:check`

  Run: `npm run test:examples`

  Run: `npm run test:consumers`

  Run: `npm run api:check`

  Run: `npm run check:generated`

  Expected: PASS.

- [ ] Commit.

  ```bash
  git add README.md packages/element/README.md docs/element docs/element-api.md examples scripts/docs etc/api/element.api.md
  git commit -m "docs(element): make fallback consumer owned"
  ```

## Task 9: Verify Phase 1 and rerun the real-browser matrix

**Files:**

- Create: `artifacts/browser-compatibility/2026-07-18/README.md`
- Create: one bounded JSON report and screenshot per tested configuration under
  `artifacts/browser-compatibility/2026-07-18/`
- Modify: `docs/superpowers/plans/2026-07-18-browser-compatibility-diagnostics-error-boundary.md`

- [ ] Run repository verification.

  Run: `npm run build:public-packages`

  Run: `npm run test:unit`

  Run: `npm run typecheck`

  Run: `npm run test:playground && npm run test:grass-rabbit && npm run test:grass-rabbit-codecs && npm run test:kinetic-orb`

  Run: `npm run docs:check && npm run test:examples && npm run test:consumers && npm run api:check`

  Run: `git diff --check`

  Expected: PASS. If an unrelated pre-existing failure appears, record the exact
  command/output separately; do not weaken the new contract to hide it.

- [ ] Start the examples and a Cloudflare quick tunnel with explicit local
  process ownership. Record the public URL and process IDs in the evidence
  README; do not commit ephemeral tunnel credentials.

- [ ] In the signed-in BrowserStack session, capture the diagnostic URL and
  screenshot for:

  - Windows 11 Chrome current, current-1, current-2, and the build closest to
    24 months old;
  - current and previous-generation Mobile Safari plus the iOS 17 boundary;
  - Android 14, 15, and 16 real devices, including one Samsung/comparable
    device where available.

- [ ] For each configuration, exercise end-user playground, grass-rabbit,
  grass-rabbit codecs, and kinetic-orb. Record H.264 preparation, packed alpha,
  interaction settlement, terminal error, decoder diagnostic, and visible
  result independently. Do not classify a blank canvas or spinner from UI alone.

- [ ] Compare each new failure to the pre-instrumentation audit. Identify the
  earliest failing component boundary and create a follow-on plan per proven
  root cause:

  - source qualification/failover;
  - foreground versus candidate decoder-lane isolation;
  - renderer semantic upload qualification;
  - bounded context-loss recreation; or
  - H.264 compiler/profile correction.

  Do not implement any of these hypotheses without the corresponding captured
  diagnostic evidence and a focused red regression.

- [ ] Mark every completed checkbox in this plan and commit evidence separately.

  ```bash
  git add artifacts/browser-compatibility/2026-07-18 docs/superpowers/plans/2026-07-18-browser-compatibility-diagnostics-error-boundary.md
  git commit -m "test: record browser compatibility failure evidence"
  ```

## Completion criteria

- AVAL owns no fallback slot, fallback event, fallback counter, or alternate
  presentation decision.
- Terminal playback settles once as `AvalPlaybackError`; repeated prepare calls,
  event detail, and diagnostics share one generation-scoped failure value.
- Reduced motion and visibility remain nonfatal and are not mislabeled as
  playback compatibility errors.
- Worker failures retain exact bounded phase/code/exception/frame evidence
  through element teardown, with at most two decoder-lane records.
- All diagnostic capture is opt-in, bounded, byte-free, and non-probing.
- The real-browser rerun yields enough evidence to replace each compatibility
  hypothesis with a component-specific failing test and follow-on fix plan.
