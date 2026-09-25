# AVAL

AVAL is a web format and runtime for short prerendered motion with continuous
loops, named application states, authored triggers, bounded transitions,
reversals, and packed transparency.

For ordinary transparent video, use the separate
[`aval-alpha` package](packages/alpha/README.md). It supports ordered child
sources, standard AV1/VP9/HEVC/H.264 files, and a small native-video/WebGL player.
Dedicated [React](packages/alpha-react/README.md) and [Svelte](packages/alpha-svelte/README.md)
adapters share the same lightweight core and lifecycle binding.
See the [Aval Alpha tested compatibility matrix](docs/alpha/browser-support.md)
for device, browser and codec results.

Compile those files with `avl alpha`; they use a separate contract from the
interactive AVAL format described below.

One logical animation is published as a codec bundle. Each codec gets its own
AVAL wire 1.1 file—AV1, VP9, H.265/HEVC, or H.264—and the browser selects the
first candidate in AVAL's fixed AV1 → VP9 → H.265 → H.264 ladder that decodes
and passes pre-readiness output qualification. DOM source order does not
change that policy. The state graph and authored timing are identical in every
file.

## Required application error handling

Every AVAL integration must own its unsupported-browser and fatal-error path.
A browser may lack the required WebCodecs interfaces, every authored codec may
be unsupported, or another terminal playback failure may stop the source
generation. In those cases `prepare()` rejects with `AvalPlaybackError` and the
element raises one fatal `error` event with `failure.code` set to a value such
as `unsupported-profile` or `unsupported-browser`.

AVAL deliberately does not create, select, reveal, or hide fallback content.
The application must decide whether to show an ordinary video, image, text,
another renderer, or nothing. Install the element's direct `error` listener
before explicit registration so an upgrade-time failure cannot outrun the
application boundary, and handle the rejected `prepare()` promise when calling
it directly. Branch on `failure.code`; do not parse the error message. The
browser-integration example below demonstrates this required boundary.

## Compile an AVAL project

Create a [`motion.json`](docs/project/1.0.md) beside your source media. This
minimal example expects `motion.mov` to be a progressive, square-pixel,
unrotated 1920×1080 video at a constant 30 fps with at least 120 frames. It
compiles the first four seconds as one looping VP9 AVAL:

<!-- BEGIN MOTION PROJECT EXAMPLE -->
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
      "id": "motion",
      "type": "video",
      "path": "motion.mov",
      "timing": { "mode": "exact" }
    }
  ],
  "encodings": [
    {
      "codec": "vp9",
      "deadline": "best",
      "cpuUsed": 0,
      "threads": 8,
      "renditions": [
        { "id": "motion.1x", "width": 1920, "height": "auto", "crf": 40 }
      ]
    }
  ],
  "units": [
    {
      "id": "idle.body",
      "kind": "body",
      "source": "motion",
      "range": [0, 120],
      "playback": "loop",
      "ports": []
    }
  ],
  "initialState": "idle",
  "states": [{ "id": "idle", "bodyUnit": "idle.body" }],
  "edges": [],
  "bindings": []
}
```
<!-- END MOTION PROJECT EXAMPLE -->

Compile it directly. No initialization or local compiler installation is
required:

```sh
npx @pixel-point/aval-compiler compile motion.json --out dist/motion
```

Here npx fetches the scoped compiler into npm's cache and automatically runs its
sole `avl` executable; it does not add the compiler to the current project. The
compiler publishes a directory rather than a single output file. This example
produces:

```text
dist/motion/
  vp9.avl
  build.json
```

See the [`motion.json` format and options](docs/project/1.0.md) for all source
types, codecs, compression controls, renditions, units, states, transitions,
and bindings. A project can request AV1, VP9, H.265, and H.264 together.

## Browser integration

Use literal direct-child sources with one required lowercase `data-codec`
family per file. AVAL derives preference from that attribute, not DOM order;
the exact WebCodecs configuration remains inside each `.avl` manifest.

```html
<aval-player id="motion" width="320" height="320">
  <source
    src="/motion/av1.avl"
    data-codec="av1"
  >
  <source
    src="/motion/vp9.avl"
    data-codec="vp9"
  >
  <source
    src="/motion/h265.avl"
    data-codec="h265"
  >
  <source
    src="/motion/h264.avl"
    data-codec="h264"
  >
</aval-player>

<script type="module" src="/motion.js"></script>
```

```js
// motion.js, resolved by a package-aware web build
import {
  AvalPlaybackError,
  defineAvalElement
} from "@pixel-point/aval-element";

