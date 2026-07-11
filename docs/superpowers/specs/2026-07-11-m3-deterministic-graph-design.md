# M3 Deterministic Graph Engine Design

**Date:** 2026-07-11

**Status:** Approved implementation slice derived from the committed web
rendered-motion format design

## 1. Objective

M3 freezes the browser-independent semantic engine for creator-defined states
and direct transitions. It proves routing, authored-frame cursors, rapid-input
behavior, lifecycle state, ordered public effects, and request settlement
without importing DOM, codec, media, rendering, networking, or timer APIs.

The engine does not decode or draw. It produces one immutable presentation
command per explicit content boundary. M5.5 will connect those commands to the
format, decoder worker, readiness measurements, and renderer.

## 2. Package Boundary

Create `@rendered-motion/graph` as a new npm workspace package:

- `model.ts` contains public immutable definition, snapshot, presentation,
  effect, and result types;
- `validate.ts` clones and validates an untrusted graph definition into maps;
- `portal-search.ts` owns loop, finite, held, portal, and finish geometry;
- `request-ledger.ts` owns request groups and exactly-once settlement;
- `engine.ts` coordinates lifecycle, authored cursors, routing, effects, and a
  bounded trace;
- `errors.ts` provides stable typed validation and lifecycle errors; and
- `index.ts` is the only package export surface.

M2's two-endpoint `ReversibleClipController` remains an isolated experiment.
It is not generalized or imported by M3. Player integration waits for M5.5.

## 3. Definition Model

Identifiers match `^[a-z][a-z0-9._-]{0,63}$`. A graph contains one to 32
states, zero to 64 direct edges, an initial state, and at most one initial unit
owned by that state.

A state declares:

- a unique ID;
- a unique static-frame ID;
- one body with a unique unit ID;
- body kind `loop`, `finite`, or `held`;
- a positive frame count (`held` requires exactly one); and
- zero to 16 named ports.

Every port has `entryFrame: 0` and sorted, unique portal frames inside the
body. A finite body's port used by an outgoing portal edge includes the held
final frame. Finite bodies advance only forward and never wrap. Loop bodies
wrap. Held bodies remain on frame zero.

An edge declares unique ID, distinct source and target states, an optional
event or completion trigger, continuity, start policy, and optional transition:

- `portal` names source and target ports and a maximum wait;
- `finish` names a target port and is invalid from a loop;
- `cut` names a target port, has no transition, and has maximum wait one;
- no transition joins directly to target body frame zero;
- `locked` owns a positive-length bridge; and
- `reversible` owns a 1–24-frame resident unit and a forward or reverse
  direction.

Only one edge may occupy `(from, to)` or `(from, event)`. A completion trigger
is unique for its source finite/held state. The inverse edge of a reversible
edge reverses endpoints, uses the same unit and frame count, uses the opposite
direction, and declares its own stable-body start policy.

Validation checks portal/finish geometric wait lower bounds, direct ambiguity,
inverse consistency, invalid references, resource counts, and immediate cycles
before constructing an engine.

## 4. Lifecycle

The engine begins `unready`. `install(definition)` validates metadata, displays
the initial state's static presentation, and enters `preparing`.

`beginAnimated()` changes readiness to animated:

- if the newest request still names the initial state and an initial unit
  exists, intro frame zero becomes current;
- if a different request was accepted during preparation, the intro is skipped,
  initial body frame zero becomes current, and that route is pending; or
- otherwise initial body frame zero becomes stable.

An intro is locked and emits no transition effects. A different valid request
while it plays waits until the intro's final frame is followed by initial body
frame zero. A request for the initial state is a semantic no-op.

`beginStatic(reason)` installs static mode and commits the newest accepted
state before returning. Static requests still require one direct edge, but
ignore portal timing and synchronously produce requested/start/visual/end
effects plus a microtask settlement descriptor.

`recoverStatic(reason)` holds the last logical presentation until invoked, then
emits `readinesschange(static)` and `fallback` before committing the newest
already accepted target. If the accepted edge had not started, its static route
emits `transitionstart` immediately before the target PNG; an already visible
edge does not emit a second start. Returning from a reversal to the unchanged
old visual state emits no false `visualstatechange(old, old)`.

`failStatic()` rejects surviving requests with `PlaybackFallbackError` without
a false visual commit. `dispose()` is idempotent and rejects all surviving
requests with `AbortError`.

## 5. Inputs and Settlements

`request(target)` and `send(event)` allocate monotonic input sequence numbers.
State requests also allocate request IDs. At most 32 inputs are accepted
between content ticks. The next input is rejected as `InputOverflowError`
without mutating graph state; event dispatch returns false.

