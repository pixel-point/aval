# Cross-Browser Playback Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every permanent AVAL demo render and complete all authored interactions on the certified rolling 24-month browser/OS matrix, using AV1 → VP9 → HEVC → H.264 only for proven startup codec/output incompatibility and publishing one deterministic consumer-owned error outside the supported matrix.

**Architecture:** Preserve the existing startup-only source ladder and generation-scoped public failure boundary. First make decoder and renderer failures field-exact and retain them through teardown, then correct the two proven standards/lifecycle defects, qualify native `VideoFrame` upload against the existing RGBA copy path, and use targeted signed-in BrowserStack probes to select the remaining renderer and Safari lifecycle fixes from explicit evidence. BrowserStack JSON, screenshots, interaction ledgers, and monotonic soak counters become release artifacts; readiness without correct pixels and state transitions remains a failure.

**Tech Stack:** TypeScript 7, Web Components, WebCodecs workers, WebGL2, Canvas 2D only if the captured Windows renderer phase requires it, Vitest 4, Playwright 1.61, Vite, Cloudflare quick tunnels, BrowserStack Live real devices/desktops, official branded Brave binaries on clean macOS and ephemeral Windows runners.

---

## Fixed decisions and evidence baseline

- The permanent targets are `examples/end-user-playground`,
  `examples/grass-rabbit`, `examples/grass-rabbit-codecs`, and
  `examples/kinetic-orb`.
- The retained baseline is
  `artifacts/browser-compatibility/2026-07-19/report.md` and its 43 signed-in
  BrowserStack screenshots. It is a failing baseline, not release evidence.
- Android's passing decoder control is the 48×104 packed-alpha AV1 playground
  rendition. The failing decoder cases are opaque 512×512, 640×360, and
  1280×720 outputs across multiple codecs. This rules out a generic
  packed-alpha, codec, bit-depth, or crop-only explanation.
- WebCodecs permits output `displayWidth`/`displayHeight` values that differ
  numerically from `displayAspectWidth`/`displayAspectHeight` when the ratios
  are equal. Timestamp and duration still remain exact authored timing
  requirements. Visible storage, bounds, color, allocation, and integrity
  checks remain strict.
- Windows BrowserStack Chrome 148–150 fails before a renderer becomes
  publishable. Local macOS Chromium 149 passes, so this is not treated as a
  generic Chrome-major regression.
- Mozilla enabled desktop WebCodecs in Firefox 130. Firefox 128 and 129 cannot
  run AVAL's required decoder path without adding a different media backend.
  The certified Firefox primitive floor is therefore 130 (released within the
  target window); 128/129 remain explicit deterministic-error sentinels and
  are never reported as playback-compatible. This is a documented one-month
  feature-floor exception to the rolling target, not an inferred pass.
- A non-context renderer task rejection is currently raced and often
  mislabeled as `context-loss`. Only a real `webglcontextlost` event may use
  that public code.
- Kinetic Orb on iOS 26.5 reaches `interactiveReady`, then fails after roughly
  20 decoder run recreations. The identical 24-frame idle GOP and identical
  SPS/PPS repeat about once per second; the evidence points to decoder
  lifecycle/metadata rather than a deterministic bad access unit.
- The mandatory H.264 encoder currently hard-codes High profile, and the
  `veryslow` preset raises the 1280×720 rendition to 16 references and Level
  5.0. New compatibility renditions use constrained baseline, one reference,
  no B-pictures/CABAC/8×8 transform/weighted prediction, and the minimum
  bounded level; legacy High assets remain readable.
- Re-engagement during the finite `exiting` body is a separate proven authored
  graph bug in all three hover demos. The current graph has no
  `exiting → entering` event edge, so a pointer/focus re-entry can be lost.
- AVAL never supplies an image, poster, static animation, or alternate video.
  Failed/out-of-policy playback rejects and raises the stable error so the
  application can choose its own fallback.

## File map

- Modify `packages/element/src/decoder-diagnostics.ts`: expected/rejected
  output evidence and mismatch categories.
- Modify `packages/element/src/decoder.ts`: field-specific validation and
  overflow-safe display-aspect comparison.
- Modify `packages/element/src/decoder-worker.ts`: strict support-result config
  echo validation and decoder lifecycle counters.
- Modify `packages/element/src/decoder-protocol.ts`: exact protocol shapes for
  new bounded evidence.
- Modify `packages/element/src/decoder-pool.ts`: logical run, role, and lane
  context in retained diagnostics.
- Create `packages/element/src/media-geometry.ts`: the single overflow-safe
  aspect-ratio authority shared by decoder and renderer.
- Create `packages/element/src/renderer-diagnostics.ts`: immutable
  renderer failure evidence.
- Modify `packages/element/src/renderer.ts`: typed failure retention, correct
  context classification, GL error capture, aspect validation, and semantic
  native-upload qualification.
- Modify `packages/element/src/player-contract.ts`,
  `packages/element/src/player.ts`, `packages/element/src/aval-element.ts`, and
  `packages/element/src/public-types.ts`: propagate bounded decoder/renderer
  evidence and monotonic soak counters through teardown.
- Modify `examples/support/aval-browser-diagnostics.js` and
  `tests/support/browser-diagnostic-capture.ts`: expose compact evidence and
  write JSON sidecars.
- Modify the three hover motion graphs and their generated `.avl` fixtures:
  add the authored re-engagement route.
- Modify the four example Playwright suites and Kinetic harness/config: exact
  pixel, transition, touch, focus, and 60-second lifecycle witnesses.
- Create `scripts/browser-compatibility/kinetic-decoder-isolator.html` and
  `scripts/browser-compatibility/kinetic-decoder-isolator.js`: render-free iOS
  decoder lifecycle A/B probe.
- Create `scripts/browser-compatibility/renderer-isolator.html` and
  `scripts/browser-compatibility/renderer-isolator.js`: controlled WebGL
  context-attribute/capability/allocation probe.
- Create `scripts/browser-compatibility/serve-built-examples.mjs`: one
  loopback server with stable routes for the four built demos and isolators.
- Create `scripts/browser-compatibility/validate-evidence.mjs`: reject missing,
  duplicate, stale, or logically incomplete release artifacts.
- Create `scripts/browser-compatibility/validate-example-assets.mjs`: inspect
  every generated example asset and bind it to its checked-in build report and
  page/controller source contract.
- Modify the H.264 format inspector, compiler policy, and browser adapters:
  emit constrained-baseline `avc1.42E0xx` compatibility renditions while
  retaining read compatibility for legacy High-profile `avc1.6400xx` assets.
- Update `docs/browser-support.md`,
  `docs/evidence/2026-07-18-browser-compatibility.md`, and the dated final
  compatibility report only after the exact matrix passes.

## Task 0: Freeze the branded matrix and make Brave runnable

**Files:**

- Create: `scripts/browser-compatibility/certification-policy.json`
- Create: `scripts/browser-compatibility/certification-policy.schema.json`
- Create: `scripts/browser-compatibility/brave/resolve-builds.mjs`
- Create: `scripts/browser-compatibility/brave/acquire-builds.mjs`
- Create: `scripts/browser-compatibility/brave/run-matrix.mjs`
- Create: `scripts/browser-compatibility/test/brave-tooling.test.ts`
- Create: `.github/workflows/brave-windows-compatibility.yml`

- [ ] **Step 1: Check in the exact release inventory**

  Populate the closed policy file with every required slot, exact OS/device and
  branded browser version, `playback` or `unsupported-sentinel` expectation,
  four-demo list, direct-H.264 mode, ladder mode, interaction modes, and
  60-second soak requirement. Pin Windows Chrome 150/149/148/127,
  Firefox 152/151/150/130, and Firefox 128/129 negative sentinels. Resolve the
  exact BrowserStack labels for both macOS generations, iOS 26.5/26.4/26.0 and
  the provider's iOS 18.0 launch selector, and Android 17/16/15 devices before
  capture. The signed-in iPhone 16 session launched by that selector reports
  exact iOS/Safari 18.6. The inventory did not expose the originally requested
  iOS 26.3 or 18.1 labels; 26.0 and the observed 18.6 session are never
  relabeled as the unavailable versions. The same inventory exposed only
  desktop Safari 26.4 on Tahoe and 18.4 on Sequoia; unavailable 26.3, 26.2,
  18.3, and 18.2 desktop versions are omitted rather than fabricated. A moving
  `latest` alias is invalid.
  The run manifest may add session data but cannot add, remove, or weaken a
  checked-in policy slot. The three real-device sessions report and pin
  Chrome/Chromium 145.0.0.0 for Android 17, 16, and 15.

- [ ] **Step 2: Add offline red tests for official Brave acquisition**

  Fixture the official `versions.brave.com` response and official
  `brave/brave-browser` GitHub release metadata. Require deterministic
  resolution of the current stable and the stable release nearest
  2024-07-19, exact platform/architecture assets, HTTPS official-host URLs,
  bounded redirects, full SHA-256, and rejection of an unsigned, wrong-host,
  wrong-version, or mismatched binary. The resolver writes exact Brave and
  embedded Chromium versions into the policy; Chrome results can never satisfy
  those slots.

