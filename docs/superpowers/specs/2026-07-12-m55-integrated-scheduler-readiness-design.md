# M5.5 Integrated Scheduler and Readiness Design

**Date:** 2026-07-12

**Status:** Approved for implementation

**Authority:**

- [Web Rendered Motion Format Design](2026-07-11-web-rendered-motion-format-design.md)
- [Web Rendered Motion Implementation Plan](../plans/2026-07-11-web-rendered-motion-implementation.md)
- [M3 Deterministic Graph Design](2026-07-11-m3-deterministic-graph-design.md)
- [M4 Minimal Compiled Format Design](2026-07-11-m4-minimal-compiled-format-design.md)
- [M5 Opaque AVC Compiler and Dedicated Worker Design](2026-07-11-m5-opaque-avc-compiler-worker-design.md)

## 1. Outcome and Claim Boundary

M5.5 is the first integrated opaque playback milestone. It joins the validated
M4 container, the M3 deterministic graph, the M5 dedicated decoder worker, a
bounded presentation ring, persistent interaction caches, an opaque WebGL2
renderer, measured readiness, and host-side promise/effect settlement.

For one completely resident compiled asset, M5.5 proves that every declared
direct route can be prepared and presented without seeking, decoder
reconfiguration, reset, flush, or an invented transition. It covers:

- continuous body loops and initial one-shots;
- looping, finite, and held source bodies;
- portal, finish, and cut start policies;
- transitionless and locked bridge edges;
- resident reversible edges and adjacent-frame active reversal;
- source-submission horizons and edge-specific presentation lead;
- generation-based disposal of obsolete decoder output;
- all-routes readiness and deterministic rendition fallback;
- graph property, effect, event, and promise ordering; and
- recoverable animation failure into the newest accepted static state.

M5.5 remains an opaque, in-memory, single-player integration milestone. It
does not claim packed alpha, independent full PNG conformance, network range
loading, runtime digest authentication, shared page-wide resource management,
the public custom element, automatic DOM engagement bindings, or named-device
performance certification. Those remain M6 through M9.

## 2. Package Authority and Dependencies

The existing packages keep their current authority:

```text
@rendered-motion/graph
  owns graph validation, authored cursors, routing, effects, and settlements

@rendered-motion/format
  owns container bytes, manifest validity, record/range relations, and AVC syntax

@rendered-motion/player-web
  owns rendition choice, decoded resources, readiness, scheduling, rendering,
  host promises/events, failure recovery, and lifecycle
```

`@rendered-motion/player-web` gains a direct production dependency and
TypeScript project reference on `@rendered-motion/graph`. Depending on graph
only through format would hide a real runtime dependency.

M5.5 does not create a second graph reducer, container validator, Annex B
parser, or decoder state machine. The runtime consumes:

- `validateCompleteAsset()` and its `ValidatedAssetLayout`;
- `ParsedFrontIndex.manifest`, `.graph`, `.records`, unit blob ranges, and
  static blob ranges;
- `MotionGraphEngine` and its existing `routeReady` tick handshake;
- `DecoderWorkerClient` configure, generation, submit, wait, frame, metrics,
  and dispose operations; and
- the M2 rational-time and opaque WebGL experiments after promoting or
  generalizing their useful primitives.

The M5 worker remains a bounded sequential decoder. It never receives a graph,
chooses a portal, computes readiness, owns a presentation clock, caches a
resident frame, or dispatches a host event.

## 3. Runtime Architecture

The integration is split into independently testable owners:

```text
owned complete asset bytes
          |
          v
validated asset catalog ----> deterministic rendition candidates
          |                              |
          |                              v
          |                     one configured worker
          |                              |
          v                              v
interaction-cache plan ------> resident cache preparation
          |                              |
          +---------------+--------------+
                          v
                 all-routes readiness
                          |
                          v
MotionGraphEngine <-> submission/path scheduler <-> presentation ring
                          |                         |
                          v                         v
                    worker generations       opaque renderer
                          \                         /
                           \                       /
                            v                     v
                       staged effect/promise host
```

No owner may both choose graph behavior and manage decoder resources. The
graph chooses semantic presentations. The scheduler proves that the required
media presentation is available and supplies only the boolean `routeReady`
handshake at an authored boundary. After every committed content tick, it
asserts that the graph's returned presentation matches the media path it
prepared.

The runtime uses narrow injectable boundaries for the worker client, clock,
animation-frame source, renderer, static-surface store, and diagnostics sink.
Unit tests use deterministic fakes; browser proof uses the real module worker,
`VideoDecoder`, `VideoFrame.copyTo()`, and WebGL2.

## 4. Asset Ownership and Catalog

### 4.1 Installation

The runtime takes a `Uint8Array`, copies it once into an owned byte array, and
calls `validateCompleteAsset({ bytes })` on that copy. The caller can mutate or
release its original view without changing installed media. The owned copy is
bounded by M4's 32 MiB file cap and remains the compressed cache for M5.5.

The catalog retains:

