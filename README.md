# AVAL

AVAL is a web-only format and runtime for short prerendered animation
with continuous partial loops, user-defined states, authored triggers, bounded
transitions, packed transparency, and host-owned fallback markup.

The central idea is simple: encode independently decodable motion units and a
small deterministic state graph in one `.avl` asset. The browser keeps a
decoder timeline moving forward across a loop instead of seeking a video file
at every seam. Hover, focus, application state, reversals, portals, finite
bodies, and held states are graph routes rather than hand-timed media seeks.

It's an early **technical preview**, so things will be changing fast and will get into a more stable shape within the next couple of weeks.

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
installed on the preceding line.

Open the printed loopback URL. That generated starter includes its frames,
project, fallback markup, exact package dependencies, and watch workflow. The
following is illustrative integration markup for a package-aware web build
after you publish or copy a compiled asset into your application:

```html
<script type="module" src="/motion.js"></script>

<aval-player src="/my-motion.avl" width="320" height="320">
  <img slot="fallback" src="/my-motion.png" alt="">
</aval-player>
```

```js
// motion.js, resolved by your package-aware web build
import { defineAvalElement } from "@pixel-point/aval-element";
defineAvalElement();
```

A one-state asset loops with no seeking code. Multi-state assets keep their
own names and triggers; applications can set any authored state:

```ts
const motion = document.querySelector("aval-player");
await motion?.setState("success");
```

## Local end-user playground

To check the consumer experience from this repository with a real interactive
asset, run:

```sh
npm install
npm run playground
```

Open the printed loopback URL. The permanent example uses workspace packages,
includes its compiled asset and fallback image, and does not require FFmpeg at
runtime. Hover, focus, or use the toggle to move between its authored states.

The element package is SSR-safe. Its root exports an explicit definition
helper; the opt-in `@pixel-point/aval-element/auto` entry is the only automatic
registration side effect.

## What is included

- `@pixel-point/aval-graph`: deterministic latest-wins state and route engine;
- `@pixel-point/aval-format`: strict wire `0.1` parser, validator, and writer;
- `@pixel-point/aval-compiler`: project `0.3` authoring and CLI;
- `@pixel-point/aval-player-web`: bounded web loader, decoder scheduler,
  renderer, fallback-state signaling, and page resource manager; and
- `@pixel-point/aval-element`: markup-first public browser component.

The compiler uses caller-installed FFmpeg/FFprobe and libx264; it never bundles
or downloads native codec tools. Codec, patent, source-media, and distribution
obligations remain the publisher's responsibility.

## Develop and verify

Node.js 22.12.0 or newer is required.

```sh
npm ci --ignore-scripts
npm run typecheck
npm run test:unit
npm run build
npm run test:browser:reference
```

Browser animation is capability-probed. Unsupported WebCodecs/WebGL/AVC
configurations leave the element's optional host-owned fallback slot visible.

## TODO

- Add support for H.265, AV1, and VP9 codecs to work with the .avl container.  
- React dedicated component and API.  
- Safari support.  
- More browser tests.  
- Render some cool stuff in 3D for the demo instead of that AI-generated loop that I was not able to make look the way I wanted to actually showcase the uninterruptible animation.

## Documentation

- [Quick start](docs/quick-start.md)
- [States and triggers](docs/states-and-triggers.md)
- [Element API](docs/element-api.md)
- [Compiler](docs/compiler.md)
- [Preparing video and authoring states](docs/compiler/authoring-video-and-states.md)
- [Network and integrity](docs/network-and-integrity.md)
- [Accessibility and reduced motion](docs/accessibility-and-motion.md)
- [Performance and budgets](docs/performance-and-budgets.md)
- [Browser support](docs/browser-support.md)
- [Versioning](docs/versioning.md)
- [Certification method](docs/certification/method.md)
- [Security policy](SECURITY.md)

Functional Playwright evidence is not a branded-browser or physical-display
certificate. Runtime scheduling certification applies only to exact published
named profiles. Physical display continuity requires a separate qualifying
observed-display report; browser callback, decoder, GPU-fence, screenshot, and
canvas-readback timestamps are insufficient by themselves.
