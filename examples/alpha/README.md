# aval-alpha playback example

Run `npm run alpha:fixtures`, then `npm run alpha` from the repository root.
Open http://127.0.0.1:4188. Switch codec and background to inspect transparency;
Run checks exercises decoded pixels, fallback, seeking, loops and cleanup.

`main.ts` uses child `<source>` elements. `checks.ts` is a diagnostic harness
and is never imported by the distributed runtime. Generated calibration media
lives in `.cache/alpha/media` and is reproducible from `scripts/alpha/generate-fixtures.mjs`.

For application integration and compiler controls, see
[`@pixel-point/aval-alpha`](../../packages/alpha/README.md).