- [ ] **Step 3: Implement the single macOS Brave path**

  `acquire-builds.mjs` downloads both official macOS builds into a caller-owned
  temporary directory, verifies each digest, mounts/extracts without installing
  globally, runs `codesign --verify --deep --strict` and
  `codesign -dv --verbose=4`, and records the Developer ID identity. It invokes
  the exact app executable with `--version`. `run-matrix.mjs` launches each
  binary with a separate `mktemp` clean user-data directory and no extensions,
  runs all four demos in forced-H.264 and full-ladder modes, exercises pointer,
  focus, overlap/re-entry, and every state in both directions, observes 60
  seconds post-ready, and writes platform-named PNG/JSON/ledger artifacts.

  ```bash
  node scripts/browser-compatibility/brave/resolve-builds.mjs \
    --boundary-date 2024-07-19 \
    --policy scripts/browser-compatibility/certification-policy.json
  AVAL_BRAVE_TMP="$(mktemp -d /tmp/aval-brave-macos.XXXXXX)"
  node scripts/browser-compatibility/brave/acquire-builds.mjs \
    --policy scripts/browser-compatibility/certification-policy.json \
    --platform macos-arm64 --output "$AVAL_BRAVE_TMP"
  node scripts/browser-compatibility/brave/run-matrix.mjs \
    --policy scripts/browser-compatibility/certification-policy.json \
    --platform macos --install-root "$AVAL_BRAVE_TMP" \
    --base-url "$TUNNEL_URL" --run-root "$RUN_ROOT" \
    --source-commit "$COMMIT" --session-id "$SESSION" \
    --tunnel-created-at "$TUNNEL_CREATED_AT"
  ```

- [ ] **Step 4: Implement the single Windows Brave path**

  The checked-in workflow uses the supported ephemeral `windows-2025` x64
  GitHub-hosted runner and records it as Windows Server 2025. Windows 11 remains
  a separate branded BrowserStack witness; CI evidence must never be relabeled
  as Windows 11. The workflow runs the same resolver/acquirer pinned by the policy, verifies each
  downloaded executable with PowerShell
  `Get-AuthenticodeSignature` (`Status=Valid` and Brave Software, Inc. signer),
  captures `brave.exe --version`, creates a distinct directory under
  `RUNNER_TEMP` for each clean profile, and invokes the same `run-matrix.mjs`
  contract. The workflow uploads one artifact containing provenance, all four
  demos, forced-H.264 and ladder evidence, pointer/focus/re-entry ledgers, and a
  60-second soak for current and boundary Brave. No installer is retained.

  ```bash
  BRANCH="$(git branch --show-current)"
  gh workflow run brave-windows-compatibility.yml \
    --ref "$BRANCH" \
    -f tunnel_url="$TUNNEL_URL" \
    -f tunnel_created_at="$TUNNEL_CREATED_AT" \
    -f source_commit="$COMMIT" \
    -f session_id="$SESSION"
  BRAVE_RUN_ID="$(gh run list \
    --workflow brave-windows-compatibility.yml \
    --branch "$BRANCH" --event workflow_dispatch --limit 20 \
    --json databaseId,displayTitle,headSha \
    --jq "[.[] | select(.displayTitle == \\"brave-windows-$SESSION\\" and .headSha == \\"$COMMIT\\")] | if length == 1 then .[0].databaseId else error(\\"expected exactly one matching Brave run\\") end")"
  gh run watch "$BRAVE_RUN_ID" --exit-status
  gh run download "$BRAVE_RUN_ID" \
    --name "brave-windows-$SESSION" --dir "$RUN_ROOT"
  node scripts/browser-compatibility/validate-evidence.mjs "$RUN_ROOT"
  ```

  BrowserStack Live cannot install a third-party desktop browser, so this is the
  only Windows Brave route. Task 0 builds and tests the tooling without needing
  a public endpoint; execute the command blocks after Task 9 Step 1 supplies
  `$TUNNEL_URL` and `$RUN_ROOT`, before Task 9 Step 2. Any unavailable, unsigned,
  or unverifiable binary fails its exact Brave slot; it is never replaced by
  Chrome evidence.

## Task 1: Preserve the exact rejected decoder output

**Files:**

- Modify: `packages/element/src/decoder-diagnostics.ts`
- Modify: `packages/element/src/decoder-protocol.ts`
- Modify: `packages/element/src/decoder.ts`
- Modify: `packages/element/src/decoder-worker.ts`
- Modify: `packages/element/src/decoder-pool.ts`
- Modify: `packages/element/src/player-contract.ts`
- Modify: `packages/element/src/player.ts`
- Modify: `packages/element/src/public-types.ts`
- Modify: `packages/element/src/aval-element.ts`
- Test: `packages/element/test/decoder.test.ts`
- Test: `packages/element/test/decoder-worker.test.ts`
- Test: `packages/element/test/element-lifecycle-regressions.test.ts`

- [ ] **Step 1: Add red tests for a later rejected frame**

  In `decoder.test.ts`, decode frame 0 with valid metadata and frame 1 with an
  invalid display ratio. Require the retained record to distinguish the prior
  first good frame from the rejected frame:

  ```ts
  expect(diagnostic.firstFrame?.timestamp).toBe(0);
  expect(diagnostic.outputFailure).toMatchObject({
    kind: "display-aspect",
    validationLayer: "host-expectation",
    expected: { timestamp: 1, duration: 1, displayAspect: [640, 360] },
    actual: { timestamp: 1, displayWidth: 1279, displayHeight: 720 }
  });
  ```

  Add table cases for `timing`, `display-aspect`, `visible-rect`,
  `color-space`, `coded-allocation`, `unknown-output`, `duplicate-output`, and
  `incomplete-output`. A callback from an already retired native decoder stays
  a silently closed stale callback and must not poison the current run.

- [ ] **Step 2: Add a red worker metadata-shape test**

  Make a fake `VideoFrame.duration` return `NaN`. The failure must be
  `metadata-shape` with `validationLayer: "worker-shape"`, a bounded field name,
  and safe partial scalar metadata. It must not contain the frame, config,
  encoded bytes, URL, stack, or unsafe numeric value. Extend exact-key,
  cross-realm, deep-freeze, redaction, and adversarial protocol tests for the
  new shape.

- [ ] **Step 3: Define the immutable output-failure contract**

  Add this closed internal model:

  ```ts
  type DecoderOutputFailureKind =
    | "metadata-shape"
    | "unknown-output"
    | "timing"
    | "display-aspect"
    | "visible-rect"
    | "color-space"
    | "coded-allocation"
    | "duplicate-output"
    | "incomplete-output";

  type DecoderOutputField =
    | "timestamp" | "duration" | "coded-width" | "coded-height"
    | "display-aspect" | "visible-rect" | "color-space"
    | "allocation" | "ordinal" | "frame-count";

  interface DecoderExpectedOutputMetadata {
    readonly timestamp: number | null;
    readonly duration: number | null;
    readonly codedWidth: number;
    readonly codedHeight: number;
    readonly displayAspectWidth: number;
    readonly displayAspectHeight: number;
    readonly visibleRect: Readonly<DecoderVisibleRectMetadata>;
    readonly colorSpace: DecoderColorSpaceMetadata | null;
    readonly frameCount: number | null;
  }

  interface DecoderObservedFrameMetadata {
    readonly timestamp: number | null;
    readonly duration: number | null;
    readonly codedWidth: number | null;
    readonly codedHeight: number | null;
    readonly displayWidth: number | null;
    readonly displayHeight: number | null;
    readonly visibleRect: Readonly<DecoderVisibleRectMetadata> | null;
    readonly colorSpace: DecoderColorSpaceMetadata | null;
    readonly receivedFrameCount: number | null;
  }

  interface DecoderOutputFailure {
    readonly kind: DecoderOutputFailureKind;
    readonly validationLayer: "worker-shape" | "host-expectation";
    readonly field: DecoderOutputField | null;
    readonly expected: Readonly<DecoderExpectedOutputMetadata> | null;
    readonly actual: Readonly<DecoderObservedFrameMetadata> | null;
  }
  ```

  Every number is `null` or a nonnegative safe integer; non-null dimensions are
  positive. Rect keys are exactly `x/y/width/height`; color is exactly the
  existing four-token tuple. `expected.frameCount` and
  `actual.receivedFrameCount` are populated only for completion failures. All
  objects/rects/tuples are exact-key checked and deeply frozen.

  Add `outputFailure` and `lastGoodFrame` to
  `DecoderFailureDiagnostic`. `DecoderObservedFrameMetadata` stores only safe
  finite scalars or `null`; it never stores WebCodecs objects. Keep
  `firstFrame` for historical comparison. Extend exact-key validation and
  freezing rather than accepting arbitrary diagnostic objects.

- [ ] **Step 4: Classify every decoder output boundary**

  Replace the compound `validateFrame()` predicate with ordered field checks
  that return or throw one typed validation failure. Preserve the same strict
  timestamp, duration, visible-rect, bounds, color, and safe-allocation rules.
  Record expected and rejected metadata before closing the frame. At flush,
  distinguish missing and duplicate current-run output from a malformed frame.
  Preserve the current run-isolation rule that closes stale callbacks from a
  retired decoder without creating a new terminal failure.

