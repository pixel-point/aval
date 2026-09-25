# @pixel-point/aval-alpha

A small transparent-video player with no runtime dependencies. An ordinary AV1,
VP9, HEVC, or H.264 video contains an RGB picture and a grayscale coverage mask
in the same frame. The browser decodes it; one WebGL texture and shader reconstruct
transparent pixels. Color and alpha share the same media clock.

This is a new 0.1 preview package, independent of the interactive AVAL player.
It does not require WebCodecs or ship a demuxer, worker, or WASM decoder. Codec support
comes from the browser and device. Software **libx265** produces the HEVC files;
Apple's native HEVC-alpha extension and VideoToolbox are not required.

Dedicated [React](../alpha-react/README.md) and [Svelte](../alpha-svelte/README.md)
packages use this same player and an optional shared `./adapter` entry for
reactive configuration and lifecycle. Plain JavaScript users do not download
that binding or either framework. See the [framework contract](../../docs/alpha/frameworks.md).

## Tested compatibility

The [device and browser matrix](../../docs/alpha/browser-support.md) records the
tested iPhone, iPad, Pixel, Galaxy, Windows and macOS configurations, exact browser
versions, and AV1/VP9/HEVC/H.264 results. It distinguishes the initial qualification
from the fixed-build retests and documents native codec limitations. H.264 passed
on every listed configuration.

## Compile

Install the player and the compiler (the alpha command requires compiler 1.1.0
or later):

```sh
npm install @pixel-point/aval-alpha
npm install --save-dev @pixel-point/aval-compiler@^1.1.0
npx avl alpha motion.mov --out public/motion
```

The default encodings are AV1 (SVT-AV1), VP9, HEVC, and H.264. FFmpeg and FFprobe
must be installed on the **compiler machine**, with the requested encoders.
Select fewer codecs or use a configuration file to control each one:

```sh
npx avl alpha motion.mov --codecs h265 \
  --crf 24 --preset veryslow --out public/motion

npx avl alpha 'frames/frame-%04d.png' \
  --fps 30 --frames 120 --codecs av1,vp9,h265,h264 --out public/motion
```

Compilation produces `av1.mp4`, `vp9.webm`, `h265.mp4`, `h264.mp4`,
`sources.json`, `sources.js`, `sources.html`, and an offline `build.json` report.
Existing output directories are refused. A failed compile removes its staging
files. `sources.html` contains ready-to-copy markup; `sources.js` contains the
same inlineable descriptor array. Playback does not fetch `build.json` or require
a sidecar request.

## Use child sources

Import and explicitly register the optional element in your application bundle:

```js
import { defineAvalAlphaElement } from '@pixel-point/aval-alpha/element';

defineAvalAlphaElement();
```

Copy the compiler's generated markup. Each source has its own MIME/codec and
layout. For a 640×360 clip, vertical packing looks like this:

```html
<aval-alpha autoplay loop style="width:640px;height:360px"
            role="img" aria-label="Animated transparent illustration">
  <source src="/motion/av1.mp4" type="video/mp4"
          data-layout="640 728 0 0 640 360 0 368 640 360">
  <source src="/motion/vp9.webm" type="video/webm"
          data-layout="640 728 0 0 640 360 0 368 640 360">
  <source src="/motion/h265.mp4" type="video/mp4"
          data-layout="640 728 0 0 640 360 0 368 640 360">
  <source src="/motion/h264.mp4" type="video/mp4"
          data-layout="640 728 0 0 640 360 0 368 640 360">
</aval-alpha>
```

Use the actual codec declarations emitted by your compilation. The numbers above
illustrate the layout, not a codec level to copy into arbitrary assets.
`data-layout` is ten space-separated integers: packed width/height, color x/y/w/h,
then alpha x/y/w/h. Width and height are the **decoded packed** dimensions.

Sources are tried in authored order. Unsupported types are skipped; load errors,
a startup timeout, a dimension mismatch, or a failed first draw advance to the
next candidate. Only one candidate is assigned to the video at a time. The browser
may fetch bytes from a rejected candidate; later alternatives are not preloaded.
This is ordered fallback, not adaptive bitrate switching.

