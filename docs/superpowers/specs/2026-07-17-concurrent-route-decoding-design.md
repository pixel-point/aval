# Concurrent Route Decoding Design

**Date:** 2026-07-17

**Status:** Approved; implementation must satisfy the structural remediation
in Sections 4, 6, 9, and 10

**Supersedes:** The runtime rule that an animated player owns one serial decoder
and must close its foreground run before preparing a non-resident departure.

## 1. Objective

AVAL must preserve authored presentation cadence while an interaction selects a
new streamed route. The current player cannot prepare that route until it closes
the foreground run because all runs share one decoder lane. At a portal this
produces a no-progress decoder handoff; the presentation scheduler then rebases
its expired deadline and adds one authored frame interval. The kinetic-orb
fixture exposes the result as 85–108 ms content gaps during rapid hover churn,
even though event handlers, animation frames, WebGL upload, and the source media
remain healthy.

This design replaces that serial handoff architecture with a bounded
foreground/candidate decoder pipeline:

- the foreground decoder continues presenting the current path;
- one candidate decoder prepares the graph's authoritative next route;
- an authored boundary atomically promotes a ready candidate; and
- decoded candidate frames exist only while that route intent is current.

The implementation does not add a feature flag, protocol version, legacy
player mode, or persistent predictive runway cache. The concurrent pipeline is
the animated player architecture.

## 2. Scope

This change owns:

- two-lane decoder ownership and exact aggregate accounting;
- authoritative candidate selection and cancellation;
- atomic foreground/candidate promotion;
- scheduler behavior when a content tick makes no progress;
- page-wide physical decoder admission;
- diagnostics and lifecycle cleanup for both decoder lanes; and
- deterministic and real-browser continuity evidence.

This change does not alter authored graph semantics, invent transitions, decode
media in reverse, modify the kinetic-orb source video, or remove the explicitly
authored resident frames required by reversible transitions and cut policies.
Those caches have separate semantics. "No persistent cache" in this design
means no new resident cache for ordinary streamed route prediction.

## 3. Required Invariants

The implementation must maintain all of these invariants:

1. The foreground remains the only presentation owner until a candidate's
   first target frame has been submitted successfully.
2. A candidate may supply only the provisional first replacement frame. It
   never mutates graph state or becomes foreground before that submission
   succeeds.
3. At most one candidate route decodes at a time, regardless of graph fan-out.
4. Physical candidate identity is the immutable unit ID. Format 1.0 fixes every
   target entry at frame zero and the decoder readiness window at frames zero
   through five, so different semantic routes to one unit have identical media.
5. Semantic route authority remains exclusively in the graph. A ready unit is
   claimed synchronously only after preview identifies that exact presentation;
   a stale semantic intent can never tick or publish the graph.
6. A claimed candidate leaves prefetch ownership synchronously.
7. Closing a run does not make its decoder lane reusable until terminal
   acknowledgement or decoder disposal.
8. Decoded frames, encoded copies, workers, and physical decoder permits are
   released exactly once on cancellation, failure, recovery, and disposal.
9. Fatal failure of either physical lane is observable even when that lane is
   idle or awaiting retirement acknowledgement; the pool routes that failure
   into player recovery instead of leaving route admission permanently closed.
10. Both lanes count toward one exact player and page resource total before
   their allocations occur.
11. Ordinary streamed candidates never call the renderer's resident
    `store()` or `drawStored()` path.

## 4. Architecture

### 4.1 Foreground/candidate coordinator

A new internal coordinator owns two existing serial `Decoder` instances. Each
decoder keeps its current dedicated worker and worker-local run state machine.
The worker command protocol remains single-lane; concurrency is achieved by
isolation, not by multiplexing multiple `VideoDecoder` objects into the current
worker state machine.

The coordinator exposes media concepts rather than raw lane numbers:

- **foreground** — the decoder and run allowed to supply presentation frames;
- **candidate** — the decoder and run preparing one selected departure;
- **candidate transaction** — an immutable unit plus a ready run whose sole
  owner can either commit or cancel it;