- [ ] **Step 5: Carry logical context through teardown**

  Extend `DecoderPoolDiagnostic` with exact keys `lane: 0 | 1`,
  `logicalRunId: number | null`, and
  `role: "foreground" | "candidate" | null`; the base `run` remains the
  physical worker's generation. Extend `PlayerDecoderDiagnostic` with
  `sourceIndex`, `rendition`, `codec`, `unit`, and a frozen `graph` object whose
  exact keys are `requestedState`, `visualState`, `activeUnit`, and
  `pendingUnit`, each `string | null`. `AvalDecoderDiagnostic` adds
  `sourceGeneration`; no layer renames `run` to `logicalRunId`. Retain one
  first terminal record per source/lane with the existing global bound. Ensure
  startup rejection and post-ready teardown both publish diagnostics before
  disposing workers.

- [ ] **Step 6: Prove public propagation**

  In `element-lifecycle-regressions.test.ts`, cause frame 1 to fail after frame
  0 succeeded. Assert `getDiagnostics().runtime.decoderDiagnostics[0]`
  deep-equals the worker record plus source/lane/unit context, is deeply frozen,
  survives terminal cleanup, and resets only when a newer source generation
  begins.

- [ ] **Step 7: Run focused tests**

  ```bash
  npx vitest run --config vitest.m9.config.ts \
    packages/element/test/decoder.test.ts \
    packages/element/test/decoder-worker.test.ts \
    packages/element/test/element-lifecycle-regressions.test.ts
  ```

  Expected: all decoder diagnostic, protocol, lifecycle, and cleanup tests pass.

## Task 2: Enforce the requested decoder config and the WebCodecs aspect contract

**Files:**

- Modify: `packages/element/src/decoder-worker.ts`
- Modify: `packages/element/src/decoder.ts`
- Modify: `packages/element/src/renderer.ts`
- Create: `packages/element/src/media-geometry.ts`
- Create: `packages/element/test/media-geometry.test.ts`
- Test: `packages/element/test/decoder-worker.test.ts`
- Test: `packages/element/test/decoder.test.ts`
- Test: `packages/element/test/renderer.test.ts`

- [ ] **Step 1: Write config-echo tests before implementation**

  Capture the exact argument received by fake `VideoDecoder.configure()`.
  Require requested `codec`, coded dimensions, display-aspect dimensions,
  color-space members, `hardwareAcceleration`, and `optimizeForLatency` to
  survive `isConfigSupported()`. Add table cases where the support result
  omits or changes one requested display/color member; each must terminate in
  `probe/unsupported-config` before decoder construction. A missing
  `result.config` is rejected when requested members cannot be proven.

- [ ] **Step 2: Validate the support-result echo**

  Add an exact recognized-member comparison in `decoder-worker.ts` before
  retaining `result.config`. Allow WebIDL defaults only for members absent from
  the original request. Configure with the validated clone; never silently
  replace a requested display/color override with a browser-mutated result.

- [ ] **Step 3: Write aspect-equivalence tests**

  In both decoder and renderer tests, require 640:360 → 1280:720 and
  48:104 → 96:208 to pass while 640:360 → 1279:720 fails as
  `display-aspect`. Add a pair near the unsigned-32-bit limit so a Number
  cross-product implementation would lose precision.

- [ ] **Step 4: Implement overflow-safe ratio comparison**

  Add `sameAspectRatio()` to `media-geometry.ts` using `BigInt` cross-products
  after validating four positive safe integers. Decoder and renderer both
  import it. `media-geometry.test.ts` owns equal, reduced, near-miss, zero,
  unsafe, and unsigned-32-bit-boundary cases. Keep exact authored visible
  storage and bounds; do not use ratio equivalence to weaken crop, timing,
  color, or allocation.

- [ ] **Step 5: Run focused tests and typechecking**

  ```bash
  npx vitest run --config vitest.m9.config.ts \
    packages/element/test/decoder-worker.test.ts \
    packages/element/test/decoder.test.ts \
    packages/element/test/media-geometry.test.ts \
    packages/element/test/renderer.test.ts
  npm run typecheck -w @pixel-point/aval-element
  ```

  Expected: all tests pass and generated public declarations remain exact.

## Task 3: Preserve renderer causes and stop false `context-loss` reports

**Files:**

- Create: `packages/element/src/renderer-diagnostics.ts`
- Modify: `packages/element/src/renderer.ts`
- Modify: `packages/element/src/player-contract.ts`
- Modify: `packages/element/src/player.ts`
- Modify: `packages/element/src/public-types.ts`
- Modify: `packages/element/src/aval-element.ts`
- Test: `packages/element/test/renderer.test.ts`
- Test: `packages/element/test/player-prefetch.test.ts`
- Test: `packages/element/test/element-lifecycle-regressions.test.ts`

- [ ] **Step 1: Add red constructor-boundary tests**

  Cover these exact outcomes with the real renderer and fake GL:

  - `getContext("webgl2") === null` → `context-create`;
  - successful context plus invalid/too-small capability →
    `capability-query` or `device-limits`;
  - shader/program failure → `program-create`;
  - first `texStorage2D` reporting `OUT_OF_MEMORY` (`0x0505`) →
    `stream-texture-create`, `textureOrdinal: 0`, `contextLost: false`.

  Assert each remains distinct from a pre-GL `ResourceBudgetError`.

- [ ] **Step 2: Define one retained renderer diagnostic**

  Add a deeply frozen, exact-key record with:

  ```ts
  type RendererDiagnosticPhase =
    | "backing-admission" | "context-create" | "capability-query"
    | "device-limits" | "program-create" | "stream-texture-create"
    | "resident-texture-create" | "native-upload" | "semantic-upload"
    | "rgba-copy" | "rgba-upload" | "draw" | "resize"
    | "context-event";
  ```

  Add `operation: "construct" | "runtime" | "restore"` separately from phase,
  then store operation ordinal, sanitized exception, GL error enum, actual
  context-loss flag, upload path, texture ordinal, layout/backing dimensions,
  byte-accounting snapshot, queried limits, and returned context attributes.
  Vendor/renderer strings are optional, bounded diagnostics-only fields read
  only through `WEBGL_debug_renderer_info`; their absence is normal. Encoded
  data, URLs, shader source, stacks, and arbitrary GL objects are forbidden.

- [ ] **Step 3: Throw a typed constructor failure and retain async failures**

  A GL-owned constructor failure must throw an internal
  `RendererFailureError` carrying the frozen record because no renderer
  snapshot exists. Argument, layout, exact-arithmetic, and configured resource
  admission errors retain their current `TypeError`/`RangeError`/
  `ResourceBudgetError` identity and are not relabeled as GL failures. A live
  renderer keeps its first GL/runtime failure in `snapshot().failure`. Capture
  `gl.getError()` immediately after the operation that can set it and before
  drain/cleanup. Poll every native upload, including uploads after native mode
  was previously proven; poll RGBA upload and draw as well.

- [ ] **Step 4: Remove the masking race**

  Change the context callback to carry the same failure identity for an async
  renderer error. Let the rejected renderer operation own non-context
  terminalization. Only the actual `webglcontextlost` listener publishes
  `context-loss`; copy, validation, upload, draw, resize, and restore failures
  publish `renderer-failure` with their retained phase. Deduplicate callback and
  promise paths by the diagnostic/error identity so only one public terminal
  error wins.

- [ ] **Step 5: Add race and restore regressions**

  Test a `VideoFrame.copyTo()` `EncodingError` and require the draw rejection,
  renderer snapshot, player diagnostic, and sole public terminal error to share
  the same renderer evidence and use `renderer-failure`, never `context-loss`.
  Separately dispatch a real context-lost event and require `context-loss`.
  Trigger restore followed by texture allocation failure and require
  `operation: "restore"`, `phase: "stream-texture-create"`, and the exact GL
  enum.

- [ ] **Step 6: Propagate renderer diagnostics publicly**

  Add a bounded `rendererDiagnostics` array to player and element diagnostics,
  retained across terminal teardown and cleared on the next source generation.
  Keep `AvalPublicFailure` small and stable; applications branch on the public
  code, while the detailed record remains diagnostic.

- [ ] **Step 7: Run renderer, player, and lifecycle tests**

  ```bash
  npx vitest run --config vitest.m9.config.ts \
    packages/element/test/renderer.test.ts \
    packages/element/test/player-prefetch.test.ts \
    packages/element/test/element-lifecycle-regressions.test.ts
  ```

  Expected: exact renderer phases survive construction/runtime cleanup and no
  synthetic context-loss race remains.

## Task 4: Qualify native VideoFrame upload semantically

**Files:**

- Modify: `packages/element/src/renderer.ts`
- Test: `packages/element/test/renderer.test.ts`
- Modify: `tests/end-user-playground/playground.spec.ts`

- [ ] **Step 1: Add a silent-corruption renderer fake**

  Extend the fake GL so native `texSubImage2D(VideoFrame)` returns
  `NO_ERROR` but renders a black sentinel, while typed RGBA upload renders the
  reference pixels. Require the first presentation to use the correct pixels
  and `snapshot().uploadMode` to become `rgba-copy` permanently.

