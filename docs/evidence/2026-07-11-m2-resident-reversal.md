# M2 Resident Reversal Evidence

**Date:** 2026-07-11

**Milestone:** Resident reversible interaction on the web

## Result

M2 passes its implementation gate. A real Chromium session prepared a bounded
WebGL2 resident cache, measured both endpoint recovery paths before enabling
interaction, reversed the live cached clip on the next content tick, recovered
either forward-decoded body behind an eight-frame runway, and retained the
newest semantic intent through a mid-clip WebGL context loss.

This is canvas scheduling and framebuffer evidence. It does not certify
physical display scan-out or every browser/device profile.

## Captured Environment

- macOS 15.6 (24G84)
- Headless Chrome 149.0.7827.55
- Playwright 1.61.1
- Node.js 25.8.1
- 256 × 256 synthetic opaque RGBA fixture at 30 fps
- H.264 Annex B, `avc1.42E020`

The browser selected H.264 rather than the VP8 fallback. The three independent
units contained 16 source-body frames, 12 reversible-clip frames, and 16
target-body frames. All 44 encoder outputs were decoded and tag-validated. Each
unit began with an independently usable SPS/PPS/IDR access unit (NAL types
7, 8, and 5).

## Resident Allocation

The frozen plan contained 28 unique layers: eight source-runway frames, twelve
clip frames, and eight target-runway frames.

| Allocation | Bytes |
| --- | ---: |
| Resident RGBA layers | 7,340,032 |
| Three streaming RGBA layers | 786,432 |
| Estimated GPU allocation including 25% overhead | 10,158,080 |
| Reused CPU staging frame | 262,144 |
| Total tracked working set | 10,420,224 |

The planner rejects dimensions, layers, clip bytes, resident bytes, or the
64 MiB total cap before WebGL allocation. The renderer and player both enforce
exactly three streaming slots.

## Recovery Readiness

Readiness creates a fresh decoder for each endpoint sequentially, starts at the
frame-zero key access unit, discards decoded runway duplicates `[0, R)`, and
waits for continuation frame `R`. The required budget is measured elapsed time
through RGBA copy and a real streaming-texture upload, rounded up to content
frames, plus one safety frame.

In the captured run:

| Endpoint | First continuation | Elapsed | Required with safety | Runway |
| --- | ---: | ---: | ---: | ---: |
| `resting` | 8 | 1.7 ms | 2 frames | 8 frames |
| `engaged` | 8 | 1.2 ms | 2 frames | 8 frames |

These timings are one headless run, not portable performance constants. The
page's readiness gate uses its current preflight measurements and refuses
interaction if either result exceeds its runway.

## Interaction and Lifecycle Evidence

- A forward live-player clip reversal drew clip frame `k - 1` immediately
  after frame `k`; synchronized framebuffer decoding confirmed the live canvas
  contained that same reversible-clip frame.
- The recovered stable body was also read back from the live player canvas and
  matched its reported body content frame.
- Inverse intent during a delayed runway recovery continued through unused
  resident runway layers without a held frame or underflow.
- The interactive decoder stayed at one configuration with zero runtime reset,
  boundary flush, or flush calls. Preparation-only finite decoders may use a
  terminal drain before interaction begins.
- A context loss triggered during an active forward clip rebuilt all 28 layers,
  preserved the requested `engaged` intent, and converged to `engaged` after
  restoration. The replaced session reported a disposed decoder, zero open
  frames, a disposed renderer, and zero allocated layers.
- Visibility, explicit pause, accelerated manual ticks, duplicate stress calls,
  stale path generations, and dispose-during-copy ownership races have focused
  regressions.

## Accelerated Cached-Layer Proof

The deterministic proof performed 1,000 direction changes around adjacent clip
frames 5 and 6. It issued and validated 1,021 resident draws by decoding a
machine tag from every WebGL framebuffer readback, with zero adjacent-frame
failures. The captured run completed in 394.8 ms.

This proof deliberately pauses the realtime players and uses a separate pure
controller against the same resident renderer. It proves cached layer ordering
and framebuffer identity, not 1,000 realtime decoder recoveries or physical
display presentation.

## Verification Gate

The final gate completed successfully:

```text
npm run typecheck       passed
npm run test:unit       15 files, 167 tests passed
npm run build           passed; playground 33.43 kB gzip JavaScript
npm run test:browser    7 Chromium tests passed
npm audit --audit-level=high
                        0 vulnerabilities
git diff --check        passed
```

The browser suite recorded no console errors or uncaught page errors. It also
kept all M0/M1 smoke, realtime seam, and 1,000-loop-seam checks green.

## Claim Boundary

M2 demonstrates the core web technique for one arbitrary endpoint pair. It
does not yet freeze a binary format, expose the public user-defined state
graph, compile creator video, support alpha, arbitrate page-wide memory, or
provide the final per-state reduced-motion/static fallback. It also does not
certify mobile and physical scan-out continuity. Those remain later milestones.