```js
const element = document.querySelector('aval-alpha');
element.addEventListener('error', (event) => showPoster(event.detail));
element.addEventListener('autoplayblocked', () => showPlayButton());
await element.ready;               // First transparent frame, even without autoplay
await element.play();
element.pause();
await element.seek(0.5);            // Seconds
```

Install error listeners before registration when catching initial upgrade errors
is important. `ready`, `error`, and `autoplayblocked` are direct element events;
errors are also available through the rejected readiness/play/seek promise.
Removing the element releases its owned media and GPU resources. Reconnecting
starts a new player. Changing child sources or assigning `element.sources`
replaces the player; use a new array to update programmatic sources. Set
`element.sources = undefined` to return to child sources. Changing `loop` updates
playback without reloading. Importing either entry is safe during SSR; call the
registration function only in the browser.

## Use a canvas directly

```js
import { createAvalAlpha } from '@pixel-point/aval-alpha';
import sources from './generated/sources.js';

const player = createAvalAlpha(document.querySelector('canvas'), {
  sources, autoplay: true, loop: true,
  timeoutMs: 15000,
  onError: (error) => showPoster(error),
  onAutoplayBlocked: () => showPlayButton()
});
await player.ready;
console.log(player.source);        // Successfully selected descriptor
// Later:
player.destroy();
```

The canvas and its WebGL context belong exclusively to this player until
`destroy()`. The player creates one muted inline video beside the canvas.
`player.video` exposes native timing, duration, playback rate and looping; do not
replace its `src` or its children. Source replacement uses a new player. The
canvas intrinsic dimensions match the visible color rectangle; style its display
size with CSS. The runtime pauses frame uploads while paused, ended or hidden,
and restores its WebGL resources after context restoration.

`AvalAlphaError.code` is `invalid-source`, `unsupported-source`, `rendering`,
`media`, or `disposed`. Exhausted candidates are recorded in `error.cause`.
Autoplay rejection keeps the selected source ready. Errors after readiness are
reported as terminal playback failures; there is no midstream codec switching.
The application owns poster, loading, accessibility and error presentation.

## Compression controls

A JSON configuration passed to `avl alpha` keeps settings specific to each codec:

```json
{
  "input": "motion.mov",
  "fps": 30,
  "width": 640,
  "baseUrl": "/motion/",
  "encodings": [
    { "codec": "av1", "encoder": "libsvtav1", "preset": "4", "crf": 30 },
    { "codec": "vp9", "cpuUsed": 0, "deadline": "best", "crf": 30 },
    { "codec": "h265", "preset": "veryslow", "crf": 24,
      "x265": { "aqMode": 3, "psyRd": 1, "sao": false } },
    { "codec": "h264", "preset": "slow", "crf": 23 }
  ]
}
```

Input paths in JSON are relative to that file. `--out` is required and relative to
the working directory. Run `avl alpha config.json --out public/motion` using the
installed CLI. The Node API is `compileAlpha(input, options)` from
`@pixel-point/aval-compiler/alpha`.

| Encoder | Controls |
| --- | --- |
| SVT-AV1 | `encoder: "libsvtav1"`, CRF 0–63, preset `"0"`–`"13"` |
| libaom AV1 | `encoder: "libaom-av1"`, CRF 0–63, `cpuUsed` 0–8 |
| VP9 | CRF 0–63, `cpuUsed` 0–5, `deadline: "good"` or `"best"` |
| x265 HEVC | CRF 0–51, `ultrafast` through `placebo`, typed `x265` options |
| x264 H.264 | CRF 0–51, `ultrafast` through `placebo` |

All support `threads` (1–64) and `gop` (maximum keyframe interval in seconds,
default 2). AV1 and HEVC additionally accept `bitDepth: 10`; the default is 8.
The compiler preserves normal lookahead and frame reordering. It reads codec
configuration from the output rather than guessing from a filename. Requested
encoders must exist; it does not silently switch an unavailable encoder.

