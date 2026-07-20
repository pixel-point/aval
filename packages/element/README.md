# @pixel-point/aval-element

`<aval-player>` is the web component for interactive AVAL 1.0 motion. It reads
ordered, direct-child `<source>` elements, selects the first codec file with a
qualified rendition, and raises a structured `AvalPlaybackError` when animation
cannot run. Applications own any alternate content.

```sh
npm install @pixel-point/aval-element@1.0.0
```

Register explicitly or use the opt-in automatic entry:

```js
import { defineAvalElement } from "@pixel-point/aval-element";

const motion = document.querySelector("#favorite-motion");
const unavailable = document.querySelector("#favorite-unavailable");
motion.addEventListener("readinesschange", () => {
  if (motion.readiness === "interactiveReady") unavailable.hidden = true;
});
motion.addEventListener("error", (event) => {
  const diagnostics = motion.getDiagnostics();
  if (
    event.detail.fatal === true &&
    motion.readiness === "error" &&
    event.detail.failure === diagnostics.lastFailure
  ) {
    unavailable.hidden = false;
  }
});

defineAvalElement();
```

```js
import "@pixel-point/aval-element/auto";
```

## Ordered codec sources

```html
<button id="favorite" type="button">
  <aval-player
    id="favorite-motion"
    interaction-for="favorite"
    crossorigin="anonymous"
    aria-hidden="true"
  >
    <source
      src="/motion/av1.avl"
      type='application/vnd.aval; codecs="av01.0.00M.10.0.110.01.01.01.0"'
      integrity="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    >
    <source
      src="/motion/vp9.avl"
      type='application/vnd.aval; codecs="vp09.00.10.08.01.01.01.01.00"'
      integrity="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    >
    <source
      src="/motion/h265.avl"
      type='application/vnd.aval; codecs="hvc1.1.6.L93.B0"'
      integrity="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    >
    <source
      src="/motion/h264.avl"
      type='application/vnd.aval; codecs="avc1.42E01E"'
      integrity="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    >
  </aval-player>
  <img id="favorite-unavailable" src="/favorite.png" alt="" hidden>
  <span>Favorite</span>
</button>
```

The codec strings and digests above are illustrative. Copy each asset's exact
`type` and `integrity` from the compiler's `build.json`; the report also exposes
the complete ordered `sourceMarkup`. If the HTML lives outside the bundle
directory, prefix each reported `src` with the bundle URL as shown.
The listener is installed before registration, validates the terminal
generation's canonical failure identity, and reveals only application-owned
DOM. A reduced-motion `staticReady` state is nonfatal and does not reveal it.

The `<aval-player>` host has no source or integrity authority. Every candidate
must have a nonempty `src` and an exact
`application/vnd.aval; codecs="..."` type. `integrity` is optional and applies
only to that file. `crossorigin` is shared by the host for all candidates.

Child order is author preference, like ordinary media sources. The runtime
probes codec configurations in its decoder worker, then fetches only the chosen
asset's encoded payloads. It does not use user-agent sniffing. Unsupported
codec/configuration outcomes advance to the next child. Network, integrity,
format, or runtime failures reject `prepare()` with `AvalPlaybackError` and
raise one fatal `error` event for that generation. The application owns the
optional sibling image and decides if or when to reveal it. The active codec is
not hot-switched. Changing the source children starts a new generation, and
there is no `preload` attribute.

Use `setState(name)` for application state, `send(event)` for authored graph
events, and the reflected `state`, `motion`, `autoplay`, `fit`, and `bindings`
properties for framework integration. Playback is frame-scheduled through the
AVAL web runtime rather than a seeking `<video>` element.

See the repository element API, accessibility, network/integrity, and browser
support guides for the complete contract.
