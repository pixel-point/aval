# M5 Opaque AVC Compiler and Dedicated Worker Evidence

**Date:** 2026-07-11

**Milestone:** Deterministic local opaque AVC compilation and dedicated-worker decode

## Result

M5 passes its implementation gate. A caller-installed FFmpeg/libx264 toolchain
now compiles local rendered video, PNG sequences, or strict multi-state projects
into deterministic `avc-annexb-opaque-v0` assets. The compiler validates source
timing and opacity, materializes one canonical RGBA spool, encodes every unit as
an independent closed GOP, and accepts output only after the shared strict AVC
inspector proves the frozen `avc1.42E020` syntax and dependency contract.

The web player exposes a dedicated module-worker decoder with one configured
`VideoDecoder`, bounded coded-sample and transferred-frame credit, exact
rational timestamps, generation cancellation, request watchdogs, and explicit
frame ownership. Supported Chromium decoded the checked path and reversible
fixtures with no boundary configure, reset, or flush.

The prototype `.rma` suffix and `@rendered-motion/*` scope remain private
descriptive labels, not a registered public format or product name.

## Captured Environment

- macOS 15.6 (24G84), Darwin 24.6.0, arm64
- Node.js 25.8.1
- TypeScript 7.0.2
- Vitest 4.1.10
- Playwright 1.61.1
- bundled Chromium 149.0.7827.55, exact `avc1.42E020` support: **supported**

## Toolchain Provenance

The reviewed fixtures were produced with:

- FFmpeg 8.1.2_1 with GPL and libx264 enabled
- FFmpeg executable SHA-256:
  `329fa7360b28a067a0cd7281474bb18cd868932d5173646a674466bcb56d6e93`
- FFmpeg version-output SHA-256:
  `98f2da65e4b3e39aa6ac74848582be422751d8f52176cf810eceb94bbcaa78d1`
- FFmpeg configuration SHA-256:
  `8470f6e5d1c91c01f1228e91aa8827bea05a7e8a39c8dedefdb778716bdc1aec`
- FFmpeg encoder-list SHA-256:
  `38b11441f5ffe17fd32539030ba9290b81e730878bb0cffe1af5084e2b7b8879`
- effective encoder calibration SHA-256:
  `88777af5e4d125466407cc218f088cf52a670ca3c3590365d2865f1a00d339c9`
- FFprobe 8.1.2, executable SHA-256:
  `841ab2259a55e5c5e44c5851890867d48750ff1e7cfa92b5fbed91445a493128`
- FFprobe version-output SHA-256:
  `8316221740e891c1f9d08d30a9a45059af9f1ec96741423eee3ae0c7721d9cec`

The normalized machine-independent record in
`fixtures/conformance/m5/provenance.json` also records every source frame,
exact redacted argv, source probe, normalization, opacity audit, unit/static
digest, continuity result, rendition inspection, and per-unit constraint-set
canonicalization. Build reports with absolute local paths are intentionally not
checked in.

## Reviewed Fixtures

| Fixture | Bytes | Whole-file SHA-256 | Coverage |
| --- | ---: | --- | --- |
| `opaque-loop.rma` | 5,833 | `dcda9b3afbd9e56c5aec4c71b24208bec94bef98d6046656ba837a4bc322ca49` | Two-frame loop and generated static fallback |
| `opaque-path.rma` | 11,769 | `edec42aad4ed140404caf895093fc3a986fbfdfaaf28f720cb47e918bf1308e0` | Intro, 1,001 body occurrences, locked bridge, target body, two statics |
| `opaque-reversible.rma` | 17,513 | `642e5d60a461f3f0d0e53be9c1a238a3f5dfdad23f4db19eb2c12a94a6f13e8a` | Reversible forward unit, exact inverse metadata, finish, cut, three statics |

Each of the three projects was compiled from its original tree, from a
semantically reordered relocated tree, and again after deleting the output in
a separate fresh relocated tree. All nine builds reproduced the corresponding
checked bytes and SHA-256 exactly. All internal unit and static SHA-256 values
were recomputed during compiler validation and fixture provenance generation.
Runtime/network digest enforcement remains M7 work.