Typed x265 controls are `aqMode`, `aqStrength`, `psyRd`, `psyRdoq`, `rd`,
`rdoqLevel`, `lookahead`, `bframes`, `ref`, and `sao`. They use x265's documented
semantics. Slower settings may reduce bytes; the best result depends on the clip.
[FFmpeg encoders](https://www.ffmpeg.org/ffmpeg-codecs.html),
[x265 controls](https://x265.readthedocs.io/en/master/cli.html).

Optional quality search tries every CRF/preset combination and selects the
smallest qualifying candidate **per codec**:

```json
{
  "optimize": {
    "crfs": [20, 26, 32],
    "presets": { "h265": ["slow", "veryslow"] },
    "maxAlphaMae": 2,
    "maxCompositeMae": 3
  }
}
```

Merge that into the configuration; preset searches apply only to encoders with a
`preset` control. At most 32 CRFs and 64 CRF/preset combinations per codec are
allowed. `build.json` records bytes, encode time, exact arguments, encoder
versions, decoded alpha/composite errors, selected candidates, and the Pareto
frontier. Errors use the 0–255 channel scale and cover every output frame;
composites use black, white, and magenta backgrounds. The search rejects if a
codec has no qualifying output. These offline metrics are not a substitute for
testing browser rendering on target devices. Equal CRF values across different
codecs do not mean equal quality. RGB and alpha share one stream, so there is no
independent `alphaCrf`.

## Input and delivery contract

- Input is SDR, square-pixel, unrotated media with alpha, or a numbered PNG
  sequence. Sequences need `fps` and `frames`; numbering starts at zero unless
  `startNumber` is supplied. `frames` also limits video inputs. Use `fps` to
  normalize variable-rate media. Fully opaque inputs are rejected.
- Input colors use straight alpha; set `premultiplied: true` / `--premultiplied`
  for premultiplied input. Transparent VP9 WebM is decoded with libvpx so its
  existing alpha plane is preserved. Audio is discarded.
- Output is full-resolution RGB plus full-resolution alpha, SDR BT.709 limited
  YUV420, with even chroma alignment and an eight-pixel gutter. `layout: "auto"`
  packs portrait clips horizontally and others vertically. Override with
  `"horizontal"` or `"vertical"`. This reduces the longest decoded side without
  affecting the runtime contract; it does not guarantee device decoder limits.
- The WebGL upload disables optional browser color-space conversion. The shader
  recovers mask coverage using BT.709 luma weights and outputs premultiplied
  RGBA. Compression remains lossy. The color checks guard against an extra
  FFmpeg matrix conversion before encoding.
- Serve correct video MIME types, HTTP byte ranges and MP4 fast-start files.
  External origins must permit CORS texture access. The default is anonymous
  CORS; `crossorigin="use-credentials"` / `crossOrigin: "use-credentials"` is
  available when the server supports credentialed CORS.
- A native decoder and WebGL1 are required. There is no WASM or Canvas2D fallback.
  A generic video viewer shows the packed picture and mask; aval-alpha supplies
  the interpretation. The runtime has no dependency on the AVAL binary format.

## Verify and measure

```sh
npm run alpha:fixtures        # Build compiler and generate synthetic media
npm run alpha                # Demo on http://127.0.0.1:4188
npm run test:alpha            # Unit validation
npm run test:alpha:media      # Real FFmpeg integration tests
npm run test:alpha:browser    # Chromium, Firefox, WebKit; also without WebCodecs/rVFC
npm run alpha:size           # Standalone ES2022 bundle, all executable resources
npm run alpha:pack           # Tarball, isolated install, type and SSR checks
```

The size gate enforces ≤5,000 gzip / 4,000 Brotli bytes for the core and ≤1,000
additional compressed bytes for the element. Generated standalone ES modules and
raw/gzip/Brotli totals are in `.cache/alpha/bundles`; copy the appropriate bundle
to your static server if using no application bundler. The measurement rejects
external modules, workers, decoder assets, and imports outside this package.
Media bytes are additional. See [verification evidence](../../docs/alpha/verification.md)
for measured sizes, tested engines and the remaining device checks.
