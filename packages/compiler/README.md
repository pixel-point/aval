# @pixel-point/aval-compiler

The AVAL 1.0 authoring API and `avl` CLI. A project defines one logical motion
graph and a codec-major encoding set. Compilation publishes a bundle
directory containing one `.avl` per requested codec and a canonical
`build.json` report.

Install the compiler locally before invoking its `avl` executable:

```sh
npm install --save-dev @pixel-point/aval-compiler@1.0.0
npx avl init my-motion
```

## Compile a project

```sh
npx avl compile motion.json --out dist/motion
```

For a project containing all four codecs, the output is:

```text
dist/motion/
  av1.avl
  vp9.avl
  h265.avl
  h264.avl
  build.json
```

`--out` always names the complete bundle directory. `--force` atomically
replaces that directory as one unit.

The project schema and build report are exact 1.0 contracts. Every `.avl` file
uses wire format 1.1. The `encodings` array order is retained in compiler and
report output; browser preference is independently fixed at AV1 → VP9 → H.265
→ H.264.
This encoding fragment omits the required canvas, source, and graph fields:

```json
{
  "projectVersion": "1.0",
  "alpha": "auto",
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
  ]
}
```

Each encoding owns one to four renditions. A rendition may use `"auto"` for
one dimension; the compiler resolves the matching even dimension without
changing the canvas aspect ratio.

## Compression controls

| Field | Codec | Accepted values | Effect |
| --- | --- | --- | --- |
| rendition `crf` | all | H.264/H.265 `0..51`; VP9/AV1 `0..63` | Lower values retain more detail and generally produce larger output. |
| `preset` | H.264/H.265 | `ultrafast` through `placebo` | Slower presets spend more encode time seeking better compression. |
| `deadline` | VP9 | `best`, `good`, `realtime` | `best` permits the slowest, most compression-focused search. |
| `cpuUsed` | VP9 | `-8..8` | Lower values spend more work on compression. |
| `cpuUsed` | AV1 | `0..8` | `0` is the slowest, most compression-focused mode. |
| `bitDepth` | AV1 | `8` or `10` | `10` preserves the canonical high-precision pipeline as `yuv420p10le`. |
| `tiles` | AV1 | power-of-two columns/rows, product at most 64 | Controls independent tile layout. |
| `rowMt` | AV1 | boolean | Enables or disables row multithreading. |
| `threads` | H.265/VP9/AV1 | `1..64` | Bounds encoder worker threads. |

The compiler owns scaling, pixel formats, elementary-stream framing, and audio
removal. VP9 and AV1 constant-quality output automatically receives `-b:v 0`.
MP4/WebM muxer controls such as codec tags, `faststart`, and experimental-mode
switches are not project fields because `.avl` stores elementary access units,
not an MP4, WebM, or IVF file. `build.json.invocations` records the exact
sanitized argument vector used for every operation.

Representative codec argument fragments are:

```text
-c:v libvpx-vp9 -crf 40 -b:v 0 -deadline best -cpu-used 0 -threads 8
-c:v libx265 -crf 32 -preset veryslow -threads 8
-c:v libaom-av1 -crf 15 -b:v 0 -pix_fmt yuv420p10le -cpu-used 0 -tiles 4x2 -row-mt 1 -threads 32
-c:v libx264 -crf 20 -preset veryslow
```

There is no default media-operation deadline. Slow settings may legitimately
run for a long time. Add `--media-timeout-ms <positive-integer>` only when your
build environment needs an explicit upper bound; cancellation and compiler
resource limits remain active either way.

## Direct media input

Direct input requires one explicit codec and produces the same one-codec bundle
shape through the same compiler pipeline:

```sh
npx avl compile render.mov \
  --codec av1 \
  --loop 0:120 \
  --crf 15 \
  --bit-depth 10 \
  --cpu-used 0 \
  --tiles 4x2 \
  --row-mt \
  --threads 32 \
  --out dist/motion
```

Use `--preset` with H.264/H.265, `--deadline` with VP9, and the matching
codec-specific options shown above. Multi-codec compilation is expressed in a
project file rather than by repeating direct CLI flags.

## Browser sources and integrity

`build.json.assets` contains each codec filename, exact WebCodecs MIME type,
SHA-256 digest, and ready-to-use SRI value in encoding/report order. Its
`sourceMarkup` field contains the canonical direct-child `<source>` lines.
Those lines use the required lowercase `data-codec` family and no HTML `type`
attribute. Copy them exactly; integrity belongs to each codec file, not to the
`<aval-player>` host. The exact codec profile remains in the `.avl` manifest.

The compiler uses caller-installed FFmpeg and FFprobe. The requested encodings
require the corresponding `libx264`, `libx265`, `libvpx-vp9`, and
`libaom-av1` encoders; the package bundles and downloads no native codec tool.

See the repository [compiler guide](../../docs/compiler.md) and
[video/state authoring guide](../../docs/compiler/authoring-video-and-states.md).
