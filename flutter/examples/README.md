# AVAL Flutter examples

Flutter ports of the AVAL web examples (`../../examples/*`). Each Flutter
example is a self-contained app that reuses the shared pure-Dart packages
(`packages/aval_graph`, `packages/aval_format`) and — where decode is involved —
the Rust `aval_decode` core via `dart:ffi`.

## Parity table

The seven web examples, what each demonstrates, and the current Flutter status.

| Web example (`examples/…`) | What it demonstrates | Flutter status |
|---|---|---|
| **grass-rabbit** | The canonical reference consumer: one 1280×720/24fps `.avl` with five units (`intro`, `idle-loop`, `hover-in`, `hover-loop`, `hover-out`) and four states (`idle`/`entering`/`hover`/`exiting`). Auto-loads via `@pixel-point/aval-element`, reveals on readiness, tracks the intro one-shot, updates a state badge from `visualstatechange`, and dismisses a one-shot interaction hotspot on first hover. | **Partial — `grass_rabbit/`.** FFI decode of **all five units** (Dart↔Rust round-trip, 311 AUs), graph-driven unit playback (`intro`→`idle-loop`; hover plays `hover-in`→`hover-loop`→`hover-out` so the rabbit actually hops in), 24fps Ticker `CustomPainter`, and a hover-driven state label. Unit switching is an **approximation** — frame-accurate portal scheduling is pending `aval_player`. macOS only; opaque asset so no packed-alpha unpack. See its README. |
| **idle-hover-states** | Illustrative two-state (`idle`/`selected`) authored asset with hover/engagement bindings; asset is a placeholder not checked in. | Not started. |
| **zero-config-loop** | Zero-configuration looping asset (`orbit.avl` + `orbit.png` poster) with no author code — the element just loops; asset placeholders. | Not started. |
| **plain-html** | Framework-free HTML/CSS/JS integration with a package-aware dev server, no inline-script/style CSP exception; asset placeholders. | Not started. |
| **react-ref** | React integration kept at the app boundary: the public custom-element definition function, a typed ref, native DOM event listeners, a controlled authored `state`, and an author-owned slotted fallback — no React wrapper package. | Not started. |
| **network-integrity** | Loading one immutable hosted asset over the network with SHA-256 integrity verification and a fallback image; origin/asset/token are placeholders (not a live endpoint). | Not started. |
| **end-user-playground** | Permanent, checked-in two-state asset exercising the full public `@pixel-point/aval-element` API: hover/focus input bindings plus buttons that toggle `idle`/`engaged`. | Not started. |

## Running

Use the shared runner from `flutter/`:

```sh
./scripts/run.sh [example] [flutter-run-args…]   # default example: grass_rabbit
```

It builds the Rust decode core (`cargo build --release`) and launches the chosen
example with `--dart-define=AVAL_DECODE_LIB=<abs path to dylib>`.

## Notes

- macOS is the only target that must work at this stage.
- `aval_player` (the runtime engine package) is under active development and is
  intentionally **not** a dependency of these examples yet — they wire the graph
  and the decoder directly.

## rings_eight_way

Compass demo for **rings + turn edges** (Dart `planFor` / sequential `request`).

```bash
cd flutter/examples/rings_eight_way && flutter pub get && flutter run -d chrome
```

## rings_climbing

Advanced climbing **motion atlas** demo (Grok Imagine stills + stamina ring +
action spokes). See `rings_climbing/README.md`.

```bash
cd flutter/examples/rings_climbing && flutter pub get && flutter run -d chrome
```
