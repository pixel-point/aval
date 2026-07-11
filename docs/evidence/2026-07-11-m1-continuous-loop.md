# M1 Continuous Loop Evidence

**Date:** 2026-07-11

**Milestone:** In-memory opaque WebCodecs loop

**Result:** Pass

## Environment

- Host: Apple M4, arm64
- OS: macOS 15.6 (24G84)
- Automated browser: Playwright Chromium 149.0.7827.55, headless
- Visual verification browser: Headless Chrome 150.0.0.0 through `agent-browser`
- Context: `http://127.0.0.1:4173`, recognized by the browser as secure

## Codec Evidence

- Requested and selected codec: `avc1.42E020`
- Packaging: H.264 Annex B
- Encoder and decoder configuration probes: supported
- Real encode/decode allocation: passed
- Encoder-provided decoder description: absent, as required for Annex B
- First stress-unit key access unit: 1,258 bytes
- Observed NAL unit types: SPS `7`, PPS `8`, IDR `5`
- Stress source outputs: one key access unit followed by one delta access unit

The browser-generated unit is an experimental fixture only. It is not a deterministic production encoder or a frozen delivery profile.

## 1,000-Seam Stress Result

The two-frame unit was submitted for 1,001 iterations with new global rational timestamps.

| Measurement | Result |
|---|---:|
| Submitted chunks | 2,002 |
| Decoder outputs | 2,002 |
| Machine tags validated | 2,002 |
| Iteration seams | 1,000 |
| Media duration represented | 66.733333 s |
| Wall time | 369.5 ms |
| Measured throughput | 180.6× realtime |
| Decoder configurations | 1 |
| Decoder resets | 0 |
| Boundary flushes | 0 |
| Terminal flushes | 1 |
| Decoder errors | 0 |
| Open frames after disposal | 0 |

The one terminal flush occurred only after all 2,002 chunks had been submitted. No decoder lifecycle operation occurred at any loop seam.

## Realtime Observation

The separate 24-frame, 30 fps orbit fixture drew more than 60 loop iterations into its canvas during the browser gut check with:

- one decoder configuration;
- zero boundary flushes or resets;
- zero presentation-ring underflows; and
- a steady decoded lead of seven to eight frames.

Playwright independently asserted multiple realtime canvas-drawn seams, pause/resume behavior, zero presentation-ring underflow, and zero browser console/page errors. These counters describe browser scheduling and canvas draws; they do not claim that every intermediate draw was scanned out to the physical display.

## Automated Verification

```text
npm run typecheck     pass
npm run test:unit     60 tests pass
npm run build         pass; playground bundle 13.43 KiB gzip
npm run test:browser  3 Chromium tests pass
```

## Claim Boundary

This milestone proves access-unit replay, rational timestamp replacement, decoded content order, lifecycle counters, bounded queue behavior, and frame cleanup in the browser. Headless timing is not physical display certification. It does not prove compositor scan-out continuity, Safari behavior, packed alpha, state transitions, the final H.264 compiler profile, or the compiled container.
