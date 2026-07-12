# M5.5 Integrated Scheduler and Readiness Implementation Plan

**Date:** 2026-07-12

**Design:** [M5.5 Integrated Scheduler and Readiness Design](../specs/2026-07-12-m55-integrated-scheduler-readiness-design.md)

## Outcome

Integrate the validated M4 asset, M3 graph, M5 opaque AVC worker, bounded
resident/streaming rendering, all-routes readiness, and host-side
effect/promise settlement in `@rendered-motion/player-web`. Prove every direct
route with deterministic fakes and a real compiled-AVC browser fixture, while
keeping alpha, network loading, shared budgets, the custom element, and device
certification in M6–M9.

M5 must be fully gated and committed before this plan begins. M5.5 is one later
intentional milestone commit after its complete gate passes.

## Engineering Rules

- Write a failing focused test before each production slice.
- Keep graph behavior in `@rendered-motion/graph`, container/AVC behavior in
  `@rendered-motion/format`, and scheduling/readiness in `player-web`.
- Reuse the M5 worker protocol unchanged unless a test proves an impossible
  integration; do not move scheduler policy into the worker.
- Use the existing `routeReady` graph handshake. Do not fork the graph reducer.
- Use one decode clock, one rendition-order function, one resource planner,
  one submission-horizon planner, and one staged effect/promise host.
- Treat every byte count, pixel product, ordinal, timestamp, layer, ring slot,
  and wait-frame calculation as hostile checked input.
- Transfer only fresh access-unit buffers. Close every `VideoFrame` exactly
  once on success, supersession, error, abort, and disposal.
- Keep production modules focused. No scheduler, player, or readiness file may
  become a catch-all owner for parsing, rendering, promises, and diagnostics.
- Preserve M0–M5 tests and public compile contracts. Compatibility re-exports
  are preferable to duplicating experimental primitives.
- Do not add M6 alpha/PNG-hardening, M7 networking/shared budgets, M8 DOM
  element/bindings, or M9 certification behavior.
- Do not commit generated `dist`, local browser/tool caches, temporary assets,
  absolute-path reports, or raw timing traces.

## Execution Order

### 1. Add the runtime package boundary and stable internal model

Update:

```text
packages/player-web/package.json
packages/player-web/tsconfig.json
packages/player-web/src/index.ts
```

Add:

```text
packages/player-web/src/runtime/errors.ts
packages/player-web/src/runtime/model.ts
packages/player-web/src/runtime/public-api.compile.ts
packages/player-web/src/runtime/model.test.ts
```

Add a direct `@rendered-motion/graph` dependency and project reference. Define
immutable internal types for readiness levels/results, candidate reports,
runtime frame keys, media presentations, scheduler snapshots, trace records,
static reasons, and normalized runtime failures.

Freeze the runtime readiness ladder as `unready -> metadataReady ->
visualReady -> interactiveReady|staticReady`, plus disposed/error. Test the
explicit mapping from M3 graph `preparing/animated/static` so graph readiness
effects are translated once and metadata/visual changes remain owned by
player-web.

The runtime error boundary distinguishes invalid asset, unsupported profile,
resource rejection, readiness failure, worker/decode failure, renderer
failure, watchdog, underflow, abort, and disposed state. Messages are bounded;
untrusted IDs remain structured fields.

Use the design's exact eight-value `StaticReason` union and deterministic
summary precedence. Freeze `RUNTIME_TRACE_CAPACITY` at 512.

The compile-only test permits only intended graph/format/worker types through
the runtime boundary and confirms that browser runtime modules do not import
Node APIs.

Run:

```text
npx vitest run packages/player-web/src/runtime/model.test.ts
npm run typecheck -w @rendered-motion/player-web
```

### 2. Implement the owned validated asset catalog

Add:

```text
packages/player-web/src/runtime/asset-catalog.ts
packages/player-web/src/runtime/asset-catalog.test.ts
```

Test first:

