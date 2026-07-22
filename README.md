# AVAL

AVAL is a web format and runtime for short prerendered motion with continuous
loops, named application states, authored triggers, bounded transitions,
reversals, and packed transparency.

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

## Five-minute start

```sh
npm install @pixel-point/aval-element@1.0.0
npm install --save-dev @pixel-point/aval-compiler@1.0.0
npx avl init my-motion
cd my-motion
npm install
npm run dev
```

Here `npx avl` resolves the `avl` executable from the compiler package
installed on the preceding line. The generated starter contains its RGBA
frames, project 1.0 file, four codec encoding policies, consumer-owned error
handling, and watch workflow.

For a normal build, the compiler publishes a directory rather than a single
output file:

```sh
npx avl compile motion.json --out dist/motion
```

```text
dist/motion/
  av1.avl
  vp9.avl
  h265.avl
  h264.avl
  build.json
```

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
- `@pixel-point/aval-compiler`: project 1.0 authoring API and bundle compiler.
- `@pixel-point/aval-player-web`: bounded loader, codec probing, decoder
  scheduling, renderer, and page resource management.
- `@pixel-point/aval-element`: markup-first public browser component.

The element package is SSR-safe. Its root exports explicit registration;
`@pixel-point/aval-element/auto` is the opt-in automatic-registration entry.

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

- React dedicated component and API.  
- Compatibility table
- Render some cool stuff in 3D for the demo instead of that AI-generated loop that I was not able to make look the way I wanted to actually showcase the uninterruptible animation.

## Documentation

- [Quick start](docs/quick-start.md)
- [States and triggers](docs/states-and-triggers.md)
- [Element API](docs/element-api.md)
- [Failure handling and reduced motion](docs/element/fallback-and-reduced-motion.md)
- [Compiler](docs/compiler.md)
- [Project schema 1.0](docs/project/1.0.md)
- [Wire format 1.1](docs/format/1.1.md)
- [Preparing video and authoring states](docs/compiler/authoring-video-and-states.md)
- [Network and integrity](docs/network-and-integrity.md)
- [Accessibility and reduced motion](docs/accessibility-and-motion.md)
- [Performance and budgets](docs/performance-and-budgets.md)
- [Browser support](docs/browser-support.md)
- [Versioning](docs/versioning.md)
- [Security policy](SECURITY.md)
