# Rendered Motion Experiment

An open, web-only experiment for short pre-rendered animations with seamless partial loops, user-defined states, and deterministic interaction transitions.

The project is intentionally unnamed. “Rendered motion” and `.rma` are descriptive prototype labels, not product branding.

## Current milestone

M1 proves the core playback architecture in a real browser:

- browser-generated H.264 Annex B access units;
- one continuously configured `VideoDecoder`;
- exact rational timestamps assigned to every repeated iteration;
- no seek, reset, configure, or flush at loop seams;
- a realtime decoded presentation lead; and
- 2,002 machine-tagged decoder outputs across exactly 1,000 seams.

The compiled container, user-defined state graph, reversible texture cache, FFmpeg compiler, packed alpha, range loader, and custom element follow in later milestones.

## Run it

Requirements: Node.js 22.12 or later and a browser with WebCodecs. The experiment probes H.264 Annex B first and labels VP8 only as a scheduler fallback.

```bash
npm install
npm run dev
```

Then open the displayed localhost URL. The page starts the realtime loop automatically and includes the 1,000-seam burst test.

## Verify it

```bash
npm run typecheck
npm run test:unit
npm run build
npm run test:browser
```

Install the Chromium test runtime first if it is not already cached:

```bash
npx playwright install chromium
```

## Documentation

- [Format design](docs/superpowers/specs/2026-07-11-web-rendered-motion-format-design.md)
- [Implementation plan](docs/superpowers/plans/2026-07-11-web-rendered-motion-implementation.md)
- [M1 browser evidence](docs/evidence/2026-07-11-m1-continuous-loop.md)

Headless browser results prove decoded ordering and lifecycle behavior, not physical display scan-out continuity. Display certification requires separate headed device profiles and external observation.