- caller mutation after installation cannot change catalog bytes;
- complete validation runs against the owned copy;
- rendition/unit/state/edge/port/static maps are immutable and exact;
- every `(rendition, unit, frame)` resolves to the M4 record and bounded bytes;
- static IDs resolve to exact PNG ranges;
- fresh sample buffers neither alias nor detach catalog storage;
- sparse/unknown lookups return a typed runtime error;
- offset/length arithmetic never leaks a built-in exception; and
- disposal releases catalog references and rejects later reads.

Use `validateCompleteAsset()` as the only container authority. Do not
revalidate manifest relations or reconstruct canonical record order.

Run:

```text
npx vitest run packages/player-web/src/runtime/asset-catalog.test.ts
```

### 3. Freeze deterministic rendition selection and strict inspection

Add:

```text
packages/player-web/src/runtime/rendition-selection.ts
packages/player-web/src/runtime/rendition-selection.test.ts
```

Implement one pure candidate function that:

1. retains only exact `avc-annexb-opaque-v0` / `avc1.42E020` WebCodecs+WebGL2
   renditions;
2. sorts descending coded pixel area;
3. sorts equal areas by descending peak bitrate; and
4. sorts the remaining tie by canonical ASCII rendition ID.

Before a candidate reaches a worker, assemble its validated unit views and
call format's public `inspectAvcAnnexBRendition()` over every unit. Preserve
format error context while normalizing the runtime category. Do not create a
second Annex B parser.

Tests cover input-order independence, safe area arithmetic, all ties, mixed
profiles, no candidate, strict inspector failure, and immutable reports.

Run:

```text
npx vitest run packages/player-web/src/runtime/rendition-selection.test.ts
```

### 4. Promote the rational clock and add decode timeline ownership

Add or promote:

```text
packages/player-web/src/runtime/rational-time.ts
packages/player-web/src/runtime/decode-timeline.ts
packages/player-web/src/runtime/decode-timeline.test.ts
```

Keep:

```text
packages/player-web/src/experimental/rational-time.ts
```

as a compatibility re-export so M1/M2 imports and tests continue using the
same implementation.

`DecodeTimeline` owns:

- the globally increasing safe worker ordinal;
- exact rounded timestamp and adjacent duration;
- positive increasing generation numbers;
- a unit-instance counter reset per generation; and
- immutable sample metadata construction.

It never owns bytes or submits work. Tests cover `30000/1001`, 24/30/60 fps,
long-run nonaccumulating timestamps, safe-integer edges, generation reset,
unit occurrence order, and no duplicate timestamps.

Run:

```text
npx vitest run packages/player-web/src/runtime/decode-timeline.test.ts packages/player-web/src/experimental/rational-time.test.ts
```

### 5. Build the sole worker sample factory

Add:

```text
packages/player-web/src/runtime/worker-samples.ts
packages/player-web/src/runtime/worker-samples.test.ts
```

Combine catalog access with `DecodeTimeline` to create closed
`DecoderWorkerSample` batches. Derive key type from the validated record while
the worker independently derives and checks it from AVC.

The factory must:

- begin every occurrence at unit frame zero;
- preserve complete contiguous occurrence grammar;
- allocate one distinct exact-length `ArrayBuffer` per sample;
- respect worker batch/sample/outstanding limits before allocation;
- advance timeline state only after the full batch validates; and
- leave catalog bytes intact after transfer simulation.

Test atomic failure, detached buffers, hostile record lengths, batches crossing
complete unit boundaries, loop occurrences, and generation changes.

Run:

```text
npx vitest run packages/player-web/src/runtime/worker-samples.test.ts
```

### 6. Implement the generalized interaction-cache plan

Add:

```text
packages/player-web/src/runtime/interaction-cache-plan.ts
packages/player-web/src/runtime/interaction-cache-plan.test.ts
packages/player-web/src/runtime/checked-runtime-bytes.ts
```

The planner expands and deduplicates:

- complete reversible clips;
- both declared reversible endpoint runways; and
- every cut-target runway.

It records semantic sequences separately from unique layers. Loop runways wrap;
finite runways advance then reuse their held final layer. Deduplication uses
only `(rendition, unit, localFrame)`.

Enforce the 24-frame/24 MiB reversible cap, 48 MiB endpoint-pair cap, 128-layer
cap, device texture limits, selected coded geometry, and safe arithmetic.