- **promotion** — transaction commit that transfers the candidate into
  foreground ownership and retires the previous foreground atomically; and
- **retirement** — closure and final release of the previous foreground.

Each run also receives a coordinator-wide logical ID for traces. Worker-local
generation numbers remain valid only inside their decoder. Candidate role,
promotion state, and cancellation live only in the transaction; Player does
not mirror them with booleans, nullable starts, or provisional lane flags.

The candidate decoder is created when animated resources are prepared and
remains configured but empty until an authoritative route exists. It holds no
decoded route frames before that point. Keeping the empty lane configured
removes worker/configuration startup from the interaction latency while still
avoiding a persistent frame cache.

### 4.2 Page decoder admission

Page resources grant animated-player permits. One permit always represents the
exact two physical decoder slots required before a player creates its workers.
The existing page ceiling remains the authority for how many physical decoders
may be live.

Admission never creates a one-lane animated compatibility mode. If the pair
cannot be granted, the candidate is reported as `decoder-queued` and the
existing static readiness/restart behavior remains responsible for recovery
when resources later become available.

The page participant owns one ticket and one lease. There is no one-slot or
weighted compatibility API. Grant, cancellation, visibility parking, release,
diagnostics, and disposal operate on the two-decoder permit atomically. This
prevents two players from each holding one foreground decoder while waiting
forever for a second slot.

### 4.3 Resource accounting

The runtime reserves the worst-case aggregate for two decoder rings before
animated readiness. One exported, side-effect-free Element capacity profile is
the sole authority for decoder count, ring size, candidate readiness depth, and
total decoded surfaces. Compiler estimation, readiness validation, Player
accounting, page admission, and diagnostics derive their values from that
profile; they do not repeat `12`, `2`, or `6`.

For decoded-surface geometry, Format exposes one codec-dispatching helper.
H.264 uses the canonical macroblock-aligned browser surface plus the 32-pixel
decoder padding bound on each axis; other codecs use exact coded RGBA geometry.
Consumers do not repeat that codec branch. Encoded-copy ceilings include one
foreground occurrence, one candidate occurrence, retiring ownership, and the
bounded compressed prefetch intents without double-counting shared asset
storage.

Both decoder callbacks feed one checked aggregate ledger. No decoder receives
an independent full `maxRuntimeBytes` allowance. Snapshots report the sum of
both lanes' worker count, open frames, open-frame bytes, and encoded copies.

Compiler runtime-working-set diagnostics use the same two-ring term for new
assets. This changes one calculation rather than introducing a new format or
compatibility branch.

## 5. Route Preparation

### 5.1 Planning

The graph snapshot remains the semantic authority. Player input first updates
the graph, then route planning derives ordered intents from that snapshot.

An intent contains only physical media work:

```text
unit ID
reason and priority
```

Compressed bytes for multiple bounded intents may load concurrently. Only the
highest-priority required intent is admitted to the candidate decoder. Lower
priority completion or speculative intents remain byte-ready; they do not
queue decoded runs behind the candidate.

Candidate readiness requires frames zero through five, bounded by unit frame
count. Format 1.0 requires every target port to enter at frame zero, so one
ready run is safely reusable when multiple semantic edges reference the same
immutable unit. Edge identity is deliberately not duplicated in the decoder
queue; the graph remains its canonical owner.

### 5.2 Reconciliation and churn

Every authoritative graph change causes a fresh ordered reconciliation:

- preserves a candidate only when its immutable unit remains the required
  physical media;
- cancels replaced candidates without touching foreground playback;
- closes frames arriving from a canceled candidate;
- ignores late readiness after queue ownership was canceled; and
- starts the newest authoritative candidate when its lane is retired.

Rejected graph inputs do not cancel the current candidate. This matters for
rapid engagement changes: the graph, not raw pointer intent, determines whether
the pending route changed. Once the first target frame is submitted, promotion
is final; newer input becomes a follow-on route.

