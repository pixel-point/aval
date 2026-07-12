# M5 opaque AVC conformance fixtures

These checked-in `.rma` files are deterministic output from the M5 compiler
using tiny, procedurally generated, fully opaque PNG sequences. The source
license is recorded in `fixtures/compiler/m5/source/ASSET-LICENSE.md`.

`opaque-loop.rma` covers a two-frame loop. `opaque-path.rma` covers an initial
one-shot, two body loops, a locked bridge, a user event, and compiler-generated
per-state static fallbacks. `opaque-reversible.rma` adds a forward-authored
reversible clip, its exact inverse route, finish and cut routes, and three
fallbacks. `provenance.json` records exact source, unit, static, and whole-file
digests; native probes and normalization; continuity; the reviewed toolchain;
and every executed FFmpeg/FFprobe argv with local paths redacted.

Regenerate from the repository root with the reviewed tool pair on `PATH`:

```sh
npm run build -w @rendered-motion/graph
npm run build -w @rendered-motion/format
npm run build -w @rendered-motion/compiler
node fixtures/compiler/m5/source/generate.mjs
node packages/compiler/dist/cli.js compile fixtures/compiler/m5/source/loop.json --out fixtures/conformance/m5/opaque-loop.rma --force
node packages/compiler/dist/cli.js compile fixtures/compiler/m5/source/path.json --out fixtures/conformance/m5/opaque-path.rma --force
node packages/compiler/dist/cli.js compile fixtures/compiler/m5/source/reversible.json --out fixtures/conformance/m5/opaque-reversible.rma --force
node fixtures/conformance/m5/update-provenance.mjs
```

Regeneration is an intentional review operation: the binary bytes and every
digest in `provenance.json` must be updated together, and both assets must pass
`rma validate`. Moving either source tree to another absolute path must still
produce byte-identical assets.

## Claim boundary

These fixtures prove the frozen M5 `avc-annexb-opaque-v0` compiler profile,
independent unit starts (including a reversible unit used as an ordinary
forward stream), deterministic static PNG generation, and the dedicated
worker's sequential decode input. They do not claim packed alpha, runtime
range/digest loading, graph-to-decoder scheduling, active reversal, polished
authoring, or cross-browser certification; those remain later milestones.
