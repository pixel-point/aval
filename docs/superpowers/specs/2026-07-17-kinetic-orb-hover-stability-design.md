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
   follow-on route.
2. Route preparation currently gives a speculative `entering → hover`
   completion prefetch higher priority than that requested follow-on route.
3. The 24-frame `hover-loop` starts on the serial decoder and fills the
   12-frame output ring while parked. It cannot flush because no consumer is
   draining it.
4. The required `hover-out` run remains queued forever, while presentation is
   held at the last `hover-in` frame.

Two ownership races can independently pin or diverge playback:

- a prefetched run remains discardable while it is being handed to active
  playback;
- a late `flushed` acknowledgement for a locally closed run is ignored before
  the decoder's active slot is released.

The current broad `AbortError` suppression can hide graph/media divergence,
and the waiter-only watchdog change converts the parked-run timeout from a
visible error into an indefinite silent freeze. These changes address symptoms
rather than the scheduling invariant.

## Repair design

### Route scheduling

Requested and follow-on intent outranks speculative completion prefetch. When
a newer required route exists, completion speculation must not start ahead of
it. If a lower-priority parked run already owns the serial decoder, the player
must close it and allow the required run to start.

A non-consumed prefetch whose unit can exceed the available decoder ring must
never be allowed to block a required route indefinitely. The implementation
will encode this as a scheduling/ownership invariant rather than a
kinetic-orb-specific frame-count exception.

### Run ownership

Taking a prefetched run transfers it out of the discardable prefetch registry
synchronously, before any await. Reconciliation may discard only runs that are
still wholly owned by prefetch. Once handed to active playback, the active
consumer exclusively controls close and frame consumption.

### Decoder terminal protocol

Close, flush, and error acknowledgements are idempotent terminal signals. A
terminal acknowledgement for the current active generation must always clear
the active slot and schedule the next queued run, even when the local run has
already been marked closed. Stale generations remain ignored without
affecting the current owner.

### Abort handling

An expected supersession abort is handled where ownership changes, before
graph and rendered-media state can diverge. The player's main advancement loop
will not blanket-swallow every `AbortError`; an abort that occurs after a graph
mutation must either reschedule from a consistent state or surface as a real
failure.

## Verification

Unit tests will cover:

- required follow-on route priority over speculative completion prefetch;
- preemption of a parked lower-priority run before it can block the serial
  decoder;
- synchronous transfer of a taken prefetch out of discardable ownership;
- the exact `flush sent → local close → late flushed acknowledgement` order,
  proving that the queued run starts;
- supersession without graph/media divergence or leaked decoder ownership.

The kinetic-orb browser regression will use actual pointer hover and pointer
leave, without compensating `send("hover.leave")` calls. It will run at least
40 rapid cycles near the reproduced 45 ms cadence, then verify:

- `requestedState` and `visualState` settle to `idle`;
- the player is not transitioning and remains `interactiveReady`;
- `lastFailure` and `staticReason` remain empty;
- no underflow, console error, or page error is recorded;
- runtime trace and rendered pixels continue advancing after settlement.

The test must fail if input events become unrouteable no-ops, so accepted event
results and real automatic engagement routing are observed separately.

## Scope

This repair changes runtime scheduling, run ownership, decoder terminal
handling, and focused regression coverage. It does not alter the kinetic-orb
asset, authored graph, portal latency, visual design, or public interaction
semantics. Debouncing input and watchdog-based restart are explicitly excluded
because they would mask the race and weaken responsiveness.