An invalid state or missing direct route produces a `RouteError` settlement
without changing `requestedState`. A same-state stable request produces only a
microtask resolve descriptor. Duplicate requests for the current in-flight
destination join its completion group. A newer valid destination rejects every
superseded group member with `AbortError`.

Actual JavaScript promises do not live in this package. The future public
player maps request IDs to promises and consumes immutable settlement effects.

Accepted destination changes atomically mutate `requestedState` and recompute
`isTransitioning`, then emit `requestedstatechange`. This resolves the source
specification's ordering ambiguity in favor of its public getter invariant: a
future listener already observes `isTransitioning === true` whenever requested
and visual state differ. Equality with the old visual state during a visible
reversal does not settle the reversal.

## 6. Tick and Presentation Contract

`tick({ contentOrdinal, routeReady = true })` requires consecutive nonnegative
ordinals and returns exactly one presentation command. The engine owns authored
cursors; the scheduler never passes decoder or renderer objects.

Presentations are:

- static frame for one state;
- initial-unit frame;
- body frame for one state;
- locked bridge frame; or
- reversible-unit frame with direction.

The current presentation is already displayed before the next tick. Therefore
a currently displayed portal has zero remaining wait: the next tick may show
bridge frame zero. Reaching a portal on this tick displays that body frame and
the following tick may leave it.

`routeReady` is the scheduler handshake. At a ready boundary, an edge may
start. If false, a loop continues to a later portal; a finite/held body stays on
its final reachable boundary. A cut ignores bridge availability because its
resident target runway is an M5.5 readiness prerequisite.

The final source portal/finish frame is followed by bridge frame zero, or target
body frame zero for a transitionless edge. Bridge frame `N - 1` is followed by
target body frame zero. Only that target entry presentation commits
`visualState`.

## 7. Rapid Routing

Pending portal/finish work is latest-wins. A newer direct edge from the current
visual state replaces it. Requesting its source, or sending the declared inverse
event, cancels it before any transition starts and resolves the new source
request as a no-op.

While a reversible unit is visible:

- duplicate prospective-target intent continues;
- inverse state/event intent changes direction on the next tick and emits the
  inverse edge's `transitionstart` before the adjacent frame;
- the next frame is `k - 1` when reversing a forward cursor or `k + 1` when
  reversing a reverse cursor;
- no displayed frame is deliberately repeated; and
- another destination is accepted only through one direct edge from the
  prospective target, becoming the sole follow-on.

While a locked bridge is visible, its frames always finish in order. Requesting
its own target removes a follow-on and joins completion. Another target is
accepted only through one direct edge from the locked target. At target body
frame zero, that intermediate visual state commits and emits the active edge's
end; a surviving follow-on then becomes pending without replaying stale
requests.

Finite/held states may declare one explicit completion-trigger edge. It becomes
eligible only at the held final frame. There is no implicit completion route.

Every tick performs at most 64 routing operations. Definitions with an
immediate routing cycle are rejected.

## 8. Effects

Every operation returns a frozen result containing its final snapshot, optional
presentation, and ordered effects. Effects are:

- `readinesschange`;
- `requestedstatechange`;
- `transitionstart`;
- `visualstatechange`;
- `transitionend`;
- `fallback`; and
- `settle` with request IDs, microtask timing, and resolve/reject reason.

For an animated transition the order is requested change, transition start at
the first edge-owned presentation, visual change at target entry, transition
end, then settlement. Static recovery prepends readiness and fallback. Event
effects carry state/edge IDs and input sequence where relevant; they never
carry executable callbacks.

The snapshot exposes readiness, phase, requested and visual states,
`isTransitioning`, prospective state, current presentation, pending/active and
follow-on edge IDs, direction/cursor, tick ordinal, input sequence, and pending
request count.

A bounded 256-operation trace stores immutable results for diagnostics.

## 9. Verification Gate

M3 passes when browser-independent tests prove:

- validation limits, references, direct/event ambiguity, portal geometry,
  inverse consistency, and immutability;
- loop portal, finite portal, finish, held, cut, and no-bridge timing;
- intro play, skip, locked queue, and body-zero join;
- pending inverse cancellation by state and event;
- adjacent active reversal in both directions;
- reversible and locked follow-on acceptance/rejection;
- loading/success/error latest-wins traces;
- duplicate request joining, superseding aborts, no-op resolution, and exact
  effect order;
- preparation coalescing, static mode, recoverable fallback, fallback failure,
  and disposal;
- explicit finite completion without implicit routing;
- 32-input and 64-operation bounds; and
- seeded rapid-input fuzz convergence and trace determinism.

M3 does not parse a container, expose actual promises or DOM events, perform
readiness measurement, decode frames, or replace the M2 player. Those joins are
M4, M5.5, and M8 work.