- the owned bytes;
- the validated immutable front index and graph;
- maps for renditions, units, states, edges, ports, records, and static frames;
- exact access-unit locations for each `(rendition, unit, frame)`; and
- exact static PNG locations for each static-frame ID.

The catalog never retains an unvalidated caller view. It checks all products
and additions before slicing. It exposes read-only metadata and functions that
return fresh owned sample buffers. A worker submit therefore transfers a
detached per-occurrence copy; it never detaches or aliases the installed asset
bytes.

M5.5 trusts M4's complete structural and shallow PNG-envelope validation and
reuses M5's public strict AVC rendition inspector. Before configuring a
candidate, the catalog presents every selected unit/access unit to
`inspectAvcAnnexBRendition()` and requires one compatible parameter-set
identity across the complete rendition. The worker then repeats incremental
strict inspection on every submitted occurrence. M5.5 does not recompute
unit/static SHA-256 values at runtime. Streaming digest enforcement remains
M7.

### 4.2 Rendition candidate set

M5.5 considers only renditions with all of these exact values:

- `profile: "avc-annexb-opaque-v0"`;
- `codec: "avc1.42E020"`;
- `capabilities: ["webcodecs", "webgl2"]`; and
- an opaque color rectangle and geometry accepted by M4.

Reference RGBA and packed-alpha renditions are not animated by M5.5. Their
presence is valid format input but does not weaken the exact opaque profile.

### 4.3 Deterministic preference

Structurally eligible candidates are ordered by:

1. descending `codedWidth * codedHeight`;
2. descending peak bitrate;
3. canonical rendition ID ascending.

The runtime attempts candidates in that order. Each candidate is probed and
configured inside a fresh dedicated worker because the M5 worker permits one
configure operation. A capability, resource, or readiness failure completely
disposes that candidate before the next is attempted. At most one decoder is
alive at a time.

Coded pixel area is the available version-0 quality proxy and chooses the
highest spatial detail first. Peak bitrate breaks equal-area quality ties.
Canonical ID supplies a stable total order without treating canonical manifest
array order as an author-controlled priority or allowing probe timing to race
selection. The next entry in this exact ordering is the meaning of a “lower
rendition” in M5.5.

After animated readiness, a fatal runtime failure recovers to static mode. It
does not hot-switch to another rendition mid-motion because doing so would
require a new readiness cycle and could expose an unprepared boundary. A later
explicit fresh preparation may retry candidates.

## 5. Exact Decode Timeline and Sample Identity

The runtime has two separate clocks:

- the presentation clock counts visible content ticks; and
- the decode clock assigns worker ordinals and integer-microsecond timestamps.

Both use the manifest's exact rational frame rate. They never accumulate a
rounded duration.

For decode ordinal `d`:

```text
timestamp(d) = round-half-up(d * 1_000_000 * denominator / numerator)
duration(d)  = timestamp(d + 1) - timestamp(d)
```

Every timestamp and duration must remain a safe integer, duration is positive,
and timestamps strictly increase across the complete worker session. Warm-up,
resident preparation, dry runs, discarded generations, and visible playback
all consume the same global worker ordinal sequence.

Within one active generation:

- `unitInstance` starts at zero and increases for every encoded unit
  occurrence, regardless of unit ID;
- every occurrence starts at unit frame zero;
- frames within an occurrence are contiguous;
- a loop iteration receives a new unit instance; and
- switching generation resets only the unit-instance counter, never the
  global decode ordinal or timestamp.

The scheduler owns all three counters. The worker independently validates them.
No end-of-stream marker, terminal flush, boundary flush, reset, or repeated
configure is part of visible scheduling.

## 6. Runtime Resource Plan

### 6.1 Persistent frame identity

A persistent frame is identified only by:

```ts
interface RuntimeFrameKey {
  readonly rendition: string;
  readonly unit: string;
  readonly localFrame: number;
}
```

Pixel equality is not used for deduplication. Equal authored keys share one
texture-array layer across reversible clips, endpoint runways, and cut-target
runways. Different authored keys do not alias merely because their current
pixels happen to match.

The plan includes:

- every frame of every reversible unit once;
- each reversible endpoint's declared 6–12-frame body runway; and
- each cut target port's declared 6–12-frame body runway.

A body runway begins at port entry frame zero. A loop advances and wraps in
body order. A finite body advances to its final frame and then reuses that
held layer for any remaining runway ticks. Semantic runway length and unique
layer count are recorded separately.

### 6.2 Hard resource checks

Before WebGL allocation or decoder submission, checked arithmetic enforces:

- at most 24 frames and 24 MiB for each reversible clip;
- at most 48 MiB for the two endpoint runways of one reversible edge;
- at most 128 unique persistent layers per player;
- selected dimensions within `MAX_TEXTURE_SIZE`;
- unique layers within `MAX_ARRAY_TEXTURE_LAYERS`;
- one bounded RGBA staging surface sized to the larger of coded animation and
  logical static pixels;