- [ ] **Step 2: Add native-proven regression coverage**

  Make the first native probe succeed semantically and the second native
  upload report `INVALID_OPERATION`. Require that later error to be observed,
  the frame to retry through RGBA copy, and the renderer to remain usable. The
  current `(native === 2 || getError() === NO_ERROR)` short-circuit must no
  longer exist.

- [ ] **Step 3: Implement a bounded semantic canary**

  For at most three nonuniform frames per renderer generation:

  1. upload the frame natively;
  2. render the complete packed-alpha/opaque shader result into an 8×8 probe
     viewport and read 256 RGBA bytes immediately;
  3. copy the same frame through `VideoFrame.copyTo(..., { format: "RGBA" })`,
     upload those pixels, render the same probe, and read the reference;
  4. compare premultiplied shader-output readbacks with an absolute tolerance
     of 3 for RGB and 1 for alpha; ignore RGB only where reference alpha is
     zero;
  5. mark native proven only when the reference has enough color/alpha variance
     to detect a black/transparent false positive and both results match.

  A reference is informative only when at least two of the 64 samples differ
  by 16 or more in an RGB/alpha channel and at least one sample has alpha or
  luma above 16. If the results differ, a GL error occurs, the context is lost,
  or three frames remain semantically uninformative, permanently select RGBA
  copy for that renderer generation. The current frame remains on the correct
  RGBA texture, so qualification never shows the unproven native pixels. Reset
  the decision only after a new context is successfully initialized.

- [ ] **Step 4: Keep qualification within resource and cleanup accounting**

  Reuse the streaming texture and the main framebuffer for the bounded 8×8
  reads; do not allocate an untracked full-size canary texture. Restore the real
  viewport before the presentation draw. Track probe readback bytes and
  operation state in `snapshot()`, and ensure dispose/context loss releases all
  pending work.

- [ ] **Step 5: Add a real-browser packed-alpha pixel witness**

  Extend the playground Playwright test to sample several interior and edge
  pixels over two different states. Require non-black color variance,
  transparent exterior pixels, changing frame hashes, and a successful return
  to `idle`. A readiness flag alone cannot pass the test.

- [ ] **Step 6: Run focused and playground tests**

  ```bash
  npx vitest run --config vitest.m9.config.ts packages/element/test/renderer.test.ts
  npm run test:playground
  ```

  Expected: semantic corruption selects RGBA copy and packed-alpha screenshots
  contain correct transparent/color pixels.

## Task 5: Fix authored re-engagement and prove every public state

**Files:**

- Modify: `examples/grass-rabbit/motion.json`
- Modify: `examples/grass-rabbit-codecs/motion.json`
- Modify: `examples/kinetic-orb/motion.json`
- Regenerate: `examples/grass-rabbit/public/grass-rabbit/{av1,vp9,h265,h264}.avl`
- Regenerate: `examples/grass-rabbit-codecs/public/grass-rabbit/{av1,vp9,h265,h264}.avl`
- Regenerate: `examples/kinetic-orb/public/kinetic-orb/h264.avl`
- Regenerate: each of those three directories' `build.json`
- Modify from generated source markup: `examples/grass-rabbit/index.html`
- Modify from generated source markup: `examples/kinetic-orb/index.html`
- Modify: `tests/grass-rabbit/grass-rabbit.spec.ts`
- Modify: `tests/grass-rabbit-codecs/rabbit-interaction.spec.ts`
- Modify: `tests/kinetic-orb/interaction.spec.ts`
- Modify: `tests/end-user-playground/playground.spec.ts`
- Modify: `packages/element/test/element-lifecycle-regressions.test.ts`
- Create: `scripts/browser-compatibility/validate-example-assets.mjs`
- Create: `scripts/browser-compatibility/test/validate-example-assets.test.ts`

- [ ] **Step 1: Add failing re-entry tests**

  For each hover demo, enter `hover`, leave until `visualState === "exiting"`,
  re-enter within the finite hover-out body, and require automatic settlement
  back to `hover` without another pointer edge. Exercise an early and late
  re-entry: frames 2 and 10 of Kinetic's 12-frame body, and frames 2 and 46 of
  each Rabbit's 48-frame body. Repeat with blur/focus. Add an element deferred-
  qualification test that toggles pointer and focus while the provisional
  player is pending, publishes, and settles to the final combined engagement
  level with no stale intermediate request.

- [ ] **Step 2: Author the missing route**

  Add this edge to Kinetic Orb:

  ```json
  {
    "id": "exiting.entering",
    "from": "exiting",
    "to": "entering",
    "trigger": { "type": "event", "name": "hover.enter" },
    "start": {
      "type": "finish",
      "targetPort": "default",
      "maxWaitFrames": 11
    },
    "continuity": "exact-authored"
  }
  ```

  Add the same edge to both Rabbit graphs with
  `"maxWaitFrames": 47`, matching their 48-frame `hover-out` unit. The value
  remains 11 only for Kinetic's 12-frame unit.

  This preserves the authored hover-out completion, then re-enters through the
  normal hover-in body. Do not teach the generic runtime that a state named
  `exiting` has special semantics.

- [ ] **Step 3: Regenerate and verify fixtures**

  Build public packages and compile each affected example. The new validator
  invokes the built compiler inspector with `inspect <asset> --json` for the
  nine affected outputs and the playground's four canonical outputs. It
  requires the new edge in the affected graph assets, unchanged source
  ordering, exact unit/frame counts, and exact file bytes, codec string,
  SHA-256, SRI, and MIME type from each build report. It also compares the
  playground, Grass Rabbit, and Kinetic Orb's checked-in `<source>` elements to
  generated `sourceMarkup`. For the playground it additionally requires byte-
  identical AV1/VP9/H.265/H.264 files and a semantically identical `build.json`
  to `fixtures/conformance/v1`, including exact SHA/SRI/MIME and ordered source
  markup. The codec chooser intentionally has no static source markup: its
  controller must continue to create the selected source exclusively from the
  matching `build.json` asset. `fixtures:verify` remains a separate repository
  fixture gate and is not claimed to validate these example outputs.

  ```bash
  npm run build:public-packages
  npm run compile:grass-rabbit
  npm run compile:grass-rabbit-codecs
  npm run compile:kinetic-orb
  npx vitest run --config vitest.m9.config.ts \
    scripts/browser-compatibility/test/validate-example-assets.test.ts
  node scripts/browser-compatibility/validate-example-assets.mjs
  ```

- [ ] **Step 4: Prove full state event order**

  For each hover demo, assert initial visible state, every public interaction state,
  `transitionstart`, `visualstatechange`, `transitionend`, settled requested and
  visual state, and return to initial state. Desktop witnesses separately cover
  pointer and focus; touch witnesses use tap on player, tap outside, and tap
  during `entering`/`exiting`.

  For the end-user playground, assert visible `idle → engaged → idle`,
  exact `transitionstart → visualstatechange → transitionend` ordering
  in both directions, settled requested/visual states, distinct correct pixel
  samples in both states, button activation on desktop, and tap activation on
  a touch project. The existing engaged-only endpoint is insufficient.

- [ ] **Step 5: Run all affected example suites**

  ```bash
  npm run test:grass-rabbit
  npm run test:grass-rabbit-codecs
  npm run test:kinetic-orb
  npm run test:playground
  ```

  Expected: all authored state and re-entry paths render and settle exactly.

## Task 6: Add lifecycle counters and a true 60-second soak

**Files:**

- Modify: `packages/element/src/decoder-worker.ts`
- Modify: `packages/element/src/decoder-pool.ts`
- Modify: `packages/element/src/player-contract.ts`
- Modify: `packages/element/src/player.ts`
- Modify: `packages/element/src/public-types.ts`
- Test: `packages/element/test/decoder-worker.test.ts`
- Test: `packages/element/test/player-prefetch.test.ts`
- Modify: `tests/kinetic-orb/browser-harness.ts`
- Modify: `tests/kinetic-orb/interaction.spec.ts`
- Modify: `playwright.kinetic-orb.config.ts`
- Modify: `playwright.playground.config.ts`
- Modify: `playwright.grass-rabbit.config.ts`
- Modify: `playwright.grass-rabbit-codecs.config.ts`
- Modify: `package.json`
- Create: `scripts/browser-compatibility/test/browser-script-contract.test.ts`

- [ ] **Step 1: Add a 64-generation worker regression**

  Reuse one worker for 64 acknowledged generations, each with the same valid
  24-frame GOP. Require 64 native decoder creations under the current design,
  all retired generations closed, no stale ordinal maps, no retained frames,
  and no terminal diagnostic.

  Add a separate test that completes 20 valid generations, injects one invalid
  output in generation 21, requires exact lane/run/unit/role/expected/rejected
  evidence and terminal cleanup, and stops. A terminal worker is never expected
  to continue to generation 64.

- [ ] **Step 2: Add a 60-wrap player regression**

  Drive a 24-frame loop through 1,440 content ticks. Assert exact 0…23 local
  frames, 60 loop crossings, bounded live runs/frames, correct candidate
  promotion ordering, both lanes exercised, final `idle/interactiveReady`, no
  underflow, and no terminal diagnostic. This test must not rely on the
  512-record trace retaining the entire history.

