# Performance and budgets

The page manager accounts for decoders and tracked bytes across players. A host
may configure an explicit lower resource policy; there is no implicit
small-asset byte ceiling. A player reserves before allocation, publishes exact
category ownership, and rejects when an actual or configured resource boundary
is reached. Resource rejection is terminal and reported to the consumer; hidden
or reduced-motion players release animation resources as a
nonfatal policy condition. None of these paths manipulates application DOM.

Authors own the cost of unit length, canvas/rendition dimensions, and bitrate.
Use authored restart runways and measure the real target devices.
The runtime never downscales or shortens a valid asset to fit. `getDiagnostics()` is
bounded and suitable for support logs, but verbose tracing, screenshots,
synchronous readback, and devtools perturb timing benchmarks.

Normal playback configures the selected decoder and fills the six-frame live
presentation ring before revealing frame zero. It does not run the exhaustive
all-routes decoder rehearsal during page startup. `runAllRoutesReadiness()` and
the certification application retain that full proof for an explicit,
dedicated development or CI candidate; it must not run in the background on a
live candidate because it owns decoder generations and probe presentation.

CI performance comparisons are advisory. A named scheduling certificate
requires at least 300 post-warm-up outputs at 1.5× authored real time plus exact
deadline and boundary rules. Heap, RSS, GPU-process memory, and energy are
observational; explicit ownership counters are the leak gate.

## JavaScript delivery gates

The release authority measures the exact production output created for a
consumer that imports `@pixel-point/aval-element/auto`. The complete working
player—entry chunk, one lazy runtime chunk, and the external decoder worker—must
be at most **60,000 bytes with Brotli quality 11**. This aggregate is the bytes
the consumer must actually ship; source-module totals and per-boundary gzip
figures are diagnostic only.

`scripts/performance/measure-m8-bundles.mjs` builds that consumer with pinned
Vite 8.1.4/Oxc, verifies that the worker is self-contained, requires exactly one
lazy runtime boundary, rejects duplicated module ownership, and enforces the
aggregate cap. The verified 2026-07-17 build measures:

- entry chunk: 13,376 Brotli bytes;
- lazy runtime chunk: 40,554 Brotli bytes;
- decoder worker: 992 Brotli bytes;
- complete working player: **54,922 Brotli bytes**.

That leaves 5,078 bytes of headroom under the release cap. The exact release
candidate must be measured again; these figures describe the current checked
workspace, not a substitute for candidate evidence.