Refactor shared constants/layer registration from
`experimental/resident-frame-plan.ts` into this owner or make the M2 function a
thin compatibility adapter. Do not leave two independent implementations of
the same layer and byte rules.

Tests cover multiple reversible edges, shared body-port/cut layers, repeated
held layers, short loop wrap, zero persistent layers, maximum boundaries,
device rejection, and traversal-order determinism.

Run:

```text
npx vitest run packages/player-web/src/runtime/interaction-cache-plan.test.ts packages/player-web/src/experimental/resident-frame-plan.test.ts
```

### 7. Implement exact runtime resource accounting

Add:

```text
packages/player-web/src/runtime/resource-plan.ts
packages/player-web/src/runtime/resource-plan.test.ts
```

Calculate the frozen per-candidate steady-state plan from actual catalog and
device data:

- complete owned asset bytes;
- maximum actual encoded bytes in one legal outstanding window;
- twelve potential submitted/output/leased decoded surfaces, with the final
  6–12-frame ring treated as a subset rather than charged again;
- persistent layers plus rounded-up 25% GPU overhead;
- three streaming layers plus overhead;
- one staging surface sized to `max(coded animation, logical static)`; and
- two logical static swap surfaces plus 25% allocation overhead.

The effective cap is `min(64 MiB, manifest.maxRuntimeBytes, hostPolicy)`. Assert
that manifest estimates do not authorize memory. Keep page-wide accounting out
of this module.

Use table-driven exact-boundary tests, multiplication/addition overflow tests,
shared static IDs, largest access-unit windows, and adversarial manifest
estimates.

Run:

```text
npx vitest run packages/player-web/src/runtime/resource-plan.test.ts
```

### 8. Promote and generalize the opaque renderer

Add or promote:

```text
packages/player-web/src/runtime/opaque-frame-renderer.ts
packages/player-web/src/runtime/opaque-frame-renderer.test.ts
```

Keep `experimental/webgl-frame-renderer.ts` as a compatibility re-export or
thin adapter, preserving M2 public names and tests.

Generalize allocation to the full cache plan and allow zero resident layers
without allocating an invalid texture array. Keep exactly three versioned
streaming slots, one staging buffer, RGBA8 uploads, close-once upload
ownership, stale resource generations, context-loss terminalization for this
milestone, and idempotent disposal.

Separate coded texture geometry from logical canvas/viewport geometry so a
lower rendition scales to the manifest canvas without changing graph state.

The fake backend tests cover every allocation/upload/draw/error path. Existing
M2 renderer tests remain green. Alpha sampling, packed geometry, and blending
are not added.

Run:

```text
npx vitest run packages/player-web/src/runtime/opaque-frame-renderer.test.ts packages/player-web/src/experimental/webgl-frame-renderer.test.ts
```

### 9. Add the bounded static-surface store

Add:

```text
packages/player-web/src/runtime/static-surfaces.ts
packages/player-web/src/runtime/static-surfaces.test.ts
```

Define an injectable adapter that decodes catalog PNG blobs sequentially,
checks exact logical dimensions, deduplicates shared static IDs, accounts RGBA
surface bytes, and closes each noncurrent validation probe. It retains only the
current surface plus at most one incoming replacement, draws on an independent
host-supplied static presentation plane, covers/reveals the animated plane
atomically, and closes replaced surfaces. It must remain usable after the
animated WebGL context or worker fails.

The browser adapter may use browser image decoding after M4 shallow envelope
validation. It must not claim independent PNG CRC/inflate/filter conformance or
construct the M8 custom element. The fake adapter tests visual-ready
installation, all-state static-ready, shared IDs, atomic plane switching,
on-demand re-decode of an already-validated state, the two-surface bound,
WebGL-independent recovery, decode/draw failure, abort, supersession, and
disposal.

Run:

```text
npx vitest run packages/player-web/src/runtime/static-surfaces.test.ts
```

### 10. Prepare persistent frames through the M5 worker

Add:

```text
packages/player-web/src/runtime/interaction-cache-preparation.ts
packages/player-web/src/runtime/interaction-cache-preparation.test.ts
```