When a pending portal route approaches the last usable portal of a looping
body, its source unit is also byte-loaded as a standby intent. If the target is
still not ready within the six-frame readiness lead, source continuation takes
decode priority. A target already ready at the current portal keeps priority.
This guarantees the one candidate lane protects continuous wrap playback
instead of freezing on the loop's final frame.

## 6. Atomic Promotion and Presentation

At each content tick the player:

1. previews the next graph presentation with current route readiness;
2. synchronously claims the required ready candidate transaction before graph
   mutation or public callbacks;
3. ticks the graph and verifies it matches the preview;
4. submits its target entry frame through the candidate transaction;
5. commits the transaction only after submission, atomically promoting the
   candidate and retiring the previous foreground;
6. installs the committed stream as the Player's active media;
7. waits for worker acknowledgement before reusing the retired physical lane;
   and
8. publishes transition effects and reconciles from the current graph snapshot.

There is no interval in which `active` is cleared merely to free a decoder.
The old canvas content remains valid until the target submission succeeds.
The previous foreground closes only after the first target draw, so a delayed
close or flush acknowledgement cannot create a blank or frozen handoff.

After promotion, the former foreground decoder becomes the empty candidate
lane once retirement completes. Immediate follow-on planning may then admit a
new route while the promoted run continues playing.

## 7. Scheduler

Player advancement returns one of two explicit scheduling outcomes:

```text
progressed        graph presentation and renderer submission completed
waiting-route     the required streamed presentation is not ready
```

Only `progressed` computes the next authored deadline. `waiting-route` does not
call the old unconditional deadline rebasing path. It preserves immediate
eligibility and retries on the next animation frame; decoder-lane availability
is rechecked before every retry.

At a loop portal with no ready candidate, the graph receives
`routeReady: false` and advances the source body normally to a later authored
portal. At a finite finish boundary, the last authored frame remains visible
while the player retries without adding an artificial frame interval.

The serial `decoder-handoff` state, active-run closure from `routeHold`, resume
unit bookkeeping, and active-blocks-departure branch are removed.

## 8. Failure and Lifecycle

Candidate cancellation is nonfatal. Candidate worker or decode failure before
promotion cannot corrupt the healthy foreground, but animated correctness is
no longer certified; the player enters the existing static recovery flow. An
active decoder failure remains fatal to the animated generation.

Resource rejection before two-lane readiness selects the next rendition when
one is available, then static recovery. The runtime never silently exceeds the
manifest or page budget and never falls back to the removed one-lane handoff.

Lifecycle settlement drains the owned-operation registry to quiescence. Work
admitted while an earlier byte load settles is part of the same settlement and
cannot escape a one-time promise snapshot.

Visibility suspension, source replacement, context loss, static recovery, and
disposal cancel route planning, close candidate and foreground runs, await
owned asynchronous work, dispose both decoders, release the atomic page
lease, clear renderer resources, and publish zero resource ownership.

## 9. Code Boundaries

The implementation is divided as follows:

- `decoder-pool.ts` owns foreground/candidate decoder roles, the candidate
  transaction, aggregate accounting, logical run identities, atomic commit,
  cancellation, and disposal.
- `decoder.ts` is a strict single-run worker lane with only the narrow
  accounting/readiness hooks needed by the coordinator. It has no queued-run
  compatibility scheduler; acknowledged idle is the authority for reuse.
- `route-prefetch.ts` separates parallel byte loading from single-candidate
  decode admission, represents each entry with one discriminated lifecycle,
  and transfers a ready candidate transaction synchronously.
- `player.ts` coordinates graph ticks, target draw, transaction commit,
  scheduling, and public effects without mirroring decoder-pool role state.
- `page-resources.ts` grants one atomic two-decoder player permit.
- `aval-element.ts` and `player-contract.ts` expose readiness permission and
  aggregate physical-slot diagnostics.
