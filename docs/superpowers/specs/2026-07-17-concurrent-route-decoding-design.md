# Concurrent Route Decoding Design

**Date:** 2026-07-17

**Status:** Implemented; verification evidence is listed in Section 10

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
9. Both lanes count toward one exact player and page resource total before
   their allocations occur.
10. Ordinary streamed candidates never call the renderer's resident
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
- **prepared media** — an immutable unit plus a ready run;
- **promotion** — transfer of a prepared route into foreground ownership; and
- **retirement** — closure and final release of the previous foreground.

Each run also receives a coordinator-wide logical ID for traces. Worker-local
generation numbers remain valid only inside their decoder.

The candidate decoder is created when animated resources are prepared and
remains configured but empty until an authoritative route exists. It holds no
decoded route frames before that point. Keeping the empty lane configured
removes worker/configuration startup from the interaction latency while still
avoiding a persistent frame cache.

### 4.2 Page decoder admission

Page resources account for physical decoder slots, not player count. An
animated Player requires an atomic two-slot decoder permit before it creates
its two workers. The existing page ceiling remains the authority for how many
physical decoders may be live.

Admission never creates a one-lane animated compatibility mode. If the pair
cannot be granted, the candidate is reported as `decoder-queued` and the
existing static readiness/restart behavior remains responsible for recovery
when resources later become available.

The page participant owns one weighted ticket and one weighted lease. Ticket
grant, cancellation, visibility parking, release, diagnostics, and disposal
operate on the lease weight atomically. This prevents two players from each
holding one foreground decoder while waiting forever for a second slot.

### 4.3 Resource accounting

The runtime reserves the worst-case aggregate for two decoder rings before
animated readiness. With the current ring size of twelve, the decoder surface
term is twenty-four decoded surfaces. For H.264, compiler, readiness, and
runtime all use the canonical macroblock-aligned browser surface plus the
32-pixel decoder padding bound on each axis. Encoded-copy ceilings include one
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
2. synchronously claims the required ready unit before graph mutation or public
   callbacks;
3. ticks the graph and verifies it matches the preview;
4. installs a player-owned provisional media transaction around that run;
5. submits its target entry frame while the run still has candidate ownership;
6. promotes the candidate and installs it as active only after submission;
7. retires the previous foreground and waits for worker acknowledgement before
   reusing that physical lane; and
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

Visibility suspension, source replacement, context loss, static recovery, and
disposal cancel route planning, close candidate and foreground runs, await
owned asynchronous work, dispose both decoders, release the weighted page
lease, clear renderer resources, and publish zero resource ownership.

## 9. Code Boundaries

The implementation is divided as follows:

- `decoder-pool.ts` owns foreground/candidate decoder roles, aggregate
  accounting, logical run identities, promotion, and disposal.
- `decoder.ts` retains the serial worker client and run contract, with only the
  narrow accounting/readiness hooks needed by the coordinator. Its
  acknowledged-idle state is the authority for physical lane reuse.
- `route-prefetch.ts` separates parallel byte loading from single-candidate
  decode admission and owns candidate reconciliation.
- `player.ts` coordinates graph ticks, atomic draw/promotion, scheduling, and
  public effects without embedding decoder-pool internals.
- `page-resources.ts` grants weighted physical decoder leases atomically.
- `aval-element.ts` and `player-contract.ts` expose the weighted readiness
  permission and aggregate diagnostics.
- compiler resource estimation changes its decoder surface term from one ring
  to two canonically bounded decoder surfaces.

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

Page-resource tests cover weighted FIFO grant, visibility parking, atomic
release, and the absence of partial pair allocation. Route-prefetch tests cover
loaded-versus-decoding state, immutable-unit reuse, cancellation, final-portal
continuation priority, and acknowledged lane retirement.

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
has completed the explicit public-package build.

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