Use `DecoderWorkerClient`, the sample factory, and the opaque renderer. Decode
required units in forward dependency order. Upload only planned frames; close
unplanned dependency outputs. Release credit after every upload and bound the
operation by signal/timeout.

One preparation generation may contain multiple complete independent unit
occurrences. No reset or flush is introduced. Reports include submitted,
decoded, uploaded, dependency-closed, stale, and released counts.

Test multi-edge deduplication, long prefixes under credit, transfer/upload
failure, unexpected output identity, cancellation at every await, generation
supersession, and zero surviving `VideoFrame`s.

Run:

```text
npx vitest run packages/player-web/src/runtime/interaction-cache-preparation.test.ts packages/player-web/src/decoder-worker/decoder-worker.test.ts
```

### 11. Implement the presentation ring

Add:

```text
packages/player-web/src/runtime/presentation-ring.ts
packages/player-web/src/runtime/presentation-ring.test.ts
```

The ring owns close-once managed frames in strict active-path FIFO order. It
validates generation, unit occurrence/frame, decode ordinal/timestamp, and
intended presentation ordinal on insertion and removal.

Capacity is 6–12 and immutable after candidate readiness. Support draining one
entry to renderer ownership, closing a stale generation, clearing on recovery,
and immutable snapshots. Never inspect worker `decodeQueueSize` for ring
readiness.

Tests cover full/empty bounds, stale outputs, duplicate identity, wrong order,
renderer transfer, close races, clear/dispose, and no double credit release.

Run:

```text
npx vitest run packages/player-web/src/runtime/presentation-ring.test.ts
```

### 12. Implement pure source-horizon and edge-lead planning

Add:

```text
packages/player-web/src/runtime/submission-horizon.ts
packages/player-web/src/runtime/edge-lead.ts
packages/player-web/src/runtime/submission-horizon.test.ts
packages/player-web/src/runtime/edge-lead.test.ts
```

Keep this layer platform-free. Given validated manifest/graph metadata,
displayed/submitted cursors, selected edge, ring capacity, and measured lead,
it returns one immutable decision:

- continue the source body;
- select a specific later portal;
- wait/hold a finite boundary;
- commit a prepared edge;
- restart a generation; or
- reject candidate readiness with a bounded reason.

Test every source frame of loop, finite, and held bodies; multiple portals;
submitted work past an early portal; exact `maxWaitFrames`; finish;
transitionless lead; bridges shorter/equal/longer than the ring; and the
one-frame bridge plus target frame zero. The pure planner must match M3 graph
golden portal/finish behavior without choosing a route itself.

Run:

```text
npx vitest run packages/player-web/src/runtime/submission-horizon.test.ts packages/player-web/src/runtime/edge-lead.test.ts packages/graph/test/portal-search.test.ts
```

### 13. Implement active-path submission and worker pumping

Add:

```text
packages/player-web/src/runtime/path-scheduler.ts
packages/player-web/src/runtime/path-scheduler.test.ts
```

Compose the timeline, sample factory, worker client, ring, horizon planner, and
renderer-facing media identity. The scheduler owns:

- active generation and unit occurrences;
- source/bridge/target sequential path construction;
- bounded worker credit requests;
- ring fill/maintenance;
- loop occurrence submission;
- branch replacement and stale generation disposal;
- resident runway to streamed continuation handoff; and
- exact scheduler traces.

It does not own a graph engine or promises. Tests use a fake worker with
controllable output latency and cover continuous loops, source horizon,
pending branch replacement, locked path completion, target continuation,
generation retirement, watchdog, and cleanup.

Run:

```text
npx vitest run packages/player-web/src/runtime/path-scheduler.test.ts
```

### 14. Implement readiness measurement statistics

Add:

```text
packages/player-web/src/runtime/readiness-metrics.ts
packages/player-web/src/runtime/readiness-metrics.test.ts
```

Implement the frozen M5.5 constants and exact calculations:

- at least 24 measured outputs;
- nearest-rank p99;
- `decodeLeadFrames = ceil(p99 / frameDuration) + 1`;
- 6–12 ring selection with one extra margin;
- at least 1.5× real-time output throughput;
- per-frame ideal deadline and actual output/upload-ready time;
- rolling minimum lead; and
- one-frame recovery margin.