- three reusable streaming texture layers;
- a decoded presentation ring of 6–12 frames;
- at most the current and one incoming logical-canvas static surface; and
- the effective per-player runtime cap.

The effective cap is the minimum of 64 MiB, the manifest's advisory
`maxRuntimeBytes`, and an optional lower host policy. Manifest estimates never
authorize an allocation.

The tracked steady-state calculation includes:

```text
owned complete asset bytes
+ maximum transferred encoded bytes simultaneously in worker credit
+ twelve potential submitted/output/leased decoded surfaces
+ persistent logical RGBA layer bytes with 25% GPU overhead
+ three streaming RGBA layers with 25% GPU overhead
+ one max(coded, logical) RGBA staging buffer
+ two logical-canvas static swap surfaces with 25% allocation overhead
```

The worker is configured with the frozen maximum of twelve combined pending,
submitted, output, and leased frames so readiness can measure and select any
legal 6–12-frame ring without reconfiguration. Resource planning therefore
reserves twelve decoded surfaces even when the final presentation ring is
smaller. The maximum encoded in-flight term is the greatest byte sum of any
legal window up to that outstanding limit, not `limit * 2 MiB` when actual
samples are smaller. GPU overhead rounds upward. Shared logical layers are
charged once. The same decoded worker frame is not charged again merely
because its managed handle resides in the presentation ring.

M5.5 owns one-player accounting only. Shared page decoder/memory budgets and
eviction remain M7.

### 6.3 Renderer allocation

The opaque renderer retains M2's one staging buffer, persistent RGBA8 texture
array, and three reusable streaming layers. It is generalized from one
reversible edge to the complete frozen interaction-cache plan. Zero persistent
layers are valid and allocate no resident texture. Its layout distinguishes
coded texture dimensions from logical presentation dimensions; the WebGL
viewport/canvas uses the manifest's logical canvas while the opaque shader
samples the selected coded texture across that viewport.

Resident preparation decodes required frames in forward dependency order,
copies one frame into the staging buffer, uploads the assigned layer, and
closes the managed worker frame before continuing. No source `VideoFrame`
survives preparation.

Streaming frames remain managed worker leases until their scheduled upload.
Upload transfers ownership to the renderer, which closes the frame after
`copyTo()` and returns worker credit. A texture slot is versioned so a stale
handle cannot draw overwritten pixels.

## 7. Presentation Ring

The presentation ring is a FIFO of decoded, validated frames for one active
streaming path. Its capacity is:

```text
clamp(max(6, decodeLeadFrames + 1), 6, 12)
```

If measured lead requires more than 12 frames, that rendition fails readiness.
Resource planning reserves the selected capacity before animated readiness.

Each ring entry records:

- scheduler generation;
- graph/media path identity;
- unit ID, occurrence, and local frame;
- decode ordinal and timestamp;
- intended presentation ordinal;
- worker-output and upload timing; and
- one close-once managed frame handle.

Only the active path may enter the ring. Stale output is closed immediately.
The ring never reorders worker output, accepts an unexpected unit/frame, grows
beyond capacity, or treats `decodeQueueSize` as presentation readiness.

Repeated display refreshes for a lower-rate content frame do not consume ring
entries. One eligible content tick consumes at most one advancing entry. A
held body or resident held-runway frame may remain the current valid surface
without creating a fake advancing frame.

## 8. Source Submission Horizon

The scheduler maintains an explicit authored source cursor, submitted cursor,
decoded cursor, and displayed cursor for the active body occurrence. It never
infers readiness from worker queue depth.

While no route is selected, source-body submission may advance beyond the
earliest unresolved outgoing portal by no more than the presentation-ring
capacity. Once a route is selected, a portal is eligible only when:

- it is forward-reachable under the body's loop/finite rules;
- it lies beyond the measured decode horizon;
- no source access unit after that selected portal has entered the active
  sequential decoder path;
- the edge sequence can meet its consecutive-lead requirement; and
- its total request-to-start wait remains within `maxWaitFrames`.

If the first authored portal fails any condition, a loop selects a later
portal and charges the additional frames to its wait. A finite body never
wraps. At its final reachable portal or finish boundary it holds the authored
final frame while preparation completes, and that delay remains charged.

The scheduler may copy compressed alternatives but submits only one selected
sequential path. It does not run standby decoders. A pending route replacement
before visible start either reuses still-valid source work or activates a
newer generation and rebuilds the source continuation. Readiness simulation
must prove every pending cancellation/replacement phase can preserve the
source presentation contract; otherwise the candidate cannot become
interactive-ready.

## 9. Edge-Specific Consecutive Lead

For a nonresident edge, define `transitionFrames` as zero for a transitionless
edge or the locked bridge's complete frame count. Its required lead in content
ticks is:

```text
if transitionFrames + 1 <= ringCapacity:
  max(2, transitionFrames + 1)
else:
  ringCapacity
```

The `+ 1` is target body frame zero. For a held target, one resident/decoded
surface provides later held ticks, but the scheduler still proves two ticks of
availability before departure.

The final displayed source portal/finish frame is followed by:

- bridge frame zero, when a locked bridge exists; or
- target body frame zero, for a transitionless edge.

Bridge frame `N - 1` is followed by target body frame zero. A one-frame bridge
therefore requires both bridge frame zero and target body frame zero before
the source is allowed to depart. The scheduler maintains the calculated lead
throughout the bridge rather than checking only its first frame.

At a loop portal, missing lead selects a later portal. At a held finite
boundary, the current frame remains displayed until lead is ready. No empty,
duplicate seam, or partial bridge is substituted.

## 10. Edge Execution

### 10.1 Portal and finish edges

The graph remains in `waiting` while the scheduler prepares the chosen path.
At a boundary with sufficient lead, the scheduler calls:

```ts
engine.tick({ contentOrdinal, routeReady: true })
```

At an ineligible boundary it passes `routeReady: false`. The scheduler has the
exact media handle for the expected graph presentation before calling `tick`.
It then asserts equality between the returned graph presentation and prepared
unit/frame identity before drawing or exposing effects.

### 10.2 Transitionless and locked edges

A transitionless edge commits only when target frame zero is drawn. A locked
bridge always presents every authored frame in order. Requests during a locked
bridge may change only the graph's validated follow-on; they cannot change its
media frames or decoder generation mid-bridge.

### 10.3 Cut edges

Every cut target runway is resident before animated readiness. On the next
eligible content tick:

1. the scheduler activates a newer decoder generation;
2. obsolete ring and worker output are closed or retired;
3. target body decoding restarts from unit frame zero;
4. cached target runway frame zero is drawn;
5. the graph commits the target visual state; and
6. decoded duplicate runway outputs are closed until the first continuation
   frame is reached.

The cached runway supplies visible frames while continuation is rebuilt. A cut
has exactly one content-frame response bound and retains continuity class
`cut`; runtime scheduling never relabels it seamless.

### 10.4 Resident reversible edges

Starting a reversible edge from a stable body still obeys its declared portal
or finish policy. Once visible, every reversible frame comes from the resident
texture array. Forward and reverse presentations use the same authored layer
sequence in opposite cursor directions.

Inverse intent while the clip is active changes direction on the next eligible
content tick and draws the adjacent frame. It never decodes backward, repeats
the current frame deliberately, or waits for the worker.

At forward completion, the target endpoint runway is displayed while a newer
generation decodes target body continuation. At reverse completion, the source
endpoint runway performs the same role. Outputs corresponding to already
resident runway frames are validated and closed. The first streamed
continuation must have path frame equal to the semantic runway length.

Readiness rejects an edge if either direction cannot recover before its
declared runway ends.

### 10.5 Initial unit and body loops

If the initial state remains requested when animation begins, its initial unit
plays once and joins initial body frame zero. If a different valid destination
was accepted during preparation, the intro is skipped exactly as M3 specifies.

Every body loop is a sequence of complete independently decodable occurrences.
The next occurrence's frame-zero key sample is submitted early enough to be in
the ring before the current final frame is displayed. The seam never invokes
configure, reset, flush, seek, or end-of-stream.

## 11. Graph Host, Properties, Effects, and Promises

### 11.1 Why exposed state is staged

A graph operation returns a final immutable snapshot and an ordered effect
list. The graph has already completed the operation when the host receives
that result. Exposing `engine.snapshot()` directly would let an early event
listener observe later state too soon.

The integrated player therefore owns a staged public-state mirror. Getters
read the mirror, not the graph's already-final internal state. The host applies
effects in order and updates the corresponding mirror field immediately before
dispatching that effect.

After the complete operation, the mirror must equal the graph result snapshot
for every externally represented field. Any mismatch is a fatal internal
invariant failure.

### 11.2 Presentation barrier

Effects are divided around one draw barrier:

- `requestedstatechange`, `readinesschange`, `fallback`, and
  `transitionstart` that precede a target commit are applied before drawing;
- the prepared presentation is drawn exactly once; and
- `visualstatechange`, `transitionend`, and settlement are applied only after
  the target entry/static surface has been drawn.

For an ordinary body/bridge/reversible frame without a visual commit, the host
applies any `transitionstart`, draws, and then completes the operation. For a
cut or transitionless commit, `transitionstart` precedes cached target frame
zero and `visualstatechange` follows it.

The mirror updates `requestedState`, `visualState`, `readiness`, and
`isTransitioning` so listeners already see each field's new value at its own
event. `isTransitioning` becomes true with an accepted destination and is
recomputed at visual commit using the operation's final route snapshot.

### 11.3 Promises

The runtime maps every accepted graph request ID to one promise capability.
Joined requests share the graph completion group but retain their own promise.
Each graph `settle` effect resolves or rejects exactly the named request IDs in
the following microtask.

Stable no-ops resolve in a microtask. Superseded requests reject `AbortError`.
Invalid state/route requests reject without changing exposed requested state.
Disposal rejects every remaining promise once. No promise is settled from a
worker callback without a corresponding graph settlement effect, except final
abort of an unusable player.

