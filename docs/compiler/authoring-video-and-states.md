# Preparing video and authoring states

An `.avl` contains encoded animation units, exact timing, integrity hashes,
and a declarative state graph. It contains no poster, host fallback, original
video, or executable content. A codec bundle contains one `.avl` per requested
codec plus `build.json`.

## Prepare source media

Project 1.0 accepts `.mov`, `.mp4`, and `.m4v` video files and numbered RGBA PNG sequences
such as `frame-0000.png`. Use the highest-quality source
available; compiling an already compressed delivery file cannot restore lost
detail.

Prepare videos with one usable video stream, progressive frames, square pixels,
constant timing where `exact` is requested, the intended aspect ratio, and
rotation metadata cleared after rotation is baked into the pixels. Audio,
subtitles, and data streams are never included in AVAL output.

```sh
ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,sample_aspect_ratio,field_order:stream_tags=rotate \
  -of json source.mov
```

For native transparency, use a source that carries alpha, such as ProRes 4444
or RGBA PNGs. The compiler audits source alpha and packs it into the decoded
video surface when `alpha` is `"packed"` or when `"auto"` finds non-opaque
pixels.

## Timing and source ranges

Use `exact` for constant-frame-rate media already on the project grid:

```json
{
  "id": "render",
  "type": "video",
  "path": "render.mov",
  "timing": { "mode": "exact" }
}
```

Use `normalize-hold` only when variable source timing should map onto the
project grid by holding the most recent source frame. PNG sources declare an
exact prefix, digit width, suffix, first number, and frame count.

All ranges are zero-based and half-open. `[30, 45]` contains frames 30 through
44. Authored units are independent decode boundaries; prediction never crosses
from one unit to another.

## Complete project

This compact two-state example publishes AV1, VP9, H.265, and H.264 alternatives
in author preference order:

```json
{
  "projectVersion": "1.0",
  "alpha": "auto",
  "canvas": {
    "width": 1920,
    "height": 1080,
    "fit": "contain",
    "pixelAspect": [1, 1],
    "colorSpace": "srgb"
  },
  "frameRate": { "numerator": 30, "denominator": 1 },
  "sources": [
    {
      "id": "render",
      "type": "video",
      "path": "render.mov",
      "timing": { "mode": "exact" }
    }
  ],
  "encodings": [
    {
      "codec": "av1",
      "bitDepth": 10,
      "cpuUsed": 0,
      "tiles": { "columns": 4, "rows": 2 },
      "rowMt": true,
      "threads": 32,
      "renditions": [
        { "id": "video.1x", "width": 1920, "height": "auto", "crf": 15 }
      ]
    },
    {
      "codec": "vp9",
      "deadline": "best",
      "cpuUsed": 0,
      "threads": 8,
      "renditions": [
        { "id": "video.1x", "width": 1920, "height": "auto", "crf": 40 }
      ]
    },
    {
      "codec": "h265",
      "preset": "veryslow",
      "threads": 8,
      "renditions": [
        { "id": "video.1x", "width": 1920, "height": "auto", "crf": 32 }
      ]
    },
    {
      "codec": "h264",
      "preset": "veryslow",
      "renditions": [
        { "id": "video.1x", "width": 1920, "height": "auto", "crf": 20 }
      ]
    }
  ],
  "units": [
    {
      "id": "idle.body",
      "kind": "body",
      "source": "render",
      "range": [0, 30],
      "playback": "loop",
      "ports": [{ "id": "default", "entryFrame": 0, "portalFrames": [0] }]
    },
    {
      "id": "engaged.body",
      "kind": "body",
      "source": "render",
      "range": [30, 60],
      "playback": "loop",
      "ports": [{ "id": "default", "entryFrame": 0, "portalFrames": [0] }]
    }
  ],
  "initialState": "idle",
  "states": [
    { "id": "idle", "bodyUnit": "idle.body" },
    { "id": "engaged", "bodyUnit": "engaged.body" }
  ],
  "edges": [
    {
      "id": "idle.engaged",
      "from": "idle",
      "to": "engaged",
      "trigger": { "type": "event", "name": "control.engage" },
      "start": {
        "type": "portal",
        "sourcePort": "default",
        "targetPort": "default",
        "maxWaitFrames": 12
      },
      "continuity": "exact-authored"
    }
  ],
  "bindings": [
    { "source": "engagement.on", "event": "control.engage" }
  ]
}
```

The project canvas and rendition sizes are authoritative. The compiler does not downscale,
shorten, sample, or invent a smaller rendition. Exactly one
rendition dimension may be `"auto"`; its even value is derived from the canvas
aspect ratio.

## Compression

Lower CRF generally retains more detail and produces larger output. H.264 and
H.265 CRF numbers are not directly comparable to VP9 or AV1. Slow modes such as
`veryslow`, VP9 `deadline: "best"`, and AV1 `cpuUsed: 0` are supported without
a default encode timeout. Packed-alpha output is decoded and composited during
compiler validation.

The compiler accepts only structured fields. It owns scaling and pixel formats;
authors do not pass `-vf`. It always removes audio. It adds `-b:v 0` for VP9 and
AV1 constant-quality output. MP4/WebM options such as `hvc1`/`av01` tags,
`faststart`, and `strict experimental` do not apply to elementary AVAL chunks.

## Direct input

Direct input requires a codec and produces the same bundle shape:

```sh
avl compile input.mov --loop 0:120 --codec av1 \
  --crf 15 --bit-depth 10 --cpu-used 0 --tiles 4x2 \
  --row-mt --threads 32 --out dist/motion
```

Use `--preset` for H.264/H.265 and `--deadline` for VP9. Add
`--media-timeout-ms` only when an explicit positive wall limit is desired.

## Compile, inspect, validate, and develop

From this repository:

```sh
npm run avl -- compile motion.json --out public/motion
npm run avl -- inspect public/motion/av1.avl
npm run avl -- validate public/motion/av1.avl
npm run avl -- dev motion.json --out public/motion --open
```

Compilation needs FFmpeg/FFprobe and the requested encoders. Browser playback
does not.

## Browser integration

Copy `build.json.sourceMarkup`, preserving order and exact type/integrity
values. If the page is outside the bundle directory, prefix each reported
relative `src` with the bundle URL.

```html
<aval-player state="idle">
  <source src="/motion/av1.avl" type='application/vnd.aval; codecs="av01..."'>
  <source src="/motion/vp9.avl" type='application/vnd.aval; codecs="vp09..."'>
  <source src="/motion/h265.avl" type='application/vnd.aval; codecs="hvc1..."'>
  <source src="/motion/h264.avl" type='application/vnd.aval; codecs="avc1..."'>
</aval-player>
<img id="motion-unavailable" src="/motion.png" alt="" hidden>
```

```js
import { AvalPlaybackError, defineAvalElement } from "@pixel-point/aval-element";

const motion = document.querySelector("aval-player");
const unavailable = document.querySelector("#motion-unavailable");
motion.addEventListener("error", (event) => {
  if (event.detail.fatal) unavailable.hidden = false;
});
motion.addEventListener("readinesschange", () => {
  if (motion.readiness === "interactiveReady") unavailable.hidden = true;
});
defineAvalElement();
try {
  await motion.prepare();
  await motion.setState("engaged");
} catch (error) {
  if (!(error instanceof AvalPlaybackError)) throw error;
}
```

The optional sibling image belongs entirely to the application. AVAL never
copies it into an `.avl` or controls its visibility.