All clocks are injected and validated monotonic. Tests cover ties, zero/very
fast elapsed intervals, exact 1.5× boundary, p99 rank, fractional rational
rates, upload slower than decode, lead 11/12 rejection boundary, and immutable
reports.

Run:

```text
npx vitest run packages/player-web/src/runtime/readiness-metrics.test.ts
```

### 15. Implement all-routes readiness evaluation

Add:

```text
packages/player-web/src/runtime/readiness-evaluator.ts
packages/player-web/src/runtime/readiness-evaluator.test.ts
packages/player-web/src/runtime/readiness-runner.ts
packages/player-web/src/runtime/readiness-runner.test.ts
```

The evaluator is pure. It enumerates every manifest edge and every valid source
body frame, applies the same horizon/lead planner, and verifies start-policy
waits. It also consumes measured reports for:

- loop warm-up/headroom;
- full nonresident bridge plus adaptive 6–12 target ticks;
- cut continuation within its target runway;
- both reversible endpoint recoveries;
- pending cancellation/replacement phases;
- locked follow-ons; and
- active inverse response in one tick.

The runner drives real/fake worker output and renderer uploads to produce those
measurements. `bootstrapUnits` and `immediateEdges` affect startup order only;
they never reduce the edge set.

Create a fixture matrix where exactly one route, one endpoint, one cut, one
loop, or one resource term fails. Every case must reject interactive readiness
for the candidate. No partial ready result exists.

Run:

```text
npx vitest run packages/player-web/src/runtime/readiness-metrics.test.ts packages/player-web/src/runtime/readiness-evaluator.test.ts packages/player-web/src/runtime/readiness-runner.test.ts
```

### 16. Add staged property/effect and promise hosting

Add:

```text
packages/player-web/src/runtime/effect-host.ts
packages/player-web/src/runtime/effect-host.test.ts
packages/player-web/src/runtime/request-promises.ts
packages/player-web/src/runtime/request-promises.test.ts
```

`EffectHost` owns the exposed mirror for readiness, requested state, visual
state, transitioning state, and bounded event trace. It processes graph
effects around an injected draw barrier:

1. apply pre-draw effects and update their mirror fields;
2. draw exactly one prepared presentation;
3. apply visual/end effects after the draw; and
4. queue settlements for the following microtask.

`RequestPromises` maps graph request IDs to close-once capabilities, supports
joined groups through graph settlement IDs, and aborts every remaining promise
on disposal.

Tests assert getter values inside every listener, draw order for bridge/cut/
static commits, stable no-op microtasks, joined destination promises,
supersession `AbortError`, static recovery, fallback failure, duplicate settle
rejection, graph-to-runtime readiness translation without duplicate events,
and final mirror equality with each graph result snapshot.

Run:

```text
npx vitest run packages/player-web/src/runtime/effect-host.test.ts packages/player-web/src/runtime/request-promises.test.ts packages/graph/test/engine-golden.test.ts
```

### 17. Build the integrated player's installation and preparation lifecycle

Add:

```text
packages/player-web/src/runtime/integrated-player.ts
packages/player-web/src/runtime/integrated-player-preparation.test.ts
```

The internal player constructor/factory accepts owned bytes, canvas/renderer
adapters, worker factory, static store, clocks, optional lower resource policy,
and diagnostics sink. It:

- installs the validated graph and staged preparing state;
- draws the initial static surface;
- accepts/coalesces graph requests during preparation;
- joins concurrent `prepare()` calls;
- tries candidates in frozen order, one worker at a time;
- disposes a failed candidate completely;
- resolves animated only after caches, all routes, and initial ring pass; and
- otherwise calls `beginStatic` and resolves a bounded static result.

Test higher unsupported/lower supported selection, higher resource/readiness
failure, candidate cleanup before retry, no candidate, timeout to static after
static readiness, timeout before static readiness as `PlaybackFallbackError`,
abort/retry, intro play/skip, prepared latest request, and no fallback event for
an intermediate candidate failure.

Run:

```text
npx vitest run packages/player-web/src/runtime/integrated-player-preparation.test.ts
```

### 18. Integrate body, portal, finish, transitionless, and locked playback

Add:

```text
packages/player-web/src/runtime/integrated-player-paths.test.ts
packages/player-web/src/runtime/integrated-trace-harness.ts
```

Implement content-tick coordination between the graph, scheduler, renderer,
effect host, and promises. Before each graph tick, require the exact expected
media handle. Pass only the scheduler's `routeReady` result. Assert graph
presentation identity before drawing.

Golden traces cover:

- intro into body frame zero;
- continuous loop seams;
- portal at first and later eligible markers;
- finite portal and already-held wait;
- finish from every finite phase;
- transitionless target frame zero;
- one-frame and long locked bridges;
- completion-triggered routes;
- locked intermediate follow-on; and
- rapid latest-wins replacement.

For every case compare graph, submission, output, draw, property/effect, and
promise traces.

Run:

```text
npx vitest run packages/player-web/src/runtime/integrated-player-paths.test.ts packages/graph/test/engine-transitions.test.ts
```

### 19. Integrate cut presentation and recovery

Add:

```text
packages/player-web/src/runtime/integrated-player-cut.test.ts
```

On a cut request, activate the newer generation, close obsolete streaming
frames, draw resident target frame zero on the next content tick, commit graph
visual state only after draw, present the target runway, discard decoded
duplicate runway frames, and join the first continuation at the exact runway
length.

Tests cover cut from every source frame, shared target runways, one-tick bound,
generation monotonicity, stale output, continuation before/at/after runway end,
resource failure, superseding requests, static recovery, and zero reset/flush.

Run:

```text
npx vitest run packages/player-web/src/runtime/integrated-player-cut.test.ts
```

### 20. Integrate resident reversible presentation and recovery

Add:

```text
packages/player-web/src/runtime/integrated-player-reversible.test.ts
```

Start reversible edges only through their stable-body portal/finish policy.
Once active, draw the resident clip. An inverse request changes to the adjacent
cached layer on the next eligible tick. Completion selects the correct endpoint
runway and starts a newer continuation generation.

Tests cover forward/reverse entry, reversal at every interior frame, endpoint
reversal, repeated direction changes, duplicate destination joining, invalid
follow-ons, source/target recovery boundaries, stale worker output, resident
handle validity after all source frames close, and no decoder work during the
visible clip itself.

Reuse M2 trace expectations where semantics match, but drive the M3 graph and
M5 worker adapters rather than the M2 controller/player.

Run:

```text
npx vitest run packages/player-web/src/runtime/integrated-player-reversible.test.ts packages/player-web/src/experimental/resident-reversible-player.test.ts
```

### 21. Add realtime driving and observable underflow

Add:

```text
packages/player-web/src/runtime/realtime-driver.ts
packages/player-web/src/runtime/realtime-driver.test.ts
```

Use the rational presentation clock and injected animation-frame source.
Repeated display callbacks below the next content deadline do nothing. At an
eligible deadline, advance only when the exact next media handle exists.

On absence, retain the canvas, do not tick the graph, emit one underflow for
that missed content tick, withdraw the session smoothness flag, and continue
pumping. Tests cover 24/30/60 fps on 60/120 Hz callbacks, late callbacks,
recovery after a missing frame, no duplicate content IDs, clock freeze on
underflow, and callback cancellation on disposal.

Manual `tickOnce()` remains a test/proof adapter over the same integrated tick
path. Do not add the M8 public pause/autoplay API or M7 visibility policy.

In the browser proof, retain RAF opportunity timestamps, post-draw canvas
submission timestamps, and callback-to-draw latency as separate evidence.
Grade visible submission cadence from the post-draw timestamps and grade RAF
host health independently. Do not add synchronous framebuffer readback to the
realtime cadence callback; exact pixels are already covered by the separate
deterministic boundary-readback drive.

Run:

```text
npx vitest run packages/player-web/src/runtime/realtime-driver.test.ts packages/player-web/src/experimental/loop-canvas-player.test.ts
```

### 22. Complete failure, static recovery, and disposal

Add:

```text
packages/player-web/src/runtime/integrated-player-recovery.test.ts
packages/player-web/src/runtime/integrated-player-disposal.test.ts
```

Normalize fatal worker/decoder/upload/renderer failures into the design's
static-recovery sequence. Freeze content, retain pixels, close animated
resources, install the newest requested static surface, call `recoverStatic`,
stage fallback/transition/draw/visual/end effects, and settle in a microtask.

If static install fails, call `failStatic` and reject with
`PlaybackFallbackError`. Keep later static state requests usable after a
successful recovery.

Exercise failure and abort at every async phase, pending branch, bridge frame,
cut runway, reversible frame, upload, microtask settlement, and disposal step.
Assert idempotent final cleanup: no managed/open frame, worker request/waiter,
ring entry, texture/static surface, animation callback, timer, abort listener,
or unresolved promise.

Run:

```text
npx vitest run packages/player-web/src/runtime/integrated-player-recovery.test.ts packages/player-web/src/runtime/integrated-player-disposal.test.ts packages/player-web/src/decoder-worker/decoder-worker.test.ts
```

### 23. Add seeded integrated trace/property tests

Add:

```text
packages/player-web/src/runtime/integrated-player-fuzz.test.ts
```

Generate bounded valid request/event/tick/output/failure traces over an
all-policy graph. Vary output latency, batch boundaries, portal phase, pending
replacement, locked follow-on, reversible direction, cut generation, and
underflow.

Invariants include:

- graph/submission/output/draw identity agreement;
- latest accepted reachable target convergence;
- no draw without a matching graph presentation;
- no visual commit before target draw;
- no settlement before its graph effect/microtask;
- no advancing duplicate at a unit boundary;
- bounded input/route operations, ring, credit, layers, bytes, and traces;
- monotonic generation/ordinal/timestamp; and
- exact close/release accounting after disposal.

Persist only fixed seeds and minimal failure descriptions, never raw frame
objects or asset bytes.

Run:

```text
npx vitest run packages/player-web/src/runtime/integrated-player-fuzz.test.ts
```

### 24. Create compiler-backed M5.5 conformance fixtures

Add:

```text
fixtures/compiler/m55/source/
  generate.mjs
  all-routes.json
  frames/
  ASSET-LICENSE.md
fixtures/conformance/m55/
  opaque-all-routes.rma
  provenance.json
  README.md
packages/compiler/test/m55-fixture.test.ts
```

Use deterministic generated opaque PNGs with error-tolerant frame tags. The
project includes two opaque renditions and covers intro, loops, finite/held,
reversible inverse edges, both endpoint runways, portal, finish, transitionless,
one-frame locked bridge, cut runway, and locked follow-on.

Compile twice with the recorded M5 toolchain and require byte identity. Strictly
inspect every unit, validate the complete asset, verify all internal digests
with compiler tooling, and record source/project/unit/static/asset/tool hashes.
No absolute path enters provenance.

The fixture test checks that every M5.5 policy is actually represented; a
fixture missing one route class fails rather than weakening browser coverage.

Run:

```text
npx vitest run packages/compiler/test/m55-fixture.test.ts
npm run rma -- validate fixtures/conformance/m55/opaque-all-routes.rma
```

### 25. Add the real-browser integrated proof

Add:

```text
apps/playground/src/m55-integrated-proof.ts
tests/browser/m55-integrated-scheduler.spec.ts
```

The proof module has no product UI. It loads the checked-in fixture, creates
the real module worker, static store, and WebGL2 renderer, prepares the
integrated player, executes a deterministic manual content-tick script, and
publishes one frozen result for Playwright.

The browser test asserts:

- exact AVC support or explicit unsupported status without VP8 substitution;
- selected rendition follows area/peak/ID ordering;
- all-routes interactive readiness and bounded measurements;
- intro/body and continuous loop order;
- portal and finish wait bounds;
- one-frame bridge then target frame zero;
- cut frame zero from resident cache on the next tick;
- adjacent cached active reversal on the next tick;
- source and target endpoint continuation before runway end;
- locked follow-on/latest-wins convergence;
- staged getter/effect/draw/promise order;
- tolerant GPU frame-tag readback at every boundary;
- induced worker failure commits the requested static frame;
- selected-worker configure count one and reset/flush/boundary-flush zero; and
- complete frame/worker/GL/static/callback/promise cleanup.

