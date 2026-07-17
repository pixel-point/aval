# Kinetic Orb Rapid-Hover Stability Design

## Purpose

Make rapid pointer enter/leave churn safe for every AVAL interactive asset. The
kinetic-orb demo is the regression fixture because its finite entry/exit units,
long looping bodies, and one-frame portals expose decoder scheduling failures
within a few hover cycles.

The intended behavior is unchanged: every accepted input is either routed or
superseded by newer intent, authored continuity is preserved, and rendered
frames keep advancing without entering fallback or an error state.

## Reproduced failure

Forty real pointer enter/leave cycles at roughly 45 ms per edge reproduce a
silent freeze on the current branch. The player continues reporting
`interactiveReady` with no `lastFailure`, but the requested state is `exiting`,
the visual state remains `entering`, and presentation is permanently held on
the final `hover-in` frame.

The source media and compiled asset are valid. The H.264 source contains 96
contiguous 512×512 frames at 24 fps, the AVL container validates, all integrity
values match, and the compiler reports no warnings.

## Root cause

The primary failure is decoder head-of-line blocking:

1. A leave arrives while `hover-in` is active, making `hover-out` the required
   pending or follow-on route.
2. The speculative `entering → hover` completion has already prefetched
   `hover-loop`. Reconciliation discards that parked run, but also immediately
   requeues the same speculation behind the required route.
3. Per-unit loading is asynchronous. The now-cached `hover-loop` reaches
   `Decoder.createRun()` before the uncached required `hover-out`, regardless
   of the order in which the player called `#queue()`.
4. The 24-frame `hover-loop` fills the 12-frame output ring while parked. It
   cannot flush because no consumer is draining it, so `hover-out` remains
   queued forever and presentation holds at the last `hover-in` frame.

Two ownership races can independently pin or diverge playback:

- a prefetched run remains discardable while it is being handed to active
  playback;
- a late `flushed` acknowledgement for a locally closed run is ignored before
  the decoder's active slot is released.

Retiring the current decoder owner also creates a strict handoff boundary. If
the player advances before the required replacement is ready, it attempts to
draw from the locally closed run and surfaces an `AbortError`. The last already
submitted frame must remain held until the replacement owns ready frames.

The current broad `AbortError` suppression can hide graph/media divergence,
and the waiter-only watchdog change converts the parked-run timeout from a
visible error into an indefinite silent freeze. These changes address symptoms
rather than the scheduling invariant.

## Repair design

The repair uses targeted extraction rather than another conditional patch in
`PlayerImpl` or a playback-pipeline rewrite. Route planning, prepared-run
admission, and decoder lifecycle certification become three separately tested
units. The graph contract, serial decoder, renderer, and public element API stay
unchanged.

### Route scheduling

Requested and follow-on intent outranks speculative completion prefetch. When
a newer required route exists, completion speculation is omitted rather than
merely queued later: asynchronous asset loading means call order alone is not
a decoder priority guarantee. If a lower-priority parked run already owns the
serial decoder, the player closes it and allows only the required run to start.

A non-consumed prefetch whose unit can exceed the available decoder ring must
never be allowed to block a required route indefinitely. The implementation
will encode this as a scheduling/ownership invariant rather than a
kinetic-orb-specific frame-count exception.

Route selection is a pure operation. `planRoutePrefetch()` receives a graph
snapshot plus read-only manifest lookups and returns an ordered plan containing
required route units, speculative completion units, and reversible units that
need resident frames. It does not load bytes, close runs, or mutate player
state. Pending and follow-on departures are both represented explicitly in the
plan and outrank completion or loop speculation.

A `PreparedRunScheduler` owns asynchronous byte loading and decoder admission.
Byte loads may proceed concurrently, but decoder admission is serialized by the
latest ordered plan: a ready speculative load cannot call `createRun()` while a
higher-priority required load is unresolved. Reconciliation cancels removed
loads and closes removed scheduler-owned runs. This makes decoder order a
scheduler guarantee rather than a consequence of promise resolution timing.

After retiring the active owner, advancement holds the last submitted frame
until the required route reports ready. It does not mutate the graph or draw
from the closed run during that handoff. The handoff is bound to the held body
unit and authored frame, not permanently to one edge: replacing a pending edge
at that same boundary keeps the hold, while replacing it with an edge authored
at a later boundary first reacquires the current body ahead of the new route.
That priority transfer prevents the replacement prefetch from parking the
serial decoder in front of the stream needed to resume presentation.

The player separates these operations instead of combining them in a
mode-bearing `prepareRoutes` method:

- plan prefetch from the snapshot;
- reconcile the scheduler and resident-frame requests;
- retire an active run only when it blocks a required departure at its authored
  boundary;
- evaluate departure readiness and select `none`, `authored`, or
  `decoder-handoff` hold behavior.

### Run ownership