## AVC and Compiler Proof

The format package has one Annex-B tokenizer, one raw AUD grouping owner, one
SPS/PPS/slice implementation, and one final strict rendition inspector. The
M5 AVC suite passed 64 tests across seven files, including deterministic
truncation at every physical NAL-component byte cut and every parsed
SPS/PPS/slice-header bit boundary, 2,048 seeded mutations, hostile NAL grammar,
parameter-set stability, closed-GOP dependency checks, and incremental worker
inspection.

The compiler suite passed 130 tests across 25 files. Its ten-test real-tool
matrix covered CFR video with intro, VFR normalize-hold, looping PNG input,
locked/reversible/finish/portal/cut graph metadata, deterministic continuity,
byte-exact unpack/repack, cancellation of a real FFmpeg descendant tree, and
bounded process output. Targeted mutations of actual libx264 output changed a
P slice to a B slice, inserted an extra IDR, and changed a later SPS; all three
were rejected for their intended strict-profile reason.

Other hostile tests cover native transparency (including one sparse `pal8`
transparent pixel before 256→32 downscaling), declared-duration windows,
source mutation, file and directory bounds, malformed project/AVC/PNG data,
subprocess timeout/output limits, redaction of hostile tool stderr,
interrupt-driven validation/unpack cleanup, private-work cleanup, report-size
limits, no-clobber publication, force rollback, publication races, and
development-build supersession.

## Dedicated Worker Browser Proof

Chromium ran three M5 worker tests successfully:

- **Path:** 2,008 validated outputs from intro, 1,001 two-frame idle-body
  occurrences, locked bridge, and target body. Metrics were 2,008 accepted,
  submitted, output, delivered, and released frames; one configure; zero reset,
  flush, boundary flush, stale frame, closed-on-error frame, worker error, or
  leaked client frame. Submission used 168 batches of at most 12 frames.
- **Reversible unit:** the six-frame `state-change` unit decoded twice as two
  independently keyed forward occurrences, producing and releasing 12 frames
  under the same one-configure/zero-reset/zero-flush contract.
- **Negative lifecycle:** unsupported configuration, malformed sample, worker
  crash, request watchdog, `AbortSignal`, generation cancellation, pending-wait
  disposal, and idempotent disposal all produced the intended typed failure and
  left zero open client frames.

The worker unit suite separately passed 29 tests, including late-frame closure,
non-frame event-sink failure, request watchdog expiry, unexpected disposal,
credit accounting, generation supersession, and teardown on every ownership
path.

## Repository Gate

The final gate completed successfully:

```text
npm run typecheck       passed across all workspaces, worker target, and tests
npm run test:unit       78 files, 717 tests passed
npm run build           graph, format, compiler, player, and playground passed
npm run test:browser    10 Chromium tests passed
npm audit --audit-level=high
                        0 vulnerabilities
npm pack --dry-run -w @rendered-motion/format
                        74 files inspected; no stale AVC helper
npm pack --dry-run -w @rendered-motion/compiler
                        280 files inspected; CLI present; no stale report writer
git diff --check        passed
```

A final read-only contract and maintainability audit confirmed one AVC parser,
one project normalizer, centralized FFmpeg argv construction, one canonical
JSON owner, one poster encoder, one SHA-256 accumulator, bounded incremental
directory scans, cancellation through file/spool work, atomic publication
rollback, and no graph scheduler policy inside the decoder worker.

## Legal and Claim Boundary

M5 proves deterministic local opaque AVC compilation with the recorded
toolchain, compiler-generated static representations, frozen-profile Annex-B
unit independence, and sequential dedicated-worker decode in the supported
browser above. Headless ordering and framebuffer behavior do not certify
physical display scan-out.

M5 does not prove packed alpha/compositing, full independent PNG decoding,
runtime or network authenticity, graph-to-decoder scheduling/readiness,
active reversal presentation, range loading, shared page budgets, the public
custom element, or cross-device/browser certification. Those remain M5.5
through M9.

H.264/AVC deployment and source/derived media may carry patent, codec-license,
content-license, and distribution obligations. A caller-installed encoder does
not remove them; product-specific legal review is required before release.