Use a per-test timeout proportionate to real preparation without weakening any
readiness watchdog. If bundled Chromium lacks exact AVC, record unsupported;
the milestone evidence still requires one supported real-browser run.

Run:

```text
npx playwright test tests/browser/m55-integrated-scheduler.spec.ts --project=chromium
```

### 26. Run the full gate, audit, and record evidence

Run focused suites first, then:

```text
npm run typecheck
npm run test:unit
npm run build
npm run test:browser
npm audit --audit-level=high
npm pack --dry-run -w @rendered-motion/graph
npm pack --dry-run -w @rendered-motion/format
npm pack --dry-run -w @rendered-motion/compiler
npm pack --dry-run -w @rendered-motion/player-web
git diff --check
```

Run one supported headed browser proof and record exact browser, OS,
architecture, codec result, selected rendition, fixture digest, readiness
statistics, resource plan, and trace summary. Unsupported bundled Chromium is
reported separately and never promoted.

Perform a strict read-only architecture and maintainability audit. Fix every
P0/P1 issue without weakening tests. The audit explicitly checks:

- one graph owner and no route fork in player-web;
- one format/record/AVC authority;
- one decode timeline and sample factory;
- one rendition sort;
- one interaction/resource planner;
- one horizon/lead planner used by readiness and playback;
- one effect/promise host;
- worker remains scheduler-free;
- all ownership and cleanup paths are bounded; and
- no alpha, network loader, shared manager, custom element, or certification
  implementation entered M5.5.

Add:

```text
docs/evidence/2026-07-12-m55-integrated-scheduler-readiness.md
```

Record exact unit/property/browser counts, fixture/tool/browser hashes,
candidate attempts, byte-determinism, cache/resource plans, warm-up and edge
readiness metrics, graph/submission/presentation/effect/settlement trace
agreement, worker operation counts, underflow/fallback results, cleanup
evidence, package/audit results, and M5.5 versus M6–M9 claim boundaries.

Commit the implementation only after every gate and audit passes. Exclude
`dist`, temporary generated media, machine-specific raw traces, absolute-path
reports, and unrelated worktree changes.

## Planned Production Files

```text
packages/player-web/src/runtime/
  errors.ts
  model.ts
  asset-catalog.ts
  rendition-selection.ts
  rational-time.ts
  decode-timeline.ts
  worker-samples.ts
  checked-runtime-bytes.ts
  interaction-cache-plan.ts
  resource-plan.ts
  opaque-frame-renderer.ts
  static-surfaces.ts
  interaction-cache-preparation.ts
  presentation-ring.ts
  edge-lead.ts
  submission-horizon.ts
  path-scheduler.ts
  readiness-metrics.ts
  readiness-evaluator.ts
  readiness-runner.ts
  request-promises.ts
  effect-host.ts
  realtime-driver.ts
  integrated-player.ts
  integrated-trace-harness.ts
```

Existing experimental files remain compatibility adapters where needed; they
must not retain independent copies of promoted clock, resource, or renderer
rules.

## Planned Test and Evidence Files

```text
packages/player-web/src/runtime/*.test.ts
packages/player-web/src/runtime/public-api.compile.ts
packages/compiler/test/m55-fixture.test.ts
fixtures/compiler/m55/source/
fixtures/conformance/m55/
apps/playground/src/m55-integrated-proof.ts
tests/browser/m55-integrated-scheduler.spec.ts
docs/evidence/2026-07-12-m55-integrated-scheduler-readiness.md
```

## Final Claim

Passing M5.5 proves that one completely resident opaque compiled asset can be
prepared under an all-routes policy and scheduled through the real web decoder
path with deterministic graph semantics, bounded media lead, resident cuts and
reversals, exact effect/promise ordering, and static recovery.

It does not prove transparency, strict independent PNG decoding, network or
publisher integrity, shared multi-player lifecycle, the public element, or
named-device/observed-display certification.