const motion = document.querySelector("#motion");
motion.addEventListener("error", (event) => {
  if (event.detail.fatal) {
    console.error("AVAL playback unavailable", event.detail.failure);
  }
});
defineAvalElement();

try {
  await motion.prepare();
} catch (error) {
  if (!(error instanceof AvalPlaybackError)) throw error;
}
```

The `<aval-player>` host does not carry `src`; URLs and codec-family
declarations belong to each candidate. `data-codec` accepts exactly `av1`,
`vp9`, `h265`, or `h264`, and a family may appear at most once. Missing,
unknown, or duplicate declarations are invalid configuration. AVAL raises
`AvalPlaybackError` when playback cannot run. The
application decides whether to show another renderer, text, or nothing.
Applications can select any authored state without media seeking:

```js
const motion = document.querySelector("aval-player");
await motion?.setState("success");
```

## Codec and compression model

A project has a codec-major `encodings` array. Its order controls compiler and
report publication only; browser preference is always AV1 → VP9 → H.265 →
H.264. Each codec owns its
rendition ladder and constant-quality CRF settings. H.264 and H.265 expose
compression presets; VP9 exposes `deadline` and `cpuUsed`; AV1 exposes
`bitDepth`, `cpuUsed`, `tiles`, `rowMt`, and `threads`. Slower modes such as
`veryslow`, VP9 `best`, and AV1 `cpuUsed: 0` are supported.

Encoding has no default wall-clock media timeout. Builds that need a deadline
can opt in with `--media-timeout-ms`. The compiler records sanitized tool
invocations, exact MIME codec strings, per-file hashes, and copyable source
markup in `build.json`.

The compiler uses caller-installed FFmpeg and FFprobe with the requested
`libx264`, `libx265`, `libvpx-vp9`, and `libaom-av1` encoders. It bundles and
downloads no native codec tool. Codec, patent, source-media, and distribution
obligations remain the publisher's responsibility.

## Packages

- `@pixel-point/aval-graph`: deterministic state and route engine.
- `@pixel-point/aval-format`: strict AVAL wire 1.1 parser, validator, and writer.
- `@pixel-point/aval-element`: markup-first browser component and the sole
  browser loader, decoder scheduler, renderer, and page resource owner.
- `@pixel-point/aval-compiler`: project 1.0 authoring API and bundle compiler.
- `@pixel-point/aval-react`: SSR-safe Rive-like `useAval()` integration for
  React 18.3 and 19 applications.
- `@pixel-point/aval-svelte`: Svelte 5 component plus a read-only reactive
  controller store for AVAL motion.

The element package is the canonical browser runtime and is SSR-safe. Its root
exports explicit registration;
`@pixel-point/aval-element/auto` is the opt-in automatic-registration entry.
The React package registers through its client ref and never imports that
side-effect entry. The Svelte package performs the same registration only
after its component has mounted and native listeners are attached.

## Develop and verify

Node.js 22.12.0 or newer is required.

```sh
npm ci --ignore-scripts
npm run typecheck
npm run test:unit
npm run build
npm run test:browser:reference
```

Browser animation is qualified in the fixed AV1 → VP9 → H.265 → H.264 order,
independent of authored source order. A positive WebCodecs configuration probe
remains provisional; unsupported configurations and
codec-specific startup qualification failures fall through to the next
`<source>`. Once `interactiveReady` is published, the selected codec never
hot-switches. When no candidate qualifies, preparation rejects and one fatal
`error` event identifies the failed source generation. AVAL never selects or
reveals alternate application content.

## TODO

- Compatibility table
- Render some cool stuff in 3D for the demo instead of that AI-generated loop that I was not able to make look the way I wanted to actually showcase the uninterruptible animation.

## Documentation

- [Quick start](docs/quick-start.md)
- [States and triggers](docs/states-and-triggers.md)
- [Element API](docs/element-api.md)
- [React integration](docs/element/react.md)
- [Svelte integration](docs/element/svelte.md)
- [Failure handling and reduced motion](docs/element/fallback-and-reduced-motion.md)
- [Compiler](docs/compiler.md)
- [`motion.json` format and options](docs/project/1.0.md)
- [Wire format 1.1](docs/format/1.1.md)
- [Preparing video and authoring states](docs/compiler/authoring-video-and-states.md)
- [Network and integrity](docs/network-and-integrity.md)
- [Accessibility and reduced motion](docs/accessibility-and-motion.md)
- [Performance and budgets](docs/performance-and-budgets.md)
- [Browser support](docs/browser-support.md)
- [Versioning](docs/versioning.md)
- [Publishing synchronized npm packages](docs/releases/publication-runbook.md)
- [Security policy](SECURITY.md)