M5.5 exposes this through an internal player facade and injected effect sink.
The DOM `CustomEvent` surface and custom element remain M8.

## 12. Readiness State Machine

### 12.1 Levels

M5.5 implements this runtime readiness ladder:

```ts
type RuntimeReadiness =
  | "unready"
  | "metadataReady"
  | "visualReady"
  | "interactiveReady"
  | "staticReady"
  | "disposed"
  | "error";
```

Its successful preparation levels mean:

- `metadataReady`: complete asset metadata and graph are valid;
- `visualReady`: the initial state's static surface has been decoded and drawn;
- `interactiveReady`: one rendition passes the complete animated gate; and
- `staticReady`: animation is unavailable, but every referenced static surface
  is usable.

This ladder is a player-web resource/presentation state. It does not replace
M3's graph readiness enum. The mapping is exact:

- `engine.install()` moves graph readiness to `preparing`; player-web publishes
  `metadataReady` only after the owned catalog and graph are installed;
- player-web publishes `visualReady` only after drawing the initial static
  surface while the graph remains `preparing`;
- graph `preparing -> animated` maps to runtime `interactiveReady` after the
  complete candidate gate; and
- graph `preparing/animated -> static` maps to runtime `staticReady` after all
  static surfaces are usable.

Player-web owns the metadata/visual readiness changes because M3 deliberately
knows nothing about bytes or rendering. The graph's animated/static
`readinesschange` effects are translated once; they are not also exposed as a
second competing readiness enum. `prepare()` resolves only after the first
animated presentation or newest requested static presentation has crossed the
draw barrier.

Before animation preparation, all static blobs are decoded sequentially by a
bounded static-surface adapter, checked for exact logical dimensions, and
deduplicated by static-frame ID. Validation probes other states one at a time
and closes each probe; `staticReady` means every unique static was successfully
validated, not that every decoded surface remains resident. M4's shallow PNG
envelope plus successful browser decode is the M5.5 static check. Independent
chunk/CRC/inflate/filter validation remains M6 and is not claimed here.

The static adapter owns an independent presentation plane supplied by the host,
not the animated WebGL context. It retains the current closeable surface and at
most one incoming replacement, draws at logical canvas size, and can cover the
animated plane after worker, decoder, or WebGL failure. A later static state
change re-decodes its already-validated compressed PNG from the owned catalog,
keeps the current surface visible, then atomically swaps and closes the old
surface. The integrated player switches planes only after the replacement is
ready. M8 will own the final DOM layering; M5.5 uses the narrow adapter and a
proof harness rather than creating the public element.

### 12.2 Preparation API

The internal API follows the future public contract:

```ts
prepare({ signal, timeoutMs = 5_000 }): Promise<
  | { mode: "animated"; assurance: "best-effort"; report: ReadinessReport }
  | { mode: "static"; reason: StaticReason; report: ReadinessReport }
>
```

Abort rejects with `AbortError`, disposes the active candidate, and leaves
installed metadata/static surfaces available for a later retry. Timeout or
candidate exhaustion resolves static only after every unique static frame has
passed the M5.5 static check. If the deadline expires while required static
validation or installation is still incomplete, the runtime cannot claim
`staticReady`; it calls `failStatic` and rejects `PlaybackFallbackError`.
Unsupported animation never leaves the promise pending. Concurrent prepare
calls join one operation.

Requests accepted after metadata installation and before preparation finishes
are handled by the M3 preparing state. They update the staged requested state,
coalesce latest-wins, and do not start motion. The surviving destination is the
first route after animated readiness or the state committed before static
prepare resolution.

### 12.3 Candidate preparation order

For each deterministic rendition candidate:

1. strictly inspect every selected AVC unit with format's public inspector;
2. create and configure one fresh worker;
3. validate selected geometry against the renderer/device;
4. calculate the complete interaction-cache and working-set plan;
5. allocate renderer resources;
6. decode and upload all persistent frames;
7. warm the loop decoder and measure output/upload timing;
8. dry-run every direct edge and every recovery runway;
9. evaluate all start-policy and wait bounds;
10. activate a fresh playback generation;
11. fill the initial presentation ring; and
12. begin animated graph playback and draw its first presentation.

Any failed step disposes the worker, managed frames, candidate textures,
queued uploads, timers, and measurements before trying the next candidate.

## 13. Readiness Measurements

### 13.1 Frozen constants and statistics

M5.5 uses:

- minimum measured warm-up outputs: 24;
- minimum decode throughput: 1.5 times authored frame rate;
- ring capacity: 6–12 frames;
- recovery/dry-run runway: `clamp(decodeLeadFrames + 1, 6, 12)` unless a
  reversible endpoint or cut declares its exact runway length; and
- one additional content-frame safety margin in every recovery calculation.

Twenty-four outputs keep the warm-cache readiness target possible while making
nearest-rank p99 conservative: with 24 samples, p99 is the maximum observed
sample. Measurements use an injectable monotonic high-resolution clock.

For each output the runtime records:

- submit time;
- worker delivery time;
- upload-ready time;
- output ordinal and media identity; and
- ideal rational deadline.

`decodeLeadFrames` is:

```text
ceil(p99(submit-to-worker-output) / contentFrameDuration) + 1
```

If this exceeds 11, the required `+ 1` ring margin would exceed 12 and the
candidate fails. Throughput includes the measured interval from first submit
to final worker output and must meet 1.5× real time. Edge deadline safety uses
submit-to-upload-ready timing, so a fast decoder cannot hide a slow copy/upload
path.

### 13.2 Nonresident edge dry runs

Every nonresident portal or finish edge is decoded as one exact sequence:

```text
complete locked bridge, if present
+ target body availability for the selected 6–12-tick probe runway
```

A short loop repeats complete unit occurrences. A finite body decodes through
its end and its final surface supplies later held ticks. The report records
per-frame ideal deadlines, actual output/upload readiness, rolling minimum
lead, p99 latency, throughput, required consecutive lead, and peak tracked
bytes.

Passing bridge frame zero alone is insufficient. The complete sequence must
remain deadline-safe and within budget.

### 13.3 Start-policy bounds

The readiness evaluator enumerates every possible stable source-body frame for
every direct edge and runs the same pure horizon/lead planner used by playback.
It records the maximum request-to-first-edge-frame wait.

- A looping portal search wraps and includes submitted-horizon and lead delay.
- A finite portal search never wraps and includes remaining authored frames
  plus preparation delay.
- Finish includes the greatest remaining finite-body distance plus preparation
  delay.
- An already held finite body includes preparation delay only.
- Cut equals one content frame because its target runway is resident.
- Reversible entry from a stable body uses its declared portal/finish bound.
- Active inverse reversal is separately required to respond in one eligible
  tick.

Each result must be no greater than the edge's `maxWaitFrames`. Pending
cancellation, replacement, locked follow-on, and prospective-target request
phases are also simulated to prove that graph and media path converge without
an unprepared presentation.

### 13.4 All-routes policy

`readiness.policy` must remain `all-routes`. The evaluator enumerates every
manifest edge, including completion-triggered edges. M4
`readiness.bootstrapUnits` and `immediateEdges` are validated startup hints;
they are not treated as the complete readiness set.

One failed edge, endpoint, cut runway, loop headroom check, cache allocation,
or initial-ring fill fails that rendition candidate. The runtime never reports
partial interactive readiness or silently disables one route.

## 14. Realtime Presentation and Underflow

The realtime driver uses `requestAnimationFrame` only as a display opportunity.
The rational clock determines whether a new content tick is eligible. Multiple
refresh callbacks for one content frame redraw nothing and do not advance the
graph.

Before calling `engine.tick`, the scheduler must own the exact next streaming
or resident media handle implied by its synchronized path cursor. If that
handle is unexpectedly unavailable at an eligible deadline:

- it does not tick or advance the graph;
- it holds the last valid canvas contents;
- it emits one bounded `underflow` diagnostic for that missed content tick;
- it marks the current smooth-session claim withdrawn; and
- it continues pumping the same path unless the underlying worker/renderer
  failure is fatal.

When the expected frame becomes available, it is presented on the next
eligible callback. The scheduler never clears the canvas, substitutes another
state, repeats an advancing content ID as though it were new, or dispatches a
visual commit before the target is drawn.

Deterministic unit/browser tests can drive one content tick at a time without
wall-clock scheduling. The manual driver exercises the same scheduler and draw
barrier, not a second playback implementation.

## 15. Failure and Static Recovery

### 15.1 Candidate failures before readiness

Unsupported WebCodecs configuration, WebGL2 absence, resource rejection,
worker configure failure, inadequate headroom, failed edge dry run, timeout,
or cache allocation failure rejects only the current candidate. After all
candidates fail, the graph enters static mode with one stable bounded reason.

Intermediate candidate failures do not dispatch public fallback events. The
final transition to static does.

### 15.2 Recoverable failure after animated readiness

A fatal worker, decoder, upload, or renderer failure performs this order:

1. freeze content time and retain the last valid pixels;
2. stop accepting new animated submissions;
3. close ring and worker-managed frames;
4. dispose the decoder worker and animated GPU resources;
5. ensure the newest accepted requested state's static surface is available;
6. call `MotionGraphEngine.recoverStatic(reason)`;
7. apply `readinesschange` and `fallback`;
8. apply `transitionstart` when present;
9. draw the requested static surface;
10. apply `visualstatechange` and `transitionend`; and
11. resolve the surviving request in the following microtask.

This is recovery of a route the graph already validated, not pathfinding or an
invented cut. Later state requests continue through M3 static-mode routing.

### 15.3 Static installation failure

If the required static surface cannot be decoded or drawn, the runtime calls
`failStatic`. Pending requests reject `PlaybackFallbackError`, the player
enters terminal error, and the last valid canvas/light-DOM fallback remains.

### 15.4 Internal runtime errors

