# rings_eight_way

Flutter demo for **AVAL rings + turn edges** (Dart port of the web fixture at
`fixtures/rings/v1-eight-way-facing/`).

## What it exercises

- `MotionGraphEngine.planFor(target)` — multi-hop dry run on a cyclic 8-way ring
- Sequential `request(step)` for each landing (hard-cut edges)
- Compass UI equivalent to the web `test.html`

## Run

```bash
cd flutter/examples/rings_eight_way
flutter pub get
flutter run -d chrome   # or linux / macos
```

## Packages

| Package | Role |
| --- | --- |
| `aval_graph` | rings (`planRingArc` / `planFor`), turn edges |
| `aval_flutter` | `AvalPlayerController.planFor` / `request` |
| `aval_format` | optional `.avl` parse when format rings land |

Graph install does **not** require the VP9 avl to succeed — colored placeholders
render while decode backends catch up.