- [ ] **Step 3: Add monotonic lifecycle counters**

  Add one exact `AvalPlaybackLifecycleCounters` object with keys
  `outputsAccepted`, `drawsCompleted`, `logicalRunsCreated`,
  `candidateCommits`, `runsClosed`, `transitionStarts`, `transitionEnds`,
  `loopCrossings`, `nativeDecoderCreatesByLane`, and
  `nativeDecoderClosesByLane`; the lane fields are frozen two-number tuples for
  lanes 0 and 1. Increment only after the named operation completes
  successfully; a nonthrowing native `.close()` increments close, while an
  attempted/failed operation does not increment its success counter. Use one
  `saturatingIncrement()` that clamps at `Number.MAX_SAFE_INTEGER`.

  Worker/pool/player own live counters, and the element copies the latest
  source-generation snapshot before teardown so values remain monotonic after
  an error. Reset all keys only when `#sourceGeneration` advances. No counter
  contains timestamps, bytes, codec payload, or URLs. Add exact-key, saturation,
  reset, teardown-retention, and lane-order tests.

- [ ] **Step 4: Add the real-time Kinetic soak project**

  Create a dedicated Playwright project/test with at least a 90-second timeout.
  After `interactiveReady`, run 10 seconds idle, eight full pointer cycles,
  eight full focus cycles, the overlap/re-entry cases, then 10 seconds idle;
  keep total post-ready observation at 60 seconds. Every second require
  readiness `interactiveReady`, `lastFailure === null`, advancing draw/run
  counters, zero underflow, and a changing rendered-frame sample. Export the
  interaction ledger separately rather than relying on the 32-checkpoint/64-
  trace-tail browser overlay.

- [ ] **Step 5: Add local engine projects**

  Add Chromium, Firefox, and WebKit projects to every permanent-demo config;
  keep the 60-second project only in the Kinetic config. Skip playback only
  when the engine truly lacks the required WebCodecs API, and assert a stable
  unsupported error in that case. Do not relabel Playwright WebKit as Safari;
  branded BrowserStack/device coverage remains authoritative. Remove the root
  `test:grass-rabbit-codecs` script's current Chromium/WebKit-only project
  filter so its normal command also runs Firefox. Add a command-contract test
  or package-script assertion proving all four permanent-demo commands include
  all three local engines.

- [ ] **Step 6: Run lifecycle and soak tests**

  ```bash
  npx vitest run --config vitest.m9.config.ts \
    packages/element/test/decoder-worker.test.ts \
    packages/element/test/player-prefetch.test.ts \
    scripts/browser-compatibility/test/browser-script-contract.test.ts
  npm run test:kinetic-orb
  ```

  Expected: 64 worker generations, 60 loop wraps, and the 60-second interaction
  soak finish without stale state, blank pixels, resource growth, or error.

## Task 7: Make BrowserStack evidence machine-verifiable

**Files:**

- Modify: `examples/support/aval-browser-diagnostics.js`
- Modify: `tests/support/browser-diagnostic-capture.ts`
- Modify: the four example `diagnostics.spec.ts` files
- Modify: `scripts/browser-compatibility/certification-policy.json`
- Create: `scripts/browser-compatibility/evidence-schema.mjs`
- Create: `scripts/browser-compatibility/source-tree-attestation.mjs`
- Create: `scripts/browser-compatibility/validate-evidence.mjs`
- Create: `scripts/browser-compatibility/test/validate-evidence.test.ts`
- Create: `scripts/browser-compatibility/test/source-tree-attestation.test.ts`
- Create before capture: immutable `run-identity.json` inside the
  full-commit/UTC-session run root resolved in Step 2
- Create after capture: `manifest.json`, exclusively through the live-evidence
  assembler after the raw tree is complete

- [ ] **Step 1: Expose complete bounded failure summaries**

  Render decoder mismatch kind/field/layer, lane/run/unit, and renderer
  phase/GL enum/context state in the overlay. Keep the full exact objects in
  `window.avalBrowserDiagnostics.report()` and sanitize them through the
  existing bounded copier. Never display URLs, source bytes, tokens, or stacks.

- [ ] **Step 2: Export JSON alongside screenshots**

  Resolve the immutable run root before launching a browser:

  ```bash
  COMMIT=$(git rev-parse HEAD)
  SESSION=$(date -u +%Y%m%dT%H%M%SZ)
  RUN_ROOT="artifacts/browser-compatibility/runs/$COMMIT/$SESSION"
  ```

  Before serving, `source-tree-attestation.mjs` hashes the full HEAD commit,
  staged and unstaged tracked diffs, sorted untracked source-file path/mode/
  content records under the repository's code/config/fixture roots, the
  checked-in certification-policy bytes, and the exact built files exposed by
  `serve-built-examples.mjs`. It excludes only `.git`, dependency caches, and
  the artifact run root to avoid self-reference. Store the resulting
  `headCommit`, `trackedDiffSha256`, `untrackedSourceTreeSha256`,
  `policySha256`, and `servedTreeSha256` in immutable `run-identity.json` by
  calling `initializeBrowserDiagnosticEvidenceRunRoot` exactly once before any
  capture writer starts. This permits an explicitly attested dirty development
  capture without falsely labeling it as bare HEAD; final certification
  requires the same identity and digest throughout the run. Capture writers
  require this marker, verify that the run-root suffix is
  `<headCommit>/<sessionId>`, and refuse to write after assembly. Never update a
  prior run root in place.

  A formal Playwright/BrowserStack Automate producer writes:

  - `<platform>/<demo>/<checkpoint>.png`;
  - `<platform>/<demo>/<checkpoint>.json` from the in-page report;
  - `<platform>/<demo>/interaction-ledger.json` for state/soak runs; and
  - `<platform>/session.json` containing exact BrowserStack session id, OS, device, browser,
    browser version, tunnel URL creation time, source commit, and test time.

  Signed-in BrowserStack Live is a streamed, operator-controlled UI and is not
  itself a Playwright `Page`. Its Device Info view and screenshots are useful
  manual evidence, but they must be stored and reported as manual observations;
  they cannot be relabeled as the machine-verifiable files above, and provider
  session ids must never be invented. Formal capture requires an actual
  BrowserStack Automate/Playwright session with credentials and a provider
  session id. If those are unavailable, report the formal matrix as pending.

  After all raw sessions have been captured, the live-evidence assembler checks
  exact policy coverage, rejects any changed marker or pre-existing manifest,
  and exclusively creates `manifest.json`. The checked-in certification policy,
  not the run manifest, defines required browser/device slots. The assembled
  manifest binds every policy slot to a session and defines each mode's expected
  authored source list:
  full-ladder runs for End User Playground, Grass Rabbit, and Kinetic Orb use
  `[av1,vp9,h265,h264]`; forced-H.264 runs use `[h264]`, and codec-specific
  controller runs use the one selected codec.

- [ ] **Step 3: Validate evidence invariants**

  `validate-evidence.mjs` first validates the policy against its checked-in
  schema, verifies its hash and the full source/served-tree attestation, and
  compares the run's slot set for exact equality. It then rejects missing JSON
  pairs, stale commit ids, moving version aliases, authored sources that differ
  from the per-run manifest, a visible readiness/canvas mismatch, missing
  state/event sequence, nonzero terminal failures, or less than 60 seconds of
  soak counters. A repeated PNG hash is rejected only when the ledger declares
  a different visual state or advancing-frame checkpoint; identical
  settled-state captures remain legal.

- [ ] **Step 4: Test the validator against good and adversarial fixtures**

  In `validate-evidence.test.ts`, create temporary manifests for a policy slot
  omitted from the run, an extra slot, missing PNG, state-inconsistent duplicate
  PNG, legitimate same-state duplicate PNG, wrong browser version, stale commit,
  altered tracked diff, altered untracked source, changed served build, wrong
  per-mode codec list, ready-but-black pixels, skipped transitionend, and a
  failure hidden after readiness. Require every invalid case to fail with a
  precise code and the legitimate duplicate to pass. Test attestation ordering,
  exclusions, path normalization, and one-byte changes independently.

- [ ] **Step 5: Run diagnostic and evidence tests**

  ```bash
  npm run test:playground
  npm run test:grass-rabbit
  npm run test:grass-rabbit-codecs
  npm run test:kinetic-orb
  npx vitest run --config vitest.m9.config.ts \
    scripts/browser-compatibility/test/validate-evidence.test.ts
  ```

  Expected: browser capture schemas and validator fixtures pass. Real run roots
  are validated only after capture completes, the assembler creates the
  manifest, and all signed-in Automate artifacts exist. Manual BrowserStack Live
  screenshots remain operator evidence and do not satisfy this gate.

## Task 8: Replace the mandatory H.264 compatibility assets

