# Grass rabbit hover example

This example compiles the supplied 1280×720, 24 fps video into separate AV1,
VP9, H.265, and H.264 `.avl` files. Each file contains the same five exact
half-open frame ranges:

- `intro`: `[0, 30)`
- `idle-loop`: `[30, 100)`
- `hover-in`: `[100, 167)`
- `hover-loop`: `[167, 263)`
- `hover-out`: `[263, 311)`

The authored canvas remains 1280×720, while each encoded rendition is 640×360.
The page presents the selected rendition at exactly 640×360, centered in a
pure-black viewport. AVAL evaluates the declared families in its fixed AV1,
VP9, H.265, then H.264 order regardless of DOM order. Hover or focus the animation to enter the `hover` state;
leave or blur it to return to `idle`.

The `intro` is an initial one-shot attached to the `idle` state. It plays once
from frames 0 through 29, continues directly into `idle-loop`, and does not
replay when `hover-out` returns to idle. Hover intent received during the intro
is queued until that one-shot finishes.

The enter and exit ranges are finite transient `entering` and `exiting`
states. If engagement ends while `hover-in` is still playing, that range
finishes and proceeds directly to `hover-out`; no `hover-loop` frame is played.
If engagement remains active, `hover-in` proceeds to `hover-loop`, which loops
until engagement ends.

`motion.json` points directly to the color-corrected source at
`source/grass-test-with-intro.mp4`. The compiler leaves that source file untouched,
decodes the authored ranges, and re-encodes them without shortening or blending.
The checked-in bundle uses these settings:

- AV1: 8-bit, CRF 36, `cpuUsed: 6`, 2×2 tiles, row multithreading, 8 threads
- VP9: CRF 38, `deadline: good`, `cpuUsed: 4`, 8 threads
- H.265: CRF 30, `preset: medium`, 8 threads
- H.264: CRF 26, `preset: medium`

The normalized encoding settings, exact codec metadata, integrity hashes, and
tool invocations are recorded in `public/grass-rabbit/build.json`, while the
authored dimensions and ranges remain authoritative.

Each `.avl` contains only motion access units and graph metadata. This page
does not supply an external fallback image, so the black page remains black
until the first decoded animation frame is ready.

From the repository root:

```sh
npm install
npm run compile:grass-rabbit
npm run grass-rabbit
```

For an automated local check, run `npm run test:grass-rabbit`. It opens a
headed Chromium instance so the WebGL/WebCodecs interactive path is exercised,
then verifies the one-shot intro, exact 640×360 centered layout, and both hover
transitions.

The compiled bundle is checked in at `public/grass-rabbit/` with one `.avl`
per codec and its `build.json` report, so recompilation is only necessary after
changing the supplied video or `motion.json`.
