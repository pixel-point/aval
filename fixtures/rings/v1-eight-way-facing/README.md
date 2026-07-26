# Eight-way facing ring (v1)

Authoring fixture for the `rings` construct. Eight looping walk bodies, one per
compass facing, joined into a single cyclic ring:

```
walk_n -> walk_ne -> walk_e -> walk_se -> walk_s -> walk_sw -> walk_w -> walk_nw -> walk_n
```

The project authors **no edges at all**. `avl compile` expands the ring into the
16 turn edges which walk it (eight adjacencies, both directions), each flagged
`derived: true` in `avl inspect` output and named after the ring plus the two
members' distinct suffixes:

```
facing.walk.n.ne   facing.walk.ne.n
facing.walk.ne.e   facing.walk.e.ne
...                facing.walk.n.nw
```

At runtime `setState("walk_e")` from `walk_n` chains two steps through
`walk_ne`; `setState("walk_s")` is an exact half turn, so `tieBreak: "forward"`
decides it deterministically. `maxChainedSteps: 4` refuses anything longer than
half the ring, which on a cyclic eight-way ring is every arc there is.

## Media

The project reads a `frames/` PNG sequence of 64 frames — eight frames per
facing, in ring order, each starting on its portal frame. The frames are not
checked in: this fixture exists to exercise ring expansion and graph planning
from the authored markup, which needs no pixels. Point `sources[0].directory` at
any 64-frame render of a walk cycle to compile it for real.

## Verified by

- `packages/compiler/test/source-ring-fixture.test.ts` — expansion, ids, and
  budget of the checked-in markup.