Runtime boundaries normalize unknown throws into stable, bounded internal
errors. At minimum they distinguish invalid installed data, unsupported
capability, resource rejection, readiness failure, decoder failure, renderer
failure, watchdog timeout, underflow, abort, and disposal. Untrusted IDs may be
carried as structured diagnostic fields but are never interpolated into HTML.

Static preparation/recovery reports use this exact reason union:

```ts
type StaticReason =
  | "no-opaque-rendition"
  | "worker-unavailable"
  | "renderer-unavailable"
  | "codec-unsupported"
  | "resource-budget"
  | "readiness-failed"
  | "preparation-timeout"
  | "animation-failure";
```

The summary is deterministic. A missing structural candidate, missing worker,
or missing renderer uses its exact reason. Timeout wins once the global
deadline expires after static readiness is available. A timeout before static
readiness is a terminal static-installation failure instead of this reason. If
every attempted candidate fails in the same capability or resource category,
the matching summary is used; mixed candidate failures use
`readiness-failed`. A post-readiness fatal recovery uses `animation-failure`.
Candidate reports retain the more specific bounded error without expanding
this public-future union.

M8 may name the public error classes and improve messages without changing the
M5.5 state/cleanup contract.

## 16. Ownership and Lifecycle

Ownership is single and explicit:

- the catalog owns its copied complete asset bytes;
- each submit command owns fresh access-unit buffers and transfers them once;
- the worker owns samples after transfer and owns decoder outputs until frame
  transfer;
- a managed worker frame is owned by exactly one ring/cache-preparation step;
- renderer upload takes that handle and closes it after copy;
- persistent caches own pixels only, never `VideoFrame` objects;
- the static-surface store owns decoded static surfaces;
- the runtime promise ledger owns unresolved request capabilities; and
- the integrated player owns worker, renderer, clocks, callbacks, abort
  listeners, diagnostics, and every child resource.

Generation activation first closes scheduler-owned obsolete frames, then asks
the client to activate the newer generation. The client closes any remaining
older managed frames, and the worker closes unavoidable stale outputs. A
generation is a stale-output token only; it never determines graph routing.

`dispose()` is idempotent and final. It freezes the clock, cancels animation
callbacks and preparation, rejects pending requests with `AbortError`, closes
every managed frame/static surface, disposes renderer resources, awaits bounded
worker disposal, releases catalog bytes, and makes later mutating calls fail
as disposed. No fire-and-forget cleanup promise may retain a player.

M5.5 does not implement source replacement, visibility eviction, context
restoration, or multi-player arbitration. Those lifecycle expansions remain
M7/M8; all underlying resources nevertheless have complete local cleanup now.

## 17. Diagnostics and Trace Agreement

The integrated runtime exposes immutable bounded diagnostics, not mutable
internals. `RUNTIME_TRACE_CAPACITY` is exactly 512; the oldest record is
dropped when the next record commits. One trace record per operation/content
tick correlates:

- presentation ordinal and rational deadline;
- graph operation, snapshot, presentation, and ordered effects;
- route-ready decision and selected boundary;
- scheduler generation and active media path;
- submitted unit occurrences and worker ordinals;
- decoded/ring/resident presentation identity;
- draw source and readback tag when enabled;
- readiness/lead measurements;
- promise settlements; and
- underflow/fallback/cleanup counters.

Graph, decoder submission, decoder output, presentation, public-property,
effect, and settlement traces must agree on IDs and order. Trace capacity is
bounded; payload bytes and `VideoFrame` objects never enter a trace.

Worker snapshots remain evidence only. Successful visible playback requires:

- one configure call on the selected worker;
- zero reset calls;
- zero flush and boundary-flush calls;
- monotonically increasing accepted/output ordinals;
- released or closed ownership for every delivered frame; and
- no pending, submitted, or leased resources after disposal.

## 18. Conformance Fixtures and Browser Proof

### 18.1 Fixtures

M5.5 adds small licensed/generated opaque source projects and checked-in
compiled assets covering:

- an initial one-shot into a loop;
- two loop states joined by a resident reversible edge;
- both endpoint restart runways;
- a portal edge with a locked bridge;
- a one-frame locked bridge followed by target frame zero;
- a finite-body finish edge;
- a transitionless portal/finish edge;
- a cut with a shared target-port runway;
- a held origin; and
- a follow-on route after a locked intermediate state.

Frames carry machine-readable color/tag values that survive AVC loss and can
be checked with tolerant GPU readback. Fixture provenance records source,
project, tool, unit, static, and complete-asset digests. M5's compiler remains
the only asset producer.

### 18.2 Deterministic integration proof

A platform-independent harness with a fake worker and renderer executes every
direct edge from every valid graph phase. For each trace it compares:

- expected graph presentation/effects;
- encoded submission path;
- decoded output path;
- resident/streaming draw path;
- staged property/event order; and
- promise resolution/rejection order.

Seeded rapid-input traces cover pending inverse cancellation, replacement,
duplicate joining, locked follow-ons, active reversal, cut supersession,
fallback, and disposal. Fuzz invariants require convergence to the newest
accepted target without exceeding input, operation, ring, sample, layer, or
byte bounds.

