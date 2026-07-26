# States and triggers

State names are authored data, not a fixed runtime enum. Discover them from
`stateNames`, request one imperatively, or reflect a declarative intent:

```ts
const motion = document.querySelector("aval-player");
if (!(motion instanceof HTMLElement) || !("setState" in motion)) {
  throw new Error("AVAL is not registered");
}

await motion.setState("loading");
motion.state = "success";
```

`setState()` follows latest-wins graph semantics. A duplicate destination joins
the in-flight request; a superseded request rejects with `AbortError`; a missing
route rejects with `RouteError`. The `state` attribute/property stores intent
and does not expose a promise.

Assets can bind the fixed pointer, focus, engagement, activation, and visibility
sources to arbitrary authored event names. Motion preference is a host policy,
not a binding source. `send(name)` returns whether the current graph accepted
an authored event. The element never guesses that “hover” means a state with a
particular name.

Partial loops, finite bodies, held bodies, portals, finish routes, locked
bridges, cuts, and resident reversible transitions are compiled graph behavior.
They are not implemented by seeking a video element, so a loop seam does not
pause for a media seek.

## Rings: one request, several steps

When an asset declares a ring, the states on it are one axis rather than a set of
unrelated destinations. `setState()` on a ring member walks the shorter arc one
authored step at a time:

```ts
motion.planFor("walk_e");   // ["walk_ne", "walk_e"] from walk_n
await motion.setState("walk_e");
```

Distances wrap only on a cyclic ring, equal-length arcs are decided by the ring's
`tieBreak` (so a half turn is deterministic), and an arc longer than the ring's
`maxChainedSteps` rejects with `RouteError` instead of walking further than the
author allowed. An explicit edge between two ring neighbours always wins over the
derived step.

Each landing dispatches `turnstep` with `{ ring, from, to, remaining }`. The plan
is replanned at every step boundary: a new `setState()` mid-arc lets the step in
flight finish, then departs on a fresh arc from the state that actually landed —
so a rapid sweep produces continuous motion, with each superseded request
rejecting `AbortError` exactly as it does off a ring. No step seeks media; every
seam lands on frame 0 of the next body.
