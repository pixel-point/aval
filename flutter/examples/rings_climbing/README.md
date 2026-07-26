# rings_climbing — climbing motion atlas

Advanced AVAL **rings** demo built from the climbing prompt kit.

**Identity lock:** user-supplied climber — **camera from behind** (rear standing
+ portal hang + full atlas via Grok Imagine `image_edit`). Front refs kept
under `assets/atlas/refs/` for turnaround, but the demo stage uses rear stills.

| Layer | What |
| --- | --- |
| **Stamina ring** | `hang_secure` → `hang_strained` → `hang_failing` (cyclic, shared portal pose) |
| **Action pivots** | `shake_out`, `lock_off_hold`, `dyno_charge` — **symmetric reversible** |
| **One-shots** | `reach_rh_up`, `dyno_leap`, `fall` — hard-cut (no mid-flight reverse) |
| **Stills** | Grok Imagine atlas under `assets/atlas/` |

## Reversibility (PRD v3)

| Mode | Used for | Mid-turn reverse? |
| --- | --- | --- |
| **Pivot-symmetric** | stamina adjacencies + action spokes | **Yes** — shared `unitId`, `+1` base / `-1` inverse with `reverseOf` |
| **Hard-cut** | one-shots (reach / leap / fall) | **No** (AC15) |

Canonical rule: along ring order, **+1 = base** (`exact-authored`, forward);
**-1 = inverse** (`exact-reverse`, reverse, `reverseOf: base.id`). Edge ids use
dots (`stamina.hang_secure.hang_strained`) — `:` is illegal in graph ids.

`maxWaitFrames` for portals is **3** (floor for 8-frame loop, portals `[0, 4]`).

Multi-hop host path still uses `planFor` + sequential `request` until full
engine `continueTurn` + ring-intent clear on reversal land in Dart (see PRD
§4). Graph **pairs validate** and populate `inverseEdgesById` today.

## Run

```bash
cd flutter/examples/rings_climbing
flutter pub get
flutter run -d chrome   # or linux / macos
flutter test
```

## Atlas layout

```
assets/atlas/
  refs/        character_base.jpg, turnaround.jpg, character_user_source.webp
  portal/      portal_pose.jpg          ← connection contract
  loops/       hang_*, shake_out, lock_off_hold, dyno_charge
  pivots/      pivot_hang_to_* (forward-authored stills; engine plays reverse)
  oneshots/    reach_rh_up, dyno_leap, fall
```

## Production notes (from prompt kit)

1. **Portal pose** shared across hang_* loops so stamina can degrade without bridge clips.
2. **Pivots** authored forward only; engine plays reverse via shared unit (group-size-2).
3. **One-shots** end settled (compiler portal on final frame).
4. Real video: i2v from stills → trim to portals → ProRes 4444 / PNG, never H.264 for alpha.
5. See `ATLAS_PROMPTS.md` for generation order.

## Related

- PRD v3 rings + reversibility (this session)
- Dart graph: `flutter/packages/aval_graph` (`planRingArc`, `planFor`, `validateReversiblePairs`)
- Simpler compass (hard-cut only): `flutter/examples/rings_eight_way/`
