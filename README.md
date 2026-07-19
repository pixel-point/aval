# AVAL

AVAL is a web format and runtime for short prerendered motion with continuous
loops, named application states, authored triggers, bounded transitions,
reversals, and packed transparency.

One logical animation is published as a codec bundle. Each codec gets its own
AVAL 1.0 file—AV1, VP9, H.265/HEVC, or H.264—and the browser selects the first
ordered `<source>` with a supported rendition. The state graph and authored
timing are identical in every file.

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
frames, project 1.0 file, four ordered encoding policies, consumer-owned error
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

Use literal direct-child sources in preference order. The exact codec strings
come from `build.json`; the values below are illustrative.

```html
<div class="motion-shell">
  <aval-player id="motion" width="320" height="320">
    <source
      src="/motion/av1.avl"
      type='application/vnd.aval; codecs="av01.0.00M.10.0.110.01.01.01.0"'
    >
    <source
      src="/motion/vp9.avl"
      type='application/vnd.aval; codecs="vp09.00.10.08.01.01.01.01.00"'
    >
    <source
      src="/motion/h265.avl"
      type='application/vnd.aval; codecs="hvc1.1.6.L93.B0"'
    >
    <source
      src="/motion/h264.avl"
      type='application/vnd.aval; codecs="avc1.42E01E"'
    >
  </aval-player>
  <img id="motion-unavailable" src="/motion.png" alt="" hidden>
</div>

<script type="module" src="/motion.js"></script>
```

```js
// motion.js, resolved by a package-aware web build
import {
  AvalPlaybackError,
  defineAvalElement
} from "@pixel-point/aval-element";

const motion = document.querySelector("#motion");
const unavailable = document.querySelector("#motion-unavailable");
function revealPlaybackUnavailable(failure) {
  const diagnostics = motion.getDiagnostics();
  if (
    motion.readiness === "error" &&
    diagnostics.lastFailure !== null &&
    failure === diagnostics.lastFailure
  ) {
    unavailable.hidden = false;
  }
}
motion.addEventListener("error", (event) => {
  if (event.detail.fatal) revealPlaybackUnavailable(event.detail.failure);
});
motion.addEventListener("readinesschange", () => {
  if (motion.readiness === "interactiveReady") unavailable.hidden = true;
});
defineAvalElement();

try {
  await motion.prepare();
} catch (error) {
  if (!(error instanceof AvalPlaybackError)) throw error;
  revealPlaybackUnavailable(error.failure);
}
```

The `<aval-player>` host does not carry `src`; URLs belong to each codec
candidate. AVAL raises `AvalPlaybackError` when playback cannot run. The
application decides whether to show its sibling image, another renderer, text,
or nothing. Applications can select any authored state without media seeking:

```js
const motion = document.querySelector("aval-player");
await motion?.setState("success");
```

## Codec and compression model

A project has an ordered, codec-major `encodings` array. Each codec owns its
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
- `@pixel-point/aval-format`: strict AVAL wire 1.0 parser, validator, and writer.
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

Browser animation is qualified in authored source order. Unsupported codec
candidates fall through to the next `<source>`; when none can run, preparation
rejects and one fatal `error` event identifies the failed source generation.
AVAL never selects or reveals alternate application content.

## TODO

- React dedicated component and API.  
- More browser tests.  
- Render some cool stuff in 3D for the demo instead of that AI-generated loop that I was not able to make look the way I wanted to actually showcase the uninterruptible animation.

## Documentation

- [Quick start](docs/quick-start.md)
- [States and triggers](docs/states-and-triggers.md)
- [Element API](docs/element-api.md)
- [Compiler](docs/compiler.md)
- [Project schema 1.0](docs/project/1.0.md)
- [Wire format 1.0](docs/format/1.0.md)
- [Preparing video and authoring states](docs/compiler/authoring-video-and-states.md)
- [Network and integrity](docs/network-and-integrity.md)
- [Accessibility and reduced motion](docs/accessibility-and-motion.md)
- [Performance and budgets](docs/performance-and-budgets.md)
- [Browser support](docs/browser-support.md)
- [Versioning](docs/versioning.md)
- [Security policy](SECURITY.md)
