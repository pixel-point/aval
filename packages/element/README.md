# @pixel-point/aval-element

`<aval-player>` is the web component for interactive AVAL 1.0 motion. It reads
direct-child `<source>` elements, evaluates their `data-codec` families in the
fixed AV1 → VP9 → H.265 → H.264 order, selects the first file with a qualified
rendition, and raises a structured `AvalPlaybackError` when animation cannot
run. Applications own any alternate content.

```sh
npm install @pixel-point/aval-element@1.0.0
```

## Required consumer error boundary

Every production integration must handle unsupported browsers and terminal
playback failure. `prepare()` rejects with `AvalPlaybackError`, and the element
raises one fatal `error` event whose `failure.code` may be
`unsupported-profile`, `unsupported-browser`, or another bounded failure code.
AVAL never creates or activates fallback DOM; the application decides whether
to reveal an ordinary video, image, text, another renderer, or nothing. Attach
the direct listener before explicit registration and branch on `failure.code`,
not the message.

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

## Codec sources

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
      data-codec="av1"
      integrity="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    >
    <source
      src="/motion/vp9.avl"
      data-codec="vp9"
      integrity="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    >
    <source
      src="/motion/h265.avl"
      data-codec="h265"
      integrity="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    >
    <source
      src="/motion/h264.avl"
      data-codec="h264"
      integrity="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    >
  </aval-player>
  <img id="favorite-unavailable" src="/favorite.png" alt="" hidden>
  <span>Favorite</span>
</button>
```

The digests above are illustrative. Copy the compiler's `sourceMarkup` from
`build.json`; if the HTML lives outside the bundle directory, prefix each
reported `src` with the bundle URL as shown.
The listener is installed before registration, validates the terminal
generation's canonical failure identity, and reveals only application-owned
DOM. A reduced-motion `staticReady` state is nonfatal and does not reveal it.

The `<aval-player>` host has no source or integrity authority. Every candidate
must have a nonempty `src` and an exact
`data-codec` value: `av1`, `vp9`, `h265`, or `h264`. A family may appear only
once. `integrity` is optional and applies only to that file. `crossorigin` is
shared by the host for all candidates.

Child order has no priority meaning. The runtime always evaluates AV1, VP9,
H.265, then H.264, probes exact manifest configurations in its decoder worker,
and fetches only the chosen asset's encoded payloads. It does not use user-agent
sniffing. Unsupported codec/configuration outcomes advance to the next family.
Consumers and certification tools that need the same family order can import
the frozen `SOURCE_CODEC_PRIORITY` tuple from this package.
Network, integrity,
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