Taking a prefetched run transfers it out of the discardable prefetch registry
synchronously, before any await. The claim is a cancellable handle owning both
readiness and close authority, so teardown can close an admitted-but-not-ready
run before awaiting it. Reconciliation may discard only runs that are still
wholly owned by prefetch. Once handed to active playback, the active consumer
exclusively controls cancellation, close, and frame consumption.

One scheduler entry is the source of truth for loading, admission, readiness,
and ownership. A claim removes the entry synchronously and returns its
cancellable readiness handle. There is no parallel map/set pair whose updates
can diverge.

### Decoder terminal protocol

The host and worker share a closed, validated wire protocol. Commands and
events use discriminated unions, positive generation identifiers, exact
top-level shapes, and a global worker `error` event with no run identifier.
Malformed traffic is terminal.

Normal `flushed` and `closed` acknowledgements are idempotent retirement
signals. An acknowledgement for the current closing generation clears the
decoder lane and schedules the next queued run even when the local run is
already closed. Worker errors are not acknowledgements: they are globally
fatal because the single worker can no longer certify any queued run.

Both sides use explicit lifecycle states rather than inferring protocol state
from resource-retention collections or independent booleans. The host lane is
idle, running, closing, or terminal. The worker is unconfigured, configuring,
idle, ready, accepting, flushing, closing, or terminal. A monotonic retirement
floor makes delayed close commands for any older generation harmless, not only
for the most recently retired run. Impossible stale start, acceptance, or frame
traffic remains a protocol failure; a transferred stale frame is closed first.

### Abort handling

An expected supersession abort is handled where ownership changes, before
graph and rendered-media state can diverge. The player's main advancement loop
will not blanket-swallow every `AbortError`; an abort that occurs after a graph
mutation must either reschedule from a consistent state or surface as a real
failure.

### Engagement convergence

Pointer and focus events are edges, but `engagement.on` and `engagement.off`
describe the current level `hovered || focused`. A level binding can be
temporarily unroutable while the graph is in an incompatible finite state. If
that rejected edge is forgotten, the graph can later settle in `hover` while
the pointer remains outside.

The element retains only a rejected engagement-level intent. After the current
authored transition ends, it retries that intent in an element-owned microtask
if the interaction binding epoch and desired level are still current. An
accepted intent, a changed level, rebinding, or teardown clears/replaces the
pending intent. Raw `pointer.*` and `focus.*` bindings are never replayed. This
is level reconciliation, not input debouncing or synthetic pointer input.

## Verification

Unit tests will cover:

- required follow-on route priority over speculative completion prefetch;
- preemption of a parked lower-priority run before it can block the serial
  decoder;
- synchronous transfer of a taken prefetch out of discardable ownership;
- the exact `flush sent → local close → late flushed acknowledgement` order,
  proving that the queued run starts;
- the inverse `flush pending → close wins → one closed acknowledgement` order;
- delayed close for generations older than the most recently retired run;
- strict rejection of stale nonterminal and malformed protocol traffic;
- rejected engagement-off during finite hover entry is retried after completion
  and converges to idle without another pointer event;
- supersession without graph/media divergence or leaked decoder ownership.

Pure planner/scheduler tests cover pending, follow-on, and speculative plans,
including deliberately inverted byte-load completion. A small player
integration test proves the planner is wired to the real graph boundary without
recreating the complete graph, asset, decoder, and renderer stack in one fake.

The kinetic-orb browser regression will use actual pointer hover and pointer
leave, without compensating `send("hover.leave")` calls. It will run at least
40 rapid cycles near the reproduced 45 ms cadence, then verify:

- `requestedState` and `visualState` settle to `idle`;
- the player is not transitioning and remains `interactiveReady`;
- `lastFailure` and `staticReason` remain empty;
- no underflow, console error, or page error is recorded;
- runtime trace and rendered pixels continue advancing after settlement.

The test must fail if rapid input stops producing meaningful routes after the
first pair. Native pointer delivery and public state/transition events are
observed separately: legitimate intermediate supersession remains allowed, but
the burst must complete multiple ordered enter/leave route cycles.

The browser regression is split into artifact, interaction, and rapid-hover
tests with shared black-box helpers. The rapid test verifies every generated
pointer edge reached the element and that automatic engagement produced
repeated public route cycles, then proves settlement, post-stress reuse, and
consecutive rendered-frame progress. It does not replace the public `send()`
method or assert private runtime trace record kinds.

`npm run test:kinetic-orb` builds the graph and element distributions it serves,
so a fresh checkout cannot accidentally test stale ignored output. Chromium is
headless under CI, and a required CI job installs Chromium and runs the suite.

## Scope

This repair changes runtime scheduling, run ownership, decoder terminal
handling, and focused regression coverage. It does not alter the kinetic-orb
asset, authored graph, portal latency, visual design, or public interaction
semantics. Debouncing input and watchdog-based restart are explicitly excluded
because they would mask the race and weaken responsiveness.
