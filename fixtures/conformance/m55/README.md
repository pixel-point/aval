# M5.5 all-routes opaque conformance fixture

`opaque-all-routes.rma` is deterministic output from the M5 compiler using 30
procedurally generated, fully opaque 32×32 PNG frames. It contains two AVC
renditions (`opaque.1x` at 32×32 and `opaque.0.5x` at 16×16) and one compact
graph that covers the complete M5.5 route matrix:

- an initial one-shot into a body loop;
- idle and hover loops connected by one resident reversible unit in both
  directions, with six-tick restart runways at both endpoints;
- a portal into a one-frame locked bridge and a finite target body;
- a transitionless finish into a one-frame held body;
- a cut whose six-tick target runway shares idle/default frame keys with the
  reversible endpoint cache;
- a transitionless portal from the held body; and
- a valid loading-to-done follow-on while the idle-to-loading bridge is locked.

Every source frame contains a redundant six-bit marker made from six 4×8
grayscale tiles. A full-rank transformed Gray code changes exactly three tiles
between consecutive source frames. Tolerant readback can therefore recover the
exact source ordinal after lossy AVC conversion, while any authored branch
changes at most six tiles and remains within the compiler's seam ratio.

`provenance.json` records normalized, path-free source-project, generator,
source-frame, unit, static, manifest, complete-asset, compiler, and tool hashes;
strict AVC inspection summaries; continuity results; and path-redacted native
tool invocations. The source license is recorded in
`fixtures/compiler/m55/source/ASSET-LICENSE.md`.

Regenerate from the repository root with the reviewed M5 FFmpeg/FFprobe pair
on `PATH`:

```sh
npm run build -w @rendered-motion/graph
npm run build -w @rendered-motion/format
npm run build -w @rendered-motion/compiler
node fixtures/compiler/m55/source/generate.mjs
node packages/compiler/dist/cli.js compile fixtures/compiler/m55/source/all-routes.json --out fixtures/conformance/m55/opaque-all-routes.rma --force
node fixtures/conformance/m55/update-provenance.mjs
npx vitest run packages/compiler/test/m55-fixture.test.ts
npm run rma -- validate fixtures/conformance/m55/opaque-all-routes.rma
```

Regeneration is an intentional review operation. The fixture test compiles the
project twice and requires byte identity; on the recorded tool hashes it also
requires identity with the checked `.rma`. Binary and provenance changes must
be reviewed together.

## Claim boundary

This fixture proves deterministic authoring/compilation metadata and the
strict opaque AVC inputs required by M5.5. The fixture alone does not prove
runtime scheduling, browser decode support, WebGL presentation, active
reversal timing, static recovery, or display scan-out continuity; those claims
require the M5.5 fake-adapter and real-browser gates.