### 18.3 Real-browser proof

Playwright serves a dedicated M5.5 proof module that loads the checked-in
opaque fixture, creates the real module worker and WebGL2 renderer, prepares
all routes, and drives a deterministic content-tick script. It proves:

- exact supported configuration or an explicit unsupported result;
- deterministic rendition choice;
- initial ring fill and continuous loop seam order;
- portal and finish transitions within declared bounds;
- one-frame bridge then target frame zero;
- cut target frame zero from a resident layer on the next tick;
- active reversal to the adjacent cached layer on the next tick;
- both reversible continuation recoveries before runway end;
- locked follow-on/latest-wins convergence;
- staged property/effect/promise order;
- induced fatal worker recovery to the requested static frame;
- tolerant GPU readback of every boundary tag;
- configure count one and reset/flush/boundary-flush counts zero; and
- zero open frames, leases, pending work, callbacks, and GL resources after
  disposal.

The bundled Chromium test may report exact AVC unsupported and skip only the
production-profile assertions. M5.5 evidence requires at least one recorded
supported real-browser run. VP8 is not substituted. The proof is runtime
scheduling conformance, not observed display scan-out or named-device
certification.

Realtime evidence keeps three timing layers distinct. RAF timestamps grade
the health of display opportunities. Post-draw `performance.now()` timestamps
grade canvas submission cadence after the synchronous production draw path,
and callback-to-draw latency has its own hard bound. A callback timestamp is
not relabeled as a presentation timestamp: irregular headless RAF phase can
quantize the selected opportunity before the actual draw completes. Tolerant
GPU readback remains in the deterministic boundary proof; the realtime cadence
drive does not insert a synchronous proof-only framebuffer readback into every
RAF callback.

## 19. Verification Gate

M5.5 is complete only when all of these pass.

### 19.1 Pure and fake-adapter tests

- asset ownership, hostile caller mutation, catalog lookup, checked slices,
  and detached submit buffers;
- deterministic rendition sorting, unsupported candidate disposal, lower
  candidate retry, and total candidate exhaustion;
- exact decode timestamps/durations, ordinal limits, unit occurrences, and
  generation changes;
- interaction-cache deduplication, loop/finite runway expansion, layer/device
  limits, and every checked memory term;
- worker-backed resident preparation and close-once ownership;
- ring bounds, FIFO identity, stale output, backpressure, and underflow hold;
- source horizon and later-portal selection from every body frame;
- nonresident lead, including transitionless and one-frame bridges;
- finite, held, portal, finish, completion, cut, locked, and reversible paths;
- pending cancellation/replacement, locked follow-ons, and adjacent reversal;
- warm-up p99/headroom, edge dry runs, runway recovery, and max-wait reports;
- all-routes rejection when exactly one edge is incomplete;
- preparation coalescing, timeout, abort, retry, and static exhaustion;
- staged getters/effects/draw barrier and microtask promise settlement;
- recoverable static commit, static failure, underflow, and terminal disposal;
- seeded long-run trace agreement and bounded resources; and
- no graph, AVC parser, or worker-policy duplication.

### 19.2 Browser and repository gate

Run:

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

Then perform a strict read-only contract and maintainability audit. It must
confirm one graph owner, one container/record owner, one AVC inspector, one
decode clock, one rendition-order owner, one resource-plan owner, one
submission-horizon owner, one effect/promise host, no scheduler policy in the
worker, and no M6–M8 implementation hidden in M5.5.

Record
`docs/evidence/2026-07-12-m55-integrated-scheduler-readiness.md` with exact
test counts, fixture/tool/browser hashes, rendition attempts, resource plans,
readiness measurements, direct-edge traces, worker counters, fallback order,
cleanup evidence, package/audit results, and explicit claim boundaries.

## 20. Explicit Deferrals

M5.5 deliberately leaves these later milestones unchanged:

- **M6:** packed stacked alpha, alpha-aware geometry, compositor shader,
  premultiplied blending, independent strict PNG parsing/CRC/inflate/filter
  validation, reduced-motion policy, and background correctness.
- **M7:** range loading, strong validators, internal digest recomputation,
  external integrity, abortable network bodies, shared page budgets, eviction,
  visibility suspension, source replacement, and context restoration.
- **M8:** public custom element, automatic pointer/focus/engagement bindings,
  DOM events, accessibility integration, authoring polish, and public naming.
- **M9:** 1,000-boundary release certification across named headed browser,
  hardware, refresh-rate, power, and observed-display profiles.

M5.5 evidence may exercise long deterministic traces, but it must not promote
them to M9 certification or claim operating-system scan-out continuity.

## 21. Commit Boundary

The design and implementation plan are documentation-only review artifacts.
Runtime implementation is one later intentional M5.5 change after M5 is
committed and every M5.5 gate passes. Generated `dist`, local browser/tool
caches, temporary decoded media, traces containing machine paths, and ad-hoc
reports never enter the commit.