- compiler resource estimation changes its decoder surface term from one ring
  to the canonical Element capacity profile.
- `@pixel-point/aval-graph` owns presentation equality because it owns the
  `GraphPresentation` union; Element and player-web import that helper.

The worker protocol and renderer resident-storage implementation do not gain a
second concurrency mode.

## 10. Verification

### 10.1 Deterministic gates

Tests must prove:

- a candidate reaches its required ready window while foreground close/flush
  acknowledgement is indefinitely delayed;
- foreground frames continue advancing while candidate readiness is blocked;
- first target draw occurs before foreground close;
- stale readiness and frames cannot promote after physical media replacement;
- rejected rapid input preserves the authoritative candidate;
- only one candidate decodes even when several routes are byte-ready;
- finite-boundary readiness is consumed on the first animation frame after it
  resolves, without deadline rebasing;
- forty alternating engagement inputs at 45 ms converge to idle with no
  underflow, fallback, or error;
- aggregate workers never exceed two and aggregate decoded surfaces never
  exceed the admitted two-ring ceiling; and
- cancellation, recovery, and disposal return workers, frames, encoded bytes,
  page leases, and renderer operations to zero.

Page-resource tests cover FIFO grant, visibility parking, atomic release, and
the absence of partial pair allocation. Route-prefetch tests cover its typed
lifecycle, synchronous ready transfer, immutable-unit reuse, cancellation,
final-portal continuation priority, and acknowledged lane retirement.

### 10.2 Browser gates

The kinetic-orb harness drives forty native enter/leave pairs with raw mouse
coordinates on absolute 45 ms deadlines. It records native delivery,
presentation submissions, public state, runtime health, and post-settlement
pixel advancement.

Required results are:

- exactly forty enters and forty leaves;
- input interval median between 35 and 55 ms and p95 no greater than 70 ms;
- transition presentation gaps no greater than the steady baseline plus one
  animation frame and never greater than 83.5 ms at 24 fps;
- zero underflow, fallback, console error, page error, or error state;
- final idle, non-transitioning convergence within 1.5 seconds; and
- pixels continue advancing after settlement.

The ready-before-draw and draw-before-close order is a deterministic unit gate;
browser traces enforce delivered input cadence and presentation-submission
gaps. The asset contract additionally verifies binary SHA-256, build-report
integrity, and the HTML SRI pin as one value.

The standard `npm run kinetic-orb` workflow rebuilds the public packages before
starting the demo, and the demo forces a fresh Vite dependency graph. A branch
pull therefore cannot silently exercise an ignored, stale `dist` runtime. The
prebuilt Playwright gate starts the example workspace directly after its caller
has completed the explicit public-package build. It never silently reuses an
existing local server; manual reuse requires an explicit opt-in plus a matching
build fingerprint.

The packed dev proof must fail immediately when the compiler emits a JSON error
diagnostic and include bounded stdout and stderr context. Element worker URLs
with the intentional `no-inline` query are accepted only for the canonical
worker entry, and that entry receives the same closed worker CSP and request
classification as every other declared worker entry.

Compiler routing and release inspection derive worker paths, query policy, and
worker-entry classification from one declarative registry. A worker cannot be
renamed or added in one gate while silently remaining an ordinary script in
another. The compiler package ships that registry at its one reviewed JSON
distribution path. Fresh-build provenance, release staging, and tarball
inspection require its canonical bytes and reject every other distribution
JSON file.

Wall-clock performance thresholds run on the controlled local/release runner.
Deterministic ownership and scheduling tests remain the required portable CI
gate because shared browser runners cannot certify display cadence.

## 11. Completion Criteria

The work is complete when concurrent foreground/candidate decoding is the only
animated streamed-route architecture, the removed serial handoff symbols and
branches no longer exist, all deterministic suites pass, the kinetic-orb
fixture satisfies the browser gates, resource snapshots return to zero after
disposal, and the implementation has no feature flag or legacy compatibility
path.
