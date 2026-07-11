# Rendered Motion Experiment

An open, web-only experiment for short pre-rendered animations with seamless partial loops, user-defined states, and deterministic interaction transitions.

The project is intentionally unnamed. “Rendered motion” and `.rma` are descriptive prototype labels, not product branding.

## Current milestones

M1 proves continuous partial-loop scheduling in a real browser:

- browser-generated H.264 Annex B access units;
- one continuously configured `VideoDecoder`;
- exact rational timestamps assigned to every repeated iteration;
- no seek, reset, configure, or flush at loop seams;
- a realtime decoded presentation lead; and
- 2,002 machine-tagged decoder outputs across exactly 1,000 seams.

M2 adds one arbitrary reversible endpoint pair:

- a bounded, deduplicated WebGL2 `RGBA8` texture-array cache;
- source and target restart runways with explicit memory accounting;
- one forward decoder whose obsolete generations are closed safely;
- adjacent-frame reversal on the next content tick;
- recovery of both endpoint bodies before their eight-frame runways end;
- context-loss and visibility-safe logical-time freezing; and
- 1,000 cached resident reversal draws with 1,000+ framebuffer tag reads.

The general user-defined graph, compiled container, FFmpeg compiler, packed
alpha, range loader, and custom element follow in later milestones. M2 accepts
creator-defined endpoint names internally but deliberately does not expose the
public multi-state graph planned for M3.

## Run it

Requirements: Node.js 22.12 or later and a browser with WebCodecs. The experiment probes H.264 Annex B first and labels VP8 only as a scheduler fallback.

```bash
npm install
npm run dev
```

Then open the displayed localhost URL. The page includes the hover/focus
reversal demo, resident-cache diagnostics, the 1,000-reversal GPU proof, and
the original 1,000-seam loop proof.

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
- [M2 design addendum](docs/superpowers/specs/2026-07-11-m2-resident-reversible-interaction-design.md)
- [M2 implementation plan](docs/superpowers/plans/2026-07-11-m2-resident-reversible-interaction-implementation.md)
- [M1 browser evidence](docs/evidence/2026-07-11-m1-continuous-loop.md)
- [M2 browser evidence](docs/evidence/2026-07-11-m2-resident-reversal.md)

Headless browser results prove decoded ordering and lifecycle behavior, not physical display scan-out continuity. Display certification requires separate headed device profiles and external observation.
