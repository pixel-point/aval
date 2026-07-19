# Grass rabbit codec comparison

This example compiles the same 1280×720, 24 fps state graph into four separate
AVAL files and lets the browser select one explicitly:

| Tab | Asset | Authored compression policy |
| --- | --- | --- |
| AV1 | `public/grass-rabbit/av1.avl` | 10-bit, CRF 48, `cpuUsed: 0`, 4×2 tiles, row multithreading, 32 threads |
| VP9 | `public/grass-rabbit/vp9.avl` | CRF 44, `deadline: best`, `cpuUsed: 0`, 8 threads |
| H.265 / HEVC | `public/grass-rabbit/h265.avl` | CRF 34, `preset: veryslow`, 8 threads |
| H.264 / AVC | `public/grass-rabbit/h264.avl` | CRF 30, `preset: veryslow` |

Every file contains the same intro, idle loop, finite hover-in, hover loop,
finite hover-out, states, edges, and input bindings. Only its video codec and
codec-specific compression controls differ. There is no compatibility copy of
an older project: `motion.json` is the single authored project.

The project compiles these exact half-open source ranges:

- `intro`: `[0, 30)`
- `idle-loop`: `[30, 100)`
- `hover-in`: `[100, 167)`
- `hover-loop`: `[167, 263)`
- `hover-out`: `[263, 311)`

The supplied `source/grass-test-with-intro.mp4` is 7,321,326 bytes and has
SHA-256 `546acee64cc36c13f8765e215a0a20fb5742026c57364c59560fa86bb68988b1`.
The source file is not modified during compilation.

CRF scales are encoder-specific rather than directly comparable quality
scores. These values were selected by matching the codec outputs against the
H.264 CRF 30 baseline on the independently encoded graph units.

## Compile and run

From the repository root:

```sh
npm install
npm run compile:grass-rabbit-codecs
npm run grass-rabbit-codecs
```

The package-level compiler command is:

```sh
avl compile motion.json --out public/grass-rabbit --force
```

Compilation writes `av1.avl`, `vp9.avl`, `h265.avl`, `h264.avl`, and
`build.json` under `public/grass-rabbit/`. The checked-in build report is the
page's source of truth for exact normalized encoding objects, codec strings,
MIME types, integrity values, and file byte counts. The page fetches that
report instead of duplicating generated metadata in JavaScript.

The FFmpeg lines shown by the page are labelled **per-unit equivalent**. They
make the compression controls easy to compare, but they are not standalone
container production commands. AVAL packages elementary payloads for each
closed graph unit: `-tag:v`, `-movflags faststart`, and MP4/WebM container
output are therefore not AVAL encoding knobs. `-an` is inherent because AVAL
does not carry the source audio stream.

## Browser selection contract

The page checks the four codec strings sequentially through
`createSourceSupportProbe`, using the exact 1280×720 coded and display size and
limited-range BT.709 color configuration. Each result is one of:

- `supported`: the tab may mount a player;
- `unsupported`: the panel shows `This codec is not supported in your browser.`;
- `unavailable`: the panel shows `Codec support could not be checked in your browser.`.

The first supported codec in authored order (AV1, VP9, H.265, H.264) is loaded
initially. If no result is supported, AV1 remains selected with its status
message. Unsupported and unavailable selections never create `aval-player`.

The probe is a preflight rather than proof that decoding will start. After a
positive probe, the page requires `aval-player.prepare()` to succeed. A rejected
`AvalPlaybackError` with `unsupported-profile`, or the matching fatal `error`
event, reclassifies that codec as unsupported. Other fatal playback failures
remain distinct and show `This codec could not be played in your browser.`;
nonfatal static policy readiness and retained candidate diagnostics do not
activate the page's error UI. Network, integrity, and malformed-source failures
are never mislabelled as codec support failures.

To inspect that example-owned unsupported state even on a machine that exposes
every decoder, append `?simulateUnsupported=h265` (or another codec id) to the
local example URL. The default URL always uses the browser probe without an
override.

Tabs use the ARIA tab/tabpanel pattern. Arrow keys, Home, and End move focus;
Enter, Space, or a pointer click activates the focused tab. On activation the
page awaits disposal of the prior player before removing it, then mounts one
new player containing exactly one `<source>`. Its URL, `type`, and `integrity`
all come from `build.json`. Repeated rapid activations are latest-wins.

For browser tests and local inspection, the page exposes:

```js
await window.grassRabbitCodecs.ready;
await window.grassRabbitCodecs.activate("vp9");
window.grassRabbitCodecs.supportSnapshot();
window.grassRabbitCodecs.activePlayer;
```

Run the focused checks from the repository root:

```sh
npm run test:grass-rabbit-codecs
npx vitest run --config vitest.m9.config.ts tests/grass-rabbit-codecs/artifacts.test.ts
```

The browser script runs Chromium and WebKit in separate Playwright processes so
their WebCodecs and GPU resources are retired between engine passes. Its Vite
fixture uses port 4178 by default, independently of the manually opened demo.