- [ ] Execute every red test, implementation, regeneration, and focused gate in
  [Appendix A](#appendix-a-task-8-h264-compatibility-implementation-details)
  before starting Task 9. Commit the constrained-baseline compiler/runtime
  change and all regenerated fixtures/examples together. The remote diagnostic
  tasks must never classify behavior from the retired High-profile/Level-5
  assets.
- [ ] Verify the Brave tooling's offline tests and the regenerated H.264 fixture
  hashes now. The live Brave smoke executes immediately after Task 9 Step 1
  starts the shared endpoint and before any diagnostic classification.

## Task 9: Recapture the first failing boundaries before the remaining fixes

**Files:**

- Create: `scripts/browser-compatibility/serve-built-examples.mjs`
- Create: `scripts/browser-compatibility/test/serve-built-examples.test.ts`
- Create: `scripts/browser-compatibility/codec-probe.html`
- Create: `scripts/browser-compatibility/codec-probe.js`
- Create: `scripts/browser-compatibility/renderer-isolator.html`
- Create: `scripts/browser-compatibility/renderer-isolator.js`
- Create during capture: the evidence tree inside the exact immutable run root
  resolved by Task 7
- Reference: `artifacts/browser-compatibility/2026-07-19/report.md`

- [ ] **Step 1: Start one HTTPS test endpoint**

  `serve-built-examples.mjs` binds only `127.0.0.1:4179` and maps immutable
  routes `/playground/`, `/rabbit/`, `/codecs/`, `/orb/`, `/probe/`, and
  `/isolators/renderer/` to the four Vite builds and two probe pages.
  `codec-probe.js` accepts only the closed
  `demo={playground,rabbit,codecs,orb}` and
  `codec={av1,vp9,h265,h264}` query tokens, reads that demo's `build.json`, and
  creates one element with only the selected source/integrity. Invalid pairs
  return a visible error without fetching media.

  Run:

  ```bash
  npm run build
  npx vitest run --config vitest.m9.config.ts \
    scripts/browser-compatibility/test/serve-built-examples.test.ts
  node scripts/browser-compatibility/serve-built-examples.mjs \
    --host 127.0.0.1 --port 4179
  cloudflared tunnel --url http://127.0.0.1:4179 --no-autoupdate
  ```

  Keep server and tunnel in separate terminal sessions and record their exact
  session ids. Record source commit, UTC session id, route map, and tunnel URL
  in the run manifest. After capture, send Ctrl-C to those two exact sessions
  and verify `lsof -nP -iTCP:4179 -sTCP:LISTEN` is empty; never kill by process
  name or glob.

  Before Step 2, execute Task 0's macOS and Windows Brave command blocks against
  this endpoint and the regenerated constrained-baseline H.264 assets. Require
  the direct-H.264 smoke to render correct pixels and complete one state cycle
  in current and boundary Brave on each OS. Retain its exact binary version,
  signature, PNG, JSON, and ledger evidence in the same immutable run.

- [ ] **Step 2: Capture Android decoder controls**

  Through the signed-in in-app BrowserStack session, run Pixel 9 / Android 17
  Chrome and Galaxy S25 / Android 15 Chrome with:

  - 48×104 packed-alpha AV1 control;
  - 640×360 opaque Rabbit AV1;
  - cropped Rabbit H.264 (coded 640×368, visible 640×360);
  - 1280×720 opaque AV1;
  - 512×512 opaque H.264;
  - 1280×720 opaque H.264.

  Save ready/error PNG+JSON pairs. Each failed case must contain config echo,
  expected output, rejected output, mismatch kind/field, lane/run/unit, and
  renderer diagnostic if presentation began.

- [ ] **Step 3: Capture Windows renderer isolators**

  `renderer-isolator.js` imports the production renderer build and exposes
  three fresh-canvas modes: exact production attributes, production attributes
  without `desynchronized`, and browser defaults. It releases each successful
  context with `WEBGL_lose_context` and exports the exact typed diagnostic/caps/
  attributes as JSON. Add a local Playwright test proving the three modes and
  JSON schema before remote use.

  On Windows 11 Chrome 150, run the exact 48×104 playground renderer first,
  then 1280×720. Record context result, returned attributes, caps, GL enum,
  texture ordinal, dimensions, phase, and byte accounting. On fresh canvases,
  A/B the production attributes, production attributes without
  `desynchronized`, and browser defaults, releasing each probe context with
  `WEBGL_lose_context`. Repeat the tiny probe on Chrome 149, 148, and 127.

  For every checkpoint, use the already-connected in-app Browser runtime:
  `tab.playwright.screenshot({ path: absolutePngPath, fullPage: true })`, then
  evaluate `window.avalBrowserDiagnostics.report()` and write its JSON to the
  matching absolute `.json` path in the same Node-backed browser session. Read
  the exact OS/device/browser/version shown by BrowserStack into
  `session.json`; do not infer it from a moving dashboard alias. Re-open each
  written PNG through the local image viewer and parse each JSON before moving
  to the next slot.

- [ ] **Step 4: Capture iOS post-ready decoder evidence**

  On iPhone 17 / iOS 26.5 and iPhone 16 / iOS 18.6 Safari, run Kinetic for 60
  seconds. Save compact counter/checkpoint JSON at 0, 10, 20, 30, 45, and 60
  seconds plus screenshots at ready, after pointer, after focus, and final.
  If it fails, the artifact must show worker/host validation layer, expected,
  last-good, rejected metadata, lane, physical/logical generation, unit, role,
  and graph state.

- [ ] **Step 5: Classify, do not guess**

  Append a short classification table to the immutable run's `README.md`:

  | Symptom | Required discriminator |
  | --- | --- |
  | Android `invalid-output` | exact mismatch kind and expected/actual |
  | Android black square | native/reference semantic canary result |
  | Windows renderer startup | context/capability/program/texture phase + GL enum |
  | iOS delayed failure | rejected field + lane/generation/unit/role |

  The next tasks apply only the matching exact branch below; they do not relax
  unrelated validation.

## Task 10: Apply the captured Windows renderer branch

**Files:**

- Create after classification:
  `docs/superpowers/plans/<run-id>-windows-renderer-fix.md`
- Update: the immutable run `README.md`

- [ ] **Step 1: Select and freeze exactly one evidence-matched branch**

  Apply this deterministic decision table:

  - `context-create` only with production attributes, but defaults succeed:
    retry once without `desynchronized`, record chosen attributes, and keep the
    same WebGL2 backend;
  - `stream-texture-create/OUT_OF_MEMORY` after valid caps: allocate one stream
    texture first, grow to at most three only after successful presentations,
    rotate over the actual count, and account the exact allocation;
  - backing/resource admission: compute the largest safe backing scale from
    texture, backing, and manifest runtime caps, reduce DPR before assigning the
    canvas, and expose `resolutionScale`/`clampReasons`; never exceed device or
    manifest limits;
  - program/device/context failure even with default attributes: add a bounded
    Canvas 2D RGBA backend behind the same renderer contract. It must use
    `VideoFrame.copyTo`, reconstruct packed alpha from the authored color/alpha
    rectangles into straight RGBA, preserve fit/pixel aspect/transparency, use
    the same byte caps/watchdog/disposal rules, and report its backend. It is a
    presentation backend, not consumer fallback content;
  - any other phase: fix only the exact failing GL call and add its captured
    enum/shape as the red regression before implementation.

  Before mutating runtime code, write and commit the branch-specific plan named
  above. It must replace the decision table with the captured diagnostic JSON,
  exact source/test files, first red assertion, implementation shape, cleanup/
  budget invariants, and local/BrowserStack acceptance commands. If Canvas 2D
  is selected, the plan must explicitly create
  `packages/element/src/canvas2d-renderer.ts` and its parity test; otherwise
  that file is not created. This plan-amendment gate prevents an unobserved
  backend rewrite.

- [ ] **Step 2: Execute the committed branch-specific plan**

  For the selected branch, first make its captured red test fail, then compare deterministic pixel samples and frame hashes
  against the existing WebGL RGBA-copy reference for opaque, odd padded
  packed-alpha, cropped H.264, all fit modes, resize, disposal, and context
  failure. Require the same public renderer-failure boundary when both
  backends are unavailable.

- [ ] **Step 3: Rerun focused local tests**

  ```bash
  npx vitest run --config vitest.m9.config.ts \
    packages/element/test/renderer.test.ts \
    packages/element/test/player-selection.test.ts \
    packages/element/test/player-prefetch.test.ts
  npm run test:playground
  npm run test:grass-rabbit
  ```

- [ ] **Step 4: Rerun Windows Chrome 150/149/148/127**

  This is a diagnostic rerun, not final certification, but it still requires
  all four demos, direct H.264, full pointer/focus states, and a soak on every
  Chrome 150/149/148/127 slot. Save new immutable PNG+JSON evidence and run the
  evidence validator; never replace the failing baseline.

## Task 11: Isolate and fix the captured iOS decoder lifecycle branch

**Files:**

- Create: `scripts/browser-compatibility/kinetic-decoder-isolator.html`
- Create: `scripts/browser-compatibility/kinetic-decoder-isolator.js`
- Create: `scripts/browser-compatibility/kinetic-decoder-isolator-worker.js`
- Create: `tests/browser/kinetic-decoder-isolator.spec.ts`
- Modify: `scripts/browser-compatibility/serve-built-examples.mjs`
- Modify: `scripts/browser-compatibility/test/serve-built-examples.test.ts`
- Create after classification:
  `docs/superpowers/plans/<run-id>-ios-decoder-lifecycle-fix.md`
- Update: the immutable iOS run artifacts

- [ ] **Step 1: Build a render-free 64-generation isolator**

  Serve the built internal element modules under `/internal/element/`. The
  isolator imports production `Asset` to open
  `/orb/kinetic-orb/h264.avl`, loads `idle-loop`, and constructs samples from
  its verified records. Mode A uses the production `Decoder`/worker path. Modes
  B/C use `kinetic-decoder-isolator-worker.js`, which shares the exact config,
  chunks, output metadata capture, and close rules but changes only the tested
  lifecycle/timing variable. Close every output frame immediately and export
  one bounded JSON result for 64 generations. Run:

  - A: current new-`VideoDecoder`-per-generation lifecycle;
  - B: one persistent decoder with flushed GOPs and monotonically rebased
    timestamps mapped back to logical timestamps;
  - C: current ordinal microsecond timing versus real 24fps microsecond timing.

  This probe has no graph, element, or renderer, so a failure isolates native
  decoder lifecycle/output.

  `kinetic-decoder-isolator.spec.ts` runs A/B/C locally, verifies the loaded
  unit SHA-256 and 24-frame count, checks that each mode changes only its named
  variable, requires 64-success output/counter schemas, and exercises one
  injected generation-21 failure. Add the isolator route to the unified server
  test before using it on BrowserStack.

- [ ] **Step 2: Select and freeze the exact iOS decision branch**

  - If the captured failure is display-aspect only, Task 2 is the complete fix;
  - if A fails and B survives, keep one configured decoder per worker across
    acknowledged runs, rebase timestamps monotonically, map outputs back to
    logical run/timestamp/ordinal, flush between independent GOPs, and close
    only on worker dispose/config change;
  - if ordinal timing fails but real 24fps timing survives, derive exact safe
    microsecond timestamps/durations from the manifest frame-rate rational and
    update expected timing consistently;
  - if a standards-required duration/color/rect field intermittently violates
    the contract in A and B, keep validation strict, cancel a speculative
    candidate lane without poisoning a still-valid foreground lane, retry the
    same independently decodable unit once on the retired lane, and terminate
    with the preserved field evidence if the retry fails;
  - if render-free A/B/C all survive, use the captured role/graph/renderer phase
    to fix the first non-decoder boundary; do not add decoder churn workarounds.

  Before runtime mutation, write and commit the branch-specific plan named
  above with the captured JSON, exact protocol/pool/player/public-diagnostic
  files, first red test, timestamp/run identity model, stale-output rule,
  cleanup/resource invariants, and acceptance commands. A persistent-decoder
  branch must include `decoder-protocol.ts`, `decoder-pool.ts`,
  `player-contract.ts`, `public-types.ts`, and their tests; a timing branch must
  also include compiler/format frame-rate propagation tests. Unselected branch
  files remain untouched.

- [ ] **Step 3: Execute the committed branch-specific plan and prove ownership**

  For a persistent-decoder branch, test 64 generations, timestamp rebasing near
  safe-integer boundaries, late output from an old logical run, abort, close,
  dispose during flush, candidate promotion, and failure isolation. Require no
  output relabeling, no frame leak, and bounded maps/counters.

- [ ] **Step 4: Rerun iOS 26.5 and observed iOS 18.6 60-second suites**

  Require Kinetic and all other demos to remain visually correct through the
  full state/soak witness. Save exact PNG, JSON, and ledger artifacts and run
  the validator.

## Appendix A: Task 8 H.264 compatibility implementation details

**Files:**

- Modify: `packages/format/src/h264/codec.ts`
- Modify: `packages/format/src/h264/types.ts`
- Modify: `packages/format/src/h264/parameter-sets.ts`
- Modify: `packages/format/src/h264/slice-header.ts`
- Modify: `packages/format/src/h264/inspector.ts`
- Modify: `packages/format/src/h264/encoder-preparation.ts`
- Create: `packages/format/src/h264/canonicalize.ts`
- Modify: `packages/format/src/h264/index.ts`
- Modify: `packages/format/src/index.ts`
- Modify: `packages/format/src/video/codec-string.ts`
- Modify: `packages/compiler/src/ffmpeg/video-encode-unit.ts`
- Modify: `packages/compiler/src/compile/video-codec-compiler.ts`
- Modify: `packages/compiler/src/compile/video-encoding-policy.ts`
- Modify: `packages/compiler/src/ffmpeg/discovery.ts`
- Modify: `packages/compiler/src/commands/asset-validation.ts`
- Modify: `packages/player-web/src/runtime/video-codec-adapters/h264.ts`
- Test: `packages/format/test/h264-fixture.ts`
- Test: `packages/format/test/h264-inspector.test.ts`
- Test: `packages/format/test/h264-encoder-preparation.test.ts`
- Test: `packages/format/test/h264-truncation.test.ts`
- Test: `packages/format/test/video-codec-string.test.ts`
- Test: `packages/format/test/manifest-schema.test.ts`
- Test: `packages/format/test/public-api.test.ts`
- Test: `packages/compiler/test/video-encode-unit.test.ts`
- Test: `packages/compiler/test/video-rendition-pipeline.test.ts`
- Test: `packages/compiler/test/video-encoding-policy.test.ts`
- Test: `packages/compiler/test/discovery.test.ts`
- Test: `packages/player-web/src/runtime/video-codec-adapters.test.ts`
- Test: `packages/player-web/src/runtime/video-rendition-inspection.test.ts`
- Test: `packages/element/test/element-inputs.test.ts`
- Test: `packages/certification/test/decoder-throughput-ledger.test.ts`
- Regenerate: `fixtures/conformance/v1/{av1,vp9,h265,h264}.avl`
- Regenerate: `fixtures/conformance/v1/build.json`
- Regenerate: `fixtures/conformance/v1/provenance.json`
- Regenerate: `examples/end-user-playground/public/favorite/**`
- Regenerate: each permanent demo's H.264 asset and `build.json`
- Modify from generated source markup:
  `examples/end-user-playground/index.html`,
  `examples/grass-rabbit/index.html`, and
  `examples/kinetic-orb/index.html`
- Modify: `docs/compiler.md`

- [ ] **Step 1: Add red profile-aware format and runtime tests**

  Require `parseH264Codec()` to distinguish constrained baseline
  `avc1.42E0xx` from legacy High `avc1.6400xx` and return the exact profile id,
  compatibility byte, level, and limits. Require the parameter-set summary to
  own the inspected codec rather than reconstructing it from level alone. Add
  final-stream tests that reject baseline CABAC, B-pictures, more than one
  reference, weighted prediction, 8×8 transform, manifest/SPS disagreement,
  and non-identity presentation order. Preserve a real legacy High fixture as
  readable format-version-1.0 input, but never emit it for a new compatibility
  rendition. Exercise truncated SPS/PPS data in both grammar branches and
  exact public codec-string validation in format, player-web, and element.

- [ ] **Step 2: Add a pure minimum-level policy and its red table**

  Select from the bounded Baseline level table with integer rational
  cross-multiplication over coded dimensions, including packed-alpha height and
  H.264 crop padding. Check macroblock width/height, macroblocks per frame,
  macroblocks per second, DPB capacity for one reference, configured maximum
  bitrate, and CPB bits. Never emit Level 1b or silently exceed the table.
  Require these exact results:

  | Coded rendition | MB/frame | MB/s | Required codec |
  | --- | ---: | ---: | --- |
  | 48×112 @ 30fps | 21 | 630 | `avc1.42E00B` (Level 1.1 practical floor) |
  | 512×512 @ 24fps | 1,024 | 24,576 | `avc1.42E01E` (Level 3.0) |
  | 640×368 @ 24fps | 920 | 22,080 | `avc1.42E01E` (Level 3.0) |
  | 1280×720 @ 24fps | 3,600 | 86,400 | `avc1.42E01F` (Level 3.1) |

  The tiny geometry mathematically fits Level 1.0, but that level's 64-kbps
  ceiling is below the existing fixture's observed bitrate. Level 1.1 is the
  explicit quality-preserving production floor. Prove that 640×368 exceeds
  Level 2.2's macroblock rate, 1280×720 reaches Level 3.1 MaxFS, preset choice
  cannot alter the result, and impossible geometry fails closed. Reject H.264
  CRF 0 because Baseline cannot satisfy the current lossless contract; retain
  the existing valid ranges for the other codecs.

- [ ] **Step 3: Emit constrained-baseline streams after preset selection**

  Replace the hard-coded High profile with 8-bit 4:2:0 Constrained Baseline.
  Apply these restrictions after the preset so `medium`, `slow`, and
  `veryslow` cannot override them:

  ```text
  -profile:v baseline
  -bf 0
  -refs 1
  -level:v <derived-level>
  -maxrate <level-MaxBR>
  -bufsize <level-MaxCPB>
  -x264-params 8x8dct=0:aud=1:bframes=0:cabac=0:colorprim=bt709:colormatrix=bt709:crop-rect=...:force-cfr=1:keyint=...:min-keyint=...:open-gop=0:range=tv:ref=1:repeat-headers=1:scenecut=0:transfer=bt709:weightp=0
  ```

  Preserve one IDR at each independently decodable unit start, closed GOPs,
  exact crop, BT.709 limited range, and identity decode/presentation order.
  Encoder argument tests assert every flag and the four geometry rows. FFmpeg
  discovery/calibration and generated invocation digests must reflect the same
  policy.

- [ ] **Step 4: Canonicalize and inspect the stored Baseline contract**

  Accept a real libx264 Baseline candidate compatibility byte of `C0` only in
  encoder preparation, set the bounded `constraint_set2_flag`, and store exact
  `E0`. Final assets require `profile_idc=66`, `avc1.42E0xx`, CAVLC, no
  B-pictures, `ref=1`, no weighted prediction, and no 8×8 extension. Runtime
  configuration uses the inspector's exact profile-aware codec. Legacy
  `6400xx` stays a read-only compatibility branch.

- [ ] **Step 5: Regenerate the canonical fixture and every permanent demo**

  The end-user playground is not source-less: its public bundle mirrors the
  conformance fixture whose canonical source is
  `fixtures/compiler/v1/source/motion.json`. Rebuild that fixture in temporary
  storage, copy the four generated assets and report back into the mixed
  fixture directory, update provenance, then copy the same bundle into the
  playground. Compile the three authored examples normally. Update only the
  static pages that consume generated `sourceMarkup`; the codec chooser
  continues to consume `build.json` through its controller.

  ```bash
  npm run build:public-packages
  AVAL_H264_TMP="$(mktemp -d /tmp/aval-h264-floor.XXXXXX)"
  node packages/compiler/dist/cli.js compile \
    fixtures/compiler/v1/source/motion.json \
    --out "$AVAL_H264_TMP/bundle"
  cp "$AVAL_H264_TMP/bundle/av1.avl" fixtures/conformance/v1/av1.avl
  cp "$AVAL_H264_TMP/bundle/vp9.avl" fixtures/conformance/v1/vp9.avl
  cp "$AVAL_H264_TMP/bundle/h265.avl" fixtures/conformance/v1/h265.avl
  cp "$AVAL_H264_TMP/bundle/h264.avl" fixtures/conformance/v1/h264.avl
  cp "$AVAL_H264_TMP/bundle/build.json" fixtures/conformance/v1/build.json
  node fixtures/conformance/v1/update-provenance.mjs
  cp fixtures/conformance/v1/av1.avl examples/end-user-playground/public/favorite/av1.avl
  cp fixtures/conformance/v1/vp9.avl examples/end-user-playground/public/favorite/vp9.avl
  cp fixtures/conformance/v1/h265.avl examples/end-user-playground/public/favorite/h265.avl
  cp fixtures/conformance/v1/h264.avl examples/end-user-playground/public/favorite/h264.avl
  cp fixtures/conformance/v1/build.json examples/end-user-playground/public/favorite/build.json
  npm run compile:grass-rabbit
  npm run compile:grass-rabbit-codecs
  npm run compile:kinetic-orb
  node scripts/browser-compatibility/validate-example-assets.mjs
  npm run fixtures:verify
  ```

- [ ] **Step 6: Run focused format/compiler/runtime and browser tests**

  ```bash
  npx vitest run --config vitest.m9.config.ts \
    packages/format/test/h264-inspector.test.ts \
    packages/format/test/h264-encoder-preparation.test.ts \
    packages/format/test/h264-truncation.test.ts \
    packages/format/test/video-codec-string.test.ts \
    packages/compiler/test/video-encode-unit.test.ts \
    packages/compiler/test/video-rendition-pipeline.test.ts \
    packages/compiler/test/video-encoding-policy.test.ts \
    packages/player-web/src/runtime/video-codec-adapters.test.ts \
    packages/player-web/src/runtime/video-rendition-inspection.test.ts \
    packages/element/test/element-inputs.test.ts
  npm run test:playground
  npm run test:grass-rabbit
  npm run test:grass-rabbit-codecs
  npm run test:kinetic-orb
  ```

  Expected: new assets expose the exact constrained-baseline string required by
  each coded geometry, every direct-H.264 demo renders and transitions locally,
  and legacy High fixtures remain readable without becoming compiler output.

## Task 12: Run the complete local gate

**Files:**

- Verify all modified source, tests, fixtures, API reports, and docs

- [ ] **Step 1: Run formatting/diff safety and unit tests**

  ```bash
  git diff --check
  npm run docs:check
  npm run test:unit
  npm run typecheck
  ```

- [ ] **Step 2: Build and verify generated assets/packages**

  ```bash
  npm run build
  npm run check:generated
  npm run fixtures:verify
  npm run fixtures:regeneration-check
  npm run api:check
  node scripts/browser-compatibility/validate-example-assets.mjs
  npm run test:examples
  npm run test:consumers
  npm run test:packed
  ```

- [ ] **Step 3: Run every browser suite**

  ```bash
  npm run test:browser
  npm run test:playground
  npm run test:grass-rabbit
  npm run test:grass-rabbit-codecs
  npm run test:kinetic-orb
  npm run test:browser:reference
  npm run test:browser:production
  ```

  Expected: all supported local engines play, render nonblank/correct pixels,
  complete states, and settle with zero failures/leaks. Engines outside the
  WebCodecs support boundary raise the stable public error.

## Task 13: Certify the exact rolling 24-month branded matrix

**Files:**

- Create: the resolved immutable Task 7 run root under
  `artifacts/browser-compatibility/runs/`, keyed by the full source commit and
  UTC session id
- Update: `docs/browser-support.md`
- Update: `docs/evidence/2026-07-18-browser-compatibility.md`
- Create: `report.md` inside that exact immutable run root

- [ ] **Step 1: Run Windows 11 branded desktops**

  Use BrowserStack for Chrome 150/149/148 and Chrome 127, plus Firefox
  152/151/150 and Firefox 130. Every playback slot runs all four demos, direct
  H.264, the optional codec ladder, pointer/focus states, and a 60-second soak.
  Run Firefox 128 and 129 separately as negative WebCodecs sentinels: each demo
  must reject preparation with the same one deterministic unsupported error,
  no blank nonterminal canvas, no hang, and no leaked worker or renderer.
  Use the preflight-verified branded Brave current and boundary binaries; do
  not infer Brave from Chrome.

- [ ] **Step 2: Run current and boundary macOS desktops**

  On the current supported macOS and provider-retained macOS nearest 24 months,
  run each exact desktop Safari version exposed for that OS (26.4 on Tahoe and
  18.4 on Sequoia), Chrome and Firefox
  current/current-1/current-2, Chrome's 24-month sentinel, Firefox 130, and
  branded Brave current plus boundary. Run Firefox 128/129 only as the same
  deterministic-error sentinels. Every playback slot must run all four demos,
  direct H.264, the optional codec ladder, separate pointer and focus paths,
  every authored state in both directions, and a 60-second soak. Record exact
  versions; Playwright engine results are not branded certification.

- [ ] **Step 3: Run real iPhones and Android/Samsung devices**

  Run the policy-pinned real-device slots: iPhone 17 / iOS Safari 26.5, 26.4,
  and 26.0 plus iPhone 16 / iOS Safari 18.6; Pixel / Android 17 Chrome, Pixel /
  Android 16 Chrome, and Galaxy S25 / Android 15 Chrome. Record the full
  installed Chrome product version in each Android session; an OS label or
  moving browser alias is insufficient. If the provider changes a device's
  installed Chrome after inventory, update and commit the policy and start a
  new immutable run rather than silently substituting it. Every one of these
  seven slots runs all four demos, a forced direct-H.264 pass, the full
  AV1→VP9→HEVC→H.264 ladder pass, real tap/outside/overlap/re-entry, every
  authored state in both directions, opaque and packed-alpha pixel witnesses,
  and 60 seconds of post-ready lifecycle evidence.

- [ ] **Step 4: Validate every artifact**

  ```bash
  node scripts/browser-compatibility/validate-evidence.mjs "$RUN_ROOT"
  ```

  Expected: no missing slot, screenshot/JSON pair, state transition, codec
  witness, soak interval, exact version, or branded Brave run.

- [ ] **Step 5: Publish only evidence-backed support**

  Update `docs/browser-support.md` and the final report with exact pass/fail
  versions, devices, selected codec, optional-codec qualification, backend, and
  state/soak outcome. The report records the resolved full commit and UTC
  session id and links only to that immutable run. Correct the older document
  that described Kinetic iOS H.264 as passed after only initial readiness.
  Systems older than the rolling window are documented only as informational;
  if run, their required outcome is either full success or one deterministic
  consumer-owned error.

- [ ] **Step 6: Completion audit**

  Completion requires all of the following, with no exception hidden by codec
  fallback:

  - every in-policy Windows, macOS, iOS, and Android slot has exact branded
    evidence;
  - all four demos show correct nonblank pixels and every authored state;
  - direct constrained-baseline H.264 works in every playback-certified slot
    at the Firefox 130+ primitive floor; Firefox 128/129 instead pass only by
    producing the specified deterministic unsupported error;
  - optional source selection follows AV1 → VP9 → HEVC → H.264 and
    switches only before interactive readiness for a proven codec/output cause;
  - packed alpha is visually correct;
  - 60-second loop/state witnesses have advancing counters and no failure;
  - unsupported/out-of-policy failure publishes one stable error and leaves no
    AVAL-owned fallback or leaked resource; and
  - the final evidence validator, full test suite, build, typecheck, fixtures,
    API, generated-example validator, and docs checks all pass.
